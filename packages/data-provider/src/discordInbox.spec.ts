import {
  discordInboxClaimSchema,
  discordInboxInspectionSchema,
  discordInboxResolutionSchema,
} from './types/discordInbox';

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

it('binds resolution to the same application and rejects caller-selected tenant or lease expiry', () => {
  const value = {
    fence: inspection.fence,
    owner: {
      applicationId: inspection.fence.applicationId,
      applicationRevision: 'revision',
      ownerId: 'a'.repeat(32),
    },
    source: null,
  };
  expect(discordInboxResolutionSchema.parse(value)).toEqual(value);
  expect(
    discordInboxResolutionSchema.safeParse({
      ...value,
      owner: { ...value.owner, applicationId: '999999999999999999' },
    }).success,
  ).toBe(false);
  expect(discordInboxResolutionSchema.safeParse({ ...value, tenantId: 'forged' }).success).toBe(
    false,
  );
  expect(
    discordInboxResolutionSchema.safeParse({
      ...value,
      owner: { ...value.owner, expiresAt: 2000000000000 },
    }).success,
  ).toBe(false);
});
