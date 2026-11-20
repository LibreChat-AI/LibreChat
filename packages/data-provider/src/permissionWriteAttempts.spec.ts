import { configSchema, permissionWriteAttemptsSchema } from './config';

describe('permission write retry budget', () => {
  test('defaults once and retains an operator-supplied budget in librechat.yaml', () => {
    expect(permissionWriteAttemptsSchema.parse(undefined)).toBe(3);
    expect(configSchema.parse({ version: '1.3.1', permissions: {} }).permissions).toEqual({
      maxWriteAttempts: 3,
      leaseTtlMs: 30000,
      leaseWaitMs: 3000,
    });
    expect(
      configSchema.parse({ version: '1.3.1', permissions: { maxWriteAttempts: 7 } }).permissions,
    ).toEqual({ maxWriteAttempts: 7, leaseTtlMs: 30000, leaseWaitMs: 3000 });
    expect(
      configSchema.parse({
        version: '1.3.1',
        permissions: { leaseTtlMs: 60000, leaseWaitMs: 5000 },
      }).permissions,
    ).toEqual({ maxWriteAttempts: 3, leaseTtlMs: 60000, leaseWaitMs: 5000 });
  });
  test.each([NaN, Infinity, -1, 0, 1.5, 101])('rejects %s', (value) => {
    expect(permissionWriteAttemptsSchema.safeParse(value).success).toBe(false);
  });
});

describe('permission lease limits', () => {
  test.each([
    [{ leaseTtlMs: 999 }],
    [{ leaseTtlMs: 600001 }],
    [{ leaseWaitMs: -1 }],
    [{ leaseWaitMs: 60001 }],
    [{ leaseTtlMs: 1.5 }],
  ])('rejects %j', (permissions) => {
    expect(configSchema.safeParse({ version: '1.3.1', permissions }).success).toBe(false);
  });
});
