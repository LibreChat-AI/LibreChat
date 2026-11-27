import { logger } from '@librechat/data-schemas';
import type { Server } from 'node:http';

/**
 * Node detects header/request timeout expiry only on `connectionsCheckingInterval`, a
 * `createServer` option that `app.listen()` leaves at its 30s default, so short values
 * take effect late rather than at the configured deadline. `keepAliveTimeout` is
 * socket-driven and stays exact.
 */
const TIMEOUT_SWEEP_RESOLUTION_MS = 30_000;

/**
 * `createServer` throws ERR_OUT_OF_RANGE unless `headersTimeout <= requestTimeout`, treating
 * zero on either side as disabled. Assigning the properties afterwards skips that check, and
 * the resulting mismatch leaves a stalled request body open past the request timeout.
 */
const clampHeadersToRequestTimeout = (server: Server, configuredHeadersTimeout?: number): void => {
  if (server.requestTimeout === 0 || server.headersTimeout === 0) {
    return;
  }
  if (server.headersTimeout <= server.requestTimeout) {
    return;
  }

  const clamped = server.requestTimeout;
  if (configuredHeadersTimeout != null) {
    logger.warn(
      `HTTP_HEADERS_TIMEOUT_MS (${configuredHeadersTimeout}ms) exceeds HTTP_REQUEST_TIMEOUT_MS (${clamped}ms), a pairing Node rejects; clamped to the request timeout.`,
    );
  }
  server.headersTimeout = clamped;
};

const parseTimeout = (value?: string): number | undefined => {
  if (value == null || value.trim() === '') {
    return undefined;
  }

  const timeout = Number(value);
  return Number.isSafeInteger(timeout) && timeout >= 0 ? timeout : undefined;
};

export const configureServerTimeouts = (
  server: Server,
  environment: NodeJS.ProcessEnv = process.env,
  versions: { bun?: string } = process.versions,
): void => {
  const keepAliveTimeout = parseTimeout(environment.HTTP_KEEP_ALIVE_TIMEOUT_MS);
  const keepAliveTimeoutBuffer = parseTimeout(environment.HTTP_KEEP_ALIVE_TIMEOUT_BUFFER_MS);
  const headersTimeout = parseTimeout(environment.HTTP_HEADERS_TIMEOUT_MS);
  const requestTimeout = parseTimeout(environment.HTTP_REQUEST_TIMEOUT_MS);

  if (keepAliveTimeout != null) {
    server.keepAliveTimeout = keepAliveTimeout;
  }
  if (keepAliveTimeoutBuffer != null) {
    server.keepAliveTimeoutBuffer = keepAliveTimeoutBuffer;
  }
  if (headersTimeout != null) {
    server.headersTimeout = headersTimeout;
  }
  if (requestTimeout != null) {
    server.requestTimeout = requestTimeout;
  }

  clampHeadersToRequestTimeout(server, headersTimeout);

  const configured = [keepAliveTimeout, keepAliveTimeoutBuffer, headersTimeout, requestTimeout];
  if (configured.every((value) => value == null)) {
    return;
  }

  /** Bun accepts and reflects these assignments back without enforcing them. */
  if (versions.bun != null) {
    logger.warn(
      'HTTP server timeouts are configured but Bun does not enforce them; run under Node.js for these settings to take effect.',
    );
  }

  const belowResolution = [
    { name: 'HTTP_HEADERS_TIMEOUT_MS', value: headersTimeout },
    { name: 'HTTP_REQUEST_TIMEOUT_MS', value: requestTimeout },
  ]
    .filter(({ value }) => value != null && value > 0 && value < TIMEOUT_SWEEP_RESOLUTION_MS)
    .map(({ name }) => name);

  if (belowResolution.length > 0) {
    logger.warn(
      `${belowResolution.join(', ')} set below the ${TIMEOUT_SWEEP_RESOLUTION_MS}ms connection sweep interval; expiry is only detected on the next sweep, so the connection can stay open well past the configured deadline. Use values at or above ${TIMEOUT_SWEEP_RESOLUTION_MS}ms for predictable enforcement.`,
    );
  }
};
