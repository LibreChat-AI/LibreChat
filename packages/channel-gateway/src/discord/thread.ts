import { z } from 'zod';
import {
  channelSnowflakeSchema,
  discordGuildThreadSourceSchema,
  discordThreadUsable,
} from 'librechat-data-provider';
import type { DiscordGuildThreadSource } from 'librechat-data-provider';
import { DiscordWriteError } from './errors';

export interface DiscordThreadInspection {
  applicationId: string;
  botUserId: string;
  guildId: string;
  threadChannelId: string;
  authorId: string;
}
const permissions = z.object({
  permissions: discordGuildThreadSourceSchema.shape.permissions.shape.bot,
});
const identity = z.object({
  id: channelSnowflakeSchema,
  type: z.number().int(),
  guild_id: channelSnowflakeSchema.optional(),
});
const metadata = z.object({
  id: channelSnowflakeSchema,
  guild_id: channelSnowflakeSchema,
  parent_id: channelSnowflakeSchema,
  type: z.number().int(),
  flags: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  thread_metadata: z.object({ archived: z.boolean(), locked: z.boolean() }),
});
const member = z.object({ id: channelSnowflakeSchema, user_id: channelSnowflakeSchema });

/** Uses the per-bot bounded REST client and its shared rate coordinator, without member-list intent. */
export async function inspectDiscordThread(
  input: DiscordThreadInspection,
  read: (path: string) => Promise<unknown>,
): Promise<DiscordGuildThreadSource | null> {
  for (const value of Object.values(input)) channelSnowflakeSchema.parse(value);
  try {
    const [rawChannel, bot, author] = await Promise.all([
      read(`/channels/${input.threadChannelId}`),
      read(`/channels/${input.threadChannelId}/permissions/member/${input.botUserId}`).then(
        (value) => permissions.parse(value).permissions,
      ),
      read(`/channels/${input.threadChannelId}/permissions/member/${input.authorId}`).then(
        (value) => permissions.parse(value).permissions,
      ),
    ]);
    const address = identity.safeParse(rawChannel);
    if (!address.success) throw new DiscordWriteError('unknown');
    if (
      address.data.id !== input.threadChannelId ||
      address.data.guild_id !== input.guildId ||
      ![11, 12].includes(address.data.type)
    )
      return null;
    const parsed = metadata.safeParse(rawChannel);
    if (!parsed.success) throw new DiscordWriteError('unknown');
    const channel = parsed.data;
    if (
      channel.parent_id === input.threadChannelId ||
      (BigInt(channel.flags ?? 0) & BigInt(1 << 17)) !== BigInt(0) ||
      channel.thread_metadata.archived ||
      channel.thread_metadata.locked
    )
      return null;
    async function membership(userId: string, bits: string): Promise<boolean> {
      // Administrators/moderators may access private threads without joining them.
      const bypass = BigInt(8) | (BigInt(1) << BigInt(34));
      if (channel.type !== 12 || (BigInt(bits) & bypass) !== BigInt(0)) return false;
      try {
        const found = member.safeParse(
          await read(`/channels/${input.threadChannelId}/thread-members/${userId}`),
        );
        if (
          !found.success ||
          found.data.id !== input.threadChannelId ||
          found.data.user_id !== userId
        )
          throw new DiscordWriteError('unknown');
        return true;
      } catch (error) {
        if (error instanceof DiscordWriteError && error.status === 404) return false;
        throw error;
      }
    }
    const [botMember, authorMember] = await Promise.all([
      membership(input.botUserId, bot),
      membership(input.authorId, author),
    ]);
    const source = discordGuildThreadSourceSchema.parse({
      kind: 'guild_thread',
      ...input,
      parentChannelId: channel.parent_id,
      threadType: channel.type,
      archived: channel.thread_metadata.archived,
      locked: channel.thread_metadata.locked,
      permissions: { bot, author },
      membership: { bot: botMember, author: authorMember },
    });
    return discordThreadUsable(source) ? source : null;
  } catch (error) {
    if (error instanceof DiscordWriteError && [403, 404].includes(error.status ?? 0)) return null;
    if (error instanceof z.ZodError) throw new DiscordWriteError('unknown');
    throw error;
  }
}
