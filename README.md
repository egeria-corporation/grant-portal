# grant-portal

An open-source, white-label client portal for grant consultants. It runs in your own Cloudflare account and shows your brand, not ours.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/egeria-corporation/grant-portal)

> **Status:** early development (v0.1 in progress). Milestone plan: [`docs/PLAN.md`](docs/PLAN.md).

## What you need (5 minutes)

- A **Cloudflare account** (the free plan works to start).
- A **Resend API key** — [resend.com/api-keys](https://resend.com/api-keys). This sends sign-in links and client email.
- A GitHub (or GitLab) account. The Deploy button copies this repository into it so you own your copy and can take updates.

Optional: an **OpenGrants API key** adds grant search, matching, and funding alerts. The portal works fully without it.

## Deploy

1. Click **Deploy to Cloudflare** above and sign in.
2. On the setup page, paste your `RESEND_API_KEY`. Leave `SESSION_SECRET` blank to have one generated on first boot (you'll be reminded to move it into a Worker secret), or paste the output of `openssl rand -hex 32`. `OPENGRANTS_API_KEY` is optional.
3. Cloudflare creates the database (D1), file storage (R2), key-value store (KV), and job queue, builds the app, runs database migrations, and deploys.
4. Open your `*.workers.dev` URL and finish the setup wizard.

Every push to `main` in your copy redeploys automatically. A weekly GitHub Action opens a pull request when upstream has updates (see [Updates](#updates)).

Step-by-step guide with timings: [`docs/deploy.md`](docs/deploy.md).

## Local development

Requirements: Node.js 22+ and npm.

```bash
npm install
cp .dev.vars.example .dev.vars   # optional: fill in what you have
npm run dev                      # SPA + Worker on http://localhost:5173 with local D1/R2/KV
```

`npm run dev` applies database migrations to the local D1 first. Nothing else is required; the Worker generates its own secrets locally when they are blank.

Without `RESEND_API_KEY`, emails aren't sent: sign-in links and codes are printed in the terminal running `npm run dev`. The setup code for claiming the portal is printed there too.

| Command | What it does |
|---|---|
| `npm run dev` | Start the app locally |
| `npm run build` | Production build (needs no secrets) |
| `npm run typecheck` / `npm run lint` | Static checks |
| `npm test` | API and security tests in the Workers runtime, plus build checks |
| `npm run test:e2e` | Playwright end-to-end tests against the production build |
| `npm run db:generate` | Generate a migration after editing `worker/db/schema.ts` |
| `npm run deploy` | Apply remote migrations and deploy with Wrangler |

## Updates

`.github/workflows/sync-upstream.yml` runs weekly (and on demand from the Actions tab). It opens a pull request in your copy with upstream changes. Merging it redeploys through Workers Builds. Database migrations only ever add, so updates are safe to apply.

## Security

Magic-link sign-in with a scanner-safe confirmation step, single-use hashed tokens, passkeys for staff, strict per-request CSP, server-side authorization on every route, encrypted sensitive fields, and an append-only audit log. Details: `docs/security.md` (arrives with M6) and [`docs/SPEC.md` §7](docs/SPEC.md).

Report vulnerabilities privately — see `SECURITY.md`.

## License

Apache-2.0.
