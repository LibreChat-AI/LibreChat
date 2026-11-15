import { z } from 'zod';
import { channelSnowflakeSchema } from '../channelProvider';

const reference = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w-]+$/);
export const discordIngressActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ask'), prompt: z.string().min(1).max(6000) }).strict(),
  z.object({ kind: z.literal('link') }).strict(),
  z.object({ kind: z.literal('status') }).strict(),
  z.object({ kind: z.literal('cancel'), reference: reference.optional() }).strict(),
  z.object({ kind: z.literal('confirm'), reference }).strict(),
  z
    .object({ kind: z.literal('feedback'), reference, rating: z.enum(['thumbsUp', 'thumbsDown']) })
    .strict(),
]);
export type DiscordIngressAction = z.infer<typeof discordIngressActionSchema>;
export const discordInboxFenceSchema = z
  .object({
    applicationId: channelSnowflakeSchema,
    eventId: channelSnowflakeSchema,
    owner: reference,
    epoch: z.number().int().positive(),
  })
  .strict();
export type DiscordInboxFence = z.infer<typeof discordInboxFenceSchema>;
