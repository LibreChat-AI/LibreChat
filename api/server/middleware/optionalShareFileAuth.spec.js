const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const mockClearCloudFrontCookies = jest.fn();

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  clearCloudFrontCookies: (...args) => mockClearCloudFrontCookies(...args),
}));
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  runAsSystem: (work) => work(),
}));
jest.mock('~/models', () => ({
  findSession: jest.fn(),
  getUserById: jest.fn(),
}));

const db = require('~/models');
const optionalShareFileAuth = require('./optionalShareFileAuth');
const viewerId = '507f1f77bcf86cd799439011';
const secret = 'share-cookie-wiring-test-secret';

function createApp(user) {
  const app = express();
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.use(optionalShareFileAuth);
  app.get('/file', (req, res) => res.json({ user: req.user ?? null }));
  return app;
}

describe('optional share-file cookie auth wiring', () => {
  const originalSecret = process.env.JWT_REFRESH_SECRET;
  const originalReuse = process.env.OPENID_REUSE_TOKENS;
  const originalEnforce = process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_REFRESH_SECRET = secret;
    process.env.OPENID_REUSE_TOKENS = 'true';
    delete process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION;
  });

  afterAll(() => {
    if (originalSecret === undefined) delete process.env.JWT_REFRESH_SECRET;
    else process.env.JWT_REFRESH_SECRET = originalSecret;
    if (originalReuse === undefined) delete process.env.OPENID_REUSE_TOKENS;
    else process.env.OPENID_REUSE_TOKENS = originalReuse;
    if (originalEnforce === undefined) delete process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION;
    else process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = originalEnforce;
  });

  it('reuses a loaded bearer viewer', async () => {
    const response = await request(createApp({ id: viewerId }))
      .get('/file')
      .set('Cookie', 'refreshToken=invalid')
      .expect(200);
    expect(response.body.user.id).toBe(viewerId);
    expect(db.findSession).not.toHaveBeenCalled();
    expect(db.getUserById).not.toHaveBeenCalled();
  });

  it('removes a loaded bearer viewer whose required enrollment is incomplete', async () => {
    process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'true';
    const response = await request(
      createApp({ id: viewerId, provider: 'local', twoFactorEnabled: false }),
    )
      .get('/file')
      .set('Cookie', 'refreshToken=invalid')
      .expect(200);
    expect(response.body.user).toBeNull();
    expect(mockClearCloudFrontCookies).toHaveBeenCalledWith(expect.any(Object), {
      userId: viewerId,
      tenantId: undefined,
      storageRegion: undefined,
    });
    expect(db.findSession).not.toHaveBeenCalled();
    expect(db.getUserById).not.toHaveBeenCalled();
  });

  it('loads a viewer through the shared authenticator from a live refresh cookie', async () => {
    const token = jwt.sign({ id: viewerId }, secret, { expiresIn: '1m' });
    db.findSession.mockResolvedValue({ user: viewerId });
    db.getUserById.mockResolvedValue({ _id: viewerId, role: 'USER' });
    const response = await request(createApp())
      .get('/file')
      .set('Cookie', `refreshToken=${token}`)
      .expect(200);
    expect(response.body.user.id).toBe(viewerId);
    expect(db.findSession).toHaveBeenCalledWith({ userId: viewerId, refreshToken: token });
    expect(mockClearCloudFrontCookies).not.toHaveBeenCalled();
  });

  it('does not restore a cookie viewer whose required enrollment is incomplete', async () => {
    process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'true';
    const token = jwt.sign({ id: viewerId }, secret, { expiresIn: '1m' });
    db.findSession.mockResolvedValue({ user: viewerId });
    db.getUserById.mockResolvedValue({
      _id: viewerId,
      role: 'USER',
      provider: 'local',
      twoFactorEnabled: false,
      tenantId: 'tenant-a',
    });
    const response = await request(createApp())
      .get('/file')
      .set('Cookie', `refreshToken=${token}`)
      .expect(200);
    expect(response.body.user).toBeNull();
    expect(mockClearCloudFrontCookies).toHaveBeenCalledWith(expect.any(Object), {
      userId: viewerId,
      tenantId: 'tenant-a',
      storageRegion: undefined,
    });
  });

  it.each([
    ['two-factor enrollment', 'twoFactorEnrolledAt'],
    ['a password reset', 'credentialsChangedAt'],
  ])('does not restore a cookie viewer minted before %s', async (_event, field) => {
    const issuedAtMs = Date.now() - 60_000;
    const token = jwt.sign({ id: viewerId, issuedAtMs }, secret, { expiresIn: '1m' });
    db.findSession.mockResolvedValue({ user: viewerId });
    db.getUserById.mockResolvedValue({
      _id: viewerId,
      role: 'USER',
      [field]: new Date(issuedAtMs + 1_000),
    });
    const response = await request(createApp())
      .get('/file')
      .set('Cookie', `refreshToken=${token}`)
      .expect(200);
    expect(response.body.user).toBeNull();
    expect(mockClearCloudFrontCookies).toHaveBeenCalledWith(expect.any(Object), {
      userId: viewerId,
      tenantId: undefined,
      storageRegion: undefined,
    });
  });

  it('keeps a cookie viewer minted after enrollment', async () => {
    const issuedAtMs = Date.now() - 60_000;
    const token = jwt.sign({ id: viewerId, issuedAtMs }, secret, { expiresIn: '1m' });
    db.findSession.mockResolvedValue({ user: viewerId });
    db.getUserById.mockResolvedValue({
      _id: viewerId,
      role: 'USER',
      twoFactorEnrolledAt: new Date(issuedAtMs - 1_000),
    });
    const response = await request(createApp())
      .get('/file')
      .set('Cookie', `refreshToken=${token}`)
      .expect(200);
    expect(response.body.user.id).toBe(viewerId);
    expect(mockClearCloudFrontCookies).not.toHaveBeenCalled();
  });

  it('leaves OpenID viewers anonymous without the signed identity cookie', async () => {
    const response = await request(createApp())
      .get('/file')
      .set('Cookie', 'token_provider=openid; refreshToken=provider-token')
      .expect(200);
    expect(response.body.user).toBeNull();
    expect(db.findSession).not.toHaveBeenCalled();
    expect(db.getUserById).not.toHaveBeenCalled();
  });
});
