/**
 * A message thread (spec §5.8, §6.6). Plain text only: bodies are rendered as
 * text nodes, never HTML. Attachments upload to the vault first.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessagesSquare, Paperclip, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { errorMessage, getJson, postJson } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import type { FileSummary, Message } from '@/lib/types';
import { fileUrl, uploadToVault } from '@/lib/upload';
import { Button, Notice, Textarea } from '@/ui/controls';
import { EmptyState } from '@/ui/display';
import { AttachmentChip, MessageBubble, MessageMeta } from '@/ui/lists';
import { vaultKey } from './Vault';

export function Thread({ clientId, thread = '', placeholder, compact }: { clientId: string; thread?: string; placeholder: string; compact?: boolean }) {
  const qc = useQueryClient();
  const key = ['messages', clientId, thread] as const;
  const messages = useQuery({
    queryKey: key,
    queryFn: () => getJson<{ messages: Message[]; lastReadAt: number }>(`/api/clients/${clientId}/messages${thread ? `?thread=${thread}` : ''}`),
    refetchInterval: 30_000,
  });
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<FileSummary[]>([]);
  const [uploading, setUploading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const end = useRef<HTMLDivElement>(null);

  const count = messages.data?.messages.length ?? 0;
  const lastReadAt = messages.data?.lastReadAt ?? 0;
  const newest = messages.data?.messages.at(-1)?.createdAt ?? 0;
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [count]);
  useEffect(() => {
    if (newest > lastReadAt) {
      void postJson(`/api/clients/${clientId}/messages/read`, { thread }).then(() => {
        void qc.invalidateQueries({ queryKey: ['overview', clientId] });
        void qc.invalidateQueries({ queryKey: ['today'] });
      });
    }
  }, [clientId, thread, newest, lastReadAt, qc]);

  const send = useMutation({
    mutationFn: () => postJson(`/api/clients/${clientId}/messages`, { body: text.trim(), thread, attachments: attachments.map((a) => a.id) }),
    onSuccess: async () => {
      setText('');
      setAttachments([]);
      await qc.invalidateQueries({ queryKey: key });
    },
  });

  const attach = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setUploading(file.name);
    try {
      const up = await uploadToVault(clientId, file, { folder: 'Messages' });
      setAttachments((a) => [...a, up]);
      void qc.invalidateQueries({ queryKey: vaultKey(clientId) });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUploading(null);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div className="card flex flex-col overflow-hidden">
      <div className={compact ? 'flex max-h-[360px] flex-col gap-4 overflow-y-auto p-4' : 'flex max-h-[60vh] min-h-[240px] flex-col gap-4 overflow-y-auto p-4'} aria-live="polite">
        {count === 0 ? (
          <EmptyState icon={MessagesSquare} title={messages.isPending ? 'Loading…' : 'No messages yet'}>
            Start the conversation below.
          </EmptyState>
        ) : (
          messages.data?.messages.map((m) => (
            <div key={m.id} className={m.mine ? 'flex flex-col items-end gap-1.5' : 'flex flex-col items-start gap-1.5'}>
              <MessageMeta author={m.mine ? 'You' : (m.author.name ?? 'Someone')} time={formatDateTime(m.createdAt)} consultant={m.author.kind === 'staff'} />
              <MessageBubble mine={m.mine}>
                <span className="whitespace-pre-wrap break-words">{m.body}</span>
              </MessageBubble>
              {m.attachments.map((a) => (
                <a key={a.id} href={fileUrl(a.id)} download className="no-underline">
                  <AttachmentChip name={a.filename} where="In documents" />
                </a>
              ))}
            </div>
          ))
        )}
        <div ref={end} />
      </div>
      <form
        className="flex flex-col gap-2 border-t border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) send.mutate();
        }}
      >
        {error || send.isError ? <Notice tone="danger">{error ?? errorMessage(send.error)}</Notice> : null}
        {attachments.length || uploading ? (
          <div className="flex flex-wrap gap-2">
            {attachments.map((a) => (
              <span key={a.id} className="tag inline-flex items-center gap-1">
                {a.filename}
                <button type="button" aria-label={`Remove ${a.filename}`} onClick={() => setAttachments((x) => x.filter((y) => y.id !== a.id))}>
                  <X aria-hidden className="size-3" />
                </button>
              </span>
            ))}
            {uploading ? <span className="tag">Uploading {uploading}…</span> : null}
          </div>
        ) : null}
        <div className="flex items-end gap-2">
          <input ref={input} type="file" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => void attach(e.target.files?.[0])} />
          <Button variant="ghost" icon aria-label="Attach a file" onClick={() => input.current?.click()} disabled={Boolean(uploading)}>
            <Paperclip aria-hidden className="i" />
          </Button>
          <Textarea
            aria-label={placeholder}
            placeholder={placeholder}
            rows={2}
            maxLength={10_000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) {
                e.preventDefault();
                send.mutate();
              }
            }}
            className="flex-1"
          />
          <Button type="submit" loading={send.isPending} disabled={!text.trim() || Boolean(uploading)}>
            Send
          </Button>
        </div>
      </form>
    </div>
  );
}
