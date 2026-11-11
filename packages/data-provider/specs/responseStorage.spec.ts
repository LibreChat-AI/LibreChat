import { agentsEndpointSchema, channelStorageConfigSchema } from '../src/config';

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
