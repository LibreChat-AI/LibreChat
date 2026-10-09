jest.mock('~/admin/secrets', () => ({
  decryptConfigSecret: jest.fn((value: string) =>
    value === 'v3:test:tenant-secret-key' ? 'tenant-secret-key' : undefined,
  ),
}));

import { tenantStorage } from '@librechat/data-schemas';
import type { AppConfig, IConfig } from '@librechat/data-schemas';
import type { TCustomConfig } from 'librechat-data-provider';
import type { LangfuseSourceGroup } from './promptSync';
import {
  readStoredLangfuse,
  buildPromptSyncConnection,
  toLangfusePromptErrorResponse,
  getPromptSyncSourceIdentity,
  createLangfuseSourceResolver,
} from './promptSync';
import { LangfusePromptRequestError } from './prompts';

const langfuseEnvKeys = [
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_PROJECT_ID',
  'LANGFUSE_BASE_URL',
  'LANGFUSE_HOST',
  'LANGFUSE_BASEURL',
  'LANGFUSE_FANOUT_ENABLED',
  'LANGFUSE_FANOUT_COLLECTOR_URL',
  'LANGFUSE_FANOUT_TENANT_DESTINATIONS',
  'LANGFUSE_FANOUT_TENANT_EU_BASE_URL',
  'LANGFUSE_FANOUT_TENANT_US_BASE_URL',
  'LANGFUSE_FANOUT_TENANT_JP_BASE_URL',
  'TENANT_ISOLATION_STRICT',
  'LANGFUSE_PROMPT_SYNC_AVAILABLE',
];

function clearLangfuseEnv() {
  for (const key of langfuseEnvKeys) {
    delete process.env[key];
  }
}

beforeEach(() => {
  clearLangfuseEnv();
});

function baseConfigDoc(langfuse: Record<string, unknown> | undefined): IConfig {
  return { overrides: langfuse !== undefined ? { langfuse } : {} } as IConfig;
}

function appConfigWithLangfuse(langfuse?: AppConfig['langfuse']): AppConfig {
  return { langfuse } as AppConfig;
}

/** A tenant connection valid enough for `resolveLangfusePromptConnection` to
 *  resolve, with a recorded source identity. */
function tenantStoredConfig(overrides: Record<string, unknown> = {}): TCustomConfig['langfuse'] {
  return {
    publicKey: 'tenant-public-key',
    secretKey: 'v3:test:tenant-secret-key',
    destination: 'us',
    projectId: 'tenant-project-1',
    promptSync: { enabled: true },
    ...overrides,
  };
}

describe('readStoredLangfuse', () => {
  it('returns undefined for a missing config', () => {
    expect(readStoredLangfuse(null)).toBeUndefined();
  });

  it('reads the langfuse section from the stored override tree', () => {
    const stored = { destination: 'us', promptSync: { enabled: true } };
    expect(readStoredLangfuse(baseConfigDoc(stored))).toEqual(stored);
  });
});

describe('toLangfusePromptErrorResponse', () => {
  it('maps timeout to 504', () => {
    const error = new LangfusePromptRequestError('timeout', 'Langfuse did not respond in time');
    expect(toLangfusePromptErrorResponse(error)).toEqual({
      status: 504,
      body: { code: 'timeout' },
    });
  });

  it.each(['unauthorized', 'upstream', 'invalid_response'] as const)('maps %s to 502', (code) => {
    const error = new LangfusePromptRequestError(code, 'failed');
    expect(toLangfusePromptErrorResponse(error).status).toBe(502);
  });

  it('includes the upstream status in the body, never a 401/403 passthrough', () => {
    const error = new LangfusePromptRequestError('upstream', 'Langfuse responded with 409', 409);
    expect(toLangfusePromptErrorResponse(error)).toEqual({
      status: 502,
      body: { code: 'upstream', status: 409 },
    });
  });

  it('omits status when the error carries none', () => {
    const error = new LangfusePromptRequestError('invalid_response', 'bad body');
    expect(toLangfusePromptErrorResponse(error)).toEqual({
      status: 502,
      body: { code: 'invalid_response' },
    });
  });
});

describe('buildPromptSyncConnection', () => {
  it('returns null when the stored config has no usable credentials', () => {
    expect(
      buildPromptSyncConnection(undefined, { promptSync: { enabled: true } }, undefined),
    ).toBeNull();
  });

  it('builds the connection from the stored destination and keys', () => {
    const connection = buildPromptSyncConnection(undefined, tenantStoredConfig(), 'tenant-a');
    expect(connection).toEqual({
      baseUrl: 'https://us.cloud.langfuse.com',
      authorization: `Basic ${Buffer.from('tenant-public-key:tenant-secret-key').toString('base64')}`,
    });
  });

  it('carries the yaml headers from appConfig, scoped to the one configured destination', () => {
    process.env.LANGFUSE_FANOUT_TENANT_US_BASE_URL = 'https://us.cloud.langfuse.com';
    const appConfig = appConfigWithLangfuse({ headers: { 'X-Gateway-Token': 'abc' } });

    const connection = buildPromptSyncConnection(appConfig, tenantStoredConfig(), 'tenant-a');

    expect(connection?.headers).toEqual({ 'X-Gateway-Token': 'abc' });
  });
});

describe('buildPromptSyncConnection and getPromptSyncSourceIdentity', () => {
  it('read the same merged config, so a stale appConfig value never outvotes the stored one', async () => {
    const appConfig = appConfigWithLangfuse({
      destination: 'eu',
      projectId: 'stale-project',
    } as AppConfig['langfuse']);
    const stored = tenantStoredConfig();

    const connection = buildPromptSyncConnection(appConfig, stored, 'tenant-a');
    const identity = await getPromptSyncSourceIdentity(appConfig, stored, 'tenant-a');

    expect(connection).toEqual({
      baseUrl: 'https://us.cloud.langfuse.com',
      authorization: `Basic ${Buffer.from('tenant-public-key:tenant-secret-key').toString('base64')}`,
    });
    expect(identity).toEqual({ destination: 'us', projectId: 'tenant-project-1' });
  });
});

describe('getPromptSyncSourceIdentity', () => {
  it('returns the stored tenant destination and project id', async () => {
    await expect(
      getPromptSyncSourceIdentity(undefined, tenantStoredConfig(), 'tenant-a'),
    ).resolves.toEqual({
      destination: 'us',
      projectId: 'tenant-project-1',
    });
  });

  it('normalizes the stored destination instead of returning the raw string', async () => {
    await expect(
      getPromptSyncSourceIdentity(undefined, tenantStoredConfig({ destination: 'US' }), 'tenant-a'),
    ).resolves.toEqual({
      destination: 'us',
      projectId: 'tenant-project-1',
    });
  });

  it('resolves the env project id for central-env mode, without a network call when it is pinned', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'env-public';
    process.env.LANGFUSE_SECRET_KEY = 'env-secret';
    process.env.LANGFUSE_PROJECT_ID = 'central-project-1';
    const fetchSpy = jest.spyOn(global, 'fetch');

    await expect(
      getPromptSyncSourceIdentity(undefined, { promptSync: { enabled: true } }, undefined),
    ).resolves.toEqual({
      destination: 'env',
      projectId: 'central-project-1',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolves the env project id over the network, scoping the appConfig headers to the lookup', async () => {
    process.env.LANGFUSE_BASE_URL = 'http://central-langfuse:3000';
    process.env.LANGFUSE_PUBLIC_KEY = 'env-public';
    process.env.LANGFUSE_SECRET_KEY = 'env-secret';
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'central-project-2' }] }),
    } as unknown as Response);
    const appConfig = appConfigWithLangfuse({ headers: { 'X-Gateway-Token': 'abc' } });

    await expect(
      getPromptSyncSourceIdentity(appConfig, { promptSync: { enabled: true } }, undefined),
    ).resolves.toEqual({
      destination: 'env',
      projectId: 'central-project-2',
    });
    const [, init] = fetchSpy.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({ 'X-Gateway-Token': 'abc' });
  });

  it('throws instead of returning an identity with no project id when the lookup fails', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'env-public';
    process.env.LANGFUSE_SECRET_KEY = 'env-secret';
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 500 } as Response);

    await expect(
      getPromptSyncSourceIdentity(undefined, { promptSync: { enabled: true } }, undefined),
    ).rejects.toBeInstanceOf(LangfusePromptRequestError);
  });

  it('throws a timeout error, not upstream, when the lookup itself times out', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'env-public-timeout';
    process.env.LANGFUSE_SECRET_KEY = 'env-secret-timeout';
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    jest.spyOn(global, 'fetch').mockRejectedValue(timeout);

    const error: unknown = await getPromptSyncSourceIdentity(
      undefined,
      { promptSync: { enabled: true } },
      undefined,
      50,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LangfusePromptRequestError);
    expect((error as LangfusePromptRequestError).code).toBe('timeout');
  });

  it('throws upstream, not timeout, for a non-timeout lookup failure', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'env-public-upstream';
    process.env.LANGFUSE_SECRET_KEY = 'env-secret-upstream';
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 500 } as Response);

    const error: unknown = await getPromptSyncSourceIdentity(
      undefined,
      { promptSync: { enabled: true } },
      undefined,
      50,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LangfusePromptRequestError);
    expect((error as LangfusePromptRequestError).code).toBe('upstream');
  });

  it('bounds this call by the given timeoutMs without shortening the underlying project-lookup fetch', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'env-public-bound';
    process.env.LANGFUSE_SECRET_KEY = 'env-secret-bound';
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'bounded-project' }] }),
    } as unknown as Response);

    await expect(
      getPromptSyncSourceIdentity(undefined, { promptSync: { enabled: true } }, undefined, 1_000),
    ).resolves.toEqual({ destination: 'env', projectId: 'bounded-project' });
    // The shared fetch always starts with the deployment-wide project-lookup
    // timeout; the `1_000` above only bounds this call's own wait on it.
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
  });

  it('returns null when the tenant stored config has no project id', async () => {
    await expect(
      getPromptSyncSourceIdentity(
        undefined,
        tenantStoredConfig({ projectId: undefined }),
        'tenant-a',
      ),
    ).resolves.toBeNull();
  });

  it('returns null when the tenant stored config has no destination', async () => {
    await expect(
      getPromptSyncSourceIdentity(
        undefined,
        tenantStoredConfig({ destination: undefined }),
        'tenant-a',
      ),
    ).resolves.toBeNull();
  });
});

describe('createLangfuseSourceResolver', () => {
  function createDeps(
    storedOverrides: Record<string, unknown> = {},
    langfuseAppConfig?: AppConfig['langfuse'],
  ) {
    const findBaseConfig = jest.fn(async () => baseConfigDoc(tenantStoredConfig(storedOverrides)));
    const getAppConfig = jest.fn(async () => appConfigWithLangfuse(langfuseAppConfig));
    return { findBaseConfig, getAppConfig };
  }

  function matchingGroup(overrides: Partial<LangfuseSourceGroup> = {}): LangfuseSourceGroup {
    return {
      tenantId: 'tenant-a',
      sourceDestination: 'us',
      sourceProjectId: 'tenant-project-1',
      ...overrides,
    };
  }

  async function resolveAsTenant(group: LangfuseSourceGroup, deps: ReturnType<typeof createDeps>) {
    return tenantStorage.run({ tenantId: group.tenantId }, () =>
      createLangfuseSourceResolver(deps)(group),
    );
  }

  function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
  } {
    let resolveFn!: (value: T) => void;
    let rejectFn!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });
    return { promise, resolve: resolveFn, reject: rejectFn };
  }

  it('returns disabled when the deployment has not enabled prompt sync at all', async () => {
    const deps = createDeps();

    const result = await resolveAsTenant(matchingGroup(), deps);

    expect(result).toEqual({ ok: false, reason: 'disabled' });
    expect(deps.findBaseConfig).not.toHaveBeenCalled();
    expect(deps.getAppConfig).not.toHaveBeenCalled();
  });

  it('returns not_configured when the group tenant differs from the active tenant', async () => {
    process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
    const deps = createDeps();

    const result = await tenantStorage.run({ tenantId: 'tenant-b' }, () =>
      createLangfuseSourceResolver(deps)(matchingGroup({ tenantId: 'tenant-a' })),
    );

    expect(result).toEqual({ ok: false, reason: 'not_configured' });
    expect(deps.findBaseConfig).not.toHaveBeenCalled();
  });

  it('returns disabled when the tenant has not turned prompt sync on', async () => {
    process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
    const deps = createDeps({ promptSync: { enabled: false } });

    const result = await resolveAsTenant(matchingGroup(), deps);

    expect(result).toEqual({ ok: false, reason: 'disabled' });
    // getAppConfig starts concurrently with the stored-config read that finds
    // prompt sync disabled, so it has already been called by the time this
    // resolves — its result is simply never used.
    expect(deps.getAppConfig).toHaveBeenCalledTimes(1);
  });

  it('returns not_configured when no connection can be built from the stored keys', async () => {
    process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
    const deps = createDeps({ publicKey: undefined, secretKey: undefined, destination: undefined });

    const result = await resolveAsTenant(matchingGroup(), deps);

    expect(result).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('returns not_configured when the stored destination has no match, even with usable keys', async () => {
    process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
    const deps = createDeps({ destination: undefined });

    const result = await resolveAsTenant(matchingGroup(), deps);

    expect(result).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('returns not_configured when the connection builds but the stored config has no project id', async () => {
    process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
    const deps = createDeps({ projectId: undefined });

    const result = await resolveAsTenant(matchingGroup(), deps);

    expect(result).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('returns source_changed when the destination no longer matches', async () => {
    process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
    const deps = createDeps();

    const result = await resolveAsTenant(matchingGroup({ sourceDestination: 'eu' }), deps);

    expect(result).toEqual({ ok: false, reason: 'source_changed' });
  });

  it('returns source_changed when the project id no longer matches', async () => {
    process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
    const deps = createDeps();

    const result = await resolveAsTenant(matchingGroup({ sourceProjectId: 'other-project' }), deps);

    expect(result).toEqual({ ok: false, reason: 'source_changed' });
  });

  it('returns source_changed when the group has no recorded identity', async () => {
    process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
    const deps = createDeps();

    const result = await resolveAsTenant(
      matchingGroup({ sourceDestination: undefined, sourceProjectId: undefined }),
      deps,
    );

    expect(result).toEqual({ ok: false, reason: 'source_changed' });
  });

  it('resolves the connection when the gate, tenant, config and identity all line up', async () => {
    process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
    const deps = createDeps();

    const result = await resolveAsTenant(matchingGroup(), deps);

    expect(result).toEqual({
      ok: true,
      connection: {
        baseUrl: 'https://us.cloud.langfuse.com',
        authorization: `Basic ${Buffer.from('tenant-public-key:tenant-secret-key').toString('base64')}`,
      },
    });
  });

  it('builds the connection with the headers getAppConfig supplies', async () => {
    process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
    process.env.LANGFUSE_FANOUT_TENANT_US_BASE_URL = 'https://us.cloud.langfuse.com';
    const deps = createDeps({}, { headers: { 'X-Gateway-Token': 'abc' } });

    const result = await resolveAsTenant(matchingGroup(), deps);

    expect(result.ok).toBe(true);
    expect(result.ok && result.connection.headers).toEqual({ 'X-Gateway-Token': 'abc' });
  });

  it('resolves a central-env group with no tenantId, matching the env destination and project id', async () => {
    process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
    process.env.LANGFUSE_PUBLIC_KEY = 'env-public';
    process.env.LANGFUSE_SECRET_KEY = 'env-secret';
    process.env.LANGFUSE_PROJECT_ID = 'central-project-1';
    const findBaseConfig = jest.fn(async () => baseConfigDoc({ promptSync: { enabled: true } }));
    const getAppConfig = jest.fn(async () => appConfigWithLangfuse(undefined));
    const group: LangfuseSourceGroup = {
      tenantId: undefined,
      sourceDestination: 'env',
      sourceProjectId: 'central-project-1',
    };

    const result = await createLangfuseSourceResolver({ findBaseConfig, getAppConfig })(group);

    expect(result).toEqual({
      ok: true,
      connection: {
        baseUrl: 'https://cloud.langfuse.com',
        authorization: `Basic ${Buffer.from('env-public:env-secret').toString('base64')}`,
      },
    });
  });

  it('uses the env identity, not the stored tenant one, in single-tenant mode with env keys set', async () => {
    // The connection and the identity must pick the same mode: a single-tenant
    // deployment with env keys set reads from the env project even though the
    // admin also stored a tenant destination, so a group recorded against that
    // stored identity must no longer match.
    process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
    process.env.LANGFUSE_PUBLIC_KEY = 'env-public';
    process.env.LANGFUSE_SECRET_KEY = 'env-secret';
    process.env.LANGFUSE_PROJECT_ID = 'central-project-1';
    const deps = createDeps();
    const group: LangfuseSourceGroup = {
      tenantId: undefined,
      sourceDestination: 'us',
      sourceProjectId: 'tenant-project-1',
    };

    const result = await createLangfuseSourceResolver(deps)(group);

    expect(result).toEqual({ ok: false, reason: 'source_changed' });
  });

  it('propagates a failed env project lookup instead of returning source_changed', async () => {
    process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
    process.env.LANGFUSE_PUBLIC_KEY = 'env-public';
    process.env.LANGFUSE_SECRET_KEY = 'env-secret';
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 500 } as Response);
    const findBaseConfig = jest.fn(async () => baseConfigDoc({ promptSync: { enabled: true } }));
    const getAppConfig = jest.fn(async () => appConfigWithLangfuse(undefined));
    const group: LangfuseSourceGroup = {
      tenantId: undefined,
      sourceDestination: 'env',
      sourceProjectId: 'central-project-1',
    };

    await expect(
      createLangfuseSourceResolver({ findBaseConfig, getAppConfig })(group),
    ).rejects.toBeInstanceOf(LangfusePromptRequestError);
  });

  it('resolves normally when no getTimeoutMs is injected, against the always-10s project-lookup fetch', async () => {
    process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
    process.env.LANGFUSE_PUBLIC_KEY = 'env-public-resolver-default';
    process.env.LANGFUSE_SECRET_KEY = 'env-secret-resolver-default';
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'resolver-default-project' }] }),
    } as unknown as Response);
    const findBaseConfig = jest.fn(async () => baseConfigDoc({ promptSync: { enabled: true } }));
    const getAppConfig = jest.fn(async () => appConfigWithLangfuse(undefined));
    const group: LangfuseSourceGroup = {
      tenantId: undefined,
      sourceDestination: 'env',
      sourceProjectId: 'resolver-default-project',
    };

    await expect(
      createLangfuseSourceResolver({ findBaseConfig, getAppConfig })(group),
    ).resolves.toEqual({ ok: true, connection: expect.anything() });

    // The underlying project-lookup fetch always starts with the fixed
    // deployment-wide timeout, regardless of what bounds this call's own wait.
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
  });

  it('bounds this call by an injected getTimeoutMs: a fetch slower than that bound reports a timeout', async () => {
    process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
    process.env.LANGFUSE_PUBLIC_KEY = 'env-public-resolver-custom';
    process.env.LANGFUSE_SECRET_KEY = 'env-secret-resolver-custom';
    // Never settles within the test: the injected getTimeoutMs below is what
    // bounds this call, not the underlying fetch.
    jest.spyOn(global, 'fetch').mockImplementation(() => new Promise<Response>(() => {}));
    const findBaseConfig = jest.fn(async () => baseConfigDoc({ promptSync: { enabled: true } }));
    const getAppConfig = jest.fn(async () => appConfigWithLangfuse(undefined));
    const group: LangfuseSourceGroup = {
      tenantId: undefined,
      sourceDestination: 'env',
      sourceProjectId: 'resolver-custom-project',
    };

    const error: unknown = await createLangfuseSourceResolver({
      findBaseConfig,
      getAppConfig,
      getTimeoutMs: () => 20,
    })(group).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LangfusePromptRequestError);
    expect((error as LangfusePromptRequestError).code).toBe('timeout');
  });

  it('starts the base-config and app-config reads together, not one after the other', async () => {
    process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
    const baseConfigGate = deferred<IConfig | null>();
    const appConfigGate = deferred<AppConfig>();
    const findBaseConfig = jest.fn(() => baseConfigGate.promise);
    const getAppConfig = jest.fn(() => appConfigGate.promise);

    const resultPromise = tenantStorage.run({ tenantId: 'tenant-a' }, () =>
      createLangfuseSourceResolver({ findBaseConfig, getAppConfig })(matchingGroup()),
    );

    // Both reads have already started, before either settles.
    expect(findBaseConfig).toHaveBeenCalledTimes(1);
    expect(getAppConfig).toHaveBeenCalledTimes(1);

    appConfigGate.resolve(appConfigWithLangfuse(undefined));
    baseConfigGate.resolve(baseConfigDoc(tenantStoredConfig()));

    await expect(resultPromise).resolves.toEqual({ ok: true, connection: expect.anything() });
  });

  it('returns disabled with no unhandled rejection when getAppConfig rejects while prompt sync is off', async () => {
    process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const findBaseConfig = jest.fn(async () =>
        baseConfigDoc(tenantStoredConfig({ promptSync: { enabled: false } })),
      );
      const getAppConfig = jest.fn(async () => {
        throw new Error('app config boom');
      });

      const result = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
        createLangfuseSourceResolver({ findBaseConfig, getAppConfig })(matchingGroup()),
      );

      expect(result).toEqual({ ok: false, reason: 'disabled' });

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('propagates a findBaseConfig rejection', async () => {
    process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
    const findBaseConfig = jest.fn(async () => {
      throw new Error('base config boom');
    });
    const getAppConfig = jest.fn(async () => appConfigWithLangfuse(undefined));

    await expect(
      tenantStorage.run({ tenantId: 'tenant-a' }, () =>
        createLangfuseSourceResolver({ findBaseConfig, getAppConfig })(matchingGroup()),
      ),
    ).rejects.toThrow('base config boom');
  });

  it('propagates a getAppConfig rejection when prompt sync is enabled', async () => {
    process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
    const findBaseConfig = jest.fn(async () => baseConfigDoc(tenantStoredConfig()));
    const getAppConfig = jest.fn(async () => {
      throw new Error('app config boom');
    });

    await expect(
      tenantStorage.run({ tenantId: 'tenant-a' }, () =>
        createLangfuseSourceResolver({ findBaseConfig, getAppConfig })(matchingGroup()),
      ),
    ).rejects.toThrow('app config boom');
  });
});
