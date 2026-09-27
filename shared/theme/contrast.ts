/**
 * Accent check for the wizard and Settings → Brand (spec §8.1): any brand color
 * is accepted. The ramp nudges it until buttons and links meet WCAG AA, and
 * this reports what was changed so the UI can say so.
 */
import { accentRamp, contrast, normalizeHex } from './ramp';

export interface AccentCheck {
  /** Normalized input, e.g. `#e8604c`. */
  accent: string;
  /** What buttons actually use in light mode. */
  solid: string;
  onAccent: string;
  ratio: number;
  /** True when the solid shade differs from the brand color to pass AA. */
  adjusted: boolean;
  passesAA: true;
}

export function checkAccent(hex: string): AccentCheck | null {
  const accent = normalizeHex(hex);
  if (!accent) return null;
  const t = accentRamp(accent, 'light');
  return {
    accent,
    solid: t.solid,
    onAccent: t.on,
    ratio: Math.round(contrast(t.solid, t.on) * 100) / 100,
    adjusted: t.adjusted,
    passesAA: true,
  };
}
