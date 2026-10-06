// --- Mocks ---
jest.mock('@librechat/data-schemas', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
  tenantStorage: { run: (_store, fn) => fn() },
}));

jest.mock('@librechat/api', () => ({
  findLdapUser: jest.requireActual('@librechat/api').findLdapUser,
  provisionLdapUser: jest.requireActual('@librechat/api').provisionLdapUser,
  isEnabled: jest.fn(() => false),
  isEmailDomainAllowed: jest.fn(() => true),
  getBalanceConfig: jest.fn(() => ({ enabled: false })),
  resolveAppConfigForUser: jest.fn(async (_getAppConfig, _user) => ({})),
}));

jest.mock('~/models', () => ({
  findUser: jest.fn(),
  createUserIfAbsent: jest.fn(),
  updateUser: jest.fn(),
  countUsers: jest.fn(),
  findBalanceByUser: jest.fn(),
}));

jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn().mockResolvedValue({}),
}));

// Mock passport-ldapauth to capture verify callback
let verifyCallback;
jest.mock('passport-ldapauth', () => {
  return jest.fn().mockImplementation((options, verify) => {
    verifyCallback = verify;
    return { name: 'ldap', options, verify };
  });
});

const { ErrorTypes } = require('librechat-data-provider');
const { isEmailDomainAllowed, resolveAppConfigForUser } = require('@librechat/api');
const { findUser, updateUser, countUsers, createUserIfAbsent } = require('~/models');
const { getAppConfig } = require('~/server/services/Config');

// Helper to call the verify callback and wrap in a Promise for convenience
const callVerify = (userinfo) =>
  new Promise((resolve, reject) => {
    verifyCallback(userinfo, (err, user, info) => {
      if (err) return reject(err);
      resolve({ user, info });
    });
  });

describe('ldapStrategy', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // minimal required env for ldapStrategy module to export
    process.env.LDAP_URL = 'ldap://example.com';
    process.env.LDAP_USER_SEARCH_BASE = 'ou=users,dc=example,dc=com';

    // Unset optional envs to exercise defaults
    delete process.env.LDAP_CA_CERT_PATH;
    delete process.env.LDAP_FULL_NAME;
    delete process.env.LDAP_ID;
    delete process.env.LDAP_USERNAME;
    delete process.env.LDAP_EMAIL;
    delete process.env.LDAP_TLS_REJECT_UNAUTHORIZED;
    delete process.env.LDAP_STARTTLS;

    // Default model/domain mocks
    findUser.mockReset().mockResolvedValue(null);
    createUserIfAbsent
      .mockReset()
      .mockImplementation(async (data) => ({ ok: true, value: { _id: 'newUserId', ...data } }));
    updateUser.mockReset().mockImplementation(async (id, user) => ({ _id: id, ...user }));
    countUsers.mockReset().mockResolvedValue(0);
    isEmailDomainAllowed.mockReset().mockReturnValue(true);

    // Ensure requiring the strategy sets up the verify callback
    jest.isolateModules(() => {
      require('./ldapStrategy');
    });
  });

  it('uses the first email when LDAP returns multiple emails (array)', async () => {
    const userinfo = {
      uid: 'uid123',
      givenName: 'Alice',
      cn: 'Alice Doe',
      mail: ['first@example.com', 'second@example.com'],
    };

    const { user } = await callVerify(userinfo);

    expect(user.email).toBe('first@example.com');
    expect(createUserIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'ldap',
        ldapId: 'uid123',
        username: 'Alice',
        email: 'first@example.com',
        emailVerified: true,
        name: 'Alice Doe',
      }),
      expect.any(Object),
    );
  });

  it('blocks login if an existing user has a different provider', async () => {
    findUser.mockResolvedValue({ _id: 'u1', email: 'first@example.com', provider: 'google' });

    const userinfo = {
      uid: 'uid123',
      mail: 'first@example.com',
      givenName: 'Alice',
      cn: 'Alice Doe',
    };

    const { user, info } = await callVerify(userinfo);

    expect(user).toBe(false);
    expect(info).toEqual({ message: ErrorTypes.AUTH_FAILED });
    expect(createUserIfAbsent).not.toHaveBeenCalled();
    expect(resolveAppConfigForUser).not.toHaveBeenCalled();
  });

  it('updates an existing ldap user with current LDAP info', async () => {
    const existing = {
      _id: 'u2',
      provider: 'ldap',
      email: 'old@example.com',
      ldapId: 'uid123',
      username: 'olduser',
      name: 'Old Name',
    };
    findUser.mockResolvedValue(existing);

    const userinfo = {
      uid: 'uid123',
      mail: 'new@example.com',
      givenName: 'NewFirst',
      cn: 'NewFirst NewLast',
    };

    const { user } = await callVerify(userinfo);

    expect(createUserIfAbsent).not.toHaveBeenCalled();
    expect(updateUser).toHaveBeenCalledWith(
      'u2',
      expect.objectContaining({
        provider: 'ldap',
        ldapId: 'uid123',
        email: 'new@example.com',
        username: 'NewFirst',
        name: 'NewFirst NewLast',
      }),
    );
    expect(user.email).toBe('new@example.com');
  });

  it('falls back to username@ldap.local when no email attributes are present', async () => {
    const userinfo = {
      uid: 'uid999',
      givenName: 'John',
      cn: 'John Doe',
    };

    const { user } = await callVerify(userinfo);

    expect(user.email).toBe('John@ldap.local');
  });

  it('denies login if email domain is not allowed', async () => {
    isEmailDomainAllowed.mockReturnValue(false);

    const userinfo = {
      uid: 'uid123',
      mail: 'notallowed@blocked.com',
      givenName: 'Alice',
      cn: 'Alice Doe',
    };

    const { user, info } = await callVerify(userinfo);
    expect(user).toBe(false);
    expect(info).toEqual({ message: 'Email domain not allowed' });
  });

  it('passes getAppConfig and found user to resolveAppConfigForUser', async () => {
    const existing = {
      _id: 'u3',
      provider: 'ldap',
      email: 'tenant@example.com',
      ldapId: 'uid-tenant',
      username: 'tenantuser',
      name: 'Tenant User',
      tenantId: 'tenant-a',
      role: 'USER',
    };
    findUser.mockResolvedValue(existing);

    const userinfo = {
      uid: 'uid-tenant',
      mail: 'tenant@example.com',
      givenName: 'Tenant',
      cn: 'Tenant User',
    };

    await callVerify(userinfo);

    expect(resolveAppConfigForUser).toHaveBeenCalledWith(getAppConfig, existing);
  });

  it('uses baseConfig for new user without calling resolveAppConfigForUser', async () => {
    findUser.mockResolvedValue(null);

    const userinfo = {
      uid: 'uid-new',
      mail: 'newuser@example.com',
      givenName: 'New',
      cn: 'New User',
    };

    await callVerify(userinfo);

    expect(resolveAppConfigForUser).not.toHaveBeenCalled();
    expect(getAppConfig).toHaveBeenCalledWith({ baseOnly: true });
  });

  it('should block login when tenant config restricts the domain', async () => {
    const existing = {
      _id: 'u-blocked',
      provider: 'ldap',
      ldapId: 'uid-tenant',
      tenantId: 'tenant-strict',
      role: 'USER',
    };
    findUser.mockResolvedValue(existing);
    resolveAppConfigForUser.mockResolvedValue({
      registration: { allowedDomains: ['other.com'] },
    });
    isEmailDomainAllowed.mockReturnValueOnce(true).mockReturnValueOnce(false);

    const userinfo = { uid: 'uid-tenant', mail: 'user@example.com', givenName: 'Test', cn: 'Test' };
    const { user, info } = await callVerify(userinfo);

    expect(user).toBe(false);
    expect(info).toEqual({ message: 'Email domain not allowed' });
  });

  describe('concurrent first login', () => {
    const userinfo = {
      uid: 'uid-race',
      mail: 'race@example.com',
      givenName: 'Race',
      cn: 'Race User',
    };

    const raceCreateWith = (existingUser) => {
      let created = false;
      findUser.mockImplementation(async (query) =>
        created && query.ldapId === existingUser.ldapId ? existingUser : null,
      );
      createUserIfAbsent.mockImplementation(async () => {
        created = true;
        return { ok: false, error: { code: 'user_exists' } };
      });
    };

    it("continues as the other request's account with this login's LDAP values", async () => {
      raceCreateWith({
        _id: 'winner-id',
        provider: 'ldap',
        ldapId: 'uid-race',
        email: 'old@example.com',
        username: 'old-username',
        name: 'Old Name',
        role: 'USER',
      });

      const { user } = await callVerify(userinfo);

      expect(createUserIfAbsent).toHaveBeenCalledTimes(1);
      expect(updateUser).toHaveBeenCalledWith(
        'winner-id',
        expect.objectContaining({
          ldapId: 'uid-race',
          email: 'race@example.com',
          username: 'Race',
          name: 'Race User',
          role: 'USER',
        }),
      );
      expect(user).toEqual(expect.objectContaining({ _id: 'winner-id' }));
    });

    it("fails the login when the recovered tenant account's policy rejects the email", async () => {
      getAppConfig.mockImplementation(async (options) =>
        options?.tenantId ? { registration: { allowedDomains: ['other.example'] } } : {},
      );
      raceCreateWith({
        _id: 'tenant-id',
        provider: 'ldap',
        ldapId: 'uid-race',
        tenantId: 'tenant-a',
      });

      const { user, info } = await callVerify(userinfo);

      expect(user).toBe(false);
      expect(info).toEqual({ message: 'Email domain not allowed' });
      expect(updateUser).not.toHaveBeenCalled();
      getAppConfig.mockResolvedValue({});
    });

    it('fails the login when the recovered account belongs to another provider', async () => {
      raceCreateWith({ _id: 'google-id', provider: 'google', ldapId: 'uid-race' });

      const { user, info } = await callVerify(userinfo);

      expect(user).toBe(false);
      expect(info).toEqual({ message: ErrorTypes.AUTH_FAILED });
      expect(updateUser).not.toHaveBeenCalled();
    });
  });
});
