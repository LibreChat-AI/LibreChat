import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ErrorTypes, SystemRoles } from 'librechat-data-provider';
import { tenantStorage, createMethods, createModels } from '@librechat/data-schemas';
import type { IUser, AppConfig, UserRecord } from '@librechat/data-schemas';
import type { LoginUserResolution } from './provision';
import { provisionSocialUser } from './social';
import { createUserOnce } from './provision';
import { provisionSamlUser } from './saml';
import { provisionLdapUser } from './ldap';

let mongoServer: MongoMemoryServer;
let User: mongoose.Model<IUser>;
let methods: ReturnType<typeof createMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri(), { autoIndex: false });
  createModels(mongoose);
  User = mongoose.models.User as mongoose.Model<IUser>;
  methods = createMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  await User.syncIndexes();
});

function findBalanceByUser(userId: string) {
  return methods.findBalanceByUser(userId);
}

function appConfigWith(
  allowedDomains?: string[],
  balance?: { enabled: boolean; startBalance: number },
): AppConfig {
  return { balance, registration: { allowedDomains } } as Partial<AppConfig> as AppConfig;
}

const baseConfig = appConfigWith();
const getAppConfig = jest.fn(async (): Promise<AppConfig> => baseConfig);
const getBalanceConfig = (config: AppConfig) => config.balance ?? null;
const admission = { appConfig: baseConfig, getAppConfig, getBalanceConfig };

describe('createUserOnce', () => {
  const email = 'first-login@example.com';
  const newUser = { provider: 'saml', samlId: 'first-login-name-id', email, username: 'first' };

  function lookupByEmail() {
    return methods.findUser({ email }).then((user) => ({ user, error: null }));
  }

  function firstLogin(
    lookup: () => Promise<LoginUserResolution> = lookupByEmail,
    overrides: Partial<Parameters<typeof createUserOnce>[0]> = {},
  ) {
    return createUserOnce({
      newUser,
      email,
      ...admission,
      lookup,
      strategyName: 'test',
      createUserIfAbsent: methods.createUserIfAbsent,
      findBalanceByUser,
      ...overrides,
    });
  }

  it('creates once and resolves the concurrent login to the created account', async () => {
    const results = await Promise.all([firstLogin(), firstLogin()]);

    expect(await User.countDocuments({ email })).toBe(1);
    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(results[0].user?._id.toString()).toBe(results[1].user?._id.toString());
  });

  it("returns the lookup's error when it rejects the account that won", async () => {
    await firstLogin();

    const result = await firstLogin(async () => ({ user: null, error: 'auth_failed' }));

    expect(result).toEqual({ user: null, error: 'auth_failed', created: false });
  });

  it('fails the recovered login while the winner has not credited its start balance yet', async () => {
    await User.create(newUser);

    const result = await firstLogin(lookupByEmail, {
      appConfig: appConfigWith(undefined, { enabled: true, startBalance: 500 }),
    });

    expect(result).toEqual({ user: null, error: ErrorTypes.AUTH_FAILED, created: false });
  });

  it('recovers once the winner has credited its start balance', async () => {
    const appConfig = appConfigWith(undefined, { enabled: true, startBalance: 500 });
    const winner = await firstLogin(lookupByEmail, { appConfig });

    const loser = await firstLogin(lookupByEmail, { appConfig });

    expect(loser.created).toBe(false);
    expect(loser.user?._id.toString()).toBe(winner.user?._id.toString());
  });

  it("applies the recovered tenant account's email-domain policy", async () => {
    const tenantId = 'tenant-a';
    await tenantStorage.run({ tenantId }, () => User.create(newUser));
    getAppConfig.mockResolvedValueOnce(appConfigWith(['other.example']));

    const result = await tenantStorage.run({ tenantId }, () => firstLogin());

    expect(result).toEqual({ user: null, error: 'Email domain not allowed', created: false });
    expect(getAppConfig).toHaveBeenCalledWith(expect.objectContaining({ tenantId }));
  });

  it("continues when only the recovered tenant account's config sets a start balance", async () => {
    const tenantId = 'tenant-a';
    await tenantStorage.run({ tenantId }, () => User.create(newUser));
    getAppConfig.mockResolvedValueOnce(
      appConfigWith(undefined, { enabled: true, startBalance: 500 }),
    );

    const result = await tenantStorage.run({ tenantId }, () => firstLogin());

    expect(result).toEqual(expect.objectContaining({ created: false, error: null }));
  });

  it('reads the tenant config and the start balance together', async () => {
    const tenantId = 'tenant-a';
    const appConfig = appConfigWith(undefined, { enabled: true, startBalance: 500 });
    await tenantStorage.run({ tenantId }, () => firstLogin(lookupByEmail, { appConfig }));
    let configResolved = false;
    let balanceReadBeforeConfig = false;
    getAppConfig.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      configResolved = true;
      return baseConfig;
    });

    const result = await tenantStorage.run({ tenantId }, () =>
      firstLogin(lookupByEmail, {
        appConfig,
        findBalanceByUser: (userId) => {
          balanceReadBeforeConfig = !configResolved;
          return findBalanceByUser(userId);
        },
      }),
    );

    expect(result).toEqual(expect.objectContaining({ created: false, error: null }));
    expect(balanceReadBeforeConfig).toBe(true);
  });

  it("continues under the recovered tenant account's config when it admits the email", async () => {
    const tenantId = 'tenant-a';
    await tenantStorage.run({ tenantId }, () => User.create(newUser));
    const tenantConfig = appConfigWith(['example.com']);
    getAppConfig.mockResolvedValueOnce(tenantConfig);

    const result = await tenantStorage.run({ tenantId }, () => firstLogin());

    expect(result).toEqual(
      expect.objectContaining({ created: false, error: null, appConfig: tenantConfig }),
    );
  });

  it('throws when the lookup cannot account for the existing account', async () => {
    await firstLogin();

    const login = firstLogin(async () => ({ user: null, error: null }));

    await expect(login).rejects.toThrow('conflicts with an account the lookup cannot resolve');
  });

  it('rethrows other create failures without repeating the lookup', async () => {
    const lookup = jest.fn(lookupByEmail);

    const login = firstLogin(lookup, { newUser: { ...newUser, email: 'not-an-email' } });

    await expect(login).rejects.toMatchObject({ name: 'ValidationError' });
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('provisionSamlUser', () => {
  const nameID = 'saml-name-id';
  const email = 'saml@example.com';

  function samlLogin(
    user: UserRecord | null,
    profile = { username: 'saml-user', name: 'Saml User' },
  ) {
    return provisionSamlUser({
      user,
      nameID,
      email,
      ...profile,
      ...admission,
      findUser: methods.findUser,
      createUserIfAbsent: methods.createUserIfAbsent,
      findBalanceByUser,
      claimSamlIdentity: methods.claimSamlIdentity,
    });
  }

  it("claims the account a concurrent first login created with this login's profile", async () => {
    const winner = await samlLogin(null);

    const loser = await samlLogin(null, { username: 'renamed', name: 'Renamed User' });

    expect(await User.countDocuments()).toBe(1);
    expect(loser.user?._id.toString()).toBe(winner.user?._id.toString());
    expect(loser.user).toEqual(
      expect.objectContaining({ samlId: nameID, username: 'renamed', name: 'Renamed User' }),
    );
  });

  it('fails the login when another provider took the email in the meantime', async () => {
    await User.create({ email, provider: 'local', username: 'local-user' });

    const result = await samlLogin(null);

    expect(result).toEqual({ user: null, error: ErrorTypes.AUTH_FAILED });
  });
});

describe('provisionLdapUser', () => {
  const ldapId = 'ldap-uid';

  function ldapLogin(
    user: UserRecord | null,
    values = { email: 'ldap@example.com', username: 'ldap' },
  ) {
    return provisionLdapUser({
      user,
      ldapId,
      name: 'Ldap User',
      ...values,
      ...admission,
      findUser: methods.findUser,
      countUsers: () => methods.countUsers(),
      createUserIfAbsent: methods.createUserIfAbsent,
      findBalanceByUser,
    });
  }

  it('creates the first deployment user as ADMIN', async () => {
    const result = await ldapLogin(null);

    expect(result.user).toEqual(expect.objectContaining({ ldapId, role: SystemRoles.ADMIN }));
  });

  it("carries this login's directory values onto the account a concurrent first login created", async () => {
    const winner = await ldapLogin(null);

    const loser = await ldapLogin(null, { email: 'moved@example.com', username: 'moved' });

    expect(await User.countDocuments()).toBe(1);
    expect(loser.user?._id.toString()).toBe(winner.user?._id.toString());
    expect(loser.user).toEqual(
      expect.objectContaining({
        provider: 'ldap',
        email: 'moved@example.com',
        username: 'moved',
        role: SystemRoles.ADMIN,
      }),
    );
  });
});

describe('provisionSocialUser', () => {
  const email = 'social@example.com';
  const newUser = { email, provider: 'google', googleId: 'google-sub', username: 'social' };

  function socialLogin() {
    const finishNewUser = jest.fn(async (user: UserRecord) => user);
    const refreshExistingUser = jest.fn(async () => undefined);
    const login = provisionSocialUser({
      lookup: { findUser: methods.findUser, provider: 'google', providerId: 'google-sub', email },
      newUser,
      ...admission,
      createUserIfAbsent: methods.createUserIfAbsent,
      findBalanceByUser,
      finishNewUser,
      refreshExistingUser,
    });
    return { login, finishNewUser, refreshExistingUser };
  }

  it('refreshes the account a concurrent first login created instead of finishing it again', async () => {
    const winner = socialLogin();
    const created = await winner.login;

    const loser = socialLogin();
    const recovered = await loser.login;

    expect(recovered._id.toString()).toBe(created._id.toString());
    expect(winner.finishNewUser).toHaveBeenCalledTimes(1);
    expect(loser.finishNewUser).not.toHaveBeenCalled();
    expect(loser.refreshExistingUser).toHaveBeenCalledWith(
      expect.objectContaining({ _id: created._id }),
      baseConfig,
    );
  });

  it('throws the coded AUTH_FAILED error when another provider took the email', async () => {
    await User.create({ email, provider: 'local', username: 'local-user' });

    const { login, refreshExistingUser } = socialLogin();

    await expect(login).rejects.toMatchObject({ code: ErrorTypes.AUTH_FAILED });
    expect(refreshExistingUser).not.toHaveBeenCalled();
  });
});
