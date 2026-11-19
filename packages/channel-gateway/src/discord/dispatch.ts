import { discordMentionPrompt } from 'librechat-data-provider';
import type { DiscordChannelConfig, DiscordGatewayBootstrap } from 'librechat-data-provider';
import type { DiscordGatewayEvent, DiscordGatewayOwner } from './gateway';
import type { DiscordRuntimeClient } from './discovery';
import type { DiscordRateCoordinator } from './rates';
import { DiscordClient } from './client';

/** Only an explicit own-bot mention reaches source inspection or private admission. */
export async function dispatchDiscordEvent(
  deps: {
    owner: DiscordGatewayOwner;
    application: DiscordGatewayBootstrap;
    policy: DiscordChannelConfig;
    rates: DiscordRateCoordinator;
    runtime: DiscordRuntimeClient;
    transport: typeof fetch;
  },
  event: DiscordGatewayEvent,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (
    event.applicationId !== deps.owner.applicationId ||
    event.applicationRevision !== deps.owner.applicationRevision ||
    event.ownerId !== deps.owner.ownerId ||
    deps.application.applicationId !== deps.owner.applicationId ||
    deps.application.applicationRevision !== deps.owner.applicationRevision
  )
    throw new Error('Discord event ownership changed');
  if (event.kind !== 'message' || !discordMentionPrompt(event, deps.application.botUserId)) return;
  const client = new DiscordClient(
    {
      botToken: deps.application.botToken,
      timeoutMs: deps.policy.requestTimeoutMs,
      maxResponseBytes: deps.policy.maxResponseBytes,
    },
    deps.transport,
    deps.rates,
  );
  const source = event.guildId
    ? await client.inspectGuildTextSource(
        {
          applicationId: deps.owner.applicationId,
          botUserId: deps.application.botUserId,
          guildId: event.guildId,
          channelId: event.channelId,
        },
        signal,
      )
    : null;
  signal.throwIfAborted();
  await deps.runtime.message(deps.owner, event, source, signal);
}
