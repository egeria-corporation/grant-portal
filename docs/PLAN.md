# Plan — milestones to v0.1

Status legend: `[x]` done · `[~]` partial/stubbed (see note) · `[ ]` not started.
Each milestone ends with: typecheck + lint + unit + relevant E2E green → conventional commit → report → wait for `continue`.

## M0 — Skeleton that deploys
- [x] `CLAUDE.md`, `docs/PLAN.md`, `docs/DECISIONS.md`
- [x] Move spec to `docs/SPEC.md`, design bundle to `docs/design/` (+ extracted boards)
- [x] `package.json` (npm), TS strict project refs, ESLint flat config
- [x] `wrangler.jsonc`: DB, FILES, KV, JOBS producer+consumer, crons, assets + `run_worker_first`, no account IDs
- [x] `.dev.vars.example` (3 secrets max) + `package.json → cloudflare.bindings` descriptions
- [x] Vite + `@cloudflare/vite-plugin` + React + TanStack Router + Tailwind v4 semantic tokens
- [x] Worker entry exporting `fetch`, `scheduled`, `queue`; Hono app; security headers + nonce CSP on HTML
- [x] Drizzle schema for spec §11 (+ `orgs`, indexes) → first migration
- [x] Secret fallback: generate `SESSION_SECRET` / `DATA_ENCRYPTION_KEY` on first boot (KV, D1-arbitrated), status endpoint + banner component (banner is Owner-gated, so visible from M1; D-015)
- [x] `/healthz`, "It works" SPA route
- [x] Vitest (workers pool) + Playwright smoke test
- [x] README with Deploy button, prerequisites, local dev
- [x] GitHub Actions: CI (typecheck, lint, test, build with no secrets, e2e) + weekly sync-from-upstream PR
- [x] Branding grep test (bundle + email templates)
- [ ] **Manual:** Deploy button run on a fresh account (owner: you — steps in M0 report / `docs/deploy.md`)

## M1 — Auth & first-run wizard
- [x] Magic link request (Turnstile + KV rate limits 5/h/email, 20/h/IP), enumeration-safe response + timing (D-020, D-022)
- [x] Token (256-bit) + 6-digit code; store SHA-256 hashes; 15-min expiry; purpose signin|invite|setup
- [x] GET interstitial → POST consume (atomic `UPDATE … WHERE used_at IS NULL AND expires_at > now`) (D-018)
- [x] Code entry, 5 attempts then invalidate (D-023)
- [x] Sessions: `__Host-session`, hashed IDs, idle/absolute expiry per kind, rotation on privilege change (D-026)
- [x] Session list, revoke, sign-out-everywhere; staff revoke client sessions
- [x] New-device email (D-025)
- [x] CSRF: Origin check + double-submit token; tests (D-028)
- [x] Passkeys (SimpleWebAuthn) register/login for staff; Owner "require passkeys"; step-up (D-029)
- [x] Owner-gated secrets banner (from M0 status endpoint)
- [~] Wizard: Claim (first claimant lock + setup code in logs) → Brand → Email sender (Resend domains + DNS table + verify polling; optional CF API token auto-DNS) → Custom domain → OpenGrants key → Invite team → First client / demo data → "Your portal is live". Logo/favicon upload moves to M2 with the SVG sanitizer (D-031)
- [x] Pre-verification restrictions (§3.4) + single-use 72h copy-invite link (new accounts only, D-027)
- [x] Turnstile config in settings; local test-key verification; "add Turnstile" notice (D-021)
- [x] Vitest: concurrency single-use, expiry, attempts, enumeration, CSRF, cookie flags, generated authz/IDOR over every route, passkeys via a software authenticator
- [x] Playwright: fresh deploy → wizard → Owner signed in → demo client → sign out → sign in with code (D-033)
- [ ] **Manual:** claim a real deployment by email (Resend account address) and by setup code from Workers Logs (owner: you — steps in `docs/deploy.md`)

## M2 — Theming engine & design system
- [x] Brand settings in D1 → `/brand/theme.css` (KV + edge cache; versioned URLs make "purge on change" automatic) (D-035)
- [x] Logo (light/dark), mark, favicon, OG image and heading-font upload in the wizard's Brand step and Settings → Brand (D-037)
- [x] Favicon (uploaded or generated initials), manifest, OG image (uploaded or generated accent card); brand written into `<head>` server-side
- [x] Accent ramp generator (port of design `calc`) + WCAG AA checks + nudge; unit tests across light/dark extremes; exact parity with the design's token table (D-034)
- [x] Radius/density presets, neutral temperature, heading font presets, self-hosted fonts, WOFF2 upload (D-040)
- [x] Light/dark modes with a per-user toggle, rendered server-side from a cookie (D-041)
- [x] `app/ui/` components per `docs/design/boards` (controls, display, documents, lists) over the ported component layer (D-038)
- [x] `/_dev/kitchen-sink` (dev only) × Northwind/Bloom/Evergreen × light/dark (D-042)
- [x] SVG logo sanitization (D-036)
- [x] Automated contrast tests: unit (tokens, every preset combination) + axe on every component in E2E; branding grep still green; literal-color guard

## M3 — Clients, documents, deliverables, messages
- [x] Clients CRUD, profile, EIN AES-GCM (masked, reveal audited behind step-up), statuses, staff assignments (D-054)
- [x] Client members + invites (client admins by email); timeline (`events`) (D-055)
- [x] Document requests + checklist + reminder policy (stored; sending is M4) (D-051)
- [x] Vault: folders, tags, expiry; R2 multipart resumable via Worker; size limit, content-type allowlist, SHA-256, scanner hook + `scan_status` (D-045–D-050)
- [x] Deliverables: versions, approvals, templates with relative due dates (D-052)
- [x] Messages with vault attachments; per-deliverable threads (D-053)
- [x] Workspace screens: Today, Clients, Client detail tabs, Deliverable detail, Doc request composer, Templates
- [x] Portal screens (mobile-first): Home, Documents, Deliverable review, Messages, Profile & team (notification preferences arrive with digests in M4)
- [x] Generated IDOR test over every route, with real cross-client fixtures and body references (D-044)
- [x] Playwright: client uploads 3 docs + approves a deliverable (`tests/e2e/workflow.spec.ts`)

## M4 — Email, schedules, reminders
- [x] `EmailProvider` + Resend adapter; signed webhooks (Svix) → delivery status, suppression, timeline (D-058)
- [x] react-email templates (10 now; funding report and alert matches arrive with M5) themed from brand tokens; auth mail text-first, no tracking; `List-Unsubscribe` one-click for non-transactional (D-057, D-060)
- [x] Cron dispatcher → Queue; idempotent keys in `job_runs`; RRULE subset with time zones; review gate; dead letters → Owner System page (D-061, D-062)
- [x] Scheduled update composer with live blocks (deadlines, opportunities, documents, wins) (D-063)
- [x] Digest preferences + timezone; ICS feeds (tokenized, revocable, access re-checked) (D-059, D-064)
- [x] Tests: schedule advancement, idempotency, review gate, digest batching, bounce suppression, webhook signatures, unsubscribe, ICS
- [x] Email snapshots for 3 brands (`tests/unit/__snapshots__/email/`)

## M5 — Funding reports & OpenGrants
- [x] Manual opportunities, CSV import, report builder, preview toggle, client responses, Pursue → pipeline (+ template) (D-069, D-070, D-073)
- [x] Pipeline board per client and cross-client (D-074)
- [x] `FundingProvider` + OpenGrants impl from generated client; mapping file; KV cache 6h/24h/7d; budget meter; low-budget mode; fallback (D-065–D-067)
- [x] Recurring alerts/reports + review queue; daily deadline refresh (D-071, D-072)
- [x] Branded PDF export (D-068)
- [x] Attribution per §10.5 (D-069)
- [x] Tests with mock provider; live smoke test gated on `OPENGRANTS_API_KEY`
- [x] Email templates: funding report, report response, alert matches (snapshots for 3 brands)

## M6 — Hardening, docs, release
- [ ] Settings > Security (staff email-domain restriction, IP allowlist, session length; D-031); Team page (roles, remove passkeys); audit log viewer/export; data export ZIP; hard delete client; retention purge; step-up on export/delete
- [ ] Header set verified by test
- [ ] Perf budget (client routes < 200 KB gz, build fails otherwise) + Lighthouse
- [ ] axe on every portal screen + auth
- [ ] Docs set + community files + LICENSE (Apache-2.0) + issue templates
- [ ] Demo-mode seed + nightly reset
- [ ] Attacker self-review vs §7.7 → Known limitations
- [ ] Release checklist
