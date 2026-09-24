// The client's copy of their data, as the walker downloads it for them.
//
// The copy is a ZIP: `record.json` (everything `fn_export_client_data`
// returns, with each walk's route and each photo's file name added), the
// photos, and a README saying what is and is not in it.
//
// Three things are assembled here rather than in SQL, each for a reason:
// - Routes come in batches from `fn_export_client_routes`. Two years of walks
//   is hundreds of thousands of points, about 20 MB of JSON; one call that
//   size runs close to the statement timeout. Each walk in the record says
//   how many points it has, so batches are sized by points, and a walk the
//   batch did not answer for stops the export: a copy that silently lacks a
//   route would be a wrong answer to "what do you hold about me".
// - Photos are storage objects, which SQL cannot read. The record lists every
//   object Storage holds in the client's folders (`stored_photos`), not only
//   the ones a row points at, and each is fetched once. A photo that cannot be
//   fetched does not stop the export: the record says it is missing and the
//   walker is told how many, because a copy without one photo is still most
//   of the answer, and refusing it would leave the client with nothing.
// - The archive itself (lib/zip.ts).

// The extensions are explicit because this module is also typechecked from
// `app/scripts/`, whose Node module rules require them; the app's bundler
// resolution accepts them too.
import { isoDateLocal } from "./format.ts";
import { ZIP_MAX_BYTES, ZIP_MAX_ENTRIES, zipBlob, zipEntry, type ZipEntry } from "./zip.ts";

/** One batch of routes: at most this many walks and roughly this many points. */
export const ROUTE_BATCH_WALKS = 200;
export const ROUTE_BATCH_POINTS = 20_000;
/** Photos fetched at once. */
const PHOTO_CONCURRENCY = 4;

type PhotoBucket = "walk-photos" | "pet-photos";

export interface ExportProgress {
  stage: "record" | "routes" | "photos" | "archive";
  done: number;
  total: number;
}

export interface ExportDeps {
  record(clientId: string): Promise<unknown>;
  routes(clientId: string, walkIds: string[]): Promise<unknown>;
  /** The object's bytes, or a throw. */
  download(bucket: PhotoBucket, path: string, signal?: AbortSignal): Promise<Blob>;
  now(): Date;
  progress?(p: ExportProgress): void;
  /** Aborting it stops the copy at the next step, and nothing is saved. */
  signal?: AbortSignal;
}

export interface ExportResult {
  blob: Blob;
  fileName: string;
  /** Photos in the archive. */
  photos: number;
  /** Photos Storage holds that could not be fetched; asking again may get them. */
  photosMissing: number;
}

export class ExportError extends Error {}
/** The walker stopped the copy. Not a failure: nothing was saved, by request. */
export class ExportCancelled extends Error {}

/**
 * What the copy is doing, in words. This is what the screen announces, so it
 * changes only when the stage does: a status region that spoke once per
 * photo would read a long copy out one photo at a time.
 */
export function exportProgressText(p: ExportProgress): string {
  switch (p.stage) {
    case "record":
      return "Reading their record…";
    case "routes":
      return "Fetching their routes…";
    case "photos":
      return "Fetching their photos…";
    case "archive":
      return "Packing the file…";
  }
}

/** How far the current stage has got, for the screen but not announced. */
export function exportProgressCount(p: ExportProgress): string | null {
  switch (p.stage) {
    case "routes":
      return `${p.done + 1} of ${p.total} batches of routes`;
    case "photos":
      return `${p.done} of ${p.total} photos`;
    default:
      return null;
  }
}

interface WalkRow {
  id: string;
  scheduled_date: string;
  route_points: number;
  route?: unknown[];
  photos: PhotoRow[];
}
interface PhotoRow {
  id: string;
  storage_path: string;
  file?: string;
  /** Storage holds it but it could not be fetched. */
  missing?: true;
  /** The row names an object Storage no longer holds. */
  not_stored?: true;
}
interface PetRow {
  id: string;
  photo_path: string | null;
  photo_file?: string;
  photo_missing?: true;
  photo_not_stored?: true;
}
interface StoredPhoto {
  bucket: PhotoBucket;
  path: string;
  /** The size Storage recorded for it, when it recorded one. */
  bytes?: number | null;
  file?: string;
  missing?: true;
}
interface RecordShape {
  format: string;
  version: number;
  client: { full_name: string };
  walks: WalkRow[];
  pets: PetRow[];
  stored_photos: StoredPhoto[];
}

function asRecord(value: unknown): RecordShape {
  const r = value as Partial<RecordShape> | null;
  if (!r || r.format !== "sanpo.client-export" || r.version !== 2
      || !Array.isArray(r.walks) || !Array.isArray(r.pets) || !Array.isArray(r.stored_photos)
      || !r.client) {
    throw new ExportError("The export came back in a shape this app does not know.");
  }
  for (const s of r.stored_photos) {
    if ((s.bucket !== "walk-photos" && s.bucket !== "pet-photos") || typeof s.path !== "string") {
      throw new ExportError("The export named a photo this app does not know how to fetch.");
    }
  }
  return r as RecordShape;
}

/** Walks grouped so that no batch asks for too many walks or points. */
export function routeBatches(walks: Array<Pick<WalkRow, "id" | "route_points">>): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let points = 0;
  for (const w of walks) {
    const n = Math.max(0, w.route_points ?? 0);
    if (current.length > 0
        && (current.length >= ROUTE_BATCH_WALKS || points + n > ROUTE_BATCH_POINTS)) {
      batches.push(current);
      current = [];
      points = 0;
    }
    current.push(w.id);
    points += n;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** The extension of a stored object, if it has a plain one. */
function extensionOf(path: string): string {
  const m = /\.([a-z0-9]{1,5})$/i.exec(path);
  return m ? m[1]!.toLowerCase() : "bin";
}

async function inBatches<T>(items: T[], size: number, run: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(run));
  }
}

export function exportFileName(fullName: string, at: Date): string {
  const slug = fullName.normalize("NFKD").replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "").toLowerCase() || "client";
  // The walker's calendar day, not the UTC one: a copy made at 8pm in
  // Chicago is named for that evening.
  const day = isoDateLocal(at);
  return `sanpo-${slug}-${day}.zip`;
}

/**
 * Refuse, before fetching anything, a copy that could never be written:
 * more files than a ZIP can list, or more bytes than it can address. Only
 * the sizes Storage recorded are counted; the archive still checks the real
 * bytes as it is written.
 */
function assertFits(record: RecordShape) {
  const files = record.stored_photos.length + 2;
  if (files > ZIP_MAX_ENTRIES) {
    throw new ExportError(
      `The copy would hold ${files.toLocaleString("en-US")} files, more than one ZIP file can `
      + `(${ZIP_MAX_ENTRIES.toLocaleString("en-US")}). Nothing was fetched.`,
    );
  }
  const bytes = record.stored_photos.reduce((n, s) => n + (typeof s.bytes === "number" ? s.bytes : 0), 0);
  if (bytes >= ZIP_MAX_BYTES) {
    throw new ExportError(
      `The copy's photos come to ${(bytes / 2 ** 30).toFixed(1)} GiB, more than one ZIP file can hold `
      + "(4 GiB). Nothing was fetched.",
    );
  }
}

/**
 * The record, indented so a person can read it, with each route on one line:
 * a route is thousands of five-item points, and indenting each one more than
 * doubled a long-standing client's file (40 MB against 19 MB, measured).
 */
export function recordJson(record: unknown): string {
  const routes: string[] = [];
  const text = JSON.stringify(record, (key, value) => {
    if (key === "route" && Array.isArray(value)) {
      routes.push(JSON.stringify(value));
      // A placeholder no value can hold: Postgres text cannot contain NUL.
      return `\u0000route:${routes.length - 1}`;
    }
    return value;
  }, 2);
  return text.replace(/"\\u0000route:(\d+)"/g, (_m, i: string) => routes[Number(i)]!);
}

export async function buildClientExport(clientId: string, deps: ExportDeps): Promise<ExportResult> {
  const stopIfCancelled = () => {
    if (deps.signal?.aborted) throw new ExportCancelled("The copy was cancelled.");
  };
  deps.progress?.({ stage: "record", done: 0, total: 1 });
  const record = asRecord(await deps.record(clientId));
  stopIfCancelled();
  assertFits(record);

  // Routes, batch by batch. Every walk must come back.
  const batches = routeBatches(record.walks);
  const walksById = new Map(record.walks.map((w) => [w.id, w]));
  for (const [i, batch] of batches.entries()) {
    stopIfCancelled();
    deps.progress?.({ stage: "routes", done: i, total: batches.length });
    const answer = (await deps.routes(clientId, batch)) as Record<string, unknown> | null;
    for (const id of batch) {
      const points = answer?.[id];
      if (!Array.isArray(points)) {
        throw new ExportError("A walk's route did not come back, so the copy would be incomplete.");
      }
      const walk = walksById.get(id)!;
      walk.route = points;
      // The file says how many points it holds, which is the count that came back.
      walk.route_points = points.length;
    }
  }

  // Name each stored photo by what it belongs to: a visit photo by its date
  // and row, a pet's current photo by the pet, anything else under earlier/.
  const key = (bucket: PhotoBucket, path: string) => `${bucket}/${path}`;
  const stored = new Map(record.stored_photos.map((s) => [key(s.bucket, s.path), s]));
  const fileOf = new Map<string, string>();
  for (const w of record.walks) {
    for (const p of w.photos) {
      const k = key("walk-photos", p.storage_path);
      if (stored.has(k) && !fileOf.has(k)) {
        fileOf.set(k, `photos/${w.scheduled_date}_${p.id}.${extensionOf(p.storage_path)}`);
      }
    }
  }
  for (const pet of record.pets) {
    if (!pet.photo_path) continue;
    const k = key("pet-photos", pet.photo_path);
    if (stored.has(k) && !fileOf.has(k)) fileOf.set(k, `pets/${pet.id}.${extensionOf(pet.photo_path)}`);
  }
  let earlier = 0;
  for (const s of record.stored_photos) {
    const k = key(s.bucket, s.path);
    if (!fileOf.has(k)) fileOf.set(k, `earlier/${++earlier}.${extensionOf(s.path)}`);
  }

  // Fetch each once. A failure marks it missing and the copy goes on.
  const entries: ZipEntry[] = [];
  const fetched = new Set<string>();
  let done = 0;
  const unique = [...stored.values()];
  await inBatches(unique, PHOTO_CONCURRENCY, async (s) => {
    stopIfCancelled();
    const k = key(s.bucket, s.path);
    const name = fileOf.get(k)!;
    try {
      entries.push(await zipEntry(name, await deps.download(s.bucket, s.path, deps.signal)));
      s.file = name;
      fetched.add(k);
    } catch {
      s.missing = true;
    }
    deps.progress?.({ stage: "photos", done: ++done, total: unique.length });
  });
  // A download the walker cancelled fails like a missing photo would; this
  // is what keeps it from being saved as one.
  stopIfCancelled();

  // Tell each row where its photo went, or why it is not there.
  for (const w of record.walks) {
    for (const p of w.photos) {
      const k = key("walk-photos", p.storage_path);
      if (!stored.has(k)) p.not_stored = true;
      else if (fetched.has(k)) p.file = fileOf.get(k)!;
      else p.missing = true;
    }
  }
  for (const pet of record.pets) {
    if (!pet.photo_path) continue;
    const k = key("pet-photos", pet.photo_path);
    if (!stored.has(k)) pet.photo_not_stored = true;
    else if (fetched.has(k)) pet.photo_file = fileOf.get(k)!;
    else pet.photo_missing = true;
  }

  const photosMissing = unique.length - fetched.size;
  deps.progress?.({ stage: "archive", done: 0, total: 1 });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const at = deps.now();
  const text = new TextEncoder();
  const head = [
    await zipEntry("README.txt", text.encode(readme(photosMissing, earlier))),
    await zipEntry("record.json", text.encode(recordJson(record))),
  ];
  return {
    blob: zipBlob([...head, ...entries], at),
    fileName: exportFileName(record.client.full_name, at),
    photos: fetched.size,
    photosMissing,
  };
}

function readme(photosMissing: number, earlier: number): string {
  return [
    "Your data, as Sanpo holds it for your walker.",
    "",
    "record.json   Everything in one file: your details, addresses, pets, schedules,",
    "              visits (each with its route and photos), your plan and its",
    "              changes, credits, payments, when your entry codes were viewed or",
    "              changed and why, and your walker's notes and notifications about",
    "              you. Money is in US cents.",
    "photos/       The photos taken on your visits, named by date. Each visit's",
    "              entry in record.json names its files.",
    "pets/         Your pets' current photos.",
    ...(earlier > 0
      ? ["earlier/      Other photos Sanpo still holds for you: a pet's earlier photos,",
         "              or a visit photo that was never attached to its visit.",
         "              \"stored_photos\" in record.json lists every one."]
      : []),
    "",
    "A route is a list of points, each [time, latitude, longitude, accuracy in",
    "metres, gap]. Coordinates are rounded to six decimal places, about 11 cm.",
    "A point marked as a gap starts again after a stretch nothing recorded, so",
    "no line should be drawn to it from the point before.",
    "",
    ...(photosMissing > 0
      ? [`${photosMissing} photo(s) could not be fetched when this copy was made.`,
         "record.json marks each one as missing; ask your walker for a new copy.", ""]
      : []),
    "Not in this copy, and why, is listed under \"not_included\" in record.json.",
    "",
  ].join("\n");
}
