/**
 * Minimal text-first templates for the M1 auth emails (spec §7.6: plain, no
 * tracking pixels, no click tracking). The branded react-email set replaces
 * the HTML part in M4; the text part stays the source of truth.
 * See docs/DECISIONS.md D-024.
 */
export interface Rendered {
  subject: string;
  text: string;
  html: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

type Block = { p: string } | { link: { href: string; label: string } } | { code: string } | { small: string };

/** Renders the same blocks as plain text and as simple, table-free HTML. */
export function render(subject: string, blocks: Block[]): Rendered {
  const text = blocks
    .map((b) => {
      if ('p' in b) return b.p;
      if ('link' in b) return `${b.link.label}:\n${b.link.href}`;
      if ('code' in b) return b.code;
      return b.small;
    })
    .join('\n\n');

  const body = blocks
    .map((b) => {
      if ('p' in b) return `<p style="margin:0 0 16px">${escapeHtml(b.p)}</p>`;
      if ('link' in b) {
        return `<p style="margin:0 0 16px"><a href="${escapeHtml(b.link.href)}">${escapeHtml(b.link.label)}</a></p>`;
      }
      if ('code' in b) {
        return `<p style="margin:0 0 16px;font-size:24px;letter-spacing:4px;font-family:monospace">${escapeHtml(b.code)}</p>`;
      }
      return `<p style="margin:0 0 16px;font-size:12px;color:#666666">${escapeHtml(b.small)}</p>`;
    })
    .join('');

  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:15px;line-height:22px;color:#1d1d1d">${body}</body></html>`;
  return { subject, text, html };
}
