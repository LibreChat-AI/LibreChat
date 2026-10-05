# Media runtime contracts

`application.ts` assembles the host from injected config, models, storage strategies,
provider transport, event transport, logging and shutdown services. `/api` wires the
result into the normal and experimental hosts. `media.enabled` controls new work;
owner access to retained Files and recovery of existing jobs remain separate.

## Ownership and persistence

Studio threads, turns and jobs use owner/tenant scopes. The data-schemas methods own
the database queries, Date-valued deadlines, version checks and lease fencing. The
service validates capabilities and admission before recording work. The worker
persists submission intent before a paid provider call and never repeats an
uncertain submission just to recover its output. Retry creates an independent
attempt; recovery reconciles the original attempt.

Originals are ordinary File records. Storage strategies plan and write immutable
bytes, while publication records the File and the job's ordered output reference.
`worker/outputs.ts` restores published output and resumes incremental publication
under the worker's serialized lease. Derivative failure preserves the original.
Message, share, import and fork writers claim File ownership before publishing a
reference; compensation removes only that writer's claim. Retirement respects live
consumers, expiry and account deletion fences. The shared expired-File sweep owns
physical expiration; the media worker repairs incomplete publication and retirement.

## Native chat

The injected SDK port leaves model invocation and accounting with chat. New native
images use normal File storage. Private continuation signatures are stored on the
owning Message and projected through an owner/tenant/conversation-scoped batch
reader. Private, generation-fenced job metadata preserves those signatures for
cross-process stop; terminal events, exports and share snapshots strip them. Legacy
native-part records have a bounded compatibility reader and cleanup lane, not a new
write path. Editing a signed response detaches its continuation metadata atomically.

## Credentials and accounting

Credential resolution receives the environment and key repository. A connection
binding identifies the effective principal/project or saved-key content, so token
refresh and unrelated envelope edits do not invalidate continuation. Keys, tokens
and provider signatures must not become logs, activity events or public metadata.

Each job freezes its admitted accounting mode and pricing inputs. Balance mode
reserves before dispatch and settles through the shared Transaction ledger;
transactions-only mode records usage without a debit. Unknown paid outcomes remain
liabilities for reconciliation. Shortfall handling protects other live holds and
distinguishes a provider overrun from concurrent chat spending. Native chat does
not enter the Studio settlement path.

## Cancellation, shutdown and observation

Cancellation is durable intent. Provider confirmation, local interruption and an
unknown paid outcome are distinct states. Pre-drain closes the dispatch gate;
shutdown budgets include bounded post-abort cleanup. Database maintenance follows
the host leader in bounded pages; local staging cleanup runs in every process.

Activity uses a dedicated instance of the shared event-transport interface, with
hashed owner scopes, subscriber demand and sequence-frontier synchronization. It
only invalidates snapshots on phase changes and output publication. Polling remains
the recovery path. Worker health describes the local scanner; durable enqueue and
HTTP readiness do not depend on that process being the active worker.

Provider attempts establish an active trace context. Lifecycle events, bounded
failure codes and durable backlog metrics use host observability services. Tracing
failures cannot replace the provider result. Operator setup and controls belong in
the companion librechat.ai configuration and Media Studio documentation.
