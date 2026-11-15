import {
  discordDmIssueSchema,
  discordDmConsumeSchema,
  discordDmCurrentSchema,
} from './types/discordDm';

const consume = {
  applicationId: '123',
  applicationRevision: 'app-rev',
  externalUserId: '456',
  codeHash: 'a'.repeat(64),
  dmChannelId: '789',
  confirmationEventId: '999',
};
it('keeps browser issuance limited to an existing link revision and signed consumption free of invented guild/user/tenant authority', () => {
  const issue = { linkId: 'link', expectedLinkRevision: 'link-rev' };
  expect(discordDmIssueSchema.safeParse(issue).success).toBe(true);
  expect(discordDmConsumeSchema.safeParse(consume).success).toBe(true);
  for (const extra of [
    { userId: 'user' },
    { tenantId: 'other' },
    { guildId: '123' },
    { agentId: 'agent' },
    { source: {} },
    { scope: 'guild' },
  ]) {
    expect(discordDmIssueSchema.safeParse({ ...issue, ...extra }).success).toBe(false);
    expect(discordDmConsumeSchema.safeParse({ ...consume, ...extra }).success).toBe(false);
  }
  for (const change of [
    { codeHash: 'raw-code' },
    { dmChannelId: 'invalid' },
    { confirmationEventId: '' },
    { applicationRevision: '' },
  ])
    expect(discordDmConsumeSchema.safeParse({ ...consume, ...change }).success).toBe(false);
  expect(discordDmCurrentSchema.safeParse(consume).success).toBe(false);
});
