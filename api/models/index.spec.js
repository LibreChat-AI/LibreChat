jest.mock('@librechat/data-schemas', () => ({ createMethods: jest.fn(() => ({})) }));
jest.mock('@librechat/api', () => ({
  matchModelName: jest.fn(),
  findMatchingPattern: jest.fn(),
  isDeploymentSkillId: jest.fn(),
  createChannelStorageConfigReader: jest.fn(() => jest.fn()),
  createMessageBudgetReader: jest.fn(() => ({ getBudget: jest.fn(), initialize: jest.fn() })),
}));
jest.mock('~/cache/getLogStores', () => jest.fn());

const { createMethods } = require('@librechat/data-schemas');
const { createMessageBudgetReader, createChannelStorageConfigReader } = require('@librechat/api');
const { initializeMessageBudget } = require('./index');
const reader = createMessageBudgetReader.mock.results[0].value;
const channelStorageConfigReader = createChannelStorageConfigReader.mock.results[0].value;
const { getMCPAppMessageBudget, getChannelStorageConfig: channelStorageConfigDependency } =
  createMethods.mock.calls[0][1];

describe('message App budget dependency wiring', () => {
  it('passes the same reader to storage and initializer to the composition root', () => {
    expect(getMCPAppMessageBudget).toBe(reader.getBudget);
    expect(initializeMessageBudget).toBe(reader.initialize);
    expect(reader.getBudget).not.toHaveBeenCalled();
  });
});

describe('channel storage configuration dependency wiring', () => {
  it('injects the deployment reader without reading config during module initialization', () => {
    expect(channelStorageConfigDependency).toBe(channelStorageConfigReader);
    expect(channelStorageConfigReader).not.toHaveBeenCalled();
  });
});
