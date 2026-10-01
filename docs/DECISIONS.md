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

## M2

### D-034 Accent ramp: the design's `calc()`, with accessibility guarantees on top
`shared/theme/ramp.ts` ports `calc()` from `docs/design/boards/01-foundations.html` (OKLCH, gamut clipping). A unit test pins the port against the design's own token table: all four firms (Northwind, Bloom, Evergreen, Custom), light and dark, every token exact. Three deviations from the board's script:
- **Dark hover.** The board's source says `solidh = solid − 0.03`, but its token table (the rendered truth) lightens by 0.04, or darkens by 0.03 when the solid had to go below the brand's lightness. The port follows the table.
- **Contrast is checked on rounded hex.** 8-bit rounding can pull a just-passing shade under 4.5:1 (grey `#777777` on white is 4.48:1). The dark-mode search and a final pass judge the color as it ships.
- **Accent text is checked against every surface.** The board only checks the page background, so dark links on cards could fall to 4.30:1. When the theme builder passes the brand's real surfaces (bg, raised, overlay, sunken, hover) plus the accent's own a50/a100 tints (the "Recommended" pill), accent text reaches 4.5:1 on all of them. The bare call, used by the parity test, is unchanged.

Any accent is accepted. The ramp nudges it and the API reports whether it did (`adjusted`), which supersedes D-031's M1 rejection. The unit test runs 24 hard colors (white, black, yellow, neon green, greys) and every sample brand across all three neutral temperatures, in both modes, against the AA thresholds.

### D-035 Brand delivery: server-injected head and versioned URLs
The Worker writes the brand into every HTML response's `<head>`:
- `theme.css` (nonce'd), the favicon, the manifest, `theme-color`, and the `<title>`;
- `og:*` and Twitter tags (link unfurlers don't run JavaScript);
- `data-theme` from the `theme` cookie, and `class="d-compact"` for the compact density.

Nothing flashes unbranded, and the SPA doesn't patch styles at runtime.

Every brand URL carries `?v=<version>`, where the version is a hash of the brand settings and asset hashes. Changing the brand changes the URL, so "purge on change" (spec §8.2) needs no purge call:
- A request with the current version gets `immutable` for a year. It is served from Cloudflare's edge cache (`caches.default`) without touching D1.
- Rendered CSS and the generated OG card are also kept in KV per version.
- Unversioned or stale URLs get `max-age=60`.

Brand files send `Cross-Origin-Resource-Policy: cross-origin`, because email clients and unfurlers embed them. Everything else stays `same-origin`.

### D-036 SVG logo sanitizer
Workers have no DOM, so `worker/brand/svg.ts` is a small allowlist parser:
- It rejects DOCTYPE, ENTITY, CDATA and processing instructions other than the XML declaration.
- Unknown elements are dropped with their whole subtree.
- Attributes are allowlisted, and their values are entity-decoded before checking.
- `href` may only point at a fragment, and `url()` only at `url(#id)`.
- Values containing quotes or angle brackets are dropped rather than escaped.
- The output is re-serialized from the parsed tree.

Served SVGs also get `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox` and `nosniff`. A 20-payload XSS corpus is in `tests/unit/svg.test.ts`. Rasterizing was rejected: no canvas in Workers, and a WASM rasterizer would dominate the Worker's size.

### D-037 Brand assets
There are six slots:
- light logo, dark logo, mark, favicon;
- link-preview image;
- heading font (WOFF2).

Handling:
- **Type:** detected from the bytes; the declared `Content-Type` is ignored.
- **Size:** capped per slot (256 KB to 2 MB).
- **SVGs:** sanitized before storage.
- **Storage:** each file gets a random R2 key (`brand/{uuid}`), and the previous object is deleted on replace.

Generated fallbacks:
- **Favicon:** an SVG of the firm's initials on the accent. An uploaded SVG favicon or mark takes its place.
- **`apple-touch-icon`:** emitted only when a PNG mark or favicon exists.
- **Link preview:** without an upload, a 1200×630 PNG card in the accent color. It's produced by a 60-line encoder (zlib via `CompressionStream`, CRC32), not a canvas.

### D-038 Component layer and Tailwind
The boards' shared stylesheet is ported to `app/styles/components.css` as Tailwind's `components` layer, and `app/ui/*` wraps it in typed React components. The port made these changes:
- **Dropped:** board-only demo rules, and helpers that clash with Tailwind utilities (`.row`, `.grow`, `.trunc`, …).
- **Renamed:** `.ring` became `.cd-ring`, because it collided with Tailwind's `ring` utility.
- **Tokenized:** the four literal colors became tokens (`--knob`, `--shadow`).
- **Fixed for AA:** the board's secondary text fell below it in three places. The countdown `.sub` was at 80% opacity, the done-chip subtext sat at 4.48:1 on the success tint, and the danger toast's action was too faint. Each now uses the full-strength status color.

`@theme inline` makes Tailwind utilities reference the semantic variables directly. Without it, `--color-text2: var(--text2)` resolves at `:root`, and a theme scoped to an element (brand previews, the kitchen sink) doesn't reach utility classes. `tests/build/no-literal-colors.test.ts` enforces "semantic tokens only".

### D-039 Status colors are system-wide
The boards vary status hues per sample firm: Northwind's info is teal, Bloom's danger is rose, Evergreen's success is lime. Brands here control the accent, gray temperature, corners, density and heading font. Status colors are the design's default set for every brand, so "overdue" and "approved" read the same in every portal and their AA pairs are tested once.

### D-040 Fonts
Geist, Geist Mono, Source Serif 4 and Newsreader come from `@fontsource-variable/*` (OFL-1.1). They are bundled into `/assets` and served same-origin, with no Google Fonts call (spec §8.1). Heading presets: Sans (Geist), Source Serif and Newsreader. An uploaded WOFF2 becomes the "Uploaded font" preset. Until a font is uploaded, a `custom` heading falls back to Sans.

### D-041 Light and dark
Each user chooses Light, Dark or System with the toggle in the header or sign-in footer, and System is the default. The choice is stored in a plain `theme` cookie (not sensitive, not HttpOnly), so the server renders the right mode on the next load. `theme.css` carries a light `:root`, a `prefers-color-scheme` dark block, and a forced `[data-theme="dark"]` block.

### D-042 Kitchen sink
`/_dev/kitchen-sink?brand=northwind|bloom|evergreen` renders every component in light and dark side by side, each panel themed through the same variables `theme.css` produces. It is code-split, and it renders only when the server reports `devTools` (`APP_ENV` development or test); production shows "Page not found". E2E runs axe's `color-contrast` rule over it for all three brands. It found the D-038 issues and the D-034 tint case.

### D-043 "Powered by" line
Spec §8.2 asks for an optional, off-by-default "Powered by" footer. The no-maintainer-branding rule (CLAUDE.md #3) keeps the product name out of every client-facing surface, so the line says "Powered by open-source software" with no link.

### New dependencies (M2)
- `@fontsource-variable/geist`, `-geist-mono`, `-source-serif-4`, `-newsreader`: self-hosted fonts (OFL-1.1).
- `@axe-core/playwright` (dev only): contrast checks in E2E, and the M6 axe pass.

## M3

### D-044 One client-scoped API for both surfaces
Workspace and portal call the same routes under `/api/clients/:clientId/…`. `requireClientAccess` decides who gets in and records how: `staff`, `admin` or `member`. Handlers then apply row-level rules on top: client users never see internal files, clients decide on consultant deliverables and staff on client ones, and clients delete only their own recent uploads. Every lookup of a row inside a client also filters on `client_id = :clientId`, so an ID from another client is a 404 even for someone who can reach both.

`tests/worker/authz.test.ts` creates real fixtures in two clients, calls every route as every kind of actor, and then calls every nested route with client A's ID and client B's row. It also sends another client's file and deliverable IDs in request bodies (attachments, versions, request items, thread references).

### D-045 Uploads go through the Worker, resumably
Spec §6.3 asks for resumable uploads via R2 multipart, and §7.4 rules out public bucket access. Without R2 API credentials there are no presigned URLs, so bytes pass through the Worker:
- Files up to 8 MiB go as one `PUT`.
- Larger files go as 8 MiB parts of an R2 multipart upload. That stays under Workers' request-body limit and over R2's 5 MiB minimum part size.
- The server records each part in `file_parts`, so a client can ask which parts landed and send only the rest.

Only the uploader can continue or cancel an upload. Uploads abandoned for 7 days are aborted by the daily cron.

### D-046 What may be uploaded
The extension picks a family: PDF, documents, spreadsheets, presentations, images, or archives (archives are off by default). The first bytes must match that family's signature (`%PDF-`, PNG, JPEG, GIF, WebP, HEIC, ZIP/OOXML, OLE, RTF), or be clean UTF-8 text with no markup-looking start for `.txt`, `.md` and `.csv`. The stored `Content-Type` comes from the server's table, never from the browser. HTML, SVG, scripts and executables are never accepted into a vault.

The size limit defaults to 100 MB (spec §7.4). Both limits live in the `files` setting (Owner UI in M6).

### D-047 SHA-256 is computed server-side
Single-request uploads are hashed as they're stored. Multipart uploads can't be hashed incrementally across requests with WebCrypto, so completing one queues a `file.finalize` job. The job streams the object through `crypto.DigestStream` and stores the hash. Downloads send it back in a `Digest` header.

### D-048 Downloads
`/f/:fileId` is the only way file bytes leave R2. It checks access to the file's client, hides internal files from client users, and refuses quarantined files. Every download is written to the audit log (spec §7.5).

Files are served as attachments by default, with a strict type, `nosniff` and `no-store`. `?inline=1` previews PDFs and images only:
- Images get a sandboxing CSP.
- Browsers refuse to render PDFs in a sandboxed document, so PDFs get `default-src 'none'` without `sandbox`. The browser's PDF viewer runs isolated from the page origin.

Filenames use the RFC 6266 `filename*` form.

### D-049 Malware scanning is a service-binding hook
No scanner ships with v1 (spec §7.4). A deployment can bind a Worker service named `SCANNER`. With it bound, new uploads start as `pending`, the finalize job posts the bytes to it, and downloads stay blocked (`409 scan_pending`) until the result is `clean`. Without it, `scan_status` stays `none`. A service binding needs no secret, so the three-secret limit (D-002) holds.

### D-050 Deleting files
A delete removes the R2 object and marks the row deleted. The row stays for the timeline and audit trail; hard deletion of a whole client is M6. Rules:
- Client users can delete their own uploads within 24 hours (spec §7.3).
- A file that is part of a deliverable's version history can't be deleted, because every version is kept (spec §5.5).
- Deleting a file that satisfied a request item reopens that item.

Staff can mark a file internal (`shared_with_client = 0`). Client uploads are always shared.

### D-051 Document requests
Each checklist item holds one file. Uploading again replaces it, and the old file stays in the vault. Staff can send an item back ("Ask again"). A request completes when every required item has a file, and reopens when one is removed.

The reminder cadence is stored per request, defaulting to the spec's example (3 days before, on the due date, 2 days after; open question §16.7). The M4 scheduler sends the reminders.

### D-052 Deliverable versions and approvals
The side that owes a deliverable adds versions; staff can always add for the firm. The other side approves, or asks for changes with a required comment. Rules:
- Only the latest version can be decided.
- Each version gets one decision, enforced atomically with a conditional insert.
- A version is a vault file the client can see, or an `https` link.

Adding a version moves the deliverable to "In review". Approving moves it to "Approved", and a change request moves it back to "In progress". Staff can set any status by hand.

Templates store `{ title, side, offsetDays }` items. Applying one creates the deliverables with due dates relative to an anchor date, usually the grant deadline. No template ships with the app, so there's no invented content.

### D-053 Messages
One thread per client, plus a thread per deliverable (its discussion). Bodies are plain text, stored as typed and rendered as text nodes, never HTML. Attachments are vault files the author can see; staff attachments must be shared with the client. Read positions live in `message_reads`. Message email notifications arrive with the email system in M4.

### D-054 Client profile and EIN
The EIN is encrypted with AES-GCM (the data key, AAD bound to the client), and only the last four digits are shown. Revealing it needs a step-up within 30 minutes and is written to both the audit log and the timeline.

Client users see their org basics, not internal fields (focus tags, funding goals, EIN). Client admins can edit org basics only when staff turn on "let the client update these". Client admins can invite colleagues by email; copy-link invites stay staff-only (D-027).

### D-055 Timeline contents
Events hold IDs and short labels: a filename, a deliverable title, a version number. They never hold message text or file contents. Client sign-ins are recorded on each of the user's clients. Writing an event also updates the client's `last_activity_at` for the client list.

### D-056 E2E runs on one worker
The specs share one local portal, and `wizard.spec.ts` must claim it before `workflow.spec.ts` signs in as its Owner. So Playwright runs with `workers: 1`, and files run in name order.

## M4

### D-057 react-email components, rendered by React
Templates use react-email's components (`Html`, `Body`, `Container`, `Section`, `Text`, `Button`, …) for Outlook-safe table layouts (spec §9). They're rendered with React's own `react-dom/server.edge`, not `@react-email/render`, because that package statically imports Prettier and its HTML plugin, which would add about a megabyte to the Worker for a pretty-print option we don't use.

Every email has a hand-written plain-text part, which is the reference (spec §7.6). Colors come from the brand's light-mode tokens; email clients' dark modes are too inconsistent to target. Only a raster logo is used, because many clients block SVG; otherwise the firm name is set in type. Snapshots for the three sample brands live in `tests/unit/__snapshots__/email/`.

### D-058 Delivery webhooks
Resend signs webhooks with Svix. The portal verifies the HMAC over `id.timestamp.body`, refuses timestamps more than 5 minutes off, and applies each message ID once (KV, 7 days). Status only moves forward (a late "sent" can't overwrite "delivered").

A hard bounce (anything but `Temporary`), a complaint or a Resend suppression sets `users.email_suppressed_at`. Suppressed addresses still get sign-in email and document requests. Everything else is recorded as `suppressed` and not sent, until the person turns email back on in their profile.

The webhook is registered through Resend's API when the sending domain verifies (or from System), and its signing secret is stored encrypted. There's no fourth secret (D-002).

### D-059 Notification categories and preferences
- **Transactional (document requests):** always sent, per spec §9.
- **Activity (new versions, decisions, messages):** right away, daily summary, weekly summary (Mondays), or off.
- **Reminders (document cadence, review nudges, grant deadline countdowns):** on or off.
- **Updates (scheduled client updates):** on or off.

Notifications go to the other side: client users, or the client's assigned consultants (the Owner when none are assigned). The actor is never notified of their own action. Each send is claimed on its notification row before it goes out, so a retried or duplicated job can't send twice. Digests go out at 8:00 in the recipient's time zone. That comes from their browser, falling back to the org default and then UTC.

No notifications are sent until the sending domain is verified (spec §3.4); they're recorded as skipped. Local development sends to the outbox.

### D-060 One-click unsubscribe
Non-transactional mail carries `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058). The URL `/u/<user>.<category>.<hmac>` is signed with the session secret and can only turn that category off.

Mail providers POST to it without cookies, so `/u/*` is exempt from CSRF, like `/webhooks/*`. The same URL, opened in a browser, shows a confirm page.

### D-061 Dispatcher and idempotency
Every 15 minutes the dispatcher claims keys in `job_runs` with `INSERT OR IGNORE` before queueing:
- `${schedule}:${runAt}` for schedule runs;
- `reminder:${request}:${offset}`, `nudge:${version}:${days}` and `countdown:${opportunity}:${days}` for reminders;
- `digest:${user}:${localDate}` for digests.

A slow or repeated cron run can't queue the same work twice, and a schedule's `next_run_at` only moves if it still holds the value that was dispatched. Reminders more than a day late are dropped rather than sent days after the fact.

Queue jobs retry with backoff. After 5 attempts (matching `max_retries`) they're marked `dead` and listed on the Owner's System page, which can re-queue them.

### D-062 RRULE subset
`shared/rrule.ts` implements FREQ=DAILY/WEEKLY/MONTHLY, INTERVAL, BYDAY (with ordinals like `1MO` and `-1FR` for MONTHLY), BYMONTHDAY (1–28, −1), BYHOUR, BYMINUTE and UNTIL. It evaluates them in the schedule's IANA time zone via `Intl`, so "Mondays at 9:00" stays 9:00 across daylight-saving changes; a skipped local time moves past the gap. Anything outside the subset is rejected when the schedule is saved. No RRULE library: the common ones pull in a time-zone database or don't run in Workers.

### D-063 Scheduled updates
An update has a subject, a plain-text message, and a choice of live blocks: deadlines in the next 30 days, opportunities added since the last update, outstanding required documents, and wins (approvals, completed requests and, from M5, awards). Blocks are filled at send time and frozen into the update, so what was sent is what's shown later. An update can be sent now, once at a time, or on a repeating schedule.

With review on (the default, spec §12), a run builds the draft, freezes its blocks, and emails the consultant. The client gets nothing until someone presses Send. Each run makes at most one update, keyed by schedule and run time.

### D-064 Calendar feeds
`/ics/<token>.ics` carries all-day events for deliverable due dates, document request due dates and grant deadlines. Staff feeds also include timed events for scheduled sends. The token is 256 bits and only its SHA-256 is stored. Access is re-checked on every fetch, and feeds are revocable. Staff can make a feed for all their clients or one; client users for their organization.

## M5 — Funding reports & OpenGrants

### D-065 OpenGrants client generated from the committed spec
`scripts/gen-opengrants.mjs` turns `worker/integrations/opengrants/openapi.json` into `client.gen.ts`: one typed function per operation, and nothing else. Responses the spec gives no schema for are typed `unknown`.

`tests/build/opengrants.test.ts` fails if the generated file is stale, or if it calls a path the spec doesn't list (CLAUDE.md #5). To change the client, update the spec and run `node scripts/gen-opengrants.mjs`. No generator dependency: the spec only uses a small subset of OpenAPI.

### D-066 Response mapping is defensive
The committed spec (v1.2.0) types the match request and response, but not the list or detail responses. `mapping.ts` reads them defensively:
- field names come from the spec's own `sort_by` enum and match item;
- wrappers like `data`, `results` or a bare array are all accepted;
- a missing value becomes `null`, never a guess;
- non-http(s) URLs are dropped.

It's the only file that knows OpenGrants field names. If the live API differs, change it there; the live smoke test (`tests/build/opengrants-live.test.ts`, which runs only with `OPENGRANTS_API_KEY` set) will say so.

The client profile → match request mapping also lives here:
- The mission falls back to programs and focus tags.
- The entity type maps to `applicant_type`.
- The budget band's floor becomes `annual_budget_usd`.
- A profile with nothing to match on makes no request.

### D-067 Request budget and cache
Every uncached call counts in KV `og:usage:<UTC date>`. The limit is the `OPENGRANTS_DAILY_LIMIT` var (default 25, spec §10.2). When the API sends `x-ratelimit-limit` / `x-ratelimit-remaining`, those win. The counter is checked before each call, so a request is never made with nothing left. Like the rate limiter (D-020), the counter is best-effort, not atomic.

Responses are cached in KV by a hash of the call:
- search and match: 6 h;
- listing detail: 24 h;
- funder: 7 d.

Identical searches across clients share one request.

Low-budget mode starts below 20% remaining: scheduled alert runs and the deadline refresh pause, while interactive search and "Run now" keep working because a person asked.

Upstream errors map to stable codes (`opengrants_*`). The UI shows a plain notice and offers manual entry (spec §10.4).

### D-068 Branded PDF export
Workers have no headless browser or canvas, and PDF libraries are large. The report PDF comes from a ~400-line writer in `worker/reports/pdf.ts`:
- PDF 1.4, US Letter;
- the standard Helvetica fonts with WinAnsi encoding (no font embedding);
- flate-compressed streams (`CompressionStream`);
- link annotations for listing URLs;
- the brand accent colour;
- the firm's raster logo: JPEG as-is, or an 8-bit non-interlaced PNG decoded to RGB plus an alpha mask. SVG and unusual PNGs fall back to the firm name.

All text is escaped into 7-bit PDF strings. Characters outside WinAnsi become `?`. That's a known limit for non-Latin text; a font-embedding approach can come later if it matters.

The PDF holds only what the client sees: no private notes, no data source, and no product name. `/Producer` is omitted.

### D-069 Opportunity visibility and attribution
An opportunity's stage is `none` (a candidate) until it joins the pipeline:
- Client users see pipeline items, plus candidates that appear in a report they were sent. Consultant notes, the data source and the OpenGrants ID are never in client responses.
- Consultant views show "Source: OpenGrants" (or CSV / by hand).
- Client views, emails and the PDF show the funder's own listing link as the source (spec §10.5). Whether OpenGrants' terms require attribution in client-facing output is still spec §16's open question. The current behaviour is the conservative reading of §10.5.

### D-070 Reports and client responses
- Only drafts can be edited. Sending is a conditional update, so a double click sends once. An empty report can't be sent.
- The client gets a `report` notification in the updates category: one-click unsubscribable, and honoured by the preference.
- Answers come from client users only; staff get 403 `client_users_only`. A question must have text, and is stored on the report item.
- Pursue moves a candidate to Researching. Changing the answer later doesn't move it back: once work may have started, the pipeline is the consultant's to manage.
- Staff are notified of each answer (activity category, so it can be digested).
- The "template offer" is a Plan deliverables button on Researching/Preparing cards with no deliverables. It uses the M3 template endpoint with the deadline as the anchor.

### D-071 Alerts and recurring reports
An alert is a saved search, or a profile match, with an RRULE schedule (kind `alert`). A run keeps only listings it hasn't seen: its own seen list, anything already saved for the client, and anything already queued. The seen list is written only after the results are stored, so a failed run retries in full. Then, by mode:
- `review` (default): new listings go to `alert_matches` for the consultant, who saves or dismisses each. Saving uses the listing data from the match, so it costs no extra request.
- `report`: the run creates the opportunities and a draft report.
  - With review on (the default, spec §5.3), the draft waits and the consultant is emailed.
  - With review off, it's sent.
  - One report per (schedule, run time), so a retried job doesn't make two.

The dispatcher queues at most 3 alert runs per 15-minute tick. The rest stay due, so a dozen Monday alerts spread over the morning (spec §10.4 "don't burst").

### D-072 Deadline refresh
The daily cron re-reads up to 10 saved OpenGrants listings a day. It picks those in Candidates, Researching or Preparing, with a future or missing deadline, oldest refresh first, each at most once per ~20 h. It stops at low budget.

A changed deadline is written and noted on the client's timeline. A listing that no longer exists is left as it is.

### D-073 CSV import
- An RFC 4180 reader, without a dependency.
- Header names are matched loosely (Title/Name, Funder/Agency, Deadline/Due date, Amount/Amount max, Amount min, URL/Link, Eligibility, Notes).
- Dates can be ISO or US `M/D/YYYY`. Amounts accept `$25,000`, `25k` or `1.5M`. URLs must be http(s).
- Valid rows are imported; the rest are reported by line. The limit is 500 rows per import.

### D-074 Pipeline board without drag and drop
Cards move with a stage menu on each card. That works by keyboard and screen reader, on phones, and needs no drag-and-drop dependency. The design's `KanbanCard` look is kept.

## M6 — Hardening, docs, release

### D-075 Settings → Security
The `security` setting holds:
- the passkey requirement;
- staff email domains (subdomains included);
- a staff IP/CIDR allowlist (IPv4 and IPv6, with IPv4-mapped addresses matched as IPv4);
- session lengths: staff idle 1–24 h and absolute 1–30 d; client idle 1–30 d and absolute 1–90 d;
- sign-in link lifetime (5–60 min);
- retention.

Absent fields default to the pre-M6 behaviour, so existing deployments are unchanged. Saving:
- is partial and needs a step-up;
- refuses (422 `would_lock_you_out`) a domain list that excludes the Owner's own address, or an allowlist that excludes their current IP.

Where each rule applies:
- **Domain rule:** checked when sign-in mail is sent (silently, like an unknown address), when a staff invite is created, and when any session starts, passkeys included.
- **IP rule:** checked when a session starts and on every request. An out-of-list staff session is treated as signed out but its cookie is kept, so it works again from an allowed network.
- **Client users:** never restricted by these rules.
- **Session lengths:** apply to new sessions.

Recovery from a lock-out is a documented D1 console statement (`docs/security.md`).

### D-076 Team, audit log, export, hard delete, retention
**Team:**
- Owners change roles and the all-clients flag.
- There's always at least one Owner, and the Owner can't remove themselves.
- A role change revokes that person's sessions, apart from the Owner's current one.
- Removal disables the account, deletes passkeys, feeds and assignments, and revokes sessions. Past work keeps pointing at the (disabled) user.
- Passkey reset deletes all of someone's passkeys and signs them out.
- Every one of these needs a step-up and is audited.

**Audit log:**
- Filterable by action family (`team` matches `team.*`), actor and time.
- CSV export (step-up, audited) prefixes formula-like cells with `'`.
- The log stays append-only. A trigger refuses deletes, so retention **does not** purge it; that's why `auditDays` was dropped during M6.

**Export:** a streamed, stored (uncompressed) ZIP with data descriptors, so files stream from R2 without buffering.
- It contains one JSON file per table, settings with every `*Enc` field stripped, all live files, and brand assets.
- It excludes sessions, sign-in links, passkeys, WebAuthn challenges, device cookies, calendar-feed tokens, notifications, job bookkeeping and `ein_enc` (EINs go out as the last four digits).
- Plain ZIP, not ZIP64: the writer fails rather than produce a broken archive over 4 GiB or 65,535 entries.

**Hard delete:** Owner, step-up, and the client name typed exactly.
- Removes the R2 prefix `clients/<id>/` and the client row, which cascades everything client-scoped, plus invites for the client.
- Client users belonging to no other client are anonymised (`deleted-<id>@invalid`) and disabled rather than deleted, because rows in other tables may still reference them. Their sessions, passkeys, devices, feeds, notifications and sent-email log rows are removed.
- The audit entry keeps the client's name.

**Retention (daily cron):**
- Deleted vault files lose their stored object once older than `deletedFilesDays` (default 30). The row stays so history still shows the file existed. Objects are purged within a 7-day catch-up window, so the job never rescans all of history.
- Sent-email log rows go after `emailLogDays` (default 365).

### D-077 Demo mode is read-only
`DEMO_MODE=1` (a var, off by default and absent from `wrangler.jsonc`) turns a deployment into the public demo from spec §14.
- **Entry:** `POST /api/demo-mode/session` signs a visitor in as a demo consultant (all clients) or a demo client admin, both `@demo.invalid`. It returns 404 when demo mode is off, 409 until the portal is claimed, and is rate-limited per IP.
- **Read-only:** demo accounts get 403 `demo_read_only` on every write except sign-out and switching demo role. The spec says the demo is "read-only", and a writable public instance would let anyone publish content under the consultancy's brand for up to a day.
- **Mail and uploads:** only the Owner's own sign-in mail is sent. Invites are refused, and uploads are capped at 2 MiB.
- **Nightly reset:** hard-deletes every client (with files), ends demo sessions, and re-seeds the sample client.

### D-078 Performance budget and accessibility gates
- **Bundle budget:** `npm run build` runs `scripts/check-bundle.mjs`. For every JS chunk, it adds the gzipped sizes of the entry script, the stylesheet and the chunk's static-import closure, and fails above 200 KB. That's spec §13's route-tree budget, measured without a browser. The heaviest route was 156 KB at M6.
- **Lighthouse:** stays a manual release step (`docs/release.md`); a headless Lighthouse run in CI would be slow and noisy.
- **Accessibility:** the E2E suite runs axe with the WCAG 2.0/2.1 A and AA rule sets on every portal screen and on the sign-in screens. Fixes it forced:
  - inline links are underlined;
  - hidden file inputs are `hidden` and labelled;
  - the scrollable pipeline board is focusable.

### New dependencies (M6)
None.

## Security review fixes

### D-079 Step-up for new credentials and Owner integrations; staff rules on calendar feeds
Found in a pre-release security review.

**Adding a passkey needs a step-up and doesn't give one.**
- A passkey outlives every session, "sign out everywhere" included. Before this, a stolen staff session older than 30 minutes could register the attacker's passkey, get a step-up from doing so, and then export data, delete clients or change the team, keeping the passkey afterwards.
- Both registration calls now need a step-up within 30 minutes. Registration still rotates the session ID, but no longer stamps `step_up_at`: the ceremony proves control of the new authenticator, not of the account.
- There's no exception for a first passkey during required enrollment (D-029). The enrollment screen follows a sign-in, which stamps a step-up. An exception would let a stale gated session, which can do nothing else, unlock full staff access. Someone who waits more than 30 minutes signs in again.
- Every added passkey emails the account (`passkey_added`, sent like the new-device email). The email leaves out the passkey's label, because whoever added the passkey typed it.
- "Sign out everywhere" doesn't remove passkeys or calendar feeds. The spec doesn't ask for it, and removing passkeys by age would be a guess. The email and `docs/security.md` say to remove an unknown passkey or feed on Account & security.

**More actions need a step-up:**
- inviting a consultant, which creates staff access like a role change;
- saving or removing the Cloudflare token, and setting the custom domain, because the token can edit DNS and attach hostnames to the Worker.

The wizard reaches these right after claiming, while the claim's step-up is fresh.

**Staff calendar feeds follow the staff rules.**
- Making one needs the passkey the Owner requires, as every staff API does. Listing feeds does too; revoking one never does.
- Making one also needs a step-up, because the URL outlives the session, as a passkey does.
- Requests from outside the IP allowlist were already treated as signed out, so feeds can't be made from there.
- Every fetch re-applies the passkey requirement and the IP allowlist. Outside the list the answer is 403, not an empty calendar, because an empty feed would look like "no deadlines". The feed isn't revoked: like a session, it works again from an allowed network.
- Trade-off: while an allowlist is set, calendar services that fetch from their own servers (Google Calendar, Outlook.com) can't load staff feeds. Apps that fetch from the device (Apple Calendar, Outlook desktop) work on an allowed network. Making a feed returns `ipRestricted`, and the page explains it.
- Client users' feeds are unaffected (D-075).
- Feeds don't expire, because a calendar subscription can't renew itself. The access re-check, the rules above, revocation, and removal or hard delete bound them instead.
