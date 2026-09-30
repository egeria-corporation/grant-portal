# Running the portal

This is the Owner's guide to day-to-day administration. Everything here is under **Settings** in the workspace and is available to Owners only. Deploying is covered in [`deploy.md`](deploy.md) and branding in [`theming.md`](theming.md).

Some actions need you to **confirm it's you** first: changing security settings, roles, or passkeys (adding one included), inviting a consultant, saving the Cloudflare token or custom domain, exporting data, and deleting a client. Staff also confirm before making a calendar link. Confirm with your passkey, or sign out and back in with an email link. Either counts for 30 minutes.

## Team

**Settings → Team** lists everyone on staff.

- **Owner** or **Consultant.**
  - Owners manage settings and see every client.
  - Consultants see the clients assigned to them on each client's People tab.
  - Turn on **All clients** to let a consultant see every client.
- Changing someone's role signs them out, so their next sign-in picks up the new access.
- **Reset passkeys** if someone lost the device with their passkey. Their passkeys are removed, and they're signed out everywhere. They sign in by email and add a new one.
- **Remove** takes someone off the team: they're disabled, signed out everywhere, and unassigned from clients. Their past work (messages, versions, timeline entries) stays.
- The portal always keeps at least one Owner. You can't demote or remove the last one, and you can't remove yourself.

Invite consultants from the same page. If email isn't set up yet, choose "Give me a link" and send the link yourself; it works once and expires in 72 hours.

## Security settings

**Settings → Security:**

| Setting | Default | Notes |
|---|---|---|
| Require passkeys for staff | Off | Add a passkey to your own account first. |
| Allowed email domains (staff) | Any | e.g. `yourfirm.com`; subdomains included. Staff outside them get no sign-in email and can't be invited. |
| Allowed IP addresses (staff) | Anywhere | Addresses or ranges (`203.0.113.0/24`, IPv6 too). Staff requests from elsewhere are treated as signed out, and staff calendar links don't load there, so Google Calendar and Outlook.com can't use them. |
| Staff: sign out after inactivity / sign in again at least every | 12 hours / 14 days | |
| Clients: sign out after inactivity / sign in again at least every | 7 days / 30 days | |
| Sign-in links and codes expire after | 15 minutes | 5–60 |
| Deleted documents are erased after | 30 days | The stored file is removed; the record that it existed stays. |
| Keep the sent-email log for | 365 days | Addresses, subjects and delivery status of sent mail. |

The portal refuses a domain or IP list that would lock you out from where you are now. The page shows the address you're connecting from.

Client users are never restricted by these staff rules.

New session lengths apply from each person's next sign-in.

Turnstile (bot protection on the sign-in form) and the saved Cloudflare API token are managed on the same page.

## Audit log

**Settings → Audit log** shows sign-ins, setting changes, team changes, EIN reveals, downloads, exports, and deletions, with who did it and when.

- It can't be edited or deleted, by anyone, and retention never removes it.
- **Export CSV** downloads it, optionally filtered. Cells that would start a spreadsheet formula are prefixed with `'`.

## Exporting everything

**Settings → Data → Download export** gives you a ZIP:

- `data/*.json`: every table, one object per row (timestamps are UTC epoch milliseconds);
- `settings.json`: your settings, with secrets removed;
- `files/<client id>/…`: every stored document;
- `brand/`: your uploaded logos and fonts.

Sign-in sessions, sign-in links, passkeys, calendar-feed tokens and API keys are never exported. EINs are exported as their last four digits.

The ZIP must stay under 4 GB. If your files add up to more, contact the maintainers, or copy the R2 bucket with Cloudflare's tools.

## Deleting a client

**Settings → Data → Delete a client permanently.** Type the client's name to confirm. This removes:

- the client and everything about it: documents (including the stored files), requests, deliverables and versions, reports and opportunities, messages, updates and schedules, alerts, the timeline, and emails sent about it;
- the accounts of their portal users who belong to no other client. Those accounts are anonymised and disabled, and their sign-in emails are removed from the log.

The deletion itself is recorded in the audit log, with the client's name. It can't be undone, so export first if you might need anything.

Archiving (the client's status) is the reversible alternative.

## Retention

A daily job at 13:00 UTC:
- erases deleted documents once they're older than the retention window;
- removes sent-email log entries older than theirs;
- cleans up expired sign-in links and sessions;
- refreshes OpenGrants deadlines (if connected).

When it removes anything, it adds one audit-log entry saying how much.

## System page

**System** (Owner) shows queue health, failed jobs (which you can retry), and email delivery problems. If a secret was generated on first boot rather than set as a Worker secret, a banner reminds Owners to move it.

## Demo mode

For a public "try it" instance only. **Never turn this on for a real consultancy.**

Add `"DEMO_MODE": "1"` to `vars` in `wrangler.jsonc` and deploy. Then:

- The sign-in page offers **Explore as a consultant** and **Explore as a client**. Each signs the visitor into a sample account with no email needed.
- Demo accounts are **read-only**: nothing they do is saved.
- No email is sent to anyone except your own sign-in mail. Invites are refused.
- Every night, all clients (and their files) are deleted and the sample client is re-created.
- A banner on every page says it's a demo.

You still claim the portal as Owner first; the demo accounts appear once it's claimed.
