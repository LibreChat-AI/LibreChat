import type { AuditContext } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types/http';

/** Normalizes a possibly-repeated header to its first string value. */
function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' ? value : undefined;
}

/** Extracts forensic request context (IP, user agent, correlation id) for an
 * audit record. Fields are undefined when the data isn't available. */
export function buildAuditContext(req: ServerRequest): AuditContext {
  const headers = req.headers ?? {};
  const forwarded = firstHeaderValue(headers['x-forwarded-for']);
  const forwardedIp = forwarded ? forwarded.split(',')[0]?.trim() : undefined;
  return {
    ip: req.ip || forwardedIp || req.socket?.remoteAddress || undefined,
    userAgent: firstHeaderValue(headers['user-agent']),
    requestId: firstHeaderValue(headers['x-request-id'] ?? headers['x-correlation-id']),
  };
}
