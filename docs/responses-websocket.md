# Responses WebSocket transport

Operators may enable upgrades on the same `/api/agents/v1/responses` path:

```yaml
endpoints:
  agents:
    responses:
      websocket:
        enabled: true
        maxConnections: 32
        maxQueuedTurns: 4
        maxMessageBytes: 1048576
        maxCacheBytes: 4194304
        maxBufferedBytes: 4194304
        admissionTimeoutMs: 10000
        heartbeatMs: 30000
        maxConnectionMs: 3600000
```

Clients provide their bearer credential in the upgrade headers, then send
`response.create` events with the ordinary request fields. Omit HTTP-only
`stream`, `stream_options` and `background` fields. Replies are JSON Responses
events, without SSE framing. Reverse proxies must forward WebSocket upgrades;
connection capacity is per process, including pending handshakes and rejecting
raw connections. Saturation closes new raw connections immediately; rejected
handshakes are destroyed after their response is flushed and remain bounded by
the admission deadline. Authenticated
tenant settings may lower connection payload, queue, cache, output and lifetime
limits beneath deployment caps; reconnect to apply changes to these lifecycle
limits. Input/cache admission also uses the current request configuration. Both server
entrypoints close these connections before HTTP shutdown drains.

The upgrade and each queued turn pass through the existing remote authentication,
tenant/configuration, feature and terms gates. Each turn then passes through the
ordinary agent ACL, admission, execution, accounting and cancellation path.
Authentication is refreshed from the original credential; credential revocation
or an authorization change takes effect through the same checks as HTTP.
Handshake request identifiers and idempotency keys are not reused across turns.
A disconnected client aborts its active foreground execution. Raw socket errors
are owned throughout upgrade admission and handoff. Agents with model streaming
disabled keep that setting; their completed JSON response is projected into the
same item, content and terminal event lifecycle. A successful HTTP delivery that
ends without a terminal response is reported as a transport failure.

The latest completed `store:false` turn can be referenced with
`previous_response_id` on that connection. Its cached input, output and historical
client-tool names share one byte budget and are bound to the authenticated user,
tenant and agent. Historical client tools enable formatting only; they do not
install executors or grant tool access. A new explicit-input turn replaces the
cache, and an unsuccessful continuation evicts it. Over-budget completed histories
are not retained. With `store:false`, an uncached predecessor fails with
`previous_response_not_found` even if that ID exists in persisted storage.
With `store:true`, the ordinary owner/project-scoped persistent lookup and
persistence apply. Storage failures remain service errors.

Turns execute serially. Pending frames and outgoing events are bounded; queue
overflow closes the connection with code 1008 and aborts the active turn. Oversize
payloads close with code 1009. Connections also have heartbeat and lifetime limits.
Expiry cancels active execution immediately; its final error is best-effort and
a backpressured peer is terminated rather than delaying cleanup.
A reconnect has no `store:false` history: recover by supplying explicit history in a new chain. Failed sends, disconnects and retries do not
provide exactly-once execution, and the server does not retry automatically.

Run credential-free integration checks after building the packages and client:

```sh
E2E_USE_MEMORY_MONGO=true npx playwright test --config e2e/playwright.config.responses-socket.ts
```

This uses the existing mock provider, real API authentication and execution,
native sockets, and temporary MongoDB. It checks connection history, isolation,
key revocation, and stored-reference policy. Native transport tests additionally
cover tenant and model scope, frame ordering, payload/cache/output bounds,
disconnect cancellation, and shutdown.
