/** Drives a DropZone: uploads files one after another and reports each state. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import type { FileSummary } from '@/lib/types';
import { uploadToVault, type UploadOptions } from '@/lib/upload';
import type { DropState } from '@/ui/documents';

export function useUploader(clientId: string, opts: { visibleTo: string; onUploaded?: (file: FileSummary) => void | Promise<void> }) {
  const [state, setState] = useState<DropState>({ kind: 'idle' });
  const abort = useRef<AbortController | null>(null);
  type Options = Omit<UploadOptions, 'onProgress' | 'signal'>;
  const retry = useRef<(files: File[], options: Options) => void>(() => undefined);

  const run = useCallback(
    async (files: File[], options: Options = {}) => {
      for (const [i, file] of files.entries()) {
        const ctrl = new AbortController();
        abort.current = ctrl;
        const detail = files.length > 1 ? `File ${i + 1} of ${files.length}` : undefined;
        setState({ kind: 'uploading', name: file.name, progress: 0, detail, onCancel: () => ctrl.abort() });
        try {
          const uploaded = await uploadToVault(clientId, file, {
            ...options,
            signal: ctrl.signal,
            onProgress: (p) => setState({ kind: 'uploading', name: file.name, progress: p, detail, onCancel: () => ctrl.abort() }),
          });
          if (uploaded.scanStatus === 'pending') setState({ kind: 'scanning', name: file.name });
          await opts.onUploaded?.(uploaded);
          setState({ kind: 'received', name: file.name, when: timeAgo(Date.now()), visibleTo: opts.visibleTo });
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            setState({ kind: 'idle' });
            return;
          }
          const remaining = files.slice(i);
          setState({ kind: 'error', message: `${file.name}: ${errorMessage(err)}`, onRetry: () => retry.current(remaining, options) });
          return;
        }
      }
    },
    [clientId, opts],
  );

  useEffect(() => {
    retry.current = (files, options) => void run(files, options);
  }, [run]);

  return { state, upload: run, reset: () => setState({ kind: 'idle' }) };
}
