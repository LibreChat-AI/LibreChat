const mockLock = { acquire: jest.fn(), extend: jest.fn(), release: jest.fn() };
const mockSyncPromptCatalog = jest.fn();
const mockCreateLangfusePromptSyncRunner = jest.fn(() => mockSyncPromptCatalog);
const mockLogger = { warn: jest.fn(), error: jest.fn() };
const mockPromptService = { importSourceGroup: jest.fn() };

jest.mock('@librechat/api', () => ({
  createLangfusePromptSyncRunner: mockCreateLangfusePromptSyncRunner,
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: mockLogger,
}));

jest.mock('~/cache', () => ({
  distributedLock: mockLock,
}));

jest.mock('~/server/services/Prompts', () => ({
  promptService: mockPromptService,
}));

describe('LangfusePromptSync', () => {
  it('composes the sync runner once with the shared lock and the shared prompt service', () => {
    const { syncLangfusePromptCatalog } = require('./LangfusePromptSync');

    expect(mockCreateLangfusePromptSyncRunner).toHaveBeenCalledTimes(1);
    expect(mockCreateLangfusePromptSyncRunner).toHaveBeenCalledWith({
      lock: mockLock,
      promptService: mockPromptService,
      logger: mockLogger,
    });
    expect(syncLangfusePromptCatalog).toBe(mockSyncPromptCatalog);
  });
});
