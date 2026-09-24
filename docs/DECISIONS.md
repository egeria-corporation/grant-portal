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
