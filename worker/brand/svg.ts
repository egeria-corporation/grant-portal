/**
 * SVG logo sanitizer (spec §7.2, §7.7: "sanitized logos"). Workers have no
 * DOM, so this is a small strict parser with allowlists:
 *
 * - DOCTYPE, ENTITY, CDATA and processing instructions other than the XML
 *   declaration are rejected outright (no XXE, no entity expansion).
 * - Unknown elements (script, style, foreignObject, image, a, animate, set, …)
 *   are dropped together with everything inside them.
 * - Attributes are allowlisted. Values are entity-decoded, then rejected if
 *   they contain a URL scheme, `url()` other than `url(#id)`, or `expression(`.
 *   `href` / `xlink:href` may only point at a fragment in the same file.
 * - The output is re-serialized from the parsed tree, so nothing the input
 *   said about quoting or escaping survives.
 *
 * Served SVGs additionally get `Content-Security-Policy: default-src 'none';
 * style-src 'unsafe-inline'; sandbox` (defence in depth). See DECISIONS D-036.
 */
export class SvgRejectedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SvgRejectedError';
  }
}

const ELEMENTS = new Set([
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan',
  'defs', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'title', 'desc', 'use', 'symbol',
]);

/** Elements whose text content is kept. */
const TEXT_ELEMENTS = new Set(['text', 'tspan', 'title', 'desc']);

const ATTRIBUTES = new Set([
  'viewbox', 'width', 'height', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'dx', 'dy',
  'd', 'points', 'transform', 'id', 'opacity', 'visibility',
  'fill', 'fill-opacity', 'fill-rule', 'clip-rule', 'clip-path', 'mask',
  'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray',
  'stroke-dashoffset', 'stroke-opacity',
  'gradientunits', 'gradienttransform', 'spreadmethod', 'offset', 'stop-color', 'stop-opacity',
  'clippathunits', 'maskunits', 'maskcontentunits', 'preserveaspectratio',
  'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'letter-spacing',
  'xmlns', 'xmlns:xlink', 'version', 'href', 'xlink:href', 'role', 'aria-label', 'aria-hidden', 'focusable',
]);

/** Case-correct spelling for camelCase SVG names we emit. */
const CANONICAL: Record<string, string> = {
  viewbox: 'viewBox', lineargradient: 'linearGradient', radialgradient: 'radialGradient', clippath: 'clipPath',
  gradientunits: 'gradientUnits', gradienttransform: 'gradientTransform', spreadmethod: 'spreadMethod',
  clippathunits: 'clipPathUnits', maskunits: 'maskUnits', maskcontentunits: 'maskContentUnits',
  preserveaspectratio: 'preserveAspectRatio',
};

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

function decodeEntities(v: string): string {
  return v.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);?/gi, (_, e: string) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
  });
}

const escapeText = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (v: string) => escapeText(v).replace(/"/g, '&quot;');

function safeValue(name: string, raw: string): string | null {
  // Strip control characters and whitespace variants browsers ignore in schemes.
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const value = decodeEntities(raw).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const squashed = value.replace(/\s+/g, '').toLowerCase();
  if (name === 'href' || name === 'xlink:href') return /^#[A-Za-z0-9_.:-]+$/.test(value) ? value : null;
  if (name === 'xmlns') return value === SVG_NS ? value : null;
  if (name === 'xmlns:xlink') return value === XLINK_NS ? value : null;
  if (/[a-z][a-z0-9+.-]*:/.test(squashed) && name !== 'font-family') return null;
  if (squashed.includes('expression(') || squashed.includes('javascript') || /[<>"`]/.test(value)) return null;
  if (value.includes("'") && name !== 'font-family') return null;
  const urls = squashed.match(/url\(([^)]*)\)/g) ?? [];
  if (urls.some((u) => !/^url\(#[a-z0-9_.:-]+\)$/.test(u))) return null;
  if (squashed.includes('url(') && urls.length === 0) return null;
  return value.slice(0, 20_000);
}

const TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[|<!|<\/?[^>]*>|[^<]+/g;
const ATTR = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;

/** Returns sanitized SVG markup, or throws SvgRejectedError. */
export function sanitizeSvg(input: string): string {
  const src = input.replace(/^\uFEFF/, '');
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(src)) throw new SvgRejectedError('doctype_or_entities');

  const out: string[] = [];
  const stack: string[] = [];
  let skipDepth = 0; // > 0 while inside a dropped element
  let sawRoot = false;

  for (const match of src.matchAll(TOKEN)) {
    const tok = match[0];
    if (tok.startsWith('<!--')) continue;
    if (tok.startsWith('<?')) {
      if (/^<\?xml[\s?]/i.test(tok)) continue;
      throw new SvgRejectedError('processing_instruction');
    }
    if (tok === '<!' || tok.startsWith('<![CDATA[')) throw new SvgRejectedError('markup_declaration');

    if (tok.startsWith('<')) {
      const closing = tok.startsWith('</');
      const selfClosing = /\/\s*>$/.test(tok);
      const body = tok.replace(/^<\/?/, '').replace(/\/?\s*>$/, '');
      const nameMatch = /^([^\s/>]+)/.exec(body);
      if (!nameMatch?.[1]) throw new SvgRejectedError('malformed_tag');
      const rawName = nameMatch[1];
      const name = rawName.toLowerCase();

      if (closing) {
        if (skipDepth > 0) {
          if (stack.at(-1) === `!${name}`) {
            stack.pop();
            skipDepth--;
          } else if (stack.at(-1)?.startsWith('!')) {
            // Mismatched close inside a dropped subtree: keep skipping.
          }
          continue;
        }
        if (stack.at(-1) !== name) throw new SvgRejectedError('unbalanced_tags');
        stack.pop();
        out.push(`</${CANONICAL[name] ?? name}>`);
        continue;
      }

      const allowed = ELEMENTS.has(name) && skipDepth === 0;
      if (!allowed) {
        if (!sawRoot) throw new SvgRejectedError('root_not_svg');
        if (!selfClosing) {
          stack.push(`!${name}`);
          skipDepth++;
        }
        continue;
      }
      if (!sawRoot) {
        if (name !== 'svg') throw new SvgRejectedError('root_not_svg');
        sawRoot = true;
      } else if (stack.length === 0) {
        throw new SvgRejectedError('multiple_roots');
      }

      const attrs: string[] = [];
      const seen = new Set<string>();
      const attrSrc = body.slice(rawName.length);
      for (const a of attrSrc.matchAll(ATTR)) {
        const attrName = (a[1] ?? '').toLowerCase();
        if (!ATTRIBUTES.has(attrName) || seen.has(attrName)) continue;
        const value = safeValue(attrName, a[2] ?? a[3] ?? a[4] ?? '');
        if (value === null) continue;
        seen.add(attrName);
        attrs.push(`${CANONICAL[attrName] ?? attrName}="${escapeAttr(value)}"`);
      }
      if (name === 'svg' && stack.length === 0 && !seen.has('xmlns')) attrs.unshift(`xmlns="${SVG_NS}"`);
      if (name === 'use' && !seen.has('href') && !seen.has('xlink:href')) continue;

      const tag = CANONICAL[name] ?? name;
      if (selfClosing) {
        out.push(`<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}/>`);
      } else {
        stack.push(name);
        out.push(`<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>`);
      }
      continue;
    }

    // Text node.
    if (skipDepth > 0) continue;
    const parent = stack.at(-1);
    if (parent && TEXT_ELEMENTS.has(parent)) out.push(escapeText(decodeEntities(tok)));
    else if (tok.trim() && !parent) throw new SvgRejectedError('text_outside_root');
  }

  if (!sawRoot) throw new SvgRejectedError('root_not_svg');
  if (stack.length) throw new SvgRejectedError('unbalanced_tags');
  return out.join('');
}

/** Headers for serving any SVG we host. */
export const SVG_HEADERS: Record<string, string> = {
  'Content-Type': 'image/svg+xml',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  'X-Content-Type-Options': 'nosniff',
};
