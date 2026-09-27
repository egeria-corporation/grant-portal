/**
 * Funding reports (spec §5.3): sending, and assembling the branded PDF.
 * The routes live in worker/api/reports.ts; alerts (worker/funding/alerts.ts)
 * also send reports when a recurring report runs without review.
 */
import type { AppEnv } from '../env';
import { getBrandState } from '../brand/state';
import { loadEmailBrand } from '../email/templates/brand';
import { eventStmts } from '../lib/events';
import { getSetting } from '../lib/settings';
import { clientName, notify } from '../notify';
import { pdfImage, renderReportPdf, type PdfReportItem } from './pdf';

export interface ReportRow {
  id: string;
  client_id: string;
  title: string;
  intro_md: string | null;
  status: 'draft' | 'scheduled' | 'sent';
  sent_at: number | null;
  schedule_id: string | null;
  pending_review: number;
  sent_by: string | null;
  created_by: string | null;
  updated_at: number | null;
  created_at: number;
}

export class ReportError extends Error {
  constructor(readonly code: 'report_empty' | 'report_not_draft') {
    super(code);
  }
}

/** Draft → sent, with its event and the client's email. Conditional, so two clicks send once. */
export async function sendReport(env: AppEnv, reportId: string, clientId: string, actor: string | null): Promise<void> {
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM report_items WHERE report_id = ?').bind(reportId).first<{ n: number }>();
  if (!count?.n) throw new ReportError('report_empty');
  const now = Date.now();
  const title = (await env.DB.prepare('SELECT title FROM reports WHERE id = ? AND client_id = ?').bind(reportId, clientId).first<{ title: string }>())?.title ?? '';
  const [moved] = await env.DB.batch([
    env.DB.prepare("UPDATE reports SET status = 'sent', sent_at = ?, sent_by = ?, pending_review = 0, updated_at = ? WHERE id = ? AND client_id = ? AND status = 'draft'").bind(
      now,
      actor,
      now,
      reportId,
      clientId,
    ),
  ]);
  if (!moved?.meta.changes) throw new ReportError('report_not_draft');
  await env.DB.batch(eventStmts(env, { clientId, actor, type: 'report.sent', payload: { reportId, title, count: count.n }, at: now }));
  await notify(env, { clientId, audience: 'client', kind: 'report', payload: { reportId, title, clientName: await clientName(env, clientId) }, actorId: actor });
}

/** The report as a branded PDF (client-visible fields only: no private notes, no data source). */
export async function reportPdf(env: AppEnv, report: ReportRow): Promise<Uint8Array> {
  const [brand, state, items, org] = await Promise.all([
    loadEmailBrand(env, null),
    getBrandState(env),
    env.DB.prepare(
      `SELECT o.title, o.funder_name, o.url, o.amount_min, o.amount_max, o.deadline_at, o.eligibility_notes, i.note_md, i.tag
         FROM report_items i JOIN opportunities o ON o.id = i.opportunity_id
        WHERE i.report_id = ? AND o.client_id = ? ORDER BY i.position`,
    )
      .bind(report.id, report.client_id)
      .all<{
        title: string;
        funder_name: string | null;
        url: string | null;
        amount_min: number | null;
        amount_max: number | null;
        deadline_at: number | null;
        eligibility_notes: string | null;
        note_md: string | null;
        tag: PdfReportItem['tag'];
      }>(),
    getSetting(env, 'org'),
  ]);
  const logoMeta = state.assets['logo-light'];
  let logo = null;
  if (logoMeta && (logoMeta.mime === 'image/png' || logoMeta.mime === 'image/jpeg') && logoMeta.size <= 2 * 1024 * 1024) {
    const obj = await env.FILES.get(logoMeta.key);
    if (obj) logo = await pdfImage(new Uint8Array(await obj.arrayBuffer()), logoMeta.mime);
  }
  return renderReportPdf({
    firm: brand.firm,
    colors: { accent: brand.colors.accent, text: brand.colors.text, text2: brand.colors.text2, border: brand.colors.border },
    logo,
    title: report.title,
    clientName: await clientName(env, report.client_id),
    date: report.sent_at ?? Date.now(),
    tz: org?.timezone ?? 'UTC',
    intro: report.intro_md,
    items: items.results.map((i) => ({
      tag: i.tag,
      title: i.title,
      funderName: i.funder_name,
      url: i.url,
      amountMin: i.amount_min,
      amountMax: i.amount_max,
      deadlineAt: i.deadline_at,
      note: i.note_md,
      eligibility: i.eligibility_notes,
    })),
  });
}

/** `Acme — Funding report.pdf` without characters that break Content-Disposition. */
export function pdfFilename(title: string): string {
  const safe = title.replace(/[^\w .,()&'-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${safe || 'Funding report'}.pdf`;
}
