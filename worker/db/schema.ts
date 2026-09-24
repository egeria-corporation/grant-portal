/**
 * D1 schema (spec §11). Source of truth for migrations: edit here, then
 * `npm run db:generate` and commit the SQL. Migrations only ever add.
 *
 * Conventions: IDs are ULIDs (text), timestamps are UTC epoch ms (integer),
 * JSON columns are text with a `_json` suffix, encrypted columns end in `_enc`.
 */
import {
  blob,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

const id = () => text('id').primaryKey();
const createdAt = () => integer('created_at').notNull();

/** v1 always uses the single org `org_default` (docs/DECISIONS.md D-007). */
export const DEFAULT_ORG_ID = 'org_default';
const orgId = () => text('org_id').notNull().default(DEFAULT_ORG_ID);

export const orgs = sqliteTable('orgs', {
  id: id(),
  name: text('name').notNull(),
  createdAt: createdAt(),
});

export const settings = sqliteTable(
  'settings',
  {
    orgId: orgId(),
    key: text('key').notNull(),
    valueJson: text('value_json').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.key] })],
);

export const users = sqliteTable(
  'users',
  {
    id: id(),
    orgId: orgId(),
    email: text('email').notNull(),
    name: text('name'),
    kind: text('kind', { enum: ['staff', 'client'] }).notNull(),
    role: text('role', { enum: ['owner', 'consultant', 'client_admin', 'client_member'] }).notNull(),
    timezone: text('timezone'),
    notifPrefsJson: text('notif_prefs_json'),
    passkeyRequired: integer('passkey_required', { mode: 'boolean' }).notNull().default(false),
    /** Owner may grant a consultant access to all clients (spec §7.3). */
    allClients: integer('all_clients', { mode: 'boolean' }).notNull().default(false),
    emailSuppressedAt: integer('email_suppressed_at'),
    createdAt: createdAt(),
    disabledAt: integer('disabled_at'),
  },
  (t) => [uniqueIndex('users_email_uq').on(t.email)],
);

export const passkeys = sqliteTable(
  'passkeys',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    credentialId: text('credential_id').notNull(),
    publicKey: blob('public_key', { mode: 'buffer' }).notNull(),
    signCount: integer('sign_count').notNull().default(0),
    transports: text('transports'),
    label: text('label'),
    createdAt: createdAt(),
    lastUsedAt: integer('last_used_at'),
  },
  (t) => [uniqueIndex('passkeys_credential_uq').on(t.credentialId), index('passkeys_user_idx').on(t.userId)],
);

export const magicLinks = sqliteTable(
  'magic_links',
  {
    id: id(),
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull(),
    codeHash: text('code_hash'),
    codeSalt: text('code_salt'),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: integer('expires_at').notNull(),
    usedAt: integer('used_at'),
    ipHash: text('ip_hash'),
    uaHash: text('ua_hash'),
    purpose: text('purpose', { enum: ['signin', 'invite', 'setup'] }).notNull(),
    /** For invites: which client the recipient is joining, and as what. */
    clientId: text('client_id'),
    inviteRole: text('invite_role'),
    createdBy: text('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('magic_links_token_hash_uq').on(t.tokenHash),
    index('magic_links_email_idx').on(t.email, t.createdAt),
    index('magic_links_expires_idx').on(t.expiresAt),
  ],
);

export const sessions = sqliteTable(
  'sessions',
  {
    idHash: text('id_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    lastSeenAt: integer('last_seen_at').notNull(),
    idleExpiresAt: integer('idle_expires_at').notNull(),
    absExpiresAt: integer('abs_expires_at').notNull(),
    /** Last step-up re-auth (passkey or fresh magic link) for sensitive actions. */
    stepUpAt: integer('step_up_at'),
    ipHash: text('ip_hash'),
    uaLabel: text('ua_label'),
    revokedAt: integer('revoked_at'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const clients = sqliteTable(
  'clients',
  {
    id: id(),
    orgId: orgId(),
    name: text('name').notNull(),
    legalName: text('legal_name'),
    status: text('status', { enum: ['onboarding', 'active', 'paused', 'archived'] })
      .notNull()
      .default('onboarding'),
    einEnc: text('ein_enc'),
    einLast4: text('ein_last4'),
    entityType: text('entity_type'),
    is501c3: integer('is_501c3', { mode: 'boolean' }),
    ntee: text('ntee'),
    geographyJson: text('geography_json'),
    budgetBand: text('budget_band'),
    fyeMonth: integer('fye_month'),
    ueiSamStatus: text('uei_sam_status'),
    mission: text('mission'),
    programsJson: text('programs_json'),
    populationsJson: text('populations_json'),
    focusTagsJson: text('focus_tags_json'),
    fundingGoalsJson: text('funding_goals_json'),
    ownerUserId: text('owner_user_id').references(() => users.id),
    isDemo: integer('is_demo', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
    archivedAt: integer('archived_at'),
  },
  (t) => [index('clients_org_status_idx').on(t.orgId, t.status)],
);

export const clientMembers = sqliteTable(
  'client_members',
  {
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['admin', 'member'] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.clientId, t.userId] }), index('client_members_user_idx').on(t.userId)],
);

export const staffAssignments = sqliteTable(
  'staff_assignments',
  {
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.clientId, t.userId] }), index('staff_assignments_user_idx').on(t.userId)],
);

export const opportunities = sqliteTable(
  'opportunities',
  {
    id: id(),
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    source: text('source', { enum: ['manual', 'opengrants', 'csv'] }).notNull(),
    ogId: text('og_id'),
    title: text('title').notNull(),
    funderName: text('funder_name'),
    url: text('url'),
    amountMin: integer('amount_min'),
    amountMax: integer('amount_max'),
    deadlineAt: integer('deadline_at'),
    eligibilityNotes: text('eligibility_notes'),
    dataJson: text('data_json'),
    stage: text('stage', {
      enum: ['none', 'researching', 'preparing', 'submitted', 'awarded', 'declined'],
    })
      .notNull()
      .default('none'),
    createdAt: createdAt(),
  },
  (t) => [index('opportunities_client_deadline_idx').on(t.clientId, t.deadlineAt)],
);

export const schedules = sqliteTable(
  'schedules',
  {
    id: id(),
    orgId: orgId(),
    clientId: text('client_id').references(() => clients.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['update', 'report', 'alert', 'reminder', 'digest'] }).notNull(),
    rrule: text('rrule').notNull(),
    timezone: text('timezone'),
    nextRunAt: integer('next_run_at'),
    configJson: text('config_json'),
    requiresReview: integer('requires_review', { mode: 'boolean' }).notNull().default(true),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdBy: text('created_by'),
    createdAt: createdAt(),
  },
  (t) => [index('schedules_next_run_idx').on(t.nextRunAt, t.enabled)],
);

export const reports = sqliteTable(
  'reports',
  {
    id: id(),
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    introMd: text('intro_md'),
    status: text('status', { enum: ['draft', 'scheduled', 'sent'] })
      .notNull()
      .default('draft'),
    sentAt: integer('sent_at'),
    scheduleId: text('schedule_id').references(() => schedules.id, { onDelete: 'set null' }),
    createdBy: text('created_by'),
    createdAt: createdAt(),
  },
  (t) => [index('reports_client_created_idx').on(t.clientId, t.createdAt)],
);

export const reportItems = sqliteTable(
  'report_items',
  {
    reportId: text('report_id')
      .notNull()
      .references(() => reports.id, { onDelete: 'cascade' }),
    opportunityId: text('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    noteMd: text('note_md'),
    tag: text('tag', { enum: ['recommended', 'consider', 'fyi'] }),
    clientResponse: text('client_response', { enum: ['pursue', 'not_now', 'question'] }),
    clientComment: text('client_comment'),
    respondedAt: integer('responded_at'),
  },
  (t) => [primaryKey({ columns: [t.reportId, t.opportunityId] })],
);

export const files = sqliteTable(
  'files',
  {
    id: id(),
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    /** `clients/{clientId}/{uuid}` — random, never derived from the filename (spec §7.4). */
    r2Key: text('r2_key').notNull(),
    filename: text('filename').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256'),
    folder: text('folder'),
    tagsJson: text('tags_json'),
    expiresAt: integer('expires_at'),
    scanStatus: text('scan_status', { enum: ['none', 'pending', 'clean', 'infected', 'error'] })
      .notNull()
      .default('none'),
    uploadStatus: text('upload_status', { enum: ['pending', 'complete', 'aborted'] })
      .notNull()
      .default('pending'),
    sharedWithClient: integer('shared_with_client', { mode: 'boolean' }).notNull().default(true),
    uploadedBy: text('uploaded_by').references(() => users.id),
    createdAt: createdAt(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    uniqueIndex('files_r2_key_uq').on(t.r2Key),
    index('files_client_created_idx').on(t.clientId, t.createdAt),
    index('files_expires_idx').on(t.expiresAt),
  ],
);

export const deliverables = sqliteTable(
  'deliverables',
  {
    id: id(),
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    opportunityId: text('opportunity_id').references(() => opportunities.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    side: text('side', { enum: ['consultant', 'client'] }).notNull(),
    assigneeUserId: text('assignee_user_id').references(() => users.id),
    dueAt: integer('due_at'),
    status: text('status', { enum: ['not_started', 'in_progress', 'in_review', 'approved', 'done'] })
      .notNull()
      .default('not_started'),
    templateId: text('template_id'),
    createdAt: createdAt(),
  },
  (t) => [index('deliverables_client_due_idx').on(t.clientId, t.dueAt)],
);

export const deliverableVersions = sqliteTable(
  'deliverable_versions',
  {
    id: id(),
    deliverableId: text('deliverable_id')
      .notNull()
      .references(() => deliverables.id, { onDelete: 'cascade' }),
    fileId: text('file_id').references(() => files.id),
    url: text('url'),
    version: integer('version').notNull(),
    noteMd: text('note_md'),
    createdBy: text('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('deliverable_versions_uq').on(t.deliverableId, t.version)],
);

export const approvals = sqliteTable(
  'approvals',
  {
    id: id(),
    deliverableVersionId: text('deliverable_version_id')
      .notNull()
      .references(() => deliverableVersions.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    decision: text('decision', { enum: ['approved', 'changes'] }).notNull(),
    comment: text('comment'),
    createdAt: createdAt(),
  },
  (t) => [index('approvals_version_idx').on(t.deliverableVersionId)],
);

export const docRequests = sqliteTable(
  'doc_requests',
  {
    id: id(),
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    message: text('message'),
    dueAt: integer('due_at'),
    reminderPolicyJson: text('reminder_policy_json'),
    status: text('status', { enum: ['open', 'complete', 'cancelled'] })
      .notNull()
      .default('open'),
    createdBy: text('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('doc_requests_client_due_idx').on(t.clientId, t.dueAt)],
);

export const docRequestItems = sqliteTable(
  'doc_request_items',
  {
    id: id(),
    docRequestId: text('doc_request_id')
      .notNull()
      .references(() => docRequests.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    required: integer('required', { mode: 'boolean' }).notNull().default(true),
    fileId: text('file_id').references(() => files.id),
    fulfilledAt: integer('fulfilled_at'),
    position: integer('position').notNull().default(0),
  },
  (t) => [index('doc_request_items_request_idx').on(t.docRequestId)],
);

export const forms = sqliteTable('forms', {
  id: id(),
  title: text('title').notNull(),
  schemaJson: text('schema_json').notNull(),
  createdAt: createdAt(),
});

export const formResponses = sqliteTable(
  'form_responses',
  {
    id: id(),
    formId: text('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    answersJson: text('answers_json'),
    submittedAt: integer('submitted_at'),
  },
  (t) => [index('form_responses_client_idx').on(t.clientId)],
);

export const alerts = sqliteTable(
  'alerts',
  {
    id: id(),
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    queryJson: text('query_json').notNull(),
    scheduleId: text('schedule_id').references(() => schedules.id, { onDelete: 'set null' }),
    lastRunAt: integer('last_run_at'),
    lastResultIdsJson: text('last_result_ids_json'),
  },
  (t) => [index('alerts_client_idx').on(t.clientId)],
);

export const emails = sqliteTable(
  'emails',
  {
    id: id(),
    toUserId: text('to_user_id').references(() => users.id, { onDelete: 'set null' }),
    toEmail: text('to_email').notNull(),
    clientId: text('client_id').references(() => clients.id, { onDelete: 'cascade' }),
    template: text('template').notNull(),
    subject: text('subject').notNull(),
    resendId: text('resend_id'),
    status: text('status', {
      enum: ['queued', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'suppressed'],
    })
      .notNull()
      .default('queued'),
    error: text('error'),
    createdAt: createdAt(),
    deliveredAt: integer('delivered_at'),
  },
  (t) => [index('emails_resend_idx').on(t.resendId), index('emails_client_created_idx').on(t.clientId, t.createdAt)],
);

export const messages = sqliteTable(
  'messages',
  {
    id: id(),
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    threadRef: text('thread_ref'),
    authorUserId: text('author_user_id').references(() => users.id),
    bodyMd: text('body_md').notNull(),
    attachmentsJson: text('attachments_json'),
    createdAt: createdAt(),
    readByJson: text('read_by_json'),
  },
  (t) => [index('messages_client_created_idx').on(t.clientId, t.createdAt)],
);

/** Client timeline (spec §5.2). */
export const events = sqliteTable(
  'events',
  {
    id: id(),
    clientId: text('client_id').references(() => clients.id, { onDelete: 'cascade' }),
    actorUserId: text('actor_user_id'),
    type: text('type').notNull(),
    payloadJson: text('payload_json'),
    createdAt: createdAt(),
  },
  (t) => [index('events_client_created_idx').on(t.clientId, t.createdAt)],
);

/** Append-only (spec §7.5). Triggers in the migration reject UPDATE and DELETE. */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: id(),
    orgId: orgId(),
    actorUserId: text('actor_user_id'),
    action: text('action').notNull(),
    target: text('target'),
    ipHash: text('ip_hash'),
    metaJson: text('meta_json'),
    createdAt: createdAt(),
  },
  (t) => [index('audit_log_created_idx').on(t.createdAt), index('audit_log_actor_idx').on(t.actorUserId)],
);

/** Queue job idempotency + dead letters (spec §12). */
export const jobRuns = sqliteTable(
  'job_runs',
  {
    key: text('key').primaryKey(), // e.g. `${schedule_id}:${run_at}`
    kind: text('kind').notNull(),
    status: text('status', { enum: ['running', 'done', 'failed', 'dead'] }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    payloadJson: text('payload_json'),
    createdAt: createdAt(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('job_runs_status_idx').on(t.status, t.updatedAt)],
);

