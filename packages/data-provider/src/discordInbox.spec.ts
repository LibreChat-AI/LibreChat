import { discordInboxClaimSchema, discordInboxInspectionSchema } from './types/discordInbox';

const inspection = {
  fence: {
    applicationId: '123456789012345678',
    eventId: '234567890123456789',
    owner: 'worker',
    epoch: 1,
  },
  applicationRevision: 'revision',
  expiresAt: 2000000000000,
  inspection: {
    guildId: '345678901234567890',
    externalChannelId: '456789012345678901',
    externalUserId: '567890123456789012',
  },
};

it('retains physical source identity and lease without secret or routing data', () => {
  expect(discordInboxClaimSchema.parse(inspection)).toEqual(inspection);
});
it.each(['token', 'prompt', 'agentId', 'channelId', 'channelRevision'])(
  'rejects unexpected %s on an inspection claim',
  (field) => {
    expect(
      discordInboxInspectionSchema.safeParse({ ...inspection, [field]: 'private' }).success,
    ).toBe(false);
  },
);
it('rejects a mixed inspection and delivery envelope', () => {
  expect(
    discordInboxClaimSchema.safeParse({
      ...inspection,
      token: 'private-token',
      reply: { content: 'Private reply' },
    }).success,
  ).toBe(false);
});
it('preserves the existing prepared reply wire format', () => {
  const delivery = {
    fence: inspection.fence,
    applicationRevision: inspection.applicationRevision,
    expiresAt: inspection.expiresAt,
    token: 'private-token',
    reply: { content: 'Prepared' },
  };
  expect(discordInboxClaimSchema.parse(delivery)).toEqual(delivery);
});
