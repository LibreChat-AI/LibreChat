import {
  MAX_MCP_ICON_PATH_LENGTH,
  SVG_SANITIZE_CONFIG,
  restrictSvgReferences,
  finalizeSvgMarkup,
} from 'librechat-data-provider';
import type { DOMPurify } from 'dompurify';
import type { JSDOM } from 'jsdom';

const SVG_DATA_URI = /^data:image\/svg\+xml/i;

let purifier: DOMPurify | null = null;

/** jsdom and dompurify load on first use so the api barrel stays cheap to require. */
function getSvgPurifier(): DOMPurify {
  if (purifier) {
    return purifier;
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const jsdom = require('jsdom') as { JSDOM: typeof JSDOM };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const loaded = require('dompurify') as DOMPurify | { default: DOMPurify };
  const create = typeof loaded === 'function' ? loaded : loaded.default;
  purifier = create(new jsdom.JSDOM('').window);
  purifier.addHook('afterSanitizeAttributes', restrictSvgReferences);
  return purifier;
}

/** Decodes like the `data:` URL processor: percent-decode, then base64 if flagged. */
function decodeSvgDataUri(iconPath: string): string | null {
  const comma = iconPath.indexOf(',');
  if (comma === -1) {
    return null;
  }
  let body: string;
  try {
    body = decodeURIComponent(iconPath.slice(comma + 1));
  } catch {
    return null;
  }
  return /;base64/i.test(iconPath.slice(0, comma))
    ? Buffer.from(body, 'base64').toString('utf-8')
    : body;
}

/**
 * Sanitizes a user-provided MCP `iconPath` at the trust boundary. SVG data URIs
 * are re-sanitized with the shared policy and re-encoded as base64; other values
 * pass through. Any value still over `MAX_MCP_ICON_PATH_LENGTH` becomes an empty
 * string, so editing a server whose stored icon predates the cap clears the icon
 * instead of failing validation.
 */
export function sanitizeMcpIconPath(iconPath: string): string {
  /* Strip what the browser's URL parser strips, so `\n data:...` cannot dodge the check. */
  const normalized = iconPath.replace(/^[\0-\x20]+|[\0-\x20]+$/g, '').replace(/[\t\n\r]/g, '');
  if (!SVG_DATA_URI.test(normalized)) {
    return iconPath.length > MAX_MCP_ICON_PATH_LENGTH ? '' : iconPath;
  }
  const svg = decodeSvgDataUri(normalized);
  if (svg == null || svg.length > MAX_MCP_ICON_PATH_LENGTH) {
    return '';
  }
  const clean = finalizeSvgMarkup(getSvgPurifier().sanitize(svg, SVG_SANITIZE_CONFIG));
  const encoded = `data:image/svg+xml;base64,${Buffer.from(clean, 'utf-8').toString('base64')}`;
  return encoded.length > MAX_MCP_ICON_PATH_LENGTH ? '' : encoded;
}
