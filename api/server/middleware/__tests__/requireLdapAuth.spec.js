let mockStrategyResult;

jest.mock('passport', () => ({
  authenticate: jest.fn((_strategy, callback) => () => {
    const { err, user, info } = mockStrategyResult;
    return callback(err, user, info);
  }),
}));

const requireLdapAuth = require('../requireLdapAuth');

function mockRes() {
  return { status: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis() };
}

describe('requireLdapAuth', () => {
  afterEach(() => {
    mockStrategyResult = undefined;
  });

  it("sets req.authMethod to 'ldap' alongside req.user on a successful bind", () => {
    const ldapUser = { _id: 'user-1', provider: 'ldap' };
    mockStrategyResult = { err: null, user: ldapUser, info: undefined };
    const req = {};
    const res = mockRes();
    const next = jest.fn();

    requireLdapAuth(req, res, next);

    expect(req.user).toBe(ldapUser);
    expect(req.authMethod).toBe('ldap');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does not set req.authMethod when the directory rejects the bind', () => {
    mockStrategyResult = { err: null, user: false, info: { message: 'Invalid credentials' } };
    const req = {};
    const res = mockRes();
    const next = jest.fn();

    requireLdapAuth(req, res, next);

    expect(req.authMethod).toBeUndefined();
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('forwards a passport error without setting req.authMethod', () => {
    const error = new Error('LDAP server unreachable');
    mockStrategyResult = { err: error, user: undefined, info: undefined };
    const req = {};
    const res = mockRes();
    const next = jest.fn();

    requireLdapAuth(req, res, next);

    expect(req.authMethod).toBeUndefined();
    expect(next).toHaveBeenCalledWith(error);
  });
});
