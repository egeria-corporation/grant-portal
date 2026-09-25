/**
 * Lists, conversation and feedback (board 06): table, message bubbles and
 * composer, command palette, settings row with live preview.
 */
import { ArrowUpDown, Paperclip, Search, Send } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { Button, Kbd, Textarea } from './controls';
import { Avatar } from './display';
import { FileType } from './documents';

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

export interface Column<Row> {
  key: string;
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  sortable?: boolean;
  width?: number;
}

/** `.tbl` with sticky header, hover-revealed row actions, and density from the theme. */
export function Table<Row>({ columns, rows, rowKey, sortedBy, onSort, selected, caption }: {
  columns: Column<Row>[];
  rows: Row[];
  rowKey: (r: Row) => string;
  sortedBy?: string;
  onSort?: (key: string) => void;
  selected?: Set<string>;
  caption: string;
}) {
  return (
    <div className="card overflow-x-auto">
      <table className="tbl">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} style={c.width ? { width: c.width } : undefined} className={cx(sortedBy === c.key && 'sorted')} aria-sort={sortedBy === c.key ? 'ascending' : undefined}>
                {c.sortable && onSort ? (
                  <button type="button" className="inline-flex items-center" onClick={() => onSort(c.key)}>
                    {c.header}
                    <ArrowUpDown aria-hidden className="i" />
                  </button>
                ) : (
                  c.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)} className={cx('group hover:[&>td]:bg-hover', selected?.has(rowKey(r)) && 'is-sel')}>
              {columns.map((c) => (
                <td key={c.key}>{c.cell(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MessageBubble({ mine, children }: { mine?: boolean; children: ReactNode }) {
  return <div className={cx('bub', mine ? 'bub-me' : 'bub-them')}>{children}</div>;
}

export function MessageMeta({ author, time, consultant }: { author: string; time: string; consultant?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <Avatar name={author} size="sm" tone={consultant ? 'consultant' : 'client'} />
      <span className="t-sm font-medium">{author}</span>
      <span className="t-xs text-text3">{time}</span>
    </div>
  );
}

export function AttachmentChip({ name, where, icon: I }: { name: string; where: string; icon?: ComponentType<{ className?: string }> }) {
  return (
    <div className="attach self-end">
      <FileType name={name} />
      <div className="flex flex-col">
        <span className="font-medium">{name}</span>
        <span className="t-xs text-text2">{where}</span>
      </div>
      {I ? <I className="i size-4 text-text3" /> : null}
    </div>
  );
}

export function Composer({ placeholder, onSend, onAttach }: { placeholder: string; onSend: (text: string) => void; onAttach?: () => void }) {
  const [text, setText] = useState('');
  const send = () => {
    if (!text.trim()) return;
    onSend(text.trim());
    setText('');
  };
  return (
    <div className="composer focus-within:border-acc-focus focus-within:shadow-[0_0_0_3px_var(--acc-ring)]">
      {onAttach ? (
        <Button variant="ghost" icon aria-label="Attach a file" onClick={onAttach}>
          <Paperclip aria-hidden className="i" />
        </Button>
      ) : null}
      <Textarea
        aria-label={placeholder}
        placeholder={placeholder}
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        className="max-h-40 flex-1 border-0! shadow-none! focus:shadow-none!"
      />
      <Button icon aria-label="Send" onClick={send} disabled={!text.trim()}>
        <Send aria-hidden className="i" />
      </Button>
    </div>
  );
}

export interface PaletteItem {
  id: string;
  group: string;
  label: string;
  detail?: string;
  icon: ComponentType<{ className?: string }>;
  keys?: string[];
  run: () => void;
}

/** Jump to any client, run any action (board 06 §22). Keyboard-first. */
export function CommandPalette({ items, onClose }: { items: PaletteItem[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? items.filter((i) => i.label.toLowerCase().includes(needle)) : items;
  }, [items, q]);
  const groups = [...new Set(filtered.map((i) => i.group))];
  const highlight = (label: string) => {
    const i = q ? label.toLowerCase().indexOf(q.trim().toLowerCase()) : -1;
    if (i < 0) return label;
    const n = q.trim().length;
    return (
      <>
        {label.slice(0, i)}
        <mark className="rounded-xs bg-acc-200 text-inherit">{label.slice(i, i + n)}</mark>
        {label.slice(i + n)}
      </>
    );
  };
  return (
    <div className="pop w-full max-w-[640px] overflow-hidden" role="dialog" aria-label="Command palette">
      <div className="flex h-[52px] items-center gap-2.5 border-b border-border px-4">
        <Search aria-hidden className="i size-4 text-text3" />
        <input
          autoFocus
          className="t-lg flex-1 bg-transparent outline-none"
          placeholder="Search clients and actions"
          aria-label="Search clients and actions"
          role="combobox"
          aria-expanded
          aria-controls="palette-list"
          aria-activedescendant={filtered[active]?.id}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, filtered.length - 1));
            else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
            else if (e.key === 'Enter') filtered[active]?.run();
            else if (e.key === 'Escape') onClose();
            else return;
            e.preventDefault();
          }}
        />
        <Kbd>esc</Kbd>
      </div>
      <div className="menu px-1.5 pb-2 pt-1" id="palette-list" role="listbox">
        {groups.map((g) => (
          <div key={g} role="group" aria-label={g}>
            <div className="lab px-3 pb-1 pt-2.5">{g}</div>
            {filtered
              .filter((i) => i.group === g)
              .map((i) => {
                const I = i.icon;
                const on = filtered[active]?.id === i.id;
                return (
                  <div key={i.id} id={i.id} role="option" aria-selected={on} className={cx('menu-item h-[38px]', on && 'on')} onMouseEnter={() => setActive(filtered.indexOf(i))} onClick={i.run}>
                    <I className="i size-4" />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium">{highlight(i.label)}</span>
                      {i.detail ? <span className="t-sm text-text2"> · {i.detail}</span> : null}
                    </span>
                    {on ? <Kbd>↵</Kbd> : i.keys?.map((k) => <Kbd key={k}>{k}</Kbd>)}
                  </div>
                );
              })}
          </div>
        ))}
        {filtered.length === 0 ? <p className="t-sm px-3 py-4 text-text2">No matches.</p> : null}
      </div>
      <div className="flex h-[38px] items-center gap-4 border-t border-border bg-sunken px-3.5">
        <span className="t-xs flex items-center gap-1.5 text-text2">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> navigate
        </span>
        <span className="t-xs flex items-center gap-1.5 text-text2">
          <Kbd>↵</Kbd> open
        </span>
        <span className="t-xs flex items-center gap-1.5 text-text2">
          <Kbd>esc</Kbd> close
        </span>
      </div>
    </div>
  );
}

/** Label and help on the left, control in the middle, what it produces on the right (board 06 §23). */
export function SettingsRow({ title, help, control, note, preview }: { title: string; help: ReactNode; control: ReactNode; note?: ReactNode; preview?: ReactNode }) {
  return (
    <div className="card grid items-center gap-7 px-6 py-5 lg:grid-cols-[240px_minmax(0,1fr)_300px]">
      <div className="flex flex-col gap-1">
        <span className="t-h4">{title}</span>
        <span className="t-sm text-text2">{help}</span>
      </div>
      <div className="flex flex-col gap-2">
        {control}
        {note ? <span className="t-xs text-text3">{note}</span> : null}
      </div>
      {preview ? <div className="card-s flex flex-col gap-1.5 p-3.5">{preview}</div> : <span />}
    </div>
  );
}
