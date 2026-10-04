import { isIP } from 'node:net';
import { EventEmitter } from 'events';
import { logger } from '@librechat/data-schemas';
import { MCP_UI_EXTENSION_ID } from 'librechat-data-provider';
import { fetch as undiciFetch, Agent, ProxyAgent } from 'undici';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  RequestInit as UndiciRequestInit,
  RequestInfo as UndiciRequestInfo,
  Response as UndiciResponse,
  Dispatcher,
} from 'undici';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ClientCapabilities } from '@modelcontextprotocol/sdk/types.js';
import type { TMCPAppOperationLimits } from 'librechat-data-provider';
import type { MCPClientCapabilityProfile } from './capabilities';
import type { MCPOAuthTokens } from './oauth/types';
import type * as t from './types';
import {
  extractSSEErrorMessage,
  isOAuthAuthenticationError,
  isMCPTransportAuthenticationError,
  MCPTransportAuthenticationError,
  isStandaloneSseConflict,
} from './errors';
import {
  createMCPAppSSEEventGuard,
  getMCPAppOperationLimits,
  guardMCPAppSSEEvents,
} from './apps/budget';
import { MCP_APPS_CAPABILITY_PROFILE, STANDARD_MCP_CAPABILITY_PROFILE } from './capabilities';
import { createSSRFSafeUndiciConnect, isSSRFTarget, resolveHostnameSSRF } from '~/auth';
import { projectMCPAppRuntimeTarget, type MCPAppRuntimeTarget } from './apps/binding';
import { reserveMCPToolsChangedRevision } from './toolsChanged';
import { runOutsideTracing } from '~/utils/tracing';
import { mediaTypeEssence } from '~/utils/headers';
import { isAddressAllowed } from '~/auth/domain';
import { withMCPRequestSignal } from './signal';
import { withTimeout } from '~/utils/promise';
import { RESOURCE_MIME_TYPE } from './apps';
import { isOAuthServer } from './utils';
import { mcpConfig } from './mcpConfig';

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;
type ManagedDispatcher = Agent | ProxyAgent;
type ParsedIP = { version: 4 | 6; bits: 32 | 128; value: bigint };
type MCPTool = MCPListToolsResult['tools'][number];

const BIGINT_ZERO = BigInt(0);
const BIGINT_ONE = BigInt(1);
const BIGINT_EIGHT = BigInt(8);
const BIGINT_SIXTEEN = BigInt(16);
const UINT16_MASK = BigInt(0xffff);

function getApproximateToolBytes(tool: MCPTool): number {
  try {
    return Buffer.byteLength(JSON.stringify(tool), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function getToolsListBudgetExceededReason(
  toolCount: number,
  totalBytes: number,
  maxTools: number,
  maxBytes: number,
): string | null {
  if (toolCount >= maxTools) {
    return 'tool count';
  }
  if (totalBytes >= maxBytes) {
    return 'size';
  }
  return null;
}

type MCPProxyConfig =
  | {
      type: 'explicit';
      proxyUrl: string;
    }
  | {
      type: 'env';
      httpProxy?: string;
      httpsProxy?: string;
      noProxy?: string;
    };

function isStdioOptions(options: t.MCPOptions): options is t.StdioOptions {
  return 'command' in options;
}

function isWebSocketOptions(options: t.MCPOptions): options is t.WebSocketOptions {
  if ('url' in options) {
    const protocol = new URL(options.url).protocol;
    return protocol === 'ws:' || protocol === 'wss:';
  }
  return false;
}

function isSSEOptions(options: t.MCPOptions): options is t.SSEOptions {
  if ('url' in options) {
    const protocol = new URL(options.url).protocol;
    return protocol !== 'ws:' && protocol !== 'wss:';
  }
  return false;
}

/**
 * Checks if the provided options are for a Streamable HTTP transport.
 *
 * Streamable HTTP is an MCP transport that uses HTTP POST for sending messages
 * and supports streaming responses. It provides better performance than
 * SSE transport while maintaining compatibility with most network environments.
 *
 * @param options MCP connection options to check
 * @returns True if options are for a streamable HTTP transport
 */
function isStreamableHTTPOptions(options: t.MCPOptions): options is t.StreamableHTTPOptions {
  if ('url' in options && 'type' in options) {
    const optionType = options.type as string;
    if (optionType === 'streamable-http' || optionType === 'http') {
      const protocol = new URL(options.url).protocol;
      return protocol !== 'ws:' && protocol !== 'wss:';
    }
  }
  return false;
}

const FIVE_MINUTES = 5 * 60 * 1000;
const DEFAULT_TIMEOUT = 60000;
/** SSE connections through proxies may need longer initial handshake time */
const SSE_CONNECT_TIMEOUT = 120000;
const DEFAULT_INIT_TIMEOUT = 30000;
/** Upper bound on the spec-mandated Streamable HTTP session DELETE so teardown never blocks on a hung server */
const SESSION_TERMINATION_TIMEOUT = 5000;
const TOOL_LIST_REFRESH_RETRY_BASE_MS = 250;
const TOOL_LIST_REFRESH_RETRY_MAX_MS = 30_000;
/** Max 307/308 redirects to follow per request (prevents redirect loops) */
const MAX_REDIRECTS = 5;
const DEFAULT_MCP_STREAMABLE_HTTP_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MCP_STREAMABLE_HTTP_MAX_LINE_BYTES = 5 * 1024 * 1024;

function getNonNegativeIntegerEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') {
    return defaultValue;
  }

  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return defaultValue;
  }

  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : defaultValue;
}

function bytesToMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function getMemoryDebugSnapshot(): Record<string, string> {
  const mem = process.memoryUsage();
  return {
    rss: bytesToMiB(mem.rss),
    heapUsed: bytesToMiB(mem.heapUsed),
    heapTotal: bytesToMiB(mem.heapTotal),
    external: bytesToMiB(mem.external),
    arrayBuffers: bytesToMiB(mem.arrayBuffers ?? 0),
  };
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
type JSONRPCRequestId = string | number;

function getChunkBytes(chunk: unknown): Uint8Array {
  if (typeof chunk === 'string') {
    return textEncoder.encode(chunk);
  }
  if (chunk instanceof ArrayBuffer) {
    return new Uint8Array(chunk);
  }
  if (ArrayBuffer.isView(chunk)) {
    const view = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    return new Uint8Array(view);
  }
  return new Uint8Array();
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) {
    return new Uint8Array();
  }
  if (chunks.length === 1) {
    return chunks[0];
  }
  const totalLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function getBodyText(body: unknown): string | null {
  if (typeof body === 'string') {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return textDecoder.decode(new Uint8Array(body));
  }
  if (ArrayBuffer.isView(body)) {
    return textDecoder.decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  }
  return null;
}

function getJSONRPCRequestIds(body: unknown): JSONRPCRequestId[] {
  const bodyText = getBodyText(body);
  if (!bodyText) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return [];
  }

  const messages = Array.isArray(parsed) ? parsed : [parsed];
  return messages.flatMap((message) => {
    if (!message || typeof message !== 'object') {
      return [];
    }
    const jsonrpcMessage = message as { id?: unknown; method?: unknown };
    const { id } = jsonrpcMessage;
    if (typeof jsonrpcMessage.method !== 'string') {
      return [];
    }
    if (typeof id !== 'string' && typeof id !== 'number') {
      return [];
    }
    return [id];
  });
}

function buildBlockedMCPResponseMessage(
  reason: string,
  details: {
    maxResponseBytes: number;
    maxLineBytes: number;
    totalBytes: number;
    currentLineBytes: number;
    chunkCount: number;
  },
): string {
  const limitDetails =
    reason === 'MCP response exceeded byte limit'
      ? `limit=${details.maxResponseBytes} bytes, observed=${details.totalBytes} bytes`
      : `lineLimit=${details.maxLineBytes} bytes, observedLine=${details.currentLineBytes} bytes, observedTotal=${details.totalBytes} bytes`;

  return `[MCP] ${reason} (${limitDetails}, chunks=${details.chunkCount}). The MCP server returned an unsafe streamable HTTP response; narrow the tool result or retry after the server response is fixed.`;
}

function buildBlockedMCPResponseSSE(requestIds: JSONRPCRequestId[], message: string): Uint8Array {
  const events = requestIds
    .map((id) => {
      const payload = {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32000,
          message,
        },
      };
      return `data: ${JSON.stringify(payload)}\n\n`;
    })
    .join('');
  return textEncoder.encode(events);
}

function getMCPStreamableHTTPResponseLimits(
  appProfile = false,
  operationLimits?: TMCPAppOperationLimits,
): {
  maxResponseBytes: number;
  maxLineBytes: number;
} {
  if (appProfile) {
    // Validated App-profile policy owns both bounds. Generic transport env defaults are for
    // standard sessions and must not silently reject an operator-approved larger App event.
    const maxBytes = getMCPAppOperationLimits(operationLimits).maxBytes;
    return { maxResponseBytes: maxBytes, maxLineBytes: maxBytes };
  }
  return {
    maxResponseBytes: getNonNegativeIntegerEnv(
      'MCP_STREAMABLE_HTTP_MAX_RESPONSE_BYTES',
      DEFAULT_MCP_STREAMABLE_HTTP_MAX_RESPONSE_BYTES,
    ),
    maxLineBytes: getNonNegativeIntegerEnv(
      'MCP_STREAMABLE_HTTP_MAX_LINE_BYTES',
      DEFAULT_MCP_STREAMABLE_HTTP_MAX_LINE_BYTES,
    ),
  };
}

async function guardMCPStreamableHTTPResponse(
  response: UndiciResponse,
  context: {
    logPrefix: string;
    method: string;
    url: string;
    requestIds?: JSONRPCRequestId[];
    appProfile?: boolean;
    operationLimits?: TMCPAppOperationLimits;
    onAppSSEOverflow?: () => void;
  },
): Promise<UndiciResponse> {
  const contentType = response.headers.get('content-type') ?? '';
  const isEventStream = mediaTypeEssence(contentType) === 'text/event-stream';
  if (context.method === 'GET') {
    if (!context.appProfile) return response;
    if (isEventStream && response.ok) {
      return guardMCPAppSSEEvents(
        response as unknown as Response,
        getMCPAppOperationLimits(context.operationLimits).maxBytes,
        context.onAppSSEOverflow,
      ) as unknown as UndiciResponse;
    }
    // SDK GET error paths may call response.text(); bound those as ordinary HTTP bodies,
    // including non-2xx responses mislabelled as an event stream.
  }
  if (!response.body) {
    return response;
  }

  const { maxResponseBytes, maxLineBytes } = getMCPStreamableHTTPResponseLimits(
    context.appProfile,
    context.operationLimits,
  );
  const canEmitFallbackSSEError = isEventStream && maxLineBytes > 0;
  // SSE streams can emit many bounded events; cumulative bytes must not end a healthy App session.
  const fitsAppEvent =
    isEventStream && response.ok && context.appProfile
      ? createMCPAppSSEEventGuard(maxResponseBytes)
      : undefined;
  if (!isEventStream && maxResponseBytes === 0) {
    return response;
  }
  if (maxResponseBytes === 0 && maxLineBytes === 0) {
    return response;
  }

  let totalBytes = 0;
  let currentLineBytes = 0;
  let chunkCount = 0;
  let pendingSSELineChunks: Uint8Array[] = [];
  const sseEventDataLines: string[] = [];
  const unresolvedRequestIds = new Set(context.requestIds ?? []);

  const buildAndLogBlockedError = (reason: string, details: Record<string, unknown>): Error => {
    const message = buildBlockedMCPResponseMessage(reason, {
      maxResponseBytes,
      maxLineBytes,
      totalBytes,
      currentLineBytes,
      chunkCount,
    });
    logger.warn(`${context.logPrefix} MCP streamable HTTP response blocked: ${reason}`, {
      method: context.method,
      status: response.status,
      maxResponseBytes,
      maxLineBytes,
      totalBytes,
      currentLineBytes,
      chunkCount,
      ...details,
      memory: getMemoryDebugSnapshot(),
    });
    return new Error(message);
  };

  const trackSSELineForResolvedIds = (lineBytes: Uint8Array): void => {
    if (unresolvedRequestIds.size === 0) {
      return;
    }

    const rawLine = textDecoder.decode(lineBytes).replace(/[\r\n]+$/, '');
    if (rawLine === '') {
      if (sseEventDataLines.length === 0) {
        return;
      }
      const data = sseEventDataLines.join('\n');
      sseEventDataLines.length = 0;
      try {
        const parsed = JSON.parse(data) as { id?: unknown };
        if (typeof parsed.id === 'string' || typeof parsed.id === 'number') {
          unresolvedRequestIds.delete(parsed.id);
        }
      } catch {
        /** Ignore malformed SSE data here; the SDK parser will report it. */
      }
      return;
    }

    const separatorIndex = rawLine.indexOf(':');
    const field = separatorIndex === -1 ? rawLine : rawLine.slice(0, separatorIndex);
    if (field !== 'data') {
      return;
    }
    let value = separatorIndex === -1 ? '' : rawLine.slice(separatorIndex + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    sseEventDataLines.push(value);
  };

  const enqueuePendingSSELine = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (pendingSSELineChunks.length === 0) {
      return;
    }
    const lineBytes = concatBytes(pendingSSELineChunks);
    pendingSSELineChunks = [];
    trackSSELineForResolvedIds(lineBytes);
    controller.enqueue(lineBytes);
  };

  const blockResponse = (
    controller: TransformStreamDefaultController<Uint8Array>,
    reason: string,
    details: Record<string, unknown>,
  ) => {
    const error = buildAndLogBlockedError(reason, details);
    const fallbackRequestIds = [...unresolvedRequestIds];
    if (canEmitFallbackSSEError && fallbackRequestIds.length > 0) {
      controller.enqueue(buildBlockedMCPResponseSSE(fallbackRequestIds, error.message));
      controller.terminate();
      return;
    }
    throw error;
  };

  const guardedBody = (response.body as unknown as ReadableStream<unknown>).pipeThrough(
    new TransformStream<unknown, Uint8Array>({
      transform(chunk, controller) {
        const bytes = getChunkBytes(chunk);
        if (bytes.byteLength === 0) {
          return;
        }

        chunkCount += 1;
        totalBytes += bytes.byteLength;

        if (
          maxResponseBytes > 0 &&
          (fitsAppEvent ? !fitsAppEvent(bytes) : totalBytes > maxResponseBytes)
        ) {
          blockResponse(controller, 'MCP response exceeded byte limit', {
            chunkBytes: bytes.byteLength,
          });
          return;
        }

        if (isEventStream && maxLineBytes > 0) {
          let segmentStart = 0;
          for (let i = 0; i < bytes.byteLength; i++) {
            const byte = bytes[i];
            if (byte === 10 || byte === 13) {
              if (i + 1 > segmentStart) {
                pendingSSELineChunks.push(copyBytes(bytes.subarray(segmentStart, i + 1)));
              }
              enqueuePendingSSELine(controller);
              segmentStart = i + 1;
              currentLineBytes = 0;
              continue;
            }
            currentLineBytes += 1;
            if (currentLineBytes > maxLineBytes) {
              blockResponse(controller, 'MCP response contained an oversized SSE line', {
                chunkBytes: bytes.byteLength,
              });
              return;
            }
          }
          if (segmentStart < bytes.byteLength) {
            pendingSSELineChunks.push(copyBytes(bytes.subarray(segmentStart)));
          }
          return;
        }

        controller.enqueue(bytes);
      },
      flush(controller) {
        enqueuePendingSSELine(controller);
      },
    }),
  );

  return new Response(guardedBody as unknown as BodyInit, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers as unknown as HeadersInit,
  }) as unknown as UndiciResponse;
}

/**
 * Headers stripped before forwarding a request across an origin boundary on
 * 307/308 redirects, mirroring browser/Fetch-spec behavior. These headers can
 * carry credentials (OAuth bearer, MCP session, cookies) that an attacker
 * controlling a redirecting MCP endpoint could otherwise exfiltrate by sending
 * a `Location` to a host they own.
 */
const CROSS_ORIGIN_FORBIDDEN_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'mcp-session-id',
]);

/**
 * Normalizes a fetch input + init pair so the redirect loop only ever has
 * to deal with `(string, init)`. When `input` is a `Request`, its method,
 * headers, and body are baked into the returned init — explicit init values
 * win (matching Fetch-spec semantics) and the body is buffered with
 * `arrayBuffer()` so 307/308 retries can replay it on the new URL. Without
 * this, switching `url` to a `Location` string on redirect would silently
 * drop the original POST method and request payload.
 */
async function resolveFetchInput(
  input: UndiciRequestInfo,
  init: UndiciRequestInit | undefined,
): Promise<{ urlString: string; resolvedInit: UndiciRequestInit | undefined }> {
  if (typeof input === 'string') {
    return { urlString: input, resolvedInit: init };
  }
  if (input instanceof URL) {
    return { urlString: input.href, resolvedInit: init };
  }
  /**
   * Treat anything else as a `Request`. Duck-typed instead of
   * `instanceof undici.Request` because requests handed to a generic fetch
   * wrapper can come from a different undici realm and fail the prototype
   * check while still implementing the same shape. The `as unknown as` cast
   * is needed because undici's `Headers` and DOM's `Headers` have
   * incompatible declared shapes even though they are interchangeable at
   * runtime for the methods we use.
   */
  const req = input as unknown as {
    url: string;
    method: string;
    headers: { entries: () => Iterable<[string, string]> };
    body: unknown;
    signal: AbortSignal | null;
    arrayBuffer: () => Promise<ArrayBuffer>;
  };
  const reqHeaders = Object.fromEntries(req.headers.entries());
  const initHeaders = normalizeInitHeaders(init);
  const mergedHeaders = { ...reqHeaders, ...initHeaders };
  /** Body must be buffered before we hand it off — the original stream is
   * single-shot, so a redirect retry with the same stream would crash with
   * `body has been read`. Empty/no-body Requests skip the read entirely. */
  const reqBody = req.body ? await req.arrayBuffer() : undefined;
  /** Forward the `Request`'s abort signal so callers that wired up an
   * `AbortController` (for timeout / user-cancellation) keep working after
   * we re-shape the input into `(string, init)`. Explicit `init.signal`
   * still wins per Fetch-spec semantics. */
  const signal = init?.signal ?? req.signal ?? undefined;
  return {
    urlString: req.url,
    resolvedInit: {
      ...init,
      method: init?.method ?? req.method,
      body: init?.body ?? (reqBody as unknown as UndiciRequestInit['body']),
      headers: mergedHeaders,
      signal,
    },
  };
}

function normalizeInitHeaders(init: UndiciRequestInit | undefined): Record<string, string> {
  if (!init?.headers) {
    return {};
  }
  if (init.headers instanceof Headers) {
    return Object.fromEntries(init.headers.entries());
  }
  if (Array.isArray(init.headers)) {
    return Object.fromEntries(init.headers);
  }
  return init.headers as Record<string, string>;
}

function buildFetchInit(
  init: UndiciRequestInit | undefined,
  dispatcher: Dispatcher,
  requestHeaders: Record<string, string> | null | undefined,
): UndiciRequestInit {
  const hasInitHeaders = init?.headers != null;
  const hasRuntimeHeaders = requestHeaders != null && Object.keys(requestHeaders).length > 0;
  /**
   * If neither `init.headers` nor runtime headers contribute anything, leave
   * `headers` off the returned init entirely. Setting `headers: {}` would
   * blow away the headers carried on a `Request` input — auth/session tokens
   * and protocol negotiation headers — even when no redirect is involved.
   */
  if (!hasInitHeaders && !hasRuntimeHeaders) {
    return { ...init, redirect: 'manual', dispatcher };
  }
  const initHeaders = normalizeInitHeaders(init);
  const headers = hasRuntimeHeaders ? { ...initHeaders, ...requestHeaders } : initHeaders;
  return {
    ...init,
    redirect: 'manual',
    headers,
    dispatcher,
  };
}

function getUrlPort(url: URL | string): string {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  if (parsed.port) return parsed.port;
  if (parsed.protocol === 'http:' || parsed.protocol === 'ws:') return '80';
  if (parsed.protocol === 'https:' || parsed.protocol === 'wss:') return '443';
  return '';
}

function getTrimmedEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const rawValue = process.env[key];
    if (rawValue != null) {
      return rawValue.trim() || undefined;
    }
  }
  return undefined;
}

function getMCPProxyConfig(options: t.MCPOptions): MCPProxyConfig | undefined {
  const configuredProxy =
    'proxy' in options && typeof options.proxy === 'string' ? options.proxy.trim() : '';
  if (configuredProxy) {
    return { type: 'explicit', proxyUrl: configuredProxy };
  }

  const libreChatProxy = process.env.PROXY?.trim() ?? '';
  if (libreChatProxy) {
    return { type: 'explicit', proxyUrl: libreChatProxy };
  }

  const httpProxy = getTrimmedEnv('http_proxy', 'HTTP_PROXY');
  const httpsProxy = getTrimmedEnv('https_proxy', 'HTTPS_PROXY');
  if (!httpProxy && !httpsProxy) {
    return undefined;
  }

  return {
    type: 'env',
    httpProxy,
    httpsProxy,
    noProxy: getTrimmedEnv('no_proxy', 'NO_PROXY'),
  };
}

function parseIPv4ToBigInt(ip: string): bigint | null {
  const octets = ip.split('.');
  if (octets.length !== 4) {
    return null;
  }

  let value = BIGINT_ZERO;
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet)) {
      return null;
    }
    const parsed = Number.parseInt(octet, 10);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255) {
      return null;
    }
    value = (value << BIGINT_EIGHT) + BigInt(parsed);
  }
  return value;
}

function parseIPv6ToBigInt(ip: string): bigint | null {
  let normalized = ip.toLowerCase().replace(/^\[|\]$/g, '');
  const zoneIndex = normalized.indexOf('%');
  if (zoneIndex !== -1) {
    normalized = normalized.slice(0, zoneIndex);
  }

  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    if (lastColon === -1) {
      return null;
    }
    const ipv4Value = parseIPv4ToBigInt(normalized.slice(lastColon + 1));
    if (ipv4Value == null) {
      return null;
    }
    const hi = Number((ipv4Value >> BIGINT_SIXTEEN) & UINT16_MASK).toString(16);
    const lo = Number(ipv4Value & UINT16_MASK).toString(16);
    normalized = `${normalized.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) {
    return null;
  }

  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0 || (halves.length === 1 && left.length !== 8)) {
    return null;
  }

  const parts = [...left, ...Array<string>(missing).fill('0'), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) {
    return null;
  }

  return parts.reduce(
    (value, part) => (value << BIGINT_SIXTEEN) + BigInt(Number.parseInt(part, 16)),
    BIGINT_ZERO,
  );
}

function parseIPLiteral(value: string): ParsedIP | null {
  const normalized = value
    .toLowerCase()
    .trim()
    .replace(/^\[|\]$/g, '');
  const version = isIP(normalized);
  if (version === 4) {
    const parsed = parseIPv4ToBigInt(normalized);
    return parsed == null ? null : { version: 4, bits: 32, value: parsed };
  }
  if (version === 6) {
    const parsed = parseIPv6ToBigInt(normalized);
    return parsed == null ? null : { version: 6, bits: 128, value: parsed };
  }
  return null;
}

function ipMatchesCIDR(hostname: string, cidr: string): boolean {
  const [rangeAddress, prefixLength, extra] = cidr.split('/');
  if (!rangeAddress || prefixLength == null || extra != null || !/^\d+$/.test(prefixLength)) {
    return false;
  }

  const hostIP = parseIPLiteral(hostname);
  const rangeIP = parseIPLiteral(rangeAddress);
  if (!hostIP || !rangeIP || hostIP.version !== rangeIP.version) {
    return false;
  }

  const prefix = Number.parseInt(prefixLength, 10);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > rangeIP.bits) {
    return false;
  }

  const bits = BigInt(rangeIP.bits);
  const mask =
    prefix === 0
      ? BIGINT_ZERO
      : (((BIGINT_ONE << bits) - BIGINT_ONE) << BigInt(rangeIP.bits - prefix)) &
        ((BIGINT_ONE << bits) - BIGINT_ONE);
  return (hostIP.value & mask) === (rangeIP.value & mask);
}

function ipMatchesRange(hostname: string, range: string): boolean {
  const [startAddress, endAddress, extra] = range.split('-');
  if (!startAddress || !endAddress || extra != null) {
    return false;
  }

  const hostIP = parseIPLiteral(hostname);
  const startIP = parseIPLiteral(startAddress);
  const endIP = parseIPLiteral(endAddress);
  if (
    !hostIP ||
    !startIP ||
    !endIP ||
    hostIP.version !== startIP.version ||
    hostIP.version !== endIP.version
  ) {
    return false;
  }

  const min = startIP.value <= endIP.value ? startIP.value : endIP.value;
  const max = startIP.value <= endIP.value ? endIP.value : startIP.value;
  return hostIP.value >= min && hostIP.value <= max;
}

function matchesNoProxyIPPattern(hostname: string, entryHostname: string): boolean {
  if (entryHostname.includes('/')) {
    return ipMatchesCIDR(hostname, entryHostname);
  }
  if (entryHostname.includes('-')) {
    return ipMatchesRange(hostname, entryHostname);
  }
  return false;
}

function getProxyEntryPort(entry: string): {
  hostname: string;
  port: number;
} {
  const trimmed = entry.trim();
  const bracketed = trimmed.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) {
    return {
      hostname: bracketed[1].toLowerCase(),
      port: bracketed[2] ? Number.parseInt(bracketed[2], 10) : 0,
    };
  }

  const separatorCount = (trimmed.match(/:/g) ?? []).length;
  const parsed = separatorCount === 1 ? trimmed.match(/^(.+):(\d+)$/) : null;
  const hostname = (parsed ? parsed[1] : trimmed).replace(/^\[|\]$/g, '').toLowerCase();
  return {
    hostname: hostname.replace(/^\*?\./, ''),
    port: parsed ? Number.parseInt(parsed[2], 10) : 0,
  };
}

function shouldBypassEnvProxy(url: URL, noProxy?: string): boolean {
  if (!noProxy) {
    return false;
  }

  const trimmed = noProxy.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed === '*') {
    return true;
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = Number.parseInt(getUrlPort(url), 10) || 0;

  for (const entry of trimmed.split(/[,\s]/)) {
    if (!entry) {
      continue;
    }
    if (entry === '*') {
      return true;
    }

    const proxyEntry = getProxyEntryPort(entry);
    if (proxyEntry.port && proxyEntry.port !== port) {
      continue;
    }
    if (matchesNoProxyIPPattern(hostname, proxyEntry.hostname)) {
      return true;
    }
    if (hostname === proxyEntry.hostname || hostname.endsWith(`.${proxyEntry.hostname}`)) {
      return true;
    }
  }

  return false;
}

function getProxyUrlForRequest(
  proxyConfig: MCPProxyConfig | undefined,
  urlString: string,
): string | undefined {
  if (!proxyConfig || !urlString) {
    return undefined;
  }
  if (proxyConfig.type === 'explicit') {
    return proxyConfig.proxyUrl;
  }

  const url = new URL(urlString);
  if (shouldBypassEnvProxy(url, proxyConfig.noProxy)) {
    return undefined;
  }
  if (url.protocol === 'https:') {
    return proxyConfig.httpsProxy ?? proxyConfig.httpProxy;
  }
  if (url.protocol === 'http:') {
    return proxyConfig.httpProxy;
  }
  return undefined;
}

function createMCPDispatcher(options: {
  bodyTimeout: number;
  headersTimeout: number;
  proxyUrl?: string;
  keepAliveTimeout?: number;
  keepAliveMaxTimeout?: number;
  connect?: ReturnType<typeof createSSRFSafeUndiciConnect>;
}): ManagedDispatcher {
  const { bodyTimeout, headersTimeout, proxyUrl, keepAliveTimeout, keepAliveMaxTimeout, connect } =
    options;

  const baseOptions = {
    bodyTimeout,
    headersTimeout,
    ...(keepAliveTimeout != null ? { keepAliveTimeout } : {}),
    ...(keepAliveMaxTimeout != null ? { keepAliveMaxTimeout } : {}),
  };

  if (proxyUrl) {
    return new ProxyAgent({
      uri: proxyUrl,
      ...baseOptions,
    });
  }

  return new Agent({
    ...baseOptions,
    ...(connect != null ? { connect } : {}),
  });
}

async function assertProxiedRequestTargetAllowed(
  urlString: string,
  proxyConfig: MCPProxyConfig | undefined,
  useSSRFProtection: boolean,
  allowedAddresses?: string[] | null,
): Promise<void> {
  const proxyUrl = getProxyUrlForRequest(proxyConfig, urlString);
  if (!proxyUrl || !useSSRFProtection) {
    return;
  }

  const targetUrl = new URL(urlString);
  const port = getUrlPort(targetUrl);
  if (isAddressAllowed(targetUrl.hostname, allowedAddresses, port)) {
    return;
  }
  if (!parseIPLiteral(targetUrl.hostname)) {
    throw new Error(
      `SSRF protection: proxied MCP request target "${targetUrl.hostname}" must be an IP literal or an explicitly allowed host`,
    );
  }

  const isBlockedTarget =
    isSSRFTarget(targetUrl.hostname, allowedAddresses, port) ||
    (await resolveHostnameSSRF(targetUrl.hostname, allowedAddresses, port));

  if (!isBlockedTarget) {
    return;
  }

  throw new Error(
    `SSRF protection: proxied MCP request target "${targetUrl.hostname}" resolved to a private/reserved address`,
  );
}

/**
 * Drops credential-bearing headers when a 307/308 redirect crosses an origin
 * boundary. Removes the always-forbidden set plus any caller-supplied secret
 * headers (runtime `setRequestHeaders` values and config-level API keys).
 */
function stripCrossOriginHeaders(
  headers: Record<string, string>,
  secretHeaderKeys: ReadonlySet<string>,
): Record<string, string> {
  const stripped: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowered = key.toLowerCase();
    if (CROSS_ORIGIN_FORBIDDEN_HEADERS.has(lowered)) {
      continue;
    }
    if (secretHeaderKeys.has(lowered)) {
      continue;
    }
    stripped[key] = value;
  }
  return stripped;
}

interface CircuitBreakerState {
  cycleCount: number;
  cycleWindowStart: number;
  cooldownUntil: number;
  failedRounds: number;
  failedWindowStart: number;
  failedBackoffUntil: number;
}

/** Default body timeout for Streamable HTTP GET SSE streams that idle between server pushes */
const DEFAULT_SSE_READ_TIMEOUT = FIVE_MINUTES;

/**
 * Error message prefixes emitted by the MCP SDK's StreamableHTTPClientTransport
 * (client/streamableHttp.ts → _handleSseStream / _scheduleReconnection).
 * These are SDK-internal strings, not part of a public API. If the SDK changes
 * them, suppression in setupTransportErrorHandlers will silently stop working.
 */
const SDK_SSE_STREAM_DISCONNECTED = 'SSE stream disconnected';
const SDK_SSE_RECONNECT_FAILED = 'Failed to reconnect SSE stream';
const SDK_SSE_RETRIES_EXHAUSTED = 'Maximum reconnection attempts';

/**
 * Headers for SSE connections.
 *
 * Headers we intentionally DO NOT include:
 * - Accept: text/event-stream - Already set by eventsource library AND MCP SDK
 * - X-Accel-Buffering: This is a RESPONSE header for Nginx, not a request header.
 *   The upstream MCP server must send this header for Nginx to respect it.
 * - Connection: keep-alive: Forbidden in HTTP/2 (RFC 7540 §8.1.2.2).
 *   HTTP/2 manages connection persistence differently.
 */
const SSE_REQUEST_HEADERS = {
  'Cache-Control': 'no-cache',
};

interface MCPConnectionParams {
  serverName: string;
  serverConfig: t.MCPOptions;
  userId?: string;
  oauthTokens?: MCPOAuthTokens | null;
  useSSRFProtection?: boolean;
  allowedAddresses?: string[] | null;
  ephemeralConnection?: boolean;
  /** The owner will replace this connection after a tools/list authentication rejection. */
  directBearerRecoveryEnabled?: boolean;
  capabilityProfile?: MCPClientCapabilityProfile;
  operationLimits?: TMCPAppOperationLimits;
}

/** Result of an MCP `tools/list` request: one page of tools plus an optional pagination cursor. */
type MCPListToolsResult = Awaited<ReturnType<Client['listTools']>>;

export interface MCPToolsSnapshot {
  tools: MCPListToolsResult['tools'];
  complete: boolean;
  /** Authentication rejection observed by this exact catalog read. */
  authenticationError?: unknown;
  /** Ordering ticket reserved before this snapshot's `tools/list`; app scope only. */
  publicationRevision?: string;
  /** Set when reserving that ticket failed, which is retryable — unlike a scope that simply
   * has no ordering to reserve, where the ticket is absent because none was ever needed. */
  orderingUnavailable?: boolean;
}

export class MCPConnection extends EventEmitter {
  public client: Client;
  private options: t.MCPOptions;
  private transport: Transport | null = null; // Make this nullable
  private connectionState: t.ConnectionState = 'disconnected';
  private connectPromise: Promise<void> | null = null;
  private readonly MAX_RECONNECT_ATTEMPTS = 3;
  public readonly serverName: string;
  public readonly capabilityProfile: MCPClientCapabilityProfile;
  private readonly operationLimits?: TMCPAppOperationLimits;
  private shouldStopReconnecting = false;
  private isReconnecting = false;
  private isInitializing = false;
  private reconnectAttempts = 0;
  /** Set once per transport, so only the first of a conflict's repeat reports escalates. */
  private reportedStandaloneSseConflict = false;
  private agents: Dispatcher[] = [];
  private readonly userId?: string;
  private lastPingTime: number;
  private lastConnectionCheckAt: number = 0;
  private lastConnectionCheckError?: unknown;
  private lastConnectionCheckCredentialSetId?: string | null;
  private transportCredentialSetId: string | null = null;
  private oauthTokens?: MCPOAuthTokens | null;
  private requestHeaders?: Record<string, string> | null;
  private oauthRequired = false;
  private oauthRecovery = false;
  private readonly useSSRFProtection: boolean;
  private readonly allowedAddresses?: string[] | null;
  private readonly ephemeralConnection: boolean;
  private readonly directBearerRecoveryEnabled: boolean;
  private readonly proxyConfig?: MCPProxyConfig;
  private toolListChangeGeneration = 0;
  private handledToolListChangeGeneration = 0;
  private toolListRefreshFailures = 0;
  private toolListRefreshPromise: Promise<MCPToolsSnapshot | undefined> | null = null;
  private toolListRefreshRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private toolListRefreshEpoch = 0;
  private toolListRefreshSuspended = false;
  private suspendedToolListSnapshot?: MCPToolsSnapshot;
  private publishedToolListSnapshot: {
    epoch: number;
    generation: number;
    tools: MCPListToolsResult['tools'];
    publicationRevision?: string;
  } | null = null;

  private hasConnected = false;
  private isDisposed = false;
  iconPath?: string;
  timeout?: number;
  sseReadTimeout?: number;
  url?: string;

  /**
   * Timestamp when this connection was created.
   * Used to detect if connection is stale compared to updated config.
   */
  public readonly createdAt: number;

  /**
   * Bumped on every tools/list_changed notification. Consumers that cache tool metadata can fold
   * this into their freshness check to detect tool changes that happen on a live connection, which
   * createdAt alone (stable until reconnect) cannot.
   */
  public toolListVersion = 0;

  private static circuitBreakers: Map<string, CircuitBreakerState> = new Map();

  public static clearCooldown(serverName: string): void {
    MCPConnection.circuitBreakers.delete(serverName);
    logger.debug('[MCP] Circuit breaker state cleared');
  }

  private getCircuitBreaker(): CircuitBreakerState {
    let cb = MCPConnection.circuitBreakers.get(this.serverName);
    if (!cb) {
      cb = {
        cycleCount: 0,
        cycleWindowStart: Date.now(),
        cooldownUntil: 0,
        failedRounds: 0,
        failedWindowStart: Date.now(),
        failedBackoffUntil: 0,
      };
      MCPConnection.circuitBreakers.set(this.serverName, cb);
    }
    return cb;
  }

  private isCircuitOpen(): boolean {
    const cb = this.getCircuitBreaker();
    const now = Date.now();
    return now < cb.cooldownUntil || now < cb.failedBackoffUntil;
  }

  private recordCycle(): void {
    const cb = this.getCircuitBreaker();
    const now = Date.now();
    if (now - cb.cycleWindowStart > mcpConfig.CB_CYCLE_WINDOW_MS) {
      cb.cycleCount = 0;
      cb.cycleWindowStart = now;
    }
    cb.cycleCount++;
    if (cb.cycleCount >= mcpConfig.CB_MAX_CYCLES) {
      cb.cooldownUntil = now + mcpConfig.CB_CYCLE_COOLDOWN_MS;
      cb.cycleCount = 0;
      cb.cycleWindowStart = now;
      logger.warn(
        `${this.getLogPrefix()} Circuit breaker: too many cycles, cooling down for ${mcpConfig.CB_CYCLE_COOLDOWN_MS}ms`,
      );
    }
  }

  private recordFailedRound(): void {
    const cb = this.getCircuitBreaker();
    const now = Date.now();
    if (now - cb.failedWindowStart > mcpConfig.CB_FAILED_WINDOW_MS) {
      cb.failedRounds = 0;
      cb.failedWindowStart = now;
    }
    cb.failedRounds++;
    if (cb.failedRounds >= mcpConfig.CB_MAX_FAILED_ROUNDS) {
      const backoff = Math.min(
        mcpConfig.CB_BASE_BACKOFF_MS *
          Math.pow(2, cb.failedRounds - mcpConfig.CB_MAX_FAILED_ROUNDS),
        mcpConfig.CB_MAX_BACKOFF_MS,
      );
      cb.failedBackoffUntil = now + backoff;
      logger.warn(
        `${this.getLogPrefix()} Circuit breaker: too many failures, backing off for ${backoff}ms`,
      );
    }
  }

  private resetFailedRounds(): void {
    const cb = this.getCircuitBreaker();
    cb.failedRounds = 0;
    cb.failedWindowStart = Date.now();
    cb.failedBackoffUntil = 0;
  }

  public static decrementCycleCount(serverName: string): void {
    const cb = MCPConnection.circuitBreakers.get(serverName);
    if (cb && cb.cycleCount > 0) {
      cb.cycleCount--;
    }
  }

  setRequestHeaders(headers: Record<string, string> | null): void {
    if (!headers) {
      return;
    }
    const normalizedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      normalizedHeaders[key.toLowerCase()] = value;
    }
    this.requestHeaders = normalizedHeaders;
  }

  /** Stable routing identity captured by this connection, without live authorization headers. */
  getMCPAppRuntimeTarget(): MCPAppRuntimeTarget {
    return projectMCPAppRuntimeTarget(this.options);
  }

  getRequestHeaders(): Record<string, string> | null | undefined {
    return this.requestHeaders;
  }

  /**
   * Replaces only the runtime bearer, leaving the rest of the per-request headers
   * a tool call installed intact. Runtime headers outrank the ones baked into the
   * transport (see `buildFetchInit`), so a credential refreshed mid-connection has
   * to land here as well or the stale `authorization` from the last tool call would
   * keep winning on the retry.
   */
  setAuthorizationHeader(accessToken: string): void {
    this.requestHeaders = {
      ...(this.requestHeaders ?? {}),
      authorization: `Bearer ${accessToken}`,
    };
  }

  /**
   * Halts reconnect attempts for a credential this connection cannot refresh on its
   * own. Retrying would replay the rejected bearer through every backoff step and
   * spend the circuit breaker's cycle budget; the connection is instead left for its
   * next borrower to dispose and rebuild with a live credential.
   */
  stopReconnecting(): void {
    this.shouldStopReconnecting = true;
  }

  constructor(params: MCPConnectionParams) {
    super();
    this.options = params.serverConfig;
    this.serverName = params.serverName;
    this.capabilityProfile = params.capabilityProfile ?? STANDARD_MCP_CAPABILITY_PROFILE;
    this.operationLimits = params.operationLimits;
    this.userId = params.userId;
    this.useSSRFProtection = params.useSSRFProtection === true;
    this.allowedAddresses = params.allowedAddresses ?? null;
    this.ephemeralConnection = params.ephemeralConnection === true;
    this.directBearerRecoveryEnabled = params.directBearerRecoveryEnabled === true;
    this.proxyConfig = getMCPProxyConfig(params.serverConfig);
    this.iconPath = params.serverConfig.iconPath;
    this.timeout = params.serverConfig.timeout;
    this.sseReadTimeout = params.serverConfig.sseReadTimeout;
    this.lastPingTime = Date.now();
    this.createdAt = Date.now(); // Record creation timestamp for staleness detection
    if (params.oauthTokens) {
      this.oauthTokens = params.oauthTokens;
    }
    const capabilities: ClientCapabilities =
      this.capabilityProfile === MCP_APPS_CAPABILITY_PROFILE
        ? { extensions: { [MCP_UI_EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } } }
        : {};
    this.client = new Client(
      {
        name: '@librechat/api-client',
        version: '1.2.3',
      },
      { capabilities },
    );

    this.setupEventListeners();
  }

  /** Helper to generate consistent log prefixes */
  private getLogPrefix(): string {
    const userPart = this.userId ? `[User: ${this.userId}]` : '';
    return `[MCP]${userPart}`;
  }

  /**
   * Factory function to create fetch functions without capturing the entire `this` context.
   * This helps prevent memory leaks by only passing necessary dependencies.
   *
   * When `sseBodyTimeout` is provided, a second Agent is created with a much longer
   * body timeout for GET requests (the Streamable HTTP SSE stream). POST requests
   * continue using the normal timeout so they fail fast on real errors.
   */
  private createFetchFunction(
    getHeaders: () => Record<string, string> | null | undefined,
    timeout?: number,
    sseBodyTimeout?: number,
    configuredSecretHeaderKeys?: ReadonlySet<string>,
    baseUrl?: string,
    guardStreamableHTTPResponses = false,
  ): (input: UndiciRequestInfo, init?: UndiciRequestInit) => Promise<UndiciResponse> {
    const proxyConfig = this.proxyConfig;
    const useSSRFProtection = this.useSSRFProtection;
    const allowedAddresses = this.allowedAddresses;
    /** Capture only the fields needed by the fetch closure; see factory note above. */
    const agents = this.agents;
    const logPrefix = this.getLogPrefix();
    const rejectDirectBearerAuthentication = this.directBearerRecoveryEnabled;
    const thisAppProfile = this.capabilityProfile === MCP_APPS_CAPABILITY_PROFILE;
    const appOperationLimits = this.operationLimits;
    const effectiveTimeout = timeout || DEFAULT_TIMEOUT;
    const requestDispatchers = new Map<string, ManagedDispatcher>();
    const ssrfConnects = new Map<string, ReturnType<typeof createSSRFSafeUndiciConnect>>();

    const getSSRFConnect = (
      targetPort: string,
      dispatcherAllowedAddresses: string[] | null | undefined,
      forceSafeDirectConnect: boolean,
    ): ReturnType<typeof createSSRFSafeUndiciConnect> => {
      const key = `${forceSafeDirectConnect ? 'redirect' : 'configured'}:${targetPort}`;
      const existingConnect = ssrfConnects.get(key);
      if (existingConnect) {
        return existingConnect;
      }

      const connect = forceSafeDirectConnect
        ? createSSRFSafeUndiciConnect()
        : createSSRFSafeUndiciConnect(dispatcherAllowedAddresses, targetPort);
      ssrfConnects.set(key, connect);
      return connect;
    };

    /**
     * Proxy selection depends on the resolved request URL, not just the
     * configured MCP base URL. SSE message endpoints can be absolute URLs, so
     * cache dispatchers by the target URL's proxy decision and connect policy.
     */
    const getRequestDispatcher = (
      isGetRequest: boolean,
      targetUrlString: string,
      dispatcherAllowedAddresses: string[] | null | undefined,
      forceSafeDirectConnect = false,
    ): ManagedDispatcher => {
      const bodyTimeout =
        isGetRequest && sseBodyTimeout != null ? sseBodyTimeout : effectiveTimeout;
      const proxyUrl = getProxyUrlForRequest(proxyConfig, targetUrlString);
      const targetPort = getUrlPort(targetUrlString);
      const needsSSRFConnect = !proxyUrl && (useSSRFProtection || forceSafeDirectConnect);
      const key = [
        bodyTimeout,
        proxyUrl ?? 'direct',
        needsSSRFConnect ? targetPort : 'open',
        forceSafeDirectConnect ? 'redirect' : 'configured',
      ].join(':');
      const existingAgent = requestDispatchers.get(key);
      if (existingAgent) {
        return existingAgent;
      }

      const connect = needsSSRFConnect
        ? getSSRFConnect(targetPort, dispatcherAllowedAddresses, forceSafeDirectConnect)
        : undefined;
      const agent = createMCPDispatcher({
        bodyTimeout,
        headersTimeout: effectiveTimeout,
        proxyUrl,
        ...(connect != null ? { connect } : {}),
      });
      requestDispatchers.set(key, agent);
      agents.push(agent);
      return agent;
    };

    if (baseUrl) {
      getRequestDispatcher(false, baseUrl, allowedAddresses);
      if (sseBodyTimeout != null) {
        getRequestDispatcher(true, baseUrl, allowedAddresses);
      }
    }

    return async function customFetch(
      input: UndiciRequestInfo,
      init?: UndiciRequestInit,
    ): Promise<UndiciResponse> {
      /**
       * Resolve the input shape upfront so the redirect loop can work with a
       * (string url, init) pair uniformly. When `input` is a `Request`, we
       * pull its method, headers, and body into the init — the body is
       * buffered because `Request.body` is a one-shot stream that can't be
       * replayed across redirect hops, and switching `url` to the new
       * `Location` would otherwise drop the original method/body and turn a
       * redirected POST into a GET with no payload.
       */
      const { urlString, resolvedInit } = await resolveFetchInput(input, init);

      const isGet = (resolvedInit?.method ?? 'GET').toUpperCase() === 'GET';
      const requestHeaders = getHeaders();
      /**
       * Headers that originated from user/server configuration — runtime
       * `setRequestHeaders` plus any keys baked into the transport at
       * construction time (e.g. `serverConfig.headers` API keys). All are
       * treated as credentials and stripped on cross-origin redirect.
       */
      const secretHeaderKeys: ReadonlySet<string> = new Set([
        ...Object.keys(requestHeaders ?? {}).map((key) => key.toLowerCase()),
        ...(configuredSecretHeaderKeys ?? []),
      ]);

      let currentUrlString = urlString;
      let currentAllowedAddresses = allowedAddresses;
      let forceRedirectSSRFConnect = false;
      let currentInit = buildFetchInit(
        resolvedInit,
        getRequestDispatcher(isGet, currentUrlString, currentAllowedAddresses),
        requestHeaders,
      );
      const originalOrigin = new URL(currentUrlString).origin;
      for (let redirects = 0; ; redirects++) {
        await assertProxiedRequestTargetAllowed(
          currentUrlString,
          proxyConfig,
          useSSRFProtection,
          currentAllowedAddresses,
        );
        const response = await undiciFetch(currentUrlString, currentInit);
        if (
          rejectDirectBearerAuthentication &&
          (response.status === 401 || response.status === 403)
        ) {
          await response.body?.cancel().catch(() => undefined);
          throw new MCPTransportAuthenticationError(response.status);
        }
        const isMethodPreservingRedirect = response.status === 307 || response.status === 308;
        const responseContext = {
          logPrefix,
          method: (currentInit?.method ?? 'GET').toUpperCase(),
          url: currentUrlString,
          requestIds: getJSONRPCRequestIds(currentInit?.body),
          appProfile: thisAppProfile,
          operationLimits: appOperationLimits,
        };

        if (!isMethodPreservingRedirect || redirects >= MAX_REDIRECTS) {
          return guardStreamableHTTPResponses
            ? guardMCPStreamableHTTPResponse(response, responseContext)
            : response;
        }

        const location = response.headers.get('location');
        if (!location) {
          return guardStreamableHTTPResponses
            ? guardMCPStreamableHTTPResponse(response, responseContext)
            : response;
        }

        const targetUrl = new URL(location, currentUrlString);
        const isCrossOriginRedirect = targetUrl.origin !== originalOrigin;

        /**
         * Keep the standalone check for immediate literal/current-DNS blocks.
         * Cross-origin allowlist redirects also switch to a connect-time
         * SSRF-safe dispatcher below so DNS rebinding cannot change the
         * address between this check and the socket connection.
         *
         * `allowedAddresses` is intentionally NOT consulted on either layer:
         * redirect targets are server-controlled (the MCP server's response
         * chooses where to send us), so they must not inherit the admin's
         * exemption for the originally-configured URL. A legitimate self-
         * redirect from a permitted private host is still blocked here, by
         * design — letting redirect targets inherit the exemption would open
         * an SSRF amplification primitive.
         */
        if (isSSRFTarget(targetUrl.hostname) || (await resolveHostnameSSRF(targetUrl.hostname))) {
          logger.warn('[MCP] Blocked redirect to private or reserved address');
          return response;
        }

        await response.body?.cancel().catch(() => undefined);

        if (isCrossOriginRedirect && currentInit.headers != null) {
          currentInit = {
            ...currentInit,
            headers: stripCrossOriginHeaders(
              currentInit.headers as Record<string, string>,
              secretHeaderKeys,
            ),
          };
        }

        if (isCrossOriginRedirect) {
          currentAllowedAddresses = null;
          forceRedirectSSRFConnect = true;
          /**
           * Once a server-controlled cross-origin hop is seen, keep the safe
           * dispatcher for the rest of this redirect chain. Restoring the
           * original dispatcher on a later hop back to the original origin
           * would re-open the allowlist-mode rebinding gap. When the original
           * dispatcher carries `allowedAddresses`, this also prevents a
           * redirect from inheriting that port-scoped exemption.
           */
          currentInit = {
            ...currentInit,
            dispatcher: getRequestDispatcher(
              isGet,
              targetUrl.href,
              currentAllowedAddresses,
              forceRedirectSSRFConnect,
            ),
          };
        } else {
          currentInit = {
            ...currentInit,
            dispatcher: getRequestDispatcher(
              isGet,
              targetUrl.href,
              currentAllowedAddresses,
              forceRedirectSSRFConnect,
            ),
          };
        }

        currentUrlString = targetUrl.href;
      }
    };
  }

  private emitError(_error: unknown, errorContext: string): void {
    logger.error(`${this.getLogPrefix()} ${errorContext}`);
  }

  private async constructTransport(options: t.MCPOptions): Promise<Transport> {
    try {
      let type: t.MCPOptions['type'];
      if (isStdioOptions(options)) {
        type = 'stdio';
      } else if (isWebSocketOptions(options)) {
        type = 'websocket';
      } else if (isStreamableHTTPOptions(options)) {
        // Could be either 'streamable-http' or 'http', normalize to 'streamable-http'
        type = 'streamable-http';
      } else if (isSSEOptions(options)) {
        type = 'sse';
      } else {
        throw new Error(
          'Cannot infer transport type: options.type is not provided and cannot be inferred from other properties.',
        );
      }

      switch (type) {
        case 'stdio':
          if (!isStdioOptions(options)) {
            throw new Error('Invalid options for stdio transport.');
          }
          return new StdioClientTransport({
            command: options.command,
            args: options.args,
            // workaround bug of mcp sdk that can't pass env:
            // https://github.com/modelcontextprotocol/typescript-sdk/issues/216
            env: { ...getDefaultEnvironment(), ...(options.env ?? {}) },
            ...(options.cwd !== undefined && { cwd: options.cwd }),
            ...(this.capabilityProfile === MCP_APPS_CAPABILITY_PROFILE && {
              maxBufferSize: getMCPAppOperationLimits(this.operationLimits).maxBytes,
            }),
          });

        case 'websocket': {
          if (!isWebSocketOptions(options)) {
            throw new Error('Invalid options for websocket transport.');
          }
          if (this.capabilityProfile === MCP_APPS_CAPABILITY_PROFILE) {
            // This SDK WebSocket transport JSON.parse's messages before exposing them and offers
            // no maxPayload option. Fail closed for Apps rather than claim a post-parse cap is safe.
            throw new Error('MCP Apps require a transport with a pre-parse response size limit');
          }
          this.url = options.url;
          /**
           * SSRF pre-check: always validate resolved IPs for WebSocket, regardless
           * of allowlist configuration. Allowlisting a domain grants trust to that
           * name, not to whatever IP it resolves to at runtime (DNS rebinding).
           *
           * Note: WebSocketClientTransport does its own DNS resolution, creating a
           * small TOCTOU window. This is an SDK limitation — the transport accepts
           * only a URL with no custom DNS lookup hook.
           */
          const wsUrl = new URL(options.url);
          const wsHostname = wsUrl.hostname;
          const isSSRF = await resolveHostnameSSRF(
            wsHostname,
            this.allowedAddresses,
            getUrlPort(wsUrl),
          );
          if (isSSRF) {
            throw new Error(
              `SSRF protection: WebSocket host "${wsHostname}" resolved to a private/reserved IP address`,
            );
          }
          return new WebSocketClientTransport(new URL(options.url));
        }

        case 'sse': {
          if (!isSSEOptions(options)) {
            throw new Error('Invalid options for sse transport.');
          }
          this.url = options.url;
          const url = new URL(options.url);
          logger.info(`${this.getLogPrefix()} Creating SSE transport`);
          const abortController = new AbortController();

          /** Add OAuth token to headers if available */
          const headers = { ...options.headers };
          if (this.oauthTokens?.access_token) {
            headers['Authorization'] = `Bearer ${this.oauthTokens.access_token}`;
          }

          /**
           * SSE connections need longer timeouts for reliability.
           * The connect timeout is extended because proxies may delay initial response.
           */
          const sseTimeout = this.timeout || SSE_CONNECT_TIMEOUT;
          const sseAgents = new Map<string, ManagedDispatcher>();
          const getSSEDispatcher = (targetUrlString: string): ManagedDispatcher => {
            const proxyUrl = getProxyUrlForRequest(this.proxyConfig, targetUrlString);
            const targetPort = getUrlPort(targetUrlString);
            const key = `${proxyUrl ?? 'direct'}:${this.useSSRFProtection && !proxyUrl ? targetPort : 'open'}`;
            const existingAgent = sseAgents.get(key);
            if (existingAgent) {
              return existingAgent;
            }

            const connect =
              this.useSSRFProtection && !proxyUrl
                ? createSSRFSafeUndiciConnect(this.allowedAddresses, targetPort)
                : undefined;
            const agent = createMCPDispatcher({
              bodyTimeout: sseTimeout,
              headersTimeout: sseTimeout,
              keepAliveTimeout: sseTimeout,
              keepAliveMaxTimeout: sseTimeout * 2,
              proxyUrl,
              ...(connect != null ? { connect } : {}),
            });
            sseAgents.set(key, agent);
            this.agents.push(agent);
            return agent;
          };
          getSSEDispatcher(options.url);
          const sseConfiguredSecretHeaderKeys: ReadonlySet<string> = new Set(
            Object.keys(headers).map((key) => key.toLowerCase()),
          );
          const transport = new SSEClientTransport(url, {
            requestInit: {
              /** User/OAuth headers override SSE defaults */
              headers: { ...SSE_REQUEST_HEADERS, ...headers },
              signal: abortController.signal,
            },
            eventSourceInit: {
              fetch: async (url, init) => {
                const { urlString, resolvedInit } = await resolveFetchInput(
                  url as UndiciRequestInfo,
                  init as UndiciRequestInit,
                );
                await assertProxiedRequestTargetAllowed(
                  urlString,
                  this.proxyConfig,
                  this.useSSRFProtection,
                  this.allowedAddresses,
                );
                /** Merge headers: SSE defaults < init headers < user headers (user wins) */
                const fetchHeaders = Object.assign(
                  {},
                  SSE_REQUEST_HEADERS,
                  resolvedInit?.headers,
                  headers,
                );
                const liveHeaders = this.directBearerRecoveryEnabled
                  ? this.getRequestHeaders()
                  : undefined;
                if (liveHeaders) {
                  for (const key of Object.keys(fetchHeaders)) {
                    const normalized = key.toLowerCase();
                    if (
                      sseConfiguredSecretHeaderKeys.has(normalized) &&
                      liveHeaders[normalized] != null
                    ) {
                      delete fetchHeaders[key];
                      fetchHeaders[normalized] = liveHeaders[normalized];
                    }
                  }
                }
                const response = await undiciFetch(urlString, {
                  ...resolvedInit,
                  redirect: 'manual',
                  dispatcher: getSSEDispatcher(urlString),
                  headers: fetchHeaders,
                });
                return this.capabilityProfile === MCP_APPS_CAPABILITY_PROFILE
                  ? guardMCPStreamableHTTPResponse(response, {
                      logPrefix: this.getLogPrefix(),
                      method: 'GET',
                      url: urlString,
                      appProfile: true,
                      operationLimits: this.operationLimits,
                      onAppSSEOverflow: () => {
                        // Let the SDK observe its stream error and reject an in-flight start before
                        // closing EventSource. Closing synchronously leaves start() pending forever.
                        // A short bounded grace also prevents the SDK's automatic retry loop.
                        const stop = setTimeout(() => {
                          abortController.abort();
                          void transport.close().catch(() => undefined);
                        }, 30);
                        stop.unref?.();
                      },
                    })
                  : response;
              },
            },
            fetch: this.createFetchFunction(
              this.getRequestHeaders.bind(this),
              sseTimeout,
              undefined,
              sseConfiguredSecretHeaderKeys,
              options.url,
              this.capabilityProfile === MCP_APPS_CAPABILITY_PROFILE,
            ) as unknown as FetchLike,
          });

          transport.onclose = () => {
            logger.info(`${this.getLogPrefix()} SSE transport closed`);
            this.emit('connectionChange', 'disconnected');
          };

          this.setupTransportErrorHandlers(transport);
          return transport;
        }

        case 'streamable-http': {
          if (!isStreamableHTTPOptions(options)) {
            throw new Error('Invalid options for streamable-http transport.');
          }
          this.url = options.url;
          const url = new URL(options.url);
          logger.info(`${this.getLogPrefix()} Creating streamable-http transport`);
          const abortController = new AbortController();

          /** Add OAuth token to headers if available */
          const headers = { ...options.headers };
          if (this.oauthTokens?.access_token) {
            headers['Authorization'] = `Bearer ${this.oauthTokens.access_token}`;
          }

          const httpConfiguredSecretHeaderKeys: ReadonlySet<string> = new Set(
            Object.keys(headers).map((key) => key.toLowerCase()),
          );
          const transport = new StreamableHTTPClientTransport(url, {
            requestInit: {
              headers,
              signal: abortController.signal,
            },
            fetch: this.createFetchFunction(
              this.getRequestHeaders.bind(this),
              this.timeout,
              this.sseReadTimeout || DEFAULT_SSE_READ_TIMEOUT,
              httpConfiguredSecretHeaderKeys,
              options.url,
              true,
            ) as unknown as FetchLike,
          });

          transport.onclose = () => {
            logger.info(`${this.getLogPrefix()} Streamable-http transport closed`);
            this.emit('connectionChange', 'disconnected');
          };

          this.setupTransportErrorHandlers(transport);
          return transport;
        }

        default: {
          throw new Error(`Unsupported transport type: ${type}`);
        }
      }
    } catch (error) {
      this.emitError(error, 'Failed to construct transport');
      throw error;
    }
  }

  private setupEventListeners(): void {
    this.isInitializing = true;
    this.on('connectionChange', (state: t.ConnectionState) => {
      this.connectionState = state;
      this.suspendedToolListSnapshot = undefined;
      if (state === 'connected') {
        this.lastConnectionCheckError = undefined;
        this.lastConnectionCheckCredentialSetId = undefined;
        const isReconnect = this.hasConnected;
        this.hasConnected = true;
        this.toolListRefreshSuspended = false;
        this.isReconnecting = false;
        this.isInitializing = false;
        this.shouldStopReconnecting = false;
        this.reconnectAttempts = 0;
        if (isReconnect) {
          if (this.client.getServerCapabilities()?.tools != null) {
            this.toolListChangeGeneration++;
          } else {
            this.handledToolListChangeGeneration = this.toolListChangeGeneration;
            this.toolListRefreshFailures = 0;
            this.dispatchToolsChanged([]);
          }
        }
        if (this.handledToolListChangeGeneration < this.toolListChangeGeneration) {
          this.startToolListRefresh();
        }
        /**
         * // FOR DEBUGGING
         * // this.client.setRequestHandler(PingRequestSchema, async (request, extra) => {
         * //    logger.info(`[MCP][${this.serverName}] PingRequest: ${JSON.stringify(request)}`);
         * //    if (getEventListeners && extra.signal) {
         * //      const listenerCount = getEventListeners(extra.signal, 'abort').length;
         * //      logger.debug(`Signal has ${listenerCount} abort listeners`);
         * //    }
         * //    return {};
         * //  });
         */
      } else {
        /** Invalidate work started on the previous transport. A reconnect can complete before an
         * old `tools/list` request settles, so checking connectionState alone is not sufficient. */
        this.toolListRefreshEpoch++;
        this.toolListRefreshSuspended = true;
        this.clearToolListRefreshRetry();
      }

      if (state === 'error' && !this.isReconnecting && !this.isInitializing) {
        this.handleReconnection().catch(() => {
          logger.error(`${this.getLogPrefix()} Reconnection handler failed`);
        });
      }
    });

    this.subscribeToResources();
    this.subscribeToToolListChanges();
  }

  private async handleReconnection(): Promise<void> {
    if (
      this.isReconnecting ||
      this.shouldStopReconnecting ||
      this.isInitializing ||
      this.oauthRequired
    ) {
      if (this.oauthRequired) {
        logger.info(`${this.getLogPrefix()} OAuth required, skipping reconnection attempts`);
      }
      return;
    }

    this.isReconnecting = true;
    const backoffDelay = (attempt: number) => {
      const base = Math.min(1000 * Math.pow(2, attempt), 30000);
      const jitter = Math.floor(Math.random() * 1000); // up to 1s of random jitter
      return base + jitter;
    };

    try {
      while (
        this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS &&
        !(this.shouldStopReconnecting as boolean)
      ) {
        this.reconnectAttempts++;
        const delay = backoffDelay(this.reconnectAttempts);

        logger.info(
          `${this.getLogPrefix()} Reconnecting ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS} (delay: ${delay}ms)`,
        );

        await new Promise((resolve) => setTimeout(resolve, delay));

        try {
          await this.connect();
          this.reconnectAttempts = 0;
          return;
        } catch (error) {
          logger.error(`${this.getLogPrefix()} Reconnection attempt failed`);

          // Stop immediately if rate limited - retrying will only make it worse
          if (this.isRateLimitError(error)) {
            /**
             * Rate limiting sets shouldStopReconnecting to prevent hammering the server.
             * Silent return here (vs throw in connectClient) because we're already in
             * error recovery mode - throwing would just add noise. The connection
             * must be recreated to retry after rate limit lifts.
             */
            logger.warn(
              `${this.getLogPrefix()} Rate limited (429), stopping reconnection attempts`,
            );
            logger.debug(
              `${this.getLogPrefix()} Rate limit block is permanent for this connection instance`,
            );
            this.shouldStopReconnecting = true;
            return;
          }

          if (
            this.reconnectAttempts === this.MAX_RECONNECT_ATTEMPTS ||
            (this.shouldStopReconnecting as boolean)
          ) {
            logger.error(`${this.getLogPrefix()} Stopping reconnection attempts`);
            return;
          }
        }
      }
    } finally {
      this.isReconnecting = false;
    }
  }

  private subscribeToResources(): void {
    this.client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
      this.emit('resourcesChanged');
    });
  }

  /**
   * A server that builds tools at runtime tells us so instead of us polling for it.
   *
   * The spec's list-changed flow is: the server notifies, the client asks for the list again. Until
   * this was handled the tool list stayed at whatever it was when the connection came up, so a
   * server that adds a tool mid-session was invisible until a restart (#7117).
   */
  private subscribeToToolListChanges(): void {
    this.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      logger.debug(`${this.getLogPrefix()} Server reported a changed tool list`);
      // Stamps the MCP Apps per-tool metadata caches (resourceUri, visibility) as stale; createdAt
      // alone cannot see a list change on a still-live connection.
      this.toolListVersion += 1;
      await this.refreshToolList();
    });
  }

  /** Queues a live tool-list refresh through the same coalescing path used by notifications. */
  public async refreshToolList(signal?: AbortSignal): Promise<MCPToolsSnapshot | undefined> {
    signal?.throwIfAborted();
    this.toolListChangeGeneration++;
    this.clearToolListRefreshRetry();
    this.startToolListRefresh(signal);
    const refresh = this.toolListRefreshPromise;
    if (signal && refresh) {
      await this.settlesBefore(refresh, undefined, signal);
      signal.throwIfAborted();
    }
    return (await refresh) ?? this.suspendedToolListSnapshot;
  }

  private clearToolListRefreshRetry(): void {
    if (this.toolListRefreshRetryTimer) {
      clearTimeout(this.toolListRefreshRetryTimer);
      this.toolListRefreshRetryTimer = null;
    }
  }

  private scheduleToolListRefreshRetry(): void {
    if (
      this.isDisposed ||
      this.toolListRefreshSuspended ||
      this.connectionState !== 'connected' ||
      this.toolListRefreshRetryTimer
    ) {
      return;
    }

    const delay = Math.min(
      TOOL_LIST_REFRESH_RETRY_BASE_MS * Math.pow(2, Math.max(0, this.toolListRefreshFailures - 1)),
      TOOL_LIST_REFRESH_RETRY_MAX_MS,
    );
    this.toolListRefreshRetryTimer = setTimeout(() => {
      this.toolListRefreshRetryTimer = null;
      this.startToolListRefresh();
    }, delay);
    this.toolListRefreshRetryTimer.unref?.();
  }

  private startToolListRefresh(signal?: AbortSignal): void {
    if (
      this.isDisposed ||
      this.toolListRefreshSuspended ||
      this.connectionState !== 'connected' ||
      this.toolListRefreshPromise
    ) {
      return;
    }

    this.toolListRefreshPromise = this.refreshChangedTools(signal).finally(() => {
      this.toolListRefreshPromise = null;
      if (
        !this.toolListRefreshRetryTimer &&
        this.handledToolListChangeGeneration < this.toolListChangeGeneration
      ) {
        this.startToolListRefresh();
      }
    });
  }

  private async refreshChangedTools(signal?: AbortSignal): Promise<MCPToolsSnapshot | undefined> {
    const refreshEpoch = this.toolListRefreshEpoch;
    let latestSnapshot: MCPToolsSnapshot | undefined;
    while (this.handledToolListChangeGeneration < this.toolListChangeGeneration) {
      const targetGeneration = this.toolListChangeGeneration;
      const snapshot: MCPToolsSnapshot =
        this.client.getServerCapabilities()?.tools == null
          ? { tools: [], complete: true, ...(await this.reserveToolsPublicationRevision()) }
          : await this.fetchToolsSnapshot(undefined, signal);
      if (signal?.aborted) {
        if (this.toolListRefreshEpoch === refreshEpoch) {
          this.toolListRefreshSuspended = true;
        }
        return;
      }
      latestSnapshot = snapshot;
      if (
        this.toolListRefreshEpoch !== refreshEpoch ||
        this.toolListRefreshSuspended ||
        this.connectionState !== 'connected'
      ) {
        return;
      }
      /** Publishing unordered would drop this catalog silently; retry until it can be ordered. */
      if (!snapshot.complete || snapshot.orderingUnavailable) {
        if (snapshot.authenticationError && this.directBearerRecoveryEnabled) {
          /** Keep the stopped queue's outcome available to an owner arriving after settlement. */
          this.suspendedToolListSnapshot = snapshot;
          this.toolListRefreshSuspended = true;
          return snapshot;
        }
        this.toolListRefreshFailures++;
        this.scheduleToolListRefreshRetry();
        return;
      }

      this.toolListRefreshFailures = 0;
      this.handledToolListChangeGeneration = targetGeneration;
      this.publishedToolListSnapshot = {
        epoch: refreshEpoch,
        generation: targetGeneration,
        tools: snapshot.tools,
        publicationRevision: snapshot.publicationRevision,
      };
      this.dispatchToolsChanged(snapshot.tools, snapshot.publicationRevision);
    }
    return latestSnapshot;
  }

  private dispatchToolsChanged(
    tools: MCPListToolsResult['tools'],
    publicationRevision?: string,
  ): void {
    try {
      this.emit('toolsChanged', tools, publicationRevision);
    } catch (error) {
      logger.error(`${this.getLogPrefix()} Failed to dispatch refreshed tools:`, error);
    }
  }

  async connectClient(): Promise<void> {
    if (this.connectionState === 'connected') {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    if (this.shouldStopReconnecting) {
      return;
    }

    if (this.isCircuitOpen()) {
      this.connectionState = 'error';
      this.emit('connectionChange', 'error');
      throw new Error(`${this.getLogPrefix()} Circuit breaker is open, connection attempt blocked`);
    }

    this.emit('connectionChange', 'connecting');

    this.connectPromise = (async () => {
      let rejectedCredentialSetId = this.oauthTokens?.credential_set_id ?? null;
      try {
        if (this.transport) {
          try {
            await this.terminateStreamableSession();
            await this.client.close();
          } catch {
            logger.warn(`${this.getLogPrefix()} Error closing connection`);
          }
          this.transport = null;
          await this.closeAgents();
        }

        this.transport = await runOutsideTracing(() => this.constructTransport(this.options));
        rejectedCredentialSetId = this.getOAuthCredentialSetId();
        /** `dispose()` can land while the transport is still being constructed — it finds nothing
         *  to close and returns, so without this check the attempt would go on to connect and
         *  leave a live connection on a disposed object. Ownership of teardown is ours here. */
        if (await this.abandonIfDisposed()) {
          return;
        }
        this.patchTransportSend();

        const connectTimeout = this.options.initTimeout ?? DEFAULT_INIT_TIMEOUT;
        await runOutsideTracing(() =>
          withTimeout(
            this.client.connect(this.transport!),
            connectTimeout,
            `Connection timeout after ${connectTimeout}ms`,
          ),
        );

        if (await this.abandonIfDisposed()) {
          return;
        }
        this.setupTransportOnMessageHandler();
        this.connectionState = 'connected';
        this.emit('connectionChange', 'connected');
        this.reconnectAttempts = 0;
        this.resetFailedRounds();
        if (this.oauthRecovery) {
          MCPConnection.decrementCycleCount(this.serverName);
          this.oauthRecovery = false;
          logger.debug(
            `${this.getLogPrefix()} OAuth recovery: decremented cycle count after successful reconnect`,
          );
        }
      } catch (error) {
        if (this.isDisposed) {
          throw error;
        }
        // Check if it's a rate limit error - stop immediately to avoid making it worse
        if (this.isRateLimitError(error)) {
          /**
           * Rate limiting sets shouldStopReconnecting to prevent hammering the server.
           * This is a permanent block for this connection instance - the connection
           * must be recreated (e.g., by user re-initiating) to retry after rate limit lifts.
           *
           * We throw here (unlike handleReconnection which returns silently) because:
           * - connectClient() is a public API - callers expect async errors to throw
           * - Other errors in this catch block also throw for consistency
           * - handleReconnection is private/internal error recovery, different context
           */
          logger.warn(`${this.getLogPrefix()} Rate limited (429), stopping connection attempts`);
          this.shouldStopReconnecting = true;
          this.connectionState = 'error';
          this.emit('connectionChange', 'error');
          throw error;
        }

        // Check if it's an OAuth authentication error
        if (
          this.directBearerRecoveryEnabled
            ? isMCPTransportAuthenticationError(error)
            : isOAuthAuthenticationError(error)
        ) {
          logger.warn(`${this.getLogPrefix()} OAuth authentication required`);
          this.oauthRequired = true;
          const serverUrl = this.url;
          logger.debug(`${this.getLogPrefix()} OAuth server URL state`, {
            hasServerUrl: Boolean(serverUrl),
          });

          const oauthTimeout = mcpConfig.OAUTH_HANDLING_TIMEOUT;
          /** Promise that will resolve when OAuth is handled */
          const oauthHandledPromise = new Promise<void>((resolve, reject) => {
            let timeoutId: NodeJS.Timeout | null = null;
            let oauthHandledListener: (() => void) | null = null;
            let oauthFailedListener: ((error: Error) => void) | null = null;

            /** Cleanup function to remove listeners and clear timeout */
            const cleanup = () => {
              if (timeoutId) {
                clearTimeout(timeoutId);
              }
              if (oauthHandledListener) {
                this.off('oauthHandled', oauthHandledListener);
              }
              if (oauthFailedListener) {
                this.off('oauthFailed', oauthFailedListener);
              }
            };

            // Success handler
            oauthHandledListener = () => {
              cleanup();
              resolve();
            };

            // Failure handler
            oauthFailedListener = (error: Error) => {
              cleanup();
              reject(error);
            };

            // Timeout handler
            timeoutId = setTimeout(() => {
              cleanup();
              reject(new Error(`OAuth handling timeout after ${oauthTimeout}ms`));
            }, oauthTimeout);

            // Listen for both success and failure events
            this.once('oauthHandled', oauthHandledListener);
            this.once('oauthFailed', oauthFailedListener);
          });

          // Emit the event
          this.emit('oauthRequired', {
            rejectedCredentialSetId,
            serverName: this.serverName,
            error,
            serverUrl,
            userId: this.userId,
          });

          try {
            // Wait for OAuth to be handled
            await oauthHandledPromise;
            this.oauthRequired = false;
            this.oauthRecovery = true;
            logger.info(
              `${this.getLogPrefix()} OAuth handled successfully, connection will be retried`,
            );
            return;
          } catch {
            // OAuth failed or timed out
            this.oauthRequired = false;
            logger.error(`${this.getLogPrefix()} OAuth handling failed`);
            // Re-throw the original authentication error
            throw error;
          }
        }

        this.connectionState = 'error';
        this.emit('connectionChange', 'error');
        this.recordFailedRound();
        throw error;
      } finally {
        this.connectPromise = null;
      }
    })();

    return this.connectPromise;
  }

  /**
   * Tears down a transport this attempt created after the connection was already disposed.
   * Returns whether the caller should abandon the rest of the connect sequence.
   */
  private async abandonIfDisposed(): Promise<boolean> {
    if (!this.isDisposed) {
      return false;
    }
    logger.debug(`${this.getLogPrefix()} Disposed mid-connect; discarding the transport it opened`);
    const transport = this.transport;
    this.transport = null;
    /** Closing the client only closes a transport the client has already adopted, which it has
     *  not when disposal beat `client.connect()`. Close the transport itself first, or the
     *  session this attempt opened outlives the connection that owned it. */
    try {
      await transport?.close();
    } catch {
      // Ignore cleanup errors
    }
    try {
      await this.client.close();
    } catch {
      // Ignore cleanup errors
    }
    return true;
  }

  private patchTransportSend(): void {
    if (!this.transport) {
      return;
    }

    const originalSend = this.transport.send.bind(this.transport);
    this.transport.send = async (msg) => {
      if ('result' in msg && !('method' in msg) && Object.keys(msg.result ?? {}).length === 0) {
        if (Date.now() - this.lastPingTime < FIVE_MINUTES) {
          throw new Error('Empty result');
        }
        this.lastPingTime = Date.now();
      }
      const method = 'method' in msg ? msg.method : undefined;
      const id = 'id' in msg ? (msg as { id: string | number | null }).id : undefined;
      logger.debug(
        `${this.getLogPrefix()} Transport sending: method=${method ?? 'response'} id=${id ?? 'none'}`,
      );
      return originalSend(msg);
    };
  }

  private setupTransportOnMessageHandler(): void {
    if (!this.transport?.onmessage) {
      return;
    }

    const sdkHandler = this.transport.onmessage;
    this.transport.onmessage = (msg) => {
      const method = 'method' in msg ? msg.method : undefined;
      const id = 'id' in msg ? (msg as { id: string | number | null }).id : undefined;
      logger.debug(
        `${this.getLogPrefix()} Transport received: method=${method ?? 'response'} id=${id ?? 'none'}`,
      );
      sdkHandler(msg);
    };
  }

  async connect(): Promise<void> {
    try {
      /**
       * Persistent connections preserve cycle tracking across reconnects so the
       * circuit breaker can detect storms. Request-scoped connections are
       * intentionally short-lived per tool call, so their clean lifecycle should
       * not consume the reconnect-storm cycle budget.
       */
      await this.disconnect(this.ephemeralConnection);
      await this.connectClient();
      if (!(await this.isConnected())) {
        throw new Error('Connection not established');
      }
    } catch (error) {
      logger.error(`${this.getLogPrefix()} Connection failed`);
      throw error;
    }
  }

  private setupTransportErrorHandlers(transport: Transport): void {
    this.reportedStandaloneSseConflict = false;
    const transportCredentialSetId = this.oauthTokens?.credential_set_id ?? null;
    this.transportCredentialSetId = transportCredentialSetId;

    transport.onerror = (error) => {
      const rawMessage =
        error && typeof error === 'object' ? ((error as { message?: string }).message ?? '') : '';

      /**
       * The MCP SDK's StreamableHTTPClientTransport fires onerror for SSE GET stream
       * disconnects but also handles reconnection internally via _scheduleReconnection.
       * Escalating these to a full transport rebuild creates a redundant reconnection
       * loop. Log at debug level and let the SDK recover the GET stream on its own.
       *
       * "Maximum reconnection attempts … exceeded" means the SDK gave up — that one
       * must fall through so our higher-level reconnection takes over.
       */
      if (
        rawMessage.startsWith(SDK_SSE_STREAM_DISCONNECTED) ||
        rawMessage.startsWith(SDK_SSE_RECONNECT_FAILED)
      ) {
        logger.debug(`${this.getLogPrefix()} SDK SSE stream recovery in progress`);
        return;
      }

      /**
       * A stale server-side stream can only be cleared by rebuilding the session, so escalate
       * on the first report and treat the rest as the echo they are: the SDK keeps retrying the
       * `GET` on its own schedule, and each of those retries conflicts for the same reason while
       * the rebuild triggered here is already running.
       */
      if (isStandaloneSseConflict(error)) {
        if (this.reportedStandaloneSseConflict) {
          logger.debug(
            `${this.getLogPrefix()} SSE stream still conflicting; session rebuild already underway`,
          );
          return;
        }

        this.reportedStandaloneSseConflict = true;
        logger.warn(
          `${this.getLogPrefix()} SSE stream conflicted with a stale server-side stream for this ` +
            `session (409). Rebuilding the session; no action needed.`,
        );
        this.emit('connectionChange', 'error');
        return;
      }

      /**
       * The SDK announcing it is out of retries normally has to fall through so our reconnection
       * takes over, but adds nothing once a conflict rebuild is already running — that rebuild is
       * what exhausted the retries, and it is the recovery.
       */
      if (this.reportedStandaloneSseConflict && rawMessage.startsWith(SDK_SSE_RETRIES_EXHAUSTED)) {
        logger.debug(
          `${this.getLogPrefix()} SDK reconnection budget exhausted; session rebuild already underway`,
        );
        return;
      }

      const {
        message: errorMessage,
        code: errorCode,
        isProxyHint,
        isTransient,
      } = extractSSEErrorMessage(error);

      if (errorCode === 400 || errorCode === 404 || errorCode === 405 || errorCode === 406) {
        const hasSession =
          'sessionId' in transport &&
          (transport as { sessionId?: string }).sessionId != null &&
          (transport as { sessionId?: string }).sessionId !== '';

        if (!hasSession && errorMessage.toLowerCase().includes('failed to open sse stream')) {
          logger.warn(
            `${this.getLogPrefix()} SSE stream not available (${errorCode}), no session. Ignoring.`,
          );
          return;
        }

        if (hasSession) {
          logger.warn(
            `${this.getLogPrefix()} ${errorCode} with active session — session lost, triggering reconnection.`,
          );
        }
      }

      // Check if it's an OAuth authentication error
      if (
        this.directBearerRecoveryEnabled
          ? isMCPTransportAuthenticationError(error)
          : isOAuthAuthenticationError(error)
      ) {
        logger.warn(`${this.getLogPrefix()} OAuth authentication error detected`);
        this.lastConnectionCheckError = error;
        this.lastConnectionCheckCredentialSetId = transportCredentialSetId;
        this.connectionState = 'error';
        this.emit('oauthError', error);
        return;
      }

      /**
       * Log with enhanced context for debugging.
       * All transport.onerror events are logged as errors to preserve stack traces.
       * isTransient indicates whether auto-reconnection is expected to succeed.
       *
       * The MCP SDK's SseError extends Error and includes:
       * - code: HTTP status code or eventsource error code
       * - event: The original eventsource ErrorEvent
       * - stack: Full stack trace
       */
      const errorContext: Record<string, unknown> = {
        code: errorCode,
        isTransient,
      };

      if (isProxyHint) {
        errorContext.hint = 'Check Nginx/proxy configuration for SSE endpoints';
      }

      const errorLabel = isTransient
        ? 'Transport error (transient, will reconnect)'
        : 'Transport error (may require manual intervention)';

      logger.error(`${this.getLogPrefix()} ${errorLabel}`, errorContext);

      this.emit('connectionChange', 'error');
    };
  }

  private async closeAgents(force = false): Promise<void> {
    const logPrefix = this.getLogPrefix();
    const closing = this.agents.map((agent) =>
      (force ? agent.destroy() : agent.close()).catch(() => {
        logger.debug(`${logPrefix} Agent close error (non-fatal)`);
      }),
    );
    this.agents = [];
    await Promise.all(closing);
  }

  /**
   * Ends a Streamable HTTP session with the spec-mandated `HTTP DELETE` before
   * the transport is discarded. Stateful MCP servers (the SDK default) keep each
   * session's transport, tasks, and buffers in memory with no TTL, so without an
   * explicit DELETE every idle eviction, reconnect, or restart leaks one
   * server-side session. Must run before `client.close()`, which aborts the
   * transport's controller and would cancel the in-flight DELETE.
   *
   * `terminateSession()` no-ops when there is no session id and already tolerates
   * a 405 (server opts out of termination). Any other failure is non-fatal to
   * teardown, so it is bounded by a timeout and swallowed.
   *
   * The transport's `onerror` is detached first: on any non-405 failure (the
   * session already expired, a network error, or `client.close()` aborting the
   * request after the timeout) `terminateSession()` invokes `onerror` before
   * rejecting. Left attached, our handler would emit `connectionChange('error')`
   * and trigger `handleReconnection()`, reopening the connection we are tearing
   * down and re-leaking the session. The transport is discarded right after, so
   * clearing the handler is safe.
   */
  private async terminateStreamableSession(): Promise<void> {
    if (!(this.transport instanceof StreamableHTTPClientTransport)) {
      return;
    }
    this.transport.onerror = undefined;
    try {
      await withTimeout(
        this.transport.terminateSession(),
        SESSION_TERMINATION_TIMEOUT,
        `Streamable HTTP session termination timed out after ${SESSION_TERMINATION_TIMEOUT}ms`,
      );
    } catch {
      logger.debug(`${this.getLogPrefix()} Error terminating streamable HTTP session`);
    }
  }

  public async disconnect(resetCycleTracking = true, forceAgentClose = false): Promise<void> {
    this.toolListRefreshEpoch++;
    this.suspendedToolListSnapshot = undefined;
    this.toolListRefreshSuspended = true;
    this.clearToolListRefreshRetry();
    try {
      if (this.transport) {
        await this.terminateStreamableSession();
        await this.client.close();
        this.transport = null;
      }
      await this.closeAgents(forceAgentClose);
      if (this.connectionState === 'disconnected') {
        return;
      }
      this.connectionState = 'disconnected';
      this.emit('connectionChange', 'disconnected');
    } finally {
      this.connectPromise = null;
      if (!resetCycleTracking) {
        this.recordCycle();
      }
    }
  }

  /** Permanently tears down a connection that will never be reused. */
  public async dispose(): Promise<void> {
    this.isDisposed = true;
    this.clearToolListRefreshRetry();
    this.shouldStopReconnecting = true;
    this.removeAllListeners();
    await this.disconnect(true, true);
  }

  async fetchResources(): Promise<t.MCPResource[]> {
    try {
      const { resources } = await this.client.listResources();
      return resources;
    } catch (error) {
      this.emitError(error, 'Failed to fetch resources');
      return [];
    }
  }

  /**
   * Fetches the server's tools, following MCP `tools/list` cursor pagination so a
   * server that spans multiple pages (e.g. an aggregating gateway exposing many
   * tools) is loaded in full instead of being truncated to the first page.
   *
   * Pagination is bounded by {@link mcpConfig.TOOLS_LIST_MAX_PAGES}, aggregate
   * tool count, approximate serialized size, elapsed time, and a repeated-cursor
   * guard. On error, the tools already fetched are returned rather than discarded,
   * and the method never throws.
   */
  async fetchTools(): Promise<MCPListToolsResult['tools']> {
    return (await this.fetchToolsSnapshot()).tools;
  }

  /**
   * Fetches a bounded tool snapshot while preserving whether every requested page succeeded.
   * Notification refreshes use `complete` to avoid replacing a known-good cache with an empty or
   * partial list after a transient `tools/list` failure.
   *
   * @param deadlineMs Absolute epoch-ms cap for a caller working to a fixed budget. Pagination
   * stops at whichever comes first, this or `TOOLS_LIST_TIMEOUT_MS`, and the partial result is
   * returned as incomplete so it is never published as an authoritative catalog.
   * @param signal Cancels the in-flight `tools/list` request itself, not just the wait for it —
   * the SDK raises an abort from `request()` and the failed page ends pagination gracefully.
   */
  public async fetchToolsSnapshot(
    deadlineMs?: number,
    signal?: AbortSignal,
  ): Promise<MCPToolsSnapshot> {
    const maxPages = mcpConfig.TOOLS_LIST_MAX_PAGES;
    const maxTools = mcpConfig.TOOLS_LIST_MAX_TOOLS;
    const maxBytes = mcpConfig.TOOLS_LIST_MAX_BYTES;
    /** A spent budget ends the fetch before the reservation below spends cache round trips on an
     *  ordering this incomplete result can never publish under. */
    if ((deadlineMs != null && Date.now() >= deadlineMs) || signal?.aborted === true) {
      this.warnToolsListBudgetExceeded('time', 0);
      return { tools: [], complete: false };
    }
    /** Reserved before the first page so the resulting catalog can never outrank one published
     * from a `tools/list` that started later. Every app-level publisher reads its ordering off
     * the snapshot it received, which is the only way to know when the data was actually read. */
    const ordering = await this.reserveToolsPublicationRevision();
    const budgetDeadline = Date.now() + mcpConfig.TOOLS_LIST_TIMEOUT_MS;
    const deadline = deadlineMs != null ? Math.min(budgetDeadline, deadlineMs) : budgetDeadline;
    const allTools: MCPListToolsResult['tools'] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let totalBytes = 0;
    const snapshot = (complete: boolean, authenticationError?: unknown): MCPToolsSnapshot => ({
      tools: allTools,
      complete,
      ...(authenticationError != null && { authenticationError }),
      ...ordering,
    });

    for (let page = 1; page <= maxPages; page++) {
      const exhaustedBudget = getToolsListBudgetExceededReason(
        allTools.length,
        totalBytes,
        maxTools,
        maxBytes,
      );
      if (exhaustedBudget != null) {
        this.warnToolsListBudgetExceeded(exhaustedBudget, allTools.length);
        return snapshot(true);
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        this.warnToolsListBudgetExceeded('time', allTools.length);
        return snapshot(false);
      }

      let result: MCPListToolsResult;
      try {
        result = await this.listToolsPage(cursor, remainingMs, signal);
      } catch (error) {
        /** Request failed mid-pagination: return the pages already fetched instead of discarding them. */
        return snapshot(false, isMCPTransportAuthenticationError(error) ? error : undefined);
      }

      for (const tool of result.tools) {
        if (allTools.length >= maxTools) {
          this.warnToolsListBudgetExceeded('tool count', allTools.length);
          return snapshot(true);
        }

        const toolBytes = getApproximateToolBytes(tool);
        if (totalBytes + toolBytes > maxBytes) {
          this.warnToolsListBudgetExceeded('size', allTools.length);
          return snapshot(true);
        }

        allTools.push(tool);
        totalBytes += toolBytes;
      }

      const { nextCursor } = result;
      if (nextCursor == null) {
        return snapshot(true);
      }

      const nextPageBudget = getToolsListBudgetExceededReason(
        allTools.length,
        totalBytes,
        maxTools,
        maxBytes,
      );
      if (nextPageBudget != null) {
        this.warnToolsListBudgetExceeded(nextPageBudget, allTools.length);
        return snapshot(true);
      }

      if (seenCursors.has(nextCursor)) {
        logger.warn(
          `${this.getLogPrefix()} MCP server returned a repeated tools/list cursor; stopping pagination after ${page} page(s).`,
        );
        return snapshot(false);
      }

      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    logger.warn(
      `${this.getLogPrefix()} Reached the tools/list pagination limit of ${maxPages} page(s); some tools may be omitted. Set MCP_TOOLS_LIST_MAX_PAGES higher if this server legitimately exposes more.`,
    );
    return snapshot(true);
  }

  /**
   * Allocates app-catalog ordering. A reservation failure must not fail the request that asked
   * for the tools, so it is reported on the snapshot for publishers to retry on instead.
   */
  public async reserveToolsPublicationRevision(): Promise<{
    publicationRevision?: string;
    orderingUnavailable?: boolean;
  }> {
    try {
      return {
        publicationRevision: await reserveMCPToolsChangedRevision({
          serverName: this.serverName,
          serverConfig: this.options,
          userId: this.userId,
          capabilityProfile: this.capabilityProfile,
        }),
      };
    } catch (error) {
      logger.warn(`${this.getLogPrefix()} Failed to reserve tool-list publication order:`, error);
      return { orderingUnavailable: true };
    }
  }

  /**
   * Returns a complete snapshot that cannot precede a concurrent `list_changed` refresh.
   * If the notification refresh cannot complete, the caller receives an incomplete snapshot
   * instead of publishing a request result that may already be stale.
   *
   * @param deadlineMs Absolute epoch-ms cap; see `fetchToolsSnapshot`. It also bounds the wait
   * for a concurrent refresh, so a caller on a budget is never held by another caller's fetch.
   * @param signal Cancels this caller's own `tools/list` requests; see `fetchToolsSnapshot`. A
   * concurrent refresh is shared work and is never aborted on one caller's behalf.
   */
  public async fetchOrderedToolsSnapshot(
    deadlineMs?: number,
    signal?: AbortSignal,
  ): Promise<MCPToolsSnapshot> {
    const startEpoch = this.toolListRefreshEpoch;
    const startGeneration = this.toolListChangeGeneration;
    const snapshot = await this.fetchToolsSnapshot(deadlineMs, signal);

    if (
      startEpoch === this.toolListRefreshEpoch &&
      startGeneration === this.toolListChangeGeneration
    ) {
      return snapshot;
    }

    while (
      startEpoch === this.toolListRefreshEpoch &&
      this.handledToolListChangeGeneration < this.toolListChangeGeneration
    ) {
      if ((deadlineMs != null && Date.now() >= deadlineMs) || signal?.aborted === true) {
        break;
      }
      this.startToolListRefresh();
      const refresh = this.toolListRefreshPromise;
      if (!refresh) {
        break;
      }
      /** The refresh runs on the connection's own budget, not the caller's, so a refresh already
       *  in flight can outlast this deadline — and a cancelled caller must stop waiting even
       *  though the shared refresh itself is never aborted on one caller's behalf. Stop waiting
       *  rather than adopting its budget; it keeps running for whoever else wants it and this
       *  caller reports an incomplete read. */
      if (deadlineMs == null && signal == null) {
        await refresh;
      } else if (!(await this.settlesBefore(refresh, deadlineMs, signal))) {
        break;
      }
      if (this.toolListRefreshRetryTimer) {
        break;
      }
    }

    const published = this.publishedToolListSnapshot;
    if (
      published?.epoch === this.toolListRefreshEpoch &&
      published.generation === this.toolListChangeGeneration &&
      this.handledToolListChangeGeneration === this.toolListChangeGeneration
    ) {
      /** Ordering travels with the data: this is the refresh's catalog, so it must publish under
       * the refresh's revision rather than the one reserved for the superseded fetch above. */
      return {
        tools: published.tools,
        complete: true,
        publicationRevision: published.publicationRevision,
      };
    }

    if (
      startEpoch === this.toolListRefreshEpoch &&
      !signal?.aborted &&
      (deadlineMs == null || Date.now() < deadlineMs) &&
      this.suspendedToolListSnapshot
    ) {
      return this.suspendedToolListSnapshot;
    }

    return { tools: [], complete: false };
  }

  /** Waits for `promise` only until `deadlineMs` or an abort, reporting whether it settled first. */
  private async settlesBefore(
    promise: Promise<unknown>,
    deadlineMs?: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted === true) {
      return false;
    }
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<false>((resolve) => {
      if (deadlineMs != null) {
        timer = setTimeout(() => resolve(false), Math.max(0, deadlineMs - Date.now()));
        timer.unref?.();
      }
      if (signal != null) {
        onAbort = () => resolve(false);
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    try {
      return await Promise.race([promise.then(() => true), interrupted]);
    } finally {
      clearTimeout(timer);
      if (onAbort != null) {
        signal?.removeEventListener('abort', onAbort);
      }
    }
  }

  private warnToolsListBudgetExceeded(reason: string, toolCount: number): void {
    logger.warn(
      `${this.getLogPrefix()} Stopping tools/list pagination because the ${reason} budget was reached after ${toolCount} tool(s).`,
    );
  }

  /** Fetches one `tools/list` page. The public snapshot interface classifies any rejection. */
  private async listToolsPage(
    cursor: string | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<MCPListToolsResult> {
    try {
      return await withMCPRequestSignal(signal, (requestSignal) =>
        this.client.listTools(cursor != null ? { cursor } : undefined, {
          timeout: timeoutMs,
          maxTotalTimeout: timeoutMs,
          signal: requestSignal,
        }),
      );
    } catch (error) {
      this.emitError(error, 'Failed to fetch tools');
      throw error;
    }
  }

  async fetchPrompts(): Promise<t.MCPPrompt[]> {
    try {
      const { prompts } = await this.client.listPrompts();
      return prompts;
    } catch (error) {
      this.emitError(error, 'Failed to fetch prompts');
      return [];
    }
  }

  /**
   * @param signal Aborts the in-flight verification request (ping or its fallback) so a caller on
   * a budget is not held for the probe's own SDK timeout. An aborted probe reports `false` for
   * this caller only; it never mutates connection state, so a shared connection stays usable.
   */
  public async isConnected(signal?: AbortSignal): Promise<boolean> {
    // First check if we're in a connected state
    if (this.connectionState !== 'connected') {
      return false;
    }

    // If we recently checked, skip expensive verification
    const now = Date.now();
    if (now - this.lastConnectionCheckAt < mcpConfig.CONNECTION_CHECK_TTL) {
      return true;
    }
    let probeCredentialSetId = this.getOAuthCredentialSetId();
    const previousCheckAt = this.lastConnectionCheckAt;
    this.lastConnectionCheckAt = now;
    this.lastConnectionCheckError = undefined;
    this.lastConnectionCheckCredentialSetId = undefined;
    /** An aborted probe answered nothing: restore the TTL stamp so the next caller probes for
     *  real, instead of a dead shared connection reading as healthy for the whole TTL window. */
    const probeAborted = (): boolean => signal?.aborted === true;
    const abandonProbe = (): false => {
      this.lastConnectionCheckAt = previousCheckAt;
      logger.debug(`${this.getLogPrefix()} Health probe aborted by caller signal`);
      return false;
    };

    try {
      // Try ping first as it's the lightest check
      await withMCPRequestSignal(signal, (requestSignal) =>
        this.client.ping({ signal: requestSignal }),
      );
      return this.connectionState === 'connected';
    } catch (error) {
      if (probeAborted()) {
        return abandonProbe();
      }
      // Check if the error is because ping is not supported (method not found)
      const pingUnsupported =
        error instanceof Error &&
        ((error as Error)?.message.includes('-32601') ||
          (error as Error)?.message.includes('-32602') ||
          (error as Error)?.message.includes('invalid method ping') ||
          (error as Error)?.message.includes('Unsupported method: ping') ||
          (error as Error)?.message.includes('method not found'));

      if (!pingUnsupported) {
        this.lastConnectionCheckError = error;
        this.lastConnectionCheckCredentialSetId = probeCredentialSetId;
        logger.error(`${this.getLogPrefix()} Ping failed`);
        return false;
      }

      // Ping is not supported by this server, try an alternative verification
      logger.debug(
        `${this.getLogPrefix()} Server does not support ping method, verifying connection with capabilities`,
      );

      try {
        probeCredentialSetId = this.getOAuthCredentialSetId();
        // Get server capabilities to verify connection is truly active
        const capabilities = this.client.getServerCapabilities();

        // If we have capabilities, try calling a supported method to verify connection
        if (capabilities?.tools) {
          await withMCPRequestSignal(signal, (requestSignal) =>
            this.client.listTools(undefined, { signal: requestSignal }),
          );
          return this.connectionState === 'connected';
        } else if (capabilities?.resources) {
          await withMCPRequestSignal(signal, (requestSignal) =>
            this.client.listResources(undefined, { signal: requestSignal }),
          );
          return this.connectionState === 'connected';
        } else if (capabilities?.prompts) {
          await withMCPRequestSignal(signal, (requestSignal) =>
            this.client.listPrompts(undefined, { signal: requestSignal }),
          );
          return this.connectionState === 'connected';
        } else {
          // No capabilities to test, but we're in connected state and initialization succeeded
          logger.debug(
            `${this.getLogPrefix()} No capabilities to test, assuming connected based on state`,
          );
          return this.connectionState === 'connected';
        }
      } catch (capabilityError) {
        if (probeAborted()) {
          return abandonProbe();
        }
        // If capability check fails, the connection is likely broken
        this.lastConnectionCheckError = capabilityError;
        this.lastConnectionCheckCredentialSetId = probeCredentialSetId;
        logger.error(`${this.getLogPrefix()} Connection verification failed`);
        return false;
      }
    }
  }

  /** Identifies the installed transport credential; pending replacement tokens are not sent yet. */
  public getOAuthCredentialSetId(): string | null {
    return this.transport
      ? this.transportCredentialSetId
      : (this.oauthTokens?.credential_set_id ?? null);
  }

  public setOAuthTokens(tokens: MCPOAuthTokens): void {
    this.oauthTokens = tokens;
  }

  /** Whether this connection's resolved runtime config uses MCP OAuth. */
  public usesOAuth(): boolean {
    return isOAuthServer(this.options);
  }

  public isOAuthAuthenticationError(error: unknown): boolean {
    return isOAuthAuthenticationError(error);
  }

  public getLastConnectionCheckCredentialSetId(): string | null | undefined {
    return this.lastConnectionCheckCredentialSetId;
  }

  public getLastConnectionCheckError(): unknown {
    return this.lastConnectionCheckError;
  }

  /**
   * Check if this connection is stale compared to config update time.
   * A connection is stale if it was created before the config was updated.
   *
   * @param configUpdatedAt - Unix timestamp (ms) when config was last updated
   * @returns true if connection was created before config update, false otherwise
   */
  public isStale(configUpdatedAt: number): boolean {
    return this.createdAt < configUpdatedAt;
  }

  /**
   * Checks if an error indicates rate limiting (HTTP 429).
   * Rate limited requests should stop reconnection attempts to avoid making the situation worse.
   */
  private isRateLimitError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    // Check for error code
    if ('code' in error) {
      const code = (error as { code?: number }).code;
      if (code === 429) {
        return true;
      }
    }

    // Check message for rate limit indicators
    if ('message' in error && typeof error.message === 'string') {
      const message = error.message.toLowerCase();
      if (
        message.includes('429') ||
        message.includes('rate limit') ||
        message.includes('too many requests')
      ) {
        return true;
      }
    }

    return false;
  }
}
