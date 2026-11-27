/** A listener's `server.address()`. */
export interface BoundAddress {
  address: string;
  family?: string | number;
  port: number;
}

/** Resolve an HTTP origin that reaches the current process's bound listener. */
export function selfOriginFromAddress(
  address: BoundAddress | string | null | undefined,
): string | null {
  if (address == null || typeof address === 'string' || !address.port) {
    return null;
  }
  const bound = address.address;
  const isIPv6 = address.family === 'IPv6' || address.family === 6 || bound.includes(':');
  const loopback = isIPv6 ? '::1' : '127.0.0.1';
  const isWildcard = bound === '' || bound === '::' || bound === '0.0.0.0';
  const host = isWildcard ? loopback : bound;
  return `http://${isIPv6 ? `[${host}]` : host}:${address.port}`;
}
