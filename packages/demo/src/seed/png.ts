import { crc32, deflateSync } from 'node:zlib';

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** A small valid PNG (8-bit RGB): the screenshot or photo a requester attached to a ticket. */
export function png(width: number, height: number, shade: (x: number, y: number) => [number, number, number]): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3); // filter byte 0 (none) + pixels
    for (let x = 0; x < width; x++) row.set(shade(x, y), 1 + x * 3);
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A phone screenshot: light page, a dark title bar and a few content bars. */
export const screenshot = (): Buffer =>
  png(120, 200, (x, y) => (y < 18 ? [38, 70, 122] : y > 40 && y < 150 && y % 24 < 10 && x > 12 && x < 108 ? [200, 206, 214] : [246, 247, 249]));

/** A photographed receipt: a pale slip on a dark table with printed lines. */
export const receiptPhoto = (): Buffer =>
  png(150, 100, (x, y) => (x < 25 || x > 125 ? [64, 52, 44] : y % 12 < 3 && x > 36 && x < 114 ? [92, 92, 96] : [236, 232, 220]));
