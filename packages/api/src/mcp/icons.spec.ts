import { MAX_MCP_ICON_PATH_LENGTH } from 'librechat-data-provider';
import type * as Icons from './icons';
import { sanitizeMcpIconPath } from './icons';

/** Decode the SVG body `sanitizeMcpIconPath` re-emits (base64 or percent-form). */
function decode(dataUri: string): string {
  const base64Prefix = 'data:image/svg+xml;base64,';
  if (dataUri.startsWith(base64Prefix)) {
    return Buffer.from(dataUri.slice(base64Prefix.length), 'base64').toString('utf-8');
  }
  return decodeURIComponent(dataUri.replace(/^data:image\/svg\+xml,/, ''));
}

describe('sanitizeMcpIconPath', () => {
  it('passes through non-SVG values untouched', () => {
    for (const value of [
      'https://example.com/icon.png',
      '/assets/icon.png',
      'data:image/png;base64,abc123',
      '',
    ]) {
      expect(sanitizeMcpIconPath(value)).toBe(value);
    }
  });

  it('strips scripts and event handlers from a percent-encoded SVG data URI', () => {
    const raw = '<svg onload="alert(1)"><script>alert(2)</script><path d="M0 0h1v1H0z"/></svg>';
    const input = `data:image/svg+xml,${encodeURIComponent(raw)}`;
    const clean = decode(sanitizeMcpIconPath(input));
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('onload');
    expect(clean).toContain('path');
  });

  it('strips active content from a base64-encoded SVG data URI (client bypass)', () => {
    const raw =
      '<svg><foreignObject><iframe src="javascript:alert(1)"></iframe></foreignObject><circle r="5"/></svg>';
    const input = `data:image/svg+xml;base64,${Buffer.from(raw, 'utf-8').toString('base64')}`;
    const clean = decode(sanitizeMcpIconPath(input)).toLowerCase();
    expect(clean).not.toContain('foreignobject');
    expect(clean).not.toContain('iframe');
    expect(clean).toContain('circle');
  });

  it('percent-decodes a base64 body before decoding it, as browsers do', () => {
    const raw = '<svg><path d="M0 0h1v1z"/></svg>';
    const escaped = encodeURIComponent(Buffer.from(raw, 'utf-8').toString('base64'));
    expect(escaped).toContain('%3D');
    const clean = decode(sanitizeMcpIconPath(`data:image/svg+xml;base64,${escaped}`));
    expect(clean).toBe('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"></path></svg>');
  });

  it('drops a base64 body with a malformed percent escape', () => {
    expect(sanitizeMcpIconPath('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4%zz')).toBe('');
  });

  it('drops external references that would let an SVG phone home', () => {
    const raw =
      '<svg><image href="https://evil.example/track.png"/><use href="https://evil.example/x.svg#a"/><path d="M0 0h1v1H0z"/></svg>';
    const input = `data:image/svg+xml,${encodeURIComponent(raw)}`;
    const clean = decode(sanitizeMcpIconPath(input));
    expect(clean).not.toContain('evil.example');
    expect(clean).toContain('path');
  });

  it('strips relative-path and javascript: hrefs from <use>', () => {
    for (const href of ['icons.svg#a', '//evil.example/x.svg#a', 'javascript:alert(1)']) {
      const input = `data:image/svg+xml,${encodeURIComponent(`<svg><use href="${href}"/></svg>`)}`;
      expect(decode(sanitizeMcpIconPath(input))).not.toContain('href');
    }
  });

  it('preserves local <defs>/<use> references', () => {
    const raw = '<svg><defs><path id="p" d="M0 0h10v10H0z"/></defs><use href="#p"/></svg>';
    const input = `data:image/svg+xml,${encodeURIComponent(raw)}`;
    const clean = decode(sanitizeMcpIconPath(input));
    expect(clean).toContain('<use href="#p"');
    expect(clean).toContain('d="M0 0h10v10H0z"');
  });

  it('preserves local xlink:href references and gradient inheritance', () => {
    const raw =
      '<svg><defs><path id="p" d="M0 0h1v1z"/></defs><use xlink:href="#p"/><linearGradient id="g2" href="#g" x1="0" x2="1"/></svg>';
    const input = `data:image/svg+xml,${encodeURIComponent(raw)}`;
    const clean = decode(sanitizeMcpIconPath(input));
    expect(clean).toContain('xlink:href="#p"');
    expect(clean).toContain('href="#g"');
    expect(clean).toContain('x1="0"');
  });

  it('keeps the xmlns:xlink declaration that binds preserved xlink:href prefixes', () => {
    const raw =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><path id="p" d="M0 0h1v1z"/></defs><use xlink:href="#p"/></svg>';
    const input = `data:image/svg+xml,${encodeURIComponent(raw)}`;
    const clean = decode(sanitizeMcpIconPath(input));
    expect(clean).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
    expect(clean).toContain('xlink:href="#p"');
  });

  it('preserves textPath labels with fragment-only path references', () => {
    const raw =
      '<svg viewBox="0 0 24 24"><defs><path id="curve" d="M0 10C5 0 15 0 20 10"/></defs><text><textPath href="#curve" startOffset="10%">Hi</textPath></text></svg>';
    const clean = decode(sanitizeMcpIconPath(`data:image/svg+xml,${encodeURIComponent(raw)}`));
    expect(clean).toContain('<textPath href="#curve"');
    expect(clean).toContain('startOffset="10%"');

    const external =
      '<svg><text><textPath href="https://evil.example/x.svg#curve">Hi</textPath></text></svg>';
    const cleanExternal = decode(
      sanitizeMcpIconPath(`data:image/svg+xml,${encodeURIComponent(external)}`),
    );
    expect(cleanExternal).toContain('<textPath');
    expect(cleanExternal).not.toContain('href');
  });

  it('preserves color scopes that feed currentColor paint', () => {
    const raw =
      '<svg color="#e00"><path fill="currentColor" d="M0 0h1v1z"/><g color="#00f"><path stroke="currentColor" d="M2 2h1v1z"/></g></svg>';
    const clean = decode(sanitizeMcpIconPath(`data:image/svg+xml,${encodeURIComponent(raw)}`));
    expect(clean).toContain('color="#e00"');
    expect(clean).toContain('fill="currentColor"');
    expect(clean).toContain('color="#00f"');
  });

  it('preserves marker definitions and fragment-only marker references', () => {
    const raw =
      '<svg viewBox="0 0 24 24"><defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="5" refY="5" orient="auto"><path d="M0 0L10 5L0 10z"/></marker></defs><line x1="2" y1="2" x2="20" y2="20" stroke="#000" marker-end="url(#arrow)"/></svg>';
    const input = `data:image/svg+xml,${encodeURIComponent(raw)}`;
    const clean = decode(sanitizeMcpIconPath(input));
    expect(clean).toContain('<marker id="arrow"');
    expect(clean).toContain('markerWidth="10"');
    expect(clean).toContain('refX="5"');
    expect(clean).toContain('orient="auto"');
    expect(clean).toContain('marker-end="url(#arrow)"');
  });

  it('drops url() references that leave the document, whichever property carries them', () => {
    for (const attribute of ['marker-end', 'fill', 'stroke', 'filter', 'mask', 'clip-path']) {
      for (const ref of [
        'url(https://evil.example/m.svg#a)',
        'url(//evil.example/m.svg#a)',
        "url('/m.svg#a')",
      ]) {
        const raw = `<svg><line x1="0" y1="0" x2="9" y2="9" ${attribute}="${ref}"/></svg>`;
        const clean = decode(sanitizeMcpIconPath(`data:image/svg+xml,${encodeURIComponent(raw)}`));
        expect(clean).not.toContain('evil.example');
        expect(clean).not.toContain(attribute);
        expect(clean).toContain('line');
      }
    }
  });

  it('preserves safe filter effects the client sanitizer allows', () => {
    const raw =
      '<svg><filter id="f"><feDropShadow dx="1" dy="1" stdDeviation="0.5" flood-color="#000" flood-opacity="0.4"/><feGaussianBlur in="SourceGraphic" stdDeviation="2" result="b"/><feOffset in="b" dx="2" dy="2"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter><rect width="10" height="10" filter="url(#f)"/></svg>';
    const input = `data:image/svg+xml,${encodeURIComponent(raw)}`;
    const clean = decode(sanitizeMcpIconPath(input));
    expect(clean).toContain('feDropShadow');
    expect(clean).toContain('feGaussianBlur');
    expect(clean).toContain('stdDeviation="2"');
    expect(clean).toContain('flood-color="#000"');
    expect(clean).toContain('filter="url(#f)"');
  });

  it('strips external feImage references inside filters', () => {
    const raw =
      '<svg><filter id="f"><feImage href="https://evil.example/x.png"/></filter><rect filter="url(#f)"/></svg>';
    const input = `data:image/svg+xml,${encodeURIComponent(raw)}`;
    const clean = decode(sanitizeMcpIconPath(input));
    expect(clean).not.toContain('evil.example');
  });

  it('strips stylesheet blocks and inline style attributes', () => {
    const raw =
      '<svg><style>.red{fill:#e00}</style><path class="red" style="stroke:#00f" fill="#e00" d="M0 0h1v1z"/></svg>';
    const clean = decode(sanitizeMcpIconPath(`data:image/svg+xml,${encodeURIComponent(raw)}`));
    expect(clean).not.toContain('<style');
    expect(clean).not.toContain('style=');
    expect(clean).toContain('fill="#e00"');
  });

  it('preserves local url() paint and filter references', () => {
    const raw =
      '<svg><defs><filter id="f"><feGaussianBlur stdDeviation="1"/></filter><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient></defs><rect fill="url(#g)" filter="url(#f)" width="10" height="10"/></svg>';
    const clean = decode(sanitizeMcpIconPath(`data:image/svg+xml,${encodeURIComponent(raw)}`));
    expect(clean).toContain('fill="url(#g)"');
    expect(clean).toContain('filter="url(#f)"');
  });

  it('preserves pattern coordinate-system attributes (parity with client SVG profile)', () => {
    const raw =
      '<svg viewBox="0 0 24 24"><defs><pattern id="p" width="4" height="4" patternUnits="userSpaceOnUse" patternContentUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="2" height="2" fill="#000"/></pattern></defs><rect width="24" height="24" fill="url(#p)"/></svg>';
    const clean = decode(sanitizeMcpIconPath(`data:image/svg+xml,${encodeURIComponent(raw)}`));
    expect(clean).toContain('patternUnits="userSpaceOnUse"');
    expect(clean).toContain('patternContentUnits="userSpaceOnUse"');
    expect(clean).toContain('patternTransform="rotate(45)"');
    expect(clean).toContain('fill="url(#p)"');
  });

  it('preserves gradient coordinate-system attributes', () => {
    const raw =
      '<svg><defs><linearGradient id="g" gradientUnits="userSpaceOnUse" gradientTransform="translate(1 2)" x1="0" y1="0" x2="10" y2="10"><stop offset="0" stop-color="#f00"/></linearGradient></defs><rect fill="url(#g)" width="10" height="10"/></svg>';
    const clean = decode(sanitizeMcpIconPath(`data:image/svg+xml,${encodeURIComponent(raw)}`));
    expect(clean).toContain('gradientUnits="userSpaceOnUse"');
    expect(clean).toContain('gradientTransform="translate(1 2)"');
  });

  it('preserves case-sensitive SVG names and multi-color paint', () => {
    const raw =
      '<svg viewBox="0 0 24 24"><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient><path d="M0 0h24v24H0z" fill="url(#g)"/></svg>';
    const input = `data:image/svg+xml,${encodeURIComponent(raw)}`;
    const clean = decode(sanitizeMcpIconPath(input));
    expect(clean).toContain('viewBox');
    expect(clean).toContain('linearGradient');
    expect(clean).toContain('fill="url(#g)"');
  });

  it('declares the SVG namespace on a root that omits it', () => {
    const raw = '<svg viewBox="0 0 8 8"><path d="M0 0h1v1z"/></svg>';
    const clean = decode(sanitizeMcpIconPath(`data:image/svg+xml,${encodeURIComponent(raw)}`));
    expect(clean.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8">')).toBe(
      true,
    );
  });

  it('does not duplicate an existing namespace declaration', () => {
    const raw = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>';
    const clean = decode(sanitizeMcpIconPath(`data:image/svg+xml,${encodeURIComponent(raw)}`));
    expect(clean.match(/xmlns=/g)).toHaveLength(1);
  });

  it('sanitizes an SVG data URI hidden behind leading whitespace or controls', () => {
    const evil = '<svg><image href="https://evil.example/x.png"/><path d="M0 0h1v1z"/></svg>';
    const body = `data:image/svg+xml,${encodeURIComponent(evil)}`;
    for (const prefix of ['\n ', '\t', ' \r\n', ' ', '   ']) {
      const clean = decode(sanitizeMcpIconPath(prefix + body));
      expect(clean).not.toContain('evil.example');
      expect(clean).toContain('path');
    }
  });

  it('sanitizes an SVG data URI whose media type hides an embedded newline', () => {
    const evil = '<svg><image href="https://evil.example/x.png"/></svg>';
    const input = `data:image/svg+x\nml,${encodeURIComponent(evil)}`;
    expect(decode(sanitizeMcpIconPath(input))).not.toContain('evil.example');
  });

  it('returns an empty string for a malformed SVG data URI', () => {
    expect(sanitizeMcpIconPath('data:image/svg+xml')).toBe('');
  });

  it('keeps the sanitized output within the schema length cap', () => {
    const raw = `<svg><text>${'A'.repeat(150_000)}</text></svg>`;
    const input = `data:image/svg+xml;base64,${Buffer.from(raw, 'utf-8').toString('base64')}`;
    expect(input.length).toBeLessThanOrEqual(MAX_MCP_ICON_PATH_LENGTH);
    const out = sanitizeMcpIconPath(input);
    expect(out.length).toBeLessThanOrEqual(MAX_MCP_ICON_PATH_LENGTH);
    expect(decode(out)).toContain('AAAA');
  });

  it('never stores an icon over the length cap even when sanitizing grows it', () => {
    // self-closing tags expand to explicit close tags under sanitization
    const cell = '<rect x="1" y="1" width="2" height="2" fill="#abc"/>';
    const raw = `<svg>${cell.repeat(3400)}</svg>`;
    const input = `data:image/svg+xml;base64,${Buffer.from(raw, 'utf-8').toString('base64')}`;
    expect(input.length).toBeLessThanOrEqual(MAX_MCP_ICON_PATH_LENGTH);
    const out = sanitizeMcpIconPath(input);
    expect(out.length).toBeLessThanOrEqual(MAX_MCP_ICON_PATH_LENGTH);
    expect(out).toBe('');
  });

  it('drops an over-cap non-SVG value (raster data URI) that cannot be compacted', () => {
    const huge = `data:image/png;base64,${'A'.repeat(MAX_MCP_ICON_PATH_LENGTH)}`;
    expect(huge.length).toBeGreaterThan(MAX_MCP_ICON_PATH_LENGTH);
    expect(sanitizeMcpIconPath(huge)).toBe('');
  });

  it('passes an under-cap non-SVG value through unchanged', () => {
    const ok = `data:image/png;base64,${'A'.repeat(1000)}`;
    expect(sanitizeMcpIconPath(ok)).toBe(ok);
  });

  it('strips every SMIL animation element so a stored icon cannot loop', () => {
    const raw =
      '<svg><rect width="1" height="1">' +
      '<animate attributeName="x"/><set attributeName="y" to="1"/>' +
      '<animateColor attributeName="fill"/>' +
      '<animateTransform attributeName="transform" type="rotate" repeatCount="indefinite"/>' +
      '<animateMotion dur="2s"><mpath href="#p"/></animateMotion>' +
      '</rect></svg>';
    const input = `data:image/svg+xml,${encodeURIComponent(raw)}`;
    const clean = decode(sanitizeMcpIconPath(input)).toLowerCase();
    for (const tag of [
      '<animate',
      '<animatecolor',
      '<animatetransform',
      '<animatemotion',
      '<mpath',
      '<set',
    ]) {
      expect(clean).not.toContain(tag);
    }
    expect(clean).toContain('rect');
  });

  it('drops an attribute whose later url() leaves the document', () => {
    const raw =
      '<svg><path filter="url(#safe) url(https://evil.example/f.svg#f)" ' +
      'mask="url(#a), url(https://evil.example/m.svg#b)" d="M0 0h1v1z"/></svg>';
    const input = `data:image/svg+xml,${encodeURIComponent(raw)}`;
    const clean = decode(sanitizeMcpIconPath(input));
    expect(clean).not.toContain('evil.example');
    expect(clean).toContain('M0 0h1v1z');
  });

  it('drops a CSS-escaped url() the browser would still resolve', () => {
    const raw = '<svg><path fill="u\\72l(https://evil.example/p.svg#x)" d="M0 0h1v1z"/></svg>';
    const input = `data:image/svg+xml,${encodeURIComponent(raw)}`;
    const clean = decode(sanitizeMcpIconPath(input));
    expect(clean).not.toContain('evil.example');
    expect(clean).toContain('M0 0h1v1z');
  });

  it('preserves radial-gradient focal geometry', () => {
    const raw =
      '<svg><radialGradient id="g" fx="0.1" fy="0.2" fr="0.3" spreadMethod="reflect">' +
      '<stop stop-color="#000"/></radialGradient></svg>';
    const input = `data:image/svg+xml,${encodeURIComponent(raw)}`;
    const clean = decode(sanitizeMcpIconPath(input));
    expect(clean).toContain('fr="0.3"');
    expect(clean).toContain('spreadMethod="reflect"');
  });

  it('drops an oversized SVG before building a DOM for it', () => {
    // the payload sanitizes to an empty <svg>, so only a pre-parse size check can reject it
    const raw = `<svg><script>${'a'.repeat(MAX_MCP_ICON_PATH_LENGTH + 1)}</script></svg>`;
    const input = `data:image/svg+xml;base64,${Buffer.from(raw, 'utf-8').toString('base64')}`;
    expect(sanitizeMcpIconPath(input)).toBe('');
  });
});

describe('sanitizeMcpIconPath dependency loading', () => {
  afterEach(() => {
    jest.dontMock('jsdom');
    jest.dontMock('dompurify');
    jest.resetModules();
  });

  it('does not load jsdom or dompurify until an SVG data URI is sanitized', () => {
    jest.resetModules();
    const loadJsdom = jest.fn();
    const loadDompurify = jest.fn();
    jest.doMock('jsdom', () => {
      loadJsdom();
      return jest.requireActual('jsdom');
    });
    jest.doMock('dompurify', () => {
      loadDompurify();
      return jest.requireActual('dompurify');
    });

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { sanitizeMcpIconPath: sanitize } = require('./icons') as typeof Icons;

    expect(loadJsdom).not.toHaveBeenCalled();
    expect(loadDompurify).not.toHaveBeenCalled();

    sanitize('https://example.com/icon.png');
    expect(loadJsdom).not.toHaveBeenCalled();
    expect(loadDompurify).not.toHaveBeenCalled();

    sanitize(`data:image/svg+xml,${encodeURIComponent('<svg><path d="M0 0h1v1z"/></svg>')}`);
    expect(loadJsdom).toHaveBeenCalledTimes(1);
    expect(loadDompurify).toHaveBeenCalledTimes(1);
  });
});
