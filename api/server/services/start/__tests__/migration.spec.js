const mockCheckStartupMigrations = jest.fn();
const mockCheckAgentPermissionsMigration = jest.fn();
const mockCheckPromptPermissionsMigration = jest.fn();
const mockWarnOnMissingSearchTokens = jest.fn();
const mockRunAsSystem = jest.fn((fn) => fn());

jest.mock('@librechat/data-schemas', () => ({
  runAsSystem: (fn) => mockRunAsSystem(fn),
  warnOnMissingSearchTokens: (...args) => mockWarnOnMissingSearchTokens(...args),
}));
jest.mock('@librechat/api', () => ({
  checkStartupMigrations: (...args) => mockCheckStartupMigrations(...args),
  checkAgentPermissionsMigration: (...args) => mockCheckAgentPermissionsMigration(...args),
  checkPromptPermissionsMigration: (...args) => mockCheckPromptPermissionsMigration(...args),
}));
jest.mock('~/models', () => ({ findRoleByIdentifier: jest.fn() }));

const mongoose = require('mongoose');
const { findRoleByIdentifier } = require('~/models');
const { checkMigrations } = require('../migration');

it('runs the startup checks as the system against the app models', async () => {
  mockCheckStartupMigrations.mockImplementationOnce(async (checks) => {
    await checks.probeSearchTokens();
    await checks.checkAgentPermissions();
    await checks.checkPromptPermissions();
  });

  await expect(checkMigrations()).resolves.toBeUndefined();

  expect(mockRunAsSystem).toHaveBeenCalledTimes(1);
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
