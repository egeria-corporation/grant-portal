/**
 * Uploads a file to a client's vault through the Worker (spec §6.3). Small
 * files go in one request; larger ones in 8 MiB parts. A dropped connection
 * doesn't restart the upload: the client asks the server which parts it
 * already has and sends only the rest.
 */
import { ApiError, deleteJson, getJson, postJson } from './api';
import type { FileSummary } from './types';

interface Begun {
  id: string;
  multipart: boolean;
  partSize: number;
  parts: number;
  filename: string;
}

export interface UploadOptions {
  folder?: string | null;
  tags?: string[];
  shared?: boolean;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

function csrfToken(): string {
  const match = /(?:^|;\s*)__Host-csrf=([^;]+)/.exec(document.cookie);
  return match?.[1] ? decodeURIComponent(match[1]) : '';
}

/** PUT with upload progress (fetch has no upload progress events). */
function put(url: string, body: Blob, onProgress: (loaded: number) => void, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-CSRF-Token', csrfToken());
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(xhr.responseText) as Record<string, unknown>;
      } catch {
        /* keep empty */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, typeof data.error === 'string' ? data.error : 'request_failed', data));
    };
    xhr.onerror = () => reject(new TypeError('network'));
    xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

const retryable = (err: unknown) => err instanceof TypeError || (err instanceof ApiError && err.status >= 500);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function uploadToVault(clientId: string, file: File, opts: UploadOptions = {}): Promise<FileSummary> {
  const base = `/api/clients/${clientId}/uploads`;
  const begun = await postJson<Begun>(base, { filename: file.name, size: file.size, folder: opts.folder ?? null, tags: opts.tags, shared: opts.shared });
  const report = (loaded: number) => opts.onProgress?.(Math.min(1, loaded / file.size));
  try {
    if (!begun.multipart) {
      const res = (await put(`${base}/${begun.id}`, file, report, opts.signal)) as { file: FileSummary };
      return res.file;
    }

    for (let attempt = 0; ; attempt++) {
      try {
        const status = await getJson<{ parts: number[] }>(`${base}/${begun.id}`);
        const have = new Set(status.parts);
        let done = [...have].reduce((sum, n) => sum + Math.min(begun.partSize, file.size - (n - 1) * begun.partSize), 0);
        for (let n = 1; n <= begun.parts; n++) {
          if (have.has(n)) continue;
          const chunk = file.slice((n - 1) * begun.partSize, n * begun.partSize);
          await put(`${base}/${begun.id}/parts/${n}`, chunk, (loaded) => report(done + loaded), opts.signal);
          done += chunk.size;
          report(done);
        }
        const res = await postJson<{ file: FileSummary }>(`${base}/${begun.id}/complete`);
        return res.file;
      } catch (err) {
        if (attempt >= 4 || !retryable(err) || opts.signal?.aborted) throw err;
        await wait(1000 * 2 ** attempt);
      }
    }
  } catch (err) {
    // Give the reservation back unless it's worth resuming later.
    if (!retryable(err)) await deleteJson(`${base}/${begun.id}`).catch(() => undefined);
    throw err;
  }
}

/** Link to download (or preview) a file; always through the Worker's authorised route. */
export function fileUrl(fileId: string, inline = false): string {
  return `/f/${fileId}${inline ? '?inline=1' : ''}`;
}

export function canPreview(mime: string): boolean {
  return mime === 'application/pdf' || /^image\/(png|jpeg|gif|webp)$/.test(mime);
}
