const mockDb = { marker: 'db' };
const mockGrantPermission = jest.fn();
const mockGetAppConfig = jest.fn();
const mockPromptServiceInstance = { marker: 'promptService' };
const mockCreatePromptService = jest.fn(() => mockPromptServiceInstance);

jest.mock('@librechat/api', () => ({
  createPromptService: mockCreatePromptService,
}));

jest.mock('~/models', () => mockDb);

jest.mock('~/server/services/PermissionService', () => ({
  grantPermission: mockGrantPermission,
}));

jest.mock('~/server/services/Config', () => ({
  getAppConfig: mockGetAppConfig,
}));

describe('Prompts', () => {
  it('builds the process prompt service once with the shared db, grantPermission and getAppConfig', () => {
    const { promptService } = require('./Prompts');

    expect(mockCreatePromptService).toHaveBeenCalledTimes(1);
    expect(mockCreatePromptService).toHaveBeenCalledWith({
      db: mockDb,
      grantPermission: mockGrantPermission,
      getAppConfig: mockGetAppConfig,
    });
    expect(promptService).toBe(mockPromptServiceInstance);
  });
});
