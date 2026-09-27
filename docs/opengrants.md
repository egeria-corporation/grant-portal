# OpenGrants (optional)

The portal works fully without OpenGrants. You can add opportunities by hand or import a CSV, build and send reports, and run the pipeline.

An OpenGrants API key adds:
- grant and contract search;
- "Match to client", which uses the client profile;
- funder lookup;
- scheduled alerts;
- daily deadline refreshes for saved listings.

## Connect it

Do either of these:
- **At deploy:** paste the key into the `OPENGRANTS_API_KEY` field on the Cloudflare setup page.
- **Later:** as the Owner, open any client's **Funding** tab and paste the key, or use step 5 of the setup wizard. The key is stored encrypted in D1 with the data key.

The key isn't tested when you save it, because every call spends your daily request budget. The first search tells you if it's wrong.

## The daily request budget

Small plans allow a limited number of API requests per day, so the portal is careful with them:

| What | Costs a request? |
|---|---|
| A search or "Match to client" | Yes, unless the same search ran in the last 6 hours |
| Adding a search result to a client | Only if its detail isn't cached (24 hours) |
| Saving a match from the review queue | No: the match already has the data |
| An alert run | One per run |
| The daily deadline refresh | Up to 10 per day, cached per listing |

The limit is the `OPENGRANTS_DAILY_LIMIT` variable in `wrangler.jsonc` (default 25). When the API reports its own limit in response headers, the portal uses that instead.

The meter on the Funding tab shows today's usage. When less than 20% is left:
- scheduled alerts and the deadline refresh pause until the reset at 00:00 UTC;
- searching, and **Run now** on an alert, still work.

If requests run out, or OpenGrants doesn't answer, the builder says so and you can keep adding opportunities by hand.

## Alerts

An alert is a saved search, or "matches for the client's profile", that runs on a schedule. Each run keeps only listings it hasn't seen before. You choose what happens to them:

- **Queue for me to review** (default): new matches wait on the client's Funding tab. **Save for client** adds one to the client's candidates; **Dismiss** hides it.
- **Draft a report for the client**: each run drafts a funding report of the new matches.
  - By default you review and send each one.
  - If you turn review off, it sends itself.

To spread the load on busy mornings, the dispatcher starts at most three alert runs every 15 minutes.

## Attribution

Consultant screens mark OpenGrants data with "Source: OpenGrants". Clients see the funder's own listing link as the source, in the portal, in emails and in the PDF (spec §10.5).

## When the API changes

- The client code is generated from the committed `worker/integrations/opengrants/openapi.json`. To update it, replace the spec and run `node scripts/gen-opengrants.mjs`. A test fails if the two drift apart.
- All field-name knowledge lives in `worker/integrations/opengrants/mapping.ts`.
- To check the live API, run `OPENGRANTS_API_KEY=... npx vitest run --project build tests/build/opengrants-live.test.ts`. It spends two requests.
