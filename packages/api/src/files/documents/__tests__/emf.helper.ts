/** Minimal valid little-endian EMF: header, brush, select, rectangle, EOF. */
export function buildEmf(): Buffer {
  const parts: Buffer[] = [];
  const rec = (type: number, size: number, ...ints: number[]): Buffer => {
    const b = Buffer.alloc(size);
    b.writeUInt32LE(type, 0);
    b.writeUInt32LE(size, 4);
    ints.forEach((v, i) => b.writeInt32LE(v | 0, 8 + i * 4));
    return b;
  };
  const header = rec(
    1,
    108,
    0,
    0,
    99,
    49, // bounds
    0,
    0,
    2645,
    1322, // frame
    0x464d4520, // signature
    0x10000, // version
    0, // bytes (patched below)
    5, // records
    2, // handles (u32 + reserved u16 packed)
    0, // nDescription
    0, // offDescription
    0, // nPalEntries
    1920,
    1080, // device
    508,
    286, // millimeters
  );
  parts.push(header);
  parts.push(rec(39, 24, 1, 0, 0x00ff0000, 0));
  parts.push(rec(37, 12, 1));
  parts.push(rec(43, 24, 0, 0, 99, 49));
  parts.push(rec(14, 20, 0, 16, 20));
  const out = Buffer.concat(parts);
  out.writeUInt32LE(out.length, 48);
  return out;
}

/** Placeable WMF: header, SETWINDOWEXT, RECTANGLE, EOF. */
export function buildWmf(): Buffer {
  const rec = (func: number, ...words: number[]): Buffer => {
    const b = Buffer.alloc(6 + words.length * 2);
    b.writeUInt32LE(b.length / 2, 0);
    b.writeUInt16LE(func, 4);
    words.forEach((w, i) => b.writeInt16LE(w, 6 + i * 2));
    return b;
  };
  const placeable = Buffer.alloc(22);
  placeable.writeUInt32LE(0x9ac6cdd7, 0);
  placeable.writeInt16LE(99, 10);
  placeable.writeInt16LE(49, 12);
  placeable.writeUInt16LE(1440, 14);
  const header = Buffer.alloc(18);
  header.writeUInt16LE(1, 0);
  header.writeUInt16LE(9, 2);
  header.writeUInt16LE(0x300, 4);
  const body = Buffer.concat([rec(0x020c, 49, 99), rec(0x041b, 49, 99, 0, 0), rec(0)]);
  header.writeUInt32LE((18 + body.length) / 2, 6);
  return Buffer.concat([placeable, header, body]);
}

/** EMF with `n` no-output SETBKMODE records between the header and EOF. */
export function buildEmfWithRecords(n: number): Buffer {
  const base = buildEmf();
  const ellipse = Buffer.alloc(12);
  ellipse.writeUInt32LE(18, 0);
  ellipse.writeUInt32LE(12, 4);
  ellipse.writeUInt32LE(1, 8);
  const out = Buffer.concat([
    base.subarray(0, base.length - 20),
    ...Array(n).fill(ellipse),
    base.subarray(base.length - 20),
  ]);
  out.writeUInt32LE(out.length, 48);
  return out;
}
