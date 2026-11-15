import { channelConfigSchema, discordChannelConfigSchema } from './config';

it('keeps DM selection opt-in with bounded code/session lifetimes and application capacities', () => {
  expect(discordChannelConfigSchema.parse({}).dm).toEqual({
    enabled: false,
    codeTtlMs: 600000,
    selectionTtlMs: 86400000,
    maxPendingPerApplication: 1000,
    maxSelectionsPerApplication: 10000,
  });
  for (const dm of [
    { codeTtlMs: 900001 },
    { codeTtlMs: 0 },
    { selectionTtlMs: 604800001 },
    { maxPendingPerApplication: 0 },
    { maxSelectionsPerApplication: 0 },
    { unknown: true },
  ])
    expect(discordChannelConfigSchema.safeParse({ dm }).success).toBe(false);
});

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
    maxPendingPerChannel: 100,
    leaseMs: 30000,
    scanLimit: 20,
    retentionMs: 86400000,
    retryDelayMs: 1000,
  });
  for (const inbox of [
    { maxPendingPerApplication: 0 },
    { maxPendingPerActor: 1001 },
    { maxPendingPerChannel: 0 },
    { maxPendingPerChannel: 100001 },
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
    maxApplications: 32,
    shardCount: 1,
    messageContent: false,
    ownershipLeaseMs: 30000,
    checkpointIntervalMs: 1000,
    maxQueuedEvents: 100,
  });
});
it.each([
  { shardCount: 129 },
  { maxApplications: 0 },
  { maxApplications: 1001 },
  { ownershipLeaseMs: 0 },
  { checkpointIntervalMs: 0 },
  { maxQueuedEvents: 0 },
  { maxMessageCharacters: 6001 },
])('rejects invalid Gateway policy %j', (gateway) => {
  expect(discordChannelConfigSchema.safeParse({ gateway }).success).toBe(false);
});

it('accepts explicit HTTPS ingress and loopback fixtures without inheriting a Slack URL', () => {
  expect(discordChannelConfigSchema.parse({}).publicUrl).toBeUndefined();
  for (const publicUrl of [
    'https://discord.example/prefix/',
    'http://localhost:8080',
    'http://[::1]:8080',
  ])
    expect(discordChannelConfigSchema.safeParse({ publicUrl }).success).toBe(true);
  for (const publicUrl of [
    'invalid',
    'ftp://discord.example',
    'http://discord.example',
    'https://user:secret@discord.example',
    'https://discord.example?token=secret',
    'https://discord.example/#fragment',
  ])
    expect(discordChannelConfigSchema.safeParse({ publicUrl }).success).toBe(false);
});
