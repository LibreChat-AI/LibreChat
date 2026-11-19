import { z } from 'zod';
import { discordIngressActionSchema, discordInboxFenceSchema } from './discordIngress';
import { channelSnowflakeSchema } from '../channelProvider';

const reference = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w-]+$/);
export const discordInboxSubmissionSchema = z
  .object({
    applicationId: channelSnowflakeSchema,
    expectedApplicationRevision: reference,
    guildId: channelSnowflakeSchema,
    externalChannelId: channelSnowflakeSchema,
    externalUserId: channelSnowflakeSchema,
    eventId: channelSnowflakeSchema,
    token: z.string().min(1).max(4096),
    action: discordIngressActionSchema,
  })
  .strict();
export type DiscordInboxSubmission = z.infer<typeof discordInboxSubmissionSchema>;
const label = z.string().min(1).max(80);
const button = z.union([
  z
    .object({
      label,
      reference: z.string().min(1).max(100),
      style: z.enum(['primary', 'secondary', 'danger']).default('secondary'),
    })
    .strict(),
  z
    .object({
      label,
      url: z.url().refine((value) => {
        const url = new URL(value);
        return (
          !url.username &&
          !url.password &&
          (url.protocol === 'https:' ||
            (url.protocol === 'http:' &&
              ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
        );
      }),
    })
    .strict(),
]);
export const discordPrivateReplySchema = z
  .object({
    content: z.string().min(1).max(2000),
    actions: z.array(button).max(5).optional(),
  })
  .strict();
export type DiscordPrivateReply = z.infer<typeof discordPrivateReplySchema>;
export const discordInboxDeliverySchema = z
  .object({
    fence: discordInboxFenceSchema,
    applicationRevision: reference,
    token: z.string().min(1).max(4096),
    expiresAt: z.number().int().positive(),
    reply: discordPrivateReplySchema,
  })
  .strict();
export type DiscordInboxDelivery = z.infer<typeof discordInboxDeliverySchema>;
