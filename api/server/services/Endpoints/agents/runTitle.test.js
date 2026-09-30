const mockGetProviderConfig = jest.fn();
const mockResolveConfigHeaders = jest.fn();

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  getProviderConfig: (...args) => mockGetProviderConfig(...args),
  resolveConfigHeaders: (...args) => mockResolveConfigHeaders(...args),
  sanitizeTitle: (title) => title,
  getBalanceConfig: jest.fn(() => ({ enabled: false })),
  getTransactionsConfig: jest.fn(() => ({})),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('~/models', () => ({
  getUserKey: jest.fn(),
  getUserKeyValues: jest.fn(),
}));

const { generateRunTitle } = require('./runTitle');

const makeProviderConfig = ({ provider = 'openai' } = {}) => ({
  overrideProvider: undefined,
  customEndpointConfig: undefined,
  /** Mirrors the real provider config: the caller's `model_parameters` (already
   *  carrying the `titleModel` override when set) flows into `llmConfig`. */
  getOptions: jest.fn(async ({ model_parameters }) => ({
    provider,
    llmConfig: { ...model_parameters, apiKey: 'sk-test' },
  })),
});

const makeRun = () => ({
  generateTitle: jest.fn().mockResolvedValue({ title: 'Generated Title' }),
});

const makeReq = (endpointConfig = {}) => ({
  user: { id: 'user-1' },
  body: {},
  config: { endpoints: { openAI: endpointConfig } },
});

const makeAgent = () => ({
  endpoint: 'openAI',
  provider: 'openAI',
  model: 'agent-model',
  model_parameters: { model: 'agent-model' },
});

describe('generateRunTitle (shared run-based title generation)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetProviderConfig.mockImplementation(() => makeProviderConfig());
  });

  it('calls run.generateTitle with the resolved provider and returns the sanitized title', async () => {
    const run = makeRun();
    const abortController = new AbortController();

    const title = await generateRunTitle({
      req: makeReq(),
      agent: makeAgent(),
      run,
      text: 'Hello there',
      contentParts: [{ type: 'text', text: 'Full response' }],
      conversationId: 'convo-1',
      responseMessageId: 'resp-1',
      parentMessageId: null,
      userId: 'user-1',
      abortController,
    });

    expect(title).toBe('Generated Title');
    expect(run.generateTitle).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai',
        inputText: 'Hello there',
        contentParts: [{ type: 'text', text: 'Full response' }],
        titleMethod: undefined,
        titlePrompt: undefined,
        titlePromptTemplate: undefined,
      }),
    );
    const call = run.generateTitle.mock.calls[0][0];
    expect(call.clientOptions.model).toBe('agent-model');
    expect(call.chainOptions.configurable).toEqual({ thread_id: 'convo-1', user_id: 'user-1' });
    expect(call.chainOptions.signal).toBe(abortController.signal);
  });

  it('honors titleModel, titleMethod, titlePrompt, and titlePromptTemplate from the endpoint config', async () => {
    const run = makeRun();

    await generateRunTitle({
      req: makeReq({
        titleModel: 'gpt-3.5-turbo',
        titleMethod: 'structured',
        titlePrompt: 'Custom title prompt',
        titlePromptTemplate: 'Template: {{content}}',
      }),
      agent: makeAgent(),
      run,
      text: 'Hello there',
      conversationId: 'convo-1',
      abortController: new AbortController(),
    });

    expect(run.generateTitle).toHaveBeenCalledWith(
      expect.objectContaining({
        titleMethod: 'structured',
        titlePrompt: 'Custom title prompt',
        titlePromptTemplate: 'Template: {{content}}',
      }),
    );
    expect(run.generateTitle.mock.calls[0][0].clientOptions.model).toBe('gpt-3.5-turbo');
  });

  it('skips generation when the endpoint disables titleConvo', async () => {
    const run = makeRun();

    const title = await generateRunTitle({
      req: makeReq({ titleConvo: false }),
      agent: makeAgent(),
      run,
      text: 'Hello there',
      conversationId: 'convo-1',
      abortController: new AbortController(),
    });

    expect(title).toBeUndefined();
    expect(run.generateTitle).not.toHaveBeenCalled();
  });

  it('skips generation for temporary conversations', async () => {
    const run = makeRun();
    const req = makeReq();
    req.body.isTemporary = true;

    const title = await generateRunTitle({
      req,
      agent: makeAgent(),
      run,
      text: 'Hello there',
      conversationId: 'convo-1',
      abortController: new AbortController(),
    });

    expect(title).toBeUndefined();
    expect(run.generateTitle).not.toHaveBeenCalled();
  });

  it('records title usage through the injected recordUsage callback', async () => {
    const run = makeRun();
    const recordUsage = jest.fn().mockResolvedValue();

    await generateRunTitle({
      req: makeReq(),
      agent: makeAgent(),
      run,
      text: 'Hello there',
      conversationId: 'convo-1',
      abortController: new AbortController(),
      recordUsage,
    });

    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        collectedUsage: [],
        model: 'agent-model',
        balance: { enabled: false },
        transactions: {},
      }),
    );
  });

  it('does not record usage when no recordUsage callback is provided', async () => {
    const run = makeRun();

    const title = await generateRunTitle({
      req: makeReq(),
      agent: makeAgent(),
      run,
      text: 'Hello there',
      conversationId: 'convo-1',
      abortController: new AbortController(),
    });

    expect(title).toBe('Generated Title');
  });

  it('returns undefined instead of throwing when the title model call fails', async () => {
    const run = makeRun();
    run.generateTitle.mockRejectedValue(new Error('provider down'));

    const title = await generateRunTitle({
      req: makeReq(),
      agent: makeAgent(),
      run,
      text: 'Hello there',
      conversationId: 'convo-1',
      abortController: new AbortController(),
    });

    expect(title).toBeUndefined();
  });

  it('resolves request-based headers for the title request', async () => {
    const req = makeReq();
    await generateRunTitle({
      req,
      agent: makeAgent(),
      run: makeRun(),
      text: 'Hello there',
      conversationId: 'convo-1',
      responseMessageId: 'resp-1',
      parentMessageId: null,
      abortController: new AbortController(),
    });

    expect(mockResolveConfigHeaders).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { messageId: 'resp-1', conversationId: 'convo-1', parentMessageId: null },
      }),
    );
  });
});
