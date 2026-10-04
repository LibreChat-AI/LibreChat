import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { StoredTwoFactorAccount, TwoFactorBackupCode } from './twoFactor';

interface BackupCodeVerificationParams {
  user: StoredTwoFactorAccount;
  backupCode: string;
  persist?: boolean;
}

/** 160-bit secrets match the recommended HMAC-SHA1 key size. */
export function generateTOTPSecret(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of randomBytes(20)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return output;
}

function digest(code: string, salt = ''): string {
  return createHash('sha256').update(salt).update(code).digest('hex');
}

/** High-entropy recovery credentials do not require password-style key stretching. */
export async function generateBackupCodes(
  count = 10,
  legacy = false,
): Promise<{
  plainCodes: string[];
  codeObjects: TwoFactorBackupCode[];
}> {
  const plainCodes: string[] = [];
  const codeObjects: TwoFactorBackupCode[] = [];
  for (let i = 0; i < count; i++) {
    const code = randomBytes(legacy ? 4 : 16).toString('hex');
    if (legacy) {
      plainCodes.push(code);
      codeObjects.push({ codeHash: digest(code), used: false, usedAt: null });
      continue;
    }
    const salt = randomBytes(16).toString('hex');
    plainCodes.push(code);
    codeObjects.push({
      codeHash: `sha256:${salt}:${digest(code, salt)}`,
      used: false,
      usedAt: null,
    });
  }
  return { plainCodes, codeObjects };
}

/** Keep issuance compatible until the operator completes the backend/client rollout. */
export function createBackupCodeGenerator(format?: string): typeof generateBackupCodes {
  return (count = 10) => generateBackupCodes(count, format !== 'strong');
}

/** Accept legacy digests until the user regenerates their recovery codes. */
export function matchesBackupCode(code: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  const legacy = /^[a-f0-9]{64}$/.test(storedHash);
  if (
    !legacy &&
    (parts.length !== 3 ||
      parts[0] !== 'sha256' ||
      !/^[a-f0-9]{32}$/.test(parts[1]) ||
      !/^[a-f0-9]{64}$/.test(parts[2]))
  ) {
    return false;
  }
  const expected = Buffer.from(legacy ? storedHash : parts[2], 'hex');
  const actual = Buffer.from(digest(code, legacy ? '' : parts[1]), 'hex');
  return timingSafeEqual(expected, actual);
}

export function createBackupCodeVerifier(
  consumeBackupCode: (id: string, codeHash: string) => Promise<boolean>,
): (params: BackupCodeVerificationParams) => Promise<boolean> {
  return async ({
    user,
    backupCode,
    persist = true,
  }: BackupCodeVerificationParams): Promise<boolean> => {
    if (typeof backupCode !== 'string' || !user || !Array.isArray(user.backupCodes)) {
      return false;
    }
    const code = backupCode.trim();
    if (!/^(?:[a-f0-9]{8}|[a-f0-9]{32})$/.test(code)) {
      return false;
    }
    const matching = user.backupCodes.find(
      (entry) => !entry.used && matchesBackupCode(code, entry.codeHash),
    );
    if (!matching) {
      return false;
    }
    if (persist) {
      return consumeBackupCode(String(user._id), matching.codeHash);
    }
    return true;
  };
}
