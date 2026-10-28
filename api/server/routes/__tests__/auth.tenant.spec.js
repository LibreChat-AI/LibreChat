const { MongoMemoryServer } = require('mongodb-memory-server');

let express;
let request;
let passport;
let mongoose;
let bcrypt;
let schemas;
let api;
const REFUSAL = {
  message: 'Tenant context required in strict isolation mode',
  code: 'TENANT_CONTEXT_REQUIRED',
};
const password = 'Tenant-test-password-123!';
let mongo;
let app;
let models;
let findUser;
let originalFindUser;
let userA;
let userB;
let platformUser;
let oauthAttempts;
const savedEnv = { ...process.env };

describe.each([false, true])('pre-auth tenant routes (strict=%s)', (strictMode) => {
  beforeAll(async () => {
    process.env.TRUST_TENANT_HEADER = 'true';
    process.env.BAN_VIOLATIONS = 'false';
    process.env.LOGIN_MAX = '1000';
    process.env.DOMAIN_CLIENT = 'http://localhost:3080';
    process.env.DOMAIN_SERVER = 'http://localhost:3080';
    process.env.TENANT_ISOLATION_STRICT = String(strictMode);
    jest.resetModules();
    express = require('express');
    request = require('supertest');
    passport = require('passport');
    mongoose = require('mongoose');
    bcrypt = require('bcryptjs');
    schemas = require('@librechat/data-schemas');
    api = require('@librechat/api');
    mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
    await mongoose.connect(mongo.getUri());
    schemas.createModels(mongoose);
    models = require('~/models');
    originalFindUser = models.findUser;
    findUser = jest.spyOn(models, 'findUser');
    passport.use('local', require('~/strategies/localStrategy')());
    oauthAttempts = jest.fn();
    for (const name of ['google', 'googleAdmin']) {
      passport.use(name, {
        name,
        authenticate() {
          oauthAttempts();
          this.fail({ message: 'Identity provider refused' });
        },
      });
    }
    await schemas.runAsSystem(async () => {
      await models.initializeRoles();
      await models.seedSystemGrants();
      const hash = await bcrypt.hash(password, 4);
      [userA, userB, platformUser] = await Promise.all(
        ['tenant-a', 'tenant-b', undefined].map((tenantId) =>
          mongoose.models.User.create({
            email: tenantId ? 'admin@example.com' : 'platform@example.com',
            name: tenantId || 'Platform',
            username: tenantId || 'platform',
            password: hash,
            emailVerified: true,
            provider: 'local',
            role: 'ADMIN',
            tenantId,
          }),
        ),
      );
    });
    app = express();
    app.use(express.json());
    app.use(passport.initialize());
    app.use('/api/auth', api.preAuthTenantMiddleware, require('../auth'));
    app.use('/api/admin', require('../admin/auth'));
    app.use('/api/user', require('../user'));
    app.use('/oauth', api.preAuthTenantMiddleware, require('../oauth'));
    app.use(api.ErrorController);
  }, 180000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await mongoose.disconnect();
    await mongo?.stop();
    process.env = savedEnv;
  }, 180000);

  beforeEach(() => {
    findUser.mockClear().mockImplementation(originalFindUser);
    oauthAttempts.mockClear();
  });

  if (strictMode) {
    it.each(['admin@example.com', 'platform@example.com', 'unknown@example.com'])(
      'refuses strict login for %s before looking up any account',
      async (email) => {
        const response = await request(app).post('/api/auth/login').send({ email, password });
        expect(response.status).toBe(403);
        expect(response.body).toEqual(REFUSAL);
        expect(findUser).not.toHaveBeenCalled();
      },
    );

    it.each([
      '/api/auth/register',
      '/api/auth/requestPasswordReset',
      '/api/auth/resetPassword',
      '/api/auth/passkey/login/options',
      '/api/auth/passkey/login/verify',
      '/api/auth/2fa/verify-temp',
      '/api/auth/2fa/setup',
      '/api/auth/2fa/setup/confirm',
      '/api/auth/2fa/setup/acknowledge',
      '/api/auth/2fa/setup/finalize',
      '/api/user/verify',
      '/api/user/verify/resend',
      '/api/admin/login/local',
    ])('refuses %s without a pre-auth tenant in strict mode', async (path) => {
      const response = await request(app).post(path).send({});
      expect(response.status).toBe(403);
      expect(response.body).toEqual(REFUSAL);
      expect(findUser).not.toHaveBeenCalled();
    });
  }

  it('admin login honors the trusted tenant header', async () => {
    const observed = [];
    findUser.mockImplementation((...args) => {
      observed.push(schemas.getTenantId());
      return originalFindUser(...args);
    });
    const response = await request(app)
      .post('/api/admin/login/local')
      .set('X-Tenant-Id', 'tenant-b')
      .send({ email: 'admin@example.com', password });
    expect(observed).toEqual(['tenant-b']);
    expect(response.status).toBe(200);
    expect(response.body.user.id).toBe(userB._id.toString());
    expect(response.body.user.id).not.toBe(userA._id.toString());
  });

  it('keeps tenant login working and does not find a platform user in that tenant', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .set('X-Tenant-Id', 'tenant-a')
      .send({ email: 'admin@example.com', password });
    expect(response.status).toBe(200);
    expect(response.body.user.id).toBe(userA._id.toString());
    const missing = await request(app)
      .post('/api/auth/login')
      .set('X-Tenant-Id', 'tenant-a')
      .send({ email: platformUser.email, password });
    expect(missing.status).toBe(404);
  });

  if (!strictMode) {
    it('does not require a tenant for platform login outside strict mode', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({ email: platformUser.email, password });
      expect(response.status).toBe(200);
      expect(response.body.user.id).toBe(platformUser._id.toString());
    });
  }

  if (strictMode) {
    it.each(
      ['google', 'facebook', 'openid', 'github', 'discord', 'apple', 'saml'].flatMap((provider) => [
        `/oauth/${provider}`,
        `/api/admin/oauth/${provider}`,
      ]),
    )('refuses %s before contacting an identity provider without a tenant', async (path) => {
      const response = await request(app).get(path);
      expect(response.status).toBe(403);
      expect(response.body).toEqual(REFUSAL);
      expect(oauthAttempts).not.toHaveBeenCalled();
    });

    it.each(
      ['google', 'facebook', 'openid', 'github', 'discord', 'apple', 'saml'].flatMap((provider) => [
        `/oauth/${provider}/callback`,
        `/api/admin/oauth/${provider}/callback`,
      ]),
    )('redirects %s to an authentication error without invoking the strategy', async (path) => {
      const method = /\/(apple|saml)\/callback$/.test(path) ? 'post' : 'get';
      const response = await request(app)[method](path).send({});
      expect(response.status).toBe(302);
      expect(response.headers.location).toContain('TENANT_CONTEXT_REQUIRED');
      expect(oauthAttempts).not.toHaveBeenCalled();
    });
  }

  it('carries the trusted tenant into email verification', async () => {
    const tenants = [];
    findUser.mockImplementation((...args) => {
      tenants.push(schemas.getTenantId());
      return originalFindUser(...args);
    });
    const response = await request(app)
      .post('/api/user/verify')
      .set('X-Tenant-Id', 'tenant-b')
      .send({ email: 'admin@example.com', token: 'invalid' });
    expect(response.status).toBe(400);
    expect(tenants).toEqual(['tenant-b']);
  });

  it('verifies only the account in the resolved tenant with a real token', async () => {
    const token = 'tenant-email-verification-token';
    const hash = await bcrypt.hash(token, 4);
    await schemas.runAsSystem(async () => {
      await mongoose.models.User.updateMany(
        { _id: { $in: [userA._id, userB._id] } },
        { $set: { emailVerified: false } },
      );
    });
    await schemas.tenantStorage.run({ tenantId: 'tenant-b' }, async () => {
      await models.createToken({
        userId: userB._id,
        email: userB.email,
        type: 'email_verification',
        token: hash,
        createdAt: Date.now(),
        expiresIn: 900,
      });
    });
    const response = await request(app)
      .post('/api/user/verify')
      .set('X-Tenant-Id', 'tenant-b')
      .send({ email: userB.email, token });
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('success');
    await schemas.runAsSystem(async () => {
      expect((await models.getUserById(userA._id)).emailVerified).toBe(false);
      expect((await models.getUserById(userB._id)).emailVerified).toBe(true);
    });
  });
});
