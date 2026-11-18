const { GoogleGenAI } = require('@google/genai');
const { logger } = require('@librechat/data-schemas');
const createGeminiImageTool = require('../GeminiImageGen');

jest.mock('@google/genai', () => ({ GoogleGenAI: jest.fn() }));
jest.mock('~/server/services/Files/strategies', () => ({ getStrategyFunctions: jest.fn() }));
jest.mock('~/models', () => ({
  spendTokens: jest.fn(),
  getFiles: jest.fn().mockResolvedValue([]),
}));

const SECRET = 'PRIVATE-PROVIDER-DETAIL';
const FALLBACK = 'Error: The tool request failed.';
const EMPTY_ARTIFACT = { content: [], file_ids: [] };

const providerError = (status) =>
  Object.assign(new Error(JSON.stringify({ error: { code: status, message: SECRET } })), {
    status,
  });

const failGeneration = (error) =>
  GoogleGenAI.mockImplementation(() => ({
    models: { generateContent: jest.fn().mockRejectedValue(error) },
  }));

const createTool = (fields = {}) =>
  createGeminiImageTool({
    isAgent: true,
    req: { user: { id: 'user-1' } },
    userId: 'user-1',
    GEMINI_API_KEY: 'gemini-key',
    ...fields,
  });

const run = async (tool) => {
  const [content, artifact] = await tool.func({ prompt: 'a cat' });
  return { text: content.map((part) => part.text).join('\n'), artifact };
};

/** True when any logged argument, including an error message, carries the text. */
const logged = (text) =>
  [logger.warn, logger.error, logger.info, logger.debug]
    .flatMap((method) => method.mock.calls.flat())
    .some((arg) => `${arg instanceof Error ? arg.message : JSON.stringify(arg)}`.includes(text));

describe('GeminiImageGen approved error text', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    jest.restoreAllMocks();
    for (const method of ['warn', 'error', 'info', 'debug']) {
      jest.spyOn(logger, method).mockImplementation(() => logger);
    }
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('words a failing generation from its status, never the provider message', async () => {
    failGeneration(providerError(403));

    const { text, artifact } = await run(createTool());

    expect(text).toBe(
      'Error: Gemini image generation rejected the configured credentials (status 403).',
    );
    expect(artifact).toEqual(EMPTY_ARTIFACT);
    expect(logger.warn).toHaveBeenCalledWith('[Gemini image generation] Tool request failed', {
      status: 403,
    });
    expect(logged(SECRET)).toBe(false);
  });

  it('returns the stable fallback for a generation failure without a status', async () => {
    failGeneration(new Error(`socket hang up ${SECRET}`));

    const { text, artifact } = await run(createTool());

    expect(text).toBe(FALLBACK);
    expect(artifact).toEqual(EMPTY_ARTIFACT);
    expect(logged(SECRET)).toBe(false);
  });

  it('returns the stable fallback when the client cannot be created', async () => {
    GoogleGenAI.mockImplementation(() => {
      throw new Error(`invalid credentials ${SECRET}`);
    });

    const { text, artifact } = await run(createTool());

    expect(text).toBe(FALLBACK);
    expect(artifact).toEqual(EMPTY_ARTIFACT);
    expect(logged(SECRET)).toBe(false);
  });

  it('keeps its configuration guidance without naming the service account path', async () => {
    process.env.GOOGLE_SERVICE_KEY_FILE = `/missing/${SECRET}/auth.json`;

    const { text } = await run(createTool({ GEMINI_API_KEY: undefined, GOOGLE_KEY: undefined }));

    expect(text).toBe(
      'Error: Gemini Image Generation requires one of: user-provided API key, GEMINI_API_KEY or GOOGLE_KEY env var, or a valid Google service account.',
    );
    expect(text).not.toContain('/missing/');
    expect(GoogleGenAI).not.toHaveBeenCalled();
  });
});
