const axios = require('axios');
const OpenAI = require('openai');
const FormData = require('form-data');
const { Readable } = require('stream');
const createOpenAIImageTools = require('~/app/clients/tools/structured/OpenAIImageTools');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');

jest.mock('axios');
jest.mock('openai');
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
    image_gen_oai: {
      name: 'image_gen_oai',
      description: 'Generate an image',
      schema: {},
    },
    image_edit_oai: {
      name: 'image_edit_oai',
      description: 'Edit an image',
      schema: {},
    },
  },
  extractBaseURL: jest.fn((url) => url),
  getProxyDispatcher: jest.fn(() => undefined),
  applyAxiosProxyConfig: jest.fn(),
  getImageGenClientOptions: jest.requireActual('@librechat/api').getImageGenClientOptions,
}));

jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(),
}));

jest.mock('~/models', () => ({
  getFiles: jest.fn().mockResolvedValue([]),
}));

describe('OpenAIImageTools - IMAGE_GEN_OAI_MODEL environment variable', () => {
  let originalEnv;

  beforeEach(() => {
    jest.clearAllMocks();
    originalEnv = { ...process.env };

    process.env.IMAGE_GEN_OAI_API_KEY = 'test-api-key';
    delete process.env.IMAGE_GEN_OAI_MODEL;
    delete process.env.IMAGE_GEN_OAI_BASEURL;
    delete process.env.IMAGE_GEN_OAI_AZURE_API_VERSION;

    axios.post.mockResolvedValue({
      data: { data: [{ b64_json: 'base64-encoded-image-data' }] },
    });
    getStrategyFunctions.mockReturnValue({
      getDownloadStream: jest.fn(async () => Readable.from([Buffer.from('image-data')])),
    });

    OpenAI.mockImplementation(() => ({
      images: {
        generate: jest.fn().mockResolvedValue({
          data: [
            {
              b64_json: 'base64-encoded-image-data',
            },
          ],
        }),
      },
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = originalEnv;
  });

  const createTools = () =>
    createOpenAIImageTools({
      isAgent: true,
      override: false,
      req: { user: { id: 'test-user' } },
      imageFiles: [
        {
          file_id: 'source-image',
          source: 'local',
          filepath: 'source-image.png',
          filename: 'source-image.png',
          type: 'image/png',
        },
      ],
    });

  it.each([undefined, ''])('defaults generation when IMAGE_GEN_OAI_MODEL=%j', async (model) => {
    if (model !== undefined) {
      process.env.IMAGE_GEN_OAI_MODEL = model;
    }

    const [imageGenTool] = createOpenAIImageTools({
      isAgent: true,
      override: false,
      req: { user: { id: 'test-user' } },
    });

    const mockGenerate = jest.fn().mockResolvedValue({
      data: [
        {
          b64_json: 'base64-encoded-image-data',
        },
      ],
    });

    OpenAI.mockImplementation(() => ({
      images: {
        generate: mockGenerate,
      },
    }));

    await imageGenTool.func({ prompt: 'test prompt' });

    expect(mockGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-image-2.5-flare',
      }),
      expect.any(Object),
    );
  });

  it.each(['gpt-image-1', 'gpt-image-1.5', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', ' '])(
    'should preserve the configured generation model %j',
    async (model) => {
      process.env.IMAGE_GEN_OAI_MODEL = model;

      const mockGenerate = jest.fn().mockResolvedValue({
        data: [
          {
            b64_json: 'base64-encoded-image-data',
          },
        ],
      });

      OpenAI.mockImplementation(() => ({
        images: {
          generate: mockGenerate,
        },
      }));

      const [imageGenTool] = createOpenAIImageTools({
        isAgent: true,
        override: false,
        req: { user: { id: 'test-user' } },
      });

      await imageGenTool.func({ prompt: 'test prompt' });

      expect(mockGenerate).toHaveBeenCalledWith(
        expect.objectContaining({
          model,
        }),
        expect.any(Object),
      );
    },
  );

  it('should use custom model name from IMAGE_GEN_OAI_MODEL environment variable', async () => {
    process.env.IMAGE_GEN_OAI_MODEL = 'custom-image-model';

    const mockGenerate = jest.fn().mockResolvedValue({
      data: [
        {
          b64_json: 'base64-encoded-image-data',
        },
      ],
    });

    OpenAI.mockImplementation(() => ({
      images: {
        generate: mockGenerate,
      },
    }));

    const [imageGenTool] = createOpenAIImageTools({
      isAgent: true,
      override: false,
      req: { user: { id: 'test-user' } },
    });

    await imageGenTool.func({ prompt: 'test prompt' });

    expect(mockGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'custom-image-model',
      }),
      expect.any(Object),
    );
  });

  it.each([
    [undefined, 'gpt-image-2.5-flare'],
    ['', 'gpt-image-2.5-flare'],
    ['gpt-image-1', 'gpt-image-1'],
    ['gpt-image-1.5', 'gpt-image-1.5'],
    ['gpt-image-2.5-flare', 'gpt-image-2.5-flare'],
    ['gpt-image-2.5-sunburst', 'gpt-image-2.5-sunburst'],
    ['custom-image-model', 'custom-image-model'],
    [' ', ' '],
  ])('preserves the editing model for IMAGE_GEN_OAI_MODEL=%j', async (model, expectedModel) => {
    if (model !== undefined) {
      process.env.IMAGE_GEN_OAI_MODEL = model;
    }
    const append = jest.spyOn(FormData.prototype, 'append');
    const [, imageEditTool] = createTools();

    await imageEditTool.func({ prompt: 'test prompt', image_ids: ['source-image'] });

    expect(append).toHaveBeenCalledWith('model', expectedModel);
    expect(axios.post).toHaveBeenCalledWith(
      '/images/edits',
      expect.any(FormData),
      expect.any(Object),
    );
  });

  it('should preserve the configured Azure deployment for generation and editing', async () => {
    const model = 'azure-image-deployment';
    const baseURL = 'https://azure.test/openai/deployments/azure-image-deployment';
    const apiVersion = '2025-04-01-preview';
    process.env.IMAGE_GEN_OAI_MODEL = model;
    process.env.IMAGE_GEN_OAI_BASEURL = baseURL;
    process.env.IMAGE_GEN_OAI_AZURE_API_VERSION = apiVersion;

    const mockGenerate = jest.fn().mockResolvedValue({
      data: [{ b64_json: 'base64-encoded-image-data' }],
    });
    OpenAI.mockImplementation(() => ({ images: { generate: mockGenerate } }));
    const append = jest.spyOn(FormData.prototype, 'append');
    const [imageGenTool, imageEditTool] = createTools();

    await imageGenTool.func({ prompt: 'test prompt' });
    await imageEditTool.func({ prompt: 'test prompt', image_ids: ['source-image'] });

    expect(mockGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ model }),
      expect.any(Object),
    );
    expect(OpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL,
        defaultQuery: { 'api-version': apiVersion },
      }),
    );
    expect(append).toHaveBeenCalledWith('model', model);
    expect(axios.post).toHaveBeenCalledWith(
      '/images/edits',
      expect.any(FormData),
      expect.objectContaining({
        baseURL,
        params: { 'api-version': apiVersion },
        headers: expect.objectContaining({ 'api-key': 'test-api-key' }),
      }),
    );
  });
});

describe('OpenAIImageTools - client timeout and retries', () => {
  let originalEnv;

  beforeEach(() => {
    jest.clearAllMocks();
    originalEnv = { ...process.env };

    process.env.IMAGE_GEN_OAI_API_KEY = 'test-api-key';
    delete process.env.IMAGE_GEN_OAI_MAX_RETRIES;

    OpenAI.mockImplementation(() => ({
      images: {
        generate: jest.fn().mockResolvedValue({
          data: [{ b64_json: 'base64-encoded-image-data' }],
        }),
      },
    }));
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const generate = async (config) => {
    const [imageGenTool] = createOpenAIImageTools({
      isAgent: true,
      override: false,
      req: { user: { id: 'test-user' }, config },
    });
    await imageGenTool.func({ prompt: 'test prompt' });
    return OpenAI.mock.calls[0][0];
  };

  it('should pass timeouts.imageGenMs and IMAGE_GEN_OAI_MAX_RETRIES to the OpenAI client', async () => {
    process.env.IMAGE_GEN_OAI_MAX_RETRIES = '0';

    const clientConfig = await generate({ timeouts: { imageGenMs: 1800000 } });

    expect(clientConfig).toMatchObject({
      timeout: 1800000,
      maxRetries: 0,
      fetchOptions: { dispatcher: expect.anything() },
    });
  });

  it('should use the default budget and client retries when unset', async () => {
    const clientConfig = await generate(undefined);

    expect(clientConfig.timeout).toBe(600000);
    expect(clientConfig).not.toHaveProperty('maxRetries');
  });
});
