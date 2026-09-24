// A minimal ZIP writer for the client's copy of their data.
//
// STORE only: every entry is written uncompressed. The payload is JPEG photos
// and one JSON record, and a JPEG does not compress; DEFLATE would buy a few
// percent on the record for an implementation several times this size. The
// format is the 1993 PKWARE subset every unzip tool reads: a local header per
// entry, the central directory, and the end record. Names are UTF-8 and say so
// (general-purpose flag bit 11), because a pet's name need not be ASCII.
//
// Each entry's bytes stay a Blob. The CRC is computed once, from the bytes,
// and the archive is assembled as a Blob of parts, so a copy with a year of
// photos is never held in memory twice.
//
// No ZIP64: a copy with 65,535 files or 4 GiB is refused by name rather than
// written wrong. One client's photos are nowhere near either.

export class ZipLimitError extends Error {}

/**
 * The most a ZIP without ZIP64 can hold. 0xFFFF in the count field tells a
 * reader to look for a ZIP64 record, so the most it can say it holds is
 * 0xFFFE; sizes and offsets are 32-bit. Exported so a caller can refuse a
 * copy it could never write before fetching anything for it.
 */
export const ZIP_MAX_ENTRIES = 0xfffe;
export const ZIP_MAX_BYTES = 0xffffffff;

export interface ZipEntry {
  /** A relative path, `/`-separated, as the archive will show it. */
  name: string;
  data: Blob;
  crc: number;
  size: number;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (ISO 3309), the checksum ZIP uses. */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A name an unzip tool will place inside the folder it extracts to. No
 * absolute path, no `..` segment, no backslash, no empty segment, no control
 * character: the names here are built from ids and dates, and a name that
 * breaks one of these is a bug, not an input to escape.
 */
export function assertSafeName(name: string): void {
  const bad =
    name.length === 0 ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.split("/").some((seg) => seg === "" || seg === "." || seg === "..") ||
    [...name].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
  if (bad) throw new Error(`not a safe archive name: ${JSON.stringify(name)}`);
}

/** An entry for `data`, with its CRC and size read from the bytes. */
export async function zipEntry(name: string, data: Blob | Uint8Array<ArrayBuffer>): Promise<ZipEntry> {
  assertSafeName(name);
  const blob = data instanceof Blob ? data : new Blob([data]);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { name, data: blob, crc: crc32(bytes), size: bytes.length };
}

/** MS-DOS date and time fields, from the local wall clock as the format expects. */
function dosDateTime(at: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, at.getFullYear()));
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  };
}

const MAX_32 = ZIP_MAX_BYTES;
const UTF8_NAMES = 0x0800;

/** The archive. */
export function zipBlob(entries: ZipEntry[], at: Date): Blob {
  if (entries.length > ZIP_MAX_ENTRIES) {
    throw new ZipLimitError(`${entries.length} files is more than one ZIP without ZIP64 can hold`);
  }
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(at);
  const seen = new Set<string>();
  // Named rather than `BlobPart[]`: that type is the DOM library's, and this
  // module is also typechecked under Node's (from app/scripts/).
  const parts: Array<Blob | Uint8Array<ArrayBuffer>> = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;

  for (const entry of entries) {
    assertSafeName(entry.name);
    if (seen.has(entry.name)) throw new Error(`two files named ${entry.name}`);
    seen.add(entry.name);
    if (entry.size !== entry.data.size) {
      throw new Error(`${entry.name}: its size says ${entry.size} and its data holds ${entry.data.size}`);
    }
    const name = encoder.encode(entry.name);
    const size = entry.size;
    if (size >= MAX_32 || offset + 30 + name.length + size >= MAX_32) {
      throw new ZipLimitError("the copy is larger than a ZIP without ZIP64 can hold (4 GiB)");
    }

    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true); // local file header
    l.setUint16(4, 20, true); // version needed: 2.0
    l.setUint16(6, UTF8_NAMES, true);
    l.setUint16(8, 0, true); // method: stored
    l.setUint16(10, time, true);
    l.setUint16(12, date, true);
    l.setUint32(14, entry.crc, true);
    l.setUint32(18, size, true); // compressed size
    l.setUint32(22, size, true); // uncompressed size
    l.setUint16(26, name.length, true);
    l.setUint16(28, 0, true); // extra field length
    local.set(name, 30);

    const dir = new Uint8Array(46 + name.length);
    const d = new DataView(dir.buffer);
    d.setUint32(0, 0x02014b50, true); // central directory header
    d.setUint16(4, 20, true); // version made by: MS-DOS, 2.0
    d.setUint16(6, 20, true);
    d.setUint16(8, UTF8_NAMES, true);
    d.setUint16(10, 0, true);
    d.setUint16(12, time, true);
    d.setUint16(14, date, true);
    d.setUint32(16, entry.crc, true);
    d.setUint32(20, size, true);
    d.setUint32(24, size, true);
    d.setUint16(28, name.length, true);
    // extra, comment, disk number, internal and external attributes: all 0
    d.setUint32(42, offset, true); // where this entry's local header starts
    dir.set(name, 46);

    parts.push(local, entry.data);
    central.push(dir);
    offset += local.length + size;
  }

  const dirSize = central.reduce((n, c) => n + c.length, 0);
  if (offset + dirSize + 22 >= MAX_32) {
    throw new ZipLimitError("the copy is larger than a ZIP without ZIP64 can hold (4 GiB)");
  }
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); // end of central directory
  e.setUint16(8, entries.length, true); // entries on this disk
  e.setUint16(10, entries.length, true); // entries in total
  e.setUint32(12, dirSize, true);
  e.setUint32(16, offset, true); // where the central directory starts
  return new Blob([...parts, ...central, end], { type: "application/zip" });
}
