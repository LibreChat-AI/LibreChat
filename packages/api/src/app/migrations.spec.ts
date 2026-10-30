import { logger } from '@librechat/data-schemas';
import { checkStartupMigrations } from './migrations';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('~/agents/migration', () => ({ logAgentMigrationWarning: jest.fn() }));
jest.mock('~/prompts/migration', () => ({ logPromptMigrationWarning: jest.fn() }));

function makeChecks() {
  return {
    probeSearchTokens: jest.fn(async () => undefined),
    checkAgentPermissions: jest.fn(),
    checkPromptPermissions: jest.fn(),
  };
}

describe('checkStartupMigrations', () => {
  beforeEach(() => jest.clearAllMocks());

  it('starts every check before any of them finishes', async () => {
    const checks = makeChecks();
    let finishAgentCheck: (value: unknown) => void = () => undefined;
    checks.checkAgentPermissions.mockReturnValue(
      new Promise((resolve) => {
        finishAgentCheck = resolve;
      }),
    );
    checks.checkPromptPermissions.mockResolvedValue({});

    const done = checkStartupMigrations(checks);
    expect(checks.probeSearchTokens).toHaveBeenCalledTimes(1);
    expect(checks.checkPromptPermissions).toHaveBeenCalledTimes(1);

    finishAgentCheck({});
    await expect(done).resolves.toBeUndefined();
  });

  it('labels permission check failures without failing startup', async () => {
    const checks = makeChecks();
    const agentError = new Error('Agent check failed');
    const promptError = new Error('Prompt check failed');
    checks.checkAgentPermissions.mockRejectedValueOnce(agentError);
    checks.checkPromptPermissions.mockRejectedValueOnce(promptError);

    await expect(checkStartupMigrations(checks)).resolves.toBeUndefined();

    expect(checks.probeSearchTokens).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      '[checkMigrations] Failed to check agent permissions migration:',
      agentError,
    );
    expect(logger.error).toHaveBeenCalledWith(
      '[checkMigrations] Failed to check prompt permissions migration:',
      promptError,
    );
  });
});
