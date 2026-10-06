const fs = require('fs');
const path = require('path');
const passport = require('passport');
const { ErrorTypes } = require('librechat-data-provider');
const { hashToken, logger } = require('@librechat/data-schemas');
const { Strategy: SamlStrategy } = require('@node-saml/passport-saml');
const {
  findSamlUser,
  getBalanceConfig,
  provisionSamlUser,
  isEmailDomainAllowed,
  getAvatarFileStrategy,
  getAvatarSaveParams,
  resolveAppConfigForUser,
  resolveSamlSubject,
  TRANSIENT_SAML_NAME_ID_FORMAT,
} = require('@librechat/api');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { resizeAvatar } = require('~/server/services/Files/images/avatar');
const {
  findUser,
  updateUser,
  findBalanceByUser,
  claimSamlIdentity,
  createUserIfAbsent,
} = require('~/models');
const { getAppConfig } = require('~/server/services/Config');
const paths = require('~/config/paths');

let crypto;
try {
  crypto = require('node:crypto');
} catch (err) {
  logger.error('[samlStrategy] crypto support is disabled!', err);
}

/**
 * Retrieves the certificate content from the given value.
 *
 * This function determines whether the provided value is a certificate string (RFC7468 format or
 * base64-encoded without a header) or a valid file path. If the value matches one of these formats,
 * the certificate content is returned. Otherwise, an error is thrown.
 *
 * @see https://github.com/node-saml/node-saml/tree/master?tab=readme-ov-file#configuration-option-idpcert
 * @param {string} value - The certificate string or file path.
 * @returns {string} The certificate content if valid.
 * @throws {Error} If the value is not a valid certificate string or file path.
 */
function getCertificateContent(value) {
  if (typeof value !== 'string') {
    throw new Error('Invalid input: SAML_CERT must be a string.');
  }

  // Check if it's an RFC7468 formatted PEM certificate
  const pemRegex = new RegExp(
    '-----BEGIN (CERTIFICATE|PUBLIC KEY)-----\n' + // header
      '([A-Za-z0-9+/=]{64}\n)+' + // base64 content (64 characters per line)
      '[A-Za-z0-9+/=]{1,64}\n' + //  base64 content (last line)
      '-----END (CERTIFICATE|PUBLIC KEY)-----', // footer
  );
  if (pemRegex.test(value)) {
    logger.info('[samlStrategy] Detected RFC7468-formatted certificate string.');
    return value;
  }

  // Check if it's a Base64-encoded certificate (no header)
  if (/^[A-Za-z0-9+/=]+$/.test(value) && value.length % 4 === 0) {
    logger.info('[samlStrategy] Detected base64-encoded certificate string (no header).');
    return value;
  }

  // Check if file exists and is readable
  const certPath = path.normalize(path.isAbsolute(value) ? value : path.join(paths.root, value));
  if (fs.existsSync(certPath) && fs.statSync(certPath).isFile()) {
    try {
      logger.info(`[samlStrategy] Loading certificate from file: ${certPath}`);
      return fs.readFileSync(certPath, 'utf8').trim();
    } catch (error) {
      throw new Error(`Error reading certificate file: ${error.message}`);
    }
  }

  throw new Error('Invalid cert: SAML_CERT must be a valid file path or certificate string.');
}

/**
 * Retrieves a SAML claim from a profile object based on environment configuration.
 * @param {object} profile - Saml profile
 * @param {string} envVar - Environment variable name (SAML_*)
 * @param {string} defaultKey -  Default key to use if the environment variable is not set
 * @returns {string}
 */
function getSamlClaim(profile, envVar, defaultKey) {
  const claimKey = process.env[envVar];

  // Avoids accessing `profile[""]` when the environment variable is empty string.
  if (claimKey) {
    return profile[claimKey] ?? profile[defaultKey];
  }
  return profile[defaultKey];
}

function getEmail(profile) {
  return getSamlClaim(profile, 'SAML_EMAIL_CLAIM', 'email');
}

function getUserName(profile) {
  return getSamlClaim(profile, 'SAML_USERNAME_CLAIM', 'username');
}

function getGivenName(profile) {
  return getSamlClaim(profile, 'SAML_GIVEN_NAME_CLAIM', 'given_name');
}

function getFamilyName(profile) {
  return getSamlClaim(profile, 'SAML_FAMILY_NAME_CLAIM', 'family_name');
}

function getPicture(profile) {
  return getSamlClaim(profile, 'SAML_PICTURE_CLAIM', 'picture');
}

const resizeIdentityProviderAvatar = async (url, userId) => {
  if (!url) {
    return null;
  }

  try {
    return await resizeAvatar({ userId, input: url });
  } catch (error) {
    logger.error('[samlStrategy] Failed to process identity-provider avatar', error);
    return null;
  }
};

/**
 * Determines the full name of a user based on SAML profile and environment configuration.
 *
 * @param {Object} profile - The user profile object from SAML Connect
 * @returns {string} The determined full name of the user
 */
function getFullName(profile) {
  if (process.env.SAML_NAME_CLAIM) {
    logger.debug(`[samlStrategy] Using SAML_NAME_CLAIM: ${process.env.SAML_NAME_CLAIM}`);
    return profile[process.env.SAML_NAME_CLAIM];
  }

  const givenName = getGivenName(profile);
  const familyName = getFamilyName(profile);

  if (givenName && familyName) {
    return `${givenName} ${familyName}`;
  }

  if (givenName) {
    return givenName;
  }
  if (familyName) {
    return familyName;
  }

  return getUserName(profile) || getEmail(profile);
}

/**
 * Converts an input into a string suitable for a username.
 * If the input is a string, it will be returned as is.
 * If the input is an array, elements will be joined with underscores.
 * In case of undefined or other falsy values, a default value will be returned.
 *
 * @param {string | string[] | undefined} input - The input value to be converted into a username.
 * @param {string} [defaultValue=''] - The default value to return if the input is falsy.
 * @returns {string} The processed input as a string suitable for a username.
 */
function convertToUsername(input, defaultValue = '') {
  if (typeof input === 'string') {
    return input;
  } else if (Array.isArray(input)) {
    return input.join('_');
  }

  return defaultValue;
}

/**
 * Creates a SAML authentication callback.
 * @param {boolean} [existingUsersOnly=false] - If true, only existing users will be authenticated.
 * @returns {Function} The SAML callback function for passport.
 */
function createSamlCallback(existingUsersOnly = false) {
  return async (profile, done) => {
    try {
      const subject = resolveSamlSubject(profile, process.env.SAML_IDP_ISSUER);
      if (subject.error) {
        logger.warn(`[samlStrategy] Rejected SAML subject: ${subject.error}`);
        return done(null, false, { message: ErrorTypes.AUTH_FAILED });
      }
      const { nameID } = subject;
      logger.info('[samlStrategy] SAML authentication received');

      const userEmail = getEmail(profile) || '';

      const baseConfig = await getAppConfig({ baseOnly: true });
      if (!isEmailDomainAllowed(userEmail, baseConfig?.registration?.allowedDomains)) {
        logger.error(
          '[samlStrategy] Authentication blocked because the email domain is not allowed',
        );
        return done(null, false, { message: 'Email domain not allowed' });
      }

      const found = await findSamlUser({ findUser, nameID, email: userEmail });
      if (found.error) {
        return done(null, false, { message: ErrorTypes.AUTH_FAILED });
      }
      let user = found.user;

      let appConfig = user?.tenantId
        ? await resolveAppConfigForUser(getAppConfig, user)
        : baseConfig;

      if (!isEmailDomainAllowed(userEmail, appConfig?.registration?.allowedDomains)) {
        logger.error('[samlStrategy] Authentication blocked by the tenant email-domain policy');
        return done(null, false, { message: 'Email domain not allowed' });
      }

      const fullName = getFullName(profile);

      const username = convertToUsername(
        getUserName(profile) || getGivenName(profile) || getEmail(profile),
      );

      if (!user && existingUsersOnly) {
        logger.error('[samlStrategy] Admin auth blocked because the user does not exist');
        return done(null, false, { message: 'User does not exist' });
      }

      const provisioned = await provisionSamlUser({
        user,
        nameID,
        email: userEmail,
        username,
        name: fullName,
        appConfig,
        getBalanceConfig,
        getAppConfig,
        findUser,
        createUserIfAbsent,
        findBalanceByUser,
        claimSamlIdentity,
      });
      if (provisioned.error) {
        return done(null, false, { message: provisioned.error });
      }
      ({ user, appConfig } = provisioned);

      const picture = getPicture(profile);
      if (picture && !user.avatar?.includes('manual=true')) {
        const userId = user._id.toString();
        const imageBuffer = await resizeIdentityProviderAvatar(picture, userId);
        if (imageBuffer) {
          let fileName;
          if (crypto) {
            fileName = (await hashToken(nameID)) + '.png';
          } else {
            fileName = userId + '.png';
          }

          const fileStrategy = getAvatarFileStrategy(appConfig, process.env.CDN_PROVIDER);
          const { saveBuffer } = getStrategyFunctions(fileStrategy);
          const imagePath = await saveBuffer(
            getAvatarSaveParams(fileStrategy, {
              fileName,
              userId,
              buffer: imageBuffer,
              tenantId: user.tenantId,
            }),
          );
          user.avatar = imagePath ?? '';
          user = await updateUser(user._id, user);
        }
      }

      logger.info(`[samlStrategy] Login success for user: ${user._id}`);

      done(null, user);
    } catch (err) {
      logger.error('[samlStrategy] Login failed', err);
      done(err);
    }
  };
}

/**
 * Returns the base SAML configuration shared by both regular and admin strategies.
 * @returns {object} The SAML configuration object.
 */
function getBaseSamlConfig() {
  const identifierFormat = process.env.SAML_NAME_ID_FORMAT?.trim();
  if (identifierFormat === TRANSIENT_SAML_NAME_ID_FORMAT) {
    throw new Error('SAML_NAME_ID_FORMAT must provide a stable, non-transient identifier');
  }
  return {
    entryPoint: process.env.SAML_ENTRY_POINT,
    issuer: process.env.SAML_ISSUER,
    idpCert: getCertificateContent(process.env.SAML_CERT),
    wantAssertionsSigned: process.env.SAML_USE_AUTHN_RESPONSE_SIGNED === 'true' ? false : true,
    wantAuthnResponseSigned: process.env.SAML_USE_AUTHN_RESPONSE_SIGNED === 'true' ? true : false,
    ...(identifierFormat ? { identifierFormat } : {}),
  };
}

async function setupSaml() {
  try {
    const baseConfig = getBaseSamlConfig();
    const samlConfig = {
      ...baseConfig,
      callbackUrl: process.env.SAML_CALLBACK_URL,
    };

    passport.use('saml', new SamlStrategy(samlConfig, createSamlCallback(false)));
    setupSamlAdmin(baseConfig);
  } catch (err) {
    logger.error('[samlStrategy]', err);
  }
}

/**
 * Sets up the SAML strategy specifically for admin authentication.
 * Rejects users that don't already exist.
 * @param {object} [baseConfig] - Pre-parsed base SAML config to avoid redundant cert parsing.
 */
function setupSamlAdmin(baseConfig) {
  try {
    const samlAdminConfig = {
      ...(baseConfig ?? getBaseSamlConfig()),
      callbackUrl: `${process.env.DOMAIN_SERVER}/api/admin/oauth/saml/callback`,
    };

    passport.use('samlAdmin', new SamlStrategy(samlAdminConfig, createSamlCallback(true)));
    logger.info('[samlStrategy] Admin SAML strategy registered.');
  } catch (err) {
    logger.error('[samlStrategy] setupSamlAdmin', err);
  }
}

module.exports = { setupSaml, getCertificateContent };
