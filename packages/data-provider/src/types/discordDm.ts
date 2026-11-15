import { z } from 'zod';
import { channelSnowflakeSchema } from '../channelProvider';

const reference = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w-]+$/);
export const discordDmCodeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const discordDmCodeHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
/** Authority remains the real, confirmed guild link. DM destination is separate. */
export const discordDmSourceSchema = z
  .object({
    applicationId: channelSnowflakeSchema,
    externalUserId: channelSnowflakeSchema,
    guildId: channelSnowflakeSchema,
    externalChannelId: channelSnowflakeSchema,
    installationId: reference,
    installationRevision: reference,
    channelId: reference,
    channelRevision: reference,
    agentId: reference,
    userId: reference,
    linkId: reference,
    linkRevision: reference,
  })
  .strict();
export type DiscordDmSource = z.infer<typeof discordDmSourceSchema>;
export const discordDmSelectionSchema = z
  .object({
    scope: z.literal('dm'),
    selectionId: reference,
    revision: reference,
    applicationId: channelSnowflakeSchema,
    externalUserId: channelSnowflakeSchema,
    dmChannelId: channelSnowflakeSchema,
    confirmationEventId: channelSnowflakeSchema,
    source: discordDmSourceSchema,
    createdAtMs: z.number().int().nonnegative(),
    expiresAtMs: z.number().int().positive(),
  })
  .strict()
  .refine(
    (value) =>
      value.applicationId === value.source.applicationId &&
      value.externalUserId === value.source.externalUserId,
  );
export type DiscordDmSelection = z.infer<typeof discordDmSelectionSchema>;
export const discordDmIssueSchema = z
  .object({ linkId: reference, expectedLinkRevision: reference })
  .strict();
export type DiscordDmIssue = z.infer<typeof discordDmIssueSchema>;
export const discordDmLookupSchema = z
  .object({
    applicationId: channelSnowflakeSchema,
    applicationRevision: reference,
    externalUserId: channelSnowflakeSchema,
    codeHash: discordDmCodeHashSchema,
  })
  .strict();
export type DiscordDmLookup = z.infer<typeof discordDmLookupSchema>;
export const discordDmConsumeSchema = discordDmLookupSchema.extend({
  dmChannelId: channelSnowflakeSchema,
  confirmationEventId: channelSnowflakeSchema,
});
export type DiscordDmConsume = z.infer<typeof discordDmConsumeSchema>;
export const discordDmCurrentSchema = discordDmLookupSchema
  .omit({ codeHash: true })
  .extend({ dmChannelId: channelSnowflakeSchema });
export type DiscordDmCurrent = z.infer<typeof discordDmCurrentSchema>;
export const discordDmFenceSchema = discordDmCurrentSchema.extend({
  selectionId: reference,
  revision: reference,
});
export type DiscordDmFence = z.infer<typeof discordDmFenceSchema>;
export type DiscordDmError =
  | 'disabled'
  | 'unavailable'
  | 'invalid_code'
  | 'changed'
  | 'capacity'
  | 'forbidden';
export type DiscordDmResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: DiscordDmError } };

/** Browser metadata contains neither selection codes nor their hashes. */
export interface DiscordDmSelectionView {
  selectionId: string;
  revision: string;
  linkId: string;
  agentId: string;
  applicationId: string;
  dmChannelId: string;
  expiresAtMs: number;
  state: 'active' | 'revoked' | 'expired' | 'unavailable';
}
export interface DiscordDmSelectionPage {
  enabled: boolean;
  selections: DiscordDmSelectionView[];
  next?: string;
}
export interface DiscordDmIssuedCode {
  code: string;
  expiresAtMs: number;
}
export const discordDmRevokeSchema = z
  .object({ selectionId: reference, revision: reference })
  .strict();
export type DiscordDmRevoke = z.infer<typeof discordDmRevokeSchema>;
/** Direct signed metadata acknowledgement, deliberately separate from run admission. */
export const discordDmAcknowledgementSchema = z
  .object({
    applicationId: channelSnowflakeSchema,
    externalUserId: channelSnowflakeSchema,
    dmChannelId: channelSnowflakeSchema,
    selectionId: reference,
    expiresAtMs: z.number().int().positive(),
  })
  .strict();
export type DiscordDmAcknowledgement = z.infer<typeof discordDmAcknowledgementSchema>;
