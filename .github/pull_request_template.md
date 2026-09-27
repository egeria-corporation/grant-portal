## What and why

<!-- What this changes, and the problem it solves. Link the issue if there is one. -->

## How it was tested

- [ ] `npm run typecheck`, `npm run lint`, `npm test`
- [ ] `npm run test:e2e` (for UI or auth changes)
- [ ] New routes are in `tests/worker/authz.test.ts`

## Checklist

- [ ] Works without `OPENGRANTS_API_KEY` and with an empty environment at build time
- [ ] Nothing client-facing mentions this project's name
- [ ] Schema changes are additive and come with a generated migration
- [ ] New dependencies are explained above
- [ ] Docs / `docs/DECISIONS.md` updated where the spec was silent
