const crypto = require('node:crypto');

jest.mock('node:crypto', () => {
  const actual = jest.requireActual('node:crypto');
  return {
    ...actual,
    timingSafeEqual: jest.fn((a, b) => actual.timingSafeEqual(a, b)),
  };
});

jest.mock('@librechat/data-schemas', () => ({
  hashBackupCode: jest.fn(),
  decryptV3: jest.fn(),
  decryptV2: jest.fn(),
}));

jest.mock('~/models', () => ({ consumeBackupCode: jest.fn() }));

jest.mock('@librechat/api', () => ({
  generateTwoFactorLoginChallengeToken: jest.fn(),
  ...jest.requireActual('../../../packages/api/src/auth/recovery'),
}));

const { generateTOTP, verifyTOTP, generateTOTPSecret } = require('./twoFactorService');

describe('verifyTOTP', () => {
  it('keeps existing 80-bit TOTP enrollments valid', async () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    await expect(verifyTOTP(secret, await generateTOTP(secret))).resolves.toBe(true);
  });

  it('produces a 160-bit secret for new enrollments', () => {
    expect(generateTOTPSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });
  it('accepts a valid current TOTP code', async () => {
    const secret = generateTOTPSecret();
    const code = await generateTOTP(secret);
    await expect(verifyTOTP(secret, code)).resolves.toBe(true);
  });

  it('rejects an invalid code of the same length', async () => {
    const secret = generateTOTPSecret();
    const code = await generateTOTP(secret);
    const wrong = code === '000000' ? '111111' : '000000';
    await expect(verifyTOTP(secret, wrong)).resolves.toBe(false);
  });

  it('compares codes in constant time via crypto.timingSafeEqual', async () => {
    const secret = generateTOTPSecret();
    const code = await generateTOTP(secret);
    crypto.timingSafeEqual.mockClear();
    await verifyTOTP(secret, code);
    expect(crypto.timingSafeEqual).toHaveBeenCalled();
  });
});
