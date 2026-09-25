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
   - [ ] `npm run deploy` prints the migrations table with `0000_init.sql`, `0001_audit_log_append_only.sql` and `0002_auth.sql` ✅;
   - [ ] `wrangler deploy` succeeds and prints a `*.workers.dev` URL.
7. Open `https://<worker>.<subdomain>.workers.dev/healthz`:
   - [ ] `{"status":"ok", …, "checks":{"db":"ok"}}` with HTTP 200.
8. Open the root URL (first-run wizard, M1):
   - [ ] you land on **Claim this portal**; no product name in the tab title or page;
   - [ ] DevTools → Network → document response has a `Content-Security-Policy` header with a `nonce-…` and no console CSP errors;
   - [ ] enter the email you used to sign up to Resend → **Email me a setup link**. The email comes from `onboarding@resend.dev` (see "First-run wizard" below). Open the link → **Continue**;
   - [ ] if no email arrives: **Use the setup code instead**. Dashboard → Workers & Pages → your Worker → **Logs** → find `Portal setup code: XXXX-XXXX-XXXX`;
   - [ ] finish Brand; skip the optional steps; **Load a demo client**; **Your portal is live** → **Go to your workspace**.
9. Dashboard → Workers → your worker → Settings:
   - [ ] bindings DB, FILES, KV, JOBS, ASSETS present; cron triggers listed; queue consumer attached.
10. Dashboard → Storage & Databases → KV → your namespace:
    - [ ] keys `sys:genkey:SESSION_SECRET:…` and `sys:genkey:DATA_ENCRYPTION_KEY:…` exist (generated on the first request because the secrets were blank).
11. Push a trivial commit to `main` in the copied repo:
    - [ ] Workers Builds redeploys; migrations report "No migrations to apply".
12. Stop the stopwatch when the workspace loads in step 8. Record the time and anything that needed a manual fix.

## First-run wizard

| Step | What it does | Needs |
|---|---|---|
| 1. Claim | Makes you the Owner. First person to finish wins; the step then locks. | The Resend account's email, **or** the setup code from the Worker logs |
| 2. Brand | Firm name, accent color (checked against WCAG AA), welcome line, live preview. Logo, fonts and favicon come in Settings → Brand (M2). | — |
| 3. Email sender | Creates your domain in Resend and lists the DNS records (DKIM, SPF, MX, plus a starter DMARC `p=none`). Checks every 15 s. With a Cloudflare API token it can create the records for you. | Optional |
| 4. Custom domain | With a Cloudflare API token, attaches the domain to the Worker. Without one, shows the dashboard steps. | Optional |
| 5. Funding discovery | Stores an OpenGrants key (encrypted). Not validated here, because every call spends the daily request budget. | Optional |
| 6. Invite team | Emails invites once the sending domain is verified; before that, gives you a single-use link valid for 72 hours. | Optional |
| 7. First client | Adds a client (with an invite link for its contact) or loads a demo client that never sends email. | Optional |
| 8. Live | Client sign-in URL, a paste-ready invite email, and the remaining optional tasks. | — |

**Why the claim email comes from `onboarding@resend.dev`.** Resend's shared test sender only delivers to the email address that owns the Resend account. The setup email always goes out from it, so only the person who holds the Resend account (the person who pasted the key) can receive a claim link, even if the account already has verified domains. Anyone else who finds a fresh `*.workers.dev` URL can't claim it by email. The fallback is the setup code in the Worker logs, and only people with access to your Cloudflare account can read those.

**Before your sending domain is verified** (spec §3.4): you and your team can sign in (the Owner through the Resend account email, team members through their invite link and then a passkey). You can build clients. Emailing clients and team members is blocked, with a banner; single-use copy links work instead.

**Cloudflare API token (optional).** Create one under *My Profile → API Tokens* with **Zone · DNS · Edit** and **Account · Workers Scripts · Edit**, limited to your zone and account. It's stored encrypted with the data key. Remove it in Settings once setup is done.

## Updates from upstream

The copied repo includes `.github/workflows/sync-upstream.yml`. For it to open pull requests you may need to enable **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests**. Updates that change files under `.github/workflows/` need a `SYNC_TOKEN` secret (fine-grained token with Contents, Pull requests, and Workflows read/write).
