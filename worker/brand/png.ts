/**
 * Minimal PNG encoder for the generated link-preview card (spec §8.2 "OG
 * image"). Workers have no canvas; a flat accent card with a lighter band is
 * enough for a branded preview, and needs only zlib (CompressionStream) and
 * CRC32. Owners who want artwork upload their own OG image.
 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function zlib(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const rgbOf = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** A `width`×`height` card: `fill` with a `band`-colored strip along the bottom. */
export async function cardPng(opts: { width: number; height: number; fill: string; band: string; bandHeight: number }): Promise<Uint8Array> {
  const { width, height } = opts;
  const fill = rgbOf(opts.fill);
  const band = rgbOf(opts.band);
  const stride = width * 3 + 1;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const c = y >= height - opts.bandHeight ? band : fill;
    const row = y * stride;
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) raw.set(c, row + 1 + x * 3);
  }
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, no interlace
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', await zlib(raw)),
    chunk('IEND', new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
