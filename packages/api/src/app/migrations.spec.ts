import { logger, warnOnMissingSearchTokens } from '@librechat/data-schemas';
import type { StartupMigrationCheckParams } from './migrations';
import { checkPromptPermissionsMigration } from '~/prompts/migration';
import { checkAgentPermissionsMigration } from '~/agents/migration';
import { checkStartupMigrations } from './migrations';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  warnOnMissingSearchTokens: jest.fn(),
}));
jest.mock('~/agents/migration', () => ({
  checkAgentPermissionsMigration: jest.fn(),
  logAgentMigrationWarning: jest.fn(),
}));
jest.mock('~/prompts/migration', () => ({
  checkPromptPermissionsMigration: jest.fn(),
  logPromptMigrationWarning: jest.fn(),
}));

const params = {
  mongoose: { connection: {} },
  methods: { findRoleByIdentifier: jest.fn() },
  AgentModel: {},
  PromptGroupModel: {},
} as unknown as StartupMigrationCheckParams;

const agentCheck = checkAgentPermissionsMigration as jest.Mock;
const promptCheck = checkPromptPermissionsMigration as jest.Mock;
const searchProbe = warnOnMissingSearchTokens as jest.Mock;

describe('checkStartupMigrations', () => {
  beforeEach(() => jest.clearAllMocks());

  it('starts every check before any of them finishes', async () => {
    let finishAgentCheck: (value: unknown) => void = () => undefined;
    agentCheck.mockReturnValue(
      new Promise((resolve) => {
        finishAgentCheck = resolve;
      }),
    );
    promptCheck.mockResolvedValue({});
    searchProbe.mockResolvedValue(undefined);

    const done = checkStartupMigrations(params);
    expect(searchProbe).toHaveBeenCalledWith(params.mongoose.connection);
    expect(promptCheck).toHaveBeenCalledTimes(1);

    finishAgentCheck({});
    await expect(done).resolves.toBeUndefined();
  });

  it('labels permission check failures without failing startup', async () => {
    const agentError = new Error('Agent check failed');
    const promptError = new Error('Prompt check failed');
    agentCheck.mockRejectedValueOnce(agentError);
    promptCheck.mockRejectedValueOnce(promptError);
    searchProbe.mockResolvedValueOnce(undefined);

    await expect(checkStartupMigrations(params)).resolves.toBeUndefined();

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
