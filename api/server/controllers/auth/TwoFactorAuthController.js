const jwt = require('jsonwebtoken');
const { logger } = require('@librechat/data-schemas');
const { isTokenIssuedBeforeCredentialChange } = require('@librechat/api');
const {
  verifyTOTP,
  getTOTPSecret,
  verifyBackupCode,
} = require('~/server/services/twoFactorService');
const { setAuthTokens } = require('~/server/services/AuthService');
const { getUserById } = require('~/models');

/**
 * Verifies the 2FA code during login using a temporary token.
 */
const verify2FAWithTempToken = async (req, res) => {
  try {
    const { tempToken, token, backupCode } = req.body;
    if (!tempToken) {
      return res.status(400).json({ message: 'Missing temporary token' });
    }

    let payload;
    try {
      payload = jwt.verify(tempToken, process.env.JWT_SECRET);
    } catch (err) {
      logger.error('Failed to verify temporary token:', err);
      return res.status(401).json({ message: 'Invalid or expired temporary token' });
    }

    const user = await getUserById(payload.userId, '+totpSecret +backupCodes');
    if (!user || !user.twoFactorEnabled) {
      return res.status(400).json({ message: '2FA is not enabled for this user' });
    }

    /**
     * The first factor was proven before the reset, so honouring this token would let a
     * password reset be survived by anyone who also holds the second factor.
     */
    if (isTokenIssuedBeforeCredentialChange(payload, user)) {
      logger.warn('[verify2FAWithTempToken] Rejected a token issued before a credential change');
      return res.status(401).json({ message: 'Invalid or expired temporary token' });
    }

    const secret = await getTOTPSecret(user.totpSecret);
    let isVerified = false;
    if (token) {
      isVerified = await verifyTOTP(secret, token);
    } else if (backupCode) {
      isVerified = await verifyBackupCode({ user, backupCode });
    }

    if (!isVerified) {
      return res.status(401).json({ message: 'Invalid 2FA code or backup code' });
    }

    const userData = user.toObject ? user.toObject() : { ...user };
    delete userData.__v;
    delete userData.password;
    delete userData.totpSecret;
    delete userData.backupCodes;
    userData.id = user._id.toString();

    const authToken = await setAuthTokens(user._id, res, null, req);
    return res.status(200).json({ token: authToken, user: userData });
  } catch (err) {
    logger.error('[verify2FAWithTempToken]', err);
    return res.status(500).json({ message: 'Something went wrong' });
  }
};

module.exports = { verify2FAWithTempToken };
