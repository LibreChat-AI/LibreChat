const { logger } = require('@librechat/data-schemas');
const { ErrorTypes } = require('librechat-data-provider');
const {
  isEnabled,
  findSocialUser,
  isEmailDomainAllowed,
  resolveAppConfigForUser,
} = require('@librechat/api');
const { createSocialUser, handleExistingUser } = require('./process');
const { getAppConfig } = require('~/server/services/Config');
const { findUser, updateUser } = require('~/models');

const socialLogin =
  (provider, getProfileDetails, options = {}) =>
  async (accessToken, refreshToken, idToken, profile, cb) => {
    try {
      const { email, id, avatarUrl, username, name, emailVerified } = getProfileDetails({
        idToken,
        profile,
      });

      const baseConfig = await getAppConfig({ baseOnly: true });
      if (!isEmailDomainAllowed(email, baseConfig?.registration?.allowedDomains)) {
        logger.error(
          `[${provider}Login] Authentication blocked - email domain not allowed [Email: ${email}]`,
        );
        const error = new Error(ErrorTypes.AUTH_FAILED);
        error.code = ErrorTypes.AUTH_FAILED;
        error.message = 'Email domain not allowed';
        return cb(error);
      }

      const providerKey = `${provider}Id`;
      const lookup = { findUser, provider, providerId: id, email };
      const existingUser = await findSocialUser(lookup);

      const appConfig = existingUser?.tenantId
        ? await resolveAppConfigForUser(getAppConfig, existingUser)
        : baseConfig;

      if (!isEmailDomainAllowed(email, appConfig?.registration?.allowedDomains)) {
        logger.error(
          `[${provider}Login] Authentication blocked - email domain not allowed [Email: ${email}]`,
        );
        const error = new Error(ErrorTypes.AUTH_FAILED);
        error.code = ErrorTypes.AUTH_FAILED;
        error.message = 'Email domain not allowed';
        return cb(error);
      }

      const passResult = (user) =>
        refreshToken && provider === 'google' ? cb(null, user, { refreshToken }) : cb(null, user);

      if (existingUser?.provider === provider) {
        if (
          options.existingUsersOnly &&
          id &&
          existingUser[providerKey] &&
          existingUser[providerKey] !== id
        ) {
          logger.warn(
            `[${provider}Login] Rejected admin email fallback for ${email}: stored ${providerKey} does not match`,
          );
          const error = new Error(ErrorTypes.AUTH_FAILED);
          error.code = ErrorTypes.AUTH_FAILED;
          return cb(error);
        }
        if (options.existingUsersOnly && id && !existingUser[providerKey]) {
          if (existingUser.tenantId) {
            logger.warn(
              `[${provider}Login] Admin migrate blocked for tenanted user ${email}: no tenant scope in OAuth callback`,
            );
            const tenantError = new Error(ErrorTypes.AUTH_FAILED);
            tenantError.code = ErrorTypes.AUTH_FAILED;
            return cb(tenantError);
          }
          await updateUser(existingUser._id, { [providerKey]: id });
          const verified = await findUser({ _id: existingUser._id, [providerKey]: id });
          if (!verified) {
            logger.warn(
              `[${provider}Login] Admin migrate superseded by concurrent write, denying: ${email}`,
            );
            const concurrentError = new Error(ErrorTypes.AUTH_FAILED);
            concurrentError.code = ErrorTypes.AUTH_FAILED;
            return cb(concurrentError);
          }
          existingUser[providerKey] = id;
        }
        await handleExistingUser(existingUser, avatarUrl, appConfig, email);
        return passResult(existingUser);
      } else if (existingUser) {
        logger.info(
          `[${provider}Login] User ${email} already exists with provider ${existingUser.provider}`,
        );
        const error = new Error(ErrorTypes.AUTH_FAILED);
        error.code = ErrorTypes.AUTH_FAILED;
        error.provider = existingUser.provider;
        return cb(error);
      }

      if (options.existingUsersOnly) {
        logger.error(
          `[${provider}Login] Admin auth blocked - user does not exist [Email: ${email}]`,
        );
        return cb(null, false, { message: 'User does not exist' });
      }

      const ALLOW_SOCIAL_REGISTRATION = isEnabled(process.env.ALLOW_SOCIAL_REGISTRATION);
      if (!ALLOW_SOCIAL_REGISTRATION) {
        logger.error(
          `[${provider}Login] Registration blocked - social registration is disabled [Email: ${email}]`,
        );
        const error = new Error(ErrorTypes.AUTH_FAILED);
        error.code = ErrorTypes.AUTH_FAILED;
        error.message = 'Social registration is disabled';
        return cb(error);
      }

      const newUser = await createSocialUser({
        email,
        avatarUrl,
        provider,
        providerKey: `${provider}Id`,
        providerId: id,
        username,
        name,
        emailVerified,
        appConfig,
        lookup,
      });
      return passResult(newUser);
    } catch (err) {
      logger.error(`[${provider}Login]`, err);
      return cb(err);
    }
  };

module.exports = socialLogin;
