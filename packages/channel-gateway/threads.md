Native thread routing pins an actual Discord thread to its original configured parent agent binding. The mapping records the parent channel, installation, channel revision and route revision. Credential rotation keeps the mapping usable through the current application revision and owner lease.

After replacing a parent agent binding, start a new Discord thread. Existing conversations never select the replacement agent automatically. This protocol provides no implicit mapping replacement.

A mapping identifies a destination. Each admission or consequential delivery must also supply a fresh source observation and authorize the acting user's current LibreChat link. The actual thread ID owns delivery addresses and actor lanes; the parent channel ID identifies the configured binding. Gateway mentions and signed slash asks in the same thread share an actor-specific lane and conversation. A different actor has a separate lane. Guild text asks outside a thread retain a fresh lane per event.

The bot requires `VIEW_CHANNEL`, `READ_MESSAGE_HISTORY` and `SEND_MESSAGES_IN_THREADS`. The acting user requires `VIEW_CHANNEL`; a signed command remains usable in a read-only thread. Private access requires current membership or `MANAGE_THREADS` for both actors; administrator bypass applies. Archived and locked threads are refused, so the integration does not implicitly reopen them. Single-member lookups avoid the privileged member-list intent.

`endpoints.agents.channels.discord.gateway.maxThreadRoutes` bounds retained mappings per application, including retired opaque pins. The default is 10,000 and the maximum is 100,000. Private mapping data is erased before its parent disappears. The remaining pin retains only the application ID, thread ID and a fingerprint, preventing cleanup from silently selecting a different agent later. Increase the configured cap when necessary; deleting private rows does not remove a thread's original pin.

Official permission and membership contracts: [Threads](https://docs.discord.com/developers/topics/threads#permissions) and [Get Thread Member](https://docs.discord.com/developers/resources/channel#get-thread-member).

## Interaction preflight protocol

An interaction's partial channel object does not guarantee the parent channel ID. An
unresolved inbox record therefore retains only the signed physical source and the
current application and guild installation revisions. It has `routing: inspection`
and no internal channel, agent, or fabricated parent destination.

Inspection claims return the inbox fence, expiration, application revision, and real
guild/channel/actor IDs. They do not expose the interaction token or prompt. The same
inbox lease, capacity bounds, expiration and opaque erasure receipts apply. Unresolved
records cannot authorize command effects. An owned resolver may prepare only a fixed
private unavailable reply without inventing a binding. That reply remains terminal and
cannot later become executable work.

The protected `/service/inbox/resolve` endpoint accepts the exact inbox fence, current
application owner and fresh thread source. The server derives the parent binding, joins
the current owner and immutable mapping, and reserves execution once per lease epoch.
Concurrent resolves cannot both execute. Lease reclamation increments the epoch and
requires another source inspection, allowing recovery through the same durable loop.
Prepared replies replay without re-executing a command.

The production gateway composes the submission fallback, owned source inspection and
thread executor. Signed thread commands and Gateway mentions both derive the parent
through a fresh Discord API inspection, then join the persisted binding and mapping before
admission. The signed interaction's partial channel object is not parent authority.
A worker without the owned inspection adapter terminates an inspection claim as unavailable.
Existing guild text submissions and prepared reply delivery retain their wire format.
