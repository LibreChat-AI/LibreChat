import { z } from 'zod';
import { discordIngressActionSchema, discordInboxFenceSchema } from './discordIngress';
import { discordGuildTextActorSourceSchema } from './discordMessage';
import { discordGuildThreadSourceSchema } from './discordThread';
import { discordGatewayOwnerSchema } from './discordGateway';
import { channelSnowflakeSchema } from '../channelProvider';
import { discordDmSourceSchema } from './discordDm';

const reference = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w-]+$/);
const submission = z
  .object({
    applicationId: channelSnowflakeSchema,
    expectedApplicationRevision: reference,
    externalChannelId: channelSnowflakeSchema,
    externalUserId: channelSnowflakeSchema,
    eventId: channelSnowflakeSchema,
    token: z.string().min(1).max(4096),
    action: discordIngressActionSchema,
  })
  .strict();
export const discordInboxSubmissionSchema = submission.extend({ guildId: channelSnowflakeSchema });
/** Signed BOT_DM controls contain a physical DM destination, never a substituted guild. */
export const discordDmInboxSubmissionSchema = submission
  .extend({ scope: z.literal('dm') })
  .refine((value) =>
    ['ask', 'status', 'cancel', 'feedback', 'review', 'decide'].includes(value.action.kind),
  );
export type DiscordDmInboxSubmission = z.infer<typeof discordDmInboxSubmissionSchema>;
/** Server-derived source snapshot supports exact selection joins and independent privacy cleanup. */
export const discordDmInboxReferenceSchema = z
  .object({
    selectionId: reference,
    selectionRevision: reference,
    parentChannelId: channelSnowflakeSchema,
    confirmationEventId: channelSnowflakeSchema,
    source: discordDmSourceSchema,
  })
  .strict()
  .refine((value) => value.parentChannelId === value.source.externalChannelId);
export type DiscordDmInboxReference = z.infer<typeof discordDmInboxReferenceSchema>;
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

/** Inspection claims intentionally expose no interaction token, prompt, or internal route. */
export const discordInboxInspectionSchema = z
  .object({
    fence: discordInboxFenceSchema,
    applicationRevision: reference,
    expiresAt: z.number().int().positive(),
    inspection: z
      .object({
        guildId: channelSnowflakeSchema,
        externalChannelId: channelSnowflakeSchema,
        externalUserId: channelSnowflakeSchema,
        scope: z.literal('dm').optional(),
      })
      .strict(),
  })
  .strict();
export type DiscordInboxInspection = z.infer<typeof discordInboxInspectionSchema>;
export const discordInboxClaimSchema = z.union([
  discordInboxDeliverySchema,
  discordInboxInspectionSchema,
]);
export type DiscordInboxClaim = z.infer<typeof discordInboxClaimSchema>;

/** Trusted owner supplies fresh Discord source observations, never a caller-selected parent binding. */
export const discordInboxResolutionSchema = z
  .object({
    fence: discordInboxFenceSchema,
    owner: discordGatewayOwnerSchema,
    source: z.union([discordGuildThreadSourceSchema, discordGuildTextActorSourceSchema]).nullable(),
  })
  .strict()
  .refine((input) => input.fence.applicationId === input.owner.applicationId);
export type DiscordInboxResolution = z.infer<typeof discordInboxResolutionSchema>;
