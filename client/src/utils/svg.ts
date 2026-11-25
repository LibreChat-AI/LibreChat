import DOMPurify from 'dompurify';
import {
  SVG_SANITIZE_CONFIG,
  restrictSvgReferences,
  finalizeSvgMarkup,
} from 'librechat-data-provider';
import type { DOMPurify as SvgPurifier } from 'dompurify';

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
