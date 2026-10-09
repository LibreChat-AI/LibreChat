import DOMPurify from 'dompurify';
import {
  SVG_SANITIZE_CONFIG,
  restrictSvgReferences,
  finalizeSvgMarkup,
} from 'librechat-data-provider';
import type { DOMPurify as SvgPurifier } from 'dompurify';

/** Largest canvas edge when sampling; keeps the pixel read to one 64 KiB buffer. */
const SAMPLE_SIZE = 128;
/** Per-channel spread (0-255) a pixel may have and still count as grayscale. */
const GRAYSCALE_TOLERANCE = 16;
/** Pixels at or below this alpha paint nothing visible and are skipped. */
const ALPHA_THRESHOLD = 8;
/**
 * Widest gray-level gap between painted pixels that still reads as one tone.
 * Shading within a glyph stays under it; a second deliberate tone (a white
 * knockout at 255, a mid-gray shape at 153) does not. Unpremultiplied rounding
 * at the lowest sampled alpha is under 16 levels, so it never crosses this.
 */
const TONE_SPREAD_LIMIT = 96;
const LOAD_TIMEOUT_MS = 10_000;

/**
 * True when every painted pixel is grayscale, at least one pixel is empty, and
 * the painted pixels carry a single tone. A CSS mask keys on alpha alone, so a
 * fully painted image would flatten to a solid wash and two grayscale tones
 * would collapse into one color.
 */
export function scanMonochrome(data: Uint8ClampedArray): boolean {
  let painted = false;
  let hasEmptyArea = false;
  let minTone = 255;
  let maxTone = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] <= ALPHA_THRESHOLD) {
      hasEmptyArea = true;
      continue;
    }
    painted = true;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (
      Math.abs(r - g) > GRAYSCALE_TOLERANCE ||
      Math.abs(g - b) > GRAYSCALE_TOLERANCE ||
      Math.abs(r - b) > GRAYSCALE_TOLERANCE
    ) {
      return false;
    }
    const tone = (r + g + b) / 3;
    minTone = Math.min(minTone, tone);
    maxTone = Math.max(maxTone, tone);
  }
  return painted && hasEmptyArea && maxTone - minTone <= TONE_SPREAD_LIMIT;
}

/** Draws the image to an offscreen canvas and reads it back; throws on a tainted canvas. */
function samplePixels(image: HTMLImageElement): Uint8ClampedArray | null {
  const naturalWidth = image.naturalWidth || image.width;
  const naturalHeight = image.naturalHeight || image.height;
  if (!naturalWidth || !naturalHeight) {
    return null;
  }
  const scale = Math.min(1, SAMPLE_SIZE / Math.max(naturalWidth, naturalHeight));
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    return null;
  }
  context.drawImage(image, 0, 0, width, height);
  return context.getImageData(0, 0, width, height).data;
}

/**
 * Loads an icon and resolves whether its rendered pixels are monochrome. Load
 * errors, a tainted canvas, and a load that never settles all resolve to false.
 */
export function detectMonochrome(src: string): Promise<boolean> {
  if (typeof Image === 'undefined') {
    return Promise.resolve(false);
  }
  /* Executor form: Vite's baseline target includes Safari 16; `withResolvers` needs 17.4. */
  return new Promise((resolve) => {
    const image = new Image();
    let timer = 0;
    const settle = (monochrome: boolean) => {
      window.clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      resolve(monochrome);
    };
    timer = window.setTimeout(() => settle(false), LOAD_TIMEOUT_MS);
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      try {
        const data = samplePixels(image);
        settle(data != null && scanMonochrome(data));
      } catch {
        settle(false);
      }
    };
    image.onerror = () => settle(false);
    image.src = src;
  });
}

let svgPurifier: SvgPurifier | null = null;

/** Dedicated instance so the reference hook never reaches the app's default DOMPurify. */
function getSvgPurifier(): SvgPurifier {
  if (svgPurifier) {
    return svgPurifier;
  }
  svgPurifier = DOMPurify(window);
  svgPurifier.addHook('afterSanitizeAttributes', restrictSvgReferences);
  return svgPurifier;
}

/** Strips active content from SVG markup with the policy the server re-applies. */
export function sanitizeSvg(svg: string): string {
  return finalizeSvgMarkup(getSvgPurifier().sanitize(svg, SVG_SANITIZE_CONFIG));
}

/** Encodes SVG markup as a base64 data URI; the escape round-trip keeps `btoa` UTF-8 safe. */
export function svgToDataUri(svg: string): string {
  const binary = encodeURIComponent(svg).replace(/%([0-9A-F]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}
