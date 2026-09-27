# Release checklist

Work through this for every release, top to bottom. Items marked **(CI)** are enforced automatically on every pull request; the rest are manual.

## 1. Code is green

- [ ] **(CI)** `npm run typecheck` and `npm run lint` pass.
- [ ] **(CI)** `npm run build` passes with an **empty environment**, and the bundle budget passes (every client route under 200 KB gzipped).
- [ ] **(CI)** `npm test` passes. That includes:
  - the generated authorization test (every route listed, cross-client checks);
  - the header-set test;
  - the branding grep;
  - email snapshots for the three sample brands;
  - the OpenGrants client-freshness check.
- [ ] **(CI)** `npm run test:e2e` passes: wizard, documents and approvals, the funding report flow, and axe (WCAG 2.1 AA) on every portal and sign-in screen.
- [ ] With an OpenGrants key available: `OPENGRANTS_API_KEY=… npx vitest run --project build tests/build/opengrants-live.test.ts`. It spends 2 requests.

## 2. Deploy from zero

- [ ] Fork the release commit into a clean GitHub account, and deploy it with the **Deploy to Cloudflare** button on a Cloudflare account with no prior resources. Paste only `RESEND_API_KEY`.
- [ ] Time it: the button through the finished wizard stays within spec §3.1's 15 minutes.
- [ ] Claim the portal, run the wizard, verify the sending domain, invite a test client, and sign in as them on a phone.
- [ ] Push a trivial commit to the fork's `main`. It redeploys, and `npm run db:migrate` runs cleanly against the existing database.

## 3. Upgrade path

- [ ] On a deployment of the previous release, merge the `sync-upstream` pull request. Migrations apply, and existing data, sessions and passkeys still work.
- [ ] `migrations/` only adds: no `DROP`, no renames (spec §4, CLAUDE.md).

## 4. Security and privacy

- [ ] `npm audit --omit=dev` has no high or critical advisories, or each one is assessed in the release notes.
- [ ] Dependabot pull requests since the last release are merged or explained.
- [ ] Re-read `docs/security.md` → "Attacker self-review" and "Known limitations" against this release's changes. Update both.
- [ ] Nothing client-facing mentions the project name. Check a sent email, a PDF export, the page title, the favicon and the link preview.
- [ ] `.dev.vars.example` has at most 3 entries (spec §3.2), and `package.json → cloudflare.bindings` help text is current.

## 5. Quality spot checks

- [ ] Lighthouse (mobile, simulated 4G) on the client portal home: Performance ≥ 90 and Accessibility 100. Time to interactive is under 1.5 s (spec §13).
- [ ] Keyboard only: sign in, upload a document, approve a deliverable, and answer a report. Nothing is unreachable, and focus is always visible.
- [ ] A screen reader (VoiceOver or NVDA) run through the same flows.
- [ ] Light and dark mode for the three sample brands. The kitchen-sink contrast test covers the components; eyeball the real screens.

## 6. Docs and publishing

- [ ] `docs/PLAN.md` and `docs/DECISIONS.md` are current. Every new decision has an entry.
- [ ] README screenshots (branded login, consultant home, client home) are retaken if the UI changed.
- [ ] Release notes cover new features, fixes, migrations, security changes, and any manual steps for existing deployments.
- [ ] Tag the release (`vX.Y.Z`) and publish it on GitHub. Tags are signed.
- [ ] If there's a public demo deployment (`DEMO_MODE=1`), update it and check it resets overnight.
