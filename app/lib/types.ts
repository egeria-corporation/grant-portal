/** Response shapes from the client-scoped API (worker/api/*). */
export type ClientAccess = 'staff' | 'admin' | 'member';

export interface FileSummary {
  id: string;
  filename: string;
  mime: string;
  size: number;
  sha256: string | null;
  folder: string | null;
  tags: string[];
  expiresAt: number | null;
  scanStatus: 'none' | 'pending' | 'clean' | 'infected' | 'error';
  shared: boolean;
  uploadedBy: { id: string | null; name: string | null; kind: string | null };
  createdAt: number;
}

export interface VaultResponse {
  files: FileSummary[];
  folders: string[];
  policy: { maxBytes: number; extensions: string[] };
}

export interface RequestItem {
  id: string;
  label: string;
  required: boolean;
  hint: string | null;
  fulfilledAt: number | null;
  file: FileSummary | null;
}

export interface DocRequest {
  id: string;
  title: string;
  message: string | null;
  dueAt: number | null;
  status: 'open' | 'complete' | 'cancelled';
  reminders: { beforeDays: number[]; onDue: boolean; afterDays: number[] } | null;
  createdAt: number;
  items: RequestItem[];
}

export type DeliverableStatus = 'not_started' | 'in_progress' | 'in_review' | 'approved' | 'done';

export interface Deliverable {
  id: string;
  title: string;
  description: string | null;
  side: 'consultant' | 'client';
  status: DeliverableStatus;
  dueAt: number | null;
  assignee: { id: string; name: string | null } | null;
  opportunity: { id: string; title: string | null } | null;
  versionCount: number;
  latestVersionId: string | null;
  latestDecision: 'approved' | 'changes' | null;
  createdAt: number;
  updatedAt: number;
}

export interface DeliverableVersion {
  id: string;
  version: number;
  file: FileSummary | null;
  url: string | null;
  note: string | null;
  createdAt: number;
  createdBy: { name: string | null; kind: string | null };
  decisions: { id: string; decision: 'approved' | 'changes'; comment: string | null; createdAt: number; by: { name: string | null; kind: string | null } }[];
}

export interface DeliverableDetail {
  deliverable: Deliverable;
  canAddVersion: boolean;
  canDecide: boolean;
  versions: DeliverableVersion[];
}

export interface Message {
  id: string;
  body: string;
  createdAt: number;
  mine: boolean;
  author: { name: string | null; kind: string | null };
  attachments: FileSummary[];
}

export interface Overview {
  openItems: { requestId: string; requestTitle: string; itemId: string; label: string; required: boolean; dueAt: number | null }[];
  awaitingDecision: Deliverable[];
  owedByCaller: Deliverable[];
  unreadMessages: number;
  deadlines: { kind: 'deliverable' | 'request'; id: string; title: string; dueAt: number }[];
  overdue: number;
  latestFromConsultant: { id: string; body: string; createdAt: number; author: string } | null;
  pipeline: Record<string, number>;
  latestUpdate: { id: string; subject: string; intro: string | null; sentAt: number } | null;
}

export interface UpdateBlock {
  kind: 'deadlines' | 'opportunities' | 'documents' | 'wins';
  title: string;
  items: { title: string; detail?: string }[];
  empty: string;
}

export interface ClientUpdate {
  id: string;
  scheduleId: string | null;
  subject: string;
  intro: string | null;
  blocks: string[];
  content: UpdateBlock[] | null;
  status: 'scheduled' | 'pending_review' | 'sent' | 'cancelled';
  sendAt: number | null;
  sentAt: number | null;
  createdAt: number;
}

export interface UpdateSchedule {
  id: string;
  rrule: string;
  description: string;
  timezone: string | null;
  nextRunAt: number | null;
  config: { subject: string; intro: string | null; blocks: string[] } | null;
  requiresReview: boolean;
  enabled: boolean;
}

export interface ClientProfile {
  id: string;
  name: string;
  legalName: string | null;
  status: 'onboarding' | 'active' | 'paused' | 'archived';
  einLast4?: string | null;
  hasEin?: boolean;
  entityType: string | null;
  is501c3: boolean | null;
  ntee: string | null;
  geography: string[];
  budgetBand: string | null;
  fyeMonth: number | null;
  ueiSamStatus: string | null;
  mission: string | null;
  programs: string[];
  populations: string[];
  focusTags?: string[];
  fundingGoals?: { targetAmount: number | null; timeline: string | null; types: string[] };
  clientCanEdit: boolean;
  reminders?: { documents: boolean; approvals: boolean; deadlines: boolean };
  isDemo?: boolean;
  canEdit: boolean;
  createdAt: number;
  lastActivityAt: number | null;
}

export interface Member {
  id: string;
  email: string;
  name: string | null;
  role: 'admin' | 'member';
  joinedAt: number;
  activeSessions?: number;
}
