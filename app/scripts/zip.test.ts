import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assertSafeName, crc32, ZipLimitError, zipBlob, zipEntry } from "../src/lib/zip.ts";

/**
 * The client's copy of their data is a ZIP this repository writes itself, so
 * it is checked by a reader this repository did not write: Python's
 * `zipfile`, which verifies every entry's CRC and reads the names as the
 * general-purpose flags say. A reader written from the same reading of the
 * format as the writer would share its mistakes.
 *
 * Python is required, not optional. A test that skipped without it would
 * report the writer as checked on any machine that lacks it.
 */

const dir = mkdtempSync(join(tmpdir(), "sanpo-zip-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** What Python's zipfile reads back: each entry's name, size, CRC and bytes (hex). */
async function readBack(blob: Blob): Promise<Array<{ name: string; size: number; crc: number; hex: string; flags: number; method: number }>> {
  const path = join(dir, `a-${Math.random().toString(36).slice(2)}.zip`);
  writeFileSync(path, new Uint8Array(await blob.arrayBuffer()));
  const script = [
    "import json, sys, zipfile",
    "z = zipfile.ZipFile(sys.argv[1])",
    "bad = z.testzip()",
    "assert bad is None, 'bad CRC in ' + str(bad)",
    "print(json.dumps([{'name': i.filename, 'size': i.file_size, 'crc': i.CRC,",
    "  'hex': z.read(i.filename).hex(), 'flags': i.flag_bits, 'method': i.compress_type}",
    "  for i in z.infolist()]))",
  ].join("\n");
  const out = execFileSync("python3", ["-c", script, path], { encoding: "utf8" });
  return JSON.parse(out);
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const AT = new Date(2026, 8, 24, 10, 30, 12);

describe("crc32", () => {
  it("gives the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
  it("is zero for nothing", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("zipBlob, read back by Python's zipfile", () => {
  it("writes entries another reader opens, byte for byte, with valid CRCs", async () => {
    const json = new TextEncoder().encode(JSON.stringify({ a: 1 }));
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    const blob = zipBlob([
      await zipEntry("record.json", json),
      await zipEntry("photos/2026-09-01_p1.jpg", new Blob([jpeg])),
      await zipEntry("empty.txt", new Uint8Array(0)),
    ], AT);
    const read = await readBack(blob);
    expect(read.map((e) => e.name)).toEqual(["record.json", "photos/2026-09-01_p1.jpg", "empty.txt"]);
    expect(read[0]!.hex).toBe(hex(json));
    expect(read[1]!.hex).toBe(hex(jpeg));
    expect(read[2]!.size).toBe(0);
    for (const e of read) expect(e.method).toBe(0); // stored
  });

  it("marks names as UTF-8, so a pet called Мила is Мила", async () => {
    const blob = zipBlob([await zipEntry("pets/Мила-🐕.jpg", new Uint8Array([1]))], AT);
    const [e] = await readBack(blob);
    expect(e!.name).toBe("pets/Мила-🐕.jpg");
    expect(e!.flags & 0x0800).toBe(0x0800);
  });

  it("holds a thousand entries", async () => {
    const entries = await Promise.all(
      Array.from({ length: 1000 }, (_, i) => zipEntry(`photos/${i}.jpg`, new Uint8Array([i & 0xff]))),
    );
    const read = await readBack(zipBlob(entries, AT));
    expect(read).toHaveLength(1000);
    expect(read[999]!.hex).toBe("e7");
  });
});

describe("zipBlob refuses what it cannot write correctly", () => {
  it("refuses two files with one name", async () => {
    const e = await zipEntry("a.txt", new Uint8Array([1]));
    expect(() => zipBlob([e, e], AT)).toThrow("two files named a.txt");
  });

  it("refuses more entries than a ZIP without ZIP64 can count", () => {
    const e = { name: "x", data: new Blob([]), crc: 0, size: 0 };
    // 0xFFFF is the ZIP64 marker in the count field, so it is refused too.
    expect(() => zipBlob(Array.from({ length: 0xffff }, () => e), AT)).toThrow(ZipLimitError);
  });

  it("refuses an entry whose declared size is not its data's", async () => {
    const e = await zipEntry("a.txt", new Uint8Array([1, 2]));
    expect(() => zipBlob([{ ...e, size: 1 }], AT)).toThrow("its size says 1");
  });

  it("refuses a name an unzip tool would place outside its folder", () => {
    for (const bad of ["/etc/passwd", "../x", "a/../../x", "a\\b", "a//b", "", "./x", "a\u0000b"]) {
      expect(() => assertSafeName(bad), bad).toThrow("not a safe archive name");
    }
    for (const ok of ["record.json", "photos/2026-09-01_x.jpg", "pets/Мила.jpg"]) {
      expect(() => assertSafeName(ok), ok).not.toThrow();
    }
  });
});
