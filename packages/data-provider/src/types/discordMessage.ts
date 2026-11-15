import { z } from 'zod';
import { discordGuildThreadSourceSchema } from './discordThread';
import { discordGuildTextSourceSchema } from './discordSource';
import { discordGatewayOwnerSchema } from './discordGateway';
import { channelSnowflakeSchema } from '../channelProvider';
export { discordGuildTextSourceSchema } from './discordSource';
export type { DiscordGuildTextSource } from './discordSource';

export const discordGatewayMessageSchema = discordGatewayOwnerSchema
  .extend({
    kind: z.literal('message'),
    shardId: z.number().int().min(0).max(127),
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    messageId: channelSnowflakeSchema,
    channelId: channelSnowflakeSchema,
    guildId: channelSnowflakeSchema.optional(),
    authorId: channelSnowflakeSchema,
    content: z.string().max(6000),
    mentionsBot: z.boolean(),
    replyToMessageId: channelSnowflakeSchema.optional(),
    channelType: z.number().int().min(0).max(100).optional(),
  })
  .strict();
export type DiscordGatewayMessage = z.infer<typeof discordGatewayMessageSchema>;
/** Fresh per-actor observation, not a stored grant or inferred channel membership. */
export const discordGuildTextActorSourceSchema = discordGuildTextSourceSchema
  .extend({
    authorId: channelSnowflakeSchema,
    authorMember: z.literal(true),
    authorPermissions: discordGuildTextSourceSchema.shape.permissions,
  })
  .strict();
export type DiscordGuildTextActorSource = z.infer<typeof discordGuildTextActorSourceSchema>;
export const discordMessageSubmissionSchema = z
  .object({
    owner: discordGatewayOwnerSchema,
    event: discordGatewayMessageSchema,
    // Legacy bot-only decoding does not prove the actor can currently access the source.
    source: z
      .union([
        discordGuildTextActorSourceSchema,
        discordGuildTextSourceSchema,
        discordGuildThreadSourceSchema,
      ])
      .nullable(),
  })
  .strict();
export type DiscordMessageSubmission = z.infer<typeof discordMessageSubmissionSchema>;
export const discordMessageResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('admitted') }).strict(),
  z.object({ outcome: z.literal('duplicate') }).strict(),
  z
    .object({
      outcome: z.literal('ignored'),
      reason: z.enum(['link_required', 'unavailable', 'unsupported', 'expired']),
    })
    .strict(),
]);
export type DiscordMessageResult = z.infer<typeof discordMessageResultSchema>;
/** A reply's implicit mention is insufficient; require a literal token and verified mention entry. */
export function discordMentionPrompt(
  event: Pick<DiscordGatewayMessage, 'mentionsBot' | 'content'>,
  botUserId: string,
): string | null {
  channelSnowflakeSchema.parse(botUserId);
  const mention = new RegExp(`<@!?${botUserId}>`, 'g');
  if (!event.mentionsBot || !mention.test(event.content)) return null;
  return event.content.replace(mention, '').trim() || null;
}
export function discordGuildTextPermissions(value: string): boolean {
  const parsed = discordGuildTextSourceSchema.shape.permissions.safeParse(value);
  if (!parsed.success) return false;
  const bits = BigInt(parsed.data);
  const required = BigInt(1024 | 2048 | 65536);
  return (bits & BigInt(8)) !== BigInt(0) || (bits & required) === required;
}
export function discordGuildTextActorUsable(value: DiscordGuildTextActorSource): boolean {
  const parsed = discordGuildTextActorSourceSchema.safeParse(value);
  if (!parsed.success || !discordGuildTextPermissions(parsed.data.permissions)) return false;
  const bits = BigInt(parsed.data.authorPermissions);
  return (bits & BigInt(8)) !== BigInt(0) || (bits & BigInt(1024)) !== BigInt(0);
}
