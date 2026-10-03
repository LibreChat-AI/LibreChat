const axios = require('axios');
const AzureSoraTool = require('~/app/clients/tools/structured/AzureSora');

const mockResolveAzureSoraCredentials = jest.fn();
const mockValidateAzureSoraEndpoint = jest.fn();
const mockCreateAzureSoraRequestConfig = jest.fn();

jest.mock('axios');
jest.mock('@librechat/data-schemas', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('@librechat/api', () => ({
  logAxiosError: jest.fn(),
  resolveAzureSoraCredentials: (...args) => mockResolveAzureSoraCredentials(...args),
  validateAzureSoraEndpoint: (...args) => mockValidateAzureSoraEndpoint(...args),
  createAzureSoraRequestConfig: (...args) => mockCreateAzureSoraRequestConfig(...args),
}));

process.env.AZURE_SORA_POLL_INTERVAL_MS = '10';
jest.setTimeout(20000);

describe('AzureSora Video Generation Tool', () => {
  const baseFields = {
    userId: 'user-1',
    userAuthValues: {
      AZURE_SORA_API_KEY: 'test-key',
      AZURE_SORA_ENDPOINT: 'https://test-resource.openai.azure.com',
    },
    uploadImageBuffer: jest.fn(),
  };

  const processFileDefaults = () => {
    baseFields.uploadImageBuffer.mockResolvedValue({
      file_id: 'file-1',
      filepath: '/files/vid-job-1.mp4',
    });
  };

  const buildTool = (overrides = {}) => new AzureSoraTool({ ...baseFields, ...overrides });

  beforeEach(() => {
    jest.clearAllMocks();
    axios.post.mockReset();
    axios.get.mockReset();
    mockResolveAzureSoraCredentials.mockImplementation((fields) => ({
      apiKey: fields.AZURE_SORA_API_KEY || '',
      endpoint: fields.AZURE_SORA_ENDPOINT || '',
    }));
    mockValidateAzureSoraEndpoint.mockImplementation(async (endpoint) => new URL(endpoint).origin);
    mockCreateAzureSoraRequestConfig.mockImplementation((_url, config) => ({
      ...config,
      maxRedirects: 0,
      proxy: false,
    }));
    processFileDefaults();
  });

  test('generates a video end-to-end and persists the buffer safely', async () => {
    const tool = buildTool();

    axios.post.mockResolvedValueOnce({ data: { id: 'job-1', status: 'queued' } });
    axios.get
      .mockResolvedValueOnce({ data: { id: 'job-1', status: 'running' } })
      .mockResolvedValueOnce({ data: { id: 'job-1', status: 'succeeded' } })
      .mockResolvedValueOnce({
        data: new Uint8Array([1, 2, 3, 4]).buffer,
      });

    const [textResponse, artifact] = await tool._call({
      prompt: 'a drone shot over a coastline at sunset',
    });

    const submitUrl = axios.post.mock.calls[0][0];
    expect(submitUrl).toBe(
      'https://test-resource.openai.azure.com/openai/v1/video/generations/jobs?api-version=preview',
    );
    expect(axios.post.mock.calls[0][1]).toMatchObject({
      model: 'sora',
      prompt: 'a drone shot over a coastline at sunset',
      size: '1280x720',
      seconds: '4',
    });
    expect(axios.post.mock.calls[0][2]).toMatchObject({
      headers: { 'api-key': 'test-key' },
      maxRedirects: 0,
      proxy: false,
    });
    expect(mockResolveAzureSoraCredentials).toHaveBeenCalledWith(
      baseFields.userAuthValues,
      process.env,
    );
    expect(mockValidateAzureSoraEndpoint).toHaveBeenCalledWith(
      'https://test-resource.openai.azure.com',
    );
    expect(mockCreateAzureSoraRequestConfig).toHaveBeenCalledTimes(4);
    for (const [url, config] of mockCreateAzureSoraRequestConfig.mock.calls) {
      expect(url).toContain('https://test-resource.openai.azure.com/');
      expect(config.maxRedirects).toBeUndefined();
    }

    expect(baseFields.uploadImageBuffer).toHaveBeenCalledWith(
      expect.objectContaining({
        context: 'video_generation',
        resize: false,
        metadata: expect.objectContaining({
          buffer: Buffer.from([1, 2, 3, 4]),
          bytes: 4,
          filename: 'vid-job-1.mp4',
          type: 'video/mp4',
          file_id: expect.any(String),
        }),
      }),
    );
    expect(baseFields.uploadImageBuffer.mock.calls[0][0]).not.toHaveProperty('URL');
    expect(textResponse[0].type).toBe('text');
    expect(artifact.content[0].type).toBe('video_url');
    expect(artifact.content[0].video_url.url).toBe('/files/vid-job-1.mp4');
    expect(artifact.file_ids).toEqual(['file-1']);
  });

  test('throws a descriptive error when the job fails', async () => {
    const tool = buildTool();

    axios.post.mockResolvedValueOnce({ data: { id: 'job-2' } });
    axios.get.mockResolvedValueOnce({
      data: { id: 'job-2', status: 'failed', error: { message: 'content policy' } },
    });

    await expect(tool._call({ prompt: 'bad prompt' })).rejects.toThrow(
      'Azure Sora generation failed: content policy',
    );
  });

  test('throws when credentials are not configured', async () => {
    const tool = new AzureSoraTool({
      userId: 'user-1',
      userAuthValues: {
        AZURE_SORA_API_KEY: '',
        AZURE_SORA_ENDPOINT: '',
      },
    });

    await expect(tool._call({ prompt: 'test' })).rejects.toThrow(/Azure Sora is not configured/);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('rejects an unsafe endpoint before any request carries the key', async () => {
    mockValidateAzureSoraEndpoint.mockRejectedValueOnce(
      new Error('Invalid Azure Sora endpoint: the host is not an approved Azure OpenAI host'),
    );
    const tool = buildTool();

    await expect(tool._call({ prompt: 'test prompt' })).rejects.toThrow(
      'not an approved Azure OpenAI host',
    );
    expect(axios.post).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('fails immediately when polling is redirected', async () => {
    const tool = buildTool();
    const redirectError = Object.assign(new Error('redirect blocked'), {
      response: { status: 302 },
    });

    axios.post.mockResolvedValueOnce({ data: { id: 'job-3' } });
    axios.get.mockRejectedValueOnce(redirectError);

    await expect(tool._call({ prompt: 'test prompt' })).rejects.toThrow('redirect blocked');
  });

  test('fails immediately when connect-time SSRF protection blocks polling', async () => {
    const tool = buildTool();
    const ssrfError = Object.assign(new Error('SSRF protection blocked DNS rebinding'), {
      code: 'ESSRF',
    });

    axios.post.mockResolvedValueOnce({ data: { id: 'job-4' } });
    axios.get.mockRejectedValueOnce(ssrfError);

    await expect(tool._call({ prompt: 'test prompt' })).rejects.toThrow(
      'SSRF protection blocked DNS rebinding',
    );
  });

  test('throws when the submission endpoint is unreachable', async () => {
    const tool = buildTool();

    axios.post.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(tool._call({ prompt: 'test prompt' })).rejects.toThrow(
      /Failed to submit the video generation job/,
    );
  });
});
