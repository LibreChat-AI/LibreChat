const axios = require('axios');
const AzureSoraClient = require('../azureSora');

jest.mock('axios');

describe('AzureSoraClient', () => {
  let client;

  beforeEach(() => {
    client = new AzureSoraClient({
      resourceName: 'test-resource',
      deploymentName: 'sora',
      apiKey: 'test-api-key',
      apiVersion: '2025-04-01-preview',
    });
    jest.clearAllMocks();
  });

  describe('createVideoGeneration', () => {
    it('should send a POST request with correct parameters', async () => {
      const mockResponse = { data: { id: 'op-123', status: 'running' } };
      axios.post.mockResolvedValue(mockResponse);

      const result = await client.createVideoGeneration({
        prompt: 'A sunset over mountains',
        n_seconds: 10,
        height: 720,
        width: 1280,
      });

      expect(axios.post).toHaveBeenCalledWith(
        'https://test-resource.openai.azure.com/openai/deployments/sora/videos/generations?api-version=2025-04-01-preview',
        { prompt: 'A sunset over mountains', n_seconds: 10, height: 720, width: 1280 },
        {
          headers: {
            'api-key': 'test-api-key',
            'Content-Type': 'application/json',
          },
        },
      );
      expect(result).toEqual({ id: 'op-123', status: 'running' });
    });

    it('should use default parameters when not provided', async () => {
      const mockResponse = { data: { id: 'op-456', status: 'running' } };
      axios.post.mockResolvedValue(mockResponse);

      await client.createVideoGeneration({ prompt: 'A cat' });

      expect(axios.post).toHaveBeenCalledWith(
        expect.any(String),
        { prompt: 'A cat', n_seconds: 5, height: 480, width: 854 },
        expect.any(Object),
      );
    });
  });

  describe('getVideoGeneration', () => {
    it('should send a GET request with correct operation ID', async () => {
      const mockResponse = {
        data: {
          id: 'op-123',
          status: 'succeeded',
          result: { generations: [{ video_url: 'https://example.com/video.mp4' }] },
        },
      };
      axios.get.mockResolvedValue(mockResponse);

      const result = await client.getVideoGeneration('op-123');

      expect(axios.get).toHaveBeenCalledWith(
        'https://test-resource.openai.azure.com/openai/deployments/sora/videos/generations/op-123?api-version=2025-04-01-preview',
        { headers: { 'api-key': 'test-api-key' } },
      );
      expect(result.status).toBe('succeeded');
    });
  });

  describe('deleteVideoGeneration', () => {
    it('should send a DELETE request with correct operation ID', async () => {
      axios.delete.mockResolvedValue({ data: {} });

      await client.deleteVideoGeneration('op-123');

      expect(axios.delete).toHaveBeenCalledWith(
        'https://test-resource.openai.azure.com/openai/deployments/sora/videos/generations/op-123?api-version=2025-04-01-preview',
        { headers: { 'api-key': 'test-api-key' } },
      );
    });
  });

  describe('pollVideoGeneration', () => {
    it('should return result when status is succeeded', async () => {
      const successResponse = {
        data: {
          id: 'op-123',
          status: 'succeeded',
          result: { generations: [{ video_url: 'https://example.com/video.mp4' }] },
        },
      };
      axios.get.mockResolvedValue(successResponse);

      const result = await client.pollVideoGeneration('op-123', { interval: 10 });

      expect(result.status).toBe('succeeded');
    });

    it('should throw an error when status is failed', async () => {
      const failedResponse = {
        data: {
          id: 'op-123',
          status: 'failed',
          error: { message: 'Content policy violation' },
        },
      };
      axios.get.mockResolvedValue(failedResponse);

      await expect(
        client.pollVideoGeneration('op-123', { interval: 10 }),
      ).rejects.toThrow('Content policy violation');
    });

    it('should throw an error on timeout', async () => {
      const runningResponse = { data: { id: 'op-123', status: 'running' } };
      axios.get.mockResolvedValue(runningResponse);

      await expect(
        client.pollVideoGeneration('op-123', { interval: 10, timeout: 50 }),
      ).rejects.toThrow('Video generation timed out');
    });

    it('should poll multiple times until succeeded', async () => {
      const runningResponse = { data: { id: 'op-123', status: 'running' } };
      const succeededResponse = {
        data: {
          id: 'op-123',
          status: 'succeeded',
          result: { generations: [{ video_url: 'https://example.com/video.mp4' }] },
        },
      };

      axios.get
        .mockResolvedValueOnce(runningResponse)
        .mockResolvedValueOnce(runningResponse)
        .mockResolvedValueOnce(succeededResponse);

      const result = await client.pollVideoGeneration('op-123', { interval: 10 });

      expect(axios.get).toHaveBeenCalledTimes(3);
      expect(result.status).toBe('succeeded');
    });
  });
});
