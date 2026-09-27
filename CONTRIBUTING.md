# Contributing

Thanks for helping. This project is a white-label client portal that consultancies deploy to their own Cloudflare account, so a few rules matter more than usual:

- **The Deploy button must keep working from a fresh fork** with only a Resend key pasted. No account IDs in `wrangler.jsonc`. The build must pass with no secrets set.
- **No branding of this project** may appear anywhere a consultant's client could see it: pages, emails, PDFs, favicons, the manifest. `tests/build/branding.test.ts` checks this.
- **Security is a feature.** Every API route declares who may call it in middleware, and `tests/worker/authz.test.ts` must list it. That test fails if a route is missing.
- **OpenGrants stays optional.** Everything must work without `OPENGRANTS_API_KEY`.

`docs/SPEC.md` is the product and security spec. `docs/DECISIONS.md` records choices the spec leaves open. If a change disagrees with the spec, say so in the PR.

## Getting started

```sh
npm ci
npm run dev          # Vite + the Worker with local D1/R2/KV (migrations applied)
```

Open the printed URL. The first visit shows the setup wizard. Locally, emails go to an outbox at `/api/dev/outbox` instead of being sent.

## Before you open a pull request

```sh
npm run typecheck
npm run lint
npm test             # Vitest: worker tests run inside workerd, plus unit and build checks
npm run build        # also checks the 200 KB gzipped per-route budget
npm run test:e2e     # Playwright (Chromium) against the production build
```

All of these run in CI.

## Conventions

- **Stack:** TypeScript strict, Hono, Zod, Drizzle + D1, React + TanStack Router/Query, and Tailwind with semantic tokens only (no hard-coded colours). Use npm, and commit `package-lock.json`.
- **Schema changes:** edit `worker/db/schema.ts`, then run `npm run db:generate` and commit the SQL. Migrations only add; nothing is dropped or renamed without a two-release deprecation.
- **IDs and timestamps:** IDs are ULIDs, and timestamps are UTC epoch milliseconds.
- **HTML:** no `innerHTML` / `dangerouslySetInnerHTML`.
- **New dependencies** need a reason in the PR description. Smaller is better.
- **Commits** use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `chore:`.
- **Tests:** security properties get explicit tests (authorization, token expiry, CSRF, headers). UI changes to the client portal must keep the axe checks in `tests/e2e/workflow.spec.ts` passing.

## Reporting security issues

Please don't open a public issue. See [SECURITY.md](SECURITY.md).

## Code of conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
