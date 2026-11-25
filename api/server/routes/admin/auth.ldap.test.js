const express = require('express');
const request = require('supertest');

/**
 * `POST /api/admin/login/local` is the admin panel's password sign-in. A directory user has no
 * local password, so when LDAP is configured it has to check the credentials against the directory
 * the way `POST /api/auth/login` does. Passport and both credential middlewares are the real ones;
 * only the two credential stores behind the strategies are in memory.
 */

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  createSetBalanceConfig: jest.fn(() => (req, res, next) => next()),
  tenantContextMiddleware: jest.fn((req, res, next) => next()),
  preAuthTenantMiddleware: jest.fn((req, res, next) => next()),
}));

const mockLoginController = jest.fn((req, res) =>
  res.status(200).json({ id: req.user.id, provider: req.user.provider }),
);
jest.mock('~/server/controllers/auth/LoginController', () => ({
  loginController: (...args) => mockLoginController(...args),
}));

jest.mock('~/server/controllers/auth/oauth', () => ({
  createOAuthHandler: jest.fn(() => (req, res) => res.status(200).end()),
}));

/** The ADMIN role holds `ACCESS_ADMIN`; every other role is refused. */
jest.mock('~/server/middleware/roles/capabilities', () => ({
  hasCapability: jest.fn(async () => true),
  requireCapability: jest.fn(
    () => (req, res, next) =>
      req.user?.role === 'ADMIN' ? next() : res.status(403).json({ message: 'Forbidden' }),
  ),
}));

jest.mock('~/models', () => ({
  findBalanceByUser: jest.fn(),
  findUsers: jest.fn(),
  generateToken: jest.fn(),
  getUserById: jest.fn(),
  upsertBalanceFields: jest.fn(),
}));

jest.mock('~/server/services/Config', () => ({ getAppConfig: jest.fn() }));
jest.mock('~/cache/getLogStores', () => jest.fn(() => ({ get: jest.fn(), delete: jest.fn() })));
jest.mock('~/strategies', () => ({ getOpenIdConfig: jest.fn() }));

jest.mock('~/server/middleware', () => {
  const pass = (req, res, next) => next();
  return {
    logHeaders: pass,
    requireSameOrigin: pass,
    loginLimiter: pass,
    checkBan: pass,
    validateEmailLogin: pass,
    requireJwtAuth: pass,
    checkDomainAllowed: pass,
    requireLocalAuth: jest.requireActual('~/server/middleware/requireLocalAuth'),
    requireLdapAuth: jest.requireActual('~/server/middleware/requireLdapAuth'),
  };
});

const LDAP_URL = 'ldap://directory.example.test:389';
const LDAP_USER_SEARCH_BASE = 'ou=people,dc=example,dc=test';
const LDAP_ENV = ['LDAP_URL', 'LDAP_USER_SEARCH_BASE'];
const ORIGINAL_ENV = Object.fromEntries(LDAP_ENV.map((key) => [key, process.env[key]]));

const directory = {
  'ada@corp.example': {
    password: 'directory-secret',
    user: { _id: 'ada', id: 'ada', role: 'ADMIN', provider: 'ldap' },
  },
  'bob@corp.example': {
    password: 'directory-secret',
    user: { _id: 'bob', id: 'bob', role: 'USER', provider: 'ldap' },
  },
};
const accounts = {
  'root@local.example': {
    password: 'local-secret',
    user: { _id: 'root', id: 'root', role: 'ADMIN', provider: 'local' },
  },
};

/** Names of the passport strategies a request reached, in order. */
const consulted = [];

/** A passport strategy over an in-memory credential store. */
const strategyOver = (name, store, message) => ({
  name,
  authenticate(req) {
    consulted.push(name);
    const entry = store[req.body.email];
    if (entry && entry.password === req.body.password) {
      return this.success({ ...entry.user });
    }
    return this.fail({ message });
  },
});

/** The admin router as it registers under `env`: its credential check is chosen when it loads. */
function loadApp(env) {
  for (const key of LDAP_ENV) {
    if (env[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = env[key];
    }
  }
  let app;
  jest.isolateModules(() => {
    const passport = require('passport');
    passport.use(strategyOver('local', accounts, 'Email does not exist.'));
    passport.use(strategyOver('ldapauth', directory, 'Invalid username/password'));
    app = express();
    app.use(express.json());
    app.use('/api/admin', require('./auth'));
  });
  return app;
}

const signIn = (app, credentials) => request(app).post('/api/admin/login/local').send(credentials);

beforeEach(() => {
  consulted.length = 0;
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  for (const key of LDAP_ENV) {
    if (ORIGINAL_ENV[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = ORIGINAL_ENV[key];
    }
  }
});

describe('admin panel sign-in with LDAP configured', () => {
  let app;
  beforeAll(() => {
    app = loadApp({ LDAP_URL, LDAP_USER_SEARCH_BASE });
  });

  it('signs in a directory user who holds admin access', async () => {
    const response = await signIn(app, { email: 'ada@corp.example', password: 'directory-secret' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: 'ada', provider: 'ldap' });
    expect(consulted).toEqual(['ldapauth']);
  });

  it('refuses a directory user who lacks admin access', async () => {
    const response = await signIn(app, { email: 'bob@corp.example', password: 'directory-secret' });

    expect(response.status).toBe(403);
    expect(mockLoginController).not.toHaveBeenCalled();
    expect(consulted).toEqual(['ldapauth']);
  });

  it('refuses wrong directory credentials without falling back to a local account', async () => {
    const wrong = await signIn(app, { email: 'ada@corp.example', password: 'not-the-secret' });
    const local = await signIn(app, { email: 'root@local.example', password: 'local-secret' });

    expect(wrong.status).toBe(404);
    expect(wrong.body).toEqual({ message: 'Invalid username/password' });
    expect(local.status).toBe(404);
    expect(mockLoginController).not.toHaveBeenCalled();
    expect(consulted).toEqual(['ldapauth', 'ldapauth']);
  });

  it('rejects malformed credentials before they reach the directory', async () => {
    const response = await signIn(app, { email: { $ne: null }, password: 'directory-secret' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ message: 'Invalid credentials' });
    expect(consulted).toEqual([]);
  });
});

describe.each([
  ['LDAP is not configured', {}],
  ['only the LDAP server is set', { LDAP_URL }],
  ['only the LDAP search base is set', { LDAP_USER_SEARCH_BASE }],
])('admin panel sign-in when %s', (_label, env) => {
  let app;
  beforeAll(() => {
    app = loadApp(env);
  });

  it('signs in a local admin through the local account store', async () => {
    const response = await signIn(app, { email: 'root@local.example', password: 'local-secret' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: 'root', provider: 'local' });
    expect(consulted).toEqual(['local']);
  });

  it('does not ask the directory about anyone else', async () => {
    const response = await signIn(app, { email: 'ada@corp.example', password: 'directory-secret' });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ message: 'Email does not exist.' });
    expect(consulted).toEqual(['local']);
  });
});
