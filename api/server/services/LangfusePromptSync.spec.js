const mockLock = { acquire: jest.fn(), extend: jest.fn(), release: jest.fn() };
const mockSyncPromptCatalog = jest.fn();
const mockCreateLangfusePromptSyncRunner = jest.fn(() => mockSyncPromptCatalog);
const mockGrantPermission = jest.fn();
const mockLogger = { warn: jest.fn(), error: jest.fn() };

jest.mock('@librechat/api', () => ({
  createLangfusePromptSyncRunner: mockCreateLangfusePromptSyncRunner,
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: mockLogger,
}));

jest.mock('~/cache', () => ({
  distributedLock: mockLock,
}));

jest.mock('~/server/services/PermissionService', () => ({
  grantPermission: mockGrantPermission,
}));

jest.mock('~/models', () => ({
  findLangfusePromptGroup: jest.fn(),
  createLangfusePromptGroup: jest.fn(),
  deletePromptGroup: jest.fn(),
}));

describe('LangfusePromptSync', () => {
  it('composes the sync runner once with the shared lock and the db methods', () => {
    const db = require('~/models');
    const { syncLangfusePromptCatalog } = require('./LangfusePromptSync');

    expect(mockCreateLangfusePromptSyncRunner).toHaveBeenCalledTimes(1);
    expect(mockCreateLangfusePromptSyncRunner).toHaveBeenCalledWith({
      lock: mockLock,
      findLangfusePromptGroup: db.findLangfusePromptGroup,
      createLangfusePromptGroup: db.createLangfusePromptGroup,
      deletePromptGroup: db.deletePromptGroup,
      grantPermission: mockGrantPermission,
      logger: mockLogger,
    });
    expect(syncLangfusePromptCatalog).toBe(mockSyncPromptCatalog);
  });
});
