import { z } from 'zod';
import { channelSnowflakeSchema } from '../channelProvider';
import { discordChannelConfigSchema } from '../config';

export const discordRuntimeCursorSchema = z.string().regex(/^[a-f0-9]{24}$/);
const reference = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w-]+$/);
export const discordRuntimeApplicationSchema = z
  .object({
    applicationId: channelSnowflakeSchema,
    applicationRevision: reference,
    tenantId: z.string().min(1).max(128),
  })
  .strict();
export type DiscordRuntimeApplication = z.infer<typeof discordRuntimeApplicationSchema>;
export const discordRuntimeChannelSchema = discordRuntimeApplicationSchema.extend({
  channelId: reference,
});
export type DiscordRuntimeChannel = z.infer<typeof discordRuntimeChannelSchema>;
export const discordRuntimeApplicationsSchema = z
  .object({
    applications: z.array(discordRuntimeApplicationSchema).max(100),
    next: discordRuntimeCursorSchema.optional(),
  })
  .strict();
export type DiscordRuntimeApplications = z.infer<typeof discordRuntimeApplicationsSchema>;
export const discordRuntimeChannelsSchema = z
  .object({
    channels: z.array(discordRuntimeChannelSchema).max(100),
    next: discordRuntimeCursorSchema.optional(),
  })
  .strict();
export type DiscordRuntimeChannels = z.infer<typeof discordRuntimeChannelsSchema>;
export const discordRuntimeBootstrapSchema = z
  .object({ discord: discordChannelConfigSchema })
  .strict();
export type DiscordRuntimeBootstrap = z.infer<typeof discordRuntimeBootstrapSchema>;
