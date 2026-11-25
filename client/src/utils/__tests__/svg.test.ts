import { isSvgIcon } from '@librechat/client';
import { sanitizeSvg, svgToDataUri } from '../svg';

describe('sanitizeSvg', () => {
  it('strips script tags but keeps drawing elements', () => {
    const dirty = '<svg><script>alert(1)</script><path d="M0 0h10v10H0z" /></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('alert(1)');
    expect(clean).toContain('path');
  });

  it('strips inline event handler attributes', () => {
    const dirty = '<svg onload="alert(1)"><circle cx="5" cy="5" r="5" onclick="alert(2)" /></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toContain('onload');
    expect(clean).not.toContain('onclick');
    expect(clean).toContain('circle');
  });

  it('removes foreignObject and embedded HTML', () => {
    const dirty =
      '<svg><foreignObject><iframe src="javascript:alert(1)"></iframe></foreignObject></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean.toLowerCase()).not.toContain('foreignobject');
    expect(clean.toLowerCase()).not.toContain('iframe');
  });

  it('strips anchors and javascript: URLs', () => {
    const dirty = '<svg><a href="javascript:alert(1)"><rect width="10" height="10" /></a></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toContain('javascript:');
    expect(clean.toLowerCase()).not.toContain('<a');
    expect(clean).toContain('rect');
  });

  it('drops external <image> references so an SVG cannot phone home', () => {
    const dirty =
      '<svg><image href="https://evil.example/track.png" width="10" height="10" /></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toContain('evil.example');
    expect(clean.toLowerCase()).not.toContain('<image');
  });

  it('strips external <use> references but keeps the element inert', () => {
    const dirty = '<svg><use href="https://evil.example/x.svg#a" /></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toContain('evil.example');
    expect(clean).not.toContain('href');
  });

  it('strips relative-path and javascript: hrefs from <use>', () => {
    for (const href of ['icons.svg#a', '//evil.example/x.svg#a', 'javascript:alert(1)']) {
      const clean = sanitizeSvg(`<svg><use href="${href}" /></svg>`);
      expect(clean).not.toContain('href');
    }
  });

  it('preserves local <defs>/<use> references', () => {
    const dirty = '<svg><defs><path id="p" d="M0 0h10v10H0z" /></defs><use href="#p" /></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).toContain('<use href="#p"');
    expect(clean).toContain('d="M0 0h10v10H0z"');
  });

  it('preserves local xlink:href <use> references', () => {
    const dirty = '<svg><defs><path id="p" d="M0 0h1v1z" /></defs><use xlink:href="#p" /></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).toContain('xlink:href="#p"');
  });

  it('keeps the xmlns:xlink declaration that binds xlink:href prefixes', () => {
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#p" /></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
  });

  it('preserves safe filter effects and strips external feImage references', () => {
    const dirty =
      '<svg><filter id="f"><feGaussianBlur in="SourceGraphic" stdDeviation="2" result="b" /><feOffset in="b" dx="2" dy="2" /><feImage href="https://evil.example/x.png" /></filter><rect width="10" height="10" filter="url(#f)" /></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).toContain('feGaussianBlur');
    expect(clean).toContain('stdDeviation="2"');
    expect(clean).toContain('filter="url(#f)"');
    expect(clean).not.toContain('evil.example');
  });

  it('preserves local url() paint and filter references', () => {
    const dirty =
      '<svg><defs><filter id="f"><feGaussianBlur stdDeviation="1" /></filter><linearGradient id="g"><stop offset="0" stop-color="#000" /></linearGradient></defs><rect fill="url(#g)" filter="url(#f)" width="10" height="10" /></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).toContain('fill="url(#g)"');
    expect(clean).toContain('filter="url(#f)"');
  });

  it('preserves gradient stop inheritance via local href', () => {
    const dirty =
      '<svg><linearGradient id="g"><stop offset="0" stop-color="#000" /></linearGradient><linearGradient id="g2" href="#g" x1="0" x2="1" /><rect fill="url(#g2)" width="10" height="10" /></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).toContain('href="#g"');
    expect(clean).toContain('x1="0"');
    expect(clean).toContain('fill="url(#g2)"');
  });

  it('strips stylesheet blocks and inline style attributes', () => {
    const dirty =
      '<svg><style>.red{fill:#e00}</style><path class="red" style="stroke:#00f" fill="#e00" d="M0 0h1v1z" /></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toContain('<style');
    expect(clean).not.toContain('style=');
    expect(clean).toContain('fill="#e00"');
  });

  it('drops href-smuggling animation elements', () => {
    const dirty = '<svg><a><animate attributeName="href" values="javascript:alert(1)" /></a></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toContain('javascript:');
    expect(clean.toLowerCase()).not.toContain('<animate');
  });

  it('drops url() paint, filter, mask, and clip references that leave the document', () => {
    for (const attribute of ['fill', 'stroke', 'filter', 'mask', 'clip-path', 'marker-end']) {
      for (const reference of [
        'url(https://evil.example/x.svg#a)',
        'url(//evil.example/x.svg#a)',
        "url('/x.svg#a')",
      ]) {
        const clean = sanitizeSvg(
          `<svg><rect width="9" height="9" ${attribute}="${reference}" /></svg>`,
        );
        expect(clean).not.toContain('evil.example');
        expect(clean).not.toContain(attribute);
        expect(clean).toContain('<rect');
      }
    }
  });

  it('preserves feDropShadow casing so the stored SVG still parses as XML', () => {
    const dirty =
      '<svg><filter id="f"><feDropShadow dx="1" dy="1" stdDeviation="0.5" flood-color="#000" /></filter><rect width="9" height="9" filter="url(#f)" /></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).toContain('feDropShadow');
    expect(clean).not.toContain('fedropshadow');
    const parsed = new DOMParser().parseFromString(clean, 'image/svg+xml');
    expect(parsed.querySelector('parsererror')).toBeNull();
    expect(parsed.querySelector('filter')?.children.length).toBe(1);
  });

  it('declares the SVG namespace on a root that omits it so the icon renders standalone', () => {
    const clean = sanitizeSvg('<svg viewBox="0 0 8 8"><path d="M0 0h1v1z" /></svg>');
    expect(clean.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8">')).toBe(
      true,
    );
    const root = new DOMParser().parseFromString(clean, 'image/svg+xml').documentElement;
    expect(root.namespaceURI).toBe('http://www.w3.org/2000/svg');
  });

  it('does not duplicate an existing namespace declaration', () => {
    const clean = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><path d="M0 0h1v1z" /></svg>',
    );
    expect(clean.match(/xmlns=/g)).toHaveLength(1);
    expect(clean).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
  });
});

describe('svgToDataUri', () => {
  const b64Body = (uri: string) => uri.slice('data:image/svg+xml;base64,'.length);

  it('produces a base64 image/svg+xml data URI', () => {
    const uri = svgToDataUri('<svg><path d="M0 0h1v1H0z" /></svg>');
    expect(uri.startsWith('data:image/svg+xml;base64,')).toBe(true);
  });

  it('round-trips through sanitizeSvg into a URI that isSvgIcon accepts', () => {
    const uri = svgToDataUri(sanitizeSvg('<svg><path d="M0 0h1v1H0z" /></svg>'));
    expect(isSvgIcon(uri)).toBe(true);
    const decoded = atob(b64Body(uri));
    expect(decoded).toContain('path');
    expect(decoded.startsWith('<svg')).toBe(true);
  });

  it('encodes non-ASCII markup without throwing and stays decodable', () => {
    const uri = svgToDataUri('<svg><title>café ☕</title><path d="M0 0h1v1H0z" /></svg>');
    expect(uri.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const utf8 = decodeURIComponent(
      atob(b64Body(uri))
        .split('')
        .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
        .join(''),
    );
    expect(utf8).toContain('café ☕');
  });
});
