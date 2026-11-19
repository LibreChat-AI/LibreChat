import { z } from 'zod';
import { channelRunActorSchema, channelSnowflakeSchema } from './channelProvider';
import { discordGuildTextActorSourceSchema } from './types/discordMessage';
import { discordGuildThreadSourceSchema } from './types/discordThread';
import { discordGatewayOwnerSchema } from './types/discordGateway';

const reference = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w-]+$/);
export const discordGuildThreadDestinationSchema = z
  .object({
    kind: z.literal('guild_thread'),
    parentChannelId: channelSnowflakeSchema,
    mappingRevision: reference,
  })
  .strict();
export const discordDmDestinationSchema = z
  .object({
    kind: z.literal('dm'),
    parentChannelId: channelSnowflakeSchema,
    selectionId: reference,
    selectionRevision: reference,
  })
  .strict();
export const discordNativeDestinationSchema = z.discriminatedUnion('kind', [
  discordGuildThreadDestinationSchema,
  discordDmDestinationSchema,
]);
export type DiscordGuildThreadDestination = z.infer<typeof discordGuildThreadDestinationSchema>;
export type DiscordDmDestination = z.infer<typeof discordDmDestinationSchema>;
export type DiscordNativeDestination = z.infer<typeof discordNativeDestinationSchema>;

export const discordNativeAuthoritySchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('guild_text'),
        owner: discordGatewayOwnerSchema,
        source: discordGuildTextActorSourceSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('guild_thread'),
        owner: discordGatewayOwnerSchema,
        source: discordGuildThreadSourceSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('dm'),
        owner: discordGatewayOwnerSchema,
        source: discordGuildTextActorSourceSchema,
      })
      .strict(),
  ])
  .refine((value) => value.owner.applicationId === value.source.applicationId);
export type DiscordNativeAuthority = z.infer<typeof discordNativeAuthoritySchema>;
export const discordRunEffectAuthoritySchema = z
  .object({ applicationRevision: reference, native: discordNativeAuthoritySchema.optional() })
  .strict()
  .refine(
    (value) =>
      !value.native || value.native.owner.applicationRevision === value.applicationRevision,
  );
export type DiscordRunEffectAuthority = z.infer<typeof discordRunEffectAuthoritySchema>;

/** Absence preserves historical guild-text and Slack wire shapes and fingerprints. */
const eventKey = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\w:.-]+$/);
export const channelRunAdmissionSchema = z
  .object({
    eventId: eventKey,
    externalChannelId: eventKey,
    externalThreadKey: eventKey,
    externalMessageKey: eventKey,
    actor: channelRunActorSchema,
    input: z.string().min(1).max(100000),
    discordDestination: discordNativeDestinationSchema.optional(),
  })
  .strict()
  .refine((admission) => {
    const { actor, discordDestination } = admission;
    if (!('provider' in actor)) return discordDestination === undefined;
    if (discordDestination?.parentChannelId === admission.externalChannelId) return false;
    if (!('scope' in actor)) return discordDestination?.kind !== 'dm';
    return (
      discordDestination?.kind === 'dm' &&
      actor.selectionId === discordDestination.selectionId &&
      actor.selectionRevision === discordDestination.selectionRevision
    );
  });
export function sameDiscordNativeDestination(
  a: DiscordNativeDestination | undefined,
  b: DiscordNativeDestination | undefined,
): boolean {
  if (!a || !b) return a === b;
  if (a.parentChannelId !== b.parentChannelId || a.kind !== b.kind) return false;
  if (a.kind === 'dm')
    return (
      b.kind === 'dm' &&
      a.selectionId === b.selectionId &&
      a.selectionRevision === b.selectionRevision
    );
  return b.kind === 'guild_thread' && a.mappingRevision === b.mappingRevision;
}
