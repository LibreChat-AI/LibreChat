import { agentsEndpointSchema, channelConfigSchema, discordChannelConfigSchema } from './config';

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

it('bounds Discord fatal and transient recovery independently without changing Slack defaults', () => {
  expect(discordChannelConfigSchema.parse({}).gateway.recovery).toEqual({
    retryMaxMs: 60000,
    resetAfterMs: 120000,
    fatalRetryMinMs: 30000,
    fatalRetryMaxMs: 900000,
    maxTrackedApplications: 4096,
  });
  for (const recovery of [
    { retryMaxMs: 999 },
    { resetAfterMs: 0 },
    { fatalRetryMinMs: 0 },
    { fatalRetryMinMs: 60000, fatalRetryMaxMs: 30000 },
    { fatalRetryMaxMs: 86400001 },
    { maxTrackedApplications: 0 },
    { maxTrackedApplications: 100001 },
  ])
    expect(discordChannelConfigSchema.safeParse({ gateway: { recovery } }).success).toBe(false);
  expect(channelConfigSchema.parse({ slackApp: {} }).slackApp?.gateway).not.toHaveProperty(
    'recovery',
  );
});

it('keeps Discord health windows bounded, optional and separate from retry policy', () => {
  expect(discordChannelConfigSchema.parse({}).health).toEqual({
    staleAfterMs: 120000,
    observationTtlMs: 3600000,
    observationRetryMs: 30000,
    permissionWindow: 3,
    taskWindow: 8,
  });
  expect(discordChannelConfigSchema.parse({ health: { taskWindow: 100 } }).health).toEqual({
    staleAfterMs: 120000,
    observationTtlMs: 3600000,
    observationRetryMs: 30000,
    permissionWindow: 3,
    taskWindow: 100,
  });
  for (const observationRetryMs of [1000, 45000, 600000])
    expect(discordChannelConfigSchema.parse({ health: { observationRetryMs } }).health).toEqual(
      expect.objectContaining({ observationRetryMs, observationTtlMs: 3600000 }),
    );
  // The app config reaches the gateway through this endpoint parse, so the key must survive it.
  expect(
    agentsEndpointSchema.parse({ channels: { discord: { health: { observationRetryMs: 45000 } } } })
      .channels?.discord?.health,
  ).toEqual(expect.objectContaining({ observationRetryMs: 45000 }));
  for (const health of [
    { staleAfterMs: 59999 },
    { staleAfterMs: 3600001 },
    { staleAfterMs: 120000.5 },
    { observationTtlMs: 59999 },
    { observationTtlMs: 86400001 },
    { observationRetryMs: 999 },
    { observationRetryMs: 0 },
    { observationRetryMs: 600001 },
    { observationRetryMs: 1000.5 },
    { observationRetryMs: '30000' },
    { permissionWindow: 0 },
    { permissionWindow: 21 },
    { taskWindow: 0 },
    { taskWindow: 101 },
    { retryMaxMs: 60000 },
  ])
    expect(discordChannelConfigSchema.safeParse({ health }).success).toBe(false);
});
