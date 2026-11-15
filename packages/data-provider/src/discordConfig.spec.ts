import { channelConfigSchema, discordChannelConfigSchema } from './config';

it('keeps Discord disabled unless explicitly enabled and preserves Slack defaults', () => {
  expect(channelConfigSchema.parse({}).discord).toBeUndefined();
  expect(discordChannelConfigSchema.parse({}).enabled).toBe(false);
  expect(discordChannelConfigSchema.parse({ enabled: true })).toMatchObject({
    enabled: true,
    botPermissions: '274877975552',
    interactionTimeoutMs: 2000,
    rateLimits: { globalRequestsPerSecond: 50, maxQueued: 100 },
  });
});

it.each(['8', '274877975560', '18446744073709551616', 'abc', '-1', '1.5', ''])(
  'rejects unsafe permission set %s without throwing from its refinement',
  (botPermissions) => {
    expect(discordChannelConfigSchema.safeParse({ botPermissions }).success).toBe(false);
  },
);
it.each([
  { interactionTimeoutMs: 3000 },
  { rateLimits: { globalRequestsPerSecond: 51 } },
  { maxBodyBytes: 0 },
  { botToken: 'secret' },
])('rejects invalid policy %#', (input) => {
  expect(discordChannelConfigSchema.safeParse(input).success).toBe(false);
});

it('bounds durable interaction backlog, leases and deduplication retention', () => {
  expect(discordChannelConfigSchema.parse({}).inbox).toEqual({
    maxPendingPerApplication: 1000,
    maxPendingPerActor: 20,
    leaseMs: 30000,
    scanLimit: 20,
    retentionMs: 86400000,
    retryDelayMs: 1000,
  });
  for (const inbox of [
    { maxPendingPerApplication: 0 },
    { maxPendingPerActor: 1001 },
    { leaseMs: 4999 },
    { leaseMs: 120001 },
    { scanLimit: 101 },
    { retentionMs: 899999 },
    { retryDelayMs: 99 },
    { retentionMs: 604800001 },
    { unknown: true },
  ])
    expect(discordChannelConfigSchema.safeParse({ inbox }).success).toBe(false);
});

it('keeps Gateway sessions opt-in with bounded non-privileged defaults', () => {
  expect(discordChannelConfigSchema.parse({ enabled: true }).gateway).toMatchObject({
    enabled: false,
    shardCount: 1,
    messageContent: false,
    ownershipLeaseMs: 30000,
    checkpointIntervalMs: 1000,
    maxQueuedEvents: 100,
  });
});
it.each([
  { shardCount: 129 },
  { ownershipLeaseMs: 0 },
  { checkpointIntervalMs: 0 },
  { maxQueuedEvents: 0 },
  { maxMessageCharacters: 6001 },
])('rejects invalid Gateway policy %j', (gateway) => {
  expect(discordChannelConfigSchema.safeParse({ gateway }).success).toBe(false);
});
