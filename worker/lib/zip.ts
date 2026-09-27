/**
 * Streaming ZIP writer for the data export (spec §5.9 "export everything").
 * Entries are stored (no compression: most of the bytes are PDFs and images
 * already compressed), with data descriptors so each file streams straight
 * from R2 without being buffered. Plain ZIP, not ZIP64: the archive must stay
 * under 4 GiB, and the writer errors out rather than produce a broken file.
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

export function crc32Update(crc: number, bytes: Uint8Array): number {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export const ZIP_LIMIT = 0xffffffff;

const enc = new TextEncoder();

function dosTime(ms: number): { time: number; date: number } {
  const d = new Date(ms);
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((Math.max(1980, d.getUTCFullYear()) - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

interface Entry {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

/** Safe path inside the archive: no leading slash, no `..`, no control characters. */
export function zipPath(...parts: string[]): string {
  return parts
    .map((p) =>
      p
        // eslint-disable-next-line no-control-regex -- control characters are exactly what's being removed
        .replace(/[\u0000-\u001f\u007f\\:*?"<>|]/g, '_')
        .replace(/^\.+/, '_')
        .replace(/\/+/g, '_')
        .slice(0, 150) || '_',
    )
    .join('/');
}

export class ZipWriter {
  private readonly entries: Entry[] = [];
  private offset = 0;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly readable: ReadableStream<Uint8Array>;

  constructor() {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    this.readable = readable;
    this.writer = writable.getWriter();
  }

  private async write(bytes: Uint8Array): Promise<void> {
    if (this.offset + bytes.length > ZIP_LIMIT) throw new Error('export_too_large');
    this.offset += bytes.length;
    await this.writer.write(bytes);
  }

  /** Adds one file; `data` is bytes, text, or a stream (R2 object body). */
  async add(name: string, data: Uint8Array | string | ReadableStream<Uint8Array>, modified = Date.now()): Promise<void> {
    if (this.entries.length >= 0xffff) throw new Error('export_too_large');
    const nameBytes = enc.encode(name);
    const { time, date } = dosTime(modified);
    const offset = this.offset;
    const head = new Uint8Array(30 + nameBytes.length);
    const h = new DataView(head.buffer);
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true); // version needed
    h.setUint16(6, 0x0808, true); // data descriptor + UTF-8 names
    h.setUint16(8, 0, true); // stored
    h.setUint16(10, time, true);
    h.setUint16(12, date, true);
    h.setUint16(26, nameBytes.length, true);
    head.set(nameBytes, 30);
    await this.write(head);

    let crc = 0;
    let size = 0;
    const chunks = typeof data === 'string' ? [enc.encode(data)] : data instanceof Uint8Array ? [data] : null;
    if (chunks) {
      for (const c of chunks) {
        crc = crc32Update(crc, c);
        size += c.length;
        await this.write(c);
      }
    } else {
      const reader = (data as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        crc = crc32Update(crc, value);
        size += value.length;
        await this.write(value);
      }
    }

    const desc = new Uint8Array(16);
    const d = new DataView(desc.buffer);
    d.setUint32(0, 0x08074b50, true);
    d.setUint32(4, crc, true);
    d.setUint32(8, size, true);
    d.setUint32(12, size, true);
    await this.write(desc);
    this.entries.push({ name: nameBytes, crc, size, offset, time, date });
  }

  async close(): Promise<void> {
    const start = this.offset;
    for (const e of this.entries) {
      const rec = new Uint8Array(46 + e.name.length);
      const v = new DataView(rec.buffer);
      v.setUint32(0, 0x02014b50, true);
      v.setUint16(4, 20, true); // made by
      v.setUint16(6, 20, true); // needed
      v.setUint16(8, 0x0808, true);
      v.setUint16(10, 0, true);
      v.setUint16(12, e.time, true);
      v.setUint16(14, e.date, true);
      v.setUint32(16, e.crc, true);
      v.setUint32(20, e.size, true);
      v.setUint32(24, e.size, true);
      v.setUint16(28, e.name.length, true);
      v.setUint32(42, e.offset, true);
      rec.set(e.name, 46);
      await this.write(rec);
    }
    const end = new Uint8Array(22);
    const v = new DataView(end.buffer);
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(8, this.entries.length, true);
    v.setUint16(10, this.entries.length, true);
    v.setUint32(12, this.offset - start, true);
    v.setUint32(16, start, true);
    await this.write(end);
    await this.writer.close();
  }

  async abort(reason: unknown): Promise<void> {
    await this.writer.abort(reason);
  }
}
