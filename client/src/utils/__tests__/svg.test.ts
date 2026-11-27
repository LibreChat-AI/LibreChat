import {
  installCanvasMock,
  registerFakeIcon,
  resetFakeIcons,
  getLastCrossOrigin,
} from 'test/canvasMock';
import { detectMonochrome, sanitizeSvg, scanMonochrome, svgToDataUri } from '../svg';
import { isSvgIcon } from '../icons';

const rgba = (...quads: number[]) => Uint8ClampedArray.from(quads);

describe('scanMonochrome', () => {
  it('treats a black glyph on a transparent background as monochrome', () => {
    expect(scanMonochrome(rgba(0, 0, 0, 0, 0, 0, 0, 255))).toBe(true);
  });

  it('treats a mid-gray glyph as monochrome', () => {
    expect(scanMonochrome(rgba(128, 128, 128, 255, 0, 0, 0, 0))).toBe(true);
  });

  it('allows a channel spread within the tolerance', () => {
    expect(scanMonochrome(rgba(100, 110, 105, 255, 0, 0, 0, 0))).toBe(true);
  });

  it('accepts a channel spread exactly at the tolerance', () => {
    expect(scanMonochrome(rgba(100, 116, 100, 255, 0, 0, 0, 0))).toBe(true);
  });

  it('rejects a channel spread just past the tolerance', () => {
    expect(scanMonochrome(rgba(100, 117, 100, 255, 0, 0, 0, 0))).toBe(false);
  });

  it('rejects a chromatic pixel', () => {
    expect(scanMonochrome(rgba(255, 0, 0, 255, 0, 0, 0, 0))).toBe(false);
  });

  it('ignores transparent pixels when judging tone', () => {
    expect(scanMonochrome(rgba(255, 0, 0, 0, 20, 20, 20, 255))).toBe(true);
  });

  it('skips a chromatic pixel at the alpha threshold', () => {
    expect(scanMonochrome(rgba(255, 0, 0, 8, 20, 20, 20, 255))).toBe(true);
  });

  it('samples a chromatic pixel just above the alpha threshold', () => {
    expect(scanMonochrome(rgba(255, 0, 0, 9, 0, 0, 0, 0))).toBe(false);
  });

  it('is not monochrome when nothing is painted', () => {
    expect(scanMonochrome(rgba(0, 0, 0, 0, 255, 0, 0, 0))).toBe(false);
  });

  it('is not monochrome when any opaque pixel is chromatic', () => {
    expect(scanMonochrome(rgba(10, 10, 10, 255, 200, 10, 10, 255, 0, 0, 0, 0))).toBe(false);
  });

  it('is not monochrome when fully opaque, since a mask would flatten it to a block', () => {
    expect(scanMonochrome(rgba(0, 0, 0, 255, 90, 90, 90, 255))).toBe(false);
  });

  it('is not monochrome when a semi-transparent fill covers every pixel', () => {
    // grayscale but no empty pixel: a mask would paint a full-canvas wash
    expect(scanMonochrome(rgba(128, 128, 128, 128, 90, 90, 90, 200))).toBe(false);
  });

  it('is monochrome when a translucent glyph sits on genuinely empty pixels', () => {
    expect(scanMonochrome(rgba(128, 128, 128, 128, 0, 0, 0, 0))).toBe(true);
  });

  it('rejects two deliberate tones, which one mask would flatten into one color', () => {
    expect(scanMonochrome(rgba(0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 0))).toBe(false);
  });

  it('allows shading within a single tone', () => {
    expect(scanMonochrome(rgba(34, 34, 34, 255, 85, 85, 85, 255, 0, 0, 0, 0))).toBe(true);
  });

  it('rejects two tones painted at the same partial opacity', () => {
    expect(scanMonochrome(rgba(0, 0, 0, 128, 255, 255, 255, 128, 0, 0, 0, 0))).toBe(false);
  });

  it('tolerates the unpremultiply rounding of a low-alpha edge sample', () => {
    expect(scanMonochrome(rgba(0, 0, 0, 255, 28, 28, 28, 9, 0, 0, 0, 0))).toBe(true);
  });
});

describe('detectMonochrome', () => {
  beforeEach(() => {
    resetFakeIcons();
    installCanvasMock();
  });

  it('detects a grayscale glyph as monochrome', async () => {
    registerFakeIcon('/mono.svg', {
      width: 24,
      height: 24,
      pixels: [0, 0, 0, 0, 0, 0, 0, 255, 90, 90, 90, 255],
    });
    await expect(detectMonochrome('/mono.svg')).resolves.toBe(true);
  });

  it('detects a multi-color icon as not monochrome', async () => {
    registerFakeIcon('/color.svg', {
      width: 24,
      height: 24,
      pixels: [12, 120, 240, 255, 0, 0, 0, 0],
    });
    await expect(detectMonochrome('/color.svg')).resolves.toBe(false);
  });

  it('does not treat a fully-opaque grayscale image as monochrome', async () => {
    registerFakeIcon('/block.svg', {
      width: 24,
      height: 24,
      pixels: [0, 0, 0, 255, 60, 60, 60, 255],
    });
    await expect(detectMonochrome('/block.svg')).resolves.toBe(false);
  });

  it('requests cross-origin access so CORS icons can be sampled', async () => {
    registerFakeIcon('/cors.svg', { width: 8, height: 8, pixels: [0, 0, 0, 255] });
    await detectMonochrome('/cors.svg');
    expect(getLastCrossOrigin()).toBe('anonymous');
  });

  it('falls back to non-monochrome when the image fails to load', async () => {
    registerFakeIcon('/broken.svg', { width: 24, height: 24, error: true });
    await expect(detectMonochrome('/broken.svg')).resolves.toBe(false);
  });

  it('falls back to non-monochrome when the canvas is tainted', async () => {
    registerFakeIcon('/cross-origin.svg', {
      width: 24,
      height: 24,
      pixels: [0, 0, 0, 255],
      taint: true,
    });
    await expect(detectMonochrome('/cross-origin.svg')).resolves.toBe(false);
  });

  it('is not monochrome when the icon reports no intrinsic size', async () => {
    registerFakeIcon('/sizeless.svg', { width: 0, height: 0, pixels: [0, 0, 0, 255] });
    await expect(detectMonochrome('/sizeless.svg')).resolves.toBe(false);
  });

  it('settles a load that never completes so its in-flight entry can be released', async () => {
    jest.useFakeTimers();
    try {
      registerFakeIcon('/stalled.svg', { width: 24, height: 24, pending: true });
      const verdict = detectMonochrome('/stalled.svg');
      jest.advanceTimersByTime(10_000);
      await expect(verdict).resolves.toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

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
