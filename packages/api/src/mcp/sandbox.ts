import { normalizeMCPAppCspDeclaration, resolveMCPAppCspLimits } from 'librechat-data-provider';
import type { MCPAppCspDeclaration, MCPAppCspLimits } from 'librechat-data-provider';

/** Replaced on the way out so the proxy can refuse to build a frame it has no response policy for. */
const CSP_APPLIED_PLACEHOLDER = '/*__CSP_APPLIED__*/';
const CSP_APPLIED_MARKER = 'window.__MCP_SANDBOX_CSP_APPLIED = true;';
const VIEW_CSP_PLACEHOLDER = '/*__VIEW_CSP__*/';

/** The operator setting accepts only explicit HTTP(S) origins, never raw CSP syntax. */
const FRAME_ANCESTOR_RE = /^https?:\/\/[a-zA-Z0-9][a-zA-Z0-9.-]*(?::\d{1,5})?$/;

export interface SandboxResponse {
  headers: Record<string, string | string[]>;
  body: string;
}

const toDomainList = (value?: string[]): string => value?.join(' ') ?? '';

const buildCspPolicy = (csp: MCPAppCspDeclaration, proxyLoader: boolean): string => {
  const resourceDomains = toDomainList(csp.resourceDomains);
  const connectDomains = toDomainList(csp.connectDomains) || "'none'";
  const frameDomains = toDomainList(csp.frameDomains);

  const scriptSrc = "script-src 'self' 'unsafe-inline' " + resourceDomains;

  return [
    "default-src 'none'",
    scriptSrc.trim(),
    ("style-src 'self' 'unsafe-inline' " + resourceDomains).trim(),
    'connect-src ' + connectDomains,
    // form-action does not fall back to default-src, so with allow-forms a form could post to
    // any origin; bound it to the declared egress allowlist ('none' when none is declared).
    'form-action ' + connectDomains,
    ("img-src 'self' data: " + resourceDomains).trim(),
    ("media-src 'self' data: " + resourceDomains).trim(),
    ("font-src 'self' " + resourceDomains).trim(),
    proxyLoader
      ? ('frame-src blob: ' + frameDomains).trim()
      : 'frame-src ' + (frameDomains || "'none'"),
    ("worker-src 'self' " + resourceDomains).trim(),
    "object-src 'none'",
    'base-uri ' + (toDomainList(csp.baseUriDomains) || "'self'"),
  ].join('; ');
};

const serializeInlineScriptString = (value: string): string =>
  JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => {
    const code = character.charCodeAt(0).toString(16).padStart(4, '0');
    return `\\u${code}`;
  });

/** An unparseable, oversized, or repeated `csp` param yields the restrictive default policy. */
const parseCspParam = (
  raw: string | string[] | undefined,
  limits: MCPAppCspLimits,
): MCPAppCspDeclaration => {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > limits.maxSerializedLength) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return normalizeMCPAppCspDeclaration(parsed, limits);
  } catch {
    return {};
  }
};

/**
 * The MCP Apps spec requires the Host and Sandbox to have different origins for web hosts. The
 * dedicated sandbox origin is unusable until the operator lists its allowed host origin(s).
 */
const buildFrameAncestors = (raw?: string): string => {
  // Only accept scheme://host[:port] tokens. A raw value is interpolated into the CSP header, so
  // an unvalidated token containing ";" would inject an unrelated directive.
  return (raw ?? '')
    .trim()
    .split(/[\s,]+/)
    .filter((token) => FRAME_ANCESTOR_RE.test(token))
    .join(' ');
};

/**
 * Builds the proxy response policy and the separate View policy from one normalized declaration.
 * The proxy refuses to build an app frame unless this route substituted both trusted markers.
 */
export function buildSandboxResponse({
  sandboxHtml,
  frameAncestors,
  csp,
  limits: rawLimits,
}: {
  sandboxHtml: string;
  frameAncestors?: string;
  csp?: string | string[];
  limits?: Partial<MCPAppCspLimits>;
}): SandboxResponse {
  const ancestors = buildFrameAncestors(frameAncestors);
  const limits = resolveMCPAppCspLimits(rawLimits);
  const declaration = parseCspParam(csp, limits);
  const proxyPolicy = buildCspPolicy(declaration, true);
  const viewPolicy = buildCspPolicy(declaration, false);
  const headers: Record<string, string | string[]> = {
    'Content-Type': 'text/html; charset=utf-8',
    // Required, not merely hygienic: the per-resource policy below varies per request.
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': ancestors ? 'cross-origin' : 'same-origin',
  };
  if (!ancestors) {
    headers['X-Frame-Options'] = 'DENY';
  }
  const ancestorsPolicy = ancestors ? `frame-ancestors ${ancestors}` : "frame-ancestors 'none'";
  // frame-ancestors stays its own policy: CSP3 excludes it from the meta-element path, and
  // multiple policies intersect, so the resource policy cannot loosen it.
  headers['Content-Security-Policy'] = [ancestorsPolicy, proxyPolicy];

  return {
    headers,
    body: sandboxHtml
      .replace(CSP_APPLIED_PLACEHOLDER, CSP_APPLIED_MARKER)
      .replace(
        VIEW_CSP_PLACEHOLDER,
        `window.__MCP_VIEW_CSP = ${serializeInlineScriptString(viewPolicy)};`,
      ),
  };
}
