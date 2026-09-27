/**
 * Malware-scanner hook (spec §7.4). v1 ships no scanner. A deployment can add
 * one by binding a Worker service named `SCANNER` in wrangler.jsonc (see
 * docs/security.md "Scanning uploads"). When it is bound, new uploads start as
 * `pending` and stay quarantined (no downloads) until the scan returns clean.
 *
 * Contract: POST the object bytes to `https://scanner/scan` with headers
 * `X-File-Id`, `X-File-Name` and `Content-Type`; the service answers
 * `{ "status": "clean" | "infected" }`. Anything else counts as an error, and
 * the file stays quarantined.
 */
import type { AppEnv } from '../env';

export type ScanResult = 'clean' | 'infected' | 'error';

export function scannerConfigured(env: AppEnv): boolean {
  return typeof env.SCANNER?.fetch === 'function';
}

export async function scanObject(env: AppEnv, file: { id: string; filename: string; mime: string }, body: ReadableStream): Promise<ScanResult> {
  if (!env.SCANNER) return 'error';
  try {
    const res = await env.SCANNER.fetch('https://scanner/scan', {
      method: 'POST',
      headers: { 'Content-Type': file.mime, 'X-File-Id': file.id, 'X-File-Name': encodeURIComponent(file.filename) },
      body,
    });
    if (!res.ok) return 'error';
    const data = (await res.json().catch(() => null)) as { status?: unknown } | null;
    return data?.status === 'clean' || data?.status === 'infected' ? data.status : 'error';
  } catch (err) {
    console.error('[scanner] scan failed', file.id, err);
    return 'error';
  }
}

/** Downloads are allowed only for files with no scanner, or a clean scan. */
export function downloadable(scanStatus: string): boolean {
  return scanStatus === 'none' || scanStatus === 'clean';
}
