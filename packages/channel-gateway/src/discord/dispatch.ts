import { discordMentionPrompt } from 'librechat-data-provider';
import type { DiscordChannelConfig, DiscordGatewayBootstrap } from 'librechat-data-provider';
import type { DiscordGatewayEvent, DiscordGatewayOwner } from './gateway';
import type { DiscordGatewayControlClient } from './ownership';
import type { DiscordRuntimeClient } from './discovery';
import type { DiscordRateCoordinator } from './rates';
import { DiscordClient } from './client';

/** Owned guild removals require fresh membership inspection; messages require an own-bot mention. */
export async function dispatchDiscordEvent(
  deps: {
    owner: DiscordGatewayOwner;
    application: DiscordGatewayBootstrap;
    policy: DiscordChannelConfig;
    rates: DiscordRateCoordinator;
    runtime: DiscordRuntimeClient;
    gateway: DiscordGatewayControlClient;
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
  if (event.kind === 'guild' && event.state !== 'removed') return;
  if (event.kind === 'message' && !discordMentionPrompt(event, deps.application.botUserId)) return;
  if (event.kind !== 'guild' && event.kind !== 'message') return;
  const client = new DiscordClient(
    {
      botToken: deps.application.botToken,
      timeoutMs: deps.policy.requestTimeoutMs,
      maxResponseBytes: deps.policy.maxResponseBytes,
    },
    deps.transport,
    deps.rates,
  );
  if (event.kind === 'guild') {
    const { target } = await deps.gateway.prepareGuildRemoval(deps.owner, event.guildId, signal);
    if (!target || (await client.isGuildMember(event.guildId, signal))) return;
    signal.throwIfAborted();
    await deps.gateway.removeGuild(deps.owner, target, signal);
    return;
  }
  const source = event.guildId
    ? await client.inspectGuildTextActorSource(
        {
          applicationId: deps.owner.applicationId,
          botUserId: deps.application.botUserId,
          guildId: event.guildId,
          channelId: event.channelId,
          authorId: event.authorId,
        },
        signal,
      )
    : null;
  signal.throwIfAborted();
  await deps.runtime.message(deps.owner, event, source, signal);
}
