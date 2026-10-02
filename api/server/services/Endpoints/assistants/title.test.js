const mockCache = {
  set: jest.fn(),
};
const mockSaveConvo = jest.fn();
const mockInitializeClient = jest.fn();

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  isEnabled: (value) => value === true || value === 'true',
  sanitizeTitle: (title) => title,
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('~/cache/getLogStores', () => jest.fn(() => mockCache));
jest.mock(
  './initalize',
  () =>
    (...args) =>
      mockInitializeClient(...args),
);
jest.mock('~/models', () => ({
  saveConvo: (...args) => mockSaveConvo(...args),
}));

const addTitle = require('./title');

describe('assistants addTitle content policy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('skips the title provider, cache, and save for a normalized temporary request', async () => {
    await addTitle(
      { user: { id: 'user-1' }, body: { isTemporary: true } },
      { text: 'temporary input', responseText: 'response', conversationId: 'conversation-1' },
    );

    expect(mockInitializeClient).not.toHaveBeenCalled();
    expect(mockCache.set).not.toHaveBeenCalled();
    expect(mockSaveConvo).not.toHaveBeenCalled();
  });

  it('replaces a blocked generated title before caching or saving it', async () => {
    const create = jest.fn().mockResolvedValue({
      choices: [{ message: { content: 'BLOCKED-GENERATED-TITLE' } }],
    });
    mockInitializeClient.mockResolvedValue({
      openai: { chat: { completions: { create } } },
    });
    const req = {
      user: { id: 'user-1' },
      body: {},
      config: {
        filters: {
          conversationTitles: {
            pii: {
              starterPatterns: [],
              customPatterns: [{ id: 'blocked', label: 'blocked', regex: 'BLOCKED' }],
            },
          },
        },
      },
    };

    await addTitle(req, {
      text: 'submitted text',
      responseText: 'response',
      conversationId: 'conversation-generated',
    });

    expect(mockCache.set).toHaveBeenCalledWith('user-1-conversation-generated', 'New Chat', 120000);
    expect(mockSaveConvo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conversationId: 'conversation-generated',
        title: 'New Chat',
      }),
      expect.objectContaining({ noUpsert: true }),
    );
  });

  it('replaces a blocked submitted-text fallback before caching or saving it', async () => {
    const create = jest.fn().mockRejectedValue(new Error('title model unavailable'));
    mockInitializeClient.mockResolvedValue({
      openai: { chat: { completions: { create } } },
    });
    const req = {
      user: { id: 'user-1' },
      body: {},
      config: {
        filters: {
          conversationTitles: {
            pii: {
              starterPatterns: [],
              customPatterns: [{ id: 'blocked', label: 'blocked', regex: 'BLOCKED' }],
            },
          },
        },
      },
    };

    await addTitle(req, {
      text: 'BLOCKED-SUBMISSION',
      responseText: 'response',
      conversationId: 'conversation-1',
    });

    expect(mockCache.set).toHaveBeenCalledWith('user-1-conversation-1', 'New Chat', 120000);
    expect(mockSaveConvo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conversationId: 'conversation-1',
        title: 'New Chat',
      }),
      expect.objectContaining({ noUpsert: true }),
    );
  });
});
