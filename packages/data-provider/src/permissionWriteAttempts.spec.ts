import { configSchema, permissionWriteAttemptsSchema } from './config';

describe('permission write retry budget', () => {
  test('defaults once and retains an operator-supplied budget in librechat.yaml', () => {
    expect(permissionWriteAttemptsSchema.parse(undefined)).toBe(3);
    expect(configSchema.parse({ version: '1.3.1', permissions: {} }).permissions).toEqual({
      maxWriteAttempts: 3,
    });
    expect(
      configSchema.parse({ version: '1.3.1', permissions: { maxWriteAttempts: 7 } }).permissions,
    ).toEqual({ maxWriteAttempts: 7 });
  });
  test.each([NaN, Infinity, -1, 0, 1.5, 101])('rejects %s', (value) => {
    expect(permissionWriteAttemptsSchema.safeParse(value).success).toBe(false);
  });
});
