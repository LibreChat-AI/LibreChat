import { Keyv } from 'keyv';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import session from 'express-session';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import type { ProviderCheckResult } from './provider';
import { createOpenIDSessionCheck, validateOpenIDSessionCheck } from './service';
import { applyOpenIDAuthGeneration } from './generation';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

const identity = { iss: 'https://issuer.test', sub: 'A' };
function fixture(enabled = true, shared?: { cache: Keyv; sessions: session.MemoryStore }) {
  const cache = shared?.cache ?? new Keyv();
  const retire = jest.fn(async () => {});
  const clear = jest.fn((req) => {
    delete req.session.openidTokens;
  });
  const verify = jest.fn<Promise<ProviderCheckResult>, unknown[]>(async () => ({
    status: 'verified',
    identity,
  }));
  const authorize = jest.fn(async ({ state }) => `https://issuer.test/authorize?state=${state}`);
  const observe = jest.fn();
  const service = createOpenIDSessionCheck({
    cache,
    jwtRefreshSecret: 'test-marker-secret',
    retire,
    clear,
    observe,
    getConfig: async () => ({ registration: { openidSessionCheck: enabled } }),
    clientDomain: 'https://app.test',
    serverDomain: 'https://app.test',
    provider: { authorize, verify },
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.cookies = Object.fromEntries(
      (req.headers.cookie ?? '')
        .split(';')
        .filter(Boolean)
        .map((value) => {
          const index = value.indexOf('=');
          return [value.slice(0, index).trim(), value.slice(index + 1)];
        }),
    );
    next();
  });
  app.use(
    session({
      secret: 'test-session-secret',
      resave: false,
      saveUninitialized: false,
      store: shared?.sessions,
    }),
  );
  app.post('/login/:subject', (req, res) => {
    Object.assign(req.session, {
      openidTokens: {
        authGenerationId: `generation-${req.params.subject}`,
        openidIssuer: identity.iss,
        openidSubject: req.params.subject,
        appUserId: req.params.subject,
        refreshToken: 'original-refresh',
      },
    });
    res.sendStatus(204);
  });
  app.post('/destroy', (req, res) => {
    req.session.destroy(() => res.sendStatus(204));
  });
  app.get('/tokens', (req, res) => {
    res.json(req.session);
  });
  app.post('/start', service.start);
  app.get('/callback', service.callback, (_req, res) => {
    res.sendStatus(418);
  });
  app.post('/complete', service.complete);
  const server = app.listen(0);
  servers.push(server);
  const agent = request.agent(server).set('Connection', 'close');
  const start = async () => {
    const response = await agent.post('/start').send({ returnTo: '/c/chat?x=1' }).expect(200);
    return new URL(response.body.authorizationUrl).searchParams.get('state')!;
  };
  const callback = async (state: string) => {
    const response = await agent.get('/callback').query({ state, code: 'code' }).expect(302);
    return new URL(response.headers.location).searchParams.get('openid_check')!;
  };
  return { app, agent, cache, service, start, callback, retire, clear, authorize, verify, observe };
}

describe('OpenID browser session check', () => {
  it('is disabled by default and rejects incompatible opt-in', () => {
    expect(() => validateOpenIDSessionCheck({}, {})).not.toThrow();
    expect(() =>
      validateOpenIDSessionCheck({ registration: { openidSessionCheck: true } }, {}),
    ).toThrow('OPENID_REUSE_TOKENS');
  });
  it('does not contact the provider for disabled or non-OpenID sessions', async () => {
    for (const enabled of [false, true]) {
      const f = fixture(enabled);
      if (!enabled) await f.agent.post('/login/A');
      expect((await f.agent.post('/start').send({})).body.status).toBe('not_required');
      expect(f.authorize).not.toHaveBeenCalled();
    }
  });
  it('does not check or retire an OpenID identity after the browser switches to local login', async () => {
    const f = fixture();
    const login = await f.agent.post('/login/A');
    f.verify.mockResolvedValue({ status: 'login_required' });
    const receipt = await f.callback(await f.start());
    const cookies = `${login.headers['set-cookie'][0].split(';')[0]}; token_provider=librechat`;
    const response = await request(f.app).post('/start').set('Cookie', cookies).send({});
    expect(response.body.status).toBe('not_required');
    await request(f.app).post('/complete').set('Cookie', cookies).send({ receipt }).expect(409);
    expect(f.retire).not.toHaveBeenCalled();
  });
  it('requires login for legacy cookies without a bound identity', async () => {
    const f = fixture();
    const response = await f.agent.post('/start').set('Cookie', 'token_provider=openid').send({});
    expect(response.body.status).toBe('login_required');
  });
  it.each(['verified', 'login_required', 'different'] as const)(
    'checks recovered identity after session expiry: %s',
    async (outcome) => {
      const f = fixture();
      const marker = jwt.sign(
        {
          id: 'A',
          openidIssuer: identity.iss,
          openidSubject: 'A',
          authGenerationId: 'generation-A',
          tenantId: 'tenant-A',
          refreshTokenHash: createHash('sha256').update('original-refresh').digest('base64url'),
        },
        'test-marker-secret',
        { expiresIn: 60 },
      );
      await f.agent.post('/login/A');
      await f.agent.post('/destroy');
      f.agent.set(
        'Cookie',
        `token_provider=openid; refreshToken=original-refresh; openid_user_id=${marker}`,
      );
      if (outcome === 'login_required') f.verify.mockResolvedValue({ status: 'login_required' });
      if (outcome === 'different')
        f.verify.mockResolvedValue({ status: 'verified', identity: { ...identity, sub: 'B' } });
      const state = await f.start();
      const tokens = (await f.agent.get('/tokens')).body.openidTokens;
      expect(tokens).toEqual({
        appUserId: 'A',
        openidIssuer: identity.iss,
        openidSubject: 'A',
        authGenerationId: 'generation-A',
        tenantId: 'tenant-A',
        refreshToken: 'original-refresh',
        browserRefreshToken: 'original-refresh',
      });
      const receipt = await f.callback(state);
      expect((await f.agent.post('/complete').send({ receipt })).body.status).toBe(
        outcome === 'verified' ? 'verified' : 'login_required',
      );
      if (outcome === 'verified') expect(f.retire).not.toHaveBeenCalled();
      else expect(f.retire).toHaveBeenCalledWith(expect.anything(), tokens);
    },
  );
  it('offers Retry without contacting the provider when recovered session storage fails', async () => {
    const shared = { cache: new Keyv(), sessions: new session.MemoryStore() };
    const f = fixture(true, shared);
    const marker = jwt.sign(
      {
        id: 'A',
        openidIssuer: identity.iss,
        openidSubject: 'A',
        authGenerationId: 'generation-A',
        refreshTokenHash: createHash('sha256').update('original-refresh').digest('base64url'),
      },
      'test-marker-secret',
      { expiresIn: 60 },
    );
    jest.spyOn(shared.sessions, 'set').mockImplementationOnce((_id, _session, callback) => {
      callback?.(new Error('store unavailable'));
    });
    const response = await f.agent
      .post('/start')
      .set(
        'Cookie',
        `token_provider=openid; refreshToken=original-refresh; openid_user_id=${marker}`,
      )
      .send({})
      .expect(503);
    expect(response.body).toEqual({ status: 'unavailable' });
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.clear).not.toHaveBeenCalled();
    expect(f.retire).not.toHaveBeenCalled();
  });
  it('rejects conflicting cookie and session generations without overwriting the current login', async () => {
    const f = fixture();
    await f.agent.post('/login/B');
    const marker = jwt.sign(
      {
        id: 'A',
        openidIssuer: identity.iss,
        openidSubject: 'A',
        authGenerationId: 'generation-A',
        refreshTokenHash: createHash('sha256').update('original-refresh').digest('base64url'),
      },
      'test-marker-secret',
      { expiresIn: 60 },
    );
    f.agent.set(
      'Cookie',
      `token_provider=openid; refreshToken=original-refresh; openid_user_id=${marker}`,
    );
    f.verify.mockResolvedValue({ status: 'verified', identity: { ...identity, sub: 'B' } });
    expect(await f.callback(await f.start())).toBe('invalid');
    expect(f.retire).not.toHaveBeenCalled();
    expect((await f.agent.get('/tokens')).body.openidTokens.authGenerationId).toBe('generation-B');
  });
  it('accepts an existing generation cookie when the live server session still holds the full identity', async () => {
    const f = fixture();
    await f.agent.post('/login/A');
    const marker = jwt.sign(
      {
        id: 'A',
        authGenerationId: 'generation-A',
        refreshTokenHash: createHash('sha256').update('original-refresh').digest('base64url'),
      },
      'test-marker-secret',
      { expiresIn: 60 },
    );
    f.agent.set(
      'Cookie',
      `token_provider=openid; refreshToken=original-refresh; openid_user_id=${marker}`,
    );
    const receipt = await f.callback(await f.start());
    expect((await f.agent.post('/complete').send({ receipt })).body.status).toBe('verified');
    await f.agent.post('/destroy');
    expect((await f.agent.post('/start').send({})).body.status).toBe('login_required');
  });
  it('checks the same identity without publishing or changing tokens', async () => {
    const f = fixture();
    await f.agent.post('/login/A');
    const receipt = await f.callback(await f.start());
    expect((await f.agent.post('/complete').send({ receipt })).body.status).toBe('verified');
    expect((await f.agent.get('/tokens')).body.openidTokens.refreshToken).toBe('original-refresh');
    expect(f.retire).not.toHaveBeenCalled();
  });
  it('compares the validated issuer using the stored identity normalization', async () => {
    const f = fixture();
    f.verify.mockResolvedValue({
      status: 'verified',
      identity: { ...identity, iss: `${identity.iss}/` },
    });
    await f.agent.post('/login/A');
    const receipt = await f.callback(await f.start());
    expect((await f.agent.post('/complete').send({ receipt })).body.status).toBe('verified');
    expect(f.retire).not.toHaveBeenCalled();
  });
  it.each(['different', 'missing'] as const)(
    'retires only the captured session when identity is %s',
    async (kind) => {
      const f = fixture();
      f.verify.mockResolvedValue(
        kind === 'different'
          ? { status: 'verified', identity: { ...identity, sub: 'B' } }
          : { status: 'login_required' },
      );
      await f.agent.post('/login/A');
      const receipt = await f.callback(await f.start());
      expect(f.retire).not.toHaveBeenCalled();
      expect((await f.agent.post('/complete').send({ receipt })).body.status).toBe(
        'login_required',
      );
      expect(f.retire).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ authGenerationId: 'generation-A' }),
      );
      expect((await f.agent.get('/tokens')).body.openidTokens).toBeUndefined();
    },
  );
  it('does not treat interaction or transport failure as logout', async () => {
    const f = fixture();
    await f.agent.post('/login/A');
    for (const outcome of ['interaction_required', 'unavailable']) {
      if (outcome === 'unavailable')
        f.verify.mockRejectedValue(new Error('private provider response'));
      else f.verify.mockResolvedValue({ status: 'interaction_required' });
      const receipt = await f.callback(await f.start());
      expect((await f.agent.post('/complete').send({ receipt })).body).toEqual({ status: outcome });
    }
    expect(f.retire).not.toHaveBeenCalled();
  });
  it('keeps concurrent tab transactions independent and consumes each once', async () => {
    const f = fixture();
    await f.agent.post('/login/A');
    const [first, second] = await Promise.all([f.start(), f.start()]);
    expect(first).not.toBe(second);
    const receipts = await Promise.all([f.callback(first), f.callback(second)]);
    for (const receipt of receipts) {
      await f.agent.post('/complete').send({ receipt }).expect(200);
      await f.agent.post('/complete').send({ receipt }).expect(400);
    }
    expect(await f.callback(first)).toBe('invalid');
  });
  it('shares a transaction and a single-use receipt across server replicas', async () => {
    const shared = { cache: new Keyv(), sessions: new session.MemoryStore() };
    const first = fixture(true, shared);
    const second = fixture(true, shared);
    const login = await first.agent.post('/login/A');
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const state = await first.start();
    const callback = await second.agent
      .get('/callback')
      .set('Cookie', cookie)
      .query({ state, code: 'code' })
      .expect(302);
    const receipt = new URL(callback.headers.location).searchParams.get('openid_check');
    const completed = await first.agent.post('/complete').send({ receipt }).expect(200);
    expect(completed.body.status).toBe('verified');
    await second.agent.post('/complete').set('Cookie', cookie).send({ receipt }).expect(400);
  });
  it('does not let another browser consume the transaction or completion', async () => {
    const f = fixture();
    await f.agent.post('/login/A');
    const state = await f.start();
    await request(f.app).get('/callback').query({ state, error: 'login_required' }).expect(302);
    const receipt = await f.callback(state);
    await request(f.app).post('/complete').send({ receipt }).expect(400);
    const response = await f.agent.post('/complete').send({ receipt }).expect(200);
    expect(response.body.status).toBe('verified');
  });
  it('rejects a callback when its server session disappears during the provider request', async () => {
    const f = fixture();
    await f.agent.post('/login/A');
    const state = await f.start();
    f.verify.mockImplementation(async () => {
      await f.agent.post('/destroy');
      return { status: 'login_required' };
    });
    expect(await f.callback(state)).toBe('invalid');
    expect(f.retire).not.toHaveBeenCalled();
  });
  it('does not clear B when A callback or completion arrives late', async () => {
    const f = fixture();
    f.verify.mockResolvedValue({ status: 'login_required' });
    await f.agent.post('/login/A');
    const first = await f.start();
    const receipt = await f.callback(await f.start());
    await f.agent.post('/login/B');
    expect(await f.callback(first)).toBe('invalid');
    await f.agent.post('/complete').send({ receipt }).expect(409);
    expect(f.retire).not.toHaveBeenCalled();
    expect((await f.agent.get('/tokens')).body.openidTokens.openidSubject).toBe('B');
  });
  it('does not clear a newer browser login when its request still carries the old server session', async () => {
    const f = fixture();
    await f.agent.post('/login/A');
    f.verify.mockResolvedValue({ status: 'login_required' });
    const receipt = await f.callback(await f.start());
    const marker = jwt.sign(
      {
        id: 'B',
        openidIssuer: identity.iss,
        openidSubject: 'B',
        authGenerationId: 'generation-B',
        refreshTokenHash: createHash('sha256').update('refresh-B').digest('base64url'),
      },
      'test-marker-secret',
      { expiresIn: 60 },
    );
    await f.agent
      .post('/complete')
      .set('Cookie', `token_provider=openid; refreshToken=refresh-B; openid_user_id=${marker}`)
      .send({ receipt })
      .expect(409);
    expect(f.clear).not.toHaveBeenCalled();
    expect(f.retire).not.toHaveBeenCalled();
  });

  it('preserves B if login advances while retirement is running', async () => {
    const f = fixture();
    await f.agent.post('/login/A');
    f.verify.mockResolvedValue({ status: 'login_required' });
    const receipt = await f.callback(await f.start());
    f.retire.mockImplementation(async () => {
      await f.agent.post('/login/B');
    });
    await f.agent.post('/complete').send({ receipt }).expect(409);
    expect(f.clear).not.toHaveBeenCalled();
  });
  it('rejects external return paths and keeps ordinary callbacks on the login route', async () => {
    const f = fixture();
    await f.agent.post('/login/A');
    const response = await f.agent.post('/start').send({ returnTo: '//evil.test' });
    const state = new URL(response.body.authorizationUrl).searchParams.get('state');
    const callback = await f.agent.get('/callback').query({ state, code: 'code' });
    expect(new URL(callback.headers.location).origin).toBe('https://app.test');
    await f.agent.get('/callback').query({ state: 'passport-state' }).expect(418);
  });
  it('preserves a login generation on refresh and replaces it on full login', () => {
    const tokens: { authGenerationId?: string } = {};
    applyOpenIDAuthGeneration({ session: { openidTokens: { authGenerationId: 'A' } } }, tokens);
    expect(tokens.authGenerationId).toBe('A');
    applyOpenIDAuthGeneration(
      { openidLoginGeneration: 'B', session: { openidTokens: tokens } },
      tokens,
    );
    expect(tokens.authGenerationId).toBe('B');
  });
});
