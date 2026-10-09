const { fetch } = require('undici');
const { logger } = require('@librechat/data-schemas');
const AzureSora = require('../AzureSora');

const saveBase64Video = jest.fn();

jest.mock('undici', () => ({
  fetch: jest.fn(),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

const mockApiKey = 'mock_api_key';
const mockEndpoint = 'https://mock-resource.openai.azure.com';

const jsonResponse = (body, ok = true, status = 200) => ({
  ok,
  status,
  json: jest.fn().mockResolvedValue(body),
  text: jest.fn().mockResolvedValue(JSON.stringify(body)),
});

describe('AzureSora', () => {
  let originalEnv;

  beforeAll(() => {
    originalEnv = { ...process.env };
  });

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      AZURE_SORA_API_KEY: mockApiKey,
      AZURE_SORA_ENDPOINT: mockEndpoint,
    };
    fetch.mockReset();
    saveBase64Video.mockReset();
  });

  afterEach(() => {
    jest.clearAllMocks();
    process.env = originalEnv;
  });

  it('should throw an error if the API key is missing', () => {
    delete process.env.AZURE_SORA_API_KEY;
    expect(() => new AzureSora()).toThrow('Missing AZURE_SORA_API_KEY environment variable.');
  });

  it('should throw an error if the endpoint is missing', () => {
    delete process.env.AZURE_SORA_ENDPOINT;
    expect(() => new AzureSora()).toThrow('Missing AZURE_SORA_ENDPOINT environment variable.');
  });

  it('should not throw when override is set without credentials', () => {
    delete process.env.AZURE_SORA_API_KEY;
    delete process.env.AZURE_SORA_ENDPOINT;
    expect(() => new AzureSora({ override: true })).not.toThrow();
  });

  it('should accept credentials via constructor fields', () => {
    delete process.env.AZURE_SORA_API_KEY;
    delete process.env.AZURE_SORA_ENDPOINT;
    const tool = new AzureSora({
      AZURE_SORA_API_KEY: mockApiKey,
      AZURE_SORA_ENDPOINT: mockEndpoint,
    });
    expect(tool.apiKey).toBe(mockApiKey);
    expect(tool.endpoint).toBe(mockEndpoint);
  });

  it('should strip trailing slashes from the endpoint', () => {
    process.env.AZURE_SORA_ENDPOINT = `${mockEndpoint}/`;
    const tool = new AzureSora();
    expect(tool.endpoint).toBe(mockEndpoint);
  });

  it('should build job and content URLs with the configured API version', () => {
    process.env.AZURE_SORA_API_VERSION = '2025-05-01-preview';
    const tool = new AzureSora();
    expect(tool.getJobsUrl()).toBe(
      `${mockEndpoint}/openai/v1/video/generations/jobs?api-version=2025-05-01-preview`,
    );
    expect(tool.getJobsUrl('job_123')).toBe(
      `${mockEndpoint}/openai/v1/video/generations/jobs/job_123?api-version=2025-05-01-preview`,
    );
    expect(tool.getContentUrl('gen_456')).toBe(
      `${mockEndpoint}/openai/v1/video/generations/gen_456/content/video?api-version=2025-05-01-preview`,
    );
  });

  it('should replace unwanted characters in the prompt', () => {
    const tool = new AzureSora();
    expect(tool.replaceUnwantedChars('A "cat"\nplaying\r\npiano.')).toBe('A cat playing piano.');
  });

  it('should throw on an invalid size', async () => {
    const tool = new AzureSora();
    await expect(tool._call({ prompt: 'a cat', size: '512x512' })).rejects.toThrow(
      'Invalid size "512x512"',
    );
  });

  it('should throw on an out-of-range duration', async () => {
    const tool = new AzureSora();
    await expect(tool._call({ prompt: 'a cat', n_seconds: 45 })).rejects.toThrow(
      'Invalid n_seconds',
    );
  });

  it('should submit, poll, download, and return a video_url artifact for agents', async () => {
    process.env.AZURE_SORA_POLL_INTERVAL_MS = '1';
    const videoBytes = Buffer.from('fake-mp4-bytes');
    fetch
      .mockResolvedValueOnce(jsonResponse({ id: 'job_123', status: 'queued' }))
      .mockResolvedValueOnce(
        jsonResponse({ id: 'job_123', status: 'succeeded', generations: [{ id: 'gen_456' }] }),
      )
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: jest
          .fn()
          .mockResolvedValue(
            videoBytes.buffer.slice(
              videoBytes.byteOffset,
              videoBytes.byteOffset + videoBytes.byteLength,
            ),
          ),
      });

    const tool = new AzureSora();
    const [response, artifact] = await tool._call({ prompt: 'a cat playing piano' });

    const [submitUrl, submitInit] = fetch.mock.calls[0];
    expect(submitUrl).toBe(tool.getJobsUrl());
    expect(submitInit.method).toBe('POST');
    expect(submitInit.headers['api-key']).toBe(mockApiKey);
    const submittedBody = JSON.parse(submitInit.body);
    expect(submittedBody).toEqual({
      prompt: 'a cat playing piano',
      width: 1280,
      height: 720,
      n_seconds: 5,
      model: 'sora',
    });

    expect(fetch.mock.calls[1][0]).toBe(tool.getJobsUrl('job_123'));
    expect(fetch.mock.calls[2][0]).toBe(tool.getContentUrl('gen_456'));

    expect(response[0].type).toBe('text');
    expect(artifact.content).toHaveLength(1);
    expect(artifact.content[0].type).toBe('video_url');
    expect(artifact.content[0].video_url.url).toBe(
      `data:video/mp4;base64,${videoBytes.toString('base64')}`,
    );
    expect(artifact.file_ids).toHaveLength(1);
  });

  it('should keep polling through transient polling errors', async () => {
    process.env.AZURE_SORA_POLL_INTERVAL_MS = '1';
    const videoBytes = Buffer.from('fake-mp4-bytes');
    fetch
      .mockResolvedValueOnce(jsonResponse({ id: 'job_123', status: 'queued' }))
      .mockResolvedValueOnce(jsonResponse({}, false, 503))
      .mockResolvedValueOnce(jsonResponse({ id: 'job_123', status: 'running' }))
      .mockResolvedValueOnce(
        jsonResponse({ id: 'job_123', status: 'succeeded', generations: [{ id: 'gen_456' }] }),
      )
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: jest
          .fn()
          .mockResolvedValue(
            videoBytes.buffer.slice(
              videoBytes.byteOffset,
              videoBytes.byteOffset + videoBytes.byteLength,
            ),
          ),
      });

    const tool = new AzureSora();
    const [, artifact] = await tool._call({ prompt: 'a cat playing piano' });
    expect(artifact.content[0].type).toBe('video_url');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('should return the failure reason when the job fails', async () => {
    process.env.AZURE_SORA_POLL_INTERVAL_MS = '1';
    fetch
      .mockResolvedValueOnce(jsonResponse({ id: 'job_123', status: 'queued' }))
      .mockResolvedValueOnce(
        jsonResponse({ id: 'job_123', status: 'failed', failure_reason: 'content_filter' }),
      );

    const tool = new AzureSora();
    const [content] = await tool._call({ prompt: 'a cat playing piano' });
    expect(content).toContain('content_filter');
  });

  it('should return an error message when job submission fails', async () => {
    fetch.mockResolvedValueOnce(jsonResponse({ error: 'unauthorized' }, false, 401));

    const tool = new AzureSora();
    const [content] = await tool._call({ prompt: 'a cat playing piano' });
    expect(content).toContain('401');
    expect(logger.error).toHaveBeenCalled();
  });

  it('should time out when the job never reaches a terminal state', async () => {
    process.env.AZURE_SORA_POLL_INTERVAL_MS = '1';
    process.env.AZURE_SORA_POLL_TIMEOUT_MS = '20';
    fetch
      .mockResolvedValueOnce(jsonResponse({ id: 'job_123', status: 'queued' }))
      .mockResolvedValue(jsonResponse({ id: 'job_123', status: 'running' }));

    const tool = new AzureSora();
    const [content] = await tool._call({ prompt: 'a cat playing piano' });
    expect(content).toContain('Timed out');
  });

  it('should return an error message when no generations are returned', async () => {
    process.env.AZURE_SORA_POLL_INTERVAL_MS = '1';
    fetch
      .mockResolvedValueOnce(jsonResponse({ id: 'job_123', status: 'queued' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'job_123', status: 'succeeded', generations: [] }));

    const tool = new AzureSora();
    const [content] = await tool._call({ prompt: 'a cat playing piano' });
    expect(content).toContain('no generations');
  });

  it('should save the video and return a markdown link outside agents', async () => {
    process.env.AZURE_SORA_POLL_INTERVAL_MS = '1';
    const videoBytes = Buffer.from('fake-mp4-bytes');
    fetch
      .mockResolvedValueOnce(jsonResponse({ id: 'job_123', status: 'queued' }))
      .mockResolvedValueOnce(
        jsonResponse({ id: 'job_123', status: 'succeeded', generations: [{ id: 'gen_456' }] }),
      )
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: jest
          .fn()
          .mockResolvedValue(
            videoBytes.buffer.slice(
              videoBytes.byteOffset,
              videoBytes.byteOffset + videoBytes.byteLength,
            ),
          ),
      });
    saveBase64Video.mockResolvedValueOnce({ filepath: '/videos/mock.mp4' });

    const tool = new AzureSora({ isAgent: false, saveBase64Video });
    const result = await tool._call({ prompt: 'a cat playing piano' });

    expect(saveBase64Video).toHaveBeenCalledWith(
      `data:video/mp4;base64,${videoBytes.toString('base64')}`,
      expect.objectContaining({ context: 'video_generation' }),
    );
    expect(result).toBe('[Generated video](/videos/mock.mp4)');
  });

  it('should return an error message when saving the video fails', async () => {
    process.env.AZURE_SORA_POLL_INTERVAL_MS = '1';
    const videoBytes = Buffer.from('fake-mp4-bytes');
    fetch
      .mockResolvedValueOnce(jsonResponse({ id: 'job_123', status: 'queued' }))
      .mockResolvedValueOnce(
        jsonResponse({ id: 'job_123', status: 'succeeded', generations: [{ id: 'gen_456' }] }),
      )
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: jest
          .fn()
          .mockResolvedValue(
            videoBytes.buffer.slice(
              videoBytes.byteOffset,
              videoBytes.byteOffset + videoBytes.byteLength,
            ),
          ),
      });
    saveBase64Video.mockRejectedValueOnce(new Error('storage unavailable'));

    const tool = new AzureSora({ isAgent: false, saveBase64Video });
    const result = await tool._call({ prompt: 'a cat playing piano' });
    expect(result).toContain('Failed to save the generated video.');
  });
});
