import type { Request, Response } from 'express';
import type { LdapAuthRequest } from './ldap';
import { createRequireLdapAuth, validateLdapCredentials } from './ldap';

function mockRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  } as unknown as Response;
}

describe('validateLdapCredentials', () => {
  it('rejects malformed credentials with 400 and never calls next', () => {
    const req = { body: { email: '', password: 'secret' } } as Request;
    const res = mockRes();
    const next = jest.fn();

    validateLdapCredentials(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('createRequireLdapAuth', () => {
  function run(strategyResult: { err?: unknown; user?: unknown; info?: unknown }) {
    const authenticate = jest.fn((_strategy: string, callback: (...args: unknown[]) => void) =>
      jest.fn(() => callback(strategyResult.err, strategyResult.user, strategyResult.info)),
    );
    const requireLdapAuth = createRequireLdapAuth({ authenticate });
    const req = {
      body: { email: 'user@example.com', password: 'secret' },
    } as unknown as LdapAuthRequest;
    const res = mockRes();
    const next = jest.fn();

    requireLdapAuth(req, res, next);
    return { req, res, next };
  }

  it('sets req.user and req.authMethod on a successful bind', () => {
    const ldapUser = { _id: 'user-1', provider: 'ldap' };
    const { req, next } = run({ user: ldapUser });

    expect(req.user).toBe(ldapUser);
    expect(req.authMethod).toBe('ldap');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('returns 404 with info and sets no authMethod on a rejected bind', () => {
    const { req, res, next } = run({ user: false, info: { message: 'Invalid credentials' } });

    expect(req.authMethod).toBeUndefined();
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.send).toHaveBeenCalledWith({ message: 'Invalid credentials' });
  });

  it('forwards a passport error without setting req.authMethod', () => {
    const error = new Error('LDAP server unreachable');
    const { req, next } = run({ err: error });

    expect(req.authMethod).toBeUndefined();
    expect(next).toHaveBeenCalledWith(error);
  });

  it('returns 400 and never calls authenticate on invalid credentials', () => {
    const authenticate = jest.fn();
    const requireLdapAuth = createRequireLdapAuth({ authenticate });
    const req = { body: { email: '', password: 'secret' } } as unknown as LdapAuthRequest;
    const res = mockRes();
    const next = jest.fn();

    requireLdapAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(authenticate).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});
