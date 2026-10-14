const mockLoggerError = jest.fn();
const mockFindOnePluginAuth = jest.fn();
const mockUpdatePluginAuth = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: mockLoggerError },
}));

jest.mock('@librechat/api', () => {
  const { encryptCredential, decryptCredential } = jest.requireActual('@librechat/api');
  return { encryptCredential, decryptCredential };
});

jest.mock('~/models', () => ({
  findOnePluginAuth: (...args) => mockFindOnePluginAuth(...args),
  updatePluginAuth: (...args) => mockUpdatePluginAuth(...args),
  deletePluginAuth: jest.fn(),
}));

const { getUserPluginAuthValue, updateUserPluginAuth } = require('./PluginService');

describe('getUserPluginAuthValue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not log an expected missing auth value', async () => {
    mockFindOnePluginAuth.mockResolvedValue(null);

    await expect(
      getUserPluginAuthValue('user-id', 'WEB_SEARCH_SELECTED_PROVIDER'),
    ).rejects.toMatchObject({ code: 'PLUGIN_AUTH_NOT_FOUND' });

    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('still logs credential-store failures', async () => {
    const error = new Error('database unavailable');
    mockFindOnePluginAuth.mockRejectedValue(error);

    await expect(getUserPluginAuthValue('user-id', 'WEB_SEARCH_SELECTED_PROVIDER')).rejects.toBe(
      error,
    );

    expect(mockLoggerError).toHaveBeenCalledWith('[getUserPluginAuthValue]', error);
  });
});

describe('plugin auth encryption', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('stores a random-IV v3 value that reads back as the plaintext', async () => {
    mockUpdatePluginAuth.mockImplementation(async (doc) => doc);

    await updateUserPluginAuth('user-id', 'API_KEY', 'plugin', 'plain');
    await updateUserPluginAuth('user-id', 'API_KEY', 'plugin', 'plain');

    const [first, second] = mockUpdatePluginAuth.mock.calls.map(([doc]) => doc.value);
    expect(first).toMatch(/^v3:[0-9a-f]{32}:[0-9a-f]+$/);
    expect(second).not.toBe(first);

    mockFindOnePluginAuth.mockResolvedValue({ value: first });
    await expect(getUserPluginAuthValue('user-id', 'API_KEY')).resolves.toBe('plain');
  });

  it('stores the legacy fixed-IV format when the write format is legacy', async () => {
    const { encrypt } = jest.requireActual('@librechat/data-schemas');
    mockUpdatePluginAuth.mockImplementation(async (doc) => doc);

    await updateUserPluginAuth('user-id', 'API_KEY', 'plugin', 'plain', 'legacy');

    const [[{ value }]] = mockUpdatePluginAuth.mock.calls;
    expect(value).toBe(await encrypt('plain'));
    mockFindOnePluginAuth.mockResolvedValue({ value });
    await expect(getUserPluginAuthValue('user-id', 'API_KEY')).resolves.toBe('plain');
  });

  it('reads a value stored in the legacy fixed-IV format', async () => {
    const { encrypt } = jest.requireActual('@librechat/data-schemas');
    mockFindOnePluginAuth.mockResolvedValue({ value: await encrypt('legacy-plain') });

    await expect(getUserPluginAuthValue('user-id', 'API_KEY')).resolves.toBe('legacy-plain');
  });
});
