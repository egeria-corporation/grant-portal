# Grant Consultant Client Portal: Product & Architecture Spec

**Working name:** `grant-portal` (placeholder. The product ships with no brand, and each consultancy's brand replaces it)
**License:** Open source (MIT or Apache-2.0, see §14)
**Maintainer:** OpenGrants (opengrants.io)
**Status:** Draft v0.1, September 24, 2026
**Deploy target:** Cloudflare Workers, one consultancy per deployment

---

## 1. What this is

This is a client portal for grant consultants. It is open source, carries no brand of its own, and runs in the consultant's own Cloudflare account. A consultant clicks **Deploy to Cloudflare**, fills in a short setup wizard, and ends up with a portal on their own domain that shows their logo, colors, and name. The finished portal has no trace of us, the maintainers.

It has two sides:

- **Consultant workspace.** Manage clients, source and send funding reports, schedule updates and alerts, track deliverables and deadlines, and collect documents.
- **Client portal.** A calm, simple space where a client signs in with a magic link, sees what's due and what's been delivered, uploads documents, answers intake questions, and messages their consultant.

**Optional OpenGrants integration.** If the consultant pastes in an OpenGrants API key, funding discovery (grant search, matching, funder lookup) and automated funding alerts turn on inside the workspace. Without a key the portal still works fully as a client-management and delivery tool.

### 1.1 Goals

1. **Under 15 minutes from finding the repo to a live, branded portal**, measured with a stopwatch on a fresh Cloudflare account. The target for a returning Cloudflare user is under 8 minutes.
2. **Secure by default.** Clients hand over financials, 990s, EINs, and budgets, so the default settings have to be safe without the consultant doing anything.
3. **Truly unbranded.** The consultant's brand shows up on every surface: login, emails, favicon, PDF exports, email sender, and domain.
4. **Clients barely have to think.** No passwords, no app to install, no "create an account" step.
5. **Consultants can run a practice from it.** It holds the recurring work (weekly reports, deadline reminders, document chasing) that currently lives across spreadsheets, Drive folders, and Gmail.

### 1.2 Non-goals (v1)

- Multi-tenant SaaS hosting. One deploy serves one consultancy. §15 covers a possible multi-tenant v2.
- Full grant-writing editor or proposal authoring. Deliverables are files and links, not an in-app word processor.
- Billing and invoicing. The portal can link out to Stripe or QuickBooks invoices.
- Native mobile apps. The web app is responsive and installable as a PWA.
- Grants management after award (drawdowns, compliance reporting). This is a candidate for v2.

---

## 2. Personas

| Persona | Who | What they need |
|---|---|---|
| **Owner** | The principal consultant who deployed it | Branding, settings, integrations, team, and the whole book of clients |
| **Consultant (team member)** | Associate writers and researchers | Clients assigned to them, report building, deliverables, messaging |
| **Client contact** | Executive director, development director, or founder at the client org | See status, upload what's asked, approve deliverables, get alerts |
| **Client collaborator** | A CFO or program lead the contact invites | Limited upload and view access within one client org |

Roles in v1 are **Owner**, **Consultant**, **Client Admin**, and **Client Member**. Permissions are listed in §7.3.

---

## 3. The 15-minute deploy

This is the headline feature and the thing people will judge the project on. The whole path is built to fit the time budget.

### 3.1 Time budget

| Step | Who | Target |
|---|---|---|
| Land on the GitHub README and click **Deploy to Cloudflare** | Consultant | 0:30 |
| Sign in or sign up for Cloudflare and authorize GitHub | Consultant | 2:00 (new account) / 0:20 |
| Cloudflare setup page: name the repo and Worker, paste `RESEND_API_KEY` (and optionally `OPENGRANTS_API_KEY`) | Consultant | 2:00 |
| Cloudflare clones the repo, provisions D1, R2, and KV, builds, runs migrations, and deploys | Automated | 2:00–3:00 |
| Open `*.workers.dev`, then the **first-run setup wizard** (§3.3) | Consultant | 4:00 |
| Sign in as Owner (magic link to the Resend account email) | Consultant | 0:30 |
| **Total** | | **~11–12 min** |

A custom domain and a verified sending domain are **optional follow-ups** and not part of the 15-minute path. The wizard can start them, but the portal is usable before they finish (§3.4).

### 3.2 What the Deploy button does (verified against Cloudflare docs, Sept 2026)

The Deploy to Cloudflare button:

- clones the repo into the consultant's own GitHub or GitLab account, so they own the fork and can take updates
- **auto-provisions** the bindings declared in `wrangler.jsonc`: D1 databases, R2 buckets, KV namespaces, Queues, Durable Objects, Workers AI, and Secrets Store secrets
- shows the secrets listed in `.dev.vars.example` as fields on the setup page, with help text taken from `package.json → cloudflare.bindings.<NAME>.description`
- sets up Workers Builds (CI/CD). Every push to `main` redeploys, and pull requests get preview URLs.
- runs the repo's `deploy` script, which is how D1 migrations run on first deploy

**Repo requirements that follow from this:**

```jsonc
// wrangler.jsonc (abridged)
{
  "name": "grant-portal",
  "main": "./worker/index.ts",
  "compatibility_date": "2026-09-24",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": "./dist/client", "not_found_handling": "single-page-application", "run_worker_first": ["/api/*", "/auth/*", "/f/*"] },
  "d1_databases":  [{ "binding": "DB",    "database_name": "grant-portal-db" }],
  "r2_buckets":    [{ "binding": "FILES", "bucket_name":   "grant-portal-files" }],
  "kv_namespaces": [{ "binding": "KV" }],
  "queues": {
    "producers": [{ "binding": "JOBS", "queue": "grant-portal-jobs" }],
    "consumers": [{ "queue": "grant-portal-jobs", "max_batch_size": 10 }]
  },
  "triggers": { "crons": ["*/15 * * * *", "0 13 * * *"] },
  "vars": { "APP_ENV": "production" }
}
```

```ini
# .dev.vars.example (each line becomes a field on the Cloudflare setup page)
RESEND_API_KEY=re_xxx            # Required. Sends magic links and client emails.
SESSION_SECRET=change-me         # Required. 32+ random bytes. The README offers a one-click generator.
OPENGRANTS_API_KEY=              # Optional. Turns on funding discovery and alerts.
```

```json
// package.json (excerpt)
{
  "scripts": {
    "build": "vite build",
    "deploy": "npm run db:migrate && wrangler deploy",
    "db:migrate": "wrangler d1 migrations apply DB --remote"
  },
  "cloudflare": {
    "bindings": {
      "RESEND_API_KEY": { "description": "Create a free key at [resend.com/api-keys](https://resend.com/api-keys). Used for sign-in links and client emails." },
      "SESSION_SECRET": { "description": "Any long random string. Run `openssl rand -hex 32` or use the generator linked in the README." },
      "OPENGRANTS_API_KEY": { "description": "**Optional.** Adds grant search, matching, and funding alerts. Get a key at [ops.opengrants.io/api-docs](https://ops.opengrants.io/api-docs)." }
    }
  }
}
```

**Design rules for fast deploys**

- **Three secrets at most on the setup page**, and only one of them (`RESEND_API_KEY`) needs another account. Everything else goes in the in-app wizard, where it gets a real UI.
- **No build step needs a secret.** Builds must succeed with an empty environment.
- **Migrations are idempotent** and reference the binding (`DB`), not the database name, so consultants can rename the database.
- **Auto-generate `SESSION_SECRET` when it's missing.** If the field is left blank, the Worker generates a key on first boot, stores it in KV, and shows a banner recommending the consultant move it to a proper secret. This saves a step without dropping below a sane floor.

> Caveat: whether Cloudflare's setup page accepts an empty required secret has to be confirmed in testing. If it doesn't, the README links to a static "generate secret" page (a bare HTML page in the repo's GitHub Pages) that makes a value with one click.

### 3.3 First-run setup wizard (inside the app)

The first visit to a fresh deployment shows the wizard. It's locked to the first person who completes step 1, and the Owner is created at that step. Steps:

1. **Claim this portal.** Enter your email. Because Resend's shared `resend.dev` test domain can only deliver to the email that owns the Resend account, the wizard says so and pre-fills that expectation. A one-time **setup code** printed in the Worker logs is the fallback if email fails.
2. **Your brand.** Firm name, logo (light and dark), accent color (with a live contrast check), favicon (generated from the logo if skipped), and a short welcome message for clients. A live preview shows the client login screen as it changes.
3. **Email sender.** "Send from `portal@yourfirm.com`." The wizard creates the domain through the Resend API and shows the DNS records. **If the domain is on Cloudflare, it offers one-click record creation** (this needs a scoped Cloudflare API token, optional). The step can be skipped, and the portal flags that client invites are blocked until the domain is verified.
4. **Custom domain** (optional). "Put the portal at `clients.yourfirm.com`." It links to the right Cloudflare dashboard screen with instructions, or does it automatically when an API token is given.
5. **Funding discovery** (optional). Paste an OpenGrants key or skip. Shows what it turns on.
6. **Invite your team** (optional).
7. **Add your first client**, or load a **demo client** with sample deliverables, a sample report, and a sample schedule so the consultant can look around right away. The demo is easy to delete.

The wizard ends on a **"Your portal is live"** screen showing the client login URL, a copyable invite email, and a checklist of remaining optional tasks.

### 3.4 What's blocked until email is verified

| Capability | Before domain verification | After |
|---|---|---|
| Owner or team sign-in | ✅ (Owner via the Resend account email; team via the setup code or a verified domain) | ✅ |
| Build clients, deliverables, reports | ✅ | ✅ |
| Invite clients / send client email | ⛔ with a clear banner and a "Verify domain" CTA | ✅ |
| Share a client link manually (copy link) | ✅ one-time invite link, single-use, 72h | ✅ |

The manual invite link means a consultant can onboard a client in the first 15 minutes even before DNS propagates.

### 3.5 Updates

- The consultant's fork gets a **"Sync from upstream"** GitHub Action, run weekly or by hand, that opens a PR from the upstream `main`. Merging it redeploys through Workers Builds.
- Migrations only ever add. Breaking schema changes need a two-release deprecation.
- An in-app **"Update available"** notice compares the build's version with the latest GitHub release tag. The check is anonymous and can be turned off.

---

## 4. Architecture

### 4.1 Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Cloudflare Workers** (single Worker, static assets + API) | One deployable unit, and the Deploy button supports it best |
| API framework | **Hono** | Small, built for Workers, typed routes, good middleware |
| Frontend | **React + Vite + TanStack Router/Query**, served as Worker static assets | Fast SPA, deep links, strong typing |
| UI kit | **Tailwind + Radix primitives + a small in-house component set** with CSS-variable theming | Theming a white-label product needs token-driven styling (§8) |
| Database | **D1** (SQLite) + **Drizzle ORM** | Auto-provisioned, and the migrations work with the deploy script |
| Files | **R2** | Client uploads and deliverables. Encrypted at rest by Cloudflare, with optional app-level encryption (§7.5). |
| Ephemeral state | **KV** | Rate-limit counters, feature flags, cached OpenGrants responses, brand cache |
| Background jobs | **Queues** + **Cron Triggers** | Email sending, report generation, alert fan-out, reminders |
| Email | **Resend** (default adapter) | Mature API, domain verification API, webhooks |
| Bot protection | **Turnstile** (invisible) on magic-link request forms | Protects the email-sending endpoint from abuse |
| Optional AI | **Workers AI** binding (off by default) | Summarize uploaded documents, draft report intros, extract fields |

Optional later: **Durable Objects** for live presence and real-time message threads. v1 uses polling and SSE-free refetch.

### 4.2 Request flow

```
Browser ──► Worker
            ├─ /assets/*        → static assets (SPA)
            ├─ /auth/*          → magic-link request/verify, sessions, passkeys
            ├─ /api/*           → Hono JSON API (authz middleware → handlers → D1/R2/KV)
            ├─ /f/:token        → short-lived signed file download (R2 stream)
            ├─ /brand/*         → dynamic theme CSS, favicon, OG image, manifest
            └─ /webhooks/resend → delivery/bounce/complaint events
Cron ──► enqueue due jobs (reminders, digests, alert runs)
Queue ──► consumer: send email, build report, run OpenGrants alert, scan upload
```

### 4.3 Repo layout

```
/worker
  index.ts              # Hono app + fetch/scheduled/queue exports
  auth/                 # magic links, sessions, passkeys, CSRF
  api/                  # route modules per domain
  jobs/                 # queue consumers, cron dispatch
  email/                # adapter interface + resend.ts + templates (react-email)
  integrations/opengrants/
  db/schema.ts          # Drizzle schema
/migrations             # D1 SQL migrations
/app                    # React SPA (consultant + client surfaces share one app; route trees split)
  routes/workspace/...
  routes/portal/...
  ui/                   # themed components
/docs                   # deploy guide, security model, API, theming
.dev.vars.example
wrangler.jsonc
```

---

## 5. Consultant workspace: features

### 5.1 Home (Today)

- **Today / This week** feed: deadlines approaching (grant deadlines, deliverable due dates), uploads received, client messages, scheduled sends going out today, alerts with new matches.
- **Clients needing attention**: overdue requests, unread messages, deliverables waiting on client approval.
- Quick actions: New client, New report, Request documents, Schedule update.

### 5.2 Clients

- Client list with status (Onboarding, Active, Paused, Archived), assigned consultant, next deadline, and last activity.
- **Client profile** holds everything we need to match and write:
  - Org basics: legal name, EIN (masked, §7.5), entity type, 501(c)(3) status, NTEE code, geography served, annual budget band, fiscal year end, UEI/SAM status
  - Mission, programs, populations served, focus areas (tags)
  - Funding goals: target amount, timeline, funding types sought (federal, state, foundation, corporate)
  - Contacts (client users) and their roles
- **Client timeline**: an audit-grade log of everything that happened (uploads, sends, approvals, messages, logins).
- **Intake forms**: a reusable form builder (text, long text, select, date, file, repeatable groups). Consultants send one, clients fill it in the portal, and answers map to profile fields where configured.

### 5.3 Funding reports (sourcing grants for clients)

A **report** is a curated, branded set of funding opportunities for one client, with the consultant's commentary.

- **Sources**
  - *With OpenGrants:* search grants, contracts, and funders from inside the report builder. "Match to client" uses the client profile (§10). Results show fit score, deadline, amount, eligibility notes, and the funder.
  - *Without OpenGrants:* add opportunities by hand (title, funder, URL, deadline, amount, notes) or paste a URL and fill the fields by hand. CSV import is supported.
- **Builder**: drag to reorder; per-opportunity consultant notes ("Strong fit. Their 2025 cycle funded two orgs like yours."); a status tag (Recommended / Consider / FYI); and a "Pursue?" question the client can answer.
- **Output**: a report page in the client portal (primary), an email summary linking to it, and a **branded PDF export**.
- **Client response**: per opportunity, the client can mark **Pursue / Not now / Question**. "Pursue" turns into a pipeline item and, optionally, a set of deliverables from a template.
- **Recurring reports**: "Every Monday, send Acme a report of new matches since last week." These need OpenGrants. Consultants can require review before each send (default ON) or send automatically.

### 5.4 Pipeline (per client)

A board of opportunities the client is pursuing: **Researching → Preparing → Submitted → Awarded / Declined**. Each card links to its deliverables, deadline, required documents, and notes. Consultants see a cross-client pipeline view, and clients see only their own.

### 5.5 Deliverables

- A deliverable is a thing the consultant owes the client, or the client owes the consultant. Fields: title, owner side (Consultant / Client), assignee, due date, status (Not started / In progress / In review / Approved / Done), attachments, version history, and optionally a linked opportunity.
- **Approvals**: consultant uploads draft v1 → client reviews → Approve or Request changes (with comment) → v2… Every version is kept.
- **Templates**: e.g. "Federal grant application" creates 12 deliverables with relative due dates (e.g., "Budget narrative: deadline minus 14 days").

### 5.6 Document requests & vault

- **Request documents**: "We need your latest 990, audited financials, board list, and W-9." Each item becomes a checklist in the client portal with an upload slot, a due date, and a reminder cadence.
- **Vault**: a per-client document library with folders (Financials, Governance, Programs, Submitted Applications, Awards) and tags. It has search, and **expiry tracking** for documents that go stale ("Audit FY2025 expires Dec 31").
- **Reuse**: attach vault documents to any deliverable without uploading again.

### 5.7 Schedules, updates & alerts

- **Scheduled updates**: compose a branded email update (rich text + blocks: "Deadlines this month", "New opportunities", "Documents we still need", "Wins") and send now, schedule, or repeat. Blocks fill themselves from live data at send time.
- **Automatic reminders** (per client, configurable):
  - Document request reminders: e.g. 3 days before due, on the due date, and 2 days overdue
  - Deliverable approval nudges
  - Grant deadline countdowns (30 / 14 / 7 / 2 days)
- **Funding alerts** (OpenGrants): saved searches per client that run on a schedule. New matches either queue for consultant review (default) or go straight into the client's digest.
- **Calendar**: one calendar of all deadlines, deliverable dates, and scheduled sends, with an **ICS feed** per consultant and per client (tokenized URL, revocable).
- **Meetings** (light): log calls and meeting notes on the client timeline; a "Book a call" link can point to Cal.com or Calendly.

### 5.8 Messages

- A thread per client, with the option of threads per deliverable or opportunity. Attachments go to the vault.
- Email notification with a "Reply in portal" link. **v1 does not handle email replies**. v2 may use Resend inbound or Cloudflare Email Routing.

### 5.9 Settings

- Brand (§8), email sender, domain
- Team and roles
- Integrations: OpenGrants, Workers AI (on/off), Cal.com link, webhook out (Zapier/Make)
- Security: session length, require passkeys for staff, client link expiry, IP allowlist for staff (optional), data retention
- Data: export everything (ZIP of JSON + files), delete a client (hard delete including R2 objects, logged)

---

## 6. Client portal: features

The client portal should feel like a quiet, well-kept folder that the consultant keeps up to date. Every screen answers **"What do you need from me?"** and **"What's happening with my funding?"**

### 6.1 Sign in

- Branded login screen: consultant logo, firm name, welcome line, and one email field.
- "Check your email" state with the sender name and a **6-digit code** shown as a fallback. The email includes the link and the code, so the client can sign in on a different device from the one that opened the email.
- If the email is unknown, the response is the same. **No account enumeration.**

### 6.2 Home

- **Needs your attention**: uploads requested, approvals waiting, questions from the consultant, opportunities to answer (Pursue / Not now).
- **Coming up**: next deadlines.
- **Latest from [Consultant name]**: most recent update or report.
- **Your funding pipeline**: a simple progress view.

### 6.3 Documents

- Checklist of requested items, each with drag-and-drop upload, status, and due date.
- The shared vault (view and download what the consultant shared, upload new files).
- Upload UX: multi-file, resumable for large files (R2 multipart), per-file progress, and a clear "Received ✓" confirmation. Allowed file types can be set, and the default covers docs, spreadsheets, PDFs, and images.

### 6.4 Reports & opportunities

- Read reports. Mark each opportunity Pursue / Not now / Ask a question.

### 6.5 Deliverables

- View drafts, compare versions, approve, or request changes with comments.

### 6.6 Messages

- A simple thread with the consultant.

### 6.7 Profile & team

- Update org info when the consultant allows it, invite a colleague (Client Admin only), and set notification preferences (instant / daily digest / weekly digest).

---

## 7. Security model

### 7.1 Magic link authentication (clients and staff)

**Flow**

1. Client submits an email. **Turnstile** (invisible) validates the request, and the email and IP are rate-limited (KV counters: 5 per hour per email, 20 per hour per IP).
2. The server generates a **256-bit random token** and a **6-digit code**. It stores only `SHA-256(token)` and `SHA-256(code + per-request salt)` in D1, together with email, `expires_at` (15 min), `request_ip_hash`, `user_agent_hash`, and `used_at`.
3. The email contains a link `https://portal/auth/verify?t=<token>` and the code.
4. **The link-scanner problem.** Corporate email security (Microsoft Safe Links, Mimecast, Proofpoint) opens links before people do, and a naive GET-to-login flow would burn the token. So **GET only renders an interstitial**: "Sign in to Acme Grants as jane@org.org → [Continue]". The **POST** consumes the token. Scanners don't POST.
5. Consuming the token is **single-use and atomic**: `UPDATE … SET used_at = now WHERE token_hash = ? AND used_at IS NULL AND expires_at > now`, then check rows affected.
6. **Code entry**: up to 5 attempts per request, after which the request is invalidated.
7. On success, the server creates a session.

**Sessions**

- Opaque session ID (256-bit) in a cookie: `__Host-session`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`.
- The session row in D1 stores a hash of the ID, the user, created and last-seen times, IP and UA hashes, and an absolute and idle expiry.
- Defaults: **clients** 30-day absolute and 7-day idle; **staff** 12-hour idle and 14-day absolute, with step-up re-auth for sensitive actions (export, delete, settings).
- "Sign out everywhere" is available to users, and staff can revoke any client session.
- Sessions rotate on privilege changes.

**Staff hardening**

- **Passkeys (WebAuthn)** for Owner and Consultants, prompted after the first magic-link sign-in. The Owner can make them mandatory.
- The Owner can restrict staff sign-in to an email domain.

### 7.2 Web security baseline

- **CSRF**: `SameSite=Lax` cookie + `Origin` header check on all state-changing requests + double-submit token for form posts.
- **CSP**: strict, nonce-based, no inline scripts, `frame-ancestors 'none'`. Brand assets are served same-origin (logos are uploaded, never hot-linked).
- **Headers**: HSTS (includeSubDomains, preload-ready), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` minimal.
- **Input**: Zod validation on every API route. Rich text is sanitized server-side against an allowlist.
- **Uploaded brand assets**: SVG logos are sanitized (or rasterized) before being served, to block script injection through SVG.

### 7.3 Authorization

Every API query is scoped by **org and role in middleware**, not in the handlers. Client users can only reach rows where `client_id ∈ their memberships`. A test suite checks every route for cross-client access (IDOR).

| Capability | Owner | Consultant | Client Admin | Client Member |
|---|---|---|---|---|
| Settings, brand, integrations | ✅ | – | – | – |
| Team management | ✅ | – | – | – |
| All clients | ✅ | Assigned only (Owner can grant all) | – | – |
| Reports / deliverables / schedules | ✅ | ✅ (assigned) | View + respond | View + respond |
| Upload documents | ✅ | ✅ | ✅ | ✅ |
| Delete documents | ✅ | ✅ | Own uploads, within 24h | Own uploads, within 24h |
| Invite client users | ✅ | ✅ | ✅ (own org) | – |
| Export / delete client data | ✅ | – | Request only | – |

### 7.4 Files

- R2 keys are **random, not guessable**: `clients/{clientId}/{uuid}`. The original filename is kept in D1 only.
- No public bucket access. Downloads go through the Worker with an authorization check and are streamed. Links in email go to the portal page, never straight to a file.
- `Content-Disposition: attachment` by default. Inline preview only for safe types (PDF, images), served with `Content-Type` set strictly and a sandboxed CSP.
- **Size limits** can be set (default 100 MB per file). Multipart upload handles large files.
- **Malware scanning**: v1 has a pluggable scanner hook (queue job) with a documented integration point. Uploads show "Scanning…" and files are quarantined until the scan clears when a scanner is configured. Default: no scanner, with a clear note in the security docs.
- **Checksums**: SHA-256 stored per version.

### 7.5 Sensitive data

- **EIN, bank details, SSNs** (if any consultant chooses to collect them): encrypted at the app level with **AES-GCM**. The key is derived from a `DATA_ENCRYPTION_KEY` secret, If that secret is absent, a key is generated on first run and stored in KV, and the Owner sees a guided prompt to move it into a Worker secret. The same pattern is used for `SESSION_SECRET`. The field is masked in the UI (last 4) and revealing it is logged.
- **Optional per-file envelope encryption** (Owner setting, off by default because it blocks server-side previews and AI summaries): each file gets a random DEK, wrapped by the master key.
- **Audit log**: append-only table of security-relevant events (sign-ins, failed codes, exports, deletes, reveals, permission changes, file downloads). Visible to the Owner and exportable.
- **Retention**: configurable auto-purge of archived clients after N months, with a notice to the Owner beforehand.

### 7.6 Email security

- The sending domain has SPF, DKIM, and DMARC set by the wizard (Resend supplies the records, and the wizard recommends `p=quarantine` once stable).
- Resend webhooks for bounces and complaints are verified by signature. Hard bounces suppress sends to that address and flag the contact.
- Magic-link emails are plain, text-first, and carry no tracking pixels or click tracking, which keeps deliverability high and preserves privacy. Marketing-style updates can enable tracking per consultant choice.

### 7.7 Threat model summary (v1)

| Threat | Mitigation |
|---|---|
| Account takeover through a leaked or forwarded magic link | 15-min expiry, single use, POST consumption, session list + revoke, new-device notification email |
| Email enumeration | Identical responses and timing for known and unknown emails |
| Brute-forcing the 6-digit code | 5 attempts per request, rate limits per email and IP, Turnstile |
| One client reading another client's data (IDOR) | Middleware scoping + automated cross-tenant tests |
| Malicious upload (XSS via HTML/SVG) | Download as attachment, strict content types, no inline rendering of HTML/SVG, sanitized logos |
| Stolen staff session | Short idle timeout, passkeys, step-up for sensitive actions |
| Compromised consultant GitHub fork | Out of scope. Documented: protect the GitHub account with 2FA, since pushes to `main` deploy. |
| Supply chain | Lockfile, Renovate/Dependabot, minimal dependencies, signed releases |

---

## 8. White-label theming

### 8.1 Brand settings

- Firm name, short name (for tight spaces), logo (light), logo (dark), mark/icon, favicon (auto-generated from the mark)
- **Accent color.** The system builds a full accessible palette from it: tints, shades, an on-accent text color, and focus rings. It checks **WCAG AA contrast** and nudges the color if it fails.
- Optional secondary color, and neutral temperature (cool / neutral / warm grays)
- Typeface: pick from a vetted set (a clean sans for UI plus an optional serif for headings), all self-hosted with no Google Fonts call. Consultants can upload a WOFF2 file.
- Corner radius (Sharp / Soft / Round) and density (Comfortable / Compact)
- Login screen: layout (Centered card / Split with image), optional background image or subtle generated pattern, welcome headline and subtext
- Email: header style, footer text, physical mailing address (CAN-SPAM), reply-to
- PDF: cover page style for reports

### 8.2 How theming works

- Tokens are stored in D1 and served as `/brand/theme.css`, which sets CSS custom properties. It's cached in KV and at the edge, and purged when the brand changes.
- All components use only semantic tokens (`--color-accent`, `--color-surface-raised`, `--radius-md`, …). No hardcoded colors.
- Dark mode is supported on both surfaces. The consultant brand supplies accent and logo variants, and the system handles the rest.
- `manifest.webmanifest`, OG image, and favicon are generated per brand so a shared link previews with the consultant's brand.
- **Zero maintainer marks**: no "Powered by" by default. An optional, off-by-default "Powered by" footer toggle exists for people who want to credit the project.

---

## 9. Email system

- An adapter interface (`send`, `sendBatch`, `verifyDomain`, `parseWebhook`) with **Resend** as the default implementation. Cloudflare Email Service can be a second adapter later.
- Templates are built with **react-email**, themed with the consultant's brand tokens, and render cleanly in Outlook.
- Template set: magic link, invite, new-device sign-in, document request, reminder, deliverable ready for review, deliverable approved, new message, funding report, scheduled update, digest (daily or weekly), alert matches.
- **Sending pipeline**: API → Queue → consumer sends through Resend → delivery status saved via webhook → shown on the client timeline ("Delivered Mon 9:02am").
- **Digests** respect each recipient's preference and timezone (stored per user and defaulting to the consultant's timezone).
- **Unsubscribe**: one-click `List-Unsubscribe` for non-transactional mail. Transactional mail (sign-in, requested documents) is always sent.

---

## 10. OpenGrants integration (optional)

### 10.1 What it adds

| Feature | Without key | With key |
|---|---|---|
| Add opportunities to reports | Manual / CSV | Search + one-click add with full data |
| Match to client | – | Profile-based matching with fit scores |
| Funder research | – | Funder lookup and profile |
| Recurring funding alerts | – | Saved searches per client on a schedule |
| Deadline data | Manual | Pulled from the listing and kept in sync |
| Eligibility hints | – | Eligibility check against the client profile |

### 10.2 Integration facts (from OpenGrants, verified Sept 2026)

- Public REST API with an OpenAPI spec, docs at `https://ops.opengrants.io/api-docs`. There's also a hosted MCP server at `https://mcp.opengrants.io/mcp`.
- Capabilities exposed: grant search, funder search, contract search, matching, eligibility checks, and funding alerts.
- Coverage: federal (Grants.gov, SAM.gov, SBIR/STTR), state and local, private foundations, and corporate giving, refreshed daily.
- Access tiers: the $9/month subscription includes limited API access (**25 requests/day**). The Developer plan ($299/month or $239/month billed annually) is intended for real API use. **The integration has to work within 25/day for small consultancies** (see §10.4).

### 10.3 Implementation

- `integrations/opengrants/client.ts` is generated from the OpenAPI spec (typed). Endpoint mapping is settled against the live spec during build and isn't assumed in this document.
- The key is stored as the `OPENGRANTS_API_KEY` Worker secret, or set later in Settings. In that case it's stored encrypted in D1 using the data key.
- **Client profile → OpenGrants profile mapping**: org type, geography, focus areas, budget band, and funding types feed the match queries. One mapping lives in one file, so it's easy to extend.
- Saved opportunities keep the **OpenGrants ID** and **source URL**, so deadlines can refresh and the listing link survives.

### 10.4 Request budget & caching

- **Budget meter** in Settings shows requests used today against the plan limit (the limit is set in config and detected from response headers where available).
- **KV cache**: search results for 6h, grant detail for 24h, funder detail for 7d. Identical searches across clients hit the cache.
- **Alert runs are batched**: one run per client per schedule, spread across the day by the cron dispatcher so they don't burst.
- **Low-budget mode** (automatic below 20% remaining): recurring alerts pause until reset, and interactive search keeps working.
- Failures degrade gracefully: the report builder falls back to manual entry and shows a notice.

### 10.5 Attribution

Opportunity data from OpenGrants carries a small "Source: OpenGrants" line inside **consultant-only** views. Client-facing views show the **original funder listing** as the source. Whether any attribution is required in client-facing output depends on the OpenGrants API terms and needs confirming (§16).

---

## 11. Data model (D1)

Core tables are listed below. All IDs are ULIDs, timestamps are UTC epoch ms, and there are soft-delete columns where noted.

```
settings            (key, value_json)                                 -- brand, email, security, integrations
users               (id, email UNIQUE, name, kind[staff|client], role, timezone, notif_prefs_json,
                     passkey_required, created_at, disabled_at)
passkeys            (id, user_id, credential_id, public_key, sign_count, transports, created_at, last_used_at)
magic_links         (id, email, token_hash, code_hash, code_salt, attempts, expires_at, used_at,
                     ip_hash, ua_hash, purpose[signin|invite|setup])
sessions            (id_hash, user_id, created_at, last_seen_at, idle_expires_at, abs_expires_at, ip_hash, ua_label)
clients             (id, name, legal_name, status, ein_enc, entity_type, ntee, geography_json, budget_band,
                     fye_month, mission, programs_json, focus_tags_json, funding_goals_json, owner_user_id,
                     created_at, archived_at)
client_members      (client_id, user_id, role[admin|member])
staff_assignments   (client_id, user_id)
opportunities       (id, client_id, source[manual|opengrants], og_id, title, funder_name, url, amount_min,
                     amount_max, deadline_at, eligibility_notes, data_json, stage, created_at)
reports             (id, client_id, title, intro_md, status[draft|scheduled|sent], sent_at, schedule_id)
report_items        (report_id, opportunity_id, position, note_md, tag, client_response, client_comment)
deliverables        (id, client_id, opportunity_id, title, side[consultant|client], assignee_user_id,
                     due_at, status, template_id, created_at)
deliverable_versions(id, deliverable_id, file_id, version, note_md, created_by, created_at)
approvals           (id, deliverable_version_id, user_id, decision[approved|changes], comment, created_at)
doc_requests        (id, client_id, title, due_at, reminder_policy_json, status)
doc_request_items   (id, doc_request_id, label, required, file_id, fulfilled_at)
files               (id, client_id, r2_key, filename, mime, size, sha256, folder, tags_json, expires_at,
                     scan_status, uploaded_by, created_at, deleted_at)
forms               (id, title, schema_json)          form_responses (id, form_id, client_id, answers_json, submitted_at)
schedules           (id, client_id, kind[update|report|alert|reminder], rrule, next_run_at, config_json,
                     requires_review, enabled)
alerts              (id, client_id, query_json, schedule_id, last_run_at, last_result_ids_json)
emails              (id, to_user_id, template, subject, resend_id, status, error, created_at, delivered_at)
messages            (id, client_id, thread_ref, author_user_id, body_md, attachments_json, created_at, read_by_json)
events              (id, client_id, actor_user_id, type, payload_json, created_at)   -- timeline
audit_log           (id, actor_user_id, action, target, ip_hash, meta_json, created_at) -- append-only
```

Indexes cover `(client_id, due_at)`, `(client_id, created_at)` on events, `schedules(next_run_at, enabled)`, `magic_links(token_hash)`, and `sessions(id_hash)`.

---

## 12. Jobs & scheduling

- **Cron `*/15 * * * *`**: finds `schedules` rows with `next_run_at <= now`, enqueues one job each, and advances `next_run_at` (RRULE evaluation). Also enqueues due reminders.
- **Cron daily `0 13 * * *`** (UTC; per-recipient timezone handled in the consumer): digests, expiry warnings, cleanup (expired magic links and sessions), and the OpenGrants deadline refresh.
- **Queue consumer**: idempotent jobs keyed by `(schedule_id, run_at)`. Retries use backoff, and a dead-letter entry surfaces in the Owner's "System" panel.
- **Review gate**: when `requires_review` is set, the job builds a draft and notifies the consultant instead of sending.

---

## 13. Quality bar

- **Performance**: client portal home is interactive in under 1.5s on a mid-range phone over 4G, SPA JS stays under 200 KB gzipped for the client route tree, and API p95 is under 150ms at the edge.
- **Accessibility**: WCAG 2.2 AA across both surfaces, fully usable by keyboard, screen-reader-tested flows for sign-in, upload, and approve.
- **Testing**: Vitest + `@cloudflare/vitest-pool-workers` for API and authz, Playwright for the critical paths (deploy smoke test, sign-in, upload, approve, report send). A **"deploy from zero" CI job** runs the Deploy button flow against a test Cloudflare account on every release, so the 15-minute promise is actually tested.
- **Observability**: Workers Logs + a structured `events` table. An Owner "System" page shows queue health, email failures, and the OpenGrants budget.
- **Docs**: README (button + 3 screenshots + 60-second video), `docs/deploy.md`, `docs/security.md`, `docs/theming.md`, `docs/opengrants.md`, `docs/self-hosting-faq.md`.

---

## 14. Open-source packaging

- **License**: Apache-2.0 is recommended (explicit patent grant, friendly for consultancies using it commercially). MIT is the simpler alternative.
- **Repo**: `github.com/<opengrants-org>/grant-portal` (name TBD) with the Deploy button at the top of the README.
- **README structure**: one-line pitch → Deploy button → 3 screenshots (branded login, consultant home, client home) → "What you need (5 min): a Cloudflare account + a free Resend key" → feature list → security summary → OpenGrants section → contributing.
- **Community**: CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md (private disclosure address), issue templates, and a `good first issue` backlog seeded at launch.
- **Demo**: a public read-only demo instance with a fictional consultancy brand, reset nightly.

---

## 15. Roadmap

**v0.1 Foundation (MVP)**
Deploy button + wizard · brand theming · magic-link and passkey auth · clients & profiles · document requests + vault · deliverables with approvals · messages · manual opportunities & reports · scheduled updates & reminders · Resend adapter · audit log.

**v0.2 Funding intelligence**
OpenGrants integration (search, match, funder lookup, alerts, deadline sync) · recurring reports with review gate · request budget meter · PDF export.

**v0.3 Practice tools**
Deliverable templates · intake form builder · pipeline board across clients · ICS feeds · Cal.com link · outbound webhooks.

**v0.4 Intelligence (optional, Workers AI)**
Summarize uploaded docs · extract profile fields from 990s · draft report intros in the consultant's voice (always editable, never auto-sent).

**v1.x Later**
Inbound email replies · malware scanning adapter · Cloudflare Email Service adapter · multi-tenant mode for agencies (Cloudflare for SaaS custom hostnames) · post-award compliance tracking.

---

## 16. Open questions

1. **Product name and repo name.** It needs a neutral, unbranded-feeling name that still works as an open-source project name.
2. **OpenGrants API terms for white-label use.** Is attribution required in client-facing output? Is redistributing listing data inside a consultant's portal allowed on the $9 tier, or only on Developer?
3. **Empty-secret handling on the Deploy setup page** (§3.2 caveat). Test before launch.
4. **Resend free-tier limits vs. consultant volume.** Document expected monthly email volume per 25 clients so consultants know when they'll need a paid plan.
5. **Data residency.** Some clients (government-adjacent) may ask. Document D1 location hints and R2 jurisdictional buckets as an advanced option.
6. **Relationship to OpenGrants Whitelabel ($299/mo).** Position this open-source portal as the consultant-practice tool and Whitelabel as the discovery product for EDOs and incubators, so they complement rather than cannibalize each other.
7. **Default reminder cadences.** Validate with 3–5 working consultants before locking defaults.

---

## Appendix A: Sources

- Cloudflare, *Deploy to Cloudflare buttons*: https://developers.cloudflare.com/workers/platform/deploy-buttons/
- Cloudflare changelog, *Deploy buttons support environment variables and secrets*: https://developers.cloudflare.com/changelog/post/2025-07-01-workers-deploy-button-supports-environment-variables-and-secrets/
- Cloudflare changelog, *Automatic resource provisioning for KV, R2, and D1*: https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/
- Resend, *403 error using resend.dev domain* (test domain only delivers to the account owner): https://resend.com/docs/knowledge-base/403-error-resend-dev-domain
- OpenGrants developer access & pricing facts (internal verified facts, Sept 2026); API docs: https://ops.opengrants.io/api-docs
