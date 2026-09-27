/**
 * Email rendering (spec §9). Every email has a hand-written plain-text part
 * (the reference, spec §7.6: text-first, no tracking) and an HTML part built
 * from react-email components, themed with the firm's brand. HTML is rendered
 * with React's own streaming renderer; see DECISIONS D-057.
 */
import type { ReactElement } from 'react';

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

const DOCTYPE = '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">';

export async function renderHtml(element: ReactElement): Promise<string> {
  const { renderToReadableStream } = await import('react-dom/server.edge');
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  const html = await new Response(stream).text();
  // React adds <!DOCTYPE html> for <html> roots; email clients prefer the XHTML one.
  return DOCTYPE + html.replace(/^<!DOCTYPE html>/i, '');
}
