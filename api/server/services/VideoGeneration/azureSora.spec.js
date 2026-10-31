const axios = require('axios');
const { createVideoGeneration, pollVideoGeneration, generateVideo } = require('./azureSora');

jest.mock('axios');
jest.mock('~/config', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

describe('AzureSora Video Generation', () => {
  const baseParams = {
    endpoint: 'https://my-resource.openai.azure.com',
    deploymentName: 'sora',
    apiKey: 'test-api-key',
    prompt: 'A cat playing with a ball in a sunny garden',
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createVideoGeneration', () => {
    it('should create a video generation job', async () => {
      const mockResponse = {
        data: {
          id: 'gen-123',
          status: 'running',
          created_at: '2025-05-02T00:00:00Z',
        },
      };
      axios.post.mockResolvedValue(mockResponse);

      const result = await createVideoGeneration(baseParams);

      expect(axios.post).toHaveBeenCalledWith(
        'https://my-resource.openai.azure.com/openai/deployments/sora/videos/generations?api-version=2025-04-01-preview',
        {
          prompt: baseParams.prompt,
          n_seconds: 5,
          height: 480,
          width: 854,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'api-key': 'test-api-key',
          },
        },
      );
      expect(result).toEqual(mockResponse.data);
    });

    it('should use custom video parameters when provided', async () => {
      const mockResponse = { data: { id: 'gen-456', status: 'running' } };
      axios.post.mockResolvedValue(mockResponse);

      await createVideoGeneration({
        ...baseParams,
        nSeconds: 10,
        height: 720,
        width: 1280,
      });

      expect(axios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          n_seconds: 10,
          height: 720,
          width: 1280,
        }),
        expect.any(Object),
      );
    });

    it('should strip trailing slash from endpoint', async () => {
      axios.post.mockResolvedValue({ data: { id: 'gen-789', status: 'running' } });

      await createVideoGeneration({
        ...baseParams,
        endpoint: 'https://my-resource.openai.azure.com/',
      });

      expect(axios.post).toHaveBeenCalledWith(
        'https://my-resource.openai.azure.com/openai/deployments/sora/videos/generations?api-version=2025-04-01-preview',
        expect.any(Object),
        expect.any(Object),
      );
    });
  });

  describe('pollVideoGeneration', () => {
    it('should return result when status is succeeded', async () => {
      const mockResult = {
        data: {
          id: 'gen-123',
          status: 'succeeded',
          generations: [{ video_url: 'https://example.com/video.mp4' }],
        },
      };
      axios.get.mockResolvedValue(mockResult);

      const result = await pollVideoGeneration({
        ...baseParams,
        generationId: 'gen-123',
      });

      expect(result).toEqual(mockResult.data);
    });

    it('should throw when status is failed', async () => {
      axios.get.mockResolvedValue({
        data: {
          id: 'gen-123',
          status: 'failed',
          error: { message: 'Content policy violation' },
        },
      });

      await expect(
        pollVideoGeneration({ ...baseParams, generationId: 'gen-123' }),
      ).rejects.toThrow('Video generation failed: Content policy violation');
    });

    it('should throw when status is cancelled', async () => {
      axios.get.mockResolvedValue({
        data: {
          id: 'gen-123',
          status: 'cancelled',
          error: {},
        },
      });

      await expect(
        pollVideoGeneration({ ...baseParams, generationId: 'gen-123' }),
      ).rejects.toThrow('Video generation cancelled: Unknown error');
    });

    it('should poll multiple times before succeeding', async () => {
      axios.get
        .mockResolvedValueOnce({ data: { id: 'gen-123', status: 'running' } })
        .mockResolvedValueOnce({ data: { id: 'gen-123', status: 'running' } })
        .mockResolvedValueOnce({
          data: {
            id: 'gen-123',
            status: 'succeeded',
            generations: [{ video_url: 'https://example.com/video.mp4' }],
          },
        });

      jest.useFakeTimers();
      const promise = pollVideoGeneration({ ...baseParams, generationId: 'gen-123' });

      await jest.advanceTimersByTimeAsync(3000);
      await jest.advanceTimersByTimeAsync(3000);

      const result = await promise;
      expect(result.status).toBe('succeeded');
      expect(axios.get).toHaveBeenCalledTimes(3);

      jest.useRealTimers();
    });
  });

  describe('generateVideo', () => {
    it('should create a job and poll until completion', async () => {
      axios.post.mockResolvedValue({
        data: { id: 'gen-full-123', status: 'running' },
      });
      axios.get.mockResolvedValue({
        data: {
          id: 'gen-full-123',
          status: 'succeeded',
          generations: [{ video_url: 'https://example.com/final.mp4' }],
        },
      });

      const result = await generateVideo(baseParams);

      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(axios.get).toHaveBeenCalledTimes(1);
      expect(result.generations[0].video_url).toBe('https://example.com/final.mp4');
    });
  });
});
