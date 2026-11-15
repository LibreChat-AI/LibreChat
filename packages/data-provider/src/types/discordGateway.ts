import { z } from 'zod';
import { channelSnowflakeSchema } from '../channelProvider';
import { discordChannelConfigSchema } from '../config';

export const discordGatewayOwnerSchema = z
  .object({
    applicationId: channelSnowflakeSchema,
    applicationRevision: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\w-]+$/),
    ownerId: z.string().regex(/^[a-f0-9]{32}$/),
  })
  .strict();
export type DiscordGatewayOwner = z.infer<typeof discordGatewayOwnerSchema>;
/** Exact installation observed before a fresh bot membership inspection. */
export const discordGuildRemovalTargetSchema = z
  .object({
    guildId: channelSnowflakeSchema,
    installationId: z.string().min(1).max(128),
    installationRevision: discordGatewayOwnerSchema.shape.applicationRevision,
  })
  .strict();
export type DiscordGuildRemovalTarget = z.infer<typeof discordGuildRemovalTargetSchema>;
export const discordGuildRemovalPreparationSchema = z
  .object({ target: discordGuildRemovalTargetSchema.nullable() })
  .strict();
export type DiscordGuildRemovalPreparation = z.infer<typeof discordGuildRemovalPreparationSchema>;
/** Resume URLs carry bot credentials during authentication; reject arbitrary destinations. */
export const discordGatewaySessionSchema = z
  .object({
    sessionId: z.string().min(1).max(256),
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    shardId: z.number().int().min(0).max(127),
    shardCount: z.number().int().min(1).max(128),
    resumeURL: z
      .string()
      .max(2048)
      .refine((raw) => {
        try {
          const url = new URL(raw);
          return (
            url.protocol === 'wss:' &&
            /^gateway(?:-[a-z0-9-]+)?\.discord\.gg$/.test(url.hostname) &&
            !url.port &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            url.pathname === '/'
          );
        } catch {
          return false;
        }
      }),
  })
  .strict()
  .refine((value) => value.shardId < value.shardCount);
export const discordGatewayCheckpointSchema = z
  .object({
    shardId: z.number().int().min(0).max(127),
    session: discordGatewaySessionSchema.nullable(),
  })
  .strict()
  .refine((value) => !value.session || value.shardId === value.session.shardId);
export const discordGatewayBatchSchema = z
  .object({
    applicationId: channelSnowflakeSchema,
    applicationRevision: discordGatewayOwnerSchema.shape.applicationRevision,
    botUserId: channelSnowflakeSchema,
    checkpoints: z.array(discordGatewayCheckpointSchema).max(128),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.checkpoints.map((entry) => entry.shardId)).size === value.checkpoints.length,
  );
export type DiscordGatewayBatch = z.infer<typeof discordGatewayBatchSchema>;
export const discordGatewayBootstrapSchema = z
  .object({
    applicationId: channelSnowflakeSchema,
    applicationRevision: discordGatewayOwnerSchema.shape.applicationRevision,
    botUserId: channelSnowflakeSchema,
    botToken: z.string().min(1).max(512),
    policy: discordChannelConfigSchema.shape.gateway,
  })
  .strict();
export type DiscordGatewayBootstrap = z.infer<typeof discordGatewayBootstrapSchema>;
