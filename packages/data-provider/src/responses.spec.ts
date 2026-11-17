import { configSchema, responsesProtocolSchema } from './config';

it('keeps Responses compaction off unless explicitly enabled', () => {
  expect(responsesProtocolSchema.parse({}).compaction.enabled).toBe(false);
  expect(configSchema.parse({ version: '1.3.11' }).endpoints?.agents?.responses).toBeUndefined();
  const config = configSchema.parse({
    version: '1.3.11',
    endpoints: { agents: { responses: { compaction: { enabled: true } } } },
  });
  expect(config.endpoints?.agents?.responses?.compaction.enabled).toBe(true);
});
it.each([
  { maxItemBytes: 0 },
  { maxInputBytes: -1 },
  { maxAgeMs: 0 },
  { maxClockSkewMs: -1 },
  { maxClockSkewMs: 300001 },
  { maxAgeMs: 31 * 86400000 },
])('rejects unsafe compaction limits %p', (limits) => {
  expect(
    responsesProtocolSchema.safeParse({ compaction: { enabled: true, ...limits } }).success,
  ).toBe(false);
});
