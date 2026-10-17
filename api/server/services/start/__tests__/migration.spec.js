const mockWarnOnMissingSearchTokens = jest.fn();
const mockCheckAgentPermissionsMigration = jest.fn();
const mockCheckPromptPermissionsMigration = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn() },
  warnOnMissingSearchTokens: (...args) => mockWarnOnMissingSearchTokens(...args),
}));
jest.mock('@librechat/api', () => ({
  logAgentMigrationWarning: jest.fn(),
  logPromptMigrationWarning: jest.fn(),
  checkAgentPermissionsMigration: (...args) => mockCheckAgentPermissionsMigration(...args),
  checkPromptPermissionsMigration: (...args) => mockCheckPromptPermissionsMigration(...args),
}));
jest.mock('~/models', () => ({ findRoleByIdentifier: jest.fn() }));

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
