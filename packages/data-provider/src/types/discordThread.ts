import { z } from 'zod';
import { discordGuildTextSourceSchema } from './discordMessage';
import { channelSnowflakeSchema } from '../channelProvider';

const reference = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w-]+$/);
const permissions = discordGuildTextSourceSchema.shape.permissions;
/** A fresh trusted Gateway observation, never a persisted permission grant. */
export const discordGuildThreadSourceSchema = z
  .object({
    kind: z.literal('guild_thread'),
    applicationId: channelSnowflakeSchema,
    botUserId: channelSnowflakeSchema,
    guildId: channelSnowflakeSchema,
    parentChannelId: channelSnowflakeSchema,
    threadChannelId: channelSnowflakeSchema,
    authorId: channelSnowflakeSchema,
    threadType: z.union([z.literal(11), z.literal(12)]),
    archived: z.boolean(),
    locked: z.boolean(),
    permissions: z.object({ bot: permissions, author: permissions }).strict(),
    membership: z.object({ bot: z.boolean(), author: z.boolean() }).strict(),
  })
  .strict()
  .refine((source) => source.parentChannelId !== source.threadChannelId);
export type DiscordGuildThreadSource = z.infer<typeof discordGuildThreadSourceSchema>;
export const discordThreadBindingSchema = z
  .object({ channelId: reference, channelRevision: reference, routeRevision: reference })
  .strict();
export type DiscordThreadBinding = z.infer<typeof discordThreadBindingSchema>;
export const discordThreadRouteSchema = discordThreadBindingSchema
  .extend({
    tenantId: z.string().min(1).max(128).optional(),
    applicationId: channelSnowflakeSchema,
    botUserId: channelSnowflakeSchema,
    guildId: channelSnowflakeSchema,
    parentChannelId: channelSnowflakeSchema,
    threadChannelId: channelSnowflakeSchema,
    threadType: z.union([z.literal(11), z.literal(12)]),
    installationId: reference,
    installationRevision: reference,
    mappingRevision: reference,
  })
  .strict();
export const discordThreadReferenceSchema = discordThreadRouteSchema.pick({
  parentChannelId: true,
  mappingRevision: true,
});
export type DiscordThreadReference = z.infer<typeof discordThreadReferenceSchema>;
export type DiscordThreadRoute = z.infer<typeof discordThreadRouteSchema>;
/** Reject archive/lock changes rather than implicitly reopening a conversation. */
export function discordThreadUsable(value: DiscordGuildThreadSource): boolean {
  const parsed = discordGuildThreadSourceSchema.safeParse(value);
  if (!parsed.success || parsed.data.archived || parsed.data.locked) return false;
  const source = parsed.data;
  const botRequired = BigInt(1024 | 65536) | (BigInt(1) << BigInt(38));
  return (['bot', 'author'] as const).every((actor) => {
    const bits = BigInt(source.permissions[actor]);
    const admin = (bits & BigInt(8)) !== BigInt(0);
    const required = actor === 'bot' ? botRequired : BigInt(1024);
    if (!admin && (bits & required) !== required) return false;
    return (
      source.threadType !== 12 ||
      source.membership[actor] ||
      admin ||
      (bits & (BigInt(1) << BigInt(34))) !== BigInt(0)
    );
  });
}
/** Gateway messages use an actual-thread lane; slash interactions retain their own event lanes. */
export function discordThreadAddress(
  threadChannelId: string,
  messageId: string,
): { externalChannelId: string; externalThreadKey: string; externalMessageKey: string } {
  channelSnowflakeSchema.parse(threadChannelId);
  channelSnowflakeSchema.parse(messageId);
  return {
    externalChannelId: threadChannelId,
    externalThreadKey: `${threadChannelId}:${threadChannelId}`,
    externalMessageKey: `${threadChannelId}:${messageId}`,
  };
}
