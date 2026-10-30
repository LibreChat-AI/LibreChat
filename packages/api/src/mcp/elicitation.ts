import { randomUUID } from 'crypto';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { Agents } from 'librechat-data-provider';
import type { FlowStateManager } from '~/flow/manager';

/** A single URL-mode elicitation as carried by a -32042 `UrlElicitationRequired`
 *  error's `data.elicitations` (MCP spec 2025-11-25). */
export interface UrlElicitation {
  mode?: string;
  message: string;
  url: string;
  /** Optional on the wire: servers may omit it, and it is only used for
   *  `notifications/elicitation/complete` correlation. */
  elicitationId?: string;
}

/**
 * True when `url` parses and uses an `http:`/`https:` scheme. Server-supplied
 * elicitation URLs are validated by the MCP SDK with `z.string().url()`, which
 * also accepts `javascript:`, `data:`, and `vbscript:` — schemes that turn an
 * "authorize" card into an XSS/exfiltration vector the moment a client renders
 * the link. Every server-supplied URL surfaced for elicitation must pass this
 * gate; anything else is dropped rather than shown to the user.
 */
export function isHttpUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

/** Returns the first elicitation only when it is well formed: a safe http(s)
 *  URL and a non-empty string message. The payload is server-supplied, so the
 *  declared types are not a runtime guarantee, and both fields are interpolated
 *  straight into user-facing strings (the card body and the McpError messages in
 *  `MCPManager.callTool`) — a missing or non-string `message` would render
 *  "undefined" to the user. A malformed entry is treated as no elicitation at
 *  all rather than being half-surfaced. */
function firstSafeUrlElicitation(elicitations?: UrlElicitation[]): UrlElicitation | null {
  const elicitation = elicitations?.[0];
  if (!elicitation || typeof elicitation !== 'object') {
    return null;
  }
  const { message, url, mode, elicitationId } = elicitation;
  if (typeof message !== 'string' || message.trim().length === 0) {
    return null;
  }
  if (typeof url !== 'string' || !isHttpUrl(url)) {
    return null;
  }
  return {
    message,
    url,
    ...(typeof mode === 'string' ? { mode } : {}),
    ...(typeof elicitationId === 'string' ? { elicitationId } : {}),
  };
}

/**
 * Extracts the first URL elicitation from a failed `tools/call`, handling both
 * wire shapes a -32042 can arrive in:
 *
 * 1. A protocol-level JSON-RPC error response — the SDK surfaces it as an
 *    `McpError`/`UrlElicitationRequiredError` with `code === -32042` and
 *    `data.elicitations`.
 * 2. An HTTP-level rejection — AgentCore Gateway returns JSON-RPC errors with a
 *    non-2xx status, so the SDK's streamable-HTTP transport never parses the
 *    body and instead throws a `StreamableHTTPError` whose `code` is the HTTP
 *    status and whose message embeds the raw body
 *    (`"Error POSTing to endpoint: {\"jsonrpc\":...,\"error\":{\"code\":-32042,...}}"`).
 *
 * Returns `null` when the error is not a URL elicitation in either shape.
 */
export function extractUrlElicitation(error: unknown): UrlElicitation | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const { code, data, message } = error as {
    code?: unknown;
    data?: { elicitations?: UrlElicitation[] };
    message?: unknown;
  };

  if (code === ErrorCode.UrlElicitationRequired) {
    return firstSafeUrlElicitation(data?.elicitations);
  }

  // Cheap pre-filter on the bare error number (not `"code":-32042`) so gateway
  // JSON with whitespace/key-order variance — e.g. a pretty-printed
  // `"code": -32042` — still gets parsed; the JSON.parse + numeric-code check
  // below is what actually validates the shape.
  if (typeof message !== 'string' || !message.includes(String(ErrorCode.UrlElicitationRequired))) {
    return null;
  }
  const braceIndex = message.indexOf('{');
  if (braceIndex === -1) {
    return null;
  }
  const body = message.slice(braceIndex);
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: number; data?: { elicitations?: UrlElicitation[] } };
    };
    if (parsed.error?.code !== ErrorCode.UrlElicitationRequired) {
      return null;
    }
    return firstSafeUrlElicitation(parsed.error.data?.elicitations);
  } catch {
    return null;
  }
}

/** Terminal actions a client can post to `POST /api/mcp/elicitation/:flowId`.
 *  Aliases the canonical {@link Agents.ElicitationAction} (its own doc explains
 *  each member) so the two never drift out of sync. */
export type ElicitationFlowAction = Agents.ElicitationAction;

export interface ElicitationFlowResult {
  action: ElicitationFlowAction;
  content?: Record<string, string | number | boolean>;
}

/**
 * Re-views the process-wide {@link FlowStateManager} singleton — statically typed for OAuth
 * tokens at its main call sites — as an elicitation-flow manager. The manager stores payloads
 * keyed at runtime by (flowId, flow type); the payload shape for an `mcp_elicit` flow is
 * fixed by the flow type, not the class generic, so the generic is erased here. This is the
 * one audited place that assertion lives, so callers never scatter `as unknown as`.
 */
export function asElicitationFlowManager(
  flowManager: unknown,
): FlowStateManager<ElicitationFlowResult> {
  return flowManager as FlowStateManager<ElicitationFlowResult>;
}

/**
 * True when a completed elicitation flow's action counts as "proceed" — either
 * the 2025-06-18 form-mode `accept`, or the URL-exception `complete`.
 */
export function isElicitationSuccess(action: ElicitationFlowAction | undefined): boolean {
  return action === 'accept' || action === 'complete';
}

/**
 * Generates a flow ID for an MCP URL-mode elicitation flow (a `mode: 'url'`
 * `elicitation/create` request, or a -32042 URL-exception retry).
 *
 * Unlike OAuth flow IDs (`MCPOAuthHandler.generateFlowId`, one per user+server),
 * elicitation flows are scoped per tool invocation — concurrent calls to the
 * same server must not collide — and the userId is embedded directly so the
 * completion route can enforce per-user ownership the same way OAuth flow
 * routes do (see `canAccessOAuthFlow` in `api/server/routes/mcp.js`).
 *
 * Every variable segment is URI-encoded so a `:` inside any of them (server and
 * tool names are config/user-derived) can't skew the fields {@link
 * parseElicitationFlowId} reads back out.
 */
export function generateElicitationFlowId(
  userId: string,
  serverName: string,
  toolName: string,
  tenantId?: string,
): string {
  const flowId = `${encodeURIComponent(userId)}:${encodeURIComponent(serverName)}:${encodeURIComponent(toolName)}:${randomUUID()}`;
  if (!tenantId) {
    return flowId;
  }
  return `tenant:${encodeURIComponent(tenantId)}:${flowId}`;
}

export interface ParsedElicitationFlowId {
  userId: string;
  serverName: string;
  toolName: string;
  nonce: string;
  tenantId?: string;
}

/** Inverse of {@link generateElicitationFlowId}, used by the completion route to
 *  verify the requesting user owns the flow before resolving it. */
export function parseElicitationFlowId(flowId: string): ParsedElicitationFlowId | null {
  const parts = flowId.split(':');
  let offset = 0;
  let tenantId: string | undefined;

  if (parts[0] === 'tenant') {
    if (parts.length < 6 || !parts[1]) {
      return null;
    }
    try {
      tenantId = decodeURIComponent(parts[1]);
    } catch {
      return null;
    }
    offset = 2;
  }

  if (parts.length < offset + 4) {
    return null;
  }

  const [rawUserId, rawServerName, rawToolName, nonce] = parts.slice(offset, offset + 4);
  if (!rawUserId || !rawServerName || !rawToolName || !nonce) {
    return null;
  }

  try {
    return {
      userId: decodeURIComponent(rawUserId),
      serverName: decodeURIComponent(rawServerName),
      toolName: decodeURIComponent(rawToolName),
      nonce,
      tenantId,
    };
  } catch {
    return null;
  }
}
