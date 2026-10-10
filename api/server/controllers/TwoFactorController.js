const { encryptV3, logger } = require('@librechat/data-schemas');
const { clearEnrollmentNonces } = require('@librechat/api');
const {
  verifyOTPOrBackupCode,
  generateBackupCodes,
  generateTOTPSecret,
  verifyBackupCode,
  getTOTPSecret,
  verifyTOTP,
} = require('~/server/services/twoFactorService');
const { getUserById, updateUser } = require('~/models');

const safeAppTitle = (process.env.APP_TITLE || 'LibreChat').replace(/\s+/g, '');

/**
 * Enable 2FA for the user by generating a new TOTP secret and backup codes.
 * The secret is encrypted and stored, and 2FA is marked as disabled until confirmed.
 * If 2FA is already enabled, requires OTP or backup code verification to re-enroll.
 */
const enable2FA = async (req, res) => {
  try {
    const userId = req.user.id;
    const existingUser = await getUserById(
      userId,
      '+totpSecret +backupCodes _id twoFactorEnabled email',
    );

    if (existingUser && existingUser.twoFactorEnabled) {
      const { token, backupCode } = req.body;
      const result = await verifyOTPOrBackupCode({
        user: existingUser,
        token,
        backupCode,
        persistBackupUse: false,
      });

      if (!result.verified) {
        const msg = result.message ?? 'TOTP token or backup code is required to re-enroll 2FA';
        return res.status(result.status ?? 400).json({ message: msg });
      }
    }

    const secret = generateTOTPSecret();
    const { plainCodes, codeObjects } = await generateBackupCodes();
    const encryptedSecret = encryptV3(secret);

    const user = await updateUser(
      userId,
      clearEnrollmentNonces({
        pendingTotpSecret: encryptedSecret,
        pendingBackupCodes: codeObjects,
      }),
    );

    const email = user.email || (existingUser && existingUser.email) || '';
    const otpauthUrl = `otpauth://totp/${safeAppTitle}:${email}?secret=${secret}&issuer=${safeAppTitle}`;

    return res.status(200).json({ otpauthUrl, backupCodes: plainCodes });
  } catch (err) {
    logger.error('[enable2FA]', err);
    return res.status(500).json({ message: err.message });
  }
};

/**
 * Verify a 2FA code (either TOTP or backup code) during setup.
 */
const verify2FA = async (req, res) => {
  try {
    const userId = req.user.id;
    const { token, backupCode } = req.body;
    const user = await getUserById(userId, '+totpSecret +pendingTotpSecret +backupCodes _id');
    const secretSource = user?.pendingTotpSecret ?? user?.totpSecret;

    if (!user || !secretSource) {
      return res.status(400).json({ message: '2FA not initiated' });
    }

    const secret = await getTOTPSecret(secretSource);
    let isVerified = false;

    if (token) {
      isVerified = await verifyTOTP(secret, token);
    } else if (backupCode) {
      isVerified = await verifyBackupCode({ user, backupCode });
    }

    if (isVerified) {
      return res.status(200).json();
    }
    return res.status(400).json({ message: 'Invalid token or backup code.' });
  } catch (err) {
    logger.error('[verify2FA]', err);
    return res.status(500).json({ message: err.message });
  }
};

/**
 * Confirm and enable 2FA after a successful verification.
 */
const confirm2FA = async (req, res) => {
  try {
    const userId = req.user.id;
    const { token } = req.body;
    const user = await getUserById(
      userId,
      '+totpSecret +pendingTotpSecret +pendingBackupCodes _id',
    );
    const secretSource = user?.pendingTotpSecret ?? user?.totpSecret;

    if (!user || !secretSource) {
      return res.status(400).json({ message: '2FA not initiated' });
    }

    const secret = await getTOTPSecret(secretSource);
    if (await verifyTOTP(secret, token)) {
      const update = {
        totpSecret: user.pendingTotpSecret ?? user.totpSecret,
        twoFactorEnabled: true,
        pendingTotpSecret: null,
        pendingBackupCodes: [],
      };
      if (user.pendingBackupCodes?.length) {
        update.backupCodes = user.pendingBackupCodes;
      }
      await updateUser(userId, clearEnrollmentNonces(update));
      return res.status(200).json();
    }
    return res.status(400).json({ message: 'Invalid token.' });
  } catch (err) {
    logger.error('[confirm2FA]', err);
    return res.status(500).json({ message: err.message });
  }
};

/**
 * Disable 2FA by clearing the stored secret and backup codes.
 * Requires verification with either TOTP token or backup code if 2FA is fully enabled.
 */
const disable2FA = async (req, res) => {
  try {
    const userId = req.user.id;
    const { token, backupCode } = req.body;
    const user = await getUserById(userId, '+totpSecret +backupCodes _id twoFactorEnabled');

    if (!user || !user.totpSecret) {
      return res.status(400).json({ message: '2FA is not setup for this user' });
    }

    if (user.twoFactorEnabled) {
      const result = await verifyOTPOrBackupCode({ user, token, backupCode });

      if (!result.verified) {
        const msg = result.message ?? 'Either token or backup code is required to disable 2FA';
        return res.status(result.status ?? 400).json({ message: msg });
      }
    }
    await updateUser(
      userId,
      clearEnrollmentNonces({
        totpSecret: null,
        backupCodes: [],
        twoFactorEnabled: false,
        pendingTotpSecret: null,
        pendingBackupCodes: [],
      }),
    );
    return res.status(200).json();
  } catch (err) {
    logger.error('[disable2FA]', err);
    return res.status(500).json({ message: err.message });
  }
};

/**
 * Regenerate backup codes for the user.
 * Requires OTP or backup code verification if 2FA is already enabled.
 */
const regenerateBackupCodes = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await getUserById(userId, '+totpSecret +backupCodes _id twoFactorEnabled');

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (user.twoFactorEnabled) {
      const { token, backupCode } = req.body;
      const result = await verifyOTPOrBackupCode({ user, token, backupCode });

      if (!result.verified) {
        const msg =
          result.message ?? 'TOTP token or backup code is required to regenerate backup codes';
        return res.status(result.status ?? 400).json({ message: msg });
      }
    }

    const { plainCodes, codeObjects } = await generateBackupCodes();
    await updateUser(userId, { backupCodes: codeObjects });
    return res.status(200).json({
      backupCodes: plainCodes,
      backupCodesHash: codeObjects,
    });
  } catch (err) {
    logger.error('[regenerateBackupCodes]', err);
    return res.status(500).json({ message: err.message });
  }
};

module.exports = {
  enable2FA,
  verify2FA,
  confirm2FA,
  disable2FA,
  regenerateBackupCodes,
};
