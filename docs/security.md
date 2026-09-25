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

## Secrets and sensitive data

- `SESSION_SECRET` and `DATA_ENCRYPTION_KEY` are generated on first boot if you leave them blank. They're kept in KV, and the Owner sees a banner recommending you move them to Worker secrets.
- Integration secrets you enter in the app (OpenGrants key, Cloudflare API token, Turnstile secret) are stored AES-256-GCM encrypted with the data key and are never returned by the API.
- The audit log is append-only, enforced by database triggers. It records sign-ins, failed codes, passkey changes, session revocations, invites, settings changes and setup. It holds IDs and keyed hashes, not raw IPs or emails.

## Recovering access

- **Someone lost their passkey while passkeys are required.** Until the Team page (M6) adds a button, remove that person's passkeys from the D1 console (Storage & Databases → D1 → your database → Console), using their email:

  ```sql
  DELETE FROM passkeys WHERE user_id = (SELECT id FROM users WHERE email = 'name@yourfirm.com');
  ```

  They then sign in with a magic link and add a new passkey. This works for the Owner too.
- **Moved to a custom domain.** Passkeys belong to the address they were created on. Add a new one after switching domains.

## Known limitations (M1)

- **Copy-link invites** (used before your sending domain is verified) sign in whoever opens them. Share them over a channel you trust. They are single-use and expire after 72 hours. They're only issued for people who don't have an account yet; existing users are added directly or emailed.
- **Rate limits are best-effort.** KV has no atomic counter, so a burst of simultaneous requests can slightly exceed a limit. The hard limits (single-use tokens, 5 code attempts, 10 setup-code attempts) are enforced atomically in D1.
- **Turnstile is off** until you add keys (Security page). Rate limits apply either way.
- **Restricting staff sign-in to an email domain**, the IP allowlist and session-length settings arrive with Settings → Security (M6).
- **Protect your GitHub account with 2FA.** Pushes to `main` of your fork deploy automatically.
