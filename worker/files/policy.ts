/**
 * What may be uploaded to a client's vault (spec §6.3, §7.4). The browser's
 * claimed type is ignored: the extension picks a family, the first bytes must
 * match it, and the stored Content-Type comes from this table. HTML, SVG,
 * scripts and executables are never accepted.
 */
export const FILE_KINDS = ['pdf', 'document', 'spreadsheet', 'presentation', 'image', 'archive'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/** Default: documents, spreadsheets, PDFs and images (spec §6.3). Archives are opt-in. */
export const DEFAULT_KINDS: FileKind[] = ['pdf', 'document', 'spreadsheet', 'presentation', 'image'];
export const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
/** Hard ceiling for the Owner setting. Multipart keeps each request small, so this is about storage, not Workers limits. */
export const MAX_MAX_BYTES = 1024 * 1024 * 1024;

/** Multipart part size. R2 needs ≥ 5 MiB for every part but the last; 8 MiB keeps each request well under Workers' body limit. */
export const PART_SIZE = 8 * 1024 * 1024;

type Magic = 'pdf' | 'png' | 'jpeg' | 'gif' | 'webp' | 'heic' | 'zip' | 'ole' | 'rtf' | 'text';

interface ExtRule {
  kind: FileKind;
  mime: string;
  magic: Magic;
}

const EXT: Record<string, ExtRule> = {
  pdf: { kind: 'pdf', mime: 'application/pdf', magic: 'pdf' },
  doc: { kind: 'document', mime: 'application/msword', magic: 'ole' },
  docx: { kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: 'zip' },
  odt: { kind: 'document', mime: 'application/vnd.oasis.opendocument.text', magic: 'zip' },
  rtf: { kind: 'document', mime: 'application/rtf', magic: 'rtf' },
  txt: { kind: 'document', mime: 'text/plain; charset=utf-8', magic: 'text' },
  md: { kind: 'document', mime: 'text/plain; charset=utf-8', magic: 'text' },
  xls: { kind: 'spreadsheet', mime: 'application/vnd.ms-excel', magic: 'ole' },
  xlsx: { kind: 'spreadsheet', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', magic: 'zip' },
  ods: { kind: 'spreadsheet', mime: 'application/vnd.oasis.opendocument.spreadsheet', magic: 'zip' },
  csv: { kind: 'spreadsheet', mime: 'text/csv; charset=utf-8', magic: 'text' },
  ppt: { kind: 'presentation', mime: 'application/vnd.ms-powerpoint', magic: 'ole' },
  pptx: { kind: 'presentation', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', magic: 'zip' },
  odp: { kind: 'presentation', mime: 'application/vnd.oasis.opendocument.presentation', magic: 'zip' },
  png: { kind: 'image', mime: 'image/png', magic: 'png' },
  jpg: { kind: 'image', mime: 'image/jpeg', magic: 'jpeg' },
  jpeg: { kind: 'image', mime: 'image/jpeg', magic: 'jpeg' },
  gif: { kind: 'image', mime: 'image/gif', magic: 'gif' },
  webp: { kind: 'image', mime: 'image/webp', magic: 'webp' },
  heic: { kind: 'image', mime: 'image/heic', magic: 'heic' },
  heif: { kind: 'image', mime: 'image/heif', magic: 'heic' },
  zip: { kind: 'archive', mime: 'application/zip', magic: 'zip' },
};

/** Types a browser may show inline (spec §7.4). Everything else downloads. */
export const INLINE_MIMES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function extensionOf(filename: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(filename);
  return m?.[1]?.toLowerCase() ?? '';
}

export function ruleFor(filename: string): ExtRule | null {
  return EXT[extensionOf(filename)] ?? null;
}

export function acceptedExtensions(kinds: readonly FileKind[]): string[] {
  return Object.entries(EXT)
    .filter(([, r]) => kinds.includes(r.kind))
    .map(([ext]) => ext);
}

/**
 * Display name kept in D1 only (the R2 key is random). Strips paths, control
 * and bidi-override characters, and trims to a sane length while keeping the
 * extension.
 */
export function cleanFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  let name = base.replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, '').trim();
  name = name.replace(/^\.+/, '');
  if (name.length > 180) {
    const ext = extensionOf(name);
    name = `${name.slice(0, 170).trim()}${ext ? `.${ext}` : ''}`;
  }
  return name;
}

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

/** True when the first bytes match what the extension promises. */
export function matchesMagic(rule: ExtRule, head: Uint8Array): boolean {
  switch (rule.magic) {
    case 'pdf':
      return ascii(head, 0, 5) === '%PDF-';
    case 'png':
      return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'jpeg':
      return startsWith(head, [0xff, 0xd8, 0xff]);
    case 'gif':
      return ascii(head, 0, 4) === 'GIF8';
    case 'webp':
      return ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP';
    case 'heic':
      return ascii(head, 4, 8) === 'ftyp' && ['heic', 'heix', 'hevc', 'heif', 'mif1', 'msf1'].includes(ascii(head, 8, 12));
    case 'zip':
      return startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06]);
    case 'ole':
      return startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    case 'rtf':
      return ascii(head, 0, 5) === '{\\rtf';
    case 'text':
      return looksLikeText(head);
  }
}

function looksLikeText(head: Uint8Array): boolean {
  const sample = head.subarray(0, 8192);
  if (sample.includes(0)) return false;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(sample, { stream: true });
  } catch {
    return false;
  }
  // Plain text is served as text/plain with nosniff anyway; refusing markup-looking
  // files keeps anything that could be mistaken for a page out of the vault.
  return !/^\s*<(?:!doctype|html|head|body|script|svg|\?xml)/i.test(text);
}
