const mockGetUserPluginAuthValue = jest.fn();

jest.mock('~/server/services/PluginService', () => ({
  getUserPluginAuthValue: (...args) => mockGetUserPluginAuthValue(...args),
}));

const { loadAuthValues } = require('./credentials');

const AUTH_FIELDS = ['AZURE_SORA_API_KEY', 'AZURE_SORA_ENDPOINT'];

describe('loadAuthValues ownership', () => {
  const originalValues = Object.fromEntries(
    AUTH_FIELDS.map((field) => [field, process.env[field]]),
  );

  beforeEach(() => {
    jest.clearAllMocks();
    for (const field of AUTH_FIELDS) delete process.env[field];
  });

  afterAll(() => {
    for (const field of AUTH_FIELDS) {
      if (originalValues[field] === undefined) delete process.env[field];
      else process.env[field] = originalValues[field];
    }
  });

  test('loads a user pair without substituting global fields', async () => {
    process.env.AZURE_SORA_API_KEY = 'server-key';
    process.env.AZURE_SORA_ENDPOINT = 'https://admin-resource.openai.azure.com';
    const userValues = {
      AZURE_SORA_API_KEY: 'user-key',
      AZURE_SORA_ENDPOINT: 'https://user-resource.openai.azure.com',
    };
    mockGetUserPluginAuthValue.mockImplementation(
      (_userId, authField) => userValues[authField] ?? null,
    );

    await expect(
      loadAuthValues({ userId: 'user-1', authFields: AUTH_FIELDS, source: 'user' }),
    ).resolves.toEqual(userValues);
  });

  test('leaves incomplete user pairs incomplete', async () => {
    process.env.AZURE_SORA_API_KEY = 'server-key';
    process.env.AZURE_SORA_ENDPOINT = 'https://admin-resource.openai.azure.com';
    mockGetUserPluginAuthValue.mockImplementation((_userId, authField) =>
      authField === 'AZURE_SORA_API_KEY' ? 'user-key' : null,
    );

    await expect(
      loadAuthValues({ userId: 'user-1', authFields: AUTH_FIELDS, source: 'user' }),
    ).resolves.toEqual({ AZURE_SORA_API_KEY: 'user-key' });
  });

  test('keeps the existing global-first behavior outside user ownership mode', async () => {
    process.env.AZURE_SORA_API_KEY = 'server-key';
    process.env.AZURE_SORA_ENDPOINT = 'https://admin-resource.openai.azure.com';
    mockGetUserPluginAuthValue.mockResolvedValue('user-key');

    await expect(loadAuthValues({ userId: 'user-1', authFields: AUTH_FIELDS })).resolves.toEqual({
      AZURE_SORA_API_KEY: 'server-key',
      AZURE_SORA_ENDPOINT: 'https://admin-resource.openai.azure.com',
    });
    expect(mockGetUserPluginAuthValue).not.toHaveBeenCalled();
  });
});
