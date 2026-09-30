# Security model

How the portal protects consultants and their clients. The spec (`docs/SPEC.md` §7) is the requirement; `docs/DECISIONS.md` records choices made where it was silent. This page grows each milestone; M6 finishes it.

## Sign-in

**Magic links (everyone).** Enter your email; you get a link and a 6-digit code.

- 256-bit token and 6-digit code; only `SHA-256(token)` and `SHA-256(code + salt)` are stored. Links expire after 15 minutes and work once. The consume step is a single atomic `UPDATE … WHERE used_at IS NULL AND expires_at > now`.
- Opening the link only shows a confirmation page. Signing in takes a POST from the **Continue** button, so email security scanners (Safe Links, Mimecast, Proofpoint) can't use up the link.
- Codes allow 5 attempts per request, then the request (link included) is dead. Requesting a new email cancels older ones.
- Responses and timing are identical for known and unknown addresses. Unknown addresses get no email and leave no trace.
- Rate limits: 5 requests/hour per email, 20/hour per IP, plus Turnstile once configured.

**Passkeys (staff).** Owners and consultants can add a passkey (Face ID, Touch ID, Windows Hello, a security key). User verification is required, so a passkey is a strong factor on its own. The Owner can require passkeys for all staff (Security page).

**Sessions.**

| | Idle timeout | Absolute limit |
|---|---|---|
| Clients | 7 days | 30 days |
| Staff | 12 hours | 14 days |

- The cookie is `__Host-session`: HttpOnly, Secure, SameSite=Lax, Path=/, no Domain, 256-bit random. The database stores only its SHA-256.
- Everyone can see where they're signed in, sign out one session, or **sign out everywhere**. Staff can sign out all sessions of a client user in a client they can access.
- **Invites** are single-use and expire after 72 hours. A new invite cancels older ones for the same person and client. They're rate-limited per inviter and per recipient, and a client invite gets the same answer whatever account the address already has. The inviter's name never appears in the subject line.
- A sign-in from a browser you haven't used before sends a "new sign-in" email.
- Sensitive settings (Turnstile, passkey policy, removing a passkey) need a sign-in or passkey check within the last 30 minutes.

## Claiming a fresh deployment

The first person to finish step 1 of the wizard becomes the Owner, and the step then locks. A fresh `*.workers.dev` URL could be found by someone else, so claiming needs one of:

- **Email to the Resend account owner.** The setup email is always sent from Resend's shared test sender, which only delivers to the address that owns the Resend account. The person who pasted the API key receives it; nobody else can.
- **The setup code** printed in the Worker's logs (Workers & Pages → your Worker → Logs). Only people with access to your Cloudflare account can read those. The code is single-use and is burned after 10 wrong attempts; **Print a new setup code** issues another.

## Web baseline

- **CSP.** Strict and nonce-based. No inline scripts, `frame-ancestors 'none'`, and a fresh nonce on every page.
- **Headers.** HSTS (preload-ready), `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, a minimal `Permissions-Policy`, COOP/CORP.
- **CSRF.** Every state-changing request needs an exact `Origin` match *and* a double-submit token (`__Host-csrf` cookie echoed in `X-CSRF-Token`).
- **Input.** Every endpoint validates its body with Zod (64 KB cap). Errors never echo input back.
- **Authorization.** Middleware on every route decides who may call it. A generated test lists every route in the app and fails if any route lacks a policy. It calls each route as every kind of user and checks cross-client (IDOR) access on client-scoped routes. Client IDs you can't access answer 404, not 403, so they can't be probed.

## Brand files

- Uploaded logos, marks, favicons, preview images and fonts are checked by their bytes, not by what the browser says they are. Each slot has a type allowlist and a size cap.
- **SVGs are rebuilt, not trusted.** A strict allowlist parser keeps shapes, gradients and text, and drops scripts, event handlers, links, embedded HTML, external references, styles and entity declarations. Files it can't make safe are refused.
- Every SVG served also carries a sandboxing Content-Security-Policy, so even a missed payload couldn't run.
- Brand files live in R2 under random keys and are public by design: the sign-in page, emails and link previews need them.

## Client files

- **Stored privately.** Files live in R2 under random keys (`clients/{client}/{uuid}`). The filename is kept in the database only. There's no public bucket access; every download goes through the portal, which checks the viewer can reach that client.
- **Checked on the way in.** Only documents, spreadsheets, PDFs and images are accepted by default (up to 100 MB). The first bytes must match the file's extension, and the stored type comes from the portal's own table, not the browser. HTML, SVG, scripts and programs are never accepted.
- **Served safely.** Files download as attachments with a strict type and `nosniff`. Only PDFs and images can be previewed in the browser, under a Content-Security-Policy that lets nothing else load or run. Every download is recorded in the audit log.
- **Checksums.** A SHA-256 is computed by the server for every file and sent back with downloads.
- **Internal files.** Staff can keep a file internal; client users can't list, attach or download it.
- **Deleting.** Client users can remove their own uploads for 24 hours; staff can remove any. Deleting removes the stored bytes; a record stays on the timeline. Files that are part of a deliverable's version history can't be deleted.

### Scanning uploads

No malware scanner ships with the portal. To add one, deploy a scanning Worker (for example one wrapping a commercial scanning API) and bind it to the portal as a service named `SCANNER` in `wrangler.jsonc`:

```jsonc
"services": [{ "binding": "SCANNER", "service": "your-scanner-worker" }]
```

With a scanner bound, every new upload shows "Checking…" and can't be downloaded until the scan comes back clean. The portal POSTs the file's bytes to `https://scanner/scan` (headers `X-File-Id`, `X-File-Name`, `Content-Type`) and expects `{"status":"clean"}` or `{"status":"infected"}`. Anything else counts as an error, and the file stays quarantined; the job retries.

## Client data

- **EIN.** Encrypted with AES-256-GCM using the data key; only the last four digits are shown. Revealing the full number needs a recent passkey or sign-in and is recorded in the audit log and on the client's timeline.
- **What clients see.** Client users see their organization's basic details, requests, shared files, deliverables and messages. They don't see internal notes such as focus tags, funding goals, or the EIN.
- **Messages** are plain text. They're never rendered as HTML.
- **Timeline.** Each client has an activity log (uploads, requests, versions, approvals, sign-ins, messages sent). It records who did what and when, not message text or file contents.

## Email

- **Sign-in email is plain and private.** Sign-in and invite emails have a plain-text part, no tracking pixels and no click tracking (links are never rewritten). The only image any email may load is the firm's own logo.
- **Links, not files.** Emails link to pages in the portal; files are never attached or linked directly.
- **One-click unsubscribe.** Non-essential email (activity, reminders, updates) carries a `List-Unsubscribe` header and a footer link, each tied to one person and one kind of email by a signed token. The link can only turn email off. Sign-in emails and document requests always go out.
- **Bounces and complaints.** Delivery events from Resend are accepted only with a valid signature and a recent timestamp, and each event is applied once. A hard bounce or complaint stops non-essential email to that address until the person turns it back on from their profile.
- **Calendar feeds** use a random 256-bit token in the URL; only its hash is stored. Anyone with the URL can read the calendar (that's how calendar apps subscribe), so feeds can be revoked, and access is re-checked on every fetch: someone removed from a client stops seeing its dates.

## Funding data

- **Who sees what.** Client users see only their own pipeline and the reports they were sent. Consultant notes, drafts, the data source, alert matches and the OpenGrants ID never reach them. Every opportunity, report, alert and match route is scoped to one client and covered by the generated IDOR test.
- **Links.** Listing URLs are stored only if they are `http(s)` (manual entry, CSV and OpenGrants alike). Links to them open with `rel="noopener noreferrer"`.
- **The PDF.** It is built on the server from escaped text, with no scripts, forms, or remote resources. It carries only what the client sees in the portal, and it's served with `Content-Disposition: attachment` and `no-store`.
- **The OpenGrants key.** It is a Worker secret, or stored encrypted with the data key. It's sent only to the API host in the committed spec, never reaches the browser, and isn't logged.

## Secrets and sensitive data

- `SESSION_SECRET` and `DATA_ENCRYPTION_KEY` are generated on first boot if you leave them blank. They're kept in KV, and the Owner sees a banner recommending you move them to Worker secrets.
- Integration secrets you enter in the app (OpenGrants key, Cloudflare API token, Turnstile secret) are stored AES-256-GCM encrypted with the data key and are never returned by the API.
- The audit log is append-only, enforced by database triggers. It records sign-ins, failed codes, passkey changes, session revocations, invites, settings changes and setup. It holds IDs and keyed hashes, not raw IPs or emails.

## Recovering access

- **Someone lost their passkey while passkeys are required.** An Owner opens **Settings → Team → Reset passkeys** for them. They then sign in with a magic link and add a new passkey.
- **The only Owner lost their passkey.** Remove it from the D1 console (Storage & Databases → D1 → your database → Console), using their email:

  ```sql
  DELETE FROM passkeys WHERE user_id = (SELECT id FROM users WHERE email = 'name@yourfirm.com');
  ```

  Then sign in with a magic link and add a new passkey.
- **Locked out by the IP allowlist or domain restriction** (for example, after an office IP change). In the D1 console, clear both lists:

  ```sql
  UPDATE settings SET value_json = json_set(value_json, '$.staffIpAllowlist', json('[]'), '$.staffEmailDomains', json('[]')) WHERE key = 'security';
  ```
- **Moved to a custom domain.** Passkeys belong to the address they were created on. Add a new one after switching domains.

## Owner controls

Settings → Security ([`operations.md`](operations.md#security-settings)) sets the following, and the portal refuses a change that would lock out the Owner making it:
- the staff email-domain restriction, enforced both when sign-in mail is sent and when a session starts, including passkey sign-in;
- the staff IP allowlist, checked on every request against Cloudflare's `CF-Connecting-IP`;
- session lengths and sign-in link lifetime;
- data retention.

These actions need a step-up (a passkey assertion, or a sign-in within the last 30 minutes) and are audited:
- changing security settings, roles or passkeys;
- the full data export and the audit-log export;
- hard-deleting a client.

## Attacker self-review (M6)

We reviewed the v0.1 code as an attacker would, against the threat model in spec §7.7. What each threat meets:

| Threat | What an attacker meets | Verified by |
|---|---|---|
| **Leaked or forwarded magic link** | 15-minute (configurable 5–60) single-use hashed tokens, consumed only by POST from the confirmation page. The session list with revoke, and a new-device email. | `magic-link.test.ts`, `sessions.test.ts` |
| **Email enumeration** | Identical 202 answers; the email is sent after the response. Staff outside the allowed domains are treated like unknown addresses. | `magic-link.test.ts`, `admin.test.ts` |
| **Brute-forcing the code** | 5 attempts per code, enforced atomically in D1. Per-IP and per-email rate limits. Optional Turnstile. | `magic-link.test.ts` |
| **Cross-client access (IDOR)** | Client scoping in middleware on every route. Every route is listed in a generated test that calls it as each kind of actor, and calls nested routes with another client's IDs in both the path and the body. | `authz.test.ts` (every route) |
| **Malicious upload** | Type checked by first bytes against an allowlist; HTML and SVG never accepted. Downloads as attachments, with no-sniff, a `default-src 'none'` CSP, and an optional scanner quarantine. | `files.test.ts`, `headers.test.ts` |
| **Stolen staff session** | Configurable idle and absolute expiry, optional passkey requirement, and the IP allowlist. Step-up for sensitive actions. Revoke everywhere. | `sessions.test.ts`, `admin.test.ts` |
| **Script injection** | React escaping everywhere, with no `innerHTML`. A nonce CSP with `strict-dynamic` and no `unsafe-inline`. Email templates are escaped. PDF text is escaped into 7-bit strings. CSV cells are defused against formula injection. | `http.test.ts`, `email.test.ts`, `funding.test.ts`, `admin.test.ts` |
| **CSRF** | A double-submit token plus an Origin check on every write. Exempt only: the signed webhook and one-click unsubscribe endpoints. | `http.test.ts` |
| **Server-side requests to attacker hosts** | Outbound calls go only to fixed hosts: Resend, the OpenGrants base URL from the committed spec (IDs are URL-encoded into one path segment), and Cloudflare's API. Listing URLs are stored if http(s), and never fetched. | code review, `funding.test.ts` |
| **Data export or deletion by the wrong person** | Owner only, with a step-up. The client's name must be typed to confirm a delete. Both are audited. The export leaves out credentials and keeps EINs to their last four digits. | `admin.test.ts` |
| **Public demo abused** | Off unless `DEMO_MODE` is set. Demo accounts are read-only and rate-limited, with no outbound mail and no invites, and the data resets nightly. | `demo-mode.test.ts` |
| **Compromised fork / GitHub account** | Out of scope. Protect the GitHub account with 2FA, since pushes deploy. | — |
| **Supply chain** | Committed lockfile, Dependabot updates, a small dependency set, and no build-time secrets. | CI |

Findings fixed during the review:
- The hard delete now also removes the sent-email log rows (addresses) of the anonymised users.
- Staff sessions from outside the IP allowlist keep their cookie but act as signed out, so a colleague on the road isn't signed out for good.
- The public demo is read-only, as spec §14 asks.

## Known limitations

- **Copy-link invites** (used before your sending domain is verified) sign in whoever opens them. Share them over a channel you trust. They are single-use and expire after 72 hours. They only ever create a new account: if the address already has one when the link is opened, the link signs nobody in and adds nothing, and the person needs an emailed invite instead. When an emailed invite brings an existing account into another client, that account's other sessions are signed out, so a session opened from someone else's copy link can't follow it in.
- **Rate limits are best-effort.** KV has no atomic counter, so a burst of simultaneous requests can slightly exceed a limit. The hard limits (single-use tokens, 5 code attempts, 10 setup-code attempts) are enforced atomically in D1.
- **Turnstile is off** until you add keys (Settings → Security). Rate limits apply either way.
- **New session lengths apply at the next sign-in.** Existing sessions keep the expiry they started with. To end them sooner, use "Sign out everywhere", or remove and re-add the person.
- **The IP allowlist trusts Cloudflare's `CF-Connecting-IP`.** It protects the portal's own hostnames, which always run behind Cloudflare. It isn't a network firewall: sign-in emails are still sent, but the resulting session is refused.
- **The audit log is never purged** (a database trigger blocks deletes). It records IDs and short labels, and the name of a hard-deleted client. Export and archive it if it grows too large for you.
- **The data export is a plain ZIP**, so it must stay under 4 GB and 65,535 files. Above that, copy the R2 bucket with Cloudflare's tools.
- **PDF exports use the standard PDF fonts.** Characters outside Western European scripts appear as `?`.
- **Protect your GitHub account with 2FA.** Pushes to `main` of your fork deploy automatically.
- **No malware scanning by default.** See "Scanning uploads" above.
- **Uploads resume within a session.** An interrupted upload picks up where it stopped while the page stays open. After a reload, the file is uploaded again; the unfinished upload is cleaned up after 7 days.
