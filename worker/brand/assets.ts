/**
 * Brand asset uploads (spec §8.1): logos, mark, favicon, OG image, heading
 * font. Types are detected from the bytes (the declared Content-Type is not
 * trusted), sizes are capped per slot, SVGs are sanitized before storage,
 * and each file gets a random R2 key (`brand/{uuid}`).
 */
import type { AppEnv } from '../env';
import { sha256Hex } from '../lib/crypto';
import { HttpError } from '../lib/http';
import { deleteSetting, getSetting, setSetting } from '../lib/settings';
import type { AssetSlot } from './state';
import { sanitizeSvg, SvgRejectedError } from './svg';

type Kind = 'png' | 'jpeg' | 'webp' | 'svg' | 'ico' | 'woff2';

const MIME: Record<Kind, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
};

export const SLOT_RULES: Record<AssetSlot, { kinds: Kind[]; maxBytes: number; label: string }> = {
  'logo-light': { kinds: ['svg', 'png', 'webp', 'jpeg'], maxBytes: 1024 * 1024, label: 'Logo (light backgrounds)' },
  'logo-dark': { kinds: ['svg', 'png', 'webp', 'jpeg'], maxBytes: 1024 * 1024, label: 'Logo (dark backgrounds)' },
  mark: { kinds: ['svg', 'png', 'webp'], maxBytes: 512 * 1024, label: 'Mark / icon' },
  favicon: { kinds: ['svg', 'png', 'ico'], maxBytes: 256 * 1024, label: 'Favicon' },
  og: { kinds: ['png', 'jpeg'], maxBytes: 2 * 1024 * 1024, label: 'Link preview image' },
  'font-heading': { kinds: ['woff2'], maxBytes: 1024 * 1024, label: 'Heading font (WOFF2)' },
};

export const ASSET_SLOTS = Object.keys(SLOT_RULES) as AssetSlot[];

export function isSlot(v: string): v is AssetSlot {
  return (ASSET_SLOTS as string[]).includes(v);
}

function sniff(b: Uint8Array): Kind | null {
  const at = (i: number, ...bytes: number[]) => bytes.every((x, j) => b[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'jpeg';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'webp';
  if (at(0, 0x77, 0x4f, 0x46, 0x32)) return 'woff2';
  if (at(0, 0x00, 0x00, 0x01, 0x00)) return 'ico';
  const head = new TextDecoder().decode(b.slice(0, 512)).replace(/^\uFEFF/, '').trimStart().toLowerCase();
  if (head.startsWith('<svg') || head.startsWith('<?xml') || head.startsWith('<!--')) return 'svg';
  return null;
}

export async function storeAsset(env: AppEnv, slot: AssetSlot, body: ArrayBuffer): Promise<{ sha256: string; mime: string; size: number }> {
  const rule = SLOT_RULES[slot];
  if (body.byteLength === 0) throw new HttpError(422, 'file_empty');
  if (body.byteLength > rule.maxBytes) throw new HttpError(413, 'file_too_large', { maxBytes: rule.maxBytes });

  let bytes: Uint8Array<ArrayBuffer> = new Uint8Array(body);
  const kind = sniff(bytes);
  if (!kind || !rule.kinds.includes(kind)) throw new HttpError(415, 'file_type_not_allowed', { allowed: rule.kinds });

  if (kind === 'svg') {
    try {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
      bytes = new Uint8Array(new TextEncoder().encode(sanitizeSvg(text)));
    } catch (err) {
      if (err instanceof SvgRejectedError || err instanceof TypeError) throw new HttpError(422, 'svg_rejected');
      throw err;
    }
  }

  const sha256 = await sha256Hex(bytes);
  const key = `brand/${crypto.randomUUID()}`;
  await env.FILES.put(key, bytes, { httpMetadata: { contentType: MIME[kind] }, customMetadata: { slot, sha256 } });

  const current = (await getSetting(env, 'brand_assets')) ?? {};
  const previous = current[slot];
  await setSetting(env, 'brand_assets', { ...current, [slot]: { key, mime: MIME[kind], size: bytes.byteLength, sha256, updatedAt: Date.now() } });
  if (previous) await env.FILES.delete(previous.key);
  return { sha256, mime: MIME[kind], size: bytes.byteLength };
}

export async function removeAsset(env: AppEnv, slot: AssetSlot): Promise<boolean> {
  const current = (await getSetting(env, 'brand_assets')) ?? {};
  const previous = current[slot];
  if (!previous) return false;
  const next = Object.fromEntries(Object.entries(current).filter(([k]) => k !== slot));
  if (Object.keys(next).length) await setSetting(env, 'brand_assets', next);
  else await deleteSetting(env, 'brand_assets');
  await env.FILES.delete(previous.key);
  return true;
}
