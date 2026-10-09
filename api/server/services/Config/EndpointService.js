const { isUserProvided, isEnabled } = require('@librechat/api');
const { EModelEndpoint } = require('librechat-data-provider');
const { generateConfig } = require('~/server/utils/handleText');

const {
  OPENAI_API_KEY: openAIApiKey,
  AZURE_ASSISTANTS_API_KEY: azureAssistantsApiKey,
  ASSISTANTS_API_KEY: assistantsApiKey,
  AZURE_API_KEY: azureOpenAIApiKey,
  ANTHROPIC_API_KEY: anthropicApiKey,
  GOOGLE_KEY: googleKey,
  OPENAI_REVERSE_PROXY,
  AZURE_OPENAI_BASEURL,
  ASSISTANTS_BASE_URL,
  AZURE_ASSISTANTS_BASE_URL,
} = process.env ?? {};

const userProvidedOpenAI = isUserProvided(openAIApiKey);
const anthropicUsesVertex = isEnabled(process.env.ANTHROPIC_USE_VERTEX);
const firstNonEmpty = (...values) => values.find((value) => value != null && value !== '');
const bedrockUserProvidedCredential = [
  process.env.BEDROCK_AWS_BEARER_TOKEN,
  process.env.BEDROCK_AWS_ACCESS_KEY_ID,
  process.env.BEDROCK_AWS_SECRET_ACCESS_KEY,
  process.env.BEDROCK_AWS_SESSION_TOKEN,
].find(isUserProvided);

module.exports = {
  config: {
    googleKey,
    openAIApiKey,
    azureOpenAIApiKey,
    userProvidedOpenAI,
    [EModelEndpoint.anthropic]: generateConfig(anthropicUsesVertex ? 'true' : anthropicApiKey),
    [EModelEndpoint.openAI]: generateConfig(openAIApiKey, OPENAI_REVERSE_PROXY),
    [EModelEndpoint.azureOpenAI]: generateConfig(azureOpenAIApiKey, AZURE_OPENAI_BASEURL),
    [EModelEndpoint.assistants]: generateConfig(
      assistantsApiKey,
      ASSISTANTS_BASE_URL,
      EModelEndpoint.assistants,
    ),
    [EModelEndpoint.azureAssistants]: generateConfig(
      azureAssistantsApiKey,
      AZURE_ASSISTANTS_BASE_URL,
      EModelEndpoint.azureAssistants,
    ),
    [EModelEndpoint.bedrock]: generateConfig(
      bedrockUserProvidedCredential ??
        firstNonEmpty(
          process.env.BEDROCK_AWS_BEARER_TOKEN,
          process.env.BEDROCK_AWS_SECRET_ACCESS_KEY,
          process.env.BEDROCK_AWS_PROFILE,
          process.env.BEDROCK_AWS_DEFAULT_REGION,
        ),
    ),
    /* key will be part of separate config */
    [EModelEndpoint.agents]: generateConfig('true', undefined, EModelEndpoint.agents),
  },
};
