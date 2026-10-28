# MCP Apps

LibreChat renders tool-linked MCP Apps with the official MCP Apps SDK. The MCP server stays behind
LibreChat: a View calls LibreChat's authenticated HTTP routes, and LibreChat forwards the operation
through the MCP connection that owns that server. Browser Views never receive MCP credentials.

This integration targets the
[stable `2026-01-26` MCP Apps protocol](https://github.com/modelcontextprotocol/ext-apps/blob/v1.7.5/specification/2026-01-26/apps.mdx),
implemented by
[`@modelcontextprotocol/ext-apps` 1.7.5](https://github.com/modelcontextprotocol/ext-apps/tree/v1.7.5).
The lockfile is the executable version boundary.

## Support profile

| Area                            | Supported behavior                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| App resource                    | A tool-linked `ui://` resource with `text/html;profile=mcp-app`, supplied as UTF-8 `text` or base64 `blob`                                 |
| MCP connection                  | Standard shared sessions when Apps are off; profile-separated per-user, MCP OAuth, and direct OpenID sessions when on                      |
| View operations                 | Same-server tool calls, resource reads, resource and template listing, text messages, policy-controlled links, and logging                 |
| Visibility                      | Model, App, dual-visible, and omitted visibility follow the MCP Apps visibility rules                                                      |
| Rendering                       | Settled Apps show inert placeholders in a message-owned area; legacy inline HTML keeps its adapter                                         |
| History                         | A stored settled result retains its input, unchanged result, and App document; the user explicitly opens its View after binding validation |
| Search and public share         | Search results do not load Apps; public shares omit UI resources and retain ordinary transcript and tool text                              |
| Unsupported connection profiles | OBO, Graph-token placeholders, and request-body credential placeholders do not offer an interactive App View                               |

Optional draft features such as sampling, downloads, App-provided tools, state restoration, external
View URLs, and partial tool input are outside this profile.

## Interactive View authority

An App attachment displays an inert **Open app** placeholder until the authenticated viewer
activates it. Merely opening or restoring a conversation does not create a sandbox iframe,
validate a persisted binding, or let an App issue follow-up requests. The default limit is three Apps open
concurrently across the host view (`maxActiveViews`, range 1–32); close one to open another. Closing an App tears down its
bridge, cancels pending approval and in-flight authenticated resource operations; reopening starts
a fresh session and does not restore its previous in-View state. Keyboard focus moves to the new
Close/Open control after a user-initiated transition, including the in-dialog Stop app control.

Opening an App permits its own resource reads and declared link policy, but does not approve actions
on the user's behalf. Each App-initiated tool call displays the originating server, tool name and
complete arguments in a host-owned confirmation; App-initiated chat text shows the complete text
and requires a separate **Send message**. An approved App message contains only that text: files,
manual skills, and quotes staged for the user's next composer message are neither submitted nor
drained. The confirmation warns that the resulting model response may use the conversation's
selected agent and tools. Those selections remain available to the turn; removing them would also
change subsequent tool availability. Once chat accepts an approved turn, a later App abort cannot
undo it and is not reported as a failed submission. An explicit empty file override
prevents a blank App message from becoming submittable just because a draft file exists. Rejecting an action or an App aborting its own pending approval request pauses further
action requests from that View until it is closed and reopened. The dialog also provides a Close
app and stop requests control for an App that repeatedly asks.
Navigating away or closing the App does not execute a pending action. Tool arguments and message
previews exceeding `maxActionPreviewChars` (default 16,384; range 1–131,072 UTF-16 characters)
fail closed; they are never silently truncated for approval. The existing authenticated same-server binding
and visibility checks remain in effect. A user who directly calls their own API can still invoke
an allowed tool: this is a consent boundary for embedded App code, not an independent authorization
mechanism for authenticated API clients.

Set `mcpSettings.apps: true` to enable MCP Apps and legacy inline HTML. When the field is omitted,
new MCP Apps stay disabled while existing legacy inline HTML remains enabled for upgrade
compatibility. An explicit `false` disables both. Authenticated clients fail closed when the
resolved policy is unavailable or malformed; configuration changes take effect when startup
configuration is refreshed, such as after a page reload.
LibreChat advertises the `io.modelcontextprotocol/ui` client capability only on sessions admitted
by that effective Apps policy. Shared operator connections and startup inspection stay on the
standard MCP handshake; an enabled request uses a profile-separated user session so discovery,
tool calls, and App follow-ups observe one capability set without changing server or credential
ownership.
Legacy `ui://` resources use the installed MCP-UI renderer's `text/html` contract. An omitted MIME
type is treated as `text/html`; explicit XHTML and other MIME types remain non-executable to that
renderer while their marker-addressed attachments stay available to custom clients.
Consequently, a new client paired with an older backend that omits the authenticated policy
withholds both MCP Apps and legacy inline HTML. LibreChat's monolithic same-version deployment is
the supported upgrade path.

The deployment-owned sandbox transport limits default to 32 sources per CSP directive and 4,096
serialized characters. Raise them for Apps that declare more origins or a larger CSP payload:

```yaml
mcpAppSandbox:
  url: https://mcp-sandbox.example.com/api/mcp/sandbox
  maxSourcesPerDirective: 64
  maxSerializedLength: 8192
  maxPersistedAppBytes: 2097152
  maxPersistedMessageBytes: 8388608
  maxAdmissionRequestsPerMinute: 480
  maxActiveViews: 3
  maxActionPreviewChars: 16384
  operationLimits:
    maxBytes: 4194304
    timeoutMs: 30000
    maxActive: 16
```

These positive-integer settings come only from the base deployment configuration; role, group, and
user overrides cannot change them. Apply a limits change across the server and client deployment,
then reload open chat pages so host link decisions and newly served sandbox responses use the same
snapshot. Request query parameters contain only the normalized CSP declaration and cannot choose
their own limits. `maxPersistedAppBytes` defaults to 1 MiB and can be raised to at most 4 MiB. It
bounds each complete App attachment added to a message. `maxPersistedMessageBytes` is a separate,
deployment-only aggregate target for App-bearing messages. It defaults to 12 MiB and accepts positive
integers up to 12 MiB, leaving headroom below MongoDB's 16 MiB document ceiling. Roles, groups, users,
and App requests cannot override it.

All full saves, edits, records, imports, and background settlements check the actual candidate when
it contains bound Apps, including stored fields omitted from the update. A small message-version
fence makes competing writers retry from the row they actually read. Small text blocks and partial
background outputs are not exempt. If the target is exceeded, the largest optional App documents
become bound URI-only descriptors; if descriptors are too large, only optional Apps are omitted.
Canonical output and unrelated attachments are never trimmed. Canonical-only data may exceed the
App target, but must still fit the separate storage ceiling (16 MiB minus 16 KiB envelope reserve).
Existing messages need no schema migration. As with other message upserts, the existing unique
`(messageId, user, tenantId)` index must be present; the MongoDB regressions create that index too.

Roll out this change to all message writers together before relying on the aggregate bound. An older
replica does not participate in the version/admission contract and can still write an oversized
snapshot; mixed-version writes are not protected by this change. Canary's normal authenticated
same-version deployment remains the supported path.

`maxAdmissionRequestsPerMinute` defaults to 240 and is a shared per-user ceiling across every App
validation, resource, and tool-call route. LibreChat applies it before principal-scoped configuration
admission. The existing `rateLimits.mcpApps` values remain the more precise resource and tool-call
limits applied after admission.

MCP App browser routes use independent, per-user, one-minute limits. Configure positive integer
values at `rateLimits.mcpApps.resourcesPerMinute` and
`rateLimits.mcpApps.toolCallsPerMinute`; their defaults are 120 and 60 respectively.

## App operation budgets

App-profile MCP sessions have a pre-parse upstream response cap of 4 MiB by default, independent
of the standard-profile MCP transport settings, including the generic Streamable HTTP SSE line
limit. Raising the validated App limit can admit a larger single SSE event without changing
standard-profile limits. Streamable HTTP JSON responses, stdio frames and
SSE events (both Streamable HTTP and standalone) are bounded before the SDK parses JSON. The SSE
cap resets between events, so a healthy long-lived stream is not rejected for its lifetime bytes.
An oversized standalone SSE event
closes that App session after the SDK observes the error, preventing a sustained reconnect loop.
The same cap is checked on serialized
responses to the App bridge. Oversized optional initial `resources/read` results preserve the
canonical tool result; a failed follow-up request returns a bounded error, never a truncated JSON
success. The existing Express 3 MiB JSON ingress bound still applies before App route handlers.

Configure `mcpAppSandbox.operationLimits` in `librechat.yaml` as shown above. The validated
positive-integer limits default to the values shown and reject invalid or excessively high
overrides. They are read from the admitted deployment config, not from process environment
variables. The timeout is absolute across configuration, connection checkout,
recovery and the SDK operation; progress notifications cannot extend the SDK call beyond it. The
16-slot concurrency bound is **per LibreChat process**, shared across App resource, tool and binding
validation routes and the optional initial document read after a tool completes. There is no queue:
follow-up requests above it receive 503; an overloaded optional first read retains the bound URI
for retry without changing the canonical tool result. An aborted or timed-out operation holds its
slot until its underlying work actually settles, avoiding a false capacity
release while upstream work remains active. This is not a distributed cluster-wide quota. Measure
capacity per replica when sizing deployments. For safety, App-profile WebSocket connections are not
supported: the installed SDK parses their messages before providing a configurable maximum payload.
Standard-profile WebSocket sessions are unaffected. Larger legitimate Apps may require a higher
byte limit; do not disable transport limits to work around large results.

## Required sandbox deployment

The chat application and Sandbox Proxy must use different URL origins. Set the proxy URL in the base
LibreChat configuration and allow the chat origin to frame the proxy response:

```yaml
mcpAppSandbox:
  url: https://mcp-sandbox.example.com/api/mcp/sandbox
```

```dotenv
MCP_SANDBOX_FRAME_ANCESTORS=https://chat.example.com
```

The runtime `url` must be an absolute `http:` or `https:` URL whose origin differs from the chat
page. It is delivered only in authenticated startup configuration, so official prebuilt images use
it without rebuilding the client. Missing, invalid, or same-origin values fail closed and show the
View load error. Configuration changes take effect after a page reload.

For compatibility with older servers, a client built with `VITE_MCP_SANDBOX_URL` uses that compiled
URL only when authenticated startup configuration omits `sandboxUrl`. An explicit runtime URL is
authoritative: if it is unusable, the client does not silently fall back to the compiled value. The
build argument remains supported for existing custom images, but runtime YAML is the supported
same-version deployment path.

Route `https://mcp-sandbox.example.com/api/mcp/sandbox` to the LibreChat sandbox handler without
adding authentication or HTML transformation. Preserve its response headers, especially its CSP,
`Cache-Control`, `Cross-Origin-Resource-Policy`, and frame-ancestor policy. The outer proxy iframe
uses `sandbox="allow-scripts allow-same-origin allow-forms"`; the proxy creates an opaque-origin
inner iframe for the server-provided document. Form destinations remain bounded by the resource's
declared `connectDomains` through the sandbox response's `form-action` policy. The dedicated origin
should expose only this sandbox endpoint, not the chat application, session endpoints, or other
authenticated LibreChat routes.

The opaque inner frame supports requested geolocation and clipboard-write delegation. Camera and
microphone requests are withheld because browser media capture requires a non-opaque document
origin; Apps must feature-detect permission availability as required by the MCP Apps protocol.

The outer proxy response CSP is a loader policy that permits its own blob-backed inner frame. Before
the App document runs, the proxy separately installs the View policy as a CSP meta element inside
that inner document. The View policy comes from the selected resource's `_meta.ui.csp`; with no
declaration it defaults to `frame-src 'none'` and restrictive script, style, image, media, connect,
object, and base URI directives. Valid declared domains only widen their corresponding directives.

## Server contract

An App tool declares its View on `_meta.ui.resourceUri` (the deprecated `ui/resourceUri` spelling is
accepted for compatibility). LibreChat reads that exact URI from the same authenticated MCP
connection during the original tool call and persists the selected App-profile document. The tool
result sent to the View remains unchanged, including any embedded resource body; an embedded body
does not replace the required `resources/read` document. MCP tools invoked through Assistants and
Azure Assistants retain the App attachment alongside their canonical model-visible tool text.

Each persisted App also carries an opaque server binding issued from the exact authenticated MCP
target used by the original call. LibreChat validates that binding before loading stored inline HTML
and on every later App operation. Changing the server owner, effective endpoint, command, relevant
custom variables, or configuration generation invalidates existing Views; routine OAuth or bearer
credential refresh does not. Invalidated and older unbound App attachments remain unavailable and
never bind by server name to a replacement configuration. The host does not live-revoke a document
that is already loaded: reopening an App after close or page reload validates before loading it,
and every later App operation validates independently.

Validation of stored inline HTML compares the binding with the current local admitted server target;
it does not connect to the MCP server. A matching persisted document can therefore render while its
server is temporarily offline, although any live View operation still reports that outage. A
URI-only descriptor needs a live bound resource read before it has a document to render.

If the initial read fails or returns no usable exact item, the ordinary tool result remains
successful and LibreChat stores a URI-only unavailable descriptor. An authenticated interactive
history view may retry that document read; noninteractive surfaces do not. LibreChat never retries
the tool or executes the embedded App-profile body as a fallback.

Content-level `_meta.ui` from the selected read result controls that exact document. This profile
does not implement the released SDK's recommended fallback to resource-listing metadata, so servers
should repeat View metadata on the `resources/read` content item. When it is absent, LibreChat uses
the restrictive default; relying only on listing metadata is an interoperability limitation rather
than an invalid server response.

View requests remain bound to the authenticated user and originating server. The browser-facing
operations are:

| Method        | Route                                    | Body                                                 |
| ------------- | ---------------------------------------- | ---------------------------------------------------- |
| Binding check | `POST /api/mcp/app/validate`             | `{ serverName, serverBinding }`                      |
| Tool call     | `POST /api/mcp/app-tool-call`            | `{ serverName, serverBinding, toolName, arguments }` |
| Resource read | `POST /api/mcp/resources/read`           | `{ serverName, serverBinding, uri }`                 |
| Resource list | `POST /api/mcp/resources/list`           | `{ serverName, serverBinding, cursor? }`             |
| Template list | `POST /api/mcp/resources/templates/list` | `{ serverName, serverBinding, cursor? }`             |

Successful routes return the raw MCP SDK result. Invalid requests return HTTP 400, missing
authentication returns 401, and a policy without MCP Apps enabled returns 403. An auxiliary
resource read uses the same authenticated server's authority; a View cannot choose another MCP
connection.

A corrected client validates stored inline HTML before loading it. URI-only history combines
binding validation and `resources/read` against one resolved target, avoiding a second lookup. An
older cached client can still display inline HTML after a server upgrade, but corrected backend
routes reject every bridge operation that omits the binding; same-version client/server deployment
remains the supported upgrade model.

Standard MCP OAuth and direct-bearer App callbacks reuse the same bounded connection recovery as
ordinary MCP tool calls. When interactive authorization is required, the user starts it through
LibreChat's existing MCP UI; an App callback does not open a separate authorization flow. Direct
OpenID reauthentication returns the established HTTP 401 `invalid_token` shape, rejected bearer
credentials return 403, temporary refresh failure returns 503, and unexpected failures return a
generic 500 response.

## Reproducible integration fixture

The focused fixture uses the ordinary mock-provider login and conversation flow, disposable Mongo,
a real LibreChat HTTP server, a real networked MCP SDK server, the official browser `App` and host
`AppBridge`, and Chromium. Its tool result includes benign embedded HTML that differs from the
declared resource. The browser verifies one initial `resources/read`, execution of the read-derived
document, delivery of the unchanged tool result, View-originated tool/resource/list/message
operations, and reload from the persisted document without another read. A public share must retain
ordinary transcript and tool text while exposing no UI attachment, frame, or App RPC.

The fixture document begins with a template containing a decoy `head`; successful connection proves
the host bootstrap was inserted into the active document prolog. It also requests camera,
microphone, geolocation, and clipboard-write while asserting that only the two permissions supported
by LibreChat's opaque frame reach either iframe boundary.

A second ordinary App resource permits one link origin; its `openLink` button checks both the SDK
result and the page the host opens. Keeping the first resource's CSP undeclared lets the browser
scenario independently verify the complete restrictive default. The same scenario renders an
ordinary legacy `text/html` resource with the installed `@mcp-ui/client`, verifies its resize
message, and follows a benign tool action through the normal chat/tool flow.

Use Node 24 with the exact lockfile installed and Playwright Chromium available. From the repository
root, run the profile with one command:

```bash
node --test e2e/mcp-apps/server.test.mjs
node e2e/mcp-apps/run.mjs
```

The Playwright E2E workflow runs these checks on eligible pull requests (including same-repository bot branches, but not untrusted external forks), the nightly schedule, and manual dispatch, regardless of codegraph selection. Its required `e2e` gate fails if this dedicated job fails. The runner verifies that enabled, disabled, omitted-policy, and quota phases each executed passing browser tests; a successful Playwright exit with only skipped tests does not pass. CI uploads separate reports for each phase and preserves failing traces and screenshots.

The runner builds the client with the chat at `http://127.0.0.1:3080` and the Sandbox Proxy at
`http://localhost:3080`. Those URLs reach the same disposable LibreChat process but have distinct
browser origins. The aliases are only a disposable local substitute for separate deployment
origins. The fixture does not contact an external model or MCP provider.

The browser spec is `e2e/specs/mock/mcp-apps.spec.ts`; the disposable official-SDK server is
`e2e/setup/fake-mcp-app-server.mjs`. Keep `E2E_MCP_APPS=true` scoped to this profile so its server and
configuration do not enter the general mock suite.

The server fixture has a faster transport/contract check that does not build LibreChat:

```bash
node --test e2e/mcp-apps/server.test.mjs
```

## Ownership and protocol boundary

```text
MCP server
  ↕ LibreChat MCP manager and the user's existing connection lifecycle
authenticated App operation routes
  ↕ raw MCP SDK request/results
one AppBridge per settled tool-result View
  ↕ source-bound postMessage
dedicated-origin Sandbox Proxy
  ↕ opaque sandboxed inner View
```

The official SDK supplies the MCP server, browser `App`, `AppBridge`, and transport contracts.
LibreChat owns authentication, same-server authorization, persistence, placement, and sandbox
policy. Its inner frame deliberately retains an opaque origin plus nonce/heartbeat liveness; this is
a documented host design beyond the basic official example and is covered by the browser fixture.
