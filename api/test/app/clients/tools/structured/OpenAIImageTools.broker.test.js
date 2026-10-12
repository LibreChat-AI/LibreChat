const OpenAI = require('openai');
const createOpenAIImageTools = require('~/app/clients/tools/structured/OpenAIImageTools');

jest.mock('openai');
jest.mock('@librechat/data-schemas', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(),
}));

jest.mock('~/models', () => ({
  getFiles: jest.fn().mockResolvedValue([]),
}));

/**
 * `@librechat/api` is deliberately left unmocked: this suite exists to prove the
 * tool is wired to the real `brokerUserHeaders`, which a stub would hide.
 */
describe('OpenAIImageTools - Tchat broker identity', () => {
  const req = {
    user: { id: 'lc-user-1', email: 'chat-user@example.com', openidId: 'sub-42' },
  };
  let originalEnv;

  const mockGeneration = () => {
    const generate = jest.fn().mockResolvedValue({ data: [{ b64_json: 'base64-image-data' }] });
    OpenAI.mockImplementation(() => ({ images: { generate } }));
    return generate;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    originalEnv = { ...process.env };
    process.env.IMAGE_GEN_OAI_API_KEY = 'broker-shared-key';
    process.env.TCHAT_BROKER_BASE_URL = 'http://tchat-broker:8081/v1';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('identifies the signed-in user when generation is routed through the broker', async () => {
    process.env.IMAGE_GEN_OAI_BASEURL = 'http://tchat-broker:8081/v1';
    mockGeneration();

    const [imageGenTool] = createOpenAIImageTools({ isAgent: true, override: false, req });
    await imageGenTool.func({ prompt: 'a teal grid' });

    expect(OpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultHeaders: {
          'X-Tchat-User-Id': 'lc-user-1',
          'X-Tchat-User-Email': 'chat-user@example.com',
          'X-Tchat-User-Openid': 'sub-42',
        },
      }),
    );
  });

  it('sends no user identity to a provider that is not the broker', async () => {
    delete process.env.IMAGE_GEN_OAI_BASEURL;
    mockGeneration();

    const [imageGenTool] = createOpenAIImageTools({ isAgent: true, override: false, req });
    await imageGenTool.func({ prompt: 'a teal grid' });

    const [config] = OpenAI.mock.calls[0];
    expect(config.defaultHeaders).toBeUndefined();
  });

  /** Tchat image options: the real `applyImageChoice`/`imageToolSchema` decide what is sent. */
  describe('image options', () => {
    const imageSpec = {
      name: 'gpt-image-2-hd',
      label: 'HD',
      model: 'gpt-image-2-h',
      protocol: 'openai',
      options: { sizes: ['1024x1024', '1536x1024'] },
    };

    it("sends the user's pinned size over the chat model's, and no unhonoured fields", async () => {
      process.env.IMAGE_GEN_OAI_BASEURL = 'http://tchat-broker:8081/v1';
      const generate = mockGeneration();
      const [imageGenTool] = createOpenAIImageTools({
        isAgent: true,
        override: false,
        req,
        imageSpec,
        imageChoice: { size: '1536x1024' },
      });

      expect(Object.keys(imageGenTool.schema.properties ?? {})).toEqual(['prompt']);
      await imageGenTool.func({ prompt: 'a teal grid', size: '1024x1024', quality: 'high' });

      const [body] = generate.mock.calls[0];
      expect(body.size).toBe('1536x1024');
      expect(body.quality).toBe('auto');
      expect(body.background).toBe('auto');
    });

    it('drops a size the model does not list', async () => {
      process.env.IMAGE_GEN_OAI_BASEURL = 'http://tchat-broker:8081/v1';
      const generate = mockGeneration();
      const [imageGenTool] = createOpenAIImageTools({
        isAgent: true,
        override: false,
        req,
        imageSpec,
      });

      await imageGenTool.func({ prompt: 'a teal grid', size: '3840x2160' });

      expect(generate.mock.calls[0][0].size).toBe('auto');
    });
  });
});
