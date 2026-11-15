import { z } from 'zod';
import type { ChannelExternalIdentity } from './types/channelIdentity';
import type { ProviderAgentChannel } from './types/channels';
import type { ChannelRunActor } from './types/channelRuns';

const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\w:.-]+$/);

/** Snowflakes are unsigned 64-bit decimal strings, never JavaScript numbers. */
export const channelSnowflakeSchema = z
  .string()
  .regex(/^[1-9]\d{0,19}$/)
  .refine((value) => value.length < 20 || value <= '18446744073709551615');

export const channelRunActorSchema = z.union([
  z.object({ teamId: identifier, appId: identifier, externalUserId: identifier }).strict(),
  z
    .object({
      provider: z.literal('discord'),
      applicationId: channelSnowflakeSchema,
      guildId: channelSnowflakeSchema,
      externalUserId: channelSnowflakeSchema,
    })
    .strict(),
  z
    .object({
      provider: z.literal('discord'),
      scope: z.literal('dm'),
      applicationId: channelSnowflakeSchema,
      externalUserId: channelSnowflakeSchema,
      selectionId: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[\w-]+$/),
      selectionRevision: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[\w-]+$/),
    })
    .strict(),
]);

const identity = {
  tenantId: identifier,
  channelId: identifier,
  channelRevision: identifier,
  agentId: identifier,
};

export const channelExternalIdentitySchema = z.union([
  z.object({ ...identity, teamId: identifier, externalUserId: identifier }).strict(),
  z
    .object({
      ...identity,
      provider: z.literal('discord'),
      applicationId: channelSnowflakeSchema,
      guildId: channelSnowflakeSchema,
      externalUserId: channelSnowflakeSchema,
    })
    .strict(),
]);

/** Slack remains untagged so historical lane and event fingerprints do not change. */
export function sameChannelRunActor(a: ChannelRunActor, b: ChannelRunActor): boolean {
  if (!channelRunActorSchema.safeParse(a).success || !channelRunActorSchema.safeParse(b).success)
    return false;
  if (a.externalUserId !== b.externalUserId) return false;
  if (a.provider === 'discord') {
    if (b.provider !== 'discord' || a.applicationId !== b.applicationId) return false;
    if (a.scope === 'dm')
      return (
        b.scope === 'dm' &&
        a.selectionId === b.selectionId &&
        a.selectionRevision === b.selectionRevision
      );
    return a.scope === undefined && b.scope === undefined && a.guildId === b.guildId;
  }
  return (
    a.provider === undefined &&
    b.provider === undefined &&
    a.teamId === b.teamId &&
    a.appId === b.appId
  );
}

export function sameChannelExternalIdentity(
  a: ChannelExternalIdentity,
  b: ChannelExternalIdentity,
): boolean {
  if (
    a.tenantId !== b.tenantId ||
    a.channelId !== b.channelId ||
    a.channelRevision !== b.channelRevision ||
    a.agentId !== b.agentId ||
    a.externalUserId !== b.externalUserId
  )
    return false;
  if (a.provider === 'discord')
    return (
      b.provider === 'discord' && a.applicationId === b.applicationId && a.guildId === b.guildId
    );
  return a.provider === undefined && b.provider === undefined && a.teamId === b.teamId;
}

export function channelActorMatchesChannel(
  channel: ProviderAgentChannel,
  actor: ChannelRunActor,
): boolean {
  if (!channelRunActorSchema.safeParse(actor).success) return false;
  if (channel.type === 'discord')
    return (
      actor.provider === 'discord' &&
      actor.scope === undefined &&
      actor.applicationId === channel.discord?.applicationId &&
      actor.guildId === channel.discord?.guildId
    );
  return (
    channel.type === 'slack' &&
    actor.provider === undefined &&
    actor.scope === undefined &&
    actor.teamId === channel.slack?.teamId &&
    actor.appId === channel.slack?.appId
  );
}
