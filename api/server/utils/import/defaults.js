const { logger, getTenantId } = require('@librechat/data-schemas');
const { EModelEndpoint, openAISettings, anthropicSettings } = require('librechat-data-provider');
const { getModelsConfig } = require('~/server/controllers/ModelController');

/**
 * Last-resort hardcoded defaults used only when the runtime models config is
 * unavailable or returns no models for the endpoint.
 */
const FALLBACK_MODEL_BY_ENDPOINT = {
  [EModelEndpoint.openAI]: openAISettings.model.default,
  [EModelEndpoint.anthropic]: anthropicSettings.model.default,
};

/**
 * Picks the first available model for an endpoint from a runtime models config.
 *
 * @param {string} endpoint - The endpoint key (e.g. EModelEndpoint.anthropic).
 * @param {TModelsConfig} [modelsConfig] - Map of endpoint -> available model list.
 * @returns {string | undefined} The first model for the endpoint, or undefined.
 */
function pickFirstConfiguredModel(endpoint, modelsConfig) {
  const models = modelsConfig?.[endpoint];
  if (!Array.isArray(models)) {
    return undefined;
  }
  for (const model of models) {
    if (typeof model === 'string' && model.length > 0) {
      return model;
    }
  }
  return undefined;
}

/**
 * Resolves the default model that imported conversations should be saved with
 * for a given endpoint. Prefers the first model exposed by the runtime models
 * config (admin-configured / provider-discovered), and only falls back to the
 * hardcoded per-endpoint default if the runtime config is empty or fails.
 *
 * @param {object} args
 * @param {string} args.endpoint - The endpoint key the import is targeting.
 * @param {string} args.requestUserId - The id of the importing user.
 * @param {string} [args.userRole] - The role of the importing user.
 * @returns {Promise<string>} The default model name to persist on the conversation.
 */
async function resolveImportDefaultModel({ endpoint, requestUserId, userRole }) {
  try {
    const modelsConfig = await getModelsConfig({
      user: { id: requestUserId, role: userRole, tenantId: getTenantId() },
    });
    const configured = pickFirstConfiguredModel(endpoint, modelsConfig);
    if (configured) {
      return configured;
    }
  } catch (error) {
    logger.warn(
      `[import] Failed to resolve default model from modelsConfig for ${endpoint}: ${error.message}`,
    );
  }
  return FALLBACK_MODEL_BY_ENDPOINT[endpoint] ?? openAISettings.model.default;
}

/**
 * Preferred endpoint order for conversations cloned without a known source
 * endpoint. OpenAI is first so deployments that expose it keep prior behavior;
 * any other configured endpoint is still selected when these are unavailable.
 */
const DEFAULT_ENDPOINT_PREFERENCE = [
  EModelEndpoint.openAI,
  EModelEndpoint.anthropic,
  EModelEndpoint.google,
  EModelEndpoint.azureOpenAI,
  EModelEndpoint.bedrock,
];

/**
 * Endpoints excluded as fork targets because they are stateful: each
 * conversation needs an assistant_id and thread_id that a cloned conversation
 * never creates, so the assistants chat controller rejects the first follow-up
 * ("Missing thread_id for existing conversation"). A fork must land on a
 * stateless chat endpoint. These can still surface in the runtime models config
 * (e.g. a deployment exposing only assistant models), so filter them out.
 */
const EXCLUDED_FORK_ENDPOINTS = new Set([
  EModelEndpoint.assistants,
  EModelEndpoint.azureAssistants,
]);

/**
 * Resolves an endpoint and model the requesting user can actually use, for
 * conversations cloned without a known source endpoint (shared forks, whose
 * original endpoint is stripped from the sanitized payload). Picks the first
 * preferred endpoint exposing models, then any other configured endpoint
 * (excluding stateful assistant endpoints, which a fork cannot resume), so a
 * deployment that doesn't expose OpenAI doesn't produce a conversation whose
 * first message is rejected by model validation. Falls back to OpenAI defaults
 * only when the runtime models config is empty or unavailable.
 *
 * @param {object} args
 * @param {string} args.requestUserId - The id of the requesting user.
 * @param {string} [args.userRole] - The role of the requesting user.
 * @returns {Promise<{ endpoint: string, model: string }>} A usable endpoint and model.
 */
async function resolveImportDefaultEndpoint({ requestUserId, userRole }) {
  try {
    const modelsConfig = await getModelsConfig({
      user: { id: requestUserId, role: userRole, tenantId: getTenantId() },
    });
    if (modelsConfig) {
      const orderedEndpoints = [
        ...DEFAULT_ENDPOINT_PREFERENCE,
        ...Object.keys(modelsConfig).filter(
          (endpoint) => !DEFAULT_ENDPOINT_PREFERENCE.includes(endpoint),
        ),
      ];
      for (const endpoint of orderedEndpoints) {
        if (EXCLUDED_FORK_ENDPOINTS.has(endpoint)) {
          continue;
        }
        const model = pickFirstConfiguredModel(endpoint, modelsConfig);
        if (model) {
          return { endpoint, model };
        }
      }
    }
  } catch (error) {
    logger.warn(
      `[import] Failed to resolve a default endpoint from modelsConfig: ${error.message}`,
    );
  }
  return {
    endpoint: EModelEndpoint.openAI,
    model: FALLBACK_MODEL_BY_ENDPOINT[EModelEndpoint.openAI] ?? openAISettings.model.default,
  };
}

module.exports = {
  FALLBACK_MODEL_BY_ENDPOINT,
  pickFirstConfiguredModel,
  resolveImportDefaultModel,
  resolveImportDefaultEndpoint,
};
