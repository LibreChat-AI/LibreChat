import {
  discordDmMessagePrepareSchema,
  discordDmMessageSubmissionSchema,
} from './types/discordDmMessage';

const owner = { applicationId: '123', applicationRevision: 'revision', ownerId: 'a'.repeat(32) };
const event = {
  ...owner,
  kind: 'message',
  shardId: 0,
  sequence: 1,
  messageId: '234',
  channelId: '345',
  authorId: '456',
  content: 'private message',
  mentionsBot: false,
};
it('accepts a physical private message without requiring a mention or optional channel expansion', () => {
  expect(discordDmMessagePrepareSchema.parse({ owner, event })).toEqual({ owner, event });
  expect(
    discordDmMessageSubmissionSchema.parse({
      owner,
      event,
      source: null,
      selectionId: 'selection',
      selectionRevision: 'revision',
    }),
  ).toMatchObject({ event, selectionId: 'selection' });
});
it('refuses guild/group identities, mixed owners, route overrides and missing generations', () => {
  for (const value of [
    { event: { ...event, guildId: '999' } },
    { event: { ...event, channelType: 3 } },
    { event: { ...event, applicationRevision: 'other' } },
    { event: { ...event, ownerId: 'b'.repeat(32) } },
    { tenantId: 'other' },
  ])
    expect(discordDmMessagePrepareSchema.safeParse({ owner, event, ...value }).success).toBe(false);
  expect(discordDmMessageSubmissionSchema.safeParse({ owner, event, source: null }).success).toBe(
    false,
  );
  expect(
    discordDmMessageSubmissionSchema.safeParse({
      owner,
      event,
      selectionId: 'selection',
      selectionRevision: 'revision',
      source: {
        kind: 'guild_text',
        applicationId: '123',
        botUserId: '567',
        guildId: '678',
        channelId: '789',
        permissions: '68608',
      },
    }).success,
  ).toBe(false);
});
