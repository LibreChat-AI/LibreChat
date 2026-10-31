const loadConfigModels = require('./loadConfigModels');
const loadDefaultModels = require('./loadDefaultModels');

/**
 * Per-request memo of the resolved models config. One request resolves this
 * from several places (model validation, token config, agent initialization),
 * and each resolution may re-fetch gateway catalogs — `fetchModels` skips the
 * shared `MODEL_QUERIES` cache whenever an endpoint forwards user-bound
 * headers. Callers share one object; treat the result as read-only.
 *
 * @type {WeakMap<object, Promise<Record<string, string[]>>>}
 */
const inFlight = new WeakMap();

async function resolveModelsConfig(req) {
  const [defaultModelsConfig, customModelsConfig] = await Promise.all([
    loadDefaultModels(req),
    loadConfigModels(req),
  ]);
  return { ...defaultModelsConfig, ...customModelsConfig };
}

/**
 * @param {ServerRequest} req
 * @returns {Promise<Record<string, string[]>>}
 */
function getModelsConfig(req) {
  if (req == null || typeof req !== 'object') {
    return resolveModelsConfig(req);
  }

  const pending = inFlight.get(req);
  if (pending != null) {
    return pending;
  }

  /* Evict on failure so a later caller retries rather than inheriting a
     settled rejection. */
  const resolving = resolveModelsConfig(req).catch((error) => {
    inFlight.delete(req);
    throw error;
  });
  inFlight.set(req, resolving);
  return resolving;
}

module.exports = getModelsConfig;
