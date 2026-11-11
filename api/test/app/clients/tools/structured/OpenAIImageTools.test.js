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
  formatToolError: jest.requireActual('@librechat/api').formatToolError,
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

  it.each([
    'gpt-image-1',
    'gpt-image-1.5',
    'gpt-image-2',
    'gpt-image-2.5-flare',
    'gpt-image-2.5-sunburst',
    'gpt-image-2.6-sunburst',
    'gpt-image-2.6-flare',
    ' ',
  ])('should preserve the configured generation model %j', async (model) => {
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
  });

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
    ['gpt-image-2', 'gpt-image-2'],
    ['gpt-image-2.5-flare', 'gpt-image-2.5-flare'],
    ['gpt-image-2.5-sunburst', 'gpt-image-2.5-sunburst'],
    ['gpt-image-2.6-sunburst', 'gpt-image-2.6-sunburst'],
    ['gpt-image-2.6-flare', 'gpt-image-2.6-flare'],
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

  describe.each([
    [undefined, 'gpt-image-2.5-flare'],
    ['', 'gpt-image-2.5-flare'],
    ['gpt-image-2.5-flare', 'gpt-image-2.5-flare'],
    ['gpt-image-2.5-flare-2026-09-08', 'gpt-image-2.5-flare-2026-09-08'],
    ['gpt-image-2.5-sunburst', 'gpt-image-2.5-sunburst'],
    ['gpt-image-2.5-sunburst-2026-09-08', 'gpt-image-2.5-sunburst-2026-09-08'],
    ['gpt-image-2.6-sunburst', 'gpt-image-2.6-sunburst'],
    ['gpt-image-2.6-flare', 'gpt-image-2.6-flare'],
  ])('quality forwarding for IMAGE_GEN_OAI_MODEL=%j', (model, expectedModel) => {
    it.each(['low', 'medium', 'high', 'xhigh', 'max'])(
      'passes quality %s to generations and edits',
      async (quality) => {
        if (model !== undefined) {
          process.env.IMAGE_GEN_OAI_MODEL = model;
        }
        const generate = jest.fn().mockResolvedValue({
          data: [{ b64_json: 'base64-encoded-image-data' }],
        });
        OpenAI.mockImplementation(() => ({ images: { generate } }));
        const append = jest.spyOn(FormData.prototype, 'append');
        const [imageGenTool, imageEditTool] = createTools();

        const [, generation] = await imageGenTool.func({ prompt: 'test prompt', quality });
        const [, edit] = await imageEditTool.func({
          prompt: 'test prompt',
          image_ids: ['source-image'],
          quality,
        });

        expect(generate).toHaveBeenCalledWith(
          expect.objectContaining({ model: expectedModel, quality, size: 'auto' }),
          expect.any(Object),
        );
        expect(append).toHaveBeenCalledWith('model', expectedModel);
        expect(append).toHaveBeenCalledWith('quality', quality);
        expect(axios.post).toHaveBeenCalledWith(
          '/images/edits',
          expect.any(FormData),
          expect.any(Object),
        );
        for (const artifact of [generation, edit]) {
          expect(artifact.content[0].image_url.url).toBe(
            'data:image/png;base64,base64-encoded-image-data',
          );
          expect(artifact.file_ids).toHaveLength(1);
        }
      },
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

describe('OpenAIImageTools - approved error text', () => {
  const { logger } = require('@librechat/data-schemas');
  const { logAxiosError } = require('@librechat/api');
  const SECRET = 'PRIVATE-PROVIDER-DETAIL';
  const FALLBACK = 'Error: The tool request failed.';
  let originalEnv;

  const providerError = (status) =>
    Object.assign(new Error(`${status} ${SECRET}`), {
      status,
      response: { status, data: { error: { message: SECRET } } },
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

  const failGeneration = (error) =>
    OpenAI.mockImplementation(() => ({
      images: { generate: jest.fn().mockRejectedValue(error) },
    }));

  /** True when any logged argument, including an error message, carries the text. */
  const logged = (text) =>
    [logger.warn, logger.error, logger.debug, logAxiosError]
      .flatMap((method) => method.mock.calls.flat())
      .some((arg) => `${arg instanceof Error ? arg.message : JSON.stringify(arg)}`.includes(text));

  beforeEach(() => {
    jest.clearAllMocks();
    originalEnv = { ...process.env };
    process.env.IMAGE_GEN_OAI_API_KEY = 'test-api-key';
    delete process.env.IMAGE_GEN_OAI_BASEURL;
    delete process.env.IMAGE_GEN_OAI_AZURE_API_VERSION;
    getStrategyFunctions.mockReturnValue({
      getDownloadStream: jest.fn(async () => Readable.from([Buffer.from('image-data')])),
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('words a failing generation from its status, never the provider message', async () => {
    failGeneration(providerError(400));
    const [imageGenTool] = createTools();

    const [text] = await imageGenTool.func({ prompt: 'test prompt' });

    expect(text).toBe(
      'Error: OpenAI image generation rejected the request parameters; check them and try again (status 400).',
    );
    expect(logger.warn).toHaveBeenCalledWith('[OpenAI image generation] Tool request failed', {
      status: 400,
    });
    expect(logged(SECRET)).toBe(false);
  });

  it('returns the stable fallback for a generation failure without a status', async () => {
    failGeneration(new Error(`connect ECONNREFUSED ${SECRET}`));
    const [imageGenTool] = createTools();

    const [text] = await imageGenTool.func({ prompt: 'test prompt' });

    expect(text).toBe(FALLBACK);
    expect(logged(SECRET)).toBe(false);
  });

  it('words a failing edit from its status, never the provider message', async () => {
    axios.post.mockRejectedValue(providerError(401));
    const [, imageEditTool] = createTools();

    const [text] = await imageEditTool.func({ prompt: 'test prompt', image_ids: ['source-image'] });

    expect(text).toBe(
      'Error: OpenAI image editing rejected the configured credentials (status 401).',
    );
    expect(logged(SECRET)).toBe(false);
  });

  it('returns the stable fallback for an edit failure without a status', async () => {
    axios.post.mockRejectedValue(new Error(`socket hang up ${SECRET}`));
    const [, imageEditTool] = createTools();

    const [text] = await imageEditTool.func({ prompt: 'test prompt', image_ids: ['source-image'] });

    expect(text).toBe(FALLBACK);
    expect(logged(SECRET)).toBe(false);
  });
});
