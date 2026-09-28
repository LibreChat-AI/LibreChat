const { logger } = require('@librechat/data-schemas');
const { ContentTypes } = require('librechat-data-provider');
const Sora = require('../Sora');

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('@librechat/api', () => ({
  extractBaseURL: jest.fn((url) => url),
  getProxyDispatcher: jest.fn(() => null),
  getEnvProxyDispatcher: jest.fn(() => null),
  createMinimalRetentionRequest: jest.fn((req) => req),
}));

jest.mock('undici', () => ({
  fetch: jest.fn(),
}));

const { fetch } = require('undici');

describe('Sora Structured Tool', () => {
  let originalEnv;
  const mockApiKey = 'test-sora-api-key';

  beforeAll(() => {
    originalEnv = { ...process.env };
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.SORA_API_KEY = mockApiKey;
    process.env.SORA_BASEURL = 'https://my-azure-resource.openai.azure.com';
    process.env.SORA_AZURE_API_VERSION = '2025-05-01-preview';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('Initialization & Configuration', () => {
    it('initializes successfully with environment variables', () => {
      const tool = new Sora();
      expect(tool.name).toBe('sora');
      expect(tool.apiKey).toBe(mockApiKey);
      expect(tool.baseURL).toBe('https://my-azure-resource.openai.azure.com');
      expect(tool.apiVersion).toBe('2025-05-01-preview');
    });

    it('initializes with Azure API Key fallback', () => {
      delete process.env.SORA_API_KEY;
      process.env.AZURE_OPENAI_API_KEY = 'azure-key-123';
      const tool = new Sora();
      expect(tool.apiKey).toBe('azure-key-123');
    });

    it('throws error when no API key is provided and override is false', () => {
      delete process.env.SORA_API_KEY;
      delete process.env.AZURE_OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      expect(() => new Sora()).toThrow('Missing SORA_API_KEY or AZURE_OPENAI_API_KEY environment variable.');
    });

    it('does not throw when override is true and API key is missing', () => {
      delete process.env.SORA_API_KEY;
      delete process.env.AZURE_OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      expect(() => new Sora({ override: true })).not.toThrow();
    });

    it('sets responseFormat for Agent mode', () => {
      const tool = new Sora({ isAgent: true });
      expect(tool.responseFormat).toBe('content_and_artifact');
    });
  });

  describe('Headers & URL Routing', () => {
    it('generates Azure headers with api-key', () => {
      const tool = new Sora();
      const headers = tool.getHeaders();
      expect(headers['api-key']).toBe(mockApiKey);
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['Authorization']).toBeUndefined();
    });

    it('generates standard OpenAI Bearer header when not Azure', () => {
      const tool = new Sora({
        SORA_BASEURL: 'https://api.openai.com/v1',
        SORA_AZURE_API_VERSION: '',
      });
      const headers = tool.getHeaders();
      expect(headers['Authorization']).toBe(`Bearer ${mockApiKey}`);
      expect(headers['api-key']).toBeUndefined();
    });

    it('constructs correct Azure job URLs with api-version query param', () => {
      const tool = new Sora();
      const submitUrl = tool.getJobUrl();
      expect(submitUrl).toBe(
        'https://my-azure-resource.openai.azure.com/openai/v1/video/generations/jobs?api-version=2025-05-01-preview',
      );

      const pollUrl = tool.getJobUrl('job-1234');
      expect(pollUrl).toBe(
        'https://my-azure-resource.openai.azure.com/openai/v1/video/generations/jobs/job-1234?api-version=2025-05-01-preview',
      );
    });
  });

  describe('Execution & Polling Loop', () => {
    it('successfully submits job and polls until completion', async () => {
      const tool = new Sora({ pollInterval: 10, pollTimeout: 5000 });

      // Mock 1: Initial POST job submission returns job ID
      fetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'job-abc', status: 'queued' }),
      });

      // Mock 2: First poll returns running
      fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'job-abc', status: 'running' }),
      });

      // Mock 3: Second poll returns succeeded with video URL
      fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: 'job-abc',
          status: 'succeeded',
          generations: [{ url: 'https://storage.azure.com/videos/output.mp4' }],
        }),
      });

      const result = await tool._call({
        prompt: 'A cyberpunk city in the rain with neon lights',
        size: '1280x720',
        duration: 5,
      });

      expect(result).toContain('https://storage.azure.com/videos/output.mp4');
      expect(result).toContain('<video controls');
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('returns Agent response format when isAgent is true', async () => {
      const tool = new Sora({ isAgent: true, pollInterval: 10 });

      fetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'job-agent', status: 'queued' }),
      });

      fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: 'job-agent',
          status: 'succeeded',
          generations: [{ url: 'https://storage.azure.com/videos/agent.mp4' }],
        }),
      });

      const [response, artifact] = await tool._call({
        prompt: 'A sunset over mountain peaks',
      });

      expect(response[0].type).toBe(ContentTypes.TEXT);
      expect(artifact.content[0].type).toBe(ContentTypes.VIDEO_URL);
      expect(artifact.content[0].video_url.url).toBe('https://storage.azure.com/videos/agent.mp4');
    });

    it('handles job failure with error description', async () => {
      const tool = new Sora({ pollInterval: 10 });

      fetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'job-fail', status: 'queued' }),
      });

      fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: 'job-fail',
          status: 'failed',
          error: { message: 'Prompt violated content management policy.' },
        }),
      });

      const result = await tool._call({ prompt: 'Invalid content prompt' });
      expect(result).toContain('Prompt violated content management policy.');
    });

    it('handles job creation network/server failure gracefully', async () => {
      const tool = new Sora();

      fetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const result = await tool._call({ prompt: 'A snowy forest' });
      expect(result).toContain('Video generation request failed (500)');
    });
  });
});
