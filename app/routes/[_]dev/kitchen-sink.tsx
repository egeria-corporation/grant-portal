/**
 * Kitchen sink (dev and E2E only): every component from docs/design/boards,
 * in one of the three sample brands, light and dark side by side. Each panel
 * sets its own theme variables, so this page shows exactly what a brand's
 * theme.css would. Used by tests/e2e/kitchen-sink.spec.ts for contrast checks.
 */
import type { Mode } from '@shared/theme/ramp';
import { SAMPLE_BRANDS } from '@shared/theme/tokens';
import { createFileRoute } from '@tanstack/react-router';
import { Building2, CalendarClock, CircleCheck, FileText, Inbox, KanbanSquare, Plus, Search, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { applyThemeVars, useConfig } from '@/lib/session';
import { Button, Checkbox, Field, Input, Notice, OtpInput, Radio, Segmented, Select, Textarea, Toggle } from '@/ui/controls';
import { Avatar, AvatarStack, DeadlineChip, EmptyState, FitScore, OrgMark, Pill, PipelineMini, ProgressBar, SegBar, Skeleton, Tag, Toast } from '@/ui/display';
import { ApprovalBar, ChecklistItem, DropZone, KanbanCard, OpportunityCard, VersionList } from '@/ui/documents';
import { AttachmentChip, CommandPalette, Composer, MessageBubble, MessageMeta, SettingsRow, Table } from '@/ui/lists';

type BrandKey = keyof typeof SAMPLE_BRANDS;

export const Route = createFileRoute('/_dev/kitchen-sink')({
  validateSearch: (s: Record<string, unknown>): { brand: BrandKey } => ({
    brand: (['northwind', 'bloom', 'evergreen'] as const).includes(s.brand as BrandKey) ? (s.brand as BrandKey) : 'northwind',
  }),
  component: KitchenSink,
});

/** A fixed "now" so countdowns render the same on every run. */
const NOW = new Date('2026-09-24T12:00:00Z').getTime();
const D = 86_400_000;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="hd t-h3">{title}</h2>
      {children}
    </section>
  );
}

function Panel({ brand, mode }: { brand: BrandKey; mode: Mode }) {
  const ref = useRef<HTMLDivElement>(null);
  const sample = SAMPLE_BRANDS[brand];
  useEffect(() => {
    if (ref.current) applyThemeVars(ref.current, sample.theme, mode);
  }, [sample, mode]);
  const [otp, setOtp] = useState('482');
  const [seg, setSeg] = useState<'warm' | 'neutral' | 'direct'>('warm');
  const [on, setOn] = useState(true);
  const [radio, setRadio] = useState('a');

  return (
    <div
      ref={ref}
      data-testid={`panel-${mode}`}
      className={`flex min-w-0 flex-col gap-8 bg-bg p-6 text-text ${sample.theme.density === 'compact' ? 'd-compact' : ''}`}
      style={{ colorScheme: mode }}
    >
      <header className="flex items-center justify-between">
        <span className="hd t-h2">{sample.name}</span>
        <Pill tone="neutral">{mode}</Pill>
      </header>

      <Section title="Buttons">
        <div className="flex flex-wrap items-center gap-2">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="quiet">Quiet</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Delete</Button>
          <Button variant="link">Link</Button>
          <Button size="sm">Small</Button>
          <Button size="lg">
            <Upload aria-hidden className="i" />
            Large
          </Button>
          <Button icon aria-label="Add">
            <Plus aria-hidden className="i" />
          </Button>
          <Button loading>Saving</Button>
          <Button disabled>Disabled</Button>
        </div>
      </Section>

      <Section title="Inputs and select">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Organization">{(p) => <Input {...p} placeholder="Riverside Food Bank" />}</Field>
          <Field label="EIN" error="That doesn't look like an EIN (12-3456789).">{(p) => <Input {...p} defaultValue="12-34" invalid />}</Field>
          <Field label="Status" hint="Clients see this on their home screen.">
            {(p) => (
              <Select {...p} defaultValue="active">
                <option value="onboarding">Onboarding</option>
                <option value="active">Active</option>
              </Select>
            )}
          </Field>
          <Field label="Disabled">{(p) => <Input {...p} disabled value="Read only" readOnly />}</Field>
        </div>
        <Field label="Note">{(p) => <Textarea {...p} rows={2} placeholder="Anything we should know?" />}</Field>
        <div className="flex flex-wrap items-center gap-5">
          <Checkbox checked={on} onChange={setOn} label="Email me updates" />
          <Radio name={`r-${mode}`} value="a" checked={radio === 'a'} onChange={() => setRadio('a')} label="Instant" />
          <Radio name={`r-${mode}`} value="b" checked={radio === 'b'} onChange={() => setRadio('b')} label="Daily digest" />
          <Toggle label="Reminders" checked={on} onChange={setOn} />
          <Segmented label="Tone" value={seg} onChange={setSeg} options={[{ value: 'warm', label: 'Warm' }, { value: 'neutral', label: 'Neutral' }, { value: 'direct', label: 'Direct' }]} />
        </div>
      </Section>

      <Section title="Sign-in code">
        <OtpInput value={otp} onChange={setOtp} label={`Sign-in code (${mode})`} />
      </Section>

      <Section title="Status, dates and deadlines">
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone="neutral">Draft</Pill>
          <Pill tone="ok" icon={CircleCheck}>Active</Pill>
          <Pill tone="warn">Awaiting client</Pill>
          <Pill tone="danger">Overdue</Pill>
          <Pill tone="info">Scheduled</Pill>
          <Pill tone="acc">Recommended</Pill>
          <Tag>Federal</Tag>
          <Tag recommended>Recommended</Tag>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DeadlineChip now={NOW} dueAt={NOW + 21 * D} sub="Oct 15" />
          <DeadlineChip now={NOW} dueAt={NOW + 6 * D} sub="Sep 30" />
          <DeadlineChip now={NOW} dueAt={NOW + 1 * D} sub="5:00 PM" />
          <DeadlineChip now={NOW} dueAt={NOW - 2 * D} />
          <DeadlineChip now={NOW} dueAt={NOW - 6 * D} done doneLabel="Submitted" sub="Sep 18" />
          <DeadlineChip now={NOW} dueAt={NOW + 6 * D} size="lg" />
        </div>
      </Section>

      <Section title="Avatars, marks and progress">
        <div className="flex flex-wrap items-center gap-3">
          <Avatar name="Margaret Ellis" tone="consultant" size="xl" />
          <Avatar name="Margaret Ellis" tone="consultant" size="lg" />
          <Avatar name="Jane Alvarez" />
          <AvatarStack names={['Jane Alvarez', 'Marcus Lee', 'Tia Reyes', 'Sam Ortiz']} />
          <OrgMark name="Riverside Food Bank" size="lg" />
          <OrgMark name="Harbor Arts" />
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <ProgressBar label="Upload progress" value={0.62} className="w-40" />
          <ProgressBar label="Checking" indeterminate className="w-40" />
          <SegBar done={2} total={5} />
          <PipelineMini counts={[2, 2, 1, 1]} />
          <FitScore score={92} label="Strong fit" />
        </div>
      </Section>

      <Section title="File drop zone">
        <div className="grid gap-3 lg:grid-cols-2">
          <DropZone state={{ kind: 'idle' }} onFiles={() => undefined} hint="PDF, Word, Excel or images · up to 100 MB" />
          <DropZone state={{ kind: 'uploading', name: 'Audited financials FY2025.pdf', progress: 0.62, detail: '4.2 of 6.8 MB · about 8 seconds', onCancel: () => undefined }} onFiles={() => undefined} />
          <DropZone state={{ kind: 'scanning', name: 'Audited financials FY2025.pdf' }} onFiles={() => undefined} />
          <DropZone state={{ kind: 'received', name: 'Audited financials FY2025.pdf', when: 'Sep 24, 2:14 PM', visibleTo: `you and ${sample.short}` }} onFiles={() => undefined} />
          <DropZone state={{ kind: 'error', message: 'The connection dropped at 71%. Your file is safe on your device.', onRetry: () => undefined }} onFiles={() => undefined} />
        </div>
      </Section>

      <Section title="Checklist">
        <div className="card divide overflow-hidden">
          <ChecklistItem title="2025 Form 990" detail="Most recent filed return · due Sep 30" status="needed" action={<Button variant="secondary"><Upload aria-hidden className="i" />Upload</Button>} />
          <ChecklistItem title="Audited financial statements" detail="FY2025, with auditor’s letter" status="uploading" progress={0.48} />
          <ChecklistItem title="Board of directors list" detail="Names, roles, terms" status="checking" />
          <ChecklistItem title="IRS determination letter" detail="501(c)(3) letter" status="received" receivedAt="Sep 24, 2:14 PM" />
          <ChecklistItem title="W-9" detail="Signed within the last 12 months" status="rejected" overdue={<DeadlineChip now={NOW} dueAt={NOW - 2 * D} />} action={<Button><Upload aria-hidden className="i" />Upload</Button>} />
        </div>
      </Section>

      <Section title="Opportunity and kanban">
        <OpportunityCard
          now={NOW}
          onRespond={() => undefined}
          opp={{
            funder: 'Hartwell Family Foundation',
            title: 'Community nutrition grants',
            amount: '$25,000 – $75,000',
            dueAt: NOW + 21 * D,
            tag: 'Recommended',
            fit: { score: 92, label: 'Strong fit' },
            eligibility: [
              { ok: true, text: '501(c)(3)' },
              { ok: false, text: 'Needs audited financials' },
            ],
            note: { author: 'Margaret Ellis', text: 'Your mobile pantry fits their rural-access priority almost word for word.' },
          }}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <KanbanCard now={NOW} funder="City Arts Council" title="Operating support" amount="$30,000" dueAt={NOW + 3 * D} deliverables={{ done: 4, total: 5 }} assignee="Tia Reyes" client="Harbor Arts Collective" />
          <KanbanCard now={NOW} funder="Alder Health Trust" title="Nutrition and chronic disease" amount="$40,000" dueAt={NOW} awarded deliverables={{ done: 4, total: 4 }} assignee="Margaret Ellis" />
        </div>
      </Section>

      <Section title="Versions and approval">
        <VersionList
          versions={[
            { n: 3, summary: 'Personnel costs split by program', by: 'Margaret Ellis', when: 'Today 11:02 AM', context: 'not shared yet', status: 'draft' },
            { n: 2, summary: 'Updated to FY26 budget', by: 'Margaret Ellis', when: 'Tue 4:40 PM', context: 'shared with Jane', status: 'waiting', current: true },
            { n: 1, summary: 'First draft', by: 'Margaret Ellis', when: 'Sep 15', context: 'Jane requested changes', status: 'changes' },
          ]}
        />
        <ApprovalBar title="Budget narrative · v2" detail="Ready for your approval · due Sep 30" onApprove={() => undefined} onRequestChanges={() => undefined} />
        <ApprovalBar title="" detail="" onApprove={() => undefined} onRequestChanges={() => undefined} approved={{ when: 'Sep 24, 2:31 PM', onUndo: () => undefined }} />
      </Section>

      <Section title="Table">
        <Table
          caption="Clients"
          rowKey={(r) => r.name}
          sortedBy="name"
          onSort={() => undefined}
          selected={new Set(['Harbor Arts Collective'])}
          rows={[
            { name: 'Riverside Food Bank', where: 'Nonprofit · Sacramento, CA', status: 'warn' as const, label: 'Awaiting client', due: 1 },
            { name: 'Harbor Arts Collective', where: 'Nonprofit · Oakland, CA', status: 'ok' as const, label: 'Active', due: 3 },
          ]}
          columns={[
            { key: 'name', header: 'Client', sortable: true, cell: (r) => <div className="flex items-center gap-(--gap-row)"><OrgMark name={r.name} /><div className="flex min-w-0 flex-col"><span className="font-medium">{r.name}</span><span className="t-xs sub2 text-text2">{r.where}</span></div></div> },
            { key: 'status', header: 'Status', cell: (r) => <Pill tone={r.status}>{r.label}</Pill> },
            { key: 'due', header: 'Next deadline', cell: (r) => <DeadlineChip now={NOW} dueAt={NOW + r.due * D} /> },
          ]}
        />
      </Section>

      <Section title="Messages and toasts">
        <div className="card flex flex-col gap-3 p-5">
          <MessageMeta author="Margaret Ellis" time="10:12 AM" consultant />
          <MessageBubble>The budget narrative v2 is ready for you.</MessageBubble>
          <MessageBubble mine>Thanks! Attaching the updated board list too.</MessageBubble>
          <AttachmentChip name="Board list 2026.pdf" where="Saved to Documents › Governance" icon={FileText} />
          <Composer placeholder="Write to Margaret…" onSend={() => undefined} onAttach={() => undefined} />
        </div>
        <div className="flex flex-col items-start gap-2.5">
          <Toast icon={CircleCheck} action={{ label: 'View', onClick: () => undefined }}>
            <b className="font-medium">Received</b> · Board list 2026.pdf · 2:14 PM
          </Toast>
          <Toast tone="danger" action={{ label: 'Retry', onClick: () => undefined }}>
            Couldn’t send. Check your connection.
          </Toast>
        </div>
        <div className="flex flex-col gap-2">
          <Notice tone="warn">Client invites are paused until your sending domain is verified.</Notice>
          <Notice tone="info">Reports go out Monday at 8:00 AM.</Notice>
          <Notice tone="acc">New matches are waiting for your review.</Notice>
          <Notice tone="ok">Saved.</Notice>
          <Notice tone="danger">That didn’t work. Try again.</Notice>
        </div>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      </Section>

      <Section title="Empty states">
        <div className="grid gap-3 lg:grid-cols-2">
          <EmptyState icon={FileText} title="No reports yet" action={<Button><Plus aria-hidden className="i" />Build first report</Button>}>
            Build a funding report and Riverside will see it here.
          </EmptyState>
          <EmptyState icon={Inbox} title="Nothing needs you today" action={<Button variant="secondary">Open clients</Button>}>
            Deadlines, uploads and approvals will show up here as they happen.
          </EmptyState>
        </div>
      </Section>

      <Section title="Command palette">
        <CommandPalette
          onClose={() => undefined}
          items={[
            { id: `${mode}-c1`, group: 'Clients', label: 'Riverside Food Bank', detail: 'Awaiting client', icon: Building2, run: () => undefined },
            { id: `${mode}-a1`, group: 'Actions', label: 'Request documents from Riverside Food Bank', icon: Upload, run: () => undefined },
            { id: `${mode}-g1`, group: 'Go to', label: 'Pipeline', icon: KanbanSquare, keys: ['G', 'P'], run: () => undefined },
            { id: `${mode}-g2`, group: 'Go to', label: 'Schedules', icon: CalendarClock, keys: ['G', 'S'], run: () => undefined },
            { id: `${mode}-s`, group: 'Go to', label: 'Search everything', icon: Search, run: () => undefined },
          ]}
        />
      </Section>

      <Section title="Settings row">
        <SettingsRow
          title="Reminder tone"
          help="How document reminders read to clients."
          control={<Segmented label="Reminder tone" value={seg} onChange={setSeg} options={[{ value: 'warm', label: 'Warm' }, { value: 'neutral', label: 'Neutral' }, { value: 'direct', label: 'Direct' }]} />}
          note="Changes apply to reminders scheduled after you save."
          preview={
            <>
              <span className="lab">Preview · email subject</span>
              <span className="t-sm font-medium">A quick reminder: 2 documents for {sample.short}</span>
            </>
          }
        />
      </Section>
    </div>
  );
}

function KitchenSink() {
  const config = useConfig();
  const { brand } = Route.useSearch();
  const navigate = Route.useNavigate();
  if (config.isPending) return null;
  if (!config.data?.devTools) {
    return (
      <main className="grid min-h-dvh place-items-center p-6 text-center">
        <h1 className="hd text-2xl">Page not found</h1>
      </main>
    );
  }
  return (
    <main className="min-h-dvh bg-bg">
      <div className="flex items-center gap-3 border-b border-border bg-raised px-6 py-3">
        <h1 className="hd t-h3">Kitchen sink</h1>
        <Segmented<BrandKey>
          label="Sample brand"
          value={brand}
          onChange={(b) => void navigate({ search: { brand: b } })}
          options={(Object.keys(SAMPLE_BRANDS) as BrandKey[]).map((k) => ({ value: k, label: SAMPLE_BRANDS[k].short }))}
        />
      </div>
      <div className="grid xl:grid-cols-2">
        <Panel brand={brand} mode="light" />
        <Panel brand={brand} mode="dark" />
      </div>
    </main>
  );
}
