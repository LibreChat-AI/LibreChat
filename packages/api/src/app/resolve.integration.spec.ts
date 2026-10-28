import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { SystemRoles, PrincipalModel, PrincipalType } from 'librechat-data-provider';
import {
  logger,
  AppService,
  createModels,
  runAsSystem,
  createMethods,
  tenantStorage,
  BASE_CONFIG_PRINCIPAL_ID,
} from '@librechat/data-schemas';
import type { TCustomConfig } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import {
  resolveAppConfigForUser,
  resolvePreAuthAppConfig,
  resolvePreLoginAppConfig,
} from './resolve';
import { isEmailDomainAllowed } from '~/auth/domain';
import { buildPreLoginInterface } from './interface';
import { createAppConfigService } from './service';
import { createUserOnce } from '~/auth/provision';

/**
 * Pre-auth config resolution end to end: the real config service and the real config methods
 * over MongoDB, with librechat.yaml stood in by `AppService` on a fixed config.
 */

type Methods = ReturnType<typeof createMethods>;
type Overrides = Partial<TCustomConfig>;

const YAML: Parameters<typeof AppService>[0] = {
  config: {
    registration: { socialLogins: ['github'] },
    turnstile: { siteKey: 'yaml-site-key' },
    interface: { privacyPolicy: { externalUrl: 'https://yaml.example/privacy' } },
  },
};

let mongoServer: MongoMemoryServer;
let methods: Methods;

function createCache() {
  const store = new Map<string, unknown>();
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => {
      store.set(key, value);
      return true;
    },
    delete: async (key: string) => store.delete(key),
  };
}

/** A fresh service per test, so no merged config is served from an earlier test's cache. */
function createService(getApplicableConfigs: Methods['getApplicableConfigs']) {
  const cache = createCache();
  return createAppConfigService({
    loadBaseConfig: () => AppService(YAML),
    setCachedTools: async () => undefined,
    getCache: () => cache,
    cacheKeys: { APP_CONFIG: 'app_config' },
    getApplicableConfigs,
    getUserPrincipals: methods.getUserPrincipals,
  }).getAppConfig;
}

function storeOverrides(principalId: string, overrides: Overrides, priority = 10) {
  return methods.upsertConfig(
    PrincipalType.ROLE,
    principalId,
    PrincipalModel.ROLE,
    overrides,
    principalId === BASE_CONFIG_PRINCIPAL_ID ? 0 : priority,
  );
}

const inTenant = <T>(tenantId: string, fn: () => Promise<T>): Promise<T> =>
  tenantStorage.run({ tenantId }, fn);

const domains = (config: AppConfig): string[] | undefined =>
  config.registration?.allowedDomains ?? undefined;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  /** Building every model's indexes is slow and none of these queries depends on one. */
  await mongoose.connect(mongoServer.getUri(), { autoIndex: false });
  createModels(mongoose);
  methods = createMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Promise.all([mongoose.models.Config.deleteMany({}), mongoose.models.User.deleteMany({})]);
  jest.spyOn(logger, 'error').mockReturnValue(logger);
  jest.spyOn(logger, 'info').mockReturnValue(logger);
});

describe('pre-auth allowedDomains', () => {
  beforeEach(async () => {
    await storeOverrides(BASE_CONFIG_PRINCIPAL_ID, {
      registration: { allowedDomains: ['corp.example', 'partner.example'] },
    });
    await inTenant('tenant-b', () =>
      storeOverrides(BASE_CONFIG_PRINCIPAL_ID, {
        registration: { allowedDomains: ['tenant-b.example'] },
      }),
    );
    await storeOverrides('USER', { registration: { allowedDomains: ['corp.example'] } });
    await inTenant('tenant-b', () =>
      storeOverrides('USER', { registration: { allowedDomains: ['open.example'] } }),
    );
  });

  it("applies the deployment's __base__ override before the user is known", async () => {
    const getAppConfig = createService(methods.getApplicableConfigs);

    const config = await resolvePreAuthAppConfig(getAppConfig);

    expect(domains(config)).toEqual(['corp.example', 'partner.example']);
    expect(isEmailDomainAllowed('eve@elsewhere.example', domains(config))).toBe(false);
  });

  it("never merges another tenant's __base__ into the deployment's", async () => {
    const getAppConfig = createService(methods.getApplicableConfigs);

    const config = await resolvePreAuthAppConfig(getAppConfig);

    expect(isEmailDomainAllowed('bob@tenant-b.example', domains(config))).toBe(false);
  });

  it("applies the tenant's own __base__ inside a tenant", async () => {
    const getAppConfig = createService(methods.getApplicableConfigs);

    const config = await inTenant('tenant-b', () => resolvePreAuthAppConfig(getAppConfig));

    expect(domains(config)).toEqual(['tenant-b.example']);
  });

  it('keeps each tenant and the deployment apart in one shared cache', async () => {
    const getAppConfig = createService(methods.getApplicableConfigs);

    const tenantB = await inTenant('tenant-b', () => resolvePreAuthAppConfig(getAppConfig));
    const tenantA = await inTenant('tenant-a', () => resolvePreAuthAppConfig(getAppConfig));
    const deployment = await resolvePreAuthAppConfig(getAppConfig);

    expect(domains(tenantB)).toEqual(['tenant-b.example']);
    expect(domains(tenantA)).toBeUndefined();
    expect(domains(deployment)).toEqual(['corp.example', 'partner.example']);
  });

  it("reads only the deployment's __base__ under the system sentinel", async () => {
    const getAppConfig = createService(methods.getApplicableConfigs);

    const config = await runAsSystem(() => resolvePreAuthAppConfig(getAppConfig));

    expect(domains(config)).toEqual(['corp.example', 'partner.example']);
  });

  it('narrows the list by role for a known user without a tenant', async () => {
    const getAppConfig = createService(methods.getApplicableConfigs);

    const config = await resolveAppConfigForUser(getAppConfig, { role: 'USER' });

    expect(domains(config)).toEqual(['corp.example']);
    expect(isEmailDomainAllowed('pat@partner.example', domains(config))).toBe(false);
  });

  it("resolves a tenant user's role in that tenant only", async () => {
    const getAppConfig = createService(methods.getApplicableConfigs);

    const config = await resolveAppConfigForUser(getAppConfig, {
      role: 'USER',
      tenantId: 'tenant-b',
    });

    expect(domains(config)).toEqual(['open.example']);
  });

  describe('a first sign-in, under the role the new account is created with', () => {
    function firstLogin(
      getAppConfig: ReturnType<typeof createService>,
      email: string,
      role?: string,
    ) {
      return createUserOnce({
        newUser: { provider: 'saml', samlId: email, email, username: email, role },
        email,
        getAppConfig,
        getBalanceConfig: () => null,
        lookup: async () => ({ user: await methods.findUser({ email }), error: null }),
        strategyName: 'samlStrategy',
        createUserIfAbsent: methods.createUserIfAbsent,
        findBalanceByUser: methods.findBalanceByUser,
      });
    }

    it("refuses a domain the USER role's list excludes, creating nothing", async () => {
      const getAppConfig = createService(methods.getApplicableConfigs);

      const result = await firstLogin(getAppConfig, 'pat@partner.example');

      expect(result).toEqual({ user: null, error: 'Email domain not allowed', created: false });
      expect(await mongoose.models.User.countDocuments()).toBe(0);
    });

    it("creates the account when the USER role's list admits the domain", async () => {
      const getAppConfig = createService(methods.getApplicableConfigs);

      const result = await firstLogin(getAppConfig, 'cam@corp.example');

      expect(result.created).toBe(true);
      expect(result.user && domains(result.appConfig)).toEqual(['corp.example']);
    });

    it("admits an ADMIN account under the ADMIN role's config", async () => {
      const getAppConfig = createService(methods.getApplicableConfigs);

      const result = await firstLogin(getAppConfig, 'pat@partner.example', SystemRoles.ADMIN);

      expect(result.user).toEqual(expect.objectContaining({ role: SystemRoles.ADMIN }));
    });
  });

  it('fails closed when overrides cannot be read', async () => {
    const getApplicableConfigs = jest
      .fn<
        ReturnType<Methods['getApplicableConfigs']>,
        Parameters<Methods['getApplicableConfigs']>
      >()
      .mockRejectedValue(new Error('override read failed'));
    const getAppConfig = createService(getApplicableConfigs);

    await expect(resolvePreAuthAppConfig(getAppConfig)).rejects.toThrow('override read failed');
    await expect(resolveAppConfigForUser(getAppConfig, { role: 'USER' })).rejects.toThrow(
      'override read failed',
    );
  });
});

describe('signed-out startup config', () => {
  beforeEach(async () => {
    await storeOverrides(BASE_CONFIG_PRINCIPAL_ID, {
      registration: { socialLogins: ['google', 'openid'] },
      turnstile: { siteKey: 'stored-site-key' },
      interface: { privacyPolicy: { externalUrl: 'https://base.example/privacy' } },
    });
    await inTenant('tenant-a', () =>
      storeOverrides(BASE_CONFIG_PRINCIPAL_ID, {
        registration: { socialLogins: ['discord'] },
        turnstile: { siteKey: 'tenant-a-site-key' },
      }),
    );
    await storeOverrides('USER', { registration: { socialLogins: ['facebook'] } });
  });

  it('serves the __base__ override, keeping Turnstile on librechat.yaml', async () => {
    const getAppConfig = createService(methods.getApplicableConfigs);

    const config = await resolvePreLoginAppConfig(getAppConfig);

    expect(config.registration?.socialLogins).toEqual(['google', 'openid']);
    expect(config.interfaceConfig?.privacyPolicy?.externalUrl).toBe('https://base.example/privacy');
    expect(config.turnstileConfig?.siteKey).toBe('yaml-site-key');
  });

  it("serves a tenant its own __base__, but Turnstile from librechat.yaml, not the tenant's", async () => {
    const getAppConfig = createService(methods.getApplicableConfigs);

    const config = await inTenant('tenant-a', () => resolvePreLoginAppConfig(getAppConfig));

    expect(config.registration?.socialLogins).toEqual(['discord']);
    expect(config.turnstileConfig?.siteKey).toBe('yaml-site-key');
  });

  it('keeps Turnstile on librechat.yaml for a signed-in user too', async () => {
    await storeOverrides('USER', { turnstile: { siteKey: 'role-site-key' } });
    const getAppConfig = createService(methods.getApplicableConfigs);

    const config = await getAppConfig({ role: 'USER' });

    expect(config.turnstileConfig?.siteKey).toBe('yaml-site-key');
  });

  it('drops a stored script URL from the policy links, keeping their other settings', async () => {
    const warn = jest.spyOn(logger, 'warn').mockReturnValue(logger);
    await storeOverrides(BASE_CONFIG_PRINCIPAL_ID, {
      interface: {
        privacyPolicy: { externalUrl: 'javascript:alert(document.domain)', openNewTab: true },
        termsOfService: { externalUrl: 'https://base.example/terms' },
      },
    });
    const getAppConfig = createService(methods.getApplicableConfigs);

    const config = await resolvePreLoginAppConfig(getAppConfig);

    expect(config.interfaceConfig?.privacyPolicy).toEqual({
      externalUrl: 'https://yaml.example/privacy',
      openNewTab: true,
    });
    expect(buildPreLoginInterface(config.interfaceConfig)).toEqual({
      privacyPolicy: { externalUrl: 'https://yaml.example/privacy', openNewTab: true },
      termsOfService: { externalUrl: 'https://base.example/terms' },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Ignoring invalid override "interface.privacyPolicy.externalUrl"'),
    );
  });

  it('falls back to librechat.yaml when overrides cannot be read', async () => {
    const getApplicableConfigs = jest
      .fn<
        ReturnType<Methods['getApplicableConfigs']>,
        Parameters<Methods['getApplicableConfigs']>
      >()
      .mockRejectedValue(new Error('override read failed'));
    const getAppConfig = createService(getApplicableConfigs);

    const config = await resolvePreLoginAppConfig(getAppConfig);

    expect(config.registration?.socialLogins).toEqual(['github']);
    expect(config.turnstileConfig?.siteKey).toBe('yaml-site-key');
  });

  it('reads the overrides once per cache lifetime', async () => {
    const getApplicableConfigs = jest.fn(methods.getApplicableConfigs);
    const getAppConfig = createService(getApplicableConfigs);

    await resolvePreLoginAppConfig(getAppConfig);
    await resolvePreLoginAppConfig(getAppConfig);
    await resolvePreAuthAppConfig(getAppConfig);

    expect(getApplicableConfigs).toHaveBeenCalledTimes(1);
    expect(getApplicableConfigs).toHaveBeenCalledWith([]);
  });
});
