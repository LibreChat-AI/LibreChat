const path = require('path');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');

/**
 * `POST /api/admin/login/local` is the admin panel's password sign-in. A directory user has no
 * local password, so when LDAP is configured the route has to check the credentials against the
 * directory, as `POST /api/auth/login` does. The router, its middleware, the local and LDAP
 * strategies, the capability check and the database are the real ones. Only the LDAP client
 * library is replaced, by one that answers from an in-memory directory and hands the matching
 * entry to the application's own verify callback.
 */

/** Names of the Passport strategies a request reached, in order. */
const mockConsulted = [];
/** The directory server's entries, keyed by login. */
const mockDirectory = new Map();

jest.mock('passport-ldapauth', () => {
  return class FakeLdapStrategy {
    constructor(_options, verify) {
      this.name = 'ldapauth';
      this.verify = verify;
    }

    authenticate(req) {
      mockConsulted.push('ldapauth');
      const { email, password } = req.body;
      const entry = mockDirectory.get(email);
      if (!entry || entry.password !== password) {
        return this.fail({ message: 'Invalid username/password' });
      }
      return this.verify(entry.attributes, (err, user, info) => {
        if (err) {
          return this.error(err);
        }
        return user ? this.success(user, info) : this.fail(info);
      });
    }
  };
});

const LDAP_URL = 'ldap://directory.example.test:389';
const LDAP_USER_SEARCH_BASE = 'ou=people,dc=example,dc=test';
const LOCAL_PASSWORD = 'local-secret-123';
const DIRECTORY_PASSWORD = 'directory-secret';
const ENV_KEYS = [
  'LDAP_URL',
  'LDAP_USER_SEARCH_BASE',
  'BAN_VIOLATIONS',
  'LOGIN_MAX',
  'DOMAIN_CLIENT',
  'DOMAIN_SERVER',
  'CONFIG_PATH',
  'TENANT_ISOLATION_STRICT',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const entry = (uid, name) => ({
  password: DIRECTORY_PASSWORD,
  attributes: { uid, mail: `${uid}@corp.example`, cn: name, givenName: name.split(' ')[0] },
});

let mongo;
let seeded = false;
const connections = [];

function setEnv(values) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/**
 * The admin router as it registers under `env`: its credential check is chosen when it loads, so
 * every configuration gets a fresh module registry, and the database is seeded once.
 */
async function loadApp(env) {
  setEnv({
    LDAP_URL: undefined,
    LDAP_USER_SEARCH_BASE: undefined,
    BAN_VIOLATIONS: 'false',
    LOGIN_MAX: '1000',
    DOMAIN_CLIENT: 'http://localhost:3080',
    DOMAIN_SERVER: 'http://localhost:3080',
    CONFIG_PATH: path.join(__dirname, 'missing-librechat.yaml'),
    TENANT_ISOLATION_STRICT: 'false',
    ...env,
  });
  jest.resetModules();
  const express = require('express');
  const passport = require('passport');
  const mongoose = require('mongoose');
  const bcrypt = require('bcryptjs');
  const schemas = require('@librechat/data-schemas');
  await mongoose.connect(mongo.getUri());
  connections.push(mongoose);
  schemas.createModels(mongoose);
  const models = require('~/models');
  if (!seeded) {
    seeded = true;
    await schemas.runAsSystem(async () => {
      await models.initializeRoles();
      await models.seedSystemGrants();
      const password = await bcrypt.hash(LOCAL_PASSWORD, 4);
      await mongoose.models.User.create([
        {
          email: 'root@local.example',
          name: 'Root',
          username: 'root',
          password,
          emailVerified: true,
          provider: 'local',
          role: 'ADMIN',
        },
        {
          email: 'ada@corp.example',
          name: 'Ada Lovelace',
          username: 'Ada',
          emailVerified: true,
          provider: 'ldap',
          ldapId: 'ada',
          role: 'ADMIN',
        },
      ]);
    });
  }
  const local = require('~/strategies/localStrategy')();
  const { authenticate } = local;
  local.authenticate = function (...args) {
    mockConsulted.push('local');
    return authenticate.apply(this, args);
  };
  passport.use('local', local);
  /** Registered whatever the configuration, so a route that wrongly picks the directory while LDAP
   *  is off shows up as a consulted strategy instead of a missing one. */
  passport.use(require('~/strategies/ldapStrategy'));
  const app = express();
  app.use(express.json());
  app.use(passport.initialize());
  app.use('/api/admin', require('./auth'));
  return app;
}

const signIn = (app, credentials) => request(app).post('/api/admin/login/local').send(credentials);

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
}, 180000);

beforeEach(() => {
  mockConsulted.length = 0;
  mockDirectory.clear();
  mockDirectory.set('ada@corp.example', entry('ada', 'Ada Lovelace'));
  mockDirectory.set('bob@corp.example', entry('bob', 'Bob Builder'));
});

afterAll(async () => {
  await Promise.all(connections.map((mongoose) => mongoose.disconnect()));
  await mongo?.stop();
  setEnv(savedEnv);
}, 180000);

describe('admin panel sign-in with LDAP configured', () => {
  let app;
  beforeAll(async () => {
    app = await loadApp({ LDAP_URL, LDAP_USER_SEARCH_BASE });
  }, 180000);

  it('signs in a directory user who holds admin access', async () => {
    const response = await signIn(app, { email: 'ada@corp.example', password: DIRECTORY_PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body.token).toEqual(expect.any(String));
    expect(response.body.user).toMatchObject({ email: 'ada@corp.example', provider: 'ldap' });
    expect(mockConsulted).toEqual(['ldapauth']);
  });

  it('refuses a directory user who lacks admin access', async () => {
    const response = await signIn(app, { email: 'bob@corp.example', password: DIRECTORY_PASSWORD });

    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('token');
    expect(mockConsulted).toEqual(['ldapauth']);
  });

  it('refuses wrong directory credentials without falling back to a local account', async () => {
    const wrong = await signIn(app, { email: 'ada@corp.example', password: 'not-the-secret' });
    const local = await signIn(app, { email: 'root@local.example', password: LOCAL_PASSWORD });

    expect(wrong.status).toBe(404);
    expect(wrong.body).toEqual({ message: 'Invalid username/password' });
    expect(local.status).toBe(404);
    expect(local.body).not.toHaveProperty('token');
    expect(mockConsulted).toEqual(['ldapauth', 'ldapauth']);
  });

  it('rejects malformed credentials before they reach the directory', async () => {
    const response = await signIn(app, { email: { $ne: null }, password: DIRECTORY_PASSWORD });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ message: 'Invalid credentials' });
    expect(mockConsulted).toEqual([]);
  });
});

describe.each([
  ['LDAP is not configured', {}],
  ['only the LDAP server is set', { LDAP_URL }],
  ['only the LDAP search base is set', { LDAP_USER_SEARCH_BASE }],
])('admin panel sign-in when %s', (_label, env) => {
  let app;
  beforeAll(async () => {
    app = await loadApp(env);
  }, 180000);

  it('signs in a local admin through the local account store', async () => {
    const response = await signIn(app, { email: 'root@local.example', password: LOCAL_PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({ email: 'root@local.example', provider: 'local' });
    expect(mockConsulted).toEqual(['local']);
  });

  it('does not ask the directory about anyone else', async () => {
    const response = await signIn(app, { email: 'ada@corp.example', password: DIRECTORY_PASSWORD });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ message: 'Email does not exist.' });
    expect(mockConsulted).toEqual(['local']);
  });
});
