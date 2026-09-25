# Decisions

Choices made where the spec is silent, or where the build prompt and spec disagree. Grouped by milestone.

## M0

### D-001 Spec and design locations
The spec shipped as `grant-portal-spec.md` at the repo root and the design as `Design.html`. Both moved: `docs/SPEC.md` and `docs/design/Design.html`. `Design.html` is a self-unpacking bundle (six boards, gzip+base64). The readable board HTML, with fonts stripped, is extracted to `docs/design/boards/` so it can be diffed and grepped. The design covers the design system (foundations, type/shape/density, three sample firms, components). It has no full-screen mocks, so screens will be composed from these components plus spec §5–§6.

### D-002 Only three secrets on the Deploy setup page (prompt/spec conflict; spec wins)
The build prompt asks for `TURNSTILE_SECRET_KEY` in `.dev.vars.example`. Spec §3.2 caps the setup page at three secrets. `.dev.vars.example` therefore lists `RESEND_API_KEY`, `SESSION_SECRET`, and `OPENGRANTS_API_KEY`. Turnstile is configured in the wizard/Settings, with the site key and secret stored encrypted in D1. A `TURNSTILE_SECRET_KEY` / `TURNSTILE_SITE_KEY` Worker secret or var is still honoured if present (documented as an advanced option). Dev uses Cloudflare's always-pass test keys. Production without keys shows the Owner an "Add Turnstile" notice and relies on the KV rate limits.

### D-003 Generated-secret fallback is KV-stored but D1-arbitrated
Spec §3.2/§7.5: when `SESSION_SECRET` / `DATA_ENCRYPTION_KEY` are absent, generate them on first boot and store them in KV. KV is eventually consistent (up to ~60 s across locations) and has no compare-and-set, so two concurrent cold starts could mint different keys. For the data key that would make encrypted fields unrecoverable. The flow:

1. Generate a key and a random key id, and `KV.put("sys:genkey:<name>:<id>")`.
2. `INSERT OR IGNORE` the id into D1 `settings`. The first writer wins atomically.
3. Read back the winning id and load that key from KV, retrying briefly if it isn't visible yet. Losers delete their own KV entry.

The key material stays in KV and never goes into D1, so a D1 export or backup alone does not expose it. D1 only arbitrates which id is canonical. A Worker secret of at least 32 characters always takes precedence. A shorter one is ignored and reported to the Owner.

### D-004 `run_worker_first` covers HTML navigations
The prompt lists `/api/*`, `/auth/*`, `/f/*`, `/brand/*`, `/webhooks/*`. A strict **nonce** CSP (spec §7.2) needs a fresh nonce per HTML response, and static-asset serving can't provide one. So `run_worker_first` is `["/*", "!/assets/*", "!/fonts/*"]`, a superset of the requested list. Hashed build assets are still served directly from the edge. Only navigations and dynamic routes hit the Worker. For those, it fetches `index.html` from `ASSETS`, sets the nonce on every `script`/`style`/`link` tag with `HTMLRewriter`, sends `Cache-Control: no-store`, and adds the full header set.

### D-005 CSP shape
HTML: `default-src 'self'; script-src 'nonce-…' 'strict-dynamic'; style-src 'self' 'nonce-…'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests`. JSON and other non-HTML responses: `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`. React style props go through CSSOM, which CSP does not block, so `'unsafe-inline'` is never needed. Vite's `html.cspNonce` placeholder puts a `<meta property="csp-nonce">` in the page, which Vite's runtime uses for the style and preload tags it injects.

### D-006 Package manager and pinned majors
npm, because the Deploy button and the spec's examples use `npm run`. TypeScript is pinned to 6.0.x because typescript-eslint supports `<6.1`; TS 7 (native) can come in once lint tooling supports it. Vitest is pinned to 4.1.x as a peer of the Workers Vitest integration. Drizzle ORM is 0.45 stable, since 1.0 is still in beta.

### D-007 Org concept
There's an `orgs` table, and `org_id` sits on the top-level tables (`users`, `clients`, `settings`, `schedules`, `audit_log`). Child tables inherit scope through `client_id`. v1 always uses the single org `org_default`, and no code branches on org.

### D-008 Tailwind token naming follows the design, not the spec's example names
Spec §8.2 gives examples like `--color-accent`. The design system, which is the source of truth for visuals, uses `--bg`, `--raised`, `--sunken`, `--text`, `--text2`, `--acc-solid`, `--acc-text`, `--r-card`, and so on. Runtime brand variables use the design names. Tailwind v4's default palette, radii, fonts, and shadows are removed (`--color-*: initial`, …), and only semantic utilities map onto those variables. That way a hardcoded color can't be used by accident.

### D-009 `db:migrate` creates the database when it does not exist yet
`deploy` is exactly `npm run db:migrate && wrangler deploy`, and bindings carry no IDs. From wrangler 4.138's source: `wrangler deploy` auto-provisions a missing D1 database, or binds to an existing database with the configured name. But `wrangler d1 migrations apply DB --remote` fails with "Couldn't find a D1 DB" when the database does not exist yet. The Deploy button provisions resources before the build, so the gap only affects plain CLI deploys. The order still has to work in both cases. So `db:migrate` runs `scripts/d1-migrate.mjs`. It applies migrations to binding `DB`. If wrangler reports the database is missing, it runs `wrangler d1 create <database_name from wrangler.jsonc>` and retries. Migrations still reference the binding, so a renamed database keeps working. Migrations are idempotent because wrangler records applied files in `d1_migrations`, and trigger DDL uses `IF NOT EXISTS`.

### D-010 Sync-from-upstream workflow
`.github/workflows/sync-upstream.yml` runs weekly and on demand. It fetches `vars.UPSTREAM_REPO`, which defaults to a placeholder until the canonical repo exists, and force-pushes `upstream/main` to an `upstream-sync` branch. Then it opens or updates a PR. It no-ops in the upstream repository itself. GitHub's built-in token can't push workflow-file changes, so an optional `SYNC_TOKEN` secret is supported and documented in `docs/deploy.md`.

### D-011 `@cloudflare/vitest-plugin` instead of `@cloudflare/vitest-pool-workers`
Cloudflare renamed the Workers Vitest integration. Its docs say `@cloudflare/vitest-plugin` replaces `@cloudflare/vitest-pool-workers` with an unchanged API and configuration. The old package's last release (2026-08-18) bundles a workerd that rejects our `compatibility_date` of 2026-09-24, so tests could not start. This is the same integration under its current name, not a different tool.

### D-012 Prefixed ULIDs
IDs are ULIDs with a short type prefix (`cli_01J…`, `usr_01J…`). The prefix makes audit entries and logs self-describing. It also stops an ID of one type from being accepted where another type is expected, which is a cheap extra layer against IDOR mistakes. R2 object keys use a random UUID, per spec §7.4.

### D-013 Dev/test detection in the Worker
`isDev(env)` is true when Vite reports `import.meta.env.DEV` (the dev server) or when `APP_ENV` is `development`/`test`. Production builds bake in `DEV=false` and get `APP_ENV=production` from `wrangler.jsonc`, so a missing variable can never switch production into dev behaviour. Dev only relaxes `connect-src` for the HMR websocket and drops `upgrade-insecure-requests`.

### D-014 npm install-script allowlist
npm 11 blocks dependency install scripts unless they're allowed. `package.json → allowScripts` allows only `workerd` and `esbuild`, which both download a platform binary. The allowlist uses names rather than versions, so dependency updates don't silently break installs.

### D-015 Owner guard fails closed until M1
`/api/system/*` sits behind `requireOwner`, which returns 401 for every request until sessions exist in M1. So in M0 the generated-secret banner renders for nobody. It will appear for the Owner once M1 lands.

### D-016 OpenGrants API spec is committed
`https://ops.opengrants.io/openapi.json` (OpenAPI 3.0.3, API v1.2.0, server `https://ops.opengrants.io/functions/v1`, bearer auth) was reachable on 2026-09-24. It's committed at `worker/integrations/opengrants/openapi.json`. It exposes list/get for grants, contracts, and funders, plus `POST /match-grants-api`. The spec has **no** eligibility-check or saved-alert endpoints, so M5 builds "eligibility hints" and "recurring alerts" on top of search/match only, and the UI says so. The typed client is generated from this file in M5.

### D-017 `audit_log` append-only is enforced by the database
Migration `0001` adds `BEFORE UPDATE` / `BEFORE DELETE` triggers that abort. Retention purges and client hard-deletes add audit entries and never remove them. Personal data in audit rows is kept to hashes and IDs, so the log doesn't have to be edited to honour a deletion.

## M1

### D-018 `/auth/*`: GET is a page, POST is the API
`GET /auth/verify?t=…` serves the SPA, which renders the interstitial ("Sign in to Acme Grants as jane@org.org → Continue"). Only `POST /auth/link/consume` spends the token, so link scanners that fetch the URL can't burn it (spec §7.1). The interstitial reads the token once, keeps it in `sessionStorage` for a reload, and removes it from the address bar and history with `history.replaceState`. Every other `/auth/*` endpoint is POST-only.

### D-019 Claiming a portal
The `setup` settings row doesn't exist until the portal is claimed, so `INSERT OR IGNORE` is the first-claimant lock. The Owner row is inserted in the same D1 batch, conditional on the recorded owner id, which makes the claim atomic even with several setup links in flight (tested with six concurrent claims). Two ways to prove ownership:
- **Email.** The setup email always goes out from Resend's shared test sender `onboarding@resend.dev`, which only delivers to the Resend account owner. Only the person holding the Resend account can claim by email, even if that account already has verified domains.
- **Setup code in the Worker logs** (spec §3.3). 60 bits (12 Crockford base32 characters), stored as a salted hash. After 10 wrong attempts it's burned. `POST /api/setup/setup-code` prints a fresh one (rate-limited). It is generated lazily on the first visit to an unclaimed portal and deleted once the portal is claimed.

### D-020 KV rate limits are best-effort; D1 holds the hard bounds
Spec §7.1 asks for KV counters. KV has no atomic increment, so a burst of simultaneous requests can overshoot a limit by the number of racing requests. Every limited action also has an atomic bound in D1: single-use tokens, 5 code attempts per request, and 10 setup-code attempts. Keys are `rl:<bucket>:<HMAC(subject)>:<window>`, never raw emails or IPs. Limits: magic-link request 5/h per email and 20/h per IP (spec). Code entry is 30/h per IP, link peek/consume 60/h per IP, setup 10/h per IP, and passkey ceremonies 60/h per IP. KV writes happen only on these endpoints, which keeps well inside the free-plan write quota.

### D-021 Turnstile without keys (amends D-002)
With no keys configured, requests aren't challenged, in dev and production alike. Production shows the Owner an "Add Turnstile" notice, and the rate limits still apply. D-002 said dev would use Cloudflare's always-pass test keys by default. Doing that would load the external script in every local run and in E2E, so dev now starts with Turnstile off. Cloudflare's documented test secrets (always-pass / always-fail) are verified locally without a network call, which keeps tests hermetic. An unreachable siteverify fails closed.

### D-022 Enumeration safety: sign-in email work happens after the response
`POST /auth/magic/request` checks Turnstile and the rate limits (identical for every address), then answers `202 {"ok":true}`. The user lookup, token creation and send run in `waitUntil`, so response content and timing don't depend on whether the account exists. Unknown addresses get no email and leave no row. It uses `waitUntil` rather than the Queue because sign-in email latency matters; the Queue pipeline (M4) is for everything else. Code checks for unknown emails do the same hashing work as real attempts and return the same `code_invalid`.

### D-023 Link lifecycle details
- A new request supersedes the same email's outstanding requests of the same purpose, so only the latest link and code work.
- The 5th wrong code invalidates the whole request, link included (spec: "the request is invalidated").
- Codes are drawn by rejection sampling, so there's no modulo bias.
- Neither the code nor the token appears in the email subject (lock-screen previews). Only `SHA-256(token)` and `SHA-256(code + salt)` are stored.

### D-024 M1 email templates are plain TypeScript, text-first
Magic-link, setup, invite and new-device emails live in `worker/email/templates/`. They render the same blocks to text and minimal HTML, with no images, tracking or remote resources (spec §7.6). The branded react-email set (spec §9) arrives in M4 and replaces the HTML part; the text part stays the reference.

### D-025 New-device detection
A random `__Host-device` cookie (HttpOnly, 400 days) identifies a browser. Its hash is stored per user in `user_devices`. A sign-in from a browser the user hasn't used before sends the new-device email, except on the very first sign-in, which is account creation, not a new device. The alternative, a heuristic on IP and UA, would email people every time their IP changes.

### D-026 Sessions and step-up
- The stored session key is plain SHA-256 of the 256-bit cookie value, not an HMAC. Rotating `SESSION_SECRET` therefore doesn't sign everyone out, and the ID's entropy already makes it unguessable.
- IPs are stored as `HMAC(SESSION_SECRET, ip)`. The User-Agent is stored only as a coarse label ("Chrome on macOS").
- Each session also gets a `public_id` (`ses_…`) used by the session list and revoke. The cookie value and its hash never leave the server.
- `last_seen`/idle expiry is refreshed at most every 5 minutes, which limits D1 writes.
- Step-up: a magic-link, code or passkey sign-in stamps `step_up_at`, and so does a passkey assertion on an existing session. `requireStepUp(30 min)` guards security settings (Turnstile, passkey policy) and passkey removal. Export and delete gain it in M6.
- Sessions rotate (new ID, same row) on passkey registration and on step-up. Any sign-in revokes the session the browser already had.

### D-027 Copy-link invites only for new accounts
A copyable invite link signs in whoever opens it. For an address that already has an account, that would let staff impersonate a client or colleague, and the audit log would attribute the actions to the wrong person. So:
- A copy-link client invite for an existing client user adds them to the client directly, with no link; they keep signing in with their own email.
- A copy-link team invite for an existing team member is refused.
- Emailed invites to existing users are fine, because the link goes to their inbox.
- The remaining risk is inherent to spec §3.4: whoever receives a copy link for a new account can open it. It's listed in `docs/security.md` → Known limitations.

### D-028 CSRF on every state-changing request
Spec §7.2 asks for an Origin check plus double-submit "for form posts". The SPA makes every write with fetch, so both checks apply to every non-GET request outside `/webhooks/*` (webhooks are signature-verified in M4).
- A missing Origin is rejected, not waved through.
- The Origin must equal the request's own origin exactly.
- The token is a random `__Host-csrf` cookie (not HttpOnly, Secure, SameSite=Lax), echoed in `X-CSRF-Token`. It is set on the first response of any kind.

### D-029 Passkeys
- Discoverable credentials (usernameless sign-in) with **user verification required**, so a passkey counts as a strong factor for step-up.
- Challenges are D1 rows consumed atomically. Registration challenges are bound to the requesting user.
- The RP ID is the request hostname. Passkeys made on `*.workers.dev` don't work on a custom domain, and the wizard's domain step says so.
- Clients can't register passkeys; spec §7.1 scopes them to staff.
- **Require passkeys** (Owner):
  - staff who have a passkey must use it, and a magic link returns `passkey_required`;
  - staff without one can sign in by link but are held on an enrollment screen, and every staff/Owner API answers `passkey_enrollment_required`;
  - the Owner must have a passkey before turning the policy on.
- Lost-passkey recovery is in `docs/security.md`.

### D-030 Team sign-in before the domain is verified
Spec §3.4 says team members sign in "via the setup code or a verified domain". The setup code is single-use and only for claiming, so before the domain is verified the path for a team member is a single-use invite link (72 h), then a passkey for later sign-ins.

### D-031 Wizard scope in M1
- Logo, dark logo and favicon upload wait for the SVG sanitizer in M2. The brand step has firm name, accent, welcome line and a live preview.
- An accent is rejected (422) when neither white nor near-black text reaches 4.5:1 on it. The automatic nudge comes with the M2 ramp generator.
- The OpenGrants key is stored encrypted but not test-called, because each call spends the 25/day budget.
- The Owner "restrict staff sign-in to an email domain" setting (spec §7.1) lands with Settings → Security in M6.

### D-032 Custom domain via the Workers Custom Domains API
With a Cloudflare API token, `PUT /accounts/:id/workers/domains` attaches the hostname. The Worker's service name is inferred from its `*.workers.dev` hostname and can be overridden; the account and zone come from the zone lookup. Without a token the wizard records the hostname and shows the dashboard steps. The token and the OpenGrants key are stored AES-GCM encrypted (`settings:<key>` as AAD), never returned by the API.

### D-033 E2E harness
Playwright runs `vite preview` with `PORTAL_E2E=1`. That uses a separate persisted state directory (`.wrangler/e2e-state`, deleted before each run), so every run is a fresh, unclaimed deploy. It also sets `APP_ENV=development`, so emails go to the local outbox, which the test reads at `GET /api/dev/outbox`. That endpoint checks `APP_ENV` explicitly rather than Vite's `DEV` flag, so no production build can expose it; a test pins this. `PLAYWRIGHT_CHROMIUM_PATH` optionally points at a preinstalled Chromium.

### New dependencies (M1)
`@simplewebauthn/server` and `@simplewebauthn/browser` (spec §4 stack) for passkeys. Nothing else.
