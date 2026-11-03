import { configSchema } from './config';

describe('durable storage admission bounds', () => {
  it('preserves the omitted configuration and supplies a default when configured', () => {
    expect(configSchema.parse({ version: '1.0' }).durableStorage).toBeUndefined();
    expect(configSchema.parse({ version: '1.0', durableStorage: {} }).durableStorage).toEqual({
      maxPendingTargetsPerScope: 256,
    });
  });

  it.each([0, -1, 1.5, 4097, Infinity, '256'])('rejects invalid capacity %s', (capacity) => {
    expect(
      configSchema.safeParse({
        version: '1.0',
        durableStorage: { maxPendingTargetsPerScope: capacity },
      }).success,
    ).toBe(false);
  });

  it('accepts the documented ceiling', () => {
    expect(
      configSchema.parse({
        version: '1.0',
        durableStorage: { maxPendingTargetsPerScope: 4096 },
      }).durableStorage?.maxPendingTargetsPerScope,
    ).toBe(4096);
  });
});
