const { AuthType } = require('librechat-data-provider');
const { getUserPluginAuthValue } = require('~/server/services/PluginService');

/**
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {string[]} params.authFields
 * @param {Set<string>} [params.optional]
 * @param {boolean} [params.throwError]
 * @param {boolean} [params.failOnOptionalError]
 * @returns
 */
const loadAuthValues = async ({
  userId,
  authFields,
  optional,
  throwError = true,
  failOnOptionalError = false,
}) => {
  let authValues = {};

  /**
   * Finds the first non-empty value for the given authentication field, supporting alternate fields.
   * @param {string[]} fields Array of strings representing the authentication fields. Supports alternate fields delimited by "||".
   * @returns {Promise<{ authField: string, authValue: string} | null>} An object containing the authentication field and value, or null if not found.
   */
  const findAuthValue = async (fields) => {
    for (const field of fields) {
      const envValue = process.env[field];
      if (envValue && envValue.trim() !== '' && envValue !== AuthType.USER_PROVIDED) {
        return { authField: field, authValue: envValue };
      }
      let value;
      try {
        value = await getUserPluginAuthValue(userId, field, throwError);
      } catch (err) {
        const isOptional = optional && optional.has(field);
        const isMissingOptional = isOptional && err?.code === 'PLUGIN_AUTH_NOT_FOUND';
        if (isOptional && (!failOnOptionalError || isMissingOptional)) {
          return { authField: field, authValue: undefined };
        }
        if (field === fields[fields.length - 1]) {
          throw err;
        }
      }
      if (value) {
        return { authField: field, authValue: value };
      }
    }
    return null;
  };

  const results = await Promise.all(
    authFields.map((authField) => findAuthValue(authField.split('||'))),
  );

  for (const result of results) {
    if (result) {
      authValues[result.authField] = result.authValue;
    }
  }

  return authValues;
};

module.exports = {
  loadAuthValues,
};
