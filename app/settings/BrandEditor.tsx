/**
 * Brand editor (spec §8.1), shared by the wizard's Brand step and
 * Settings → Brand. Everything previews live in light and dark before saving;
 * the server regenerates theme.css under a new version on save.
 */
import { checkAccent } from '@shared/theme/contrast';
import type { Mode } from '@shared/theme/ramp';
import { type Density, HEADING_LABELS, HEADINGS, type Heading, type Neutral, type Radius, type ThemeInput } from '@shared/theme/tokens';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ImageUp, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { deleteJson, errorMessage, getJson, putFile, putJson } from '@/lib/api';
import { applyThemeVars } from '@/lib/session';
import { FirmMark } from '@/ui/brand';
import { Button, Field, Input, Notice, Segmented, Select, Toggle } from '@/ui/controls';

type Slot = 'logo-light' | 'logo-dark' | 'mark' | 'favicon' | 'og' | 'font-heading';

interface BrandResponse {
  brand: (ThemeInput & { firmName: string; shortName?: string; welcome?: string; poweredBy: boolean }) | null;
  assets: Record<Slot, { url: string; mime: string; size: number } | null>;
  slots: Record<Slot, { label: string; maxBytes: number; kinds: string[] }>;
}

const ACCEPT: Record<Slot, string> = {
  'logo-light': 'image/svg+xml,image/png,image/webp,image/jpeg',
  'logo-dark': 'image/svg+xml,image/png,image/webp,image/jpeg',
  mark: 'image/svg+xml,image/png,image/webp',
  favicon: 'image/svg+xml,image/png,image/x-icon',
  og: 'image/png,image/jpeg',
  'font-heading': 'font/woff2,.woff2',
};

function Preview({ theme, mode, firmName, welcome, logo }: { theme: ThemeInput; mode: Mode; firmName: string; welcome: string; logo: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) applyThemeVars(ref.current, theme, mode);
  }, [theme, mode]);
  return (
    <div ref={ref} className="rounded-card border border-border bg-bg p-4 text-text" style={{ colorScheme: mode }} aria-label={`${mode} preview`}>
      <p className="lab mb-2">{mode === 'light' ? 'Light' : 'Dark'}</p>
      <div className="card mx-auto max-w-[260px] p-4 shadow-panel">
        <div className="mb-3 flex items-center gap-2">
          {logo ? <img src={logo} alt="" className="h-7 w-auto" /> : <FirmMark name={firmName} size={28} />}
          {logo ? null : <span className="hd text-[14px]">{firmName || 'Your firm'}</span>}
        </div>
        <p className="t-sm text-text2">{welcome || "Enter your email and we'll send you a sign-in link."}</p>
        <div className="input mt-3 text-text3">you@organization.org</div>
        <div className="btn btn-primary btn-block mt-2.5">Email me a sign-in link</div>
        <p className="t-xs mt-2.5">
          <a href="#preview" onClick={(e) => e.preventDefault()}>
            Need help?
          </a>
        </p>
      </div>
    </div>
  );
}

function AssetSlot({ slot, label, hint, current, onChanged }: { slot: Slot; label: string; hint: string; current: { url: string; mime: string } | null; onChanged: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const upload = useMutation({ mutationFn: (f: File) => putFile(`/api/settings/brand/assets/${slot}`, f), onSuccess: onChanged });
  const remove = useMutation({ mutationFn: () => deleteJson(`/api/settings/brand/assets/${slot}`), onSuccess: onChanged });
  const isImage = current?.mime.startsWith('image/');
  return (
    <div className="flex items-center gap-3 border-t border-border py-3 first:border-t-0">
      <div className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-md bg-sunken shadow-[inset_0_0_0_1px_var(--border)]">
        {current && isImage ? <img src={current.url} alt="" className="max-h-10 max-w-10" /> : <ImageUp aria-hidden className="i size-4 text-text3" />}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="t-sm font-medium">{label}</span>
        <span className="t-xs text-text2">{upload.isError ? <span className="text-danger-text">{errorMessage(upload.error)}</span> : current ? 'Uploaded' : hint}</span>
      </div>
      <input
        ref={input}
        type="file"
        accept={ACCEPT[slot]}
        className="sr-only"
        tabIndex={-1}
        aria-label={`Upload ${label}`}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) upload.mutate(f);
          e.target.value = '';
        }}
      />
      <Button variant="secondary" size="sm" loading={upload.isPending} onClick={() => input.current?.click()}>
        {current ? 'Replace' : 'Upload'}
      </Button>
      {current ? (
        <Button variant="ghost" size="sm" icon aria-label={`Remove ${label}`} loading={remove.isPending} onClick={() => remove.mutate()}>
          <Trash2 aria-hidden className="i" />
        </Button>
      ) : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="t-h4 mb-1">{title}</legend>
      {children}
    </fieldset>
  );
}

export function BrandEditor({ onSaved, submitLabel = 'Save brand', compact = false }: { onSaved?: () => void; submitLabel?: string; compact?: boolean }) {
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['settings', 'brand'], queryFn: () => getJson<BrandResponse>('/api/settings/brand') });
  const [form, setForm] = useState({
    firmName: '',
    shortName: '',
    welcome: '',
    accent: '#5b4fd6',
    neutral: 'neutral' as Neutral,
    radius: 'soft' as Radius,
    density: 'comfortable' as Density,
    heading: 'sans' as Heading,
    poweredBy: false,
  });
  const [loaded, setLoaded] = useState(false);
  if (data.data && !loaded) {
    setLoaded(true);
    const b = data.data.brand;
    if (b) setForm({ firmName: b.firmName, shortName: b.shortName ?? '', welcome: b.welcome ?? '', accent: b.accent, neutral: b.neutral, radius: b.radius, density: b.density, heading: b.heading, poweredBy: b.poweredBy });
  }
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['settings'] });
    await qc.invalidateQueries({ queryKey: ['config'] });
  };

  const check = checkAccent(form.accent);
  const hasFont = Boolean(data.data?.assets['font-heading']);
  const theme: ThemeInput = {
    accent: check?.accent ?? '#5b4fd6',
    neutral: form.neutral,
    radius: form.radius,
    density: form.density,
    heading: form.heading === 'custom' && !hasFont ? 'sans' : form.heading,
  };

  const save = useMutation({
    mutationFn: () =>
      putJson('/api/settings/brand', {
        firmName: form.firmName,
        shortName: form.shortName || undefined,
        welcome: form.welcome || undefined,
        accent: check?.accent ?? form.accent,
        neutral: form.neutral,
        radius: form.radius,
        density: form.density,
        heading: form.heading,
        poweredBy: form.poweredBy,
      }),
    onSuccess: async () => {
      await refresh();
      onSaved?.();
    },
  });

  const assets = data.data?.assets;
  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Section title="Name">
        <Field label="Firm name">{(p) => <Input {...p} required maxLength={80} value={form.firmName} onChange={(e) => set('firmName', e.target.value)} />}</Field>
        {compact ? null : (
          <Field label="Short name" hint="For tight spaces, like the phone home screen.">
            {(p) => <Input {...p} maxLength={24} value={form.shortName} onChange={(e) => set('shortName', e.target.value)} />}
          </Field>
        )}
        <Field label="Welcome line for clients" hint="Shown on the sign-in screen and in link previews.">
          {(p) => <Input {...p} maxLength={280} value={form.welcome} onChange={(e) => set('welcome', e.target.value)} placeholder="Welcome! Sign in to see what’s next." />}
        </Field>
      </Section>

      <Section title="Color and shape">
        <Field
          label="Accent color"
          hint={
            check
              ? check.adjusted
                ? `Buttons use a slightly adjusted shade (${check.solid}) so text on them stays readable (${check.ratio}:1, WCAG AA).`
                : `Readable as is: ${check.ratio}:1 with ${check.onAccent === '#ffffff' ? 'white' : 'dark'} text (WCAG AA).`
              : 'Enter a hex color like #1e3a5f.'
          }
        >
          {(p) => (
            <div className="flex gap-2">
              <input
                type="color"
                aria-label="Pick accent color"
                value={check?.accent ?? '#000000'}
                onChange={(e) => set('accent', e.target.value)}
                className="h-[34px] w-12 cursor-pointer rounded-sm border border-binput bg-raised p-1"
              />
              <Input {...p} value={form.accent} onChange={(e) => set('accent', e.target.value.trim())} className="font-code" invalid={!check} />
            </div>
          )}
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="field">
            <span className="label">Gray tone</span>
            <Segmented<Neutral> label="Gray tone" value={form.neutral} onChange={(v) => set('neutral', v)} options={[{ value: 'cool', label: 'Cool' }, { value: 'neutral', label: 'Neutral' }, { value: 'warm', label: 'Warm' }]} />
          </div>
          <div className="field">
            <span className="label">Corners</span>
            <Segmented<Radius> label="Corners" value={form.radius} onChange={(v) => set('radius', v)} options={[{ value: 'sharp', label: 'Sharp' }, { value: 'soft', label: 'Soft' }, { value: 'round', label: 'Round' }]} />
          </div>
          <div className="field">
            <span className="label">Density</span>
            <Segmented<Density> label="Density" value={form.density} onChange={(v) => set('density', v)} options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} />
          </div>
          <Field label="Heading font">
            {(p) => (
              <Select {...p} value={form.heading} onChange={(e) => set('heading', e.target.value as Heading)}>
                {HEADINGS.filter((h) => h !== 'custom' || hasFont).map((h) => (
                  <option key={h} value={h}>
                    {HEADING_LABELS[h]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </Section>

      <div className="grid gap-3 sm:grid-cols-2">
        <Preview theme={theme} mode="light" firmName={form.firmName} welcome={form.welcome} logo={assets?.['logo-light']?.url ?? null} />
        <Preview theme={theme} mode="dark" firmName={form.firmName} welcome={form.welcome} logo={(assets?.['logo-dark'] ?? assets?.['logo-light'])?.url ?? null} />
      </div>

      <Section title="Logos and files">
        <div className="card px-4 py-1">
          <AssetSlot slot="logo-light" label="Logo" hint="SVG or PNG, up to 1 MB. Used on light backgrounds." current={assets?.['logo-light'] ?? null} onChanged={refresh} />
          <AssetSlot slot="logo-dark" label="Logo for dark mode" hint="Optional. Falls back to the main logo." current={assets?.['logo-dark'] ?? null} onChanged={refresh} />
          <AssetSlot slot="mark" label="Mark / icon" hint="Square. Used for the favicon when there's no favicon." current={assets?.mark ?? null} onChanged={refresh} />
          {compact ? null : (
            <>
              <AssetSlot slot="favicon" label="Favicon" hint="Optional. Otherwise made from the mark or your initials." current={assets?.favicon ?? null} onChanged={refresh} />
              <AssetSlot slot="og" label="Link preview image" hint="1200×630 PNG or JPEG. Otherwise a card in your accent color." current={assets?.og ?? null} onChanged={refresh} />
              <AssetSlot slot="font-heading" label="Heading font" hint="WOFF2 you're licensed to use on the web." current={assets?.['font-heading'] ?? null} onChanged={refresh} />
            </>
          )}
        </div>
        <p className="t-xs text-text3">SVGs are cleaned before they're stored: scripts, links and external references are removed.</p>
      </Section>

      {compact ? null : (
        <label className="flex items-center justify-between gap-4">
          <span className="flex flex-col">
            <span className="t-sm font-medium">Show a “Powered by open-source software” line</span>
            <span className="t-xs text-text2">Off by default. Your clients never see this unless you turn it on.</span>
          </span>
          <Toggle label="Powered by line" checked={form.poweredBy} onChange={(v) => set('poweredBy', v)} />
        </label>
      )}

      {save.isError ? <Notice tone="danger">{errorMessage(save.error)}</Notice> : null}
      {save.isSuccess && !onSaved ? <Notice tone="ok">Saved. Your portal now uses this brand.</Notice> : null}
      <div className="flex justify-end border-t border-border pt-4">
        <Button type="submit" loading={save.isPending} disabled={!form.firmName.trim() || !check}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
