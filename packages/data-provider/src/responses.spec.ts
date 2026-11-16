import { configSchema, responsesProtocolSchema } from './config';

it('does not enable WebSockets for existing configurations', () => {
  expect(configSchema.parse({ version: '1.3.11' }).endpoints?.agents?.responses).toBeUndefined();
  expect(responsesProtocolSchema.parse({}).websocket.enabled).toBe(false);
});
it('keeps WebSockets opt-in with finite queue, payload, cache and lifetime defaults', () => {
  const { websocket } = responsesProtocolSchema.parse({});
  expect(websocket).toMatchObject({
    enabled: false,
    maxConnections: 32,
    maxQueuedTurns: 4,
    maxMessageBytes: 1048576,
    maxCacheBytes: 4194304,
    maxConnectionMs: 3600000,
  });
  expect(responsesProtocolSchema.safeParse({ websocket: { maxQueuedTurns: 0 } }).success).toBe(
    false,
  );
});
