/**
 * The MCP Apps profile media type. Only `text/html` carrying `profile=mcp-app` runs the App Bridge,
 * so the server (which attaches the bridge payload) and the client (which renders it) must classify
 * a resource identically; a substring test on either side can admit unsupported HTML-like media
 * types.
 */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

/** Spec identifier for the MCP Apps extension, advertised as a per-session host capability. */
export const MCP_UI_EXTENSION_ID = 'io.modelcontextprotocol/ui';

const MCP_APP_PROFILE = 'mcp-app';
const LEGACY_MCP_UI_MIME_TYPE = 'text/html';

function unquote(value: string): string {
  if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

/** RFC 9110 media types are case-insensitive, and parameters are not part of the type. */
function mediaTypeOf(mimeType: string): string {
  return mimeType.split(';')[0].trim().toLowerCase();
}

/**
 * Resolves the legacy MCP-UI convention that an omitted MIME type means inline HTML. Explicit
 * values are preserved so unsupported types never gain HTML behavior by normalization.
 */
export function resolveMCPUIResourceMimeType(mimeType?: string | null): string {
  return mimeType == null ? LEGACY_MCP_UI_MIME_TYPE : mimeType;
}

/**
 * True only for the inline HTML media type supported by the legacy MCP-UI renderer. Media types are
 * case-insensitive and parameters do not change the underlying type.
 */
export function isHtmlMediaType(mimeType?: string | null): boolean {
  if (typeof mimeType !== 'string') {
    return false;
  }
  return mediaTypeOf(mimeType) === LEGACY_MCP_UI_MIME_TYPE;
}

/**
 * True only for the MCP Apps profile: media type exactly `text/html` plus a `profile` parameter
 * whose value is `mcp-app`. Other parameters (`charset`) may precede or follow it, and the value may
 * be quoted. The media type and parameter names are matched case-insensitively per RFC 9110; the
 * profile value is the spec's literal token.
 */
export function isMcpAppMimeType(mimeType?: string | null): boolean {
  if (typeof mimeType !== 'string') {
    return false;
  }
  const parts = mimeType.split(';');
  if (mediaTypeOf(parts[0]) !== 'text/html') {
    return false;
  }
  for (let i = 1; i < parts.length; i++) {
    const separator = parts[i].indexOf('=');
    if (separator === -1) {
      continue;
    }
    if (parts[i].slice(0, separator).trim().toLowerCase() !== 'profile') {
      continue;
    }
    if (unquote(parts[i].slice(separator + 1).trim()) === MCP_APP_PROFILE) {
      return true;
    }
  }
  return false;
}
