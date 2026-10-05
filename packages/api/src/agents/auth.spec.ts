import { logger, decrypt } from '@librechat/data-schemas';
import type { IPluginAuth, PluginAuthMethods } from '@librechat/data-schemas';
import { getUserMCPAuthMap } from '~/mcp/auth';
import { getPluginAuthMap } from './auth';

jest.mock('@librechat/data-schemas', () => {
  const actual = jest.requireActual('@librechat/data-schemas');
  return {
    ...actual,
    decrypt: jest.fn(actual.decrypt),
    logger: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
  };
});
beforeEach(() => {
  jest.clearAllMocks();
});

const key = 'mcp_Files';
const diagnostic = () =>
  Object.assign(new Error(`private-variable-diagnostic-${'x'.repeat(5000)}`), {
    query: { credential: 'private-query-value' },
    response: { status: 503, data: { credential: 'private-provider-value' } },
  });
const expectSafeLogs = () => {
  const logs = JSON.stringify([
    ...jest.mocked(logger.warn).mock.calls,
    ...jest.mocked(logger.error).mock.calls,
  ]);
  expect(logs).not.toMatch(
    /private-variable-diagnostic|private-query-value|private-provider-value/,
  );
  expect(logs.length).toBeLessThan(1000);
};

it.each([true, false])(
  'sanitizes lookup diagnostics while preserving throwError=%s',
  async (throwError) => {
    const error = diagnostic();
    const find: PluginAuthMethods['findPluginAuthsByKeys'] = jest.fn(async () => {
      throw error;
    });
    const result = getPluginAuthMap({
      userId: 'owner',
      pluginKeys: [key],
      throwError,
      findPluginAuthsByKeys: find,
    });
    if (throwError) await expect(result).rejects.toBe(error);
    else await expect(result).resolves.toEqual({ [key]: {} });
    expectSafeLogs();
    expect(logger.warn).toHaveBeenCalledWith('[getPluginAuthMap] Failed to fetch auth values', {
      type: 'Error',
      status: 503,
    });
  },
);

it.each([true, false])(
  'sanitizes decryption diagnostics and keeps throwError=%s',
  async (throwError) => {
    const error = diagnostic();
    jest.mocked(decrypt).mockRejectedValueOnce(error);
    const find: PluginAuthMethods['findPluginAuthsByKeys'] = async () => [
      { pluginKey: key, authField: 'KEY', value: 'test-ciphertext' } as IPluginAuth,
    ];
    const result = getPluginAuthMap({
      userId: 'owner',
      pluginKeys: [key],
      throwError,
      findPluginAuthsByKeys: find,
    });
    if (throwError) {
      await expect(result).rejects.toMatchObject({
        message: `Decryption failed for plugin ${key}, field KEY`,
        cause: error,
      });
    } else await expect(result).resolves.toEqual({ [key]: {} });
    expectSafeLogs();
    expect(logger.error).toHaveBeenCalledWith('[getPluginAuthMap] Decryption failed', {
      type: 'Error',
      status: 503,
    });
  },
);

it.each([true, false])(
  'keeps the MCP consumer diagnostics safe with throwOnError=%s',
  async (throwOnError) => {
    const error = diagnostic();
    const find: PluginAuthMethods['findPluginAuthsByKeys'] = async () => {
      throw error;
    };
    const result = getUserMCPAuthMap({
      userId: 'owner',
      tools: ['read_mcp_Files'],
      throwOnError,
      findPluginAuthsByKeys: find,
    });
    if (throwOnError) await expect(result).rejects.toBe(error);
    else await expect(result).resolves.toEqual({ [key]: {} });
    expectSafeLogs();
  },
);

it('retains successful decrypted maps with caller-owned crypto configuration', async () => {
  const value = 'test-ciphertext';
  jest.mocked(decrypt).mockResolvedValueOnce('test-only-credential');
  const find: PluginAuthMethods['findPluginAuthsByKeys'] = async () => [
    { pluginKey: key, authField: 'KEY', value } as IPluginAuth,
  ];
  await expect(
    getPluginAuthMap({ userId: 'owner', pluginKeys: [key], findPluginAuthsByKeys: find }),
  ).resolves.toEqual({ [key]: { KEY: 'test-only-credential' } });
});
