/**
 * Minimal JSON fetch wrapper. Same-origin only; cookies ride along
 * automatically. Writes echo the `__Host-csrf` cookie in X-CSRF-Token
 * (double-submit, spec §7.2).
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(`${status} ${code}`);
    this.name = 'ApiError';
  }
}

function csrfToken(): string {
  const match = /(?:^|;\s*)__Host-csrf=([^;]+)/.exec(document.cookie);
  return match?.[1] ? decodeURIComponent(match[1]) : '';
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    headers['X-CSRF-Token'] = csrfToken();
  }
  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, typeof data.error === 'string' ? data.error : 'request_failed', data);
  return data as T;
}

/** Uploads a file as the raw request body (brand assets). */
export async function putFile<T>(path: string, file: Blob): Promise<T> {
  const res = await fetch(path, {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': file.type || 'application/octet-stream', 'X-CSRF-Token': csrfToken() },
    credentials: 'same-origin',
    body: file,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, typeof data.error === 'string' ? data.error : 'request_failed', data);
  return data as T;
}

export const getJson = <T>(path: string) => request<T>('GET', path);
export const postJson = <T>(path: string, body?: unknown) => request<T>('POST', path, body);
export const putJson = <T>(path: string, body?: unknown) => request<T>('PUT', path, body);
export const deleteJson = <T>(path: string) => request<T>('DELETE', path);

/** Human wording for API error codes. Unknown codes get a generic line. */
const MESSAGES: Record<string, string> = {
  rate_limited: 'Too many attempts. Please wait a while and try again.',
  turnstile_failed: "We couldn't confirm you're human. Please try again.",
  link_invalid: 'This link has expired or was already used. Request a new one.',
  code_invalid: "That code didn't match. Check the latest email and try again.",
  code_locked: 'Too many wrong codes. Request a new sign-in email.',
  passkey_required: 'Your account requires a passkey. Use “Sign in with a passkey”.',
  passkey_invalid: "That passkey couldn't be verified.",
  challenge_invalid: 'That took too long. Please try again.',
  already_claimed: 'This portal has already been claimed. Sign in instead.',
  email_not_configured: 'Email is not set up on this deployment. Use the setup code from your Worker logs instead.',
  email_failed: "We couldn't send the email. Use the setup code from your Worker logs instead.",
  setup_code_invalid: "That setup code didn't match. Codes are single-use; request a new one if needed.",
  email_domain_unverified: 'Emailing others needs a verified sending domain. Copy the invite link instead.',
  invite_conflict: 'That email already belongs to a different kind of account.',
  already_member: 'That person is already on your team.',
  accent_contrast: 'That color is too low-contrast for buttons. Try a darker or more saturated shade.',
  file_too_large: 'That file is too large for this slot.',
  file_type_not_allowed: 'That file type isn’t accepted here.',
  file_empty: 'That file is empty.',
  svg_rejected: 'That SVG couldn’t be made safe to show. Try exporting it again, or upload a PNG.',
  step_up_required: 'For security, confirm it’s you first (passkey or a fresh sign-in link).',
  register_passkey_first: 'Add a passkey to your own account before requiring them for the team.',
  token_invalid: 'Cloudflare rejected that API token.',
  zone_not_found: 'That domain is not in the Cloudflare account this token can see.',
  csrf_origin: 'Your session changed in another tab. Reload and try again.',
  csrf_token: 'Your session changed in another tab. Reload and try again.',
  invalid_input: 'Please check the highlighted fields.',
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (typeof err.body.message === 'string' && (err.code === 'email_provider_error' || err.code === 'cloudflare_error')) {
      return err.body.message;
    }
    return MESSAGES[err.code] ?? 'Something went wrong. Please try again.';
  }
  return 'Network error. Check your connection and try again.';
}
