const { webcrypto, timingSafeEqual } = require('node:crypto');
const { decryptV3, decryptV2 } = require('@librechat/data-schemas');
const {
  generateTwoFactorLoginChallengeToken,
  generateTOTPSecret,
  createBackupCodeGenerator,
  createBackupCodeVerifier,
} = require('@librechat/api');
const { consumeBackupCode } = require('~/models');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const verifyBackupCode = createBackupCodeVerifier(consumeBackupCode);
const generateBackupCodes = createBackupCodeGenerator(process.env.TWO_FACTOR_BACKUP_CODE_FORMAT);

/**
 * Decodes a Base32 string into a Buffer.
 * @param {string} base32Str
 * @returns {Buffer}
 */
const decodeBase32 = (base32Str) => {
  const cleaned = base32Str.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const output = [];
  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) {
      continue;
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
};

/**
 * Generates a TOTP code based on the secret and time.
 * Uses a 30-second time step and produces a 6-digit code.
 * @param {string} secret
 * @param {number} [forTime=Date.now()]
 * @returns {Promise<string>}
 */
const generateTOTP = async (secret, forTime = Date.now()) => {
  const timeStep = 30; // seconds
  const counter = Math.floor(forTime / 1000 / timeStep);
  const counterBuffer = new ArrayBuffer(8);
  const counterView = new DataView(counterBuffer);
  counterView.setUint32(4, counter, false);

  const keyBuffer = decodeBase32(secret);
  const keyArrayBuffer = keyBuffer.buffer.slice(
    keyBuffer.byteOffset,
    keyBuffer.byteOffset + keyBuffer.byteLength,
  );

  const cryptoKey = await webcrypto.subtle.importKey(
    'raw',
    keyArrayBuffer,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const signatureBuffer = await webcrypto.subtle.sign('HMAC', cryptoKey, counterBuffer);
  const hmac = new Uint8Array(signatureBuffer);

  // Dynamic truncation per RFC 4226.
  const offset = hmac[hmac.length - 1] & 0xf;
  const slice = hmac.slice(offset, offset + 4);
  const view = new DataView(slice.buffer, slice.byteOffset, slice.byteLength);
  const binaryCode = view.getUint32(0, false) & 0x7fffffff;
  const code = (binaryCode % 1000000).toString().padStart(6, '0');
  return code;
};

/**
 * Constant-time comparison of a candidate 2FA code against the expected value.
 * A plain `===` comparison short-circuits at the first differing character, so
 * an attacker submitting codes to the 2FA verification endpoint could, in
 * principle, learn how many leading digits are correct from the response time.
 * Codes are of a fixed, public length, so returning early on a length mismatch
 * (or a non-string input) leaks nothing secret while keeping the match path
 * timing-independent. Mirrors the `crypto.timingSafeEqual(Buffer.from(...))`
 * pattern already used for CSRF token checks in `packages/api`.
 * @param {string} expected
 * @param {string} candidate
 * @returns {boolean}
 */
const constantTimeEqual = (expected, candidate) => {
  if (typeof expected !== 'string' || typeof candidate !== 'string') {
    return false;
  }
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const candidateBuffer = Buffer.from(candidate, 'utf8');
  if (expectedBuffer.length !== candidateBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, candidateBuffer);
};

/**
 * Verifies a TOTP token by checking a ±1 time step window.
 * @param {string} secret
 * @param {string} token
 * @returns {Promise<boolean>}
 */
const verifyTOTP = async (secret, token) => {
  const timeStepMS = 30 * 1000;
  const currentTime = Date.now();
  for (let offset = -1; offset <= 1; offset++) {
    const expected = await generateTOTP(secret, currentTime + offset * timeStepMS);
    if (constantTimeEqual(expected, token)) {
      return true;
    }
  }
  return false;
};

/**
 * Verifies a user's identity via TOTP token or backup code.
 * @param {Object} params
 * @param {Object} params.user - The user document (must include totpSecret and backupCodes).
 * @param {string} [params.token] - A 6-digit TOTP token.
 * @param {string} [params.backupCode] - A recovery code (legacy or current format).
 * @param {boolean} [params.persistBackupUse=true] - Whether to mark the backup code as used in the DB.
 * @returns {Promise<{ verified: boolean, status?: number, message?: string }>}
 */
const verifyOTPOrBackupCode = async ({ user, token, backupCode, persistBackupUse = true }) => {
  if (!token && !backupCode) {
    return { verified: false, status: 400 };
  }

  if (token) {
    const secret = await getTOTPSecret(user.totpSecret);
    if (!secret) {
      return { verified: false, status: 400, message: '2FA secret is missing or corrupted' };
    }
    const ok = await verifyTOTP(secret, token);
    return ok
      ? { verified: true }
      : { verified: false, status: 401, message: 'Invalid token or backup code' };
  }

  const ok = await verifyBackupCode({ user, backupCode, persist: persistBackupUse });
  return ok
    ? { verified: true }
    : { verified: false, status: 401, message: 'Invalid token or backup code' };
};

/**
 * Retrieves and decrypts a stored TOTP secret.
 * - Uses decryptV3 if the secret has a "v3:" prefix.
 * - Falls back to decryptV2 for colon-delimited values.
 * - Assumes a 16-character secret is already plain.
 * @param {string|null} storedSecret
 * @returns {Promise<string|null>}
 */
const getTOTPSecret = async (storedSecret) => {
  if (!storedSecret) {
    return null;
  }
  if (storedSecret.startsWith('v3:')) {
    return decryptV3(storedSecret);
  }
  if (storedSecret.includes(':')) {
    return await decryptV2(storedSecret);
  }
  if (storedSecret.length === 16) {
    return storedSecret;
  }
  return storedSecret;
};

/**
 * Generates a temporary JWT token for 2FA verification that expires in 5 minutes.
 * @param {string} userId
 * @returns {string}
 */
const generate2FATempToken = (userId) => {
  return generateTwoFactorLoginChallengeToken(userId, process.env.JWT_SECRET);
};

module.exports = {
  verifyOTPOrBackupCode,
  generate2FATempToken,
  generateBackupCodes,
  generateTOTPSecret,
  verifyBackupCode,
  getTOTPSecret,
  generateTOTP,
  verifyTOTP,
};
