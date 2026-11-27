import {
  installCanvasMock,
  registerFakeIcon,
  resetFakeIcons,
  getLastCrossOrigin,
} from '~/test/canvasMock';
import { isSvgIcon, scanMonochrome, detectMonochrome, isSameOriginOrDataIcon } from './icon';

describe('isSvgIcon', () => {
  it.each([
    'https://example.com/icon.svg',
    '/assets/icon.svg',
    '/assets/icon.SVG',
    'https://example.com/icon.svg?v=2',
    'https://example.com/icon.svg#hash',
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    'data:image/svg+xml,%3Csvg%3E%3C/svg%3E',
  ])('accepts SVG icon %s', (iconURL) => {
    expect(isSvgIcon(iconURL)).toBe(true);
  });

  it.each([
    'https://example.com/icon.png',
    '/assets/icon.jpg',
    'data:image/png;base64,abc',
    'https://example.com/svg-logo.png',
    'https://example.com/a.svg/b.png',
    '/assets/icon.svgz',
    'blob:https://example.com/abc-123',
    '/assets/icon.svg/',
    '',
    null,
    undefined,
  ])('rejects non-SVG icon %s', (iconURL) => {
    expect(isSvgIcon(iconURL)).toBe(false);
  });
});

describe('isSameOriginOrDataIcon', () => {
  it.each([
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    'data:image/png;base64,abc',
    '/assets/icon.svg',
    `${window.location.origin}/assets/icon.svg`,
  ])('accepts same-origin or data icon %s', (iconURL) => {
    expect(isSameOriginOrDataIcon(iconURL)).toBe(true);
  });

  it.each([
    'https://evil.example.com/icon.svg',
    '//cdn.example.com/icon.svg',
    'http://other.example/icon.svg',
    /* a backslash is a separator in http(s) URLs, so these load cross-origin */
    '/\\attacker.example/icon.svg',
    '/\\/attacker.example/icon.svg',
    '',
    null,
    undefined,
  ])('rejects cross-origin or empty icon %s', (iconURL) => {
    expect(isSameOriginOrDataIcon(iconURL)).toBe(false);
  });
});

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
