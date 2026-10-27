const mockWarnOnMissingSearchTokens = jest.fn();
const mockCheckAgentPermissionsMigration = jest.fn();
const mockCheckPromptPermissionsMigration = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn() },
  runAsSystem: (fn) => fn(),
  warnOnMissingSearchTokens: (...args) => mockWarnOnMissingSearchTokens(...args),
}));
jest.mock('@librechat/api', () => ({
  logAgentMigrationWarning: jest.fn(),
  logPromptMigrationWarning: jest.fn(),
  checkAgentPermissionsMigration: (...args) => mockCheckAgentPermissionsMigration(...args),
  checkPromptPermissionsMigration: (...args) => mockCheckPromptPermissionsMigration(...args),
}));
jest.mock('~/models', () => ({ findRoleByIdentifier: jest.fn() }));

const { logger } = require('@librechat/data-schemas');
const { checkMigrations } = require('../migration');

describe('checkMigrations', () => {
  it('starts the search token probe while the permission checks are still running', async () => {
    let finishAgentCheck;
    mockCheckAgentPermissionsMigration.mockReturnValue(
      new Promise((resolve) => {
        finishAgentCheck = resolve;
      }),
    );
    mockCheckPromptPermissionsMigration.mockResolvedValue({});
    mockWarnOnMissingSearchTokens.mockResolvedValue(undefined);

    const done = checkMigrations();
    expect(mockWarnOnMissingSearchTokens).toHaveBeenCalledTimes(1);

    finishAgentCheck({});
    await done;
    expect(mockCheckPromptPermissionsMigration).toHaveBeenCalledTimes(1);
  });
});

it('labels permission check failures and still awaits the search probe', async () => {
  const agentError = new Error('Agent check failed');
  const promptError = new Error('Prompt check failed');
  mockCheckAgentPermissionsMigration.mockRejectedValueOnce(agentError);
  mockCheckPromptPermissionsMigration.mockRejectedValueOnce(promptError);
  mockWarnOnMissingSearchTokens.mockResolvedValueOnce(undefined);

  await expect(checkMigrations()).resolves.toBeUndefined();

  expect(logger.error).toHaveBeenCalledWith(
    '[checkMigrations] Failed to check agent permissions migration:',
    agentError,
  );
  expect(logger.error).toHaveBeenCalledWith(
    '[checkMigrations] Failed to check prompt permissions migration:',
    promptError,
  );
});
