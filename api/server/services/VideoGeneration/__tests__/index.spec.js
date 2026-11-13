describe('createSoraClient', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should create a client with explicit config', () => {
    const { createSoraClient } = require('../index');
    const client = createSoraClient({
      resourceName: 'my-resource',
      deploymentName: 'sora',
      apiKey: 'my-key',
    });
    expect(client).toBeDefined();
  });

  it('should create a client from environment variables', () => {
    process.env.AZURE_OPENAI_SORA_RESOURCE_NAME = 'env-resource';
    process.env.AZURE_OPENAI_SORA_API_KEY = 'env-key';
    process.env.AZURE_OPENAI_SORA_DEPLOYMENT_NAME = 'sora';

    const { createSoraClient } = require('../index');
    const client = createSoraClient();
    expect(client).toBeDefined();
  });

  it('should throw if resource name is missing', () => {
    delete process.env.AZURE_OPENAI_SORA_RESOURCE_NAME;
    delete process.env.AZURE_OPENAI_SORA_API_KEY;

    const { createSoraClient } = require('../index');
    expect(() => createSoraClient()).toThrow('Azure OpenAI Sora resource name and API key are required');
  });

  it('should throw if API key is missing', () => {
    process.env.AZURE_OPENAI_SORA_RESOURCE_NAME = 'my-resource';
    delete process.env.AZURE_OPENAI_SORA_API_KEY;

    const { createSoraClient } = require('../index');
    expect(() => createSoraClient()).toThrow('Azure OpenAI Sora resource name and API key are required');
  });
});
