import jwt from 'jsonwebtoken';
import type { Response } from 'express';
import type { StoredTwoFactorAccount } from './twoFactor';
import type { LoginDependencies } from './login';
import { createLoginController } from './login';

const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;
const ORIGINAL_ENFORCE_2FA = process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION;

function mockResponse() {
  const res: { status: jest.Mock; json: jest.Mock; send: jest.Mock } = {
    status: jest.fn(),
    json: jest.fn(),
    send: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  res.send.mockReturnValue(res);
  return res as unknown as Response;
}

function makeUser(overrides: Partial<StoredTwoFactorAccount> = {}): StoredTwoFactorAccount {
  return {
    _id: 'user-1',
    provider: 'local',
    twoFactorEnabled: false,
    ...overrides,
  } as unknown as StoredTwoFactorAccount;
}

function makeDeps(overrides: Partial<LoginDependencies> = {}): LoginDependencies {
  return {
    getUserById: jest.fn().mockResolvedValue(null),
    deleteAllUserSessions: jest.fn().mockResolvedValue({}),
    clearCloudFrontCookies: jest.fn(),
    generate2FATempToken: jest.fn().mockReturnValue('2fa-temp-token'),
    setAuthTokens: jest.fn().mockResolvedValue('jwt-token'),
    defaultAuthMethod: 'local',
    ...overrides,
  };
}

describe('createLoginController authMethod', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret';
    delete process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION;
  });

  afterAll(() => {
    if (ORIGINAL_JWT_SECRET === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
    }
    if (ORIGINAL_ENFORCE_2FA === undefined) {
      delete process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION;
    } else {
      process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = ORIGINAL_ENFORCE_2FA;
    }
  });

  describe('the two-factor challenge branch', () => {
    it('carries the overriding auth method into the 2FA challenge token', async () => {
      const generate2FATempToken = jest.fn().mockReturnValue('2fa-temp-token');
      const deps = makeDeps({ generate2FATempToken, defaultAuthMethod: 'ldap' });
      const controller = createLoginController(deps);
      const user = makeUser({ twoFactorEnabled: true });
      const req = { user, authMethod: 'passkey' } as unknown as Parameters<typeof controller>[0];
      const res = mockResponse();

      await controller(req, res);

      expect(generate2FATempToken).toHaveBeenCalledWith('user-1', 'passkey');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ twoFAPending: true, tempToken: '2fa-temp-token' });
    });

    it('falls back to the controller default auth method when nothing overrides it', async () => {
      const generate2FATempToken = jest.fn().mockReturnValue('2fa-temp-token');
      const deps = makeDeps({ generate2FATempToken, defaultAuthMethod: 'ldap' });
      const controller = createLoginController(deps);
      const user = makeUser({ twoFactorEnabled: true });
      const req = { user } as unknown as Parameters<typeof controller>[0];
      const res = mockResponse();

      await controller(req, res);

      expect(generate2FATempToken).toHaveBeenCalledWith('user-1', 'ldap');
    });

    it('does not mint a 2FA challenge when the account has no second factor enabled', async () => {
      const generate2FATempToken = jest.fn().mockReturnValue('2fa-temp-token');
      const deps = makeDeps({ generate2FATempToken, defaultAuthMethod: 'ldap' });
      const controller = createLoginController(deps);
      const user = makeUser({ twoFactorEnabled: false });
      const req = { user } as unknown as Parameters<typeof controller>[0];
      const res = mockResponse();

      await controller(req, res);

      expect(generate2FATempToken).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalledWith(expect.objectContaining({ twoFAPending: true }));
      expect(res.send).toHaveBeenCalled();
    });
  });

  describe('the required-enrollment branch', () => {
    beforeEach(() => {
      process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'true';
    });

    it('carries the overriding auth method into the enrollment setup token', async () => {
      const deps = makeDeps({ defaultAuthMethod: 'ldap' });
      const controller = createLoginController(deps);
      const user = makeUser({ twoFactorEnabled: false, provider: 'local' });
      const req = { user, authMethod: 'passkey' } as unknown as Parameters<typeof controller>[0];
      const res = mockResponse();

      await controller(req, res);

      const tempToken = (res.json as jest.Mock).mock.calls[0][0].tempToken;
      const decoded = jwt.decode(tempToken) as jwt.JwtPayload;
      expect(decoded.authMethod).toBe('passkey');
    });

    it('falls back to the controller default auth method when nothing overrides it', async () => {
      const deps = makeDeps({ defaultAuthMethod: 'ldap' });
      const controller = createLoginController(deps);
      const user = makeUser({ twoFactorEnabled: false, provider: 'local' });
      const req = { user } as unknown as Parameters<typeof controller>[0];
      const res = mockResponse();

      await controller(req, res);

      const tempToken = (res.json as jest.Mock).mock.calls[0][0].tempToken;
      const decoded = jwt.decode(tempToken) as jwt.JwtPayload;
      expect(decoded.authMethod).toBe('ldap');
    });
  });

  describe('the completed-login branch', () => {
    it('records the overriding auth method on the minted session', async () => {
      const setAuthTokens = jest.fn().mockResolvedValue('jwt-token');
      const deps = makeDeps({ setAuthTokens, defaultAuthMethod: 'ldap' });
      const controller = createLoginController(deps);
      const user = makeUser({ twoFactorEnabled: false, provider: 'local' });
      const req = { user, authMethod: 'passkey' } as unknown as Parameters<typeof controller>[0];
      const res = mockResponse();

      await controller(req, res);

      expect(setAuthTokens).toHaveBeenCalledWith(
        'user-1',
        res,
        null,
        req,
        expect.objectContaining({ authMethod: 'passkey' }),
      );
    });
  });
});
