const axios = require('axios');
const createAzureSoraTools = require('~/app/clients/tools/structured/AzureSora');

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
  oaiToolkit: {
    video_gen_sora_azure: {
      name: 'video_gen_sora_azure',
      description: 'Azure Sora',
      schema: {},
      responseFormat: 'content_and_artifact',
    },
  },
}));

describe('AzureSora Video Generation Tool', () => {
  let originalEnv;
  let mockProcessFileURL;

  beforeEach(() => {
    jest.clearAllMocks();
    originalEnv = { ...process.env };
    process.env.AZURE_SORA_API_KEY = 'test-key';
    process.env.AZURE_SORA_ENDPOINT = 'https://test-resource.openai.azure.com';

    mockProcessFileURL = jest.fn().mockResolvedValue({
      file_id: 'test-file-id',
      filepath: '/images/vid-test.mp4',
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should fail if prompt is missing', async () => {
    const [soraTool] = createAzureSoraTools({
      userId: 'user123',
      processFileURL: mockProcessFileURL,
    });

    await expect(soraTool.func({})).rejects.toThrow('Missing required field: prompt');
  });

  it('should fail if credentials are not configured', async () => {
    delete process.env.AZURE_SORA_API_KEY;
    delete process.env.AZURE_API_KEY;

    const [soraTool] = createAzureSoraTools({
      userId: 'user123',
      processFileURL: mockProcessFileURL,
    });

    await expect(soraTool.func({ prompt: 'test' })).rejects.toThrow(
      'Azure Sora credentials (API Key or Endpoint) are not configured.'
    );
  });

  it('should successfully submit and poll for video generation', async () => {
    axios.post.mockResolvedValueOnce({
      headers: {
        'operation-location': 'https://test-resource.openai.azure.com/operations/job123',
      },
      data: {
        id: 'job123',
      },
    });

    axios.get.mockResolvedValueOnce({
      data: {
        status: 'running',
      },
    });

    axios.get.mockResolvedValueOnce({
      data: {
        status: 'succeeded',
        output: {
          video_url: 'https://test-resource.openai.azure.com/content/video123.mp4',
        },
      },
    });

    const [soraTool] = createAzureSoraTools({
      userId: 'user123',
      processFileURL: mockProcessFileURL,
      fileStrategy: 'local',
    });

    const originalTimeout = global.setTimeout;
    global.setTimeout = jest.fn((cb) => cb());

    const result = await soraTool.func({ prompt: 'cinematic rocket landing on Mars' });

    expect(axios.post).toHaveBeenCalled();
    expect(axios.get).toHaveBeenCalledTimes(2);
    expect(mockProcessFileURL).toHaveBeenCalledWith(
      expect.objectContaining({
        URL: 'https://test-resource.openai.azure.com/content/video123.mp4',
        fileName: expect.stringMatching(/^vid-.*\.mp4$/),
      })
    );

    expect(result).toEqual([
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining('generated_video_id: "test-file-id"'),
        }),
      ]),
      expect.objectContaining({
        file_ids: ['test-file-id'],
      }),
    ]);

    global.setTimeout = originalTimeout;
  });
});
