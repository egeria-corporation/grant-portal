/**
 * A client's document vault (spec §5.6, §6.3), for staff and client users.
 * Staff can file documents into folders, tag them, set an expiry, and keep a
 * file internal; everyone can search, download and preview.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Eye, EyeOff, FolderOpen, Pencil, Search, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { deleteJson, errorMessage, getJson, patchJson } from '@/lib/api';
import { formatBytes, formatDate, fromDateInput, timeAgo, toDateInput } from '@/lib/format';
import type { ClientAccess, FileSummary, VaultResponse } from '@/lib/types';
import { canPreview, fileUrl } from '@/lib/upload';
import { Button, Checkbox, Field, Input, Notice, Select } from '@/ui/controls';
import { EmptyState, Pill } from '@/ui/display';
import { DropZone, FileType } from '@/ui/documents';
import { useUploader } from './useUploader';

const DAY = 86_400_000;

export function vaultKey(clientId: string) {
  return ['vault', clientId] as const;
}

export function useVault(clientId: string) {
  return useQuery({ queryKey: vaultKey(clientId), queryFn: () => getJson<VaultResponse>(`/api/clients/${clientId}/files`) });
}

function ExpiryPill({ at, now }: { at: number | null; now: number }) {
  if (!at) return null;
  const left = at - now;
  if (left < 0) return <Pill tone="danger">Expired {formatDate(at)}</Pill>;
  if (left < 30 * DAY) return <Pill tone="warn">Expires {formatDate(at)}</Pill>;
  return <Pill>Expires {formatDate(at)}</Pill>;
}

function ScanPill({ status }: { status: FileSummary['scanStatus'] }) {
  if (status === 'pending') return <Pill tone="info">Checking…</Pill>;
  if (status === 'infected' || status === 'error') return <Pill tone="danger">Blocked</Pill>;
  return null;
}

function EditFile({ clientId, file, folders, onDone }: { clientId: string; file: FileSummary; folders: string[]; onDone: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(file.filename);
  const [folder, setFolder] = useState(file.folder ?? '');
  const [tags, setTags] = useState(file.tags.join(', '));
  const [expires, setExpires] = useState(toDateInput(file.expiresAt));
  const [shared, setShared] = useState(file.shared);
  const save = useMutation({
    mutationFn: () =>
      patchJson(`/api/clients/${clientId}/files/${file.id}`, {
        filename: name,
        folder: folder || null,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        expiresAt: fromDateInput(expires),
        shared,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: vaultKey(clientId) });
      onDone();
    },
  });
  return (
    <form
      className="grid gap-3 border-t border-border bg-sunken p-4 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field label="Name">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <Field label="Folder">
        {(p) => (
          <Input {...p} list={`folders-${file.id}`} value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="No folder" />
        )}
      </Field>
      <datalist id={`folders-${file.id}`}>
        {folders.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
      <Field label="Tags" hint="Separate with commas">
        {(p) => <Input {...p} value={tags} onChange={(e) => setTags(e.target.value)} />}
      </Field>
      <Field label="Expires" hint="For documents that go stale, like an audit">
        {(p) => <Input {...p} type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />}
      </Field>
      <div className="sm:col-span-2">
        <Checkbox checked={shared} onChange={setShared} label="Visible to the client" />
      </div>
      {save.isError ? (
        <div className="sm:col-span-2">
          <Notice tone="danger">{errorMessage(save.error)}</Notice>
        </div>
      ) : null}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" size="sm" loading={save.isPending}>
          Save
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function FileRow({ file, actions }: { file: FileSummary; actions?: React.ReactNode }) {
  // Read the clock once per mount (render must stay pure).
  const [now] = useState(() => Date.now());
  const blocked = file.scanStatus !== 'none' && file.scanStatus !== 'clean';
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <FileType name={file.filename} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          {blocked ? (
            <span className="truncate font-medium">{file.filename}</span>
          ) : (
            <a href={fileUrl(file.id)} className="truncate font-medium text-text hover:text-acc-text hover:underline" download>
              {file.filename}
            </a>
          )}
          <ScanPill status={file.scanStatus} />
          <ExpiryPill at={file.expiresAt} now={now} />
          {!file.shared ? (
            <Pill icon={EyeOff}>Internal</Pill>
          ) : null}
        </span>
        <span className="t-xs text-text2">
          {formatBytes(file.size)} · {file.uploadedBy.name ?? 'Unknown'} · {timeAgo(file.createdAt)}
          {file.folder ? ` · ${file.folder}` : ''}
          {file.tags.length ? ` · ${file.tags.join(', ')}` : ''}
        </span>
      </div>
      {!blocked && canPreview(file.mime) ? (
        <a href={fileUrl(file.id, true)} target="_blank" rel="noopener" className="btn btn-ghost btn-sm btn-icon" aria-label={`Preview ${file.filename}`}>
          <Eye aria-hidden className="i" />
        </a>
      ) : null}
      {!blocked ? (
        <a href={fileUrl(file.id)} download className="btn btn-ghost btn-sm btn-icon" aria-label={`Download ${file.filename}`}>
          <Download aria-hidden className="i" />
        </a>
      ) : null}
      {actions}
    </div>
  );
}

export function Vault({ clientId, access, meId }: { clientId: string; access: ClientAccess; meId: string }) {
  const qc = useQueryClient();
  const vault = useVault(clientId);
  const [q, setQ] = useState('');
  const [folder, setFolder] = useState('');
  const [uploadFolder, setUploadFolder] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const staff = access === 'staff';
  const uploader = useUploader(clientId, {
    visibleTo: staff ? 'the client and your team' : 'you and your consultant',
    onUploaded: () => qc.invalidateQueries({ queryKey: vaultKey(clientId) }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteJson(`/api/clients/${clientId}/files/${id}`),
    onSettled: () => qc.invalidateQueries({ queryKey: vaultKey(clientId) }),
  });

  const files = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (vault.data?.files ?? []).filter(
      (f) =>
        (!folder || f.folder === folder) &&
        (!needle || f.filename.toLowerCase().includes(needle) || f.tags.some((t) => t.toLowerCase().includes(needle)) || (f.folder ?? '').toLowerCase().includes(needle)),
    );
  }, [vault.data, q, folder]);

  const accept = vault.data?.policy.extensions.map((e) => `.${e}`).join(',');
  const canDelete = (f: FileSummary) => staff || (f.uploadedBy.id === meId && now - f.createdAt < DAY);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        {staff ? (
          <div className="flex items-center gap-2">
            <label htmlFor="upload-folder" className="t-sm text-text2">
              Upload to
            </label>
            <Select id="upload-folder" value={uploadFolder} onChange={(e) => setUploadFolder(e.target.value)} className="w-auto">
              <option value="">No folder</option>
              {vault.data?.folders.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <DropZone
          state={uploader.state.kind === 'received' ? { kind: 'idle' } : uploader.state}
          accept={accept}
          hint={vault.data ? `PDF, Word, Excel, images and more · up to ${formatBytes(vault.data.policy.maxBytes)}` : undefined}
          onFiles={(fs) => void uploader.upload(fs, { folder: uploadFolder || null })}
        />
        {uploader.state.kind === 'received' ? (
          <p role="status" className="t-sm text-ok-text">
            Received {uploader.state.name}.
          </p>
        ) : null}
      </div>

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <div className="relative min-w-[200px] flex-1">
            <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text3" />
            <Input aria-label="Search documents" placeholder="Search documents" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
          </div>
          <Select aria-label="Folder" value={folder} onChange={(e) => setFolder(e.target.value)} className="w-auto">
            <option value="">All folders</option>
            {vault.data?.folders.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </Select>
        </div>
        {remove.isError ? (
          <div className="p-3">
            <Notice tone="danger">{errorMessage(remove.error)}</Notice>
          </div>
        ) : null}
        {files.length ? (
          <ul className="divide-y divide-border">
            {files.map((f) => (
              <li key={f.id}>
                <FileRow
                  file={f}
                  actions={
                    <>
                      {staff ? (
                        <Button variant="ghost" size="sm" icon aria-label={`Edit ${f.filename}`} onClick={() => setEditing(editing === f.id ? null : f.id)}>
                          <Pencil aria-hidden className="i" />
                        </Button>
                      ) : null}
                      {canDelete(f) ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          icon
                          aria-label={`Delete ${f.filename}`}
                          loading={remove.isPending && remove.variables === f.id}
                          onClick={() => {
                            if (window.confirm(`Delete ${f.filename}? This can’t be undone.`)) remove.mutate(f.id);
                          }}
                        >
                          <Trash2 aria-hidden className="i" />
                        </Button>
                      ) : null}
                    </>
                  }
                />
                {editing === f.id && vault.data ? <EditFile clientId={clientId} file={f} folders={vault.data.folders} onDone={() => setEditing(null)} /> : null}
              </li>
            ))}
          </ul>
        ) : (
          <div className="p-4">
            <EmptyState icon={FolderOpen} title={vault.isPending ? 'Loading…' : q || folder ? 'Nothing matches' : 'No documents yet'}>
              {q || folder ? 'Try another search or folder.' : 'Files you upload appear here.'}
            </EmptyState>
          </div>
        )}
      </div>
    </div>
  );
}
