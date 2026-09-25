/**
 * The brand as the rest of the app sees it: settings + uploaded assets +
 * a content version. Every brand URL carries `?v=<version>`, so a change to
 * the brand is a new URL: caches never need purging (spec §8.2 "purged when
 * the brand changes"; DECISIONS D-035).
 */
import { DEFAULT_THEME, type ThemeInput } from '@shared/theme/tokens';
import { DEFAULT_ORG_ID } from '../db/schema';
import type { AppEnv } from '../env';
import { sha256Hex } from '../lib/crypto';
import { SETTINGS, type SettingValue } from '../lib/settings';

export type BrandSettings = SettingValue<'brand'>;
export type BrandAssets = SettingValue<'brand_assets'>;
export type AssetSlot = keyof BrandAssets & string;

export interface BrandState {
  firmName: string | null;
  shortName: string | null;
  welcome: string | null;
  poweredBy: boolean;
  theme: ThemeInput;
  assets: BrandAssets;
  /** Changes whenever anything that affects brand output changes. */
  version: string;
}

export async function getBrandState(env: AppEnv): Promise<BrandState> {
  const rows = await env.DB.prepare("SELECT key, value_json FROM settings WHERE org_id = ? AND key IN ('brand', 'brand_assets')")
    .bind(DEFAULT_ORG_ID)
    .all<{ key: string; value_json: string }>();
  let brand: BrandSettings | null = null;
  let assets: BrandAssets = {};
  for (const r of rows.results) {
    try {
      if (r.key === 'brand') {
        const p = SETTINGS.brand.safeParse(JSON.parse(r.value_json));
        if (p.success) brand = p.data;
      } else {
        const p = SETTINGS.brand_assets.safeParse(JSON.parse(r.value_json));
        if (p.success) assets = p.data;
      }
    } catch {
      // A malformed row falls back to defaults rather than breaking every page.
    }
  }
  const font = assets['font-heading'];
  const theme: ThemeInput = brand
    ? {
        accent: brand.accent,
        neutral: brand.neutral,
        radius: brand.radius,
        density: brand.density,
        heading: brand.heading === 'custom' && !font ? 'sans' : brand.heading,
        headingFontUrl: font ? `/brand/asset/font-heading?v=${font.sha256.slice(0, 12)}` : null,
      }
    : DEFAULT_THEME;
  const version = (await sha256Hex(JSON.stringify({ brand, assets: Object.entries(assets).map(([k, a]) => [k, a?.sha256]), t: 1 }))).slice(0, 12);
  return {
    firmName: brand?.firmName || null,
    shortName: brand?.shortName || null,
    welcome: brand?.welcome || null,
    poweredBy: brand?.poweredBy ?? false,
    theme,
    assets,
    version,
  };
}

export function assetUrl(state: BrandState, slot: AssetSlot): string | null {
  const a = state.assets[slot];
  return a ? `/brand/asset/${slot}?v=${a.sha256.slice(0, 12)}` : null;
}

/** Initials for generated icons: "Northwind Grant Partners" → "NG". */
export function initials(name: string | null): string {
  const words = (name ?? '').split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w));
  const letters = words.slice(0, 2).map((w) => (/[A-Za-z0-9]/.exec(w)?.[0] ?? '').toUpperCase());
  return letters.join('') || '•';
}
