const path = require('path');
const fs = require('fs/promises');
const { logger } = require('@librechat/data-schemas');
const { loadServiceKey, isUserProvided } = require('@librechat/api');
const { config } = require('./EndpointService');

const defaultServiceKeyPath = path.join(__dirname, '../../..', 'data', 'auth.json');

async function getServiceKeyPath() {
  const serviceKeyPath = process.env.GOOGLE_SERVICE_KEY_FILE?.trim();
  if (serviceKeyPath) {
    return serviceKeyPath;
  }

  try {
    await fs.access(defaultServiceKeyPath);
    return defaultServiceKeyPath;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logger.warn(
        `Unable to access default Google service key file: ${defaultServiceKeyPath}`,
        error,
      );
    }
    return null;
  }
}

async function loadAsyncEndpoints() {
  let serviceKey;
  let googleUserProvides = false;
  const { googleKey } = config;

  /** Check if GOOGLE_KEY is provided at all(including 'user_provided') */
  const isGoogleKeyProvided = googleKey && googleKey.trim() !== '';

  if (isGoogleKeyProvided) {
    /** If GOOGLE_KEY is provided, check if it's user_provided */
    googleUserProvides = isUserProvided(googleKey);
  } else {
    const serviceKeyPath = await getServiceKeyPath();

    if (serviceKeyPath) {
      try {
        serviceKey = await loadServiceKey(serviceKeyPath);
      } catch (error) {
        logger.warn('Error loading Google service key', error);
        serviceKey = null;
      }
    }
  }

  const google = serviceKey || isGoogleKeyProvided ? { userProvide: googleUserProvides } : false;

  return { google };
}

module.exports = loadAsyncEndpoints;
