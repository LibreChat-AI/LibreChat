import { createHash } from 'node:crypto';
import {
  createBackupCodeVerifier,
  createBackupCodeGenerator,
  generateBackupCodes,
  generateTOTPSecret,
  matchesBackupCode,
} from './recovery';

describe('two-factor credential generation', () => {
  it.each([undefined, 'legacy', 'invalid'])(
    'keeps issuance compatible before activation: %s',
    async (format) => {
      const { plainCodes, codeObjects } = await createBackupCodeGenerator(format)(2);
      plainCodes.forEach((code, index) => {
        expect(code).toMatch(/^[a-f0-9]{8}$/);
        expect(codeObjects[index].codeHash).toBe(createHash('sha256').update(code).digest('hex'));
      });
    },
  );

  it('activates strong issuance only when explicitly configured', async () => {
    const { plainCodes, codeObjects } = await createBackupCodeGenerator('strong')(1);
    expect(plainCodes[0]).toHaveLength(32);
    expect(matchesBackupCode(plainCodes[0], codeObjects[0].codeHash)).toBe(true);
  });
  it('generates a 160-bit Base32 TOTP secret', () => {
    expect(generateTOTPSecret()).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateTOTPSecret()).not.toBe(generateTOTPSecret());
  });

  it('generates ten 128-bit backup codes with individual salts', async () => {
    const { plainCodes, codeObjects } = await generateBackupCodes();
    expect(plainCodes).toHaveLength(10);
    expect(new Set(plainCodes).size).toBe(10);
    expect(new Set(codeObjects.map((entry) => entry.codeHash.split(':')[1])).size).toBe(10);
    plainCodes.forEach((code, i) => {
      expect(code).toMatch(/^[a-f0-9]{32}$/);
      expect(codeObjects[i].codeHash).toMatch(/^sha256:[a-f0-9]{32}:[a-f0-9]{64}$/);
      expect(matchesBackupCode(code, codeObjects[i].codeHash)).toBe(true);
      expect(matchesBackupCode('not-the-code', codeObjects[i].codeHash)).toBe(false);
      expect(codeObjects[i]).toMatchObject({ used: false, usedAt: null });
    });
  });

  it('accepts legacy unsalted SHA-256 digests', () => {
    const hash = createHash('sha256').update('deadbeef').digest('hex');
    expect(matchesBackupCode('deadbeef', hash)).toBe(true);
    expect(matchesBackupCode('feedface', hash)).toBe(false);
  });

  it.each(['', 'sha256:x:y', 'sha256:' + 'a'.repeat(32) + ':bad', 'bcrypt:invalid'])(
    'rejects malformed stored hashes: %s',
    (hash) => {
      expect(matchesBackupCode('deadbeef', hash)).toBe(false);
    },
  );

  it('consumes the matched code without changing remaining codes', async () => {
    const { plainCodes, codeObjects } = await generateBackupCodes(2);
    const user = { _id: 'user', backupCodes: codeObjects };
    const consumeBackupCode = jest.fn(async (_id: string, hash: string) => {
      const entry = user.backupCodes.find((code) => code.codeHash === hash && !code.used);
      if (!entry) {
        return false;
      }
      entry.used = true;
      return true;
    });
    const verify = createBackupCodeVerifier(consumeBackupCode);
    expect(await verify({ user, backupCode: ` ${plainCodes[0]} ` })).toBe(true);
    expect(consumeBackupCode).toHaveBeenCalledWith('user', codeObjects[0].codeHash);
    expect(user.backupCodes[1].used).toBe(false);
    expect(await verify({ user, backupCode: plainCodes[0] })).toBe(false);
    expect(await verify({ user, backupCode: plainCodes[1], persist: false })).toBe(true);
    expect(consumeBackupCode).toHaveBeenCalledTimes(1);
  });

  it('rejects an otherwise matching code when atomic consumption loses', async () => {
    const { plainCodes, codeObjects } = await generateBackupCodes(1);
    const consumeBackupCode = jest.fn().mockResolvedValue(false);
    expect(
      await createBackupCodeVerifier(consumeBackupCode)({
        user: { _id: 'user', backupCodes: codeObjects },
        backupCode: plainCodes[0],
      }),
    ).toBe(false);
  });

  it('allows an existing legacy code without persistence during replacement', async () => {
    const updateUser = jest.fn();
    const user = {
      _id: 'user',
      backupCodes: [
        {
          codeHash: createHash('sha256').update('deadbeef').digest('hex'),
          used: false,
        },
      ],
    };
    expect(
      await createBackupCodeVerifier(updateUser)({ user, backupCode: 'deadbeef', persist: false }),
    ).toBe(true);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('does not persist an invalid code', async () => {
    const updateUser = jest.fn();
    const user = { _id: 'user', backupCodes: (await generateBackupCodes()).codeObjects };
    expect(await createBackupCodeVerifier(updateUser)({ user, backupCode: 'bad' })).toBe(false);
    expect(updateUser).not.toHaveBeenCalled();
  });
});
