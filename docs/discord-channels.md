# Discord Agent Channels: Operator Guide

Discord Agent Channels connect an organization-owned Discord application and server text
channel to a LibreChat agent. Each person links their own LibreChat account and grants
consent. Agent execution uses that person's current LibreChat access and credentials.

Slack and Discord are independent providers. A deployment supporting both runs a separate
gateway process for each provider, alongside the API. Discord does not require Slack setup.

## Requirements and Boundaries

- Run a release containing Discord Channels, with matching API and gateway images.
- Use transaction-capable MongoDB, such as a replica set. Back up an existing database
  before changing its topology. The deployment overlays do not make standalone MongoDB
  transaction-capable automatically.
- Configure public HTTPS `DOMAIN_SERVER` and `DOMAIN_CLIENT` for LibreChat OAuth and account
  linking. Configure the Discord gateway's separate public URL in YAML, as shown below.
- Give the API and gateways the same private `CHANNEL_SERVICE_TOKEN` of at least 32
  characters. Keep `CREDS_KEY`, `CREDS_IV` and the database backed up securely so stored
  application credentials remain decryptable after restarts.
- Application and server setup requires the organization installation-management capability.
  Binding additionally requires permission to share the selected agent. Users need Agents
  and Remote Agents use permissions, current agent access, and personal consent.

Bindings support regular server text channels only. Threads and direct messages use the
existing binding and cannot be bound separately. Forum channels and other parent channel
types are unsupported. One application/server/channel
destination has one active agent binding. Replacing a binding closes the previous binding
and requires new personal consent. Reconnecting a disconnected server also requires new
bindings and consent.

Discord links restored without a recorded native confirmation time are treated as expired.
Run `/librechat link`, choose the LibreChat account in the browser and confirm that account
in Discord again. Then send a fresh prompt. Messages and slash prompts created before the
current confirmation cannot start new runs; already authorized runs retain their normal lifecycle.

Never paste bot tokens, OAuth client secrets, service tokens or encryption keys into a chat,
issue, screenshot or log. Application credentials belong in the authenticated setup form.
They are encrypted in organization storage and never returned by the setup API. The public
application ID and verification key are distinct from these secrets.

## Enable Server Policy

Merge this into the existing `librechat.yaml`; retain the deployment's existing version and
other settings:

```yaml
endpoints:
  agents:
    remoteApi:
      background:
        enabled: true
    channels:
      enabled: true
      discord:
        enabled: true
        publicUrl: https://discord.example.com
        gateway:
          enabled: false
          messageContent: false
```

`channels.enabled` and `discord.enabled` enable Discord setup and execution policy. Stored
background Responses must also be enabled for agent runs. Deploying the gateway alone does
not enable either policy.

The nested `discord.gateway.enabled` switch controls the optional Discord WebSocket Gateway
for ordinary bot mentions. Slash commands and their signed HTTP interaction endpoint do
not require that switch. Both Gateway message ingestion and privileged Message Content
intent are disabled by default. To opt in to bot mentions, set `gateway.enabled: true`.
Set `gateway.messageContent: true` only when you intentionally want that privileged intent,
and enable or obtain approval for it in the Discord Developer Portal as required by Discord.
Without Message Content intent, Discord can still include content for messages mentioning
the bot. This integration admits supported mentions in bound text channels; it does not
forward every server message to an agent. Supported native threads inherit their parent
text-channel binding. Private threads also require current membership; archived or locked
threads cannot receive new agent work.

`publicUrl` is the public HTTPS base of the Discord gateway, independent of the LibreChat
website and Slack gateway. The server builds each application's interactions endpoint as
`<publicUrl>/discord/<applicationId>/interactions`. It rejects URL credentials, query
parameters and fragments. HTTP loopback URLs are accepted for local configuration checks,
but Discord needs a reachable public HTTPS endpoint for real interactions.

A prefix such as `https://example.com/chat-discord` requires a reverse proxy that strips
`/chat-discord` before forwarding to the gateway. The runtime and chart route `/discord/`.
Do not infer this URL from the browser origin. When `publicUrl` is absent, setup explicitly
indicates that public ingress configuration is needed.

## Docker Compose

Use the checked-in Discord overlay with the base Compose file. Set a release-matched
`LIBRECHAT_IMAGE_TAG` and provision the shared service token through the deployment's
private environment or secret-management system before starting it:

```sh
docker compose -f docker-compose.yml -f docker-compose.discord.yml \
  --profile channels config --quiet
docker compose -f docker-compose.yml -f docker-compose.discord.yml \
  --profile channels up -d
```

For source builds, add `-f docker-compose.discord-build.yml` after the Discord overlay and
use `up -d --build`. Do not mix an API from one release with a gateway from another.

The `discord-gateway` service uses `CHANNEL_PROVIDER=discord` and discovers applications
through the protected API. It has no bound `CHANNEL_ID` or tenant ID. Bot tokens and client
secrets do not belong in this service's environment. Its HTTP port is published on loopback
as `127.0.0.1:3082` by default; `DISCORD_GATEWAY_PORT` changes that host port.

Route public `/discord/` requests to this listener through an HTTPS reverse proxy. Preserve
the request body bytes and Discord signature headers. Keep `/livez`, `/readyz`, `/healthz`,
`/metrics` and all API `/api/channels/discord/service/` routes off the public gateway route.
The gateway must reach LibreChat over its private `LIBRECHAT_INTERNAL_URL`.

For both providers, include the Slack overlays as well. This creates two services:

```sh
docker compose -f docker-compose.yml -f docker-compose.channels.yml \
  -f docker-compose.slack-workspaces.yml -f docker-compose.discord.yml \
  --profile channels config --quiet
```

Slack remains `channel-gateway` on its own loopback port and public Slack paths. Discord
remains `discord-gateway` on its own port and `/discord/` paths. A single process cannot
serve both providers. Slack-specific automatic environment settings do not enable Discord.

For a new local transaction-capable MongoDB deployment, inspect
[`docker-compose.mongo-replica.yml`](../docker-compose.mongo-replica.yml) and its existing-data
guidance before adding it to the command. Do not apply it blindly to a populated standalone
database. Production MongoDB authentication, backup and availability remain deployment
responsibilities.

## Helm

The existing `channelGateway.enabled` and `channelGateway.mode` settings continue to
configure Slack. Enable Discord independently:

```yaml
image:
  tag: YOUR_RELEASE_TAG
global:
  librechat:
    existingSecretName: librechat-credentials-env
librechat:
  existingConfigYaml: librechat-policy
channelGateway:
  enabled: false
  discord:
    enabled: true
    replicaCount: 1
    resources: {}
    podAnnotations: {}
    ingress:
      enabled: true
      className: nginx
      host: discord.example.com
      tls:
        - secretName: discord-gateway-tls
          hosts:
            - discord.example.com
```

This example assumes existing credential, policy ConfigMap and TLS Secrets. The policy
ConfigMap must provide `librechat.yaml` with the server policy above. Alternatively set
`librechat.configYamlContent`. Add `CHANNEL_SERVICE_TOKEN` to the existing credentials
Secret without replacing its other keys. API and gateways must read the same token.

The chart renders a distinct `discord-gateway` Deployment, Service and optional Ingress.
It forces shared discovery and sets `CHANNEL_PROVIDER=discord`; it accepts no Discord bot
credential values. Common `channelGateway.image`, `internalUrl`, `existingSecretName` and
`appTitle` settings apply to both providers. Discord has separate replica count, resources,
pod annotations and ingress settings. Its ingress exposes only `/discord/`.

When Discord is enabled and Slack is disabled, the API still receives the shared service
token. Automatic Slack flags are added only for enabled shared Slack mode. To run both,
configure Slack normally and set `channelGateway.discord.enabled: true`; provider Services
have distinct selectors. Discord replicas use RollingUpdate and application ownership
fences. Replica count is not the Discord shard count; `discord.gateway.shardCount` is a
separate server policy and must match Discord's application requirements when using Gateway
messages.

The chart refuses shared gateways with bundled standalone MongoDB. Configure a replica
set or an external transaction-capable `MONGO_URI` before enabling them. Render and inspect
your values before deployment. This guide does not require deploying the chart to validate
configuration.

## Register an Application and Connect a Server

1. In the [Discord Developer Portal](https://discord.com/developers/applications), create or
   select an organization-owned application and bot. Enable **Require OAuth2 Code Grant**.
   Keep the bot token and OAuth client secret private.
2. In LibreChat, open **Settings > Account > Discord**. Copy the server-provided **OAuth
   callback URL** into the application's OAuth2 redirect URLs. This callback belongs to
   LibreChat, not the gateway.
3. Choose **Add application** and enter its application ID, bot token and OAuth client
   secret. LibreChat verifies the application and bot identity. Saving credentials does
   not install the bot or register commands automatically.
4. Copy the application's **Interactions endpoint URL** into the Developer Portal. Discord
   validates it with a signed request. Check public ingress and gateway readiness if that
   validation fails; do not disable signature verification.
5. Choose **Register or update /librechat commands** on the application card. This explicit
   action upserts the global `/librechat` command without replacing other command names.
   The command is restricted to server installations and server invocation contexts.
   Global command changes can take time to appear in Discord.
6. Choose **Connect server** and complete Discord authorization with an account permitted
   to manage that server. Review the requested bot permissions. Keep the initiating
   LibreChat session open. If the popup is blocked, allow it and refresh server status
   before starting another attempt. Use the displayed cancel action to abandon a pending
   attempt. A successful server entry must show **Connected**.
7. Open the selected agent's **Channels** surface, select **Discord**, choose a connected
   server and enter a regular text channel ID. Discord Developer Mode provides **Copy
   Channel ID**. The bot needs **View Channel**, **Send Messages** and **Read Message
   History** in that exact channel, including role and channel permission overwrites.
8. Check the current binding, then choose **Connect channel**. If another agent owns the
   destination, review the replacement confirmation. A message saying the operation could
   not be confirmed requires **Check current binding** before another mutation; do not
   blindly repeat it.

An administrator can manage multiple server installations of the same application. Select
the intended application and server explicitly. Installation access does not grant a user
access to every agent, and a Discord user or server ID is never a LibreChat tenant selector.

## Personal Linking and Use

In a bound server text channel, run `/librechat link`. Open the account-link URL, sign in to
the intended LibreChat account and review the requested agent consent. Complete the Discord
confirmation step when prompted. Each person must do this independently.

Use `/librechat ask prompt: ...` to start an agent run, `/librechat status` to inspect the
current run, and `/librechat cancel` to request cancellation. These commands work in a bound
text channel, a supported thread beneath it, or an explicitly selected bot DM. Bot mentions
use the optional Gateway message path described above. Unsupported events, bot-authored
messages, unbound channels and missing consent do not grant execution.

Repeated prompts in the same native thread share the invoking person's conversation lane,
including when switching between slash commands and mentions. Another person has a separate
lane. Replies stay in the thread; a failed thread permission check never redirects output
to its parent channel.

Bindings use per-user conversation isolation. This does not make Discord channel messages
private: other people who can read that Discord channel can read messages posted there.
Choose an appropriate channel and do not send secrets in prompts.

### Select an Agent for Direct Messages

Direct messages are disabled by default. Set
`endpoints.agents.channels.discord.dm.enabled: true` to allow selection codes and new DM
execution. Signed DM slash commands do not require `discord.gateway.enabled`. Ordinary DM
messages require both switches. Deploy matching API and gateway versions before enabling
either path.

After confirming a server account link, open **Settings > Account > Discord Direct Messages**.
Choose **Use in Direct Messages** beside the intended agent, Discord account, server and
application. Choose **Generate Code**, then run `/librechat select` in a direct message with
that Discord app and paste the value into its `code` option. Generating a code does not
select an agent until the same Discord account confirms it in the bot DM.

Keep the code private. It expires at the displayed time, and closing its dialog removes
it from the browser UI. Generating another code for the same account and application
invalidates the previous unused code. Replaying a used code cannot extend the selection
or replace a newer selection. The browser does not store the code in query caches,
mutation history, local storage or session storage.

Each selection keeps its original server-channel authority and account consent; a DM is
not a way around server access. Settings lists selection status and expiry, with paginated
history and retry for failed loads. **Revoke DM Selection** requires confirmation and
remains available when the source is unavailable or new DM selections are disabled.
Revoking a DM selection leaves its server account link intact. Disconnecting that account
link makes dependent selections unavailable.

After selection, use `/librechat ask` in that bot DM, or send a normal DM when Gateway
message ingestion is enabled. Answers are delivered to that DM channel. Status, Cancel,
Stop, review links and answer feedback remain bound to the requesting account and current
selection. Changing the selected agent does not transfer old runs or answer controls to
the replacement selection. A prompt sent before selection confirmation cannot start work.

Turning off `discord.dm.enabled` blocks new DM execution. Existing response metadata can
still settle, and authorized status, cancellation, review and feedback remain available;
new output still requires current source permissions and selection authority. Revoking,
replacing or expiring the selection prevents queued prompts from obtaining execution
credentials. To resume, make a new selection and send a fresh prompt.

## Rotation, Disconnect and Recovery

- Use **Update credentials** to rotate a stored application's credentials. Blank secret
  fields retain their current values. Saved values are never echoed. Refresh after a
  revision-change response, then retry using the current application state.
- Use **Disconnect server** to stop accepting new work for that installation. Discord may
  still show the bot as installed. Reconnect through a fresh OAuth flow, then recreate
  bindings and personal consent; old bindings do not reactivate automatically.
- Use **Remove binding** to stop new requests for one destination. Replacement and removal
  operate on the displayed revision. Refetch after conflicts or uncertain results.
- Turning off provider policy blocks new setup and ingress. Authorized list, cancel and
  disconnect operations remain available for cleanup. Completed external actions cannot
  be undone by disabling a flag or disconnecting.
- Keep the database and encryption keys together during recovery. Restored, expired or
  revoked records must pass current application, installation, user and agent checks.
  Do not repair access by manually changing revisions or route records.

Fatal native Gateway stops (rejected bot credentials, invalid shard configuration or intents,
and identity mismatches) enter a per-process quarantine. Retries start at 30 seconds and double
to a 15-minute cap. Transient failures use jittered exponential delays capped at 60 seconds.
A credential revision change bypasses the previous revision's delay immediately; only a
verified healthy session lasting two minutes resets failure counters. Fix settings in the
Discord Developer Portal or rotate credentials in LibreChat, rather than repeatedly restarting
the gateway to clear its local delay.

The controls live under `endpoints.agents.channels.discord.gateway.recovery`:

| Setting                  | Default  | Purpose                                                         |
| ------------------------ | -------- | --------------------------------------------------------------- |
| `fatalRetryMinMs`        | `30000`  | First retry delay after a fatal stop                            |
| `fatalRetryMaxMs`        | `900000` | Maximum fatal retry delay                                       |
| `retryMaxMs`             | `60000`  | Maximum transient retry delay                                   |
| `resetAfterMs`           | `120000` | Verified session lifetime needed to reset failure counts        |
| `maxTrackedApplications` | `4096`   | Bound on active and delayed applications tracked by one process |

When recovery tracking is full, additional applications wait for capacity. An application
absent from a complete discovery scan releases its delayed slot; a failed discovery page
does not. Shutdown and lease loss do not quarantine an application.

Delivery records distinguish known failure from an uncertain send. A timeout can happen
after Discord accepted a message. Refresh run status and inspect the destination before
manually submitting another prompt. Restarting a gateway is not a reason to replay old
interaction requests or clear deduplication records.

## Rollback and Uninstall

Disable only `endpoints.agents.channels.discord.enabled` to stop new Discord setup and
admission. Do not disable the shared `channels.enabled` setting when Slack must keep working.
Restart or roll out the API configuration using the deployment's normal procedure. Removing
only the public HTTP route does not stop WebSocket mentions or ordinary DMs; stopping only
WebSocket ingestion does not stop signed slash commands.

For a full rollback, remove public routing to the Discord interaction endpoint and stop the
Discord gateway with its normal termination signal. Preserve the API long enough to inspect
and cancel outstanding runs through the authorized controls. Cancellation is a request,
not proof that an external tool action or a Discord message was undone. Record uncertain
send outcomes before changing versions. Do not clear inbox receipts, run receipts, thread
pins or consent records to force a retry.

Back up MongoDB together with the encryption keys before changing versions. Roll back API
and gateway images together to a known compatible release. Older gateways reject delivery
plans with an unsupported renderer version; they cannot safely finish a newer saved plan.
Keep Discord disabled when rolling back to a release without Discord support. Retained
Discord records are not a reason to drop shared collections, indexes or Slack data. Resume
with compatible versions and current authority checks, then complete the verification
checklist before reopening ingress.

To uninstall, remove bindings and disconnect each server through organization settings;
users can revoke account links and DM selections through account settings. Confirm those
operations succeeded before removing the Discord gateway deployment and public route.
Remove the bot from the test or production server through Discord, and revoke its bot token
and OAuth client secret in the Developer Portal if the application will no longer be used.
Do not revoke an application used by another deployment without coordinating its migration.
Remove that deployment's private secret references only after no component needs them.
Removing a bot does not delete its historical messages; handle that separately under the
server's retention policy. Keep opaque replay and thread-routing records for their intended
retention periods instead of manually deleting database rows.

## Dedicated Verification Checklist

Use a dedicated Discord test application, server, text channels and LibreChat test accounts.
Do not rotate production credentials or erase shared data for a test. Automated fixtures
cannot prove real Discord OAuth, command propagation or public proxy configuration.

- Render Compose with `config --quiet`, or render Helm with your values. Confirm separate
  provider Services, matching image tags, private token references and transaction-capable
  MongoDB. Never publish a rendered configuration containing secrets.
- Check private `/livez` and `/readyz` on the Discord gateway. Confirm public routing exposes
  `/discord/` only and preserves signed request bytes. Verify the Developer Portal accepts
  the application's interactions endpoint, including any public URL prefix rewrite.
- Add the test application, explicitly register commands, connect the intended server,
  and bind a text channel. Reject a wrong server/channel pair, non-text channel, or bot
  missing one of the required effective channel permissions.
- With two LibreChat users, link and consent independently. Verify an unlinked user cannot
  run the agent, linked users retain separate conversation state, and removing agent or
  Remote Agents access prevents subsequent work.
- Exercise `/librechat ask`, `status` and `cancel`. Retry a captured delivery through the
  test harness to verify deduplication, rather than manually replaying production signed
  requests. Inspect uncertain-delivery behavior without assuming it is a known failure.
- Replace a binding, remove it, disconnect and reconnect the server, and rotate test
  credentials. Confirm old destinations and old consent cannot regain authority. Refresh
  after conflicts and confirm no secret appears in UI responses or diagnostic output.
- In a native thread, mix slash asks and mentions and verify continuity for one actor and
  isolation for another. Remove private-thread membership or archive the thread and verify
  that output cannot move into the parent channel.
- Generate a DM code in account settings, consume it from the intended bot DM, then test
  ask, status, cancellation and feedback. Reject a different actor, an expired code and a
  code replay after replacement. Revoke the selection and verify a fresh prompt cannot
  execute. Check signed DM commands with Gateway ingestion disabled, and ordinary DMs
  with both policy switches enabled.
- If opting into Gateway messages, test mentions with its policy disabled and enabled.
  Test Message Content intent separately, then restart the gateway and confirm ownership
  recovery does not duplicate runs. Keep these tests separate from HTTP slash-command
  validation so a Gateway outage cannot be mistaken for an interactions configuration issue.

For repository checks, run focused suites in their owning workspaces. The Helm regression
is `node helm/librechat/tests/channel_gateway_render_test.mjs` with Helm on `PATH`; it renders
the real templates in an isolated fixture and runs strict Helm lint without fetching
unrelated subcharts. API, database and gateway suites cover authority, binding races,
OAuth/session fences, inbox deduplication, Gateway ownership and delivery outcomes.
