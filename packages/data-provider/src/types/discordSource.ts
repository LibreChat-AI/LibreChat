import { z } from 'zod';
import { channelSnowflakeSchema } from '../channelProvider';

export const discordGuildTextSourceSchema = z
  .object({
    kind: z.literal('guild_text'),
    applicationId: channelSnowflakeSchema,
    botUserId: channelSnowflakeSchema,
    guildId: channelSnowflakeSchema,
    channelId: channelSnowflakeSchema,
    permissions: z
      .string()
      .regex(/^(0|[1-9]\d{0,19})$/)
      .refine((value) => value.length < 20 || value <= '18446744073709551615'),
  })
  .strict();
export type DiscordGuildTextSource = z.infer<typeof discordGuildTextSourceSchema>;
