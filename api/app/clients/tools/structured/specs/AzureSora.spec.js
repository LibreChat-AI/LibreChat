jest.mock('undici', () => ({
  fetch: jest.fn(),
}));

jest.mock(
  '@librechat/agents/langchain/tools',
  () => ({
    Tool: class {},
  }),
  { virtual: true },
);

jest.mock(
  '@librechat/data-schemas',
  () => ({
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    },
  }),
  { virtual: true },
);

const { fetch } = require('undici');
const AzureSora = require('./AzureSora');

describe('AzureSora Tool', () => {
  const validEndpoint = 'https://my-openai-resource.openai.azure.com';
  const validApiKey = 'test-azure-api-key-12345';
  const validDeployment = 'sora-preview';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Constructor & Endpoint Validation', () => {
    it('throws error if required credentials are missing when override is false', () => {
      expect(() => new AzureSora({})).toThrow(
        'Missing AZURE_OPENAI_ENDPOINT environment variable or configuration.',
      );
    });

    it('rejects user-provided endpoints outside trusted Azure domains', () => {
      expect(
        () =>
          new AzureSora({
            AZURE_OPENAI_ENDPOINT: 'https://malicious-external-api.com',
            AZURE_OPENAI_API_KEY: validApiKey,
            AZURE_OPENAI_SORA_DEPLOYMENT_NAME: validDeployment,
            userProvidedAuthFields: new Set(['AZURE_OPENAI_ENDPOINT']),
          }),
      ).toThrow('User-provided Azure OpenAI endpoints must use a trusted Azure host.');
    });

    it('successfully initializes with valid Azure OpenAI endpoint', () => {
      const tool = new AzureSora({
        AZURE_OPENAI_ENDPOINT: validEndpoint,
        AZURE_OPENAI_API_KEY: validApiKey,
        AZURE_OPENAI_SORA_DEPLOYMENT_NAME: validDeployment,
      });

      expect(tool.name).toBe('azure-sora');
      expect(tool.serviceEndpoint).toBe(validEndpoint);
      expect(tool.deploymentName).toBe(validDeployment);
    });
  });

  describe('_call Video Generation Execution', () => {
    it('returns validation error if prompt is empty', async () => {
      const tool = new AzureSora({
        AZURE_OPENAI_ENDPOINT: validEndpoint,
        AZURE_OPENAI_API_KEY: validApiKey,
        AZURE_OPENAI_SORA_DEPLOYMENT_NAME: validDeployment,
      });

      const result = await tool._call({ prompt: '' });
      expect(result).toContain('Error: A valid text prompt is required');
    });

    it('handles job submission, status polling, and returns video markdown on success', async () => {
      const tool = new AzureSora({
        AZURE_OPENAI_ENDPOINT: validEndpoint,
        AZURE_OPENAI_API_KEY: validApiKey,
        AZURE_OPENAI_SORA_DEPLOYMENT_NAME: validDeployment,
      });

      // Mock creation POST
      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'job-sora-999', status: 'pending' }),
      });

      // Mock polling GET (succeeded)
      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'job-sora-999',
          status: 'succeeded',
          prompt: 'A golden retriever running in autumn leaves',
          video_url: 'https://storage.azure.net/videos/generated-clip.mp4',
        }),
      });

      const result = await tool._call({
        prompt: 'A golden retriever running in autumn leaves',
        resolution: '1280x720',
        duration: 5,
      });

      expect(result).toContain('### 🎬 Video Generated with Azure Sora');
      expect(result).toContain('https://storage.azure.net/videos/generated-clip.mp4');
      expect(result).toContain('<video controls width="100%"');
    });

    it('handles failed generation job gracefully', async () => {
      const tool = new AzureSora({
        AZURE_OPENAI_ENDPOINT: validEndpoint,
        AZURE_OPENAI_API_KEY: validApiKey,
        AZURE_OPENAI_SORA_DEPLOYMENT_NAME: validDeployment,
      });

      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'job-sora-fail', status: 'pending' }),
      });

      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'job-sora-fail',
          status: 'failed',
          error: { message: 'Content safety filter triggered.' },
        }),
      });

      const result = await tool._call({
        prompt: 'Unsafe prompt example',
      });

      expect(result).toContain('Video generation failed: Content safety filter triggered.');
    });
  });
});
