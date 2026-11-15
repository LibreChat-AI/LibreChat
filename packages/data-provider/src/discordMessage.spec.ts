import { discordMentionPrompt, discordGuildTextPermissions } from './types/discordMessage';
import { discordChannelConfigSchema } from './config';

it('requires an explicit own mention in addition to the verified mention list', () => {
  expect(discordMentionPrompt({ mentionsBot: true, content: 'reply text' }, '123')).toBeNull();
  expect(
    discordMentionPrompt({ mentionsBot: false, content: '<@123> question' }, '123'),
  ).toBeNull();
  expect(
    discordMentionPrompt({ mentionsBot: true, content: '<@1234> question' }, '123'),
  ).toBeNull();
  expect(
    discordMentionPrompt({ mentionsBot: true, content: '<@123> <@!123> question <@456>' }, '123'),
  ).toBe('question <@456>');
  expect(discordMentionPrompt({ mentionsBot: true, content: '<@123>' }, '123')).toBeNull();
});
it('requires view, send and history permissions with administrator bypass', () => {
  expect(discordGuildTextPermissions(String(1024 | 2048 | 65536))).toBe(true);
  expect(discordGuildTextPermissions('8')).toBe(true);
  expect(discordGuildTextPermissions('2048')).toBe(false);
  expect(discordGuildTextPermissions('18446744073709551616')).toBe(false);
  expect(discordGuildTextPermissions('invalid')).toBe(false);
});
it('bounds message freshness below the minimum receipt retention across policy changes', () => {
  const defaults = discordChannelConfigSchema.parse({});
  expect(defaults.gateway.messageMaxAgeMs).toBeLessThanOrEqual(defaults.inbox.retentionMs);
  expect(
    discordChannelConfigSchema.safeParse({ gateway: { messageMaxAgeMs: 900001 } }).success,
  ).toBe(false);
});
