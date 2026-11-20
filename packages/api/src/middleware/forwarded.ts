import type { IncomingHttpHeaders } from 'http';

/**
 * Picks the X-Forwarded headers safe to log. The forwarded-for chain holds client addresses, so only
 * its hop count is reported.
 */
export function getForwardedHeaders(headers: IncomingHttpHeaders): Record<string, string | number> {
  const forwarded: Record<string, string | number> = {};
  const forwardedFor = headers['x-forwarded-for'];
  if (forwardedFor) {
    forwarded['x-forwarded-for-hops'] = String(forwardedFor).split(',').length;
  }
  const host = headers['x-forwarded-host'];
  if (host) {
    forwarded['x-forwarded-host'] = String(host);
  }
  const proto = headers['x-forwarded-proto'];
  if (proto) {
    forwarded['x-forwarded-proto'] = String(proto);
  }
  return forwarded;
}
