import {
  discordThreadAddress,
  discordThreadUsable,
  discordGuildThreadSourceSchema,
} from './types/discordThread';
import { discordChannelConfigSchema } from './config';

const required = BigInt(1024 | 65536) | (BigInt(1) << BigInt(38));
const manage = BigInt(1) << BigInt(34);
const source = {
  kind: 'guild_thread' as const,
  applicationId: '123',
  botUserId: '234',
  guildId: '345',
  parentChannelId: '456',
  threadChannelId: '567',
  authorId: '678',
  threadType: 11 as const,
  archived: false,
  locked: false,
  permissions: { bot: String(required), author: String(required) },
  membership: { bot: false, author: false },
};
it('allows public thread access without explicit membership when thread-specific permissions are current', () => {
  expect(discordThreadUsable(source)).toBe(true);
  expect(
    discordThreadUsable({
      ...source,
      permissions: { ...source.permissions, bot: String(1024 | 2048 | 65536) },
    }),
  ).toBe(false);
});
it('requires private membership or moderator access for both the bot and the acting author', () => {
  const privateSource = { ...source, threadType: 12 as const };
  expect(discordThreadUsable(privateSource)).toBe(false);
  expect(discordThreadUsable({ ...privateSource, membership: { bot: true, author: true } })).toBe(
    true,
  );
  expect(discordThreadUsable({ ...privateSource, membership: { bot: true, author: false } })).toBe(
    false,
  );
  expect(
    discordThreadUsable({
      ...privateSource,
      permissions: { bot: String(required | manage), author: String(required | manage) },
    }),
  ).toBe(true);
  expect(discordThreadUsable({ ...privateSource, permissions: { bot: '8', author: '8' } })).toBe(
    true,
  );
});
it('refuses archive and lock states even when the bot could reopen or moderate the thread', () => {
  expect(discordThreadUsable({ ...source, archived: true })).toBe(false);
  expect(
    discordThreadUsable({ ...source, locked: true, permissions: { bot: '8', author: '8' } }),
  ).toBe(false);
  expect(
    discordGuildThreadSourceSchema.safeParse({ ...source, threadChannelId: source.parentChannelId })
      .success,
  ).toBe(false);
});
it('uses the actual thread for delivery and a stable thread lane across different message IDs', () => {
  expect(discordThreadAddress('567', '789')).toEqual({
    externalChannelId: '567',
    externalThreadKey: '567:567',
    externalMessageKey: '567:789',
  });
  expect(discordThreadAddress('567', '890').externalThreadKey).toBe('567:567');
});
it('ships a bounded configurable mapping cap', () => {
  expect(discordChannelConfigSchema.parse({}).gateway.maxThreadRoutes).toBe(10000);
  expect(discordChannelConfigSchema.safeParse({ gateway: { maxThreadRoutes: 0 } }).success).toBe(
    false,
  );
  expect(
    discordChannelConfigSchema.safeParse({ gateway: { maxThreadRoutes: 100001 } }).success,
  ).toBe(false);
});
