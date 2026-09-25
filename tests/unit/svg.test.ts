import { describe, expect, it } from 'vitest';
import { sanitizeSvg, SvgRejectedError } from '../../worker/brand/svg';

const wrap = (inner: string, attrs = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"${attrs}>${inner}</svg>`;

/** Nothing executable, loadable, or styleable may survive. */
function assertInert(out: string) {
  const lower = out.toLowerCase();
  for (const bad of ['<script', 'javascript', 'onload', 'onerror', 'onclick', ' on', '<foreignobject', '<iframe', '<image', '<a ', '<style', '@import', 'http://evil', 'https://evil', 'data:', '<animate', '<set', 'expression(']) {
    expect(lower, bad).not.toContain(bad);
  }
}

describe('sanitizeSvg keeps ordinary logos intact', () => {
  it('preserves shapes, gradients, text and fragment references', () => {
    const logo = wrap(
      '<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#1e3a5f"/><stop offset="1" stop-color="#2f6b4f"/></linearGradient>' +
        '<clipPath id="c"><rect width="10" height="10" rx="2"/></clipPath></defs>' +
        '<g clip-path="url(#c)" transform="translate(1 1)"><path d="M0 0L10 10" stroke="url(#g)" stroke-width="2"/>' +
        '<circle cx="5" cy="5" r="3" fill="#fff" fill-opacity=".5"/></g><text x="1" y="9" font-family="Georgia">A&amp;B</text>' +
        '<use href="#c"/>',
    );
    const out = sanitizeSvg(logo);
    expect(out).toContain('<linearGradient id="g"');
    expect(out).toContain('viewBox="0 0 10 10"');
    expect(out).toContain('clip-path="url(#c)"');
    expect(out).toContain('stroke="url(#g)"');
    expect(out).toContain('>A&amp;B</text>');
    expect(out).toContain('<use href="#c"/>');
  });

  it('adds the SVG namespace and drops the XML declaration and comments', () => {
    const out = sanitizeSvg('<?xml version="1.0"?><!-- made in a tool --><svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>');
    expect(out).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>');
  });
});

describe('sanitizeSvg removes every known XSS vector', () => {
  const payloads: [string, string][] = [
    ['script element', wrap('<script>alert(1)</script><rect/>')],
    ['uppercase script', wrap('<SCRIPT>alert(1)</SCRIPT>')],
    ['namespaced script', wrap('<svg:script>alert(1)</svg:script>')],
    ['event handler on root', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect/></svg>'],
    ['event handler on child', wrap('<rect onmouseover="alert(1)" onclick=alert(1) width="1"/>')],
    ['foreignObject html', wrap('<foreignObject><iframe src="javascript:alert(1)"></iframe></foreignObject>')],
    ['anchor javascript', wrap('<a href="javascript:alert(1)"><rect/></a>')],
    ['use external', wrap('<use href="https://evil.test/x.svg#a"/>')],
    ['use data uri', wrap('<use xlink:href="data:image/svg+xml;base64,PHN2Zz4="/>')],
    ['entity-encoded javascript', wrap('<use href="&#106;avascript:alert(1)"/>')],
    ['hex-entity encoded scheme', wrap('<rect fill="&#x75;rl(https://evil.test/a)"/>')],
    ['image element', wrap('<image href="https://evil.test/track.png"/>')],
    ['style element import', wrap('<style>@import url(https://evil.test/a.css);</style>')],
    ['style attribute', wrap('<rect style="background:url(https://evil.test/a)"/>')],
    ['external url in fill', wrap('<rect fill="url(https://evil.test/p#a)"/>')],
    ['animate to javascript', wrap('<a><animate attributeName="href" to="javascript:alert(1)"/></a>')],
    ['set element', wrap('<set attributeName="onload" to="alert(1)"/>')],
    ['css expression', wrap('<rect fill="expression(alert(1))"/>')],
    ['whitespace in scheme', wrap('<use href=" java\tscript:alert(1)"/>')],
    ['quote breaking', wrap('<rect id="a&quot; onload=&quot;alert(1)"/>')],
  ];
  for (const [label, svg] of payloads) {
    it(label, () => {
      let out: string;
      try {
        out = sanitizeSvg(svg);
      } catch (err) {
        expect(err).toBeInstanceOf(SvgRejectedError);
        return;
      }
      assertInert(out);
    });
  }

  it('drops attribute values that carry quotes instead of trying to escape them', () => {
    const out = sanitizeSvg(wrap('<rect id="a&quot; onload=&quot;alert(1)" width="2"/>'));
    expect(out).toContain('<rect width="2"/>');
  });
});

describe('sanitizeSvg rejects documents it cannot make safe', () => {
  const rejects: [string, string][] = [
    ['doctype with entities', '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>'],
    ['billion laughs', '<!DOCTYPE lolz [<!ENTITY lol "lol">]><svg/>'],
    ['cdata', wrap('<text><![CDATA[<script>alert(1)</script>]]></text>')],
    ['not svg', '<html><body onload="alert(1)"></body></html>'],
    ['stylesheet PI', '<?xml-stylesheet href="https://evil.test/a.css"?><svg/>'],
    ['unbalanced', '<svg><g></svg>'],
    ['two roots', '<svg/><svg/>'],
  ];
  for (const [label, svg] of rejects) {
    it(label, () => expect(() => sanitizeSvg(svg)).toThrow(SvgRejectedError));
  }
});
