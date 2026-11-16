import { z } from 'zod';

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
