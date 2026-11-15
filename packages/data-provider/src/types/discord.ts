import { z } from 'zod';
import type { DiscordAgentChannel } from './channels';
import { channelSnowflakeSchema } from '../channelProvider';
export const discordPublicKeySchema = z.string().regex(/^[a-f\d]{64}$/i);

/** Verified organization application metadata. Credentials are write-only. */
export interface DiscordApplication {
  tenantId?: string;
  applicationId: string;
  botUserId: string;
  publicKey: string;
  name?: string;
  createdBy: string;
  revision: string;
  authorityWrites: number;
}

/** An organization installation; the installer is not an execution principal. */
export interface DiscordGuild {
  tenantId?: string;
  installationId: string;
  applicationId: string;
  guildId: string;
  guildName: string;
  createdBy: string;
  status: 'active' | 'disconnected';
  revision: string;
  authorityWrites: number;
}

export const configureDiscordApplicationSchema = z
  .object({
    applicationId: channelSnowflakeSchema,
    name: z.string().trim().max(100).optional(),
    botToken: z.string().trim().min(1).max(512).optional(),
    clientSecret: z.string().trim().min(1).max(512).optional(),
    expectedRevision: z.string().min(1).max(128).optional(),
  })
  .strict()
  .refine((input) => Boolean(input.expectedRevision || (input.botToken && input.clientSecret)));

export type ConfigureDiscordApplication = z.infer<typeof configureDiscordApplicationSchema>;

export interface DiscordApplicationPage {
  applications: DiscordApplication[];
  next?: string;
  setup?: { oauthCallbackUrl: string; interactionBaseUrl?: string };
}
export interface DiscordGuildPage {
  guilds: DiscordGuild[];
  next?: string;
}
export interface DiscordConnect {
  url: string;
  flowId: string;
  expiresInSeconds: number;
}

export interface DiscordBindingStatus {
  occupied: boolean;
  assignedToThisAgent: boolean;
  canReplace: boolean;
  revision?: string;
  assignedAgentName?: string;
}

export interface DiscordBindingTarget {
  agentId: string;
  installationId: string;
  externalChannelId: string;
}
export interface BindDiscordChannel extends DiscordBindingTarget {
  expectedRevision?: string;
}
export interface RemoveDiscordBinding extends DiscordBindingTarget {
  expectedRevision: string;
}

export interface DiscordBindingView {
  channel: DiscordAgentChannel;
  routeRevision: string;
}

/** Protected gateway projections; neither contains provider credentials. */
export interface DiscordApplicationSecurity {
  tenantId: string;
  applicationId: string;
  applicationRevision: string;
  publicKey: string;
  botUserId: string;
}

export interface DiscordResolvedRoute extends DiscordApplicationSecurity {
  routeRevision: string;
  installationId: string;
  installationRevision: string;
  guildId: string;
  externalChannelId: string;
  channelId: string;
  channelRevision: string;
  agentId: string;
}

export const DISCORD_COMMAND_MANIFEST_VERSION = '2' as const;
export const registerDiscordCommandsSchema = z
  .object({
    applicationId: channelSnowflakeSchema,
    expectedRevision: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\w-]+$/),
    manifestVersion: z.literal(DISCORD_COMMAND_MANIFEST_VERSION),
  })
  .strict();
export type RegisterDiscordCommands = z.infer<typeof registerDiscordCommandsSchema>;
export interface DiscordCommandRegistration {
  applicationId: string;
  commandId: string;
  providerVersion: string;
  manifestVersion: typeof DISCORD_COMMAND_MANIFEST_VERSION;
}
