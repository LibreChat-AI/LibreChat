import {
  agentsEndpointSchema,
  channelStorageConfigSchema,
  channelConfigSchema,
} from '../src/config';

it('preserves existing endpoint defaults and accepts configured storage bounds', () => {
  expect(agentsEndpointSchema.parse({}).channels).toBeUndefined();
  expect(agentsEndpointSchema.parse({ channels: {} }).channels).toEqual(
    channelStorageConfigSchema.parse({}),
  );
  expect(
    agentsEndpointSchema.parse({ channels: { erasureBatchSize: 12 } }).channels?.erasureBatchSize,
  ).toBe(12);
});

it.each([
  { enabled: true },
  { enabled: false },
  { gatewayUrl: 'https://gateway.example.com' },
  { transport: 'socket_mode' },
])('rejects runtime configuration before its consuming surface is available: %j', (channels) => {
  expect(agentsEndpointSchema.safeParse({ channels }).success).toBe(false);
});

it('validates the persistence limits currently consumed by storage', () => {
  expect(agentsEndpointSchema.safeParse({ channels: { erasureBatchSize: 0 } }).success).toBe(false);
  expect(agentsEndpointSchema.safeParse({ channels: { claimBatchSize: 0 } }).success).toBe(false);
});

it('validates injected runtime host policy without exposing an operator enable switch', () => {
  const policy = channelConfigSchema.parse({});
  expect(policy.enabled).toBe(false);
  expect(policy.transport).toBe('socket_mode');
  expect(policy.ticketLifetimeMs).toBe(600000);
  expect(policy.cleanup.batchSize).toBe(25);
  expect(channelConfigSchema.safeParse({ leaseMs: 0 }).success).toBe(false);
  expect(channelConfigSchema.safeParse({ artifactMaxFiles: 21 }).success).toBe(false);
  expect(agentsEndpointSchema.safeParse({ channels: { enabled: true } }).success).toBe(false);
});

it('configures the answer-file byte threshold with the existing default and bounded integer values', () => {
  expect(channelConfigSchema.parse({}).artifactAnswerFileThresholdBytes).toBe(6000);
  expect(
    channelConfigSchema.parse({ artifactAnswerFileThresholdBytes: 0 })
      .artifactAnswerFileThresholdBytes,
  ).toBe(0);
  expect(
    channelConfigSchema.parse({ artifactAnswerFileThresholdBytes: 8192 })
      .artifactAnswerFileThresholdBytes,
  ).toBe(8192);
  for (const value of [-1, 1.5, 50 * 1024 * 1024 + 1])
    expect(channelConfigSchema.safeParse({ artifactAnswerFileThresholdBytes: value }).success).toBe(
      false,
    );
});
