/**
 * Leaves idle keep-alive connections open until the client closes them.
 *
 * Playwright sends its Node-side requests (the `request` fixture, `page.request`, `route.fetch`)
 * through one process-wide keep-alive agent with no idle timeout. Node's agent honors a server's
 * `Keep-Alive: timeout=N` hint only by shortening a timeout of its own, so this one keeps an idle
 * socket indefinitely. A Node server, by default, closes an idle socket once `keepAliveTimeout`
 * plus `keepAliveTimeoutBuffer` (6 s) pass; a request that reuses the socket at that moment, or
 * reaches a server too busy to read it before the deadline fires, is reset (`read ECONNRESET`) or
 * dropped (`socket hang up`). Every server the suite drives from Playwright's Node side therefore
 * disables its idle deadline; the backend gets the same through `HTTP_KEEP_ALIVE_TIMEOUT_MS`.
 *
 * @template {import('node:http').Server} T
 * @param {T} server
 * @returns {T}
 */
function keepIdleConnections(server) {
  server.keepAliveTimeout = 0;
  return server;
}

module.exports = { keepIdleConnections };
