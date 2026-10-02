const { logger } = require('@librechat/data-schemas');
const { EModelEndpoint } = require('librechat-data-provider');
const {
  mergeHeaders,
  getAnthropicModels,
  getBedrockModels,
  getAppConfigOptionsFromUser,
  getOpenAIModels,
  getGoogleModels,
  configuredModelList,
} = require('@librechat/api');
const { getAppConfig } = require('./app');

/**
 * Loads the default models for the application.
 * @async
 * @function
 * @param {ServerRequest} req - The Express request object.
 */
async function loadDefaultModels(req) {
  try {
    const appConfig = req.config ?? (await getAppConfig(getAppConfigOptionsFromUser(req.user)));
    const vertexConfig = appConfig?.endpoints?.[EModelEndpoint.anthropic]?.vertexConfig;

    /** Forward configured custom headers (endpoint over global `all`) so model
     *  fetches reach a gateway-fronted provider the same as chat requests. */
    const allHeaders = appConfig?.endpoints?.all?.headers;
    const openAIHeaders = mergeHeaders(
      allHeaders,
      appConfig?.endpoints?.[EModelEndpoint.openAI]?.headers,
    );
    const anthropicHeaders = mergeHeaders(
      allHeaders,
      appConfig?.endpoints?.[EModelEndpoint.anthropic]?.headers,
    );

    const [openAI, anthropic, azureOpenAI, assistants, azureAssistants, google, bedrock] =
      await Promise.all([
        getOpenAIModels({
          user: req.user.id,
          headers: openAIHeaders,
          userObject: req.user,
          configuredModels: configuredModelList(appConfig, EModelEndpoint.openAI),
        }).catch((error) => {
          logger.error('Error fetching OpenAI models:', error);
          return [];
        }),
        getAnthropicModels({
          user: req.user.id,
          vertexModels: vertexConfig?.modelNames,
          headers: anthropicHeaders,
          userObject: req.user,
          configuredModels: configuredModelList(appConfig, EModelEndpoint.anthropic),
        }).catch((error) => {
          logger.error('Error fetching Anthropic models:', error);
          return [];
        }),
        getOpenAIModels({ user: req.user.id, azure: true }).catch((error) => {
          logger.error('Error fetching Azure OpenAI models:', error);
          return [];
        }),
        getOpenAIModels({ assistants: true }).catch((error) => {
          logger.error('Error fetching OpenAI Assistants API models:', error);
          return [];
        }),
        getOpenAIModels({ azureAssistants: true }).catch((error) => {
          logger.error('Error fetching Azure OpenAI Assistants API models:', error);
          return [];
        }),
        Promise.resolve(getGoogleModels()).catch((error) => {
          logger.error('Error getting Google models:', error);
          return [];
        }),
        Promise.resolve(getBedrockModels()).catch((error) => {
          logger.error('Error getting Bedrock models:', error);
          return [];
        }),
      ]);

    return {
      [EModelEndpoint.openAI]: openAI,
      [EModelEndpoint.google]: google,
      [EModelEndpoint.anthropic]: anthropic,
      [EModelEndpoint.azureOpenAI]: azureOpenAI,
      [EModelEndpoint.assistants]: assistants,
      [EModelEndpoint.azureAssistants]: azureAssistants,
      [EModelEndpoint.bedrock]: bedrock,
    };
  } catch (error) {
    logger.error('Error fetching default models:', error);
    throw new Error(`Failed to load default models: ${error.message}`);
  }
}

module.exports = loadDefaultModels;
