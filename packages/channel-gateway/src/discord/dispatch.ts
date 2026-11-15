import { discordMentionPrompt } from 'librechat-data-provider';
import type { DiscordChannelConfig, DiscordGatewayBootstrap } from 'librechat-data-provider';
import type { DiscordGatewayEvent, DiscordGatewayOwner } from './gateway';
import type { DiscordGatewayControlClient } from './ownership';
import type { DiscordRuntimeClient } from './discovery';
import type { DiscordRateCoordinator } from './rates';
import { DiscordClient } from './client';

/** Guild messages require a bot mention; private messages require an explicit current selection. */
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
  if (
    event.kind === 'message' &&
    (event.guildId
      ? !discordMentionPrompt(event, deps.application.botUserId)
      : !deps.policy.dm.enabled ||
        (event.channelType !== undefined && event.channelType !== 1) ||
        event.authorId === deps.application.botUserId ||
        !event.content.trim())
  )
    return;
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
  if (!event.guildId) {
    const prepared = await deps.runtime.prepareDm(deps.owner, event, signal);
    if (!prepared) return;
    if (prepared.botUserId !== deps.application.botUserId)
      throw new Error('Discord DM preparation bot changed');
    const source = await client.inspectGuildTextActorSource(
      {
        applicationId: deps.owner.applicationId,
        botUserId: deps.application.botUserId,
        guildId: prepared.guildId,
        channelId: prepared.parentChannelId,
        authorId: event.authorId,
      },
      signal,
    );
    signal.throwIfAborted();
    await deps.runtime.dmMessage(deps.owner, event, prepared, source, signal);
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
