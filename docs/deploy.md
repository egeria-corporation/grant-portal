# Deploying

The full timed walkthrough lands with M6. This page covers what exists today and the manual check for the Deploy button.

## What the Deploy button does with this repo

| Step | Where it comes from |
|---|---|
| Copies the repo into your GitHub/GitLab account | Deploy to Cloudflare |
| Setup page fields `RESEND_API_KEY`, `SESSION_SECRET`, `OPENGRANTS_API_KEY` | `.dev.vars.example`, help text from `package.json → cloudflare.bindings` |
| Creates D1 (`DB`), R2 (`FILES`), KV (`KV`), Queue (`JOBS`) | `wrangler.jsonc` (no account IDs, so they are provisioned for you) |
| Build command `npm run build` | `package.json → scripts.build` (needs no secrets) |
| Deploy command `npm run deploy` = `npm run db:migrate && wrangler deploy` | `package.json → scripts.deploy` |
| Migrations | `scripts/d1-migrate.mjs --remote` applies `migrations/` to the `DB` binding; it creates the database first if it does not exist yet (plain CLI deploys) |
| Cron triggers `*/15 * * * *`, `0 13 * * *` | `wrangler.jsonc → triggers` |

## Manual Deploy-button test (M0)

Run on a Cloudflare account that has **no** existing `grant-portal-*` resources, ideally a fresh one. Start a stopwatch at step 1.

1. Make `egeria-corporation/grant-portal` **public** (the button does not support private repos), or push to another public repo and update `README.md` to match.
2. Open `https://deploy.workers.cloudflare.com/?url=https://github.com/<you>/<repo>` in a private window.
3. Sign in to Cloudflare and authorise GitHub.
4. On the setup page, check:
   - [ ] exactly three secret fields are shown, with the help text from `package.json`;
   - [ ] resource names default to `grant-portal-db`, `grant-portal-files`, a KV namespace, and `grant-portal-jobs`.
5. Paste a Resend key. **Leave `SESSION_SECRET` and `OPENGRANTS_API_KEY` blank.**
   - [ ] Record whether the page accepts a blank `SESSION_SECRET` (spec §16 open question 3). If it refuses, paste `openssl rand -hex 32` and note it in the report.
6. Click **Create and deploy**. Watch the build log:
   - [ ] `npm run build` succeeds (no secrets needed);
   - [ ] `npm run deploy` prints the migrations table with `0000_init.sql` and `0001_audit_log_append_only.sql` ✅;
   - [ ] `wrangler deploy` succeeds and prints a `*.workers.dev` URL.
7. Open `https://<worker>.<subdomain>.workers.dev/healthz`:
   - [ ] `{"status":"ok", …, "checks":{"db":"ok"}}` with HTTP 200.
8. Open the root URL:
   - [ ] "It works" page, "All systems ready";
   - [ ] no product name in the tab title or page;
   - [ ] DevTools → Network → document response has a `Content-Security-Policy` header with a `nonce-…` and no console CSP errors.
9. Dashboard → Workers → your worker → Settings:
   - [ ] bindings DB, FILES, KV, JOBS, ASSETS present; cron triggers listed; queue consumer attached.
10. Dashboard → Storage & Databases → KV → your namespace:
    - [ ] keys `sys:genkey:SESSION_SECRET:…` and `sys:genkey:DATA_ENCRYPTION_KEY:…` exist (generated on the first request because the secrets were blank).
11. Push a trivial commit to `main` in the copied repo:
    - [ ] Workers Builds redeploys; migrations report "No migrations to apply".
12. Stop the stopwatch at step 8. Record the time and anything that needed a manual fix.

## Updates from upstream

The copied repo includes `.github/workflows/sync-upstream.yml`. For it to open pull requests you may need to enable **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests**. Updates that change files under `.github/workflows/` need a `SYNC_TOKEN` secret (fine-grained token with Contents, Pull requests, and Workflows read/write).
