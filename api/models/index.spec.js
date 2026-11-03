jest.mock('@librechat/data-schemas', () => ({ createMethods: jest.fn(() => ({})) }));
jest.mock('@librechat/api', () => ({
  matchModelName: jest.fn(),
  findMatchingPattern: jest.fn(),
  isDeploymentSkillId: jest.fn(),
  createStorageConfigReader: jest.fn(() => ({
    getChannelConfig: jest.fn(),
    getDurableConfig: jest.fn(),
    initialize: jest.fn(),
  })),
  createMessageBudgetReader: jest.fn(() => ({ getBudget: jest.fn(), initialize: jest.fn() })),
}));
jest.mock('~/cache/getLogStores', () => jest.fn());

const { createMethods } = require('@librechat/data-schemas');
const { createMessageBudgetReader, createStorageConfigReader } = require('@librechat/api');
const { initializeMessageBudget, initializeStorageConfig } = require('./index');
const reader = createMessageBudgetReader.mock.results[0].value;
const storageConfigReader = createStorageConfigReader.mock.results[0].value;
const {
  getMCPAppMessageBudget,
  getChannelStorageConfig: channelStorageConfigDependency,
  getDurableStorageConfig: durableStorageConfigDependency,
} = createMethods.mock.calls[0][1];

describe('message App budget dependency wiring', () => {
  it('passes the same reader to storage and initializer to the composition root', () => {
    expect(getMCPAppMessageBudget).toBe(reader.getBudget);
    expect(initializeMessageBudget).toBe(reader.initialize);
    expect(reader.getBudget).not.toHaveBeenCalled();
  });
});

describe('deployment storage configuration dependency wiring', () => {
  it('injects the deployment reader without reading config during module initialization', () => {
    expect(channelStorageConfigDependency).toBe(storageConfigReader.getChannelConfig);
    expect(durableStorageConfigDependency).toBe(storageConfigReader.getDurableConfig);
    expect(initializeStorageConfig).toBe(storageConfigReader.initialize);
    expect(require('./index').getDurableStorageConfig).toBe(storageConfigReader.getDurableConfig);
    expect(storageConfigReader.getChannelConfig).not.toHaveBeenCalled();
    expect(storageConfigReader.getDurableConfig).not.toHaveBeenCalled();
  });
});
