import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  buildClientExport, ExportCancelled, exportFileName, ExportError, exportProgressCount,
  exportProgressText, recordJson, routeBatches, ROUTE_BATCH_POINTS, ROUTE_BATCH_WALKS,
  type ExportDeps,
} from "../src/lib/client-export.ts";
import { ZIP_MAX_ENTRIES } from "../src/lib/zip.ts";
import { lastFunctionBody } from "./migration-functions.ts";

const dir = mkdtempSync(join(tmpdir(), "sanpo-export-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Every file in the archive and its text, as Python's zipfile reads it. */
async function unzip(blob: Blob): Promise<Record<string, string>> {
  const path = join(dir, `e-${Math.random().toString(36).slice(2)}.zip`);
  writeFileSync(path, new Uint8Array(await blob.arrayBuffer()));
  const script = [
    "import json, sys, zipfile",
    "z = zipfile.ZipFile(sys.argv[1])",
    "assert z.testzip() is None",
    "print(json.dumps({i.filename: z.read(i.filename).decode('latin-1') for i in z.infolist()}))",
  ].join("\n");
  return JSON.parse(execFileSync("python3", ["-c", script, path], { encoding: "utf8" }));
}

const OP = "11111111-1111-4111-8111-111111111111";
function record() {
  return {
    format: "sanpo.client-export",
    version: 2,
    client: { full_name: "Jane Doe" },
    pets: [{ id: "pet-1", photo_path: `${OP}/pet-1/a.jpg` }, { id: "pet-2", photo_path: null }],
    walks: [
      { id: "w1", scheduled_date: "2026-09-01", route_points: 2,
        photos: [{ id: "ph1", storage_path: `${OP}/w1/x.jpg` }] },
      { id: "w2", scheduled_date: "2026-09-02", route_points: 0, photos: [] },
    ],
    // What Storage holds: the two photos the rows name, and the pet's earlier
    // photo, which no row names any more.
    stored_photos: [
      { bucket: "pet-photos", path: `${OP}/pet-1/a.jpg` },
      { bucket: "pet-photos", path: `${OP}/pet-1/old.jpg` },
      { bucket: "walk-photos", path: `${OP}/w1/x.jpg` },
    ] as Array<{ bucket: string; path: string; bytes?: number | null }>,
    not_included: ["…"],
  };
}

function deps(over: Partial<ExportDeps> = {}, rec: unknown = record()): ExportDeps {
  return {
    record: vi.fn(async () => rec),
    routes: vi.fn(async (_c: string, ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, id === "w1" ? [["t", 1, 2, 5, false], ["t", 1, 2, 5, true]] : []]))),
    download: vi.fn(async (bucket: string, path: string) => new Blob([`${bucket}:${path}`])),
    now: () => new Date("2026-09-24T17:00:00Z"),
    ...over,
  };
}

describe("buildClientExport", () => {
  it("puts the record, every route and every stored photo in one archive", async () => {
    const out = await buildClientExport("c-1", deps());
    const files = await unzip(out.blob);
    expect(Object.keys(files).sort()).toEqual([
      "README.txt", "earlier/1.jpg", "pets/pet-1.jpg", "photos/2026-09-01_ph1.jpg", "record.json",
    ]);
    expect(files["photos/2026-09-01_ph1.jpg"]).toBe(`walk-photos:${OP}/w1/x.jpg`);
    expect(files["pets/pet-1.jpg"]).toBe(`pet-photos:${OP}/pet-1/a.jpg`);
    expect(files["earlier/1.jpg"]).toBe(`pet-photos:${OP}/pet-1/old.jpg`);
    const rec = JSON.parse(files["record.json"]!);
    expect(rec.walks[0].route).toHaveLength(2);
    expect(rec.walks[1].route).toEqual([]);
    expect(rec.walks[0].photos[0].file).toBe("photos/2026-09-01_ph1.jpg");
    expect(rec.pets[0].photo_file).toBe("pets/pet-1.jpg");
    expect(out).toMatchObject({ photos: 3, photosMissing: 0, fileName: "sanpo-jane-doe-2026-09-24.zip" });
  });

  it("asks for walk photos from walk-photos and pet photos from pet-photos", async () => {
    const d = deps();
    await buildClientExport("c-1", d);
    expect(d.download).toHaveBeenCalledWith("walk-photos", `${OP}/w1/x.jpg`, undefined);
    expect(d.download).toHaveBeenCalledWith("pet-photos", `${OP}/pet-1/a.jpg`, undefined);
    expect(d.download).toHaveBeenCalledWith("pet-photos", `${OP}/pet-1/old.jpg`, undefined);
    expect(d.download).toHaveBeenCalledTimes(3);
  });

  /**
   * Replacing a pet's photo never deleted the old one, so Sanpo still holds
   * it. A copy that held only the photos a row points at would leave it out.
   */
  it("holds a photo no row names, and says what it is", async () => {
    const out = await buildClientExport("c-1", deps());
    const files = await unzip(out.blob);
    const rec = JSON.parse(files["record.json"]!);
    expect(rec.stored_photos.find((s: { path: string }) => s.path.endsWith("old.jpg")).file).toBe("earlier/1.jpg");
    expect(files["README.txt"]).toContain("a pet's earlier photos");
  });

  /** A copy without one photo is still most of the answer; it says which one. */
  it("marks a photo it could not fetch as missing and goes on", async () => {
    const d = deps({
      download: vi.fn(async (bucket: string, path: string) => {
        if (bucket === "walk-photos") throw new Error("404");
        return new Blob([path]);
      }),
    });
    const out = await buildClientExport("c-1", d);
    const files = await unzip(out.blob);
    const rec = JSON.parse(files["record.json"]!);
    expect(rec.walks[0].photos[0]).toMatchObject({ missing: true });
    expect(rec.walks[0].photos[0].file).toBeUndefined();
    expect(out.photosMissing).toBe(1);
    expect(files["README.txt"]).toContain("1 photo(s) could not be fetched");
  });

  /** A row naming an object Storage no longer holds is a fact, not a failure. */
  it("marks a row whose photo is no longer stored, without asking for it", async () => {
    const rec = record();
    rec.stored_photos = rec.stored_photos.filter((s) => s.bucket !== "walk-photos");
    const d = deps({}, rec);
    const out = await buildClientExport("c-1", d);
    const files = await unzip(out.blob);
    const got = JSON.parse(files["record.json"]!);
    expect(got.walks[0].photos[0]).toMatchObject({ not_stored: true });
    expect(d.download).not.toHaveBeenCalledWith("walk-photos", expect.anything());
    expect(out.photosMissing).toBe(0);
  });

  /** A copy that silently lacks a route is a wrong answer, not a partial one. */
  it("stops when a walk's route does not come back", async () => {
    const d = deps({ routes: vi.fn(async () => ({ w1: [] })) });
    await expect(buildClientExport("c-1", d)).rejects.toThrow(ExportError);
  });

  it("stops when the routes call fails", async () => {
    const d = deps({ routes: vi.fn(async () => { throw new Error("timeout"); }) });
    await expect(buildClientExport("c-1", d)).rejects.toThrow("timeout");
  });

  it("refuses a record it does not recognise rather than guessing at it", async () => {
    await expect(buildClientExport("c-1", deps({}, { format: "sanpo.client-export", version: 1 })))
      .rejects.toThrow(ExportError);
    const { stored_photos: _gone, ...noPhotos } = record();
    await expect(buildClientExport("c-1", deps({}, noPhotos))).rejects.toThrow(ExportError);
  });

  it("refuses to fetch from a bucket it does not know", async () => {
    const rec = record();
    rec.stored_photos.push({ bucket: "avatars" as "pet-photos", path: `${OP}/x.jpg` });
    await expect(buildClientExport("c-1", deps({}, rec))).rejects.toThrow("does not know how to fetch");
  });

  it("says how many points the file holds, which is how many came back", async () => {
    const d = deps({
      routes: vi.fn(async () => ({ w1: [["t", 1, 2, 5, false]], w2: [] })),
    });
    const files = await unzip((await buildClientExport("c-1", d)).blob);
    expect(JSON.parse(files["record.json"]!).walks[0].route_points).toBe(1);
  });

  it("reports each stage as it goes", async () => {
    const progress = vi.fn();
    await buildClientExport("c-1", deps({ progress }));
    const stages = progress.mock.calls.map(([p]) => p.stage);
    expect(stages[0]).toBe("record");
    expect(stages).toContain("routes");
    expect(progress).toHaveBeenCalledWith({ stage: "photos", done: 3, total: 3 });
    expect(stages[stages.length - 1]).toBe("archive");
  });
});

describe("before fetching anything", () => {
  /** A copy that could never be written is refused before the first download. */
  it("refuses a copy with more files than one ZIP can list", async () => {
    const rec = record();
    rec.stored_photos = Array.from({ length: ZIP_MAX_ENTRIES - 1 }, (_, i) =>
      ({ bucket: "walk-photos" as const, path: `${OP}/w1/${i}.jpg` }));
    const d = deps({}, rec);
    await expect(buildClientExport("c-1", d)).rejects.toThrow(/more than one ZIP file can .*Nothing was fetched/);
    expect(d.download).not.toHaveBeenCalled();
    expect(d.routes).not.toHaveBeenCalled();
  });

  it("refuses a copy whose photos come to more than one ZIP can hold", async () => {
    const rec = record();
    rec.stored_photos = [
      { bucket: "pet-photos", path: `${OP}/pet-1/a.jpg`, bytes: 3 * 2 ** 30 },
      { bucket: "walk-photos", path: `${OP}/w1/x.jpg`, bytes: 2 ** 30 },
    ];
    const d = deps({}, rec);
    await expect(buildClientExport("c-1", d)).rejects.toThrow(/4\.0 GiB, more than one ZIP file can hold/);
    expect(d.download).not.toHaveBeenCalled();
  });

  /** Only what Storage recorded is counted; the archive checks the real bytes. */
  it("does not count a size Storage did not record", async () => {
    const rec = record();
    rec.stored_photos = rec.stored_photos.map((s) => ({ ...s, bytes: null }));
    await expect(buildClientExport("c-1", deps({}, rec))).resolves.toMatchObject({ photos: 3 });
  });
});

describe("cancelling", () => {
  it("stops before fetching anything when cancelled at once", async () => {
    const controller = new AbortController();
    controller.abort();
    const d = deps({ signal: controller.signal });
    await expect(buildClientExport("c-1", d)).rejects.toThrow(ExportCancelled);
    expect(d.routes).not.toHaveBeenCalled();
    expect(d.download).not.toHaveBeenCalled();
  });

  /**
   * A download the walker cancelled fails like a missing photo would. Every
   * download here is under way before the cancel lands, so each one fails
   * that way, and the copy must still not be saved with them "missing".
   */
  it("stops part way through the photos, rather than saving a copy with them missing", async () => {
    const controller = new AbortController();
    const download = vi.fn(async (_b: string, path: string, signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      await new Promise((r) => setTimeout(r, 0));
      controller.abort();
      throw new Error(`aborted fetching ${path}`);
    });
    const d = deps({ signal: controller.signal, download });
    await expect(buildClientExport("c-1", d)).rejects.toThrow(ExportCancelled);
    expect(download).toHaveBeenCalledTimes(3);
  });

  /** Photos are fetched a few at a time; a cancel stops the next few being asked for. */
  it("asks for no more photos once cancelled", async () => {
    const controller = new AbortController();
    const rec = record();
    rec.stored_photos = Array.from({ length: 10 }, (_, i) =>
      ({ bucket: "walk-photos" as const, path: `${OP}/w1/${i}.jpg` }));
    const download = vi.fn(async (_b: string, path: string) => {
      controller.abort();
      return new Blob([path]);
    });
    await expect(buildClientExport("c-1", deps({ signal: controller.signal, download }, rec)))
      .rejects.toThrow(ExportCancelled);
    expect(download).toHaveBeenCalledTimes(1);
  });
});

describe("record.json", () => {
  const rec = {
    client: { full_name: "Jane Doe" },
    walks: [
      { id: "w1", route: [["2026-09-01T10:00:00Z", 41.1, -87.1, 5, false], ["2026-09-01T10:00:05Z", 41.2, -87.2, 5, true]] },
      { id: "w2", route: [] },
    ],
  };

  it("reads back as exactly the record", () => {
    expect(JSON.parse(recordJson(rec))).toEqual(rec);
  });

  /** Indenting every point more than doubled a long-standing client's file. */
  it("puts each route on one line and indents the rest", () => {
    const text = recordJson(rec);
    expect(text).toContain('"route": [["2026-09-01T10:00:00Z",41.1,-87.1,5,false],["2026-09-01T10:00:05Z",41.2,-87.2,5,true]]');
    expect(text).toContain('"route": []');
    expect(text).toContain('\n  "client": {\n    "full_name": "Jane Doe"');
  });

  it("is far smaller than indenting every point, for a long route", () => {
    const long = { walks: [{ id: "w", route: Array.from({ length: 5_000 }, (_, i) =>
      [`2026-09-01T10:00:${String(i % 60).padStart(2, "0")}Z`, 41.123456, -87.123456, 5, false]) }] };
    expect(recordJson(long).length).toBeLessThan(JSON.stringify(long, null, 2).length / 2);
  });
});

describe("what the screen says", () => {
  /** The announced text changes with the stage, never with each photo. */
  it("announces the stage alone", () => {
    expect(exportProgressText({ stage: "record", done: 0, total: 1 })).toBe("Reading their record…");
    expect(exportProgressText({ stage: "routes", done: 0, total: 4 })).toBe("Fetching their routes…");
    expect(exportProgressText({ stage: "photos", done: 2, total: 9 }))
      .toBe(exportProgressText({ stage: "photos", done: 8, total: 9 }));
    expect(exportProgressText({ stage: "archive", done: 0, total: 1 })).toBe("Packing the file…");
  });

  it("shows how far the stage has got", () => {
    expect(exportProgressCount({ stage: "routes", done: 0, total: 4 })).toBe("1 of 4 batches of routes");
    expect(exportProgressCount({ stage: "photos", done: 2, total: 9 })).toBe("2 of 9 photos");
    expect(exportProgressCount({ stage: "record", done: 0, total: 1 })).toBeNull();
  });
});

describe("routeBatches", () => {
  /**
   * The browser's batch size and the database's cap are one rule in two
   * runtimes. A batch bigger than the cap is refused whole, so an export of a
   * client with more walks than it would fail every time.
   */
  it("never asks for more walks than fn_export_client_routes answers at once", () => {
    const body = lastFunctionBody("fn_export_client_routes");
    const cap = /cardinality\(p_walks\)\s*>\s*(\d+)/.exec(body);
    expect(cap, "fn_export_client_routes no longer states its cap the way this reads it").not.toBeNull();
    expect(ROUTE_BATCH_WALKS).toBeLessThanOrEqual(Number(cap![1]));
  });

  it("keeps each batch under the point budget", () => {
    const walks = Array.from({ length: 10 }, (_, i) => ({ id: `w${i}`, route_points: 7_000 }));
    const batches = routeBatches(walks);
    expect(batches.flat()).toEqual(walks.map((w) => w.id));
    for (const b of batches) expect(b.length * 7_000).toBeLessThanOrEqual(ROUTE_BATCH_POINTS);
  });

  it("keeps each batch under the walk limit", () => {
    const walks = Array.from({ length: 450 }, (_, i) => ({ id: `w${i}`, route_points: 0 }));
    const batches = routeBatches(walks);
    expect(batches.map((b) => b.length)).toEqual([ROUTE_BATCH_WALKS, ROUTE_BATCH_WALKS, 50]);
  });

  it("gives a walk bigger than the budget a batch of its own", () => {
    const batches = routeBatches([
      { id: "a", route_points: 10 }, { id: "big", route_points: 50_000 }, { id: "b", route_points: 10 },
    ]);
    expect(batches).toEqual([["a"], ["big"], ["b"]]);
  });
});

describe("exportFileName", () => {
  it("is safe to save anywhere", () => {
    expect(exportFileName("Zoë O'Brien / Apt 2", new Date("2026-09-24T17:00:00Z")))
      .toBe("sanpo-zoe-o-brien-apt-2-2026-09-24.zip");
    expect(exportFileName("Мила", new Date("2026-09-24T17:00:00Z"))).toBe("sanpo-client-2026-09-24.zip");
  });

  /** A copy made at 8pm in Chicago is named for that evening, not for UTC's tomorrow. */
  it("is named for the walker's day", () => {
    expect(exportFileName("Jane Doe", new Date("2026-09-25T01:00:00Z"))).toBe("sanpo-jane-doe-2026-09-24.zip");
  });
});
