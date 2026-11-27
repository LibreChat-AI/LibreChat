import type { AsyncLocalStorage } from 'async_hooks';

jest.mock('@librechat/data-schemas', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AsyncLocalStorage: ALS } = require('async_hooks');
  const tenantStorage = new ALS();
  return { tenantStorage, getTenantId: () => tenantStorage.getStore()?.tenantId };
});

import type { AppConfig } from '@librechat/data-schemas';
import type { GetAppConfigOptions } from './service';
import {
  resolveAppConfigForUser,
  resolvePreAuthAppConfig,
  resolvePreLoginAppConfig,
} from './resolve';

const { tenantStorage } = jest.requireMock('@librechat/data-schemas') as {
  tenantStorage: AsyncLocalStorage<{ tenantId?: string }>;
};

const PRE_AUTH = { skipRuntimeAugmentation: true, failClosed: true };

describe('resolvePreAuthAppConfig', () => {
  const mockGetAppConfig = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAppConfig.mockResolvedValue({ registration: {} });
  });

  it('reads the base principal only, without augmentation, failing closed', async () => {
    await resolvePreAuthAppConfig(mockGetAppConfig);
    expect(mockGetAppConfig).toHaveBeenCalledTimes(1);
    expect(mockGetAppConfig).toHaveBeenCalledWith(PRE_AUTH);
  });

  it('propagates an override read failure instead of returning librechat.yaml', async () => {
    mockGetAppConfig.mockRejectedValue(new Error('overrides unavailable'));
    await expect(resolvePreAuthAppConfig(mockGetAppConfig)).rejects.toThrow(
      'overrides unavailable',
    );
  });
});

describe('resolvePreLoginAppConfig', () => {
  const mergedConfig: Partial<AppConfig> = { registration: { socialLogins: ['google'] } };
  const getAppConfig = jest.fn(async (_options: GetAppConfigOptions) => mergedConfig as AppConfig);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('serves the base override in one read, with or without a tenant', async () => {
    const outside = await resolvePreLoginAppConfig(getAppConfig);
    const inside = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
      resolvePreLoginAppConfig(getAppConfig),
    );

    expect(getAppConfig).toHaveBeenCalledTimes(2);
    expect(getAppConfig).toHaveBeenNthCalledWith(1, { skipRuntimeAugmentation: true });
    expect(getAppConfig).toHaveBeenNthCalledWith(2, { skipRuntimeAugmentation: true });
    expect(outside.registration).toEqual({ socialLogins: ['google'] });
    expect(inside).toBe(outside);
  });

  it('does not fail closed, so the sign-in page still renders from the YAML fallback', async () => {
    await resolvePreLoginAppConfig(getAppConfig);
    for (const [options] of getAppConfig.mock.calls) {
      expect(options.failClosed).toBeUndefined();
    }
  });
});

describe('resolveAppConfigForUser', () => {
  const mockGetAppConfig = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAppConfig.mockResolvedValue({ registration: {} });
  });

  it('resolves the pre-auth config when user is null', async () => {
    await resolveAppConfigForUser(mockGetAppConfig, null);
    expect(mockGetAppConfig).toHaveBeenCalledWith(PRE_AUTH);
  });

  it('resolves the pre-auth config when user is undefined', async () => {
    await resolveAppConfigForUser(mockGetAppConfig, undefined);
    expect(mockGetAppConfig).toHaveBeenCalledWith(PRE_AUTH);
  });

  it('applies role overrides for a user without a tenant', async () => {
    await resolveAppConfigForUser(mockGetAppConfig, { role: 'USER' });
    expect(mockGetAppConfig).toHaveBeenCalledWith({ ...PRE_AUTH, role: 'USER' });
  });

  it('calls getAppConfig with role and tenantId when user has tenantId', async () => {
    await resolveAppConfigForUser(mockGetAppConfig, { tenantId: 'tenant-a', role: 'USER' });
    expect(mockGetAppConfig).toHaveBeenCalledWith({
      ...PRE_AUTH,
      role: 'USER',
      tenantId: 'tenant-a',
    });
  });

  it('calls tenantStorage.run for tenant users but not for non-tenant users', async () => {
    const runSpy = jest.spyOn(tenantStorage, 'run');

    await resolveAppConfigForUser(mockGetAppConfig, { role: 'USER' });
    expect(runSpy).not.toHaveBeenCalled();

    await resolveAppConfigForUser(mockGetAppConfig, { tenantId: 'tenant-b', role: 'ADMIN' });
    expect(runSpy).toHaveBeenCalledWith({ tenantId: 'tenant-b' }, expect.any(Function));

    runSpy.mockRestore();
  });

  it('makes tenantId available via ALS inside getAppConfig', async () => {
    let capturedContext: { tenantId?: string } | undefined;
    mockGetAppConfig.mockImplementation(async () => {
      capturedContext = tenantStorage.getStore();
      return { registration: {} };
    });

    await resolveAppConfigForUser(mockGetAppConfig, { tenantId: 'tenant-c', role: 'USER' });

    expect(capturedContext).toEqual({ tenantId: 'tenant-c' });
  });

  it('returns the config from getAppConfig', async () => {
    const tenantConfig = { registration: { allowedDomains: ['example.com'] } };
    mockGetAppConfig.mockResolvedValue(tenantConfig);

    const result = await resolveAppConfigForUser(mockGetAppConfig, {
      tenantId: 'tenant-d',
      role: 'USER',
    });

    expect(result).toBe(tenantConfig);
  });

  it('calls getAppConfig with role undefined when user has tenantId but no role', async () => {
    await resolveAppConfigForUser(mockGetAppConfig, { tenantId: 'tenant-e' });
    expect(mockGetAppConfig).toHaveBeenCalledWith({
      ...PRE_AUTH,
      role: undefined,
      tenantId: 'tenant-e',
    });
  });

  it('propagates rejection from getAppConfig for tenant users', async () => {
    mockGetAppConfig.mockRejectedValue(new Error('config unavailable'));
    await expect(
      resolveAppConfigForUser(mockGetAppConfig, { tenantId: 'tenant-f', role: 'USER' }),
    ).rejects.toThrow('config unavailable');
  });

  it('propagates rejection from getAppConfig for users without a tenant', async () => {
    mockGetAppConfig.mockRejectedValue(new Error('cache failure'));
    await expect(resolveAppConfigForUser(mockGetAppConfig, { role: 'USER' })).rejects.toThrow(
      'cache failure',
    );
    await expect(resolveAppConfigForUser(mockGetAppConfig, null)).rejects.toThrow('cache failure');
  });
});
