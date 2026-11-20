const AzureSoraClient = require('./azureSora');

function createSoraClient(config = {}) {
  const resourceName = config.resourceName || process.env.AZURE_OPENAI_SORA_RESOURCE_NAME;
  const deploymentName = config.deploymentName || process.env.AZURE_OPENAI_SORA_DEPLOYMENT_NAME || 'sora';
  const apiKey = config.apiKey || process.env.AZURE_OPENAI_SORA_API_KEY;
  const apiVersion = config.apiVersion || process.env.AZURE_OPENAI_SORA_API_VERSION || '2025-04-01-preview';

  if (!resourceName || !apiKey) {
    throw new Error('Azure OpenAI Sora resource name and API key are required');
  }

  return new AzureSoraClient({ resourceName, deploymentName, apiKey, apiVersion });
}

module.exports = { AzureSoraClient, createSoraClient };
