import { validateHeaderValue } from 'node:http';
import { logger } from '@librechat/data-schemas';
import { RUM_COLLECTOR_ACK_HEADER } from 'librechat-data-provider';
import type { Request, Response, RequestHandler } from 'express';
import type { RumProxyEndpoint, RumProxyResult } from '~/app/metrics';
import { recordRumProxyRequest } from '~/app/metrics';
import { isEnabled } from '~/utils';

const DEFAULT_PROXY_PATH = '/api/rum';
const DEFAULT_BODY_LIMIT = '3mb';
const DEFAULT_TIMEOUT_MS = 10_000;
const OTLP_PATHS = new Set(['/v1/traces', '/v1/logs']);
/** OTLP/HTTP encodings; anything else is refused before a body is forwarded. */
const OTLP_CONTENT_TYPES = new Set([
  'application/json',
  'application/x-protobuf',
  'application/octet-stream',
]);

function normalizeBasePath(pathname: string): string {
  if (pathname === '/') {
    return '';
  }

  return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

export function getRumProxyClientUrl(): string {
  return DEFAULT_PROXY_PATH;
}

export function getRumProxyBodyLimit(): string {
  return process.env.RUM_PROXY_BODY_LIMIT?.trim() || DEFAULT_BODY_LIMIT;
}

export function getRumProxyTimeoutMs(): number {
  const parsed = Number(process.env.RUM_PROXY_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

export function getRumProxyTargetBaseUrl(): URL | undefined {
  const value = process.env.RUM_PROXY_TARGET_URL?.trim();
  if (!value) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  if (url.username || url.password || url.search || url.hash) {
    return undefined;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return undefined;
  }

  return url;
}

export function isRumProxyEnabled(): boolean {
  return (
    isEnabled(process.env.RUM_ENABLED) &&
    process.env.RUM_AUTH_MODE === 'proxy' &&
    getRumProxyTargetBaseUrl() != null
  );
}

/**
 * Whether browsers export client logger warnings/errors as OTLP logs. Opt-in with
 * `RUM_CLIENT_LOGS=true`, like console capture, so enabling RUM never starts a new log stream on
 * its own; proxy mode only, so the logs reach the collector through session auth and never with
 * a browser-held ingestion key.
 */
export function isRumClientLogsEnabled(): boolean {
  return isRumProxyEnabled() && isEnabled(process.env.RUM_CLIENT_LOGS);
}

/**
 * Whether the proxy accepts OTLP logs at all. Only client logs, SDK console capture and SDK
 * session replay produce browser logs, so with all three off the logs route refuses even tabs
 * still holding an older startup config, which makes turning `RUM_CLIENT_LOGS` off authoritative.
 */
export function isRumLogsEndpointEnabled(): boolean {
  if (!isRumProxyEnabled()) {
    return false;
  }
  const replaySetting = process.env.RUM_DISABLE_REPLAY?.trim();
  const replayEnabled = !!replaySetting && !isEnabled(replaySetting);
  return (
    isEnabled(process.env.RUM_CLIENT_LOGS) ||
    isEnabled(process.env.RUM_CONSOLE_CAPTURE) ||
    replayEnabled
  );
}

/** HTTP gates stay with the proxy policy rather than the CJS route wiring. */
export const requireRumProxyEnabled: RequestHandler = (_req, res, next) => {
  if (!isRumProxyEnabled()) {
    res.status(404).json({ message: 'RUM proxy is not configured' });
    return;
  }
  next();
};

export const requireRumLogsEnabled: RequestHandler = (_req, res, next) => {
  if (!isRumLogsEndpointEnabled()) {
    res.status(404).json({ message: 'RUM logs are not enabled' });
    return;
  }
  next();
};

/** Defer RUM parsing until the authenticated route has applied its request budget. */
export function excludeRumBodyParser(parser: RequestHandler): RequestHandler {
  return (req, res, next) => {
    const path = req.path.toLowerCase();
    if (path === DEFAULT_PROXY_PATH || path.startsWith(`${DEFAULT_PROXY_PATH}/`)) {
      next();
      return;
    }
    parser(req, res, next);
  };
}

export function resolveRumProxyTarget(path: string): string | undefined {
  if (!OTLP_PATHS.has(path)) {
    return undefined;
  }

  const baseUrl = getRumProxyTargetBaseUrl();
  if (!baseUrl) {
    return undefined;
  }

  const targetUrl = new URL(baseUrl.href);
  targetUrl.pathname = `${normalizeBasePath(targetUrl.pathname)}${path}`;
  return targetUrl.href;
}

// Keep in sync with api/server/middleware/requireJwtAuth.js; auth drops are recorded there.
export function getRumProxyEndpoint(path: string): RumProxyEndpoint {
  if (path === '/v1/traces') {
    return 'traces';
  }
  if (path === '/v1/logs') {
    return 'logs';
  }
  return 'unknown';
}

function getRumCollectorResult(status: number): RumProxyResult {
  if (status >= 500) {
    return 'collector_5xx';
  }
  if (status >= 400) {
    return 'collector_4xx';
  }
  return 'success';
}

function getRequestBody(req: Request): Buffer | string | undefined {
  const body = req.body as unknown;

  if (Buffer.isBuffer(body) || typeof body === 'string') {
    return body;
  }

  if (body && typeof body === 'object') {
    return JSON.stringify(body);
  }

  return undefined;
}

function getHeader(req: Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }

  return typeof value === 'string' ? value : undefined;
}

function isOtlpContentType(req: Request): boolean {
  const mediaType = getHeader(req, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType != null && OTLP_CONTENT_TYPES.has(mediaType);
}

function getProxyHeaders(
  req: Request,
  body: Buffer | string,
  authorization: string | undefined,
): Record<string, string> {
  if (authorization) {
    try {
      validateHeaderValue('authorization', authorization);
    } catch {
      throw new Error('Invalid RUM proxy authorization header');
    }
  }

  const contentType =
    getHeader(req, 'content-type') || (typeof body === 'string' ? 'application/json' : undefined);
  const accept = getHeader(req, 'accept');
  return {
    ...(contentType ? { 'content-type': contentType } : {}),
    ...(accept ? { accept } : {}),
    ...(authorization ? { authorization } : {}),
  };
}

export async function proxyRumRequest(
  req: Request,
  res: Response,
  upstreamAuthorization?: string,
): Promise<void> {
  const authorization = upstreamAuthorization?.trim();
  const endpoint = getRumProxyEndpoint(req.path);
  const target = resolveRumProxyTarget(req.path);
  if (!target) {
    recordRumProxyRequest(endpoint, 'not_configured');
    res.status(404).json({ message: 'RUM proxy is not configured' });
    return;
  }

  if (!isOtlpContentType(req)) {
    recordRumProxyRequest(endpoint, 'unsupported_media_type');
    res.status(415).json({ message: 'Unsupported RUM payload content type' });
    return;
  }

  const body = getRequestBody(req);
  if (!body) {
    recordRumProxyRequest(endpoint, 'bad_request');
    res.status(400).json({ message: 'RUM payload is required' });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getRumProxyTimeoutMs());
  try {
    const response = await fetch(target, {
      method: 'POST',
      headers: getProxyHeaders(req, body, authorization),
      redirect: authorization ? 'error' : 'follow',
      // TS 5.9 made `Buffer` generic (`Buffer<ArrayBufferLike>`), which no longer
      // structurally matches `BodyInit`; Node's fetch accepts a Buffer body at runtime.
      body: body as BodyInit,
      signal: controller.signal,
    });

    const contentType = response.headers.get('content-type');
    if (contentType) {
      res.set('content-type', contentType);
    }

    const responseBody = Buffer.from(await response.arrayBuffer());
    recordRumProxyRequest(endpoint, getRumCollectorResult(response.status));
    if (response.status >= 200 && response.status < 300) {
      res.set(RUM_COLLECTOR_ACK_HEADER, 'true');
    }
    res.status(response.status).send(responseBody);
  } catch (error) {
    recordRumProxyRequest(
      endpoint,
      controller.signal.aborted ? 'collector_timeout' : 'collector_error',
    );
    logger.warn('[rumProxy] Failed to proxy RUM telemetry', {
      error: error instanceof Error ? error.message : String(error),
      target,
    });
    res.status(controller.signal.aborted ? 504 : 502).json({
      message: controller.signal.aborted
        ? 'RUM telemetry proxy timed out'
        : 'Failed to proxy RUM telemetry',
    });
  } finally {
    clearTimeout(timeout);
  }
}
