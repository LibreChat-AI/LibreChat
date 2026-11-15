Native thread routing pins an actual Discord thread to its original configured parent agent binding. The mapping records the parent channel, installation, channel revision and route revision. Credential rotation keeps the mapping usable through the current application revision and owner lease.

After replacing a parent agent binding, start a new Discord thread. Existing conversations never select the replacement agent automatically. This protocol provides no implicit mapping replacement.

A mapping identifies a destination. Each admission or consequential delivery must also supply a fresh source observation and authorize the acting user's current LibreChat link. The actual thread ID owns delivery addresses and actor lanes; the parent channel ID identifies the configured binding. Gateway messages share their actor-specific thread lane, while slash interactions retain a fresh lane per interaction.

Public and private threads require `VIEW_CHANNEL`, `READ_MESSAGE_HISTORY` and `SEND_MESSAGES_IN_THREADS`. Private access requires current membership or `MANAGE_THREADS`; administrator bypass applies. Archived and locked threads are refused, so the integration does not implicitly reopen them. Single-member lookups avoid the privileged member-list intent.

`channels.discord.gateway.maxThreadRoutes` bounds retained mappings per application, including retired opaque pins. The default is 10,000 and the maximum is 100,000. Private mapping data is erased before its parent disappears. The remaining pin retains only the application ID, thread ID and a fingerprint, preventing cleanup from silently selecting a different agent later. Increase the configured cap when necessary; deleting private rows does not remove a thread's original pin.

Official permission and membership contracts: [Threads](https://docs.discord.com/developers/topics/threads#permissions) and [Get Thread Member](https://docs.discord.com/developers/resources/channel#get-thread-member).
