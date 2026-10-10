import {
  Tools,
  request,
  apiBaseUrl,
  isMcpAppMimeType,
  MCP_APP_CSP_MAX_LENGTH,
  normalizeMCPAppCspDeclaration,
  resolveMCPAppCspLimits,
} from 'librechat-data-provider';
import type {
  CallToolResult,
  ListResourcesResult,
  ReadResourceResult,
  ListResourceTemplatesResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { MCPAppCspLimits, TAttachment, UIResource } from 'librechat-data-provider';

export type AppToolResult = {
  content: unknown[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

/** Browser capabilities supported by LibreChat's deliberately opaque inner App frame. */
export function getSupportedMCPAppPermissions(
  permissions: UIResource['permissions'],
): UIResource['permissions'] {
  if (!permissions) {
    return undefined;
  }
  const supported: NonNullable<UIResource['permissions']> = {};
  if (permissions.geolocation) {
    supported.geolocation = {};
  }
  if (permissions.clipboardWrite) {
    supported.clipboardWrite = {};
  }
  return Object.keys(supported).length > 0 ? supported : undefined;
}

/**
 * An MCP App resource is server-bound and declares the MCP Apps HTML profile
 * (`text/html;profile=mcp-app`). Only these run the App Bridge handshake; plain `text/html`
 * resources are static and must render through a srcDoc iframe instead.
 */
export function isMcpAppResource(resource: UIResource): boolean {
  // Shared with the server's app-backed classification so the two sides cannot drift: a substring
  // test here accepted mime types the parser refuses to attach bridge fields to.
  return !!resource.toolName && !!resource.serverName && isMcpAppMimeType(resource.mimeType);
}

/**
 * Builds the App Bridge tool result from a UI resource. App-backed resources (toolName +
 * serverName) always produce a result so the app's ontoolresult fires even for empty output,
 * and the tool result's _meta is forwarded for apps that hydrate from it.
 */
export function buildAppToolResult(resource: UIResource): AppToolResult | undefined {
  const sc = resource.structuredContent as Record<string, unknown> | undefined | null;
  const content = (resource.content as unknown[] | undefined) ?? [];
  const meta = resource.resultMeta as Record<string, unknown> | undefined;
  const hasStructured = !!sc && typeof sc === 'object' && !Array.isArray(sc);
  const isAppBacked = !!(resource.toolName && resource.serverName);
  if (
    !hasStructured &&
    content.length === 0 &&
    meta == null &&
    resource.isError !== true &&
    !isAppBacked
  ) {
    return undefined;
  }
  return {
    content,
    ...(hasStructured ? { structuredContent: sc } : {}),
    ...(resource.isError === true ? { isError: true } : {}),
    ...(meta != null ? { _meta: meta } : {}),
  };
}

export function getMCPSandboxUrl(runtimeUrl?: unknown): string | undefined {
  const env = import.meta.env as Record<string, string | undefined>;
  let base = env.VITE_MCP_SANDBOX_URL ?? '';
  if (runtimeUrl !== undefined) {
    base = typeof runtimeUrl === 'string' ? runtimeUrl : '';
  }
  base = base.trim();
  if (!base) {
    return undefined;
  }
  try {
    const url = new URL(base);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.origin === window.location.origin
    ) {
      return undefined;
    }
    url.searchParams.set('parentOrigin', window.location.origin);
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Default route bound retained for mixed-version callers and assertions. */
export const MAX_SANDBOX_CSP_PARAM_LENGTH = MCP_APP_CSP_MAX_LENGTH;

/**
 * The declaration travels on the sandbox URL before load. The route uses the same normalized value
 * for its proxy response policy and the View policy it installs ahead of App content. Returning that
 * normalized value keeps host link decisions within the policy the View actually received.
 */
export function withSandboxCsp(
  sandboxUrl: string,
  csp: UIResource['csp'],
  limits?: MCPAppCspLimits,
): { url: string; applied: UIResource['csp'] } {
  if (!csp) {
    return { url: sandboxUrl, applied: undefined };
  }
  try {
    const effectiveLimits = resolveMCPAppCspLimits(limits);
    const normalized = normalizeMCPAppCspDeclaration(csp, effectiveLimits);
    const serialized = JSON.stringify(normalized);
    if (serialized.length > effectiveLimits.maxSerializedLength) {
      return { url: sandboxUrl, applied: undefined };
    }
    const url = new URL(sandboxUrl, window.location.origin);
    url.searchParams.set('csp', serialized);
    return { url: url.toString(), applied: normalized };
  } catch {
    return { url: sandboxUrl, applied: undefined };
  }
}

/**
 * Stable identity for a UI resource across re-renders. Keying render state by array index lets a
 * removed resource hand its loaded/torn-down state and measured height to whichever resource
 * reconciles onto its index.
 */
export function getResourceKey(resource: UIResource): string {
  return resource.resourceId || resource.uri;
}

export type MCPAppResourceOccurrence = {
  attachment: TAttachment;
  key: string;
  resource: UIResource;
};

/** MCP Apps owned by correlated attachment wrappers. Legacy HTML remains marker-owned. */
export function selectToolCallUIResources(attachments?: TAttachment[]): MCPAppResourceOccurrence[] {
  const occurrences = new Map<string, number>();
  return (attachments ?? []).flatMap((attachment) => {
    if (attachment.type !== Tools.ui_resources) {
      return [];
    }
    const value = attachment[Tools.ui_resources];
    const resources = Array.isArray(value) ? (value as UIResource[]) : [];
    const owner = attachment as TAttachment & {
      toolCallId?: string;
      agentId?: string;
      stepId?: string;
    };
    return resources.flatMap((resource) => {
      if (!isMcpAppResource(resource)) {
        return [];
      }
      const semanticKey = JSON.stringify([
        owner.toolCallId,
        owner.agentId,
        owner.stepId,
        getResourceKey(resource),
      ]);
      const occurrence = occurrences.get(semanticKey) ?? 0;
      occurrences.set(semanticKey, occurrence + 1);
      return [{ attachment, key: JSON.stringify([semanticKey, occurrence]), resource }];
    });
  });
}

async function postMCPAppRequest<T>(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await request.authenticatedFetch(`${apiBaseUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    throw new Error(`MCP App request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

export async function callMCPAppTool(
  serverName: string,
  serverBinding: string,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  return postMCPAppRequest(
    '/api/mcp/app-tool-call',
    {
      serverName,
      serverBinding,
      toolName,
      arguments: args,
    },
    signal,
  );
}

export async function readMCPResource(
  serverName: string,
  serverBinding: string,
  uri: string,
  signal?: AbortSignal,
): Promise<ReadResourceResult> {
  return postMCPAppRequest('/api/mcp/resources/read', { serverName, serverBinding, uri }, signal);
}

export async function listMCPResources(
  serverName: string,
  serverBinding: string,
  cursor?: string,
  signal?: AbortSignal,
): Promise<ListResourcesResult> {
  return postMCPAppRequest(
    '/api/mcp/resources/list',
    { serverName, serverBinding, cursor },
    signal,
  );
}

export async function listMCPResourceTemplates(
  serverName: string,
  serverBinding: string,
  cursor?: string,
  signal?: AbortSignal,
): Promise<ListResourceTemplatesResult> {
  return postMCPAppRequest(
    '/api/mcp/resources/templates/list',
    { serverName, serverBinding, cursor },
    signal,
  );
}

export async function validateMCPAppBinding(
  serverName: string,
  serverBinding: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = await postMCPAppRequest<{ valid?: boolean }>(
    '/api/mcp/app/validate',
    { serverName, serverBinding },
    signal,
  );
  if (result.valid !== true) {
    throw new Error('MCP App server binding is no longer valid');
  }
}

type ResourceUiMeta = {
  csp?: {
    connectDomains?: string[];
    resourceDomains?: string[];
    frameDomains?: string[];
    baseUriDomains?: string[];
  };
  permissions?: {
    camera?: Record<string, never>;
    microphone?: Record<string, never>;
    geolocation?: Record<string, never>;
    clipboardWrite?: Record<string, never>;
  };
};

/** Decode a base64 resource blob as UTF-8 so non-ASCII HTML is not mojibake (atob yields Latin-1). */
export function decodeBase64Utf8(b64: string): string {
  const bytes = Uint8Array.from(atob(b64), (char) => char.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Upper bound for an app-requested iframe height. The size comes from the sandboxed app, so an
 * unclamped value would let it impose multi-million-pixel layout on the host conversation.
 */
export const MAX_APP_VIEW_HEIGHT = 4000;

/**
 * Lower bound for an app-requested iframe height. A few-pixel height hides the app behind its own
 * chrome with no way for the user to recover it.
 */
export const MIN_APP_VIEW_HEIGHT = 80;

/** Upper bound for a carousel slide, which scrolls horizontally in a fixed-height row. */
export const MAX_CAROUSEL_VIEW_HEIGHT = 720;

/** Clamps an app-reported height, returning undefined when it is not a usable positive number. */
export function clampAppViewHeight(
  height?: number,
  bounds?: { min?: number; max?: number },
): number | undefined {
  if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) {
    return undefined;
  }
  const min = bounds?.min ?? MIN_APP_VIEW_HEIGHT;
  const max = bounds?.max ?? MAX_APP_VIEW_HEIGHT;
  return Math.min(Math.max(Math.round(height), min), max);
}

/**
 * CSP3 §6.6.2.2 host-source grammar, minus the scheme-less form. `scheme-part` is required because
 * the app document has an opaque origin, so §6.7.2.8's "same scheme as the protected resource" rule
 * has no stable answer; `path-part` is rejected because the sandbox filter drops path-bearing
 * entries, so accepting one here would authorize a link the sandbox policy never granted.
 *
 * `isAllowedAppLink` consumes the shared normalized source list, then authorizes a strict subset of
 * what the browser grants inside the sandbox. Every deviation from CSP3 here narrows.
 */
const APP_LINK_HOST_PATTERN =
  /^(https?|wss?):\/\/(\*\.)?([a-zA-Z0-9](?:[a-zA-Z0-9\-.]*[a-zA-Z0-9])?)(?::(\d{1,5}|\*))?$/i;

const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' };

function effectivePort(url: URL): string {
  return url.port || DEFAULT_PORTS[url.protocol] || '';
}

/** IPv6 hosts arrive bracketed from `URL`; IPv4 is four decimal labels. CSP3 §6.7.2.10 step 1
 * compares host-parts label by label, so an address literal can never match a wildcard and only
 * ever matches itself: refuse both rather than reason about `0x7f.1` style spellings. */
function isAddressLiteral(hostname: string): boolean {
  return hostname.startsWith('[') || /^\d+(?:\.\d+)*$/.test(hostname);
}

/**
 * Matches a URL against one declared CSP source, following CSP3 §6.7.2.8-11: the scheme must match
 * exactly (no `http`→`https` widening in either direction), an absent `port-part` matches only the
 * scheme's default port, `port-part = '*'` matches any port, and `*.example.com` requires at least
 * one subdomain label so it never covers the apex.
 */
function urlMatchesDeclaredSource(url: URL, entry: string): boolean {
  const match = APP_LINK_HOST_PATTERN.exec(entry.trim());
  if (!match) {
    return false;
  }
  const [, declaredScheme, wildcard, declaredHost, declaredPort] = match;

  // ws(s) declarations are for sockets, not navigable links.
  const scheme = declaredScheme.toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    return false;
  }
  if (url.protocol !== `${scheme}:`) {
    return false;
  }

  if (
    declaredPort !== '*' &&
    effectivePort(url) !== (declaredPort || DEFAULT_PORTS[`${scheme}:`])
  ) {
    return false;
  }

  const host = url.hostname.toLowerCase();
  const target = declaredHost.toLowerCase();
  // CSP3 compares host-parts label by label, so a trailing dot yields an empty final label that
  // matches nothing; refuse it rather than normalize it into the apex.
  if (!host || host.endsWith('.') || isAddressLiteral(host)) {
    return false;
  }
  if (!wildcard) {
    return host === target;
  }
  return host.length > target.length + 1 && host.endsWith(`.${target}`);
}

/**
 * A host-opened link is not bound by the sandbox CSP, so an app holding proxied MCP data could
 * encode it into a URL and exfiltrate it through the host page. Only hosts the resource declared
 * for egress are opened; a resource declaring none gets no host-opened links, matching the
 * `connect-src 'none'` default applied inside the sandbox.
 */
export function isAllowedAppLink(
  url: string,
  csp: UIResource['csp'],
  limits?: MCPAppCspLimits,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  const effective = normalizeMCPAppCspDeclaration(csp, limits);
  const declared = [
    ...(effective.connectDomains ?? []),
    ...(effective.resourceDomains ?? []),
    ...(effective.frameDomains ?? []),
  ];
  return declared.some(
    (entry) => typeof entry === 'string' && urlMatchesDeclaredSource(parsed, entry),
  );
}

/**
 * Inline HTML persisted on a UI resource, carried either as `text` or as a base64 `blob`. Read-only
 * views render only inline HTML, so both encodings must count as persisted or blob-embedded apps
 * would be dropped from shared transcripts.
 */
export function getInlineResourceHtml(resource: UIResource): string | undefined {
  if (typeof resource.text === 'string' && resource.text) {
    return resource.text;
  }
  if (typeof resource.blob === 'string' && resource.blob) {
    try {
      return decodeBase64Utf8(resource.blob);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function fetchMCPResourceHtml(
  serverName: string,
  serverBinding: string,
  uri: string,
  signal?: AbortSignal,
): Promise<{
  html: string;
  csp?: ResourceUiMeta['csp'];
  permissions?: ResourceUiMeta['permissions'];
}> {
  const result = (await readMCPResource(serverName, serverBinding, uri, signal)) as {
    contents?: Array<{
      uri?: string;
      mimeType?: string;
      text?: string;
      blob?: string;
      _meta?: { ui?: ResourceUiMeta };
    }>;
  };
  const item = result?.contents?.find(
    (content) => content.uri === uri && isMcpAppMimeType(content.mimeType),
  );
  const uiMeta = item?._meta?.ui;
  let html = item?.text ?? '';
  if (!html && typeof item?.blob === 'string' && item.blob) {
    try {
      html = decodeBase64Utf8(item.blob);
    } catch {
      html = '';
    }
  }
  if (!html) {
    throw new Error('MCP App resource returned no matching HTML document');
  }
  return {
    html,
    csp: uiMeta?.csp,
    permissions: uiMeta?.permissions,
  };
}
