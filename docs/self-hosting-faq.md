# Self-hosting FAQ

## What does it cost to run?

The portal runs on your own Cloudflare account:
- **Cloudflare:** Workers, D1, R2, KV, Queues and Cron;
- **Resend:** email;
- **OpenGrants (optional):** funding data.

Each is billed by its provider under your plan, so check their current pricing pages. This project adds no fees and doesn't phone home.

## Who can see our data?

You and the people you invite. The data lives in your Cloudflare account (D1 for records, R2 for files). Email goes through your Resend account. If you connect OpenGrants, search queries and the profile fields used for matching go to OpenGrants. Nothing is sent to this project's maintainers.

## How do we back up?

- **Settings → Data → Download export** gives you a ZIP of every record and file whenever you want one.
- Cloudflare D1 also keeps its own point-in-time recovery ("Time Travel"). See Cloudflare's D1 documentation for how far back it goes on your plan.

## How do updates work?

Your deployment is your own copy (fork) of the repository. A weekly GitHub Action in your copy opens a pull request when upstream has changes, and merging it redeploys. Database migrations only ever add tables and columns, so an update never removes data. See [`deploy.md`](deploy.md#updates-from-upstream).

## Can we use our own domain?

Yes. Add it in the setup wizard, or later. With a Cloudflare API token the portal attaches it for you; without one, it shows the dashboard steps. See [`deploy.md`](deploy.md).

## Our emails land in spam / don't arrive

- Verify your sending domain in the setup wizard (the DNS records it shows). Until it's verified, only you receive email.
- Turn on delivery tracking (a Resend webhook, one click in the wizard). Bounces then appear on the client's timeline, and addresses that bounce stop receiving non-essential mail.

## Someone lost their passkey

An Owner opens **Settings → Team → Reset passkeys** for them. They then sign in by email and add a new passkey. If the Owner is locked out, [`security.md`](security.md#recovering-access) has the steps.

## How big can uploads be?

Up to 100 MB per file. Large files upload in resumable 8 MB parts. The full data export has to stay under 4 GB.

## Do we need OpenGrants?

No. You can add opportunities by hand or import them from CSV, and still build reports and run the pipeline. OpenGrants adds search, matching, alerts and deadline refresh; see [`opengrants.md`](opengrants.md).

## Can one deployment serve several consultancies?

No, by design: one deployment is one consultancy, with one brand and one Owner team. Agencies run one deployment per consultancy.

## Is there a demo?

A deployment can run in [demo mode](operations.md#demo-mode): read-only sample data, with no email sent, reset nightly.
