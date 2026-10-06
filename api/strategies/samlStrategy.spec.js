// --- Mocks ---
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn(actual.existsSync),
    statSync: jest.fn(actual.statSync),
    readFileSync: jest.fn(actual.readFileSync),
  };
});
jest.mock('path', () => {
  const actual = jest.requireActual('path');
  return {
    ...actual,
    isAbsolute: jest.fn(actual.isAbsolute),
    join: jest.fn(actual.join),
    normalize: jest.fn(actual.normalize),
  };
});
jest.mock('node-fetch');
jest.mock('@node-saml/passport-saml');
jest.mock('@librechat/data-schemas', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  hashToken: jest.fn().mockResolvedValue('hashed-token'),
  tenantStorage: { run: (_store, fn) => fn() },
}));
jest.mock('~/models', () => ({
  findUser: jest.fn(),
  createUserIfAbsent: jest.fn(),
  updateUser: jest.fn(),
  claimSamlIdentity: jest.fn(),
  findBalanceByUser: jest.fn(),
}));
jest.mock('~/server/services/Config', () => ({
  config: {
    registration: {
      socialLogins: ['saml'],
    },
  },
  getAppConfig: jest.fn().mockResolvedValue({}),
}));
jest.mock('@librechat/api', () => ({
  findSamlUser: jest.requireActual('@librechat/api').findSamlUser,
  provisionSamlUser: jest.requireActual('@librechat/api').provisionSamlUser,
  isEmailDomainAllowed: jest.fn(() => true),
  getBalanceConfig: jest.fn(() => ({
    tokenCredits: 1000,
    startBalance: 1000,
  })),
  getAvatarFileStrategy: jest.fn((config, fallbackStrategy) => {
    const { FileSources } = jest.requireActual('librechat-data-provider');
    if (config?.fileStrategies) {
      return config.fileStrategies.avatar ?? config.fileStrategies.default ?? config.fileStrategy;
    }
    return config?.fileStrategy ?? fallbackStrategy ?? FileSources.local;
  }),
  getAvatarSaveParams: jest.fn((strategy, params) => {
    const { FileSources } = jest.requireActual('librechat-data-provider');
    return strategy === FileSources.s3 || strategy === FileSources.cloudfront
      ? { ...params, basePath: 'avatars' }
      : params;
  }),
  resolveAppConfigForUser: jest.fn(async (_getAppConfig, _user) => ({})),
  resolveSamlSubject: jest.fn((profile) => ({ nameID: profile.nameID })),
  TRANSIENT_SAML_NAME_ID_FORMAT: 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient',
}));
jest.mock('~/server/services/Config/EndpointService', () => ({
  config: {},
}));
jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(() => ({
    saveBuffer: jest.fn().mockResolvedValue('/fake/path/to/avatar.png'),
  })),
}));
jest.mock('~/server/services/Files/images/avatar', () => ({
  resizeAvatar: jest.fn().mockResolvedValue(Buffer.from('safe avatar')),
}));
jest.mock('~/config/paths', () => ({
  root: '/fake/root/path',
}));

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { Strategy: SamlStrategy } = require('@node-saml/passport-saml');
const { FileSources } = require('librechat-data-provider');
const { findUser } = require('~/models');
const { resolveAppConfigForUser } = require('@librechat/api');
const { resizeAvatar } = require('~/server/services/Files/images/avatar');
const { getAppConfig } = require('~/server/services/Config');
const { setupSaml, getCertificateContent } = require('./samlStrategy');

// Configure fs mock
jest.mocked(fs).existsSync = jest.fn();
jest.mocked(fs).statSync = jest.fn();
jest.mocked(fs).readFileSync = jest.fn();

const verifyCallbacks = new Map();
SamlStrategy.mockImplementation((options, verify) => {
  const strategyName = options.callbackUrl?.includes('/api/admin/') ? 'samlAdmin' : 'saml';
  verifyCallbacks.set(strategyName, verify);
  return { name: strategyName, options, verify };
});

describe('getCertificateContent', () => {
  const certWithHeader = `-----BEGIN CERTIFICATE-----
MIIDazCCAlOgAwIBAgIUKhXaFJGJJPx466rlwYORIsqCq7MwDQYJKoZIhvcNAQEL
BQAwRTELMAkGA1UEBhMCQVUxEzARBgNVBAgMClNvbWUtU3RhdGUxITAfBgNVBAoM
GEludGVybmV0IFdpZGdpdHMgUHR5IEx0ZDAeFw0yNTAzMDQwODUxNTJaFw0yNjAz
MDQwODUxNTJaMEUxCzAJBgNVBAYTAkFVMRMwEQYDVQQIDApTb21lLVN0YXRlMSEw
HwYDVQQKDBhJbnRlcm5ldCBXaWRnaXRzIFB0eSBMdGQwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCWP09NZg0xaRiLpNygCVgV3M+4RFW2S0c5X/fg/uFT
O5MfaVYzG5GxzhXzWRB8RtNPsxX/nlbPsoUroeHbz+SABkOsNEv6JuKRH4VXRH34
VzjazVkPAwj+N4WqsC/Wo4EGGpKIGeGi8Zed4yvMqoTyE3mrS19fY0nMHT62wUwS
GMm2pAQdAQePZ9WY7A5XOA1IoxW2Zh2Oxaf1p59epBkZDhoxSMu8GoSkvK27Km4A
4UXftzdg/wHNPrNirmcYouioHdmrOtYxPjrhUBQ74AmE1/QK45B6wEgirKH1A1AW
6C+ApLwpBMvy9+8Gbyvc8G18W3CjdEVKmAeWb9JUedSXAgMBAAGjUzBRMB0GA1Ud
DgQWBBRxpaqBx8VDLLc8IkHATujj8IOs6jAfBgNVHSMEGDAWgBRxpaqBx8VDLLc8
IkHATujj8IOs6jAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQBc
Puk6i+yowwGccB3LhfxZ+Fz6s6/Lfx6bP/Hy4NYOxmx2/awGBgyfp1tmotjaS9Cf
FWd67LuEru4TYtz12RNMDBF5ypcEfibvb3I8O6igOSQX/Jl5D2pMChesZxhmCift
Qp09T41MA8PmHf1G9oMG0A3ZnjKDG5ebaJNRFImJhMHsgh/TP7V3uZy7YHTgopKX
Hv63V3Uo3Oihav29Q7urwmf7Ly7X7J2WE86/w3vRHi5dhaWWqEqxmnAXl+H+sG4V
meeVRI332bg1Nuy8KnnX8v3ZeJzMBkAhzvSr6Ri96R0/Un/oEFwVC5jDTq8sXVn6
u7wlOSk+oFzDIO/UILIA
-----END CERTIFICATE-----`;

  const certWithoutHeader = certWithHeader
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');

  it('should throw an error if SAML_CERT is not set', () => {
    process.env.SAML_CERT;
    expect(() => getCertificateContent(process.env.SAML_CERT)).toThrow(
      'Invalid input: SAML_CERT must be a string.',
    );
  });

  it('should throw an error if SAML_CERT is empty', () => {
    process.env.SAML_CERT = '';
    expect(() => getCertificateContent(process.env.SAML_CERT)).toThrow(
      'Invalid cert: SAML_CERT must be a valid file path or certificate string.',
    );
  });

  it('should load cert from an environment variable if it is a single-line string(with header)', () => {
    process.env.SAML_CERT = certWithHeader;

    const actual = getCertificateContent(process.env.SAML_CERT);
    expect(actual).toBe(certWithHeader);
  });

  it('should load cert from an environment variable if it is a single-line string(with no header)', () => {
    process.env.SAML_CERT = certWithoutHeader;

    const actual = getCertificateContent(process.env.SAML_CERT);
    expect(actual).toBe(certWithoutHeader);
  });

  it('should throw an error if SAML_CERT is a single-line string (with header, no newline characters)', () => {
    process.env.SAML_CERT = certWithHeader.replace(/\n/g, '');
    expect(() => getCertificateContent(process.env.SAML_CERT)).toThrow(
      'Invalid cert: SAML_CERT must be a valid file path or certificate string.',
    );
  });

  it('should load cert from a relative file path if SAML_CERT is valid', () => {
    process.env.SAML_CERT = 'test.pem';
    const resolvedPath = '/absolute/path/to/test.pem';

    path.isAbsolute.mockReturnValue(false);
    path.join.mockReturnValue(resolvedPath);
    path.normalize.mockReturnValue(resolvedPath);

    fs.existsSync.mockReturnValue(true);
    fs.statSync.mockReturnValue({ isFile: () => true });
    fs.readFileSync.mockReturnValue(certWithHeader);

    const actual = getCertificateContent(process.env.SAML_CERT);
    expect(actual).toBe(certWithHeader);
  });

  it('should load cert from an absolute file path if SAML_CERT is valid', () => {
    process.env.SAML_CERT = '/absolute/path/to/test.pem';

    path.isAbsolute.mockReturnValue(true);
    path.normalize.mockReturnValue(process.env.SAML_CERT);

    fs.existsSync.mockReturnValue(true);
    fs.statSync.mockReturnValue({ isFile: () => true });
    fs.readFileSync.mockReturnValue(certWithHeader);

    const actual = getCertificateContent(process.env.SAML_CERT);
    expect(actual).toBe(certWithHeader);
  });

  it('should throw an error if the file does not exist', () => {
    process.env.SAML_CERT = 'missing.pem';
    const resolvedPath = '/absolute/path/to/missing.pem';

    path.isAbsolute.mockReturnValue(false);
    path.join.mockReturnValue(resolvedPath);
    path.normalize.mockReturnValue(resolvedPath);

    fs.existsSync.mockReturnValue(false);

    expect(() => getCertificateContent(process.env.SAML_CERT)).toThrow(
      'Invalid cert: SAML_CERT must be a valid file path or certificate string.',
    );
  });

  it('should throw an error if the file is not readable', () => {
    process.env.SAML_CERT = 'unreadable.pem';
    const resolvedPath = '/absolute/path/to/unreadable.pem';

    path.isAbsolute.mockReturnValue(false);
    path.join.mockReturnValue(resolvedPath);
    path.normalize.mockReturnValue(resolvedPath);

    fs.existsSync.mockReturnValue(true);
    fs.statSync.mockReturnValue({ isFile: () => true });
    fs.readFileSync.mockImplementation(() => {
      throw new Error('Permission denied');
    });

    expect(() => getCertificateContent(process.env.SAML_CERT)).toThrow(
      'Error reading certificate file: Permission denied',
    );
  });
});

describe('setupSaml', () => {
  // Helper to wrap the verify callback in a promise
  const validate = (profile, strategyName = 'saml') =>
    new Promise((resolve, reject) => {
      verifyCallbacks.get(strategyName)(profile, (err, user, details) => {
        if (err) {
          reject(err);
        } else {
          resolve({ user, details });
        }
      });
    });

  const baseProfile = {
    nameID: 'saml-1234',
    email: 'test@example.com',
    given_name: 'First',
    family_name: 'Last',
    name: 'My Full Name',
    username: 'flast',
    picture: 'https://example.com/avatar.png',
    custom_name: 'custom',
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    verifyCallbacks.clear();

    // Configure mocks
    const { findUser, createUserIfAbsent, updateUser, claimSamlIdentity } = require('~/models');
    findUser.mockResolvedValue(null);
    createUserIfAbsent.mockImplementation(async (userData) => ({
      ok: true,
      value: { _id: 'mock-user-id', ...userData },
    }));
    updateUser.mockImplementation(async (id, userData) => ({
      _id: id,
      ...userData,
    }));
    claimSamlIdentity.mockImplementation(async (id, samlId, userData) => {
      const result = findUser.mock.results[findUser.mock.results.length - 1];
      const existingUser = result ? await result.value : {};
      return { ...existingUser, _id: id, ...userData, samlId };
    });

    const cert = `
-----BEGIN CERTIFICATE-----
MIIDazCCAlOgAwIBAgIUKhXaFJGJJPx466rlwYORIsqCq7MwDQYJKoZIhvcNAQEL
BQAwRTELMAkGA1UEBhMCQVUxEzARBgNVBAgMClNvbWUtU3RhdGUxITAfBgNVBAoM
GEludGVybmV0IFdpZGdpdHMgUHR5IEx0ZDAeFw0yNTAzMDQwODUxNTJaFw0yNjAz
MDQwODUxNTJaMEUxCzAJBgNVBAYTAkFVMRMwEQYDVQQIDApTb21lLVN0YXRlMSEw
HwYDVQQKDBhJbnRlcm5ldCBXaWRnaXRzIFB0eSBMdGQwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCWP09NZg0xaRiLpNygCVgV3M+4RFW2S0c5X/fg/uFT
O5MfaVYzG5GxzhXzWRB8RtNPsxX/nlbPsoUroeHbz+SABkOsNEv6JuKRH4VXRH34
VzjazVkPAwj+N4WqsC/Wo4EGGpKIGeGi8Zed4yvMqoTyE3mrS19fY0nMHT62wUwS
GMm2pAQdAQePZ9WY7A5XOA1IoxW2Zh2Oxaf1p59epBkZDhoxSMu8GoSkvK27Km4A
4UXftzdg/wHNPrNirmcYouioHdmrOtYxPjrhUBQ74AmE1/QK45B6wEgirKH1A1AW
6C+ApLwpBMvy9+8Gbyvc8G18W3CjdEVKmAeWb9JUedSXAgMBAAGjUzBRMB0GA1Ud
DgQWBBRxpaqBx8VDLLc8IkHATujj8IOs6jAfBgNVHSMEGDAWgBRxpaqBx8VDLLc8
IkHATujj8IOs6jAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQBc
Puk6i+yowwGccB3LhfxZ+Fz6s6/Lfx6bP/Hy4NYOxmx2/awGBgyfp1tmotjaS9Cf
FWd67LuEru4TYtz12RNMDBF5ypcEfibvb3I8O6igOSQX/Jl5D2pMChesZxhmCift
Qp09T41MA8PmHf1G9oMG0A3ZnjKDG5ebaJNRFImJhMHsgh/TP7V3uZy7YHTgopKX
Hv63V3Uo3Oihav29Q7urwmf7Ly7X7J2WE86/w3vRHi5dhaWWqEqxmnAXl+H+sG4V
meeVRI332bg1Nuy8KnnX8v3ZeJzMBkAhzvSr6Ri96R0/Un/oEFwVC5jDTq8sXVn6
u7wlOSk+oFzDIO/UILIA
-----END CERTIFICATE-----
    `;

    // Reset environment variables
    process.env.SAML_ENTRY_POINT = 'https://example.com/saml';
    process.env.SAML_ISSUER = 'saml-issuer';
    process.env.SAML_CERT = cert;
    process.env.SAML_CALLBACK_URL = '/oauth/saml/callback';
    delete process.env.SAML_EMAIL_CLAIM;
    delete process.env.SAML_USERNAME_CLAIM;
    delete process.env.SAML_GIVEN_NAME_CLAIM;
    delete process.env.SAML_FAMILY_NAME_CLAIM;
    delete process.env.SAML_PICTURE_CLAIM;
    delete process.env.SAML_NAME_CLAIM;
    delete process.env.SAML_NAME_ID_FORMAT;
    delete process.env.SAML_IDP_ISSUER;

    resizeAvatar.mockResolvedValue(Buffer.from('safe avatar'));

    await setupSaml();
  });

  it('should create a new user with correct username when username claim exists', async () => {
    const profile = { ...baseProfile };
    const { user } = await validate(profile);

    expect(user.username).toBe(profile.username);
    expect(user.provider).toBe('saml');
    expect(user.samlId).toBe(profile.nameID);
    expect(user.email).toBe(profile.email);
    expect(user.name).toBe(`${profile.given_name} ${profile.family_name}`);
  });

  it('should use given_name as username when username claim is missing', async () => {
    const profile = { ...baseProfile };
    delete profile.username;
    const expectUsername = profile.given_name;

    const { user } = await validate(profile);

    expect(user.username).toBe(expectUsername);
    expect(user.provider).toBe('saml');
  });

  it('should use email as username when username and given_name are missing', async () => {
    const profile = { ...baseProfile };
    delete profile.username;
    delete profile.given_name;
    const expectUsername = profile.email;

    const { user } = await validate(profile);

    expect(user.username).toBe(expectUsername);
    expect(user.provider).toBe('saml');
  });

  it('should override username with SAML_USERNAME_CLAIM when set', async () => {
    process.env.SAML_USERNAME_CLAIM = 'nameID';
    const profile = { ...baseProfile };

    const { user } = await validate(profile);

    expect(user.username).toBe(profile.nameID);
    expect(user.provider).toBe('saml');
  });

  it('should set the full name correctly when given_name and family_name exist', async () => {
    const profile = { ...baseProfile };
    const expectedFullName = `${profile.given_name} ${profile.family_name}`;

    const { user } = await validate(profile);

    expect(user.name).toBe(expectedFullName);
  });

  it('should set the full name correctly when given_name exist', async () => {
    const profile = { ...baseProfile };
    delete profile.family_name;
    const expectedFullName = profile.given_name;

    const { user } = await validate(profile);

    expect(user.name).toBe(expectedFullName);
  });

  it('should set the full name correctly when family_name exist', async () => {
    const profile = { ...baseProfile };
    delete profile.given_name;
    const expectedFullName = profile.family_name;

    const { user } = await validate(profile);

    expect(user.name).toBe(expectedFullName);
  });

  it('should set the full name correctly when username exist', async () => {
    const profile = { ...baseProfile };
    delete profile.family_name;
    delete profile.given_name;
    const expectedFullName = profile.username;

    const { user } = await validate(profile);

    expect(user.name).toBe(expectedFullName);
  });

  it('should set the full name correctly when email only exist', async () => {
    const profile = { ...baseProfile };
    delete profile.family_name;
    delete profile.given_name;
    delete profile.username;
    const expectedFullName = profile.email;

    const { user } = await validate(profile);

    expect(user.name).toBe(expectedFullName);
  });

  it('should set the full name correctly with SAML_NAME_CLAIM when set', async () => {
    process.env.SAML_NAME_CLAIM = 'custom_name';
    const profile = { ...baseProfile };
    const expectedFullName = profile.custom_name;

    const { user } = await validate(profile);

    expect(user.name).toBe(expectedFullName);
  });

  it('should update an existing user on login', async () => {
    // Set up findUser to return an existing user with saml provider
    const { findUser } = require('~/models');
    const existingUser = {
      _id: 'existing-user-id',
      provider: 'saml',
      email: baseProfile.email,
      samlId: '',
      username: 'oldusername',
      name: 'Old Name',
    };
    findUser.mockResolvedValue(existingUser);

    const profile = { ...baseProfile };
    const { user } = await validate(profile);

    expect(user.provider).toBe('saml');
    expect(user.samlId).toBe(baseProfile.nameID);
    expect(user.username).toBe(baseProfile.username);
    expect(user.name).toBe(`${baseProfile.given_name} ${baseProfile.family_name}`);
    expect(user.email).toBe(baseProfile.email);
  });

  it('should preserve a matching NameID binding', async () => {
    const { findUser, claimSamlIdentity } = require('~/models');
    const existingUser = {
      _id: 'existing-user-id',
      provider: 'saml',
      email: baseProfile.email,
      samlId: baseProfile.nameID,
    };
    findUser.mockResolvedValueOnce(existingUser);

    const { user } = await validate(baseProfile);

    expect(user.samlId).toBe(baseProfile.nameID);
    expect(claimSamlIdentity).toHaveBeenCalledWith(
      existingUser._id,
      baseProfile.nameID,
      expect.objectContaining({ username: baseProfile.username }),
    );
  });

  it('should atomically bind a legacy SAML account found by email', async () => {
    const { findUser, claimSamlIdentity } = require('~/models');
    const existingUser = {
      _id: 'legacy-user-id',
      provider: 'saml',
      email: baseProfile.email,
    };
    findUser.mockResolvedValueOnce(null).mockResolvedValueOnce(existingUser);

    const { user } = await validate(baseProfile);

    expect(user.samlId).toBe(baseProfile.nameID);
    expect(claimSamlIdentity).toHaveBeenCalledWith(
      existingUser._id,
      baseProfile.nameID,
      expect.objectContaining({ username: baseProfile.username }),
    );
  });

  it('should reject a concurrent first-time binding that loses the atomic claim', async () => {
    const { findUser, updateUser, claimSamlIdentity } = require('~/models');
    const existingUser = {
      _id: 'legacy-user-id',
      provider: 'saml',
      email: baseProfile.email,
    };
    findUser.mockResolvedValueOnce(null).mockResolvedValueOnce(existingUser);
    claimSamlIdentity.mockResolvedValueOnce(null);

    const result = await validate(baseProfile);

    expect(result.user).toBe(false);
    expect(result.details.message).toBe(require('librechat-data-provider').ErrorTypes.AUTH_FAILED);
    expect(updateUser).not.toHaveBeenCalled();
  });

  describe('concurrent first login', () => {
    const raceCreateWith = (existingUser) => {
      const { findUser, createUserIfAbsent } = require('~/models');
      let created = false;
      const matches = (query) =>
        Object.entries(query).every(([field, value]) => existingUser[field] === value);
      findUser.mockImplementation(async (query) =>
        created && matches(query) ? existingUser : null,
      );
      createUserIfAbsent.mockImplementation(async () => {
        created = true;
        return { ok: false, error: { code: 'user_exists' } };
      });
    };

    it("claims the account the other request created with this login's profile", async () => {
      const { createUserIfAbsent, claimSamlIdentity } = require('~/models');
      raceCreateWith({
        _id: 'winner-user-id',
        provider: 'saml',
        samlId: baseProfile.nameID,
        email: baseProfile.email,
        username: 'old-username',
        name: 'Old Name',
      });

      const { user } = await validate(baseProfile);

      expect(createUserIfAbsent).toHaveBeenCalledTimes(1);
      expect(claimSamlIdentity).toHaveBeenCalledWith('winner-user-id', baseProfile.nameID, {
        username: baseProfile.username,
        name: `${baseProfile.given_name} ${baseProfile.family_name}`,
      });
      expect(user).toEqual(expect.objectContaining({ _id: 'winner-user-id' }));
    });

    it("fails the login when the recovered tenant account's policy rejects the email", async () => {
      const { getAppConfig } = require('~/server/services/Config');
      getAppConfig.mockImplementation(async (options) =>
        options?.tenantId ? { registration: { allowedDomains: ['other.example'] } } : {},
      );
      raceCreateWith({
        _id: 'tenant-user-id',
        provider: 'saml',
        samlId: baseProfile.nameID,
        email: baseProfile.email,
        tenantId: 'tenant-a',
      });

      const result = await validate(baseProfile);

      expect(result.user).toBe(false);
      expect(result.details.message).toBe('Email domain not allowed');
      getAppConfig.mockResolvedValue({});
    });

    it('fails the login when another provider took the email in the meantime', async () => {
      const { claimSamlIdentity, updateUser } = require('~/models');
      raceCreateWith({ _id: 'local-user-id', provider: 'local', email: baseProfile.email });

      const result = await validate(baseProfile);

      expect(result.user).toBe(false);
      expect(result.details.message).toBe(
        require('librechat-data-provider').ErrorTypes.AUTH_FAILED,
      );
      expect(claimSamlIdentity).not.toHaveBeenCalled();
      expect(updateUser).not.toHaveBeenCalled();
    });
  });

  it.each([undefined, '', '   '])('should reject an invalid NameID value: %p', async (nameID) => {
    const { findUser, claimSamlIdentity } = require('~/models');
    const { resolveSamlSubject } = require('@librechat/api');
    resolveSamlSubject.mockReturnValueOnce({ error: 'missing_name_id' });

    const result = await validate({ ...baseProfile, nameID });

    expect(result.user).toBe(false);
    expect(result.details.message).toBe(require('librechat-data-provider').ErrorTypes.AUTH_FAILED);
    expect(findUser).not.toHaveBeenCalled();
    expect(claimSamlIdentity).not.toHaveBeenCalled();
  });

  it('should reject a transient NameID', async () => {
    const { findUser } = require('~/models');
    const { resolveSamlSubject } = require('@librechat/api');
    resolveSamlSubject.mockReturnValueOnce({ error: 'transient_name_id' });
    const result = await validate({
      ...baseProfile,
      nameIDFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient',
    });

    expect(result.user).toBe(false);
    expect(result.details.message).toBe(require('librechat-data-provider').ErrorTypes.AUTH_FAILED);
    expect(findUser).not.toHaveBeenCalled();
  });

  it('should reject an assertion from a different IdP issuer when configured', async () => {
    const { findUser } = require('~/models');
    const { resolveSamlSubject } = require('@librechat/api');
    resolveSamlSubject.mockReturnValueOnce({ error: 'issuer_mismatch' });
    process.env.SAML_IDP_ISSUER = 'https://idp.example.com';

    const result = await validate({ ...baseProfile, issuer: 'https://other-idp.example.com' });

    expect(result.user).toBe(false);
    expect(result.details.message).toBe(require('librechat-data-provider').ErrorTypes.AUTH_FAILED);
    expect(findUser).not.toHaveBeenCalled();
    expect(resolveSamlSubject).toHaveBeenCalledWith(
      expect.objectContaining({ issuer: 'https://other-idp.example.com' }),
      'https://idp.example.com',
    );
  });

  it('should reject an email match bound to a different NameID', async () => {
    const { findUser, updateUser, claimSamlIdentity } = require('~/models');
    const existingUser = {
      _id: 'existing-user-id',
      provider: 'saml',
      email: baseProfile.email,
      samlId: 'original-name-id',
    };
    findUser.mockResolvedValueOnce(null).mockResolvedValueOnce(existingUser);

    const result = await validate(baseProfile);

    expect(result.user).toBe(false);
    expect(result.details.message).toBe(require('librechat-data-provider').ErrorTypes.AUTH_FAILED);
    expect(updateUser).not.toHaveBeenCalled();
    expect(claimSamlIdentity).not.toHaveBeenCalled();
  });

  it('should enforce the NameID binding for the admin SAML callback', async () => {
    const { findUser, claimSamlIdentity } = require('~/models');
    const existingUser = {
      _id: 'existing-admin-id',
      provider: 'saml',
      email: baseProfile.email,
      samlId: 'original-name-id',
    };
    findUser.mockResolvedValueOnce(null).mockResolvedValueOnce(existingUser);

    const result = await validate(baseProfile, 'samlAdmin');

    expect(result.user).toBe(false);
    expect(result.details.message).toBe(require('librechat-data-provider').ErrorTypes.AUTH_FAILED);
    expect(claimSamlIdentity).not.toHaveBeenCalled();
  });

  it('should block login when email exists with different provider', async () => {
    // Set up findUser to return a user with different provider
    const { findUser } = require('~/models');
    const existingUser = {
      _id: 'existing-user-id',
      provider: 'google',
      email: baseProfile.email,
      googleId: 'some-google-id',
      username: 'existinguser',
      name: 'Existing User',
    };
    findUser.mockResolvedValue(existingUser);

    const profile = { ...baseProfile };
    const result = await validate(profile);

    expect(result.user).toBe(false);
    expect(result.details.message).toBe(require('librechat-data-provider').ErrorTypes.AUTH_FAILED);
  });

  it('should process and save the avatar through the shared avatar path if picture is provided', async () => {
    const { getStrategyFunctions } = require('~/server/services/Files/strategies');
    const profile = { ...baseProfile };

    const { user } = await validate(profile);
    const strategyResult =
      getStrategyFunctions.mock.results[getStrategyFunctions.mock.results.length - 1];
    const { saveBuffer } = strategyResult.value;
    const [saveParams] = saveBuffer.mock.calls[0];

    expect(resizeAvatar).toHaveBeenCalledWith({
      userId: 'mock-user-id',
      input: 'https://example.com/avatar.png',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(saveParams).toEqual(
      expect.objectContaining({
        fileName: 'hashed-token.png',
        userId: 'mock-user-id',
        buffer: expect.any(Buffer),
      }),
    );
    expect(saveParams).not.toHaveProperty('basePath');
    expect(user.avatar).toBe('/fake/path/to/avatar.png');
  });

  it('continues login when shared avatar processing rejects the picture URL', async () => {
    const { getStrategyFunctions } = require('~/server/services/Files/strategies');
    const profile = { ...baseProfile };
    resizeAvatar.mockRejectedValueOnce(new Error('avatar processing failed'));

    const { user } = await validate(profile);

    expect(user).toBeTruthy();
    expect(user.avatar).toBeUndefined();
    expect(getStrategyFunctions).not.toHaveBeenCalled();
  });

  it('uses the configured SAML picture claim for shared avatar processing', async () => {
    process.env.SAML_PICTURE_CLAIM = 'avatar_url';
    await setupSaml();

    const profile = {
      ...baseProfile,
      picture: 'https://example.com/ignored.png',
      avatar_url: 'https://idp.example.com/custom-avatar.png',
    };

    await validate(profile);

    expect(resizeAvatar).toHaveBeenCalledWith({
      userId: 'mock-user-id',
      input: 'https://idp.example.com/custom-avatar.png',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should pass the configured NameID format to both SAML strategies', async () => {
    process.env.SAML_NAME_ID_FORMAT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';
    process.env.SAML_IDP_ISSUER = 'https://idp.example.com';

    await setupSaml();

    const calls = SamlStrategy.mock.calls.slice(-2);
    for (const [options] of calls) {
      expect(options).toEqual(
        expect.objectContaining({
          identifierFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
        }),
      );
    }
  });

  it('should refuse to configure a transient NameID format', async () => {
    const { logger } = require('@librechat/data-schemas');
    process.env.SAML_NAME_ID_FORMAT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient';
    const callCount = SamlStrategy.mock.calls.length;

    await setupSaml();

    expect(SamlStrategy).toHaveBeenCalledTimes(callCount);
    expect(logger.error).toHaveBeenCalledWith(
      '[samlStrategy]',
      expect.objectContaining({
        message: 'SAML_NAME_ID_FORMAT must provide a stable, non-transient identifier',
      }),
    );
  });

  it('should not log raw NameID or profile attributes', async () => {
    const { logger } = require('@librechat/data-schemas');
    const sensitiveValue = 'sensitive-profile-attribute';

    await validate({ ...baseProfile, sensitiveAttribute: sensitiveValue });

    const logOutput = JSON.stringify([
      ...logger.info.mock.calls,
      ...logger.debug.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls,
    ]);
    expect(logOutput).not.toContain(baseProfile.nameID);
    expect(logOutput).not.toContain(sensitiveValue);
  });

  it('should save CloudFront SAML avatars under the shared avatar prefix', async () => {
    const { getStrategyFunctions } = require('~/server/services/Files/strategies');
    getAppConfig.mockResolvedValueOnce({ fileStrategies: { avatar: FileSources.cloudfront } });
    const profile = { ...baseProfile };

    const { user } = await validate(profile);
    const strategyResult =
      getStrategyFunctions.mock.results[getStrategyFunctions.mock.results.length - 1];
    const { saveBuffer } = strategyResult.value;
    const [saveParams] = saveBuffer.mock.calls[0];

    expect(getStrategyFunctions).toHaveBeenLastCalledWith(FileSources.cloudfront);
    expect(resizeAvatar).toHaveBeenCalledWith({
      userId: 'mock-user-id',
      input: 'https://example.com/avatar.png',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(saveParams).toEqual(
      expect.objectContaining({
        basePath: 'avatars',
        fileName: 'hashed-token.png',
        userId: 'mock-user-id',
      }),
    );
    expect(user.avatar).toBe('/fake/path/to/avatar.png');
  });

  it('should not attempt to download avatar if picture is not provided', async () => {
    const profile = { ...baseProfile };
    delete profile.picture;

    await validate(profile);

    expect(fetch).not.toHaveBeenCalled();
    expect(resizeAvatar).not.toHaveBeenCalled();
  });

  it('should pass the found user to resolveAppConfigForUser', async () => {
    const existingUser = {
      _id: 'tenant-user-id',
      provider: 'saml',
      samlId: 'saml-1234',
      email: 'test@example.com',
      tenantId: 'tenant-c',
      role: 'USER',
    };
    findUser.mockResolvedValue(existingUser);

    const profile = { ...baseProfile };
    await validate(profile);

    expect(resolveAppConfigForUser).toHaveBeenCalledWith(getAppConfig, existingUser);
  });

  it('should use baseConfig for new SAML user without calling resolveAppConfigForUser', async () => {
    const profile = { ...baseProfile };
    await validate(profile);

    expect(resolveAppConfigForUser).not.toHaveBeenCalled();
    expect(getAppConfig).toHaveBeenCalledWith({ baseOnly: true });
  });

  it('should block login when tenant config restricts the domain', async () => {
    const { isEmailDomainAllowed } = require('@librechat/api');
    const existingUser = {
      _id: 'tenant-blocked',
      provider: 'saml',
      samlId: 'saml-1234',
      email: 'test@example.com',
      tenantId: 'tenant-restrict',
      role: 'USER',
    };
    findUser.mockResolvedValue(existingUser);
    resolveAppConfigForUser.mockResolvedValue({
      registration: { allowedDomains: ['other.com'] },
    });
    isEmailDomainAllowed.mockReturnValueOnce(true).mockReturnValueOnce(false);

    const profile = { ...baseProfile };
    const { user } = await validate(profile);
    expect(user).toBe(false);
  });
});
