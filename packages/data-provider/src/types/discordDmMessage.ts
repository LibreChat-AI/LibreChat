import { z } from 'zod';
import { discordGatewayMessageSchema, discordGuildTextActorSourceSchema } from './discordMessage';
import { discordGatewayOwnerSchema } from './discordGateway';
import { channelSnowflakeSchema } from '../channelProvider';
import { discordDmFenceSchema } from './discordDm';

const envelope = z
  .object({ owner: discordGatewayOwnerSchema, event: discordGatewayMessageSchema })
  .strict();
const physicalDm = (value: z.infer<typeof envelope>): boolean =>
  value.event.guildId === undefined &&
  (value.event.channelType === undefined || value.event.channelType === 1) &&
  value.event.applicationId === value.owner.applicationId &&
  value.event.applicationRevision === value.owner.applicationRevision &&
  value.event.ownerId === value.owner.ownerId;
export const discordDmMessagePrepareSchema = envelope.refine(physicalDm);
export type DiscordDmMessagePrepare = z.infer<typeof discordDmMessagePrepareSchema>;
/** Routing hints only. No run, new consent, generation replacement or expiry extension occurs. */
export const discordDmMessagePreparedSchema = z
  .object({
    applicationId: channelSnowflakeSchema,
    externalUserId: channelSnowflakeSchema,
    dmChannelId: channelSnowflakeSchema,
    selectionId: discordDmFenceSchema.shape.selectionId,
    selectionRevision: discordDmFenceSchema.shape.revision,
    guildId: channelSnowflakeSchema,
    parentChannelId: channelSnowflakeSchema,
    botUserId: channelSnowflakeSchema,
  })
  .strict();
export type DiscordDmMessagePrepared = z.infer<typeof discordDmMessagePreparedSchema>;
export const discordDmMessageSubmissionSchema = envelope
  .extend({
    selectionId: discordDmFenceSchema.shape.selectionId,
    selectionRevision: discordDmFenceSchema.shape.revision,
    source: discordGuildTextActorSourceSchema.nullable(),
  })
  .refine(physicalDm);
export type DiscordDmMessageSubmission = z.infer<typeof discordDmMessageSubmissionSchema>;
