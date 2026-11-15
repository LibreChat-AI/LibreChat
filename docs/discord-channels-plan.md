# Discord Provider for Agent Channels

Status: implementation in progress, authorized on 2026-11-15. The provider is being delivered as a dependency stack. This document records the design and acceptance gates; it is not a claim of production readiness.

Current implementation and verification:

| Area                                                                                     | State                                                                                                                  |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Provider contracts, organization applications, guild installations and explicit bindings | Implemented with focused compatibility and authority tests                                                             |
| Signed HTTP commands, account consent, durable execution and text delivery               | Implemented with signature, replay, transaction, recovery and built-process tests                                      |
| Optional Gateway mentions, resumable sessions and guild removal                          | Implemented with owner-fenced dispatch and platform-client tests                                                       |
| Account and organization settings                                                        | Component tests and five browser scenarios pass, including both providers and light/dark account consent               |
| Feedback                                                                                 | Storage, API policy projection and immutable native button plans implemented and tested                                |
| Native threads                                                                           | Storage and immutable parent-binding affinity implemented; runtime and first-command source resolution are in progress |
| Direct messages                                                                          | Explicit hashed selection-code storage implemented; browser controls, signed selection and execution are in progress   |
| Deployment                                                                               | Compose and Helm configuration validated; a built Node process smoke passes; local Docker execution remains unverified |
| Release gates                                                                            | Integrated precheck, remaining runtime work, live Discord verification and published-head review/closeout remain open  |

The original worktree's unrelated lockfile change remains outside the feature. See [the operator guide](discord-channels.md) for configuration and deployment. A dedicated Discord test application/guild and the location of its local secret configuration are still needed for live verification. Never put a bot token in this document, chat, screenshots or test output.

## 1. Recommendation and scope

Add Discord as a first-class Channels provider, sharing LibreChat's existing agent execution, account consent, durable runs, cancellation, review, and delivery recovery. Keep Discord authentication, installation authority, transport, rendering, and platform permissions provider-specific.

This is a **large** feature. The likely changes span `packages/data-provider`, `packages/data-schemas`, `packages/api/src/channels`, `packages/channel-gateway`, `client`, deployment configuration, and focused tests. Plan a dependency stack of independently correct PRs, splitting any link that approaches 1,500 changed lines or 40 files. Do not implement the feature as one oversized provider patch.

Recommended delivery sequence:

1. **Foundation:** provider-aware contracts and authority, with unchanged Slack behavior.
2. **First usable release:** organization-managed Discord applications, guild installations, explicit channel bindings, slash commands over signed HTTP, account linking, durable bot replies, cancellation, review links, and button feedback.
3. **Conversational expansion:** Discord Gateway transport for explicit mentions and DMs, native thread routing, lifecycle events, and reconnect recovery.
4. **Optional richer features:** attachments, native review forms, and reaction feedback after their security and ordering contracts are proven.

The baseline works with explicit commands. Gateway ingestion is separately configurable and admits only explicit bot mentions in supported guild destinations. An implicit reply mention is insufficient. Direct messages require an explicit, current agent selection. Thread and DM support remain release gates for the complete goal; privileged message access is not a prerequisite for the baseline command flow.

Assumptions to carry into implementation: guild-installed bots first; one explicit agent binding per application/guild/channel; no guild-wide default routing initially; output is visible to members of the chosen Discord channel; user-installed applications and private ephemeral agent conversations are separate features. These defaults define the implementation scope. Optional richer features remain separate from this delivery.

## 2. Baseline Evidence and Required Changes

| Area              | Evidence before implementation                                                                                           | Required direction                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Public contracts  | `packages/data-provider/src/types/channels.ts` restricts `AgentChannel.type` to Slack and carries Slack service bundles  | Discriminated provider contracts with separate browser-safe and service-only projections |
| Configuration     | `packages/data-provider/src/config.ts` has Slack transports, native sessions, and `slackApp` configuration               | Add a Discord configuration branch; leave existing defaults intact                       |
| Persistence       | `packages/data-schemas/src/models/channel.ts` only accepts Slack                                                         | Add validated Discord metadata and provider-aware indexes                                |
| Authority         | `methods/channelScope.ts` checks Slack metadata and sends `workspaceId` through Slack installation fences                | Preserve the transaction fence, dispatch installation checks by provider                 |
| Identity          | `types/channelIdentity.ts` uses `teamId`; persisted consent carries `slackReply`                                         | Explicit Discord identity and confirmation capability; preserve consent CAS semantics    |
| Durable execution | `methods/channelRun.ts`, `channelProtocol.ts`, and API `channels/runs.ts` provide admission, lanes, leases, and receipts | Reuse, with provider-aware actor and destination validation                              |
| Gateway           | `packages/channel-gateway/src/main.ts` directly constructs Slack clients and workers                                     | Select a provider adapter at bootstrap; share only proven common orchestration           |
| Shared routing    | Gateway `shared/route.ts` and API workspace services are Slack-specific                                                  | Add Discord application, guild, and route resolution without overloading Slack records   |
| Feedback          | `types/channelFeedback.ts` and `channelFeedbackProtocol.ts` use Slack event timestamps and reaction aliases              | Use an explicit Discord button event contract first                                      |
| UI                | `Channels.tsx`, `ChannelsDialog.tsx`, setup, details, and account-link views assume Slack                                | Make provider selection drive readiness, setup, metadata, and copy                       |
| Deployment        | Compose and Helm expose Slack ingress paths                                                                              | Add Discord interaction ingress and operational configuration                            |

Two important traps:

- The existence of generic run names does not make authorization provider-neutral. Mapping a guild ID into `teamId` or placing a Discord installation into `workspaceId` would reach Slack-specific authority paths.
- Discord threads are channels with their own IDs. Existing delivery checks require `externalMessageKey` to begin with `externalChannelId + ':'`. A thread destination must agree with admission; it cannot be substituted after the run has started.

The existing Discord social-login strategy and `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, and `DISCORD_CALLBACK_URL` settings serve a different purpose. They must not become implicit Channels credentials or consent.

## 3. User experience and acceptance contract

An organization administrator enables Discord and registers an application using its application ID, public key, and bot token. The UI returns an interaction endpoint and an installation URL. Secrets are write-only after submission. A manager connects an authorized guild, and an agent editor binds an eligible text channel to an agent.

Members use a command family such as:

- `/librechat ask prompt:<text>` invokes the agent assigned to the current channel.
- `/librechat link` starts personal account consent using a private interaction response.
- `/librechat status` shows the requesting actor's current run state privately.
- `/librechat cancel` requests cancellation of that actor's active run in the current scope.

Command names are provisional. Register commands through an explicit, versioned operation, use guild-scoped commands for development, and avoid overwriting commands on every process start. A production registration must not remove unrelated commands belonging to the same application.

For linked-user execution, an unlinked member receives a private link prompt and no agent run is admitted. After browser consent, the same Discord actor must confirm the attempt. Linking does not retroactively execute the original prompt; the UI asks the member to submit it again unless a separately specified, expiring replay flow is added.

After admission, acknowledge promptly, publish a bot-owned status message in the configured channel, and update it as the run progresses. Deliver the final reply there, with cancellation/review controls when applicable and an authenticated LibreChat link. Clearly explain that linking a private LibreChat account does not make Discord output private.

Define conversation continuity before implementing slash-command admission. Recommended initial behavior: each `/librechat ask` starts a fresh conversation, with status/cancel scoped to the actor's current run. Later thread invocations can continue the actor's existing thread lane. A synthetic non-thread key for initial commands must retain the existing destination prefix and include the interaction ID; never use the whole text channel as a shared conversation. If repeated commands should continue context instead, add an explicit conversation/reset contract and tests rather than relying on accidental lane reuse.

Required states include disabled, unconfigured, invalid credentials, disconnected guild, missing permission, no binding, binding conflict, unlinked user, queued, running, needs review, cancelled, completed, retryable delivery failure, uncertain delivery, and unavailable resource. Do not present a credential check as proof that routing and delivery work.

Before editing implementation code, enumerate all affected paths by grep: dedicated versus shared Slack deployments; legacy versus current records; application and channel owners; linked versus existing service-principal execution modes; changed/deleted routes; revoked users; expired consent; missing permissions; and failed refetches. Record those variants in the implementation acceptance contract.

### Direct-Message Selection and Native Thread Continuity

DMs cannot infer a tenant, agent or guild from the most recently used link. In account settings, a user chooses one confirmed guild account link and requests a short-lived code. Only a hash is stored. The same Discord actor sends `/librechat select code:<value>` in a bot DM. Signed bot-DM context, application revision and actual DM channel identity must match before a transaction creates the selection. Browser input supplies only the link reference and expected revision; the server derives every source authority field.

One selection generation is current for each application, actor and actual DM destination. Replaying a consumed code cannot extend its expiry or replace a newer generation. Its original confirmation interaction anchors conversation continuity. Selection expiry is bounded by both configured policy and the source consent expiry. Source guild, installation, channel, account link and principal remain real authority references, distinct from the DM destination. Revocation and owner-visible selection cleanup remain available when DM admission is disabled. Before execution, refresh the bot's and actor's access to the source guild channel, then join current database authority in the admission transaction.

Native threads use their actual thread channel ID as the delivery destination. A durable mapping pins the original parent-channel binding and its revisions. Replacing the parent binding invalidates old thread execution instead of silently changing its agent. An opaque retired pin survives private-data erasure so the same thread cannot be implicitly retargeted. Check archived/locked state, `SEND_MESSAGES_IN_THREADS`, and both bot and actor visibility/history permissions. Private threads additionally require current membership or `MANAGE_THREADS` for each actor.

Signed interaction channel objects may omit the thread parent. A first command in an unseen thread therefore needs explicit unresolved routing in the existing durable private inbox, followed by owner-fenced REST source inspection before effects. Do not fabricate guild/channel/agent fields or introduce a second execution ledger. Queue retries must preserve actor/destination order so a later cancellation cannot overtake an earlier deferred request. Prepared replies have already committed their effects and need not block subsequent commands.

## 4. Provider boundary and dependency ownership

Introduce a small typed boundary around actual differences, not a generic integration framework. Conceptual responsibilities are:

| Responsibility                 | Provider-neutral owner               | Discord implementation                                     |
| ------------------------------ | ------------------------------------ | ---------------------------------------------------------- |
| Authenticate ingress           | Gateway boundary                     | Ed25519 HTTP verification or authenticated Gateway session |
| Resolve installation and route | API/data-schemas                     | Application + guild + effective destination lookup         |
| Admit actor and run            | Existing Channels authority          | Discord identity discriminator and installation fence      |
| Execute agent                  | Existing Responses/run worker        | No Discord SDK dependencies                                |
| Render presentation            | Gateway adapter                      | Discord text, buttons, safe URLs, splitting                |
| Deliver/reconcile              | Existing lease protocol plus adapter | Bot REST message operations and bounded reconciliation     |
| Confirm consent                | Existing consent state machine       | Actor-bound Discord interaction                            |

Use discriminated unions so a Slack service bundle cannot be passed to a Discord adapter. Keep SDK clients, credentials, configuration, and database methods injected by the host. Backend behavior belongs in `packages/api`; `/api` gets route registration and calls only. Shared database contracts expose plain types, not Mongoose query types.

Refactor only the worker orchestration needed by the second provider. Slack Block Kit, response URLs, Socket Mode, lifecycle reactions, and native Slack sessions remain in Slack-specific modules. Avoid an interface with dozens of optional methods that merely moves provider checks elsewhere.

Dependencies: first inspect installed libraries and compatible published SDK versions. For HTTP interactions, Node's cryptography and the existing HTTP client may suffice; a small Discord REST/types dependency may reduce protocol errors. Gateway support should use a maintained Discord SDK for heartbeat, resume, compression, and sharding rather than a custom WebSocket protocol. Select and pin the minimum justified versions, account for Node 24, and update only necessary declarations and lockfile entries. Do not decide package versions from memory.

## 5. Data model and installation authority

Add provider-discriminated channel, actor, service-bundle, link, installation, and delivery-address types. Retain `type` as the public channel discriminator unless there is a concrete reason to rename it. All Discord snowflakes remain validated strings, never JavaScript numbers; permission bitfields use a lossless representation as well.

The conceptual Discord records are:

- **Application:** tenant, application ID, bot user ID, public verification key, encrypted bot token, optional encrypted OAuth secret, revision, and credential status.
- **Guild installation:** tenant, application ID, guild ID, display metadata, managing principals, verified installation state, and revision.
- **Binding:** installation, actual Discord channel ID, LibreChat channel/agent identity, and revision. Enforce one active binding for a route transactionally.
- **External actor:** provider, application, guild or explicit DM scope, and Discord user ID, tied to the existing channel and tenant authority.
- **Delivery address:** actual destination channel ID, optional parent channel ID/thread ID, and immutable provider identity. Message keys use the actual destination channel plus message ID.

One application endpoint receives interactions across all of its guild installations. Route the application key lookup by a non-secret registered application identifier, verify the signature, then require the signed payload's application ID to match. Resolve tenant ownership from stored installation authority, never from a client-supplied tenant field.

Initially bind an application/guild installation to exactly one tenant in a deployment. Enforce uniqueness at the appropriate application and installation boundaries. Sharing one Discord bot across unrelated tenants requires a separately designed ownership model; a bot token can access every guild where that bot is installed, so it is a broader secret than a per-guild route credential.

Do not silently infer the invoking user's management rights from successful bot installation. Connecting a guild must establish both LibreChat management authority and Discord installation-management authority. Use an authenticated OAuth flow with one-time state, bound redirect/session/tenant/application, minimal scopes, and a server-verified guild membership/permission check. Verify bot presence and application identity separately. If OAuth tokens are only needed during setup, discard them after verification.

Preserve the existing transactional fences for owner activity, agent access, channel revision, installation revision, and consent revision. Revalidate at admission and before consequential run/delivery operations. Disconnect, credential rotation, route replacement, owner deletion, and account unlink must invalidate stale authority and queued actions. Cleanup must include Discord bindings, tickets, confirmation capabilities, feedback sources, and stored delivery references.

Migration must be additive: read legacy Slack records as Slack only where their validated schema permits, explicitly tag new records, and keep Slack browser/service contracts compatible during rollout. Inspect existing compound indexes before changing them; backfill and validate uniqueness before dropping any old index. Old workers must reject unsupported Discord bundles rather than interpret them as Slack. Enable Discord only after compatible API, database, and gateway versions are deployed.

## 6. Ingress, acknowledgement, and durable admission

For the initial release, expose a dedicated HTTPS interaction route, for example `/discord/interactions/:applicationId`. This is a proposed route, not an existing API. Preserve the raw body and verify `X-Signature-Ed25519` over timestamp plus exact body bytes before parsing or acting. Validate header lengths, request size, bounded timestamp freshness, application identity, interaction schema, and supported context. Reject invalid signatures with 401. Handle Discord's PING verification without starting work.

Discord requires an initial response within **3 seconds**. Defer valid potentially slow commands promptly, preferably privately for setup/status/errors. Do not run agent execution, OAuth exchanges, or unbounded configuration reads on the acknowledgement path. Use a bounded, revision-aware verification-key lookup; never let a stale key cache outlive rotation policy.

The durable handoff needs an explicit contract: a deferred response means accepted for processing, not proof that a run exists. Persist a deduplicated ingress/admission record before reporting successful admission. Keep this operation within the acknowledgement budget. If storage is unavailable, return an immediate private unavailable response where possible, and never execute an unrecorded task. Test crashes before persistence, after persistence but before acknowledgement, and after acknowledgement but before worker scheduling. Do not assume Discord will redeliver every lost request.

Use interaction ID as the HTTP event identity. Duplicate deliveries may repeat a safe acknowledgement but must not create another run or repeat an action. Same identity with changed actor, prompt, route, or principal is rejected. Reject unsupported command versions, unknown action identifiers, user-installed/DM contexts in the guild-only release, bots, and webhook-originated input where applicable.

Resolve the configured route server-side. Never accept an agent ID, run owner, destination, or tenant from arbitrary command/component fields. Bound per-user, per-route, and per-application admission, queue depth, input length, and concurrency through configuration. Expected rejection returns stable codes; unexpected outages reach the owning boundary with sanitized diagnostics.

## 7. Consent, privacy, and review actions

Reuse the current consent states, single-use tickets, expiry, revision comparisons, and revocation behavior. Replace Slack-specific confirmation storage with a discriminated provider capability; do not broaden the Slack callback URL allowlist to arbitrary hosts.

Bind confirmation to tenant, provider, application, guild/scope, channel, actor, link attempt, and current revision. A browser click alone does not establish Discord ownership. Deliver the initial link privately, and accept final confirmation only from a verified interaction by the original actor. If the original interaction expires, allow a fresh authenticated `/librechat link` invocation to resume or replace the attempt according to the consent state machine.

Discord interaction tokens are bearer capabilities valid for **15 minutes**. If retained for a private reply, encrypt them, restrict them to the relevant operation, redact URL paths containing tokens, and erase them on expiry/completion. Do not store arbitrary user-supplied callback URLs.

Initially expose tool approval and complex review through authenticated LibreChat links. The linked account and current run ownership still authorize the review; possession of a URL or a Discord moderator role does not. Native Cancel and feedback controls use opaque short references, respect Discord component limits, and revalidate actor, source message, run, and revisions on every click. Another channel member must not be able to cancel or approve the initiating user's run.

Personal account access can retrieve private information and post it to a shared channel. Setup and linking must disclose this destination clearly. Retain existing agent/tool authorization and approval policies, and reject any mode whose output cannot safely be shared. Do not fetch unrelated guild/channel history or combine actors' private conversation lanes.

## 8. Durable replies and failure recovery

Interaction followups alone cannot support runs or approvals lasting longer than 15 minutes. Use bot-token REST delivery for persistent channel messages. A private deferred acknowledgement can point to the durable status message, but expired interaction tokens must not block completion.

Persist a versioned Discord presentation inside the existing immutable delivery-plan protocol. Split content within Discord's 2,000-character message-content limit, preserving Unicode and code fences; test boundaries using Discord's documented counting behavior. Suppress all implicit mentions with `allowed_mentions` on every create/edit, including reply mentions. Treat model-produced Markdown and URLs as untrusted presentation. Cap total output chunks and offer an authorized transcript link when content exceeds the configured delivery budget.

Prefer a stable bot-owned status message and edit it into the result where feasible. Persist IDs for every additional chunk. Keep tool traces and sensitive approval details out of public status updates. A Discord message link is useful navigation, not authorization to view the underlying LibreChat conversation.

Preserve lease and revision fencing through prepare, send, receipt, and reconciliation. A timeout after a successful send is uncertain, not a definite failure. Discord supports `nonce` with `enforce_nonce` for message creation, but uniqueness lasts only a few minutes; it is not durable exactly-once delivery. Derive a stable nonce within the documented size limit, persist message IDs immediately, and use supported message lookups plus stored receipts for reconciliation. If uncertainty cannot be resolved beyond the nonce window, expose a recoverable uncertain state rather than blindly duplicating the result. Do not claim an exactly-once guarantee.

Honor rate-limit buckets, global limits, and `Retry-After`/`retry_after`; coordinate clients sharing a bot token or centralize their egress. Avoid creating a separate uncoordinated limiter for each guild worker. Bound retries and update frequency; use backoff with jitter for retryable transport failures. Handle invalid tokens, missing access, deleted channels, and deleted messages as distinct stable outcomes. Never retry permanent 401/403/404 failures indefinitely.

The first release rejects invocation in unsupported thread types. In the expansion, admit using the actual thread-channel destination and store the parent route separately. Revalidate parent binding and thread membership, and define behavior for archived/locked/deleted threads. Never silently move a private-thread response into a public parent channel.

## 9. Discord permissions and Gateway expansion

Install with the `bot` and `applications.commands` scopes. Derive the permission set from enabled capabilities: View Channel, Send Messages, Read Message History where reconciliation requires it, and later Send Messages in Threads, thread creation, Embed Links, or Attach Files as actually needed. Do not request Administrator, Manage Messages, Manage Webhooks, or Mention Everyone for basic agent replies.

Evaluate effective channel overwrites and thread membership, not just the guild role bitfield. Check capability at setup and recheck after forbidden delivery. Discord documentation announces channel obfuscation for bots without view permission beginning 2026-11-16; treat hidden/partial channel metadata as unavailable, not as evidence of an empty or usable channel.

For the Gateway phase:

1. Use a maintained SDK, one owned shard/session assignment per bot, and a distributed ownership mechanism if multiple gateway replicas exist. Do not open duplicate full subscriptions per worker.
2. Configure only required intents. Explicit mentions and bot DMs have message-content exceptions; ambient guild/thread reading generally needs the privileged Message Content intent and potentially approval. Verify the exact event shapes and exceptions with a real test application. Do not label intents as OAuth permissions.
3. Ignore self, bot, webhook, edit, and system events unless explicitly supported. Deduplicate message-create admission by message identity across reconnects and HTTP/Gateway overlap. Choose one interaction transport per application; when HTTP interactions are configured, do not expect those same interactions over Gateway.
4. Persist and fence session state where the SDK and deployment support it; implement heartbeat health, resume, invalid-session handling, bounded reconnect, Identify concurrency, and session-start budget handling. Detect gaps that cannot be replayed and report degraded service rather than invent missing messages.
5. Reconcile installation removal, unavailable guilds, permission loss, and token revocation. Distinguish a transient unavailable guild from removal before deleting authority.
6. Define native thread continuation explicitly. Default to invoking actor lanes; shared multi-user agent context is a separate product/security decision. In DMs, require explicit selection of an authorized installation/agent when more than one could apply; never route to the last-used guild implicitly.

## 10. Feedback and files

Ship thumbs-up/down buttons first if the existing feedback pipeline can support a provider-specific occurrence contract safely. Bind each vote to the delivered canonical message and authenticated actor, apply existing retention/owner checks, and define replace/remove semantics with CAS. Interaction snowflakes identify button events; do not pretend that their timestamps implement Slack's exact reaction timestamp contract.

Reaction feedback is a later feature. Discord Gateway reaction events require a deliberate event identity and ordering strategy across session resume, reconnect, add/remove, and duplicate delivery. Gateway sequence numbers are session-scoped, message snowflakes date the message rather than the reaction, and receipt time is not authoritative occurrence order. If the necessary contract cannot be established, keep reaction feedback unsupported and document buttons as the supported path.

Defer input/output files from the first release unless product requirements demand them. Later support needs strict byte/type/count limits, safe download allowlists and redirects, expired CDN URL handling, malware/file policy integration, attachment authorization, and retention/erasure. Never pass arbitrary attachment URLs into an unrestricted server-side fetcher. Validate current upload limits at implementation time instead of embedding a remembered platform-wide limit.

## 11. Configuration, UI, and operations

Proposed configuration lives under `endpoints.agents.channels.discord`, enabled by default only when explicitly configured. Keep credentials in encrypted organization-managed storage; YAML governs enablement and bounded policies. Reuse existing generic limits where appropriate, and add validated fields for new signature tolerance, ingress/admission deadlines, REST timeouts/retries, concurrency, queue/input/output limits, and Gateway reconnect behavior. Platform constants such as Discord's interaction deadline remain enforced constraints, not operator-tunable promises.

UI work includes:

- `ChannelsDialog.tsx` provider selection and `Channels.tsx` provider-specific readiness and creation; Discord must work when Slack is unconfigured.
- `ChannelSetup.tsx`, `WorkspaceChannel.tsx`, `ChannelDetails.tsx`, `ChannelStatus.tsx`, and `ChannelUsage.tsx` with appropriate Discord setup/status projections. Keep Slack setup isolated where its semantics differ.
- Organization application/guild management, credential rotation, installation verification, binding collision/replacement, and disconnect confirmation with impact disclosure.
- `ChannelLinkRoute.tsx`, linked-account settings, settings search keywords, localized errors, and provider-specific navigation links.

The provider-specific account-link rendering actually lives in `client/src/components/Channels/Link.tsx` and `Links.tsx`; the route itself is largely neutral. Preserve fragment removal before login redirects, session ticket retention, terms gating, ticket case, owner isolation, and focus restoration when adapting those components.

Reuse `DiscordIcon` already exported from `@librechat/client`; inspect its sizing API before changing the shared primitive. Use existing components, semantic colors, English localization keys, accessible labels/focus, Jotai for new state, and React Query for API/cache ownership. Model optimistic replacement and failed refetches according to the existing state-coherence guidance. No raw palette classes or new action-menu framework.

Update Compose, Helm, and gateway deployment generation together. Expose only interaction ingress publicly; health, metrics, and internal service credentials remain appropriately restricted. Preserve raw-body verification through the proxy. Document TLS, public callback URLs, secret storage, command registration, permissions, token rotation, and uninstall cleanup. Gateway-only message ingestion can use outbound connections, but the chosen HTTP-interaction mode still requires public ingress.

Keep `docker-compose.slack-workspaces.yml` Slack-specific. Extend `.github/scripts/test-channel-compose.mjs`, `helm/librechat/tests/channel_gateway_render_test.mjs`, and the process smoke tests in `.github/workflows/channel-gateway.yml` for Discord while retaining signed Slack coverage. Coordinate the public setup guide at `https://www.librechat.ai/docs/features/agent_channels` with the release; that guide lives outside this repository.

Measure acknowledgement latency and deadline misses, deduplication, admission rejects, queue age, run state, REST 429/401/403 outcomes, retry/uncertain delivery, consent failures, and later heartbeat/resume health. Use bounded metric labels without guild/user IDs or content. Logs may contain safe correlation identifiers but never prompt text, tokens, signature bodies, or raw provider errors.

Health must distinguish process liveness, worker readiness, application credential health, installation permission health, and Gateway connectivity. Define shutdown draining and lease release. HTTP workers may scale horizontally with durable deduplication; Gateway shard ownership and bot-token rate limits require coordination.

## 12. Implementation stack and exit gates

| Slice | Deliverable                                                                              | Exit gate                                                                                          |
| ----- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1     | Provider-discriminated contracts, legacy Slack compatibility, provider-aware authority   | Slack regression suite passes; mixed provider identities rejected                                  |
| 2     | Discord application/guild persistence, management API, routes, secret handling, setup UI | Authorized install/bind/rotate/disconnect works; credentials never appear in browser projections   |
| 3     | Signed HTTP interactions, command registration, durable ingress, consent                 | PING/signature/replay/deadline tests pass; unlinked and wrong-actor runs denied                    |
| 4     | Adapter-based execution and Discord durable rendering/delivery                           | Real command completes through shared execution; cancellation/review and uncertain-send tests pass |
| 5     | Complete status/account UI, button feedback, deployment examples and documentation       | First-release acceptance matrix passes with Slack and Discord side by side                         |
| 6     | Gateway mentions/DMs, thread routes, lifecycle and reconnect                             | Live reconnect, permission loss, route affinity, and multi-replica ownership verified              |
| 7     | Optional native review/forms, files, and reactions                                       | Each feature has its own authorization, retention, and recovery evidence                           |

The slices describe dependency order, not fixed PR sizes. Split further where necessary, keep incomplete functionality disabled, and ensure each link compiles and preserves existing behavior without requiring code from a later link. Choose the actual base according to the branch's intended target; do not silently retarget existing work to canary or dev.

## 13. Verification matrix

| Surface                 | Required evidence                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Configuration/contracts | Discord disabled by default; existing Slack config unchanged; invalid mixed provider fields rejected; lossless IDs                  |
| Ingress                 | Real cryptographic fixtures; altered body, wrong key/app, expired timestamp, malformed headers, oversized payload, PING, duplicates |
| Deadline/durability     | Slow DB/key lookup, worker crash at every handoff boundary, duplicate acknowledgement, no unrecorded execution                      |
| Authority               | Wrong tenant/guild/app/actor, inactive owner, revoked link, deleted agent, changed installation/channel revision                    |
| Management              | CSRF/state mismatch, installation hijack, unauthorized guild manager, duplicate route, concurrent replace, token rotation           |
| Lanes                   | Two actors in one channel cannot inherit private response chains; route revision isolates subsequent work                           |
| Delivery                | Unicode/code fences, mention suppression, multiple chunks, 429, permanent access loss, timeout after send, nonce-window expiry      |
| Lifecycle               | Disconnect/delete during queued/running/delivering work, deleted status message, unavailable guild, stale worker lease              |
| Consent/actions         | Browser acceptance without external confirmation, expired token, forwarded button, other actor, double click, stale review          |
| Feedback                | Wrong source message, duplicate vote, replace/remove, retention expiry, owner/access loss                                           |
| UI                      | Discord with Slack unavailable; loading/empty/error/success; secret replacement; failed refetch; keyboard and screen-reader use     |
| Gateway phase           | Resume/replay, invalid session, shard ownership loss, Identify limits, missing intents, DM ambiguity, archived/private thread       |
| Compatibility           | Legacy Slack records and both Slack deployment modes; old gateway fails closed on Discord; disable/rollback behavior                |

Start with existing focused tests in `packages/data-schemas/src/methods/channel*.spec.ts`, `packages/api/src/channels/*.spec.ts`, `packages/channel-gateway/src/*.spec.ts`, and the Channels/account-link component tests. Parameterize genuinely shared authority/run invariants for both providers; keep provider protocol tests distinct. Use real database transactions for persistence tests and real signature verification; mock external Discord HTTP rather than internal authorization logic.

Run lint on every changed JS/TS file, scoped import formatting, focused owning-workspace Jest with `--findRelatedTests` and `--maxWorkers=2`, and incremental TypeScript checks with build info outside tracked files. Build required internal packages first. Add focused E2E coverage alongside `e2e/specs/mock/scenarios/agent-channels-ui.spec.ts` and `channel-account-lifecycle.spec.ts`. Use a dedicated Discord test application and guild for command registration, permissions, interaction deadlines, long-running completion after token expiry, and eventual Gateway reconnect checks. Mock tests cannot prove Discord accepts the actual deployment.

Use `lc` for any local LibreChat server and stop it after checks. Do not run destructive migrations against the shared development database. If implementation changes startup/auth/config/message-loading paths, run the required Lighthouse lane and investigate query regressions. Apply static checks and the repository review/closeout workflow for implementation PRs. Record environment failures separately from implementation failures.

## 14. Release, rollback, and unresolved choices

Release behind a provider-specific flag. Roll out to one test application/guild, then selected organizations, then general availability after real delivery and failure evidence. Keep Slack live during every stage. First deploy additive schemas/contracts, then compatible services/workers/UI, then enable Discord. Verify the public endpoint before registering production commands or inviting users.

Rollback first closes Discord admission and disables its commands/routes, then drains or explicitly cancels admitted work while compatible workers still exist. Preserve receipts and audit state. Do not deploy older binaries against live Discord records or drop additive fields/indexes as the first rollback step. A disabled feature must still let users revoke consent and administrators remove installations.

Resolve these product choices before their dependent implementation, using the recommended defaults above to avoid blocking foundational work:

1. Is slash-command-first acceptable, or are mentions/DMs required for the initial public launch? If required, move slice 6 into the launch gate.
2. Are shared-channel replies acceptable for linked personal accounts? If private responses are required, specify a separate durable private destination and failure policy before building delivery.
3. Is organization-managed application ownership sufficient, or must a centrally hosted application serve multiple tenants? The latter changes credential authority and operational isolation.
4. Should users work only in explicitly bound channels, or should a guild-wide agent selector/default exist? Explicit binding is the safer first scope.
5. Are buttons and web review sufficient, or are reactions, native modals, and files launch requirements? Each adds a distinct platform contract.

The next implementation gate is coherent thread and DM execution: source resolution, actor-scoped continuity, current permission checks and durable delivery must agree on the same real destination. The completed foundation remains protected by the existing Slack regression suites.

## 15. Sources and planning validation

Repository paths above were inspected directly. Discord platform constraints were checked against these official documents:

- [Interactions overview and request signatures](https://docs.discord.com/developers/interactions/overview)
- [Receiving and responding, deadlines and token lifetime](https://docs.discord.com/developers/interactions/receiving-and-responding)
- [Application commands and registration](https://docs.discord.com/developers/interactions/application-commands)
- [OAuth2 and bot authorization](https://docs.discord.com/developers/topics/oauth2)
- [Gateway intents, sessions, and sharding](https://docs.discord.com/developers/events/gateway)
- [Permissions and thread behavior](https://docs.discord.com/developers/topics/permissions)
- [Rate limits](https://docs.discord.com/developers/topics/rate-limits)
- [Messages, allowed mentions, and nonce behavior](https://docs.discord.com/developers/resources/message)

Implementation evidence is summarized in the status table and recorded with the corresponding stack slices. Unit tests, typechecks, lint, deployment rendering, built-process smoke and browser scenarios have run on those slices; they do not replace live Discord verification. No live Discord success is claimed. The pre-existing root-worktree `package-lock.json` modification remains outside this plan.
