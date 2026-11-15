import {
  discordMessageSubmissionSchema,
  discordMentionPrompt,
  discordGuildTextPermissions,
} from './types/discordMessage';
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

it('decodes native thread observations while retaining legacy bot-only text decoding', () => {
  const owner = { applicationId: '123', applicationRevision: 'revision', ownerId: 'a'.repeat(32) };
  const event = {
    ...owner,
    kind: 'message',
    shardId: 0,
    sequence: 1,
    messageId: '789',
    channelId: '567',
    guildId: '345',
    authorId: '678',
    content: '<@234> prompt',
    mentionsBot: true,
  };
  const source = {
    kind: 'guild_thread',
    applicationId: '123',
    botUserId: '234',
    guildId: '345',
    parentChannelId: '456',
    threadChannelId: '567',
    authorId: '678',
    threadType: 11,
    archived: false,
    locked: false,
    permissions: { bot: '274877973504', author: '1024' },
    membership: { bot: false, author: false },
  };
  expect(discordMessageSubmissionSchema.parse({ owner, event, source }).source).toEqual(source);
  expect(
    discordMessageSubmissionSchema.safeParse({
      owner,
      event,
      source: { ...source, channelId: '456' },
    }).success,
  ).toBe(false);
  const legacy = {
    kind: 'guild_text',
    applicationId: '123',
    botUserId: '234',
    guildId: '345',
    channelId: '567',
    permissions: '68608',
  };
  expect(discordMessageSubmissionSchema.parse({ owner, event, source: legacy }).source).toEqual(
    legacy,
  );
});
