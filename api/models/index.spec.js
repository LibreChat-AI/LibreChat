jest.mock('@librechat/data-schemas', () => ({
  createPostgresFavoriteBackend: jest.fn(),
  createMethods: jest.fn((_mongoose, deps) => ({ ...deps.toolFavorites })),
  createToolFavoriteMethods: jest.fn(() => ({
    getToolFavorites: jest.fn().mockResolvedValue([]),
    addToolFavorite: jest.fn().mockResolvedValue({ ok: true, added: true }),
    removeToolFavorite: jest.fn().mockResolvedValue({ ok: true, removed: true }),
    deleteUserToolFavorites: jest.fn().mockResolvedValue(2),
  })),
}));
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('../../packages/api/src/app/persistence'),
  createFavoriteRuntime: jest.fn(
    jest.requireActual('../../packages/api/src/app/persistence').createFavoriteRuntime,
  ),
  matchModelName: jest.fn(),
  findMatchingPattern: jest.fn(),
  isDeploymentSkillId: jest.fn(),
  createChannelStorageConfigReader: jest.fn(() => ({
    getConfig: jest.fn(),
    initialize: jest.fn(),
  })),
  createMessageBudgetReader: jest.fn(() => ({ getBudget: jest.fn(), initialize: jest.fn() })),
}));
jest.mock('~/cache/getLogStores', () => jest.fn());

const {
  createToolFavoriteMethods,
  createMethods,
  createPostgresFavoriteBackend,
} = require('@librechat/data-schemas');
const {
  createMessageBudgetReader,
  createFavoriteRuntime,
  createChannelStorageConfigReader,
} = require('@librechat/api');
const models = require('./index');
const { initializeMessageBudget, initializeChannelStorageConfig } = models;
const reader = createMessageBudgetReader.mock.results[0].value;
const channelStorageConfigReader = createChannelStorageConfigReader.mock.results[0].value;
const dependencies = createMethods.mock.calls[0][1];
const runtimeDependencies = createFavoriteRuntime.mock.calls[0];
const { getMCPAppMessageBudget, getChannelStorageConfig: channelStorageConfigDependency } =
  dependencies;
const mongoFavorites = createToolFavoriteMethods.mock.results[0].value;

describe('message App budget dependency wiring', () => {
  it('passes the same reader to storage and initializer to the composition root', () => {
    expect(getMCPAppMessageBudget).toBe(reader.getBudget);
    expect(initializeMessageBudget).toBe(reader.initialize);
    expect(reader.getBudget).not.toHaveBeenCalled();
  });
});

describe('favorites composition root', () => {
  it('passes stable runtime methods to storage and keeps captured deletion references usable', async () => {
    expect(runtimeDependencies).toEqual([
      mongoFavorites,
      process.env,
      createPostgresFavoriteBackend,
    ]);
    const captured = models.deleteUserToolFavorites;
    expect(dependencies.toolFavorites.deleteUserToolFavorites).toBe(captured);
    await expect(captured('user')).rejects.toThrow('not initialized');
    await models.initializeFavorites(null);
    expect(createPostgresFavoriteBackend).not.toHaveBeenCalled();
    expect(await captured('user')).toBe(2);
    expect(mongoFavorites.deleteUserToolFavorites).toHaveBeenCalledWith('user');
    expect(models.deleteUserToolFavorites).toBe(captured);
    await models.closeFavorites();
    await expect(captured('user')).rejects.toThrow('not initialized');
  });
});

describe('channel storage configuration dependency wiring', () => {
  it('injects the deployment reader without reading config during module initialization', () => {
    expect(channelStorageConfigDependency).toBe(channelStorageConfigReader.getConfig);
    expect(initializeChannelStorageConfig).toBe(channelStorageConfigReader.initialize);
    expect(channelStorageConfigReader.getConfig).not.toHaveBeenCalled();
  });
});
