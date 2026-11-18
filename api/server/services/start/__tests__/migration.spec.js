const mockCheckStartupMigrations = jest.fn();
const mockMigrateLegacyAgentOfficialStatus = jest.fn().mockResolvedValue(0);
const mockCheckAgentPermissionsMigration = jest.fn();
const mockCheckPromptPermissionsMigration = jest.fn();
const mockWarnOnMissingSearchTokens = jest.fn();
const mockRunAsSystem = jest.fn((fn) => fn());

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), info: jest.fn() },
  runAsSystem: (fn) => mockRunAsSystem(fn),
  warnOnMissingSearchTokens: (...args) => mockWarnOnMissingSearchTokens(...args),
  migrateLegacyAgentOfficialStatus: (...args) => mockMigrateLegacyAgentOfficialStatus(...args),
}));
jest.mock('@librechat/api', () => ({
  checkStartupMigrations: (...args) => mockCheckStartupMigrations(...args),
  checkAgentPermissionsMigration: (...args) => mockCheckAgentPermissionsMigration(...args),
  checkPromptPermissionsMigration: (...args) => mockCheckPromptPermissionsMigration(...args),
}));
jest.mock('~/models', () => ({ findRoleByIdentifier: jest.fn() }));

const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { findRoleByIdentifier } = require('~/models');
const { checkMigrations } = require('../migration');

it('runs startup checks as the system against the app models', async () => {
  mockCheckStartupMigrations.mockImplementationOnce(async (checks) => {
    await checks.probeSearchTokens();
    await checks.checkAgentPermissions();
    await checks.checkPromptPermissions();
  });

  await expect(checkMigrations()).resolves.toBeUndefined();

  expect(mockRunAsSystem).toHaveBeenCalledTimes(1);
  expect(mockCheckStartupMigrations).toHaveBeenCalledTimes(1);
  expect(mockWarnOnMissingSearchTokens).toHaveBeenCalledWith(mongoose.connection);
  expect(mockCheckAgentPermissionsMigration).toHaveBeenCalledWith({
    mongoose,
    methods: { findRoleByIdentifier },
    AgentModel: mongoose.models.Agent,
  });
  expect(mockCheckPromptPermissionsMigration).toHaveBeenCalledWith({
    mongoose,
    methods: { findRoleByIdentifier },
    PromptGroupModel: mongoose.models.PromptGroup,
  });
});

it('migrates legacy official status and logs the number of updated agents', async () => {
  mockMigrateLegacyAgentOfficialStatus.mockResolvedValueOnce(2);
  mockCheckStartupMigrations.mockResolvedValueOnce(undefined);

  await expect(checkMigrations()).resolves.toBeUndefined();

  expect(mockMigrateLegacyAgentOfficialStatus).toHaveBeenCalledWith(mongoose.connection);
  expect(logger.info).toHaveBeenCalledWith('[AgentOfficialStatusMigration] Updated 2 agents');
});
