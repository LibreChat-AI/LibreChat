# NMB prompt-review workflow: design

Scope: the LibreChat side of the secure gateway (Agent 3). The scanner (`nmb-scanner/`, contract in `INTERFACE.md`) decides; LibreChat enforces, holds, and presents.

## 1. What I found in LibreChat

Browser chat reaches the model through one family of routes, all under `/api/agents/chat` (`api/server/routes/agents/index.js`, `chat.js`, controller `controllers/agents/request.js`):

| route | model-bound text | notes |
|---|---|---|
| `POST /chat`, `POST /chat/:endpoint` | `req.body.text` | resumable generation; the controller persists `req.body.text` as the user message and rebuilds history from the DB on every later turn |
| `POST /chat/steer`, `/steer/deliver` | `req.body.text` | mid-run user message |
| `POST /chat/queued-turns`, `/v2` | `req.body.text` | queued follow-up |
| `POST /chat/resume` | `req.body.answers` | answers to ask-user questions |
| `POST /api/files` (`routes/files/files.js` `handleFileUpload`) | multer temp file at `req.file.path` | upload processing extracts text / embeds / may deliver natively to the provider |
| `/api/agents/v1/chat/completions`, `/v1/responses` | OpenAI-compatible API (API key auth) | bypasses the browser flow entirely |

Facts that shaped the design:

* The message text is persisted, and **history is re-sent to the LLM on every turn from the DB**. Therefore the sanitised text must be what is stored. Storing the original and masking only on the wire would leak it on turn 2.
* The same is true of assistant replies: they contain placeholders and are re-sent as history. **Unmasking must be display-only** and must never be written back to the DB.
* Existing pre-denial paths (`isPreDenialTextSubmission`, `rejectUnprotectedDeniedMessage`) can persist submitted text before the regular filter chain runs. The gateway must therefore run before them, immediately after authentication.
* There is already a content-filter chain (`createMessageFilterPii`, `moderateText`) but it is block-only and runs on the original text, and `moderateText` can call an external moderation API. NMB must be ahead of both.
* A failed POST (4xx JSON body) is rendered in the chat by `getStreamStartFailureText` + `Messages/Content/Error` (registry keyed by `type`/`code`). This is an existing, localisable channel for "held", "rejected" and "gateway unavailable" states, with no change to the resumable transport.
* Roles: LibreChat has (a) per-role feature permissions (`PermissionTypes`) and (b) **system capabilities** (`SystemCapabilities`, `requireCapability`, `hasCapability`), granted to roles, groups or users through `SystemGrant` and seeded to `ADMIN`. Capabilities are the mechanism for privileged operations and are what the admin panel's capability editor lists.
* Audit: a tamper-evident chained audit log exists (`recordAuditEntry`, `AUDIT_ACTIONS`).
* `User` has no department attribute.
* `packages/*` had no `dist/`. They build in ~10 s each (`npm run build:data-provider`, `build:data-schemas`, `build:api`).
* AGENTS.md: new backend behaviour belongs in TypeScript under `packages/api`, `/api` keeps wiring only; DB contracts belong in `packages/data-schemas`.

## 2. Chosen design

### 2.1 Interception point (messages)

A single Express middleware, `createNmbChatGateway` (logic in `packages/api/src/nmb/chat.ts`), mounted in `api/server/routes/agents/index.js` **directly after the authenticated-identity capture and before `privateTextIngress`/pre-denial/PII/moderation** for POSTs to `/chat`, `/chat/:endpoint`, `/chat/steer`, `/chat/steer/deliver`, `/chat/queued-turns`, `/chat/queued-turns/v2` and `/chat/resume`. Control routes (abort, steer cancel/arm, GETs) are untouched.

It:

1. no-ops when `NMB_GATEWAY_ENABLED` is not true;
2. builds the identity from `req.user` only (id, role, department via server-side role map); nothing from the body;
3. if the body text is a release sentinel (`[[nmb:release:<review id>]]`), loads the review from the scanner, requires `review.user === req.user.id`, status `approved-masked`, and swaps in the scanner's stored sanitised content. The client cannot choose what is released;
4. otherwise calls `/scan/text`:
   * `allow`/`mask` -> `req.body.text = sanitized_content` (plus a short note telling the model that `<TYPE_nnn>` tokens are redactions to be preserved verbatim, when masked);
   * `review` -> respond with a hold: `423 {type:'nmb_review_pending', review_id}` (a non-2xx so the transport shows it through the existing start-failure channel); the request never reaches the controller and nothing is persisted;
   * `reject` -> `422 {type:'nmb_rejected', reason}`;
   * scanner unreachable / 401 / 5xx / malformed -> **fail closed**: `503 {type:'nmb_unavailable'}`; the original text is never forwarded.
5. for `/resume`, scans `answers` string values the same way (mask in place; review/reject/unavailable refuse the resume).

Scope id sent to the scanner: **`u:<LibreChat user id>`, one placeholder namespace per user, not per conversation.** Reasons: a new conversation has no id when the first message (and any attachments, uploaded earlier) are scanned; per-conversation scope would number placeholders differently for the file and the chat so `<ACCOUNT_001>` could mean two different values, and a client-chosen conversation id could be used to unmask another user's mapping. A user-level namespace gives one consistent mapping for text, files and replies, and the key is derived from the session, never the body. (Deviation from the INTERFACE.md recommendation; the scanner treats the id as opaque so it works. `DELETE /conversations/{id}` is therefore not used.)

### 2.2 Interception point (attachments)

`handleFileUpload` in `api/server/routes/files/files.js`, after the existing permission checks and before any processing (`processAgentFileUpload`, which extracts text, embeds, or delivers natively). `packages/api/src/nmb/files.ts`:

* `.docx/.pdf/.xlsx` -> `/scan/file`; `.txt .csv .md .json .xml .log .tsv` -> read as UTF-8 and `/scan/text`; anything else (images, archives, unknown) -> refused while the gateway is on, because it cannot be inspected (fail closed).
* `allow`/`mask` -> the multer temp file is **replaced** by the sanitised markdown rendering (`<name>.masked.md`, `text/markdown`) and the original temp file is deleted; the rest of the pipeline only ever sees sanitised content. This also keeps the provider-native document path from ever carrying the original.
* `review` -> upload refused with `423 {type:'nmb_review_pending', review_id}`; a hold record (`NmbFileHold`: user, sha256, review id) is stored so a later **re-upload of the identical file** by the same user is released automatically once the review is `approved-masked` (the sanitised content comes from the scanner; the hold is consumed once). Rejected -> refusal with the reviewer's reason.
* `reject`, scanner errors -> refused (fail closed).

### 2.3 Reviews

`/api/nmb/*` (`api/server/routes/nmb.js`, handlers in `packages/api/src/nmb/handlers.ts`), all behind `requireJwtAuth`:

| endpoint | who |
|---|---|
| `GET /me` | any user: `{enabled, reviewer, regexBlocklist}` |
| `GET /submissions/:id` | owner only: status, mask flag, reviewer note on reject |
| `POST /unmask` | authenticated user; text only, scope derived from session |
| `GET /reviews`, `GET /reviews/:id`, `GET /reviews/:id/original`, `POST /reviews/:id/approve`, `POST /reviews/:id/reject`, `GET/POST /blocklist` | **reviewers only** |

Reviewer = holds the new system capability `review:prompts` (`SystemCapabilities.REVIEW_PROMPTS`), enforced with the existing `requireCapability`. It is granted to a role/group/user through the existing grants API (`ADMIN` gets it from `seedSystemGrants`). The backend, not the client, supplies the reviewer identity and the scanner reviewer role (`X-NMB-Roles`, `ReviewAction.roles`).

* **Self-review prohibited**: items where `review.user === req.user.id` are filtered from the queue and refused (403) on view-original, approve, reject.
* Per-finding blocklist choices come from the reviewer as `{value, mode:'literal'|'regex'}`. Literal values must occur in the original (checked server-side) and are length-bounded; regex is validated with RE2 and only forwarded when the scanner advertises support (see mismatches in the report).
* **Audit**: every reviewer action (list, view-original, approve, reject, blocklist change, and denied attempts) writes a `nmb_review.*` entry to the existing audit chain (actor, review id, counts, outcome; no content, no values) and a structured log line.

### 2.4 Showing the user the outcome

* Held/rejected/unavailable arrive as the failed-start JSON, rendered by a new error renderer registered in the existing `errorRenderers` registry. The held card polls `GET /api/nmb/submissions/:id`; on approval it offers "Send approved message", which submits the release sentinel through the normal `ask`.
* Masked content: the persisted user message already carries placeholders; the client shows a "Sensitive data was masked" notice when the text contains placeholders, without any value.
* Unmask for display: `Markdown` (central text renderer) calls `POST /api/nmb/unmask` for assistant text containing placeholders and renders the restored text; the cache is never written back. Copy/export remain masked (safe default).

### 2.5 Config

`NMB_GATEWAY_ENABLED`, `NMB_SCANNER_URL`, `NMB_SERVICE_KEY`, `NMB_SCANNER_TIMEOUT_MS`, `NMB_ROLE_DEPARTMENTS` (JSON role -> department), `NMB_DEFAULT_DEPARTMENT`, `NMB_SCANNER_REGEX_BLOCKLIST`. When enabled without URL or key the gateway refuses everything (fail closed) rather than passing through.
When enabled the OpenAI-compatible bypass routes (`/agents/v1/chat/completions`, `/v1/responses`) return 403.

## 3. Alternatives rejected

| alternative | why not |
|---|---|
| Mask in `BaseClient`/agent initialisation just before the provider call | the unmasked text would already be persisted and re-sent from history; many code paths (agents, steer, queued, resume, title generation) |
| Extend `createMessageFilterPii` | block-only by design, runs after pre-denial persistence, takes an `inspectContent` detector API, wrong place for an HTTP call and a hold/release state machine |
| LiteLLM/Kong-level masking only | cannot hold a message for human review or show status; also needed at the app because history/DB must be sanitised |
| Scan attachments at send time | files are processed at upload (extraction/embedding/native delivery); a send-time swap would have to patch several delivery routes. Upload-time replacement is one seam |
| Per-conversation placeholder scope | new-conversation ordering problem and cross-user unmask risk (see 2.1) |
| Server-side persistence of unmasked replies | would re-send raw values to the LLM as history |
| Client-side hold (precheck from React) | not authoritative; the server must enforce |
| A bespoke `reviewer` role string / env allow-list | the repo already has capability grants; a hardcoded role name is the hack the task rules out |
| Auto-resume generation server-side after approval | needs the full original request context and a second admission path in the controller; the release sentinel reuses the normal path |
