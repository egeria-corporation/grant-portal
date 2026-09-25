/**
 * WCAG 2.x contrast for the brand accent (spec §8.1). Shared by the wizard's
 * live check and the server's validation. The full accent ramp arrives in M2.
 */
export function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m?.[1]) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export interface AccentCheck {
  /** Text color to put on the accent: whichever of white/near-black reads better. */
  onAccent: '#ffffff' | '#121212';
  ratio: number;
  /** AA for normal text (4.5:1). */
  passesAA: boolean;
}

export function checkAccent(hex: string): AccentCheck | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const white = contrastRatio(rgb, [255, 255, 255]);
  const dark = contrastRatio(rgb, [18, 18, 18]);
  const onAccent = white >= dark ? '#ffffff' : '#121212';
  const ratio = Math.max(white, dark);
  return { onAccent, ratio: Math.round(ratio * 100) / 100, passesAA: ratio >= 4.5 };
}
