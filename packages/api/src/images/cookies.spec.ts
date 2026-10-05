import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { createOptionalCookieAuth } from './cookies';

describe('browser file session authentication', () => {
  const userId = '65cfb246f7ecadb8b1e8036b';
  const secret = 'cookie-auth-test-secret';
  const token = jwt.sign({ id: userId }, secret, { expiresIn: '1h' });
  const findSession = jest.fn();
  const getUserById = jest.fn();
  const log = jest.fn();
  let openId = false;
  const auth = () =>
    createOptionalCookieAuth({
      parseCookies: (header) =>
        Object.fromEntries(
          header.split(';').map((entry) => {
            const [key, ...value] = entry.trim().split('=');
            return [key, value.join('=')];
          }),
        ),
      getSecret: () => secret,
      isOpenIdReuseEnabled: () => openId,
      asSystem: (work) => work(),
      findSession,
      getUserById,
      clearCloudFrontCookies: jest.fn(),
      log,
    });
  const app = () => {
    const result = express();
    result.use((req, _res, next) => {
      if (req.headers.authorization === 'Bearer fixture') req.user = { id: 'bearer-user' };
      next();
    });
    result.use(auth());
    result.get('/', (req, res) => {
      res.json(req.user ?? null);
    });
    return result;
  };
  beforeEach(() => {
    jest.clearAllMocks();
    openId = false;
    findSession.mockResolvedValue({ userId });
    getUserById.mockResolvedValue({ tenantId: 'tenant-a' });
  });

  it('reuses the bearer user without a session or user lookup', async () => {
    const response = await request(app())
      .get('/')
      .set('Authorization', 'Bearer fixture')
      .set('Cookie', `refreshToken=${token}`);
    expect(response.body).toEqual({ id: 'bearer-user' });
    expect(findSession).not.toHaveBeenCalled();
    expect(getUserById).not.toHaveBeenCalled();
  });
  it('resolves a signed refresh cookie with an active session and preserves tenant ownership', async () => {
    const response = await request(app()).get('/').set('Cookie', `refreshToken=${token}`);
    expect(response.body).toEqual({
      id: userId,
      role: 'USER',
      tenantId: 'tenant-a',
      idOnTheSource: null,
    });
    expect(findSession).toHaveBeenCalledWith({ userId, refreshToken: token });
    expect(getUserById).toHaveBeenCalledTimes(1);
  });
  it.each([
    '',
    'refreshToken=invalid',
    `refreshToken=${jwt.sign({ id: userId }, 'wrong-secret')}`,
    `refreshToken=${jwt.sign({ id: userId }, secret, { expiresIn: -1 })}`,
  ])('rejects missing, forged and expired credentials: %s', async (cookie) => {
    expect((await request(app()).get('/').set('Cookie', cookie)).body).toBeNull();
    expect(getUserById).not.toHaveBeenCalled();
    expect(findSession).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    'loads the user while session validation is pending and only authenticates an active session: %s',
    async (active) => {
      let finishSession!: (value: object | null) => void;
      findSession.mockReturnValueOnce(
        new Promise((resolve) => {
          finishSession = resolve;
        }),
      );
      const req = { headers: { cookie: `refreshToken=${token}` } } as Request;
      const next = jest.fn();
      const pending = auth()(req, {} as Response, next);
      expect(findSession).toHaveBeenCalledTimes(1);
      expect(getUserById).toHaveBeenCalledTimes(1);
      await Promise.resolve();
      expect(req.user).toBeUndefined();
      expect(next).not.toHaveBeenCalled();
      finishSession(active ? { userId } : null);
      await pending;
      expect(next).toHaveBeenCalledTimes(1);
      if (active) expect(req.user).toMatchObject({ id: userId, tenantId: 'tenant-a' });
      else expect(req.user).toBeUndefined();
    },
  );
  it('rejects revoked sessions, removed users and accounts being deleted', async () => {
    findSession.mockResolvedValueOnce(null);
    expect((await request(app()).get('/').set('Cookie', `refreshToken=${token}`)).body).toBeNull();
    expect(getUserById).toHaveBeenCalledTimes(1);
    getUserById
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ agentTriggerDeletionStartedAt: new Date() });
    expect((await request(app()).get('/').set('Cookie', `refreshToken=${token}`)).body).toBeNull();
    expect((await request(app()).get('/').set('Cookie', `refreshToken=${token}`)).body).toBeNull();
  });
  it('requires the signed OpenID identity to bind the refresh token and a live session', async () => {
    openId = true;
    const refreshToken = 'provider-refresh';
    const identity = jwt.sign(
      {
        id: userId,
        refreshTokenHash: createHash('sha256').update(refreshToken).digest('base64url'),
      },
      secret,
    );
    const cookies = `token_provider=openid; openid_user_id=${identity}; refreshToken=${refreshToken}`;
    expect((await request(app()).get('/').set('Cookie', cookies)).body.id).toBe(userId);
    findSession.mockResolvedValueOnce(null);
    expect((await request(app()).get('/').set('Cookie', cookies)).body).toBeNull();
    expect(
      (await request(app()).get('/').set('Cookie', cookies.replace(refreshToken, 'other-refresh')))
        .body,
    ).toBeNull();
    expect(findSession).toHaveBeenCalledTimes(2);
  });
  it('preserves legacy OpenID session binding without adding a durable-session query', async () => {
    openId = true;
    const refreshToken = 'legacy-provider-refresh';
    const identity = jwt.sign({ id: userId }, secret, { expiresIn: '1h' });
    const req = {
      headers: {
        cookie: `token_provider=openid; openid_user_id=${identity}; refreshToken=${refreshToken}`,
      },
      session: { openidTokens: { refreshToken } },
    } as unknown as Request;
    const next = jest.fn();
    await auth()(req, {} as Response, next);
    expect(req.user).toMatchObject({ id: userId, tenantId: 'tenant-a' });
    expect(findSession).not.toHaveBeenCalled();
    expect(getUserById).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });
  it('fails closed on a session-store error without preventing a public route response', async () => {
    findSession.mockRejectedValueOnce(new Error('session store unavailable'));
    const response = await request(app()).get('/').set('Cookie', `refreshToken=${token}`);
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
  });
});
