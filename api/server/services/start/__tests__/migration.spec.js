const mockCheckStartupMigrations = jest.fn();
const mockRunAsSystem = jest.fn((fn) => fn());

jest.mock('@librechat/data-schemas', () => ({
  runAsSystem: (fn) => mockRunAsSystem(fn),
}));
jest.mock('@librechat/api', () => ({
  checkStartupMigrations: (...args) => mockCheckStartupMigrations(...args),
}));
jest.mock('~/models', () => ({ findRoleByIdentifier: jest.fn() }));

const mongoose = require('mongoose');
const { findRoleByIdentifier } = require('~/models');
const { checkMigrations } = require('../migration');

it('runs the startup checks as the system with the app models', async () => {
  mockCheckStartupMigrations.mockResolvedValueOnce(undefined);

  await expect(checkMigrations()).resolves.toBeUndefined();

  expect(mockRunAsSystem).toHaveBeenCalledTimes(1);
  expect(mockCheckStartupMigrations).toHaveBeenCalledWith({
    mongoose,
    methods: { findRoleByIdentifier },
    AgentModel: mongoose.models.Agent,
    PromptGroupModel: mongoose.models.PromptGroup,
  });
});
