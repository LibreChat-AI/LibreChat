import { OPENID_SESSION_ENDED, OPENID_SESSION_ID_MISSING } from 'librechat-data-provider';
import type { ResolvedBackchannelLogoutConfig } from './config';
import {
  createProviderSessionAuthorizer,
  CALLBACK_EXPIRED,
  type ProviderSessionMethodsDeps,
} from './authorize';
import { ProviderSessionUnavailableError } from './errors';

const ref = { issuer: 'https://idp.example.com', clientId: 'librechat', sid: 'session-1' };
const expiresAt = new Date('2026-01-01T00:00:00Z');
const now = new Date('2025-12-01T00:00:00Z');

function makeConfig(overrides: Partial<ResolvedBackchannelLogoutConfig> = {}) {
  return {
    mode: 'off',
    algorithms: ['RS256'],
    clockToleranceSec: 60,
    maxTokenAgeSec: 120,
    maxBodyBytes: 16384,
    rateLimit: { windowMs: 60_000, max: 60 },
    processingTimeoutMs: 5000,
    callbackGraceMs: 600_000,
    ...overrides,
  } as ResolvedBackchannelLogoutConfig;
}

function makeLogger() {
  return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeMethods(): jest.Mocked<ProviderSessionMethodsDeps> {
  return { establish: jest.fn(), authorize: jest.fn() };
}

describe('createProviderSessionAuthorizer: establish', () => {
  it('off mode: ok without calling the database', async () => {
    const methods = makeMethods();
    const authorizer = createProviderSessionAuthorizer({
      methods,
      getConfig: async () => makeConfig({ mode: 'off' }),
      logger: makeLogger(),
      now: () => now,
    });
    await expect(authorizer.establish({ ref, expiresAt, callbackIssuedAt: now })).resolves.toEqual({
      ok: true,
    });
    expect(methods.establish).not.toHaveBeenCalled();
  });

  it.each(['record', 'enforce'] as const)(
    '%s mode: rejects a callback older than callbackGraceMs before touching the database',
    async (mode) => {
      const methods = makeMethods();
      const authorizer = createProviderSessionAuthorizer({
        methods,
        getConfig: async () => makeConfig({ mode, callbackGraceMs: 1000 }),
        logger: makeLogger(),
        now: () => now,
      });
      await expect(
        authorizer.establish({ ref, expiresAt, callbackIssuedAt: new Date(now.getTime() - 5000) }),
      ).resolves.toEqual({ ok: false, code: CALLBACK_EXPIRED });
      expect(methods.establish).not.toHaveBeenCalled();
    },
  );

  it('record mode: a missing ref establishes without calling the database', async () => {
    const methods = makeMethods();
    const authorizer = createProviderSessionAuthorizer({
      methods,
      getConfig: async () => makeConfig({ mode: 'record' }),
      logger: makeLogger(),
      now: () => now,
    });
    await expect(
      authorizer.establish({ ref: null, expiresAt, callbackIssuedAt: now }),
    ).resolves.toEqual({ ok: true });
    expect(methods.establish).not.toHaveBeenCalled();
  });

  it('enforce mode: a missing ref is denied as OPENID_SESSION_ID_MISSING', async () => {
    const methods = makeMethods();
    const authorizer = createProviderSessionAuthorizer({
      methods,
      getConfig: async () => makeConfig({ mode: 'enforce' }),
      logger: makeLogger(),
      now: () => now,
    });
    await expect(
      authorizer.establish({ ref: null, expiresAt, callbackIssuedAt: now }),
    ).resolves.toEqual({
      ok: false,
      code: OPENID_SESSION_ID_MISSING,
    });
    expect(methods.establish).not.toHaveBeenCalled();
  });

  it.each(['record', 'enforce'] as const)('%s mode: a successful establish is ok', async (mode) => {
    const methods = makeMethods();
    methods.establish.mockResolvedValue({ ok: true });
    const authorizer = createProviderSessionAuthorizer({
      methods,
      getConfig: async () => makeConfig({ mode }),
      logger: makeLogger(),
      now: () => now,
    });
    await expect(
      authorizer.establish({ ref, subject: 'user-1', expiresAt, callbackIssuedAt: now }),
    ).resolves.toEqual({
      ok: true,
    });
    expect(methods.establish).toHaveBeenCalledWith({
      issuer: ref.issuer,
      clientId: ref.clientId,
      sid: ref.sid,
      subject: 'user-1',
      expiresAt,
      now,
    });
  });

  it.each([
    ['ENDED', OPENID_SESSION_ENDED],
    ['CONFLICT', OPENID_SESSION_ENDED],
  ] as const)(
    'maps database %s to %s, logging the result code with a sid hash',
    async (dbCode, wireCode) => {
      const methods = makeMethods();
      methods.establish.mockResolvedValue({ ok: false, code: dbCode });
      const logger = makeLogger();
      const authorizer = createProviderSessionAuthorizer({
        methods,
        getConfig: async () => makeConfig({ mode: 'enforce' }),
        logger,
        now: () => now,
      });
      await expect(
        authorizer.establish({ ref, expiresAt, callbackIssuedAt: now }),
      ).resolves.toEqual({
        ok: false,
        code: wireCode,
      });
      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [, meta] = logger.warn.mock.calls[0];
      expect(meta).toMatchObject({
        issuer: ref.issuer,
        clientId: ref.clientId,
        resultCode: dbCode,
      });
      expect(JSON.stringify(meta)).not.toContain(ref.sid);
    },
  );

  it('enforce mode: a database failure throws ProviderSessionUnavailableError with the original error as cause', async () => {
    const methods = makeMethods();
    const dbError = new Error('connection lost');
    methods.establish.mockRejectedValue(dbError);
    const authorizer = createProviderSessionAuthorizer({
      methods,
      getConfig: async () => makeConfig({ mode: 'enforce' }),
      logger: makeLogger(),
      now: () => now,
    });
    const rejection = authorizer.establish({ ref, expiresAt, callbackIssuedAt: now });
    await expect(rejection).rejects.toBeInstanceOf(ProviderSessionUnavailableError);
    await expect(rejection).rejects.toMatchObject({ cause: dbError });
  });

  it('record mode: a database failure fails open and logs without the raw sid', async () => {
    const methods = makeMethods();
    methods.establish.mockRejectedValue(new Error('connection lost'));
    const logger = makeLogger();
    const authorizer = createProviderSessionAuthorizer({
      methods,
      getConfig: async () => makeConfig({ mode: 'record' }),
      logger,
      now: () => now,
    });
    await expect(authorizer.establish({ ref, expiresAt, callbackIssuedAt: now })).resolves.toEqual({
      ok: true,
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [, meta] = logger.warn.mock.calls[0];
    expect(meta).toMatchObject({ issuer: ref.issuer, clientId: ref.clientId });
    expect(JSON.stringify(meta)).not.toContain(ref.sid);
  });
});

describe('createProviderSessionAuthorizer: authorize', () => {
  it('off mode: ok without calling the database', async () => {
    const methods = makeMethods();
    const authorizer = createProviderSessionAuthorizer({
      methods,
      getConfig: async () => makeConfig({ mode: 'off' }),
      logger: makeLogger(),
      now: () => now,
    });
    await expect(authorizer.authorize({ ref, expiresAt, legacy: false })).resolves.toEqual({
      ok: true,
    });
    expect(methods.authorize).not.toHaveBeenCalled();
  });

  it('record mode: a missing ref is ok without calling the database', async () => {
    const methods = makeMethods();
    const authorizer = createProviderSessionAuthorizer({
      methods,
      getConfig: async () => makeConfig({ mode: 'record' }),
      logger: makeLogger(),
      now: () => now,
    });
    await expect(authorizer.authorize({ ref: null, expiresAt, legacy: true })).resolves.toEqual({
      ok: true,
    });
    expect(methods.authorize).not.toHaveBeenCalled();
  });

  it('enforce mode: a missing ref is denied', async () => {
    const methods = makeMethods();
    const authorizer = createProviderSessionAuthorizer({
      methods,
      getConfig: async () => makeConfig({ mode: 'enforce' }),
      logger: makeLogger(),
      now: () => now,
    });
    await expect(authorizer.authorize({ ref: null, expiresAt, legacy: true })).resolves.toEqual({
      ok: false,
      code: OPENID_SESSION_ENDED,
    });
    expect(methods.authorize).not.toHaveBeenCalled();
  });

  it.each(['record', 'enforce'] as const)('%s mode: a successful authorize is ok', async (mode) => {
    const methods = makeMethods();
    methods.authorize.mockResolvedValue({ ok: true });
    const authorizer = createProviderSessionAuthorizer({
      methods,
      getConfig: async () => makeConfig({ mode }),
      logger: makeLogger(),
      now: () => now,
    });
    await expect(
      authorizer.authorize({ ref, subject: 'user-1', expiresAt, legacy: false }),
    ).resolves.toEqual({ ok: true });
    expect(methods.authorize).toHaveBeenCalledWith({
      issuer: ref.issuer,
      clientId: ref.clientId,
      sid: ref.sid,
      subject: 'user-1',
      expiresAt,
      now,
    });
  });

  it.each([
    ['record', 'ENDED'],
    ['enforce', 'ENDED'],
    ['record', 'CONFLICT'],
    ['enforce', 'CONFLICT'],
  ] as const)('%s mode: %s is always denied, never failing open', async (mode, dbCode) => {
    const methods = makeMethods();
    methods.authorize.mockResolvedValue({ ok: false, code: dbCode });
    const authorizer = createProviderSessionAuthorizer({
      methods,
      getConfig: async () => makeConfig({ mode }),
      logger: makeLogger(),
      now: () => now,
    });
    await expect(authorizer.authorize({ ref, expiresAt, legacy: false })).resolves.toEqual({
      ok: false,
      code: OPENID_SESSION_ENDED,
    });
  });

  it('enforce mode: MISSING is denied', async () => {
    const methods = makeMethods();
    methods.authorize.mockResolvedValue({ ok: false, code: 'MISSING' });
    const authorizer = createProviderSessionAuthorizer({
      methods,
      getConfig: async () => makeConfig({ mode: 'enforce' }),
      logger: makeLogger(),
      now: () => now,
    });
    await expect(authorizer.authorize({ ref, expiresAt, legacy: false })).resolves.toEqual({
      ok: false,
      code: OPENID_SESSION_ENDED,
    });
  });

  it('record mode: MISSING fails open and logs without the raw sid', async () => {
    const methods = makeMethods();
    methods.authorize.mockResolvedValue({ ok: false, code: 'MISSING' });
    const logger = makeLogger();
    const authorizer = createProviderSessionAuthorizer({
      methods,
      getConfig: async () => makeConfig({ mode: 'record' }),
      logger,
      now: () => now,
    });
    await expect(authorizer.authorize({ ref, expiresAt, legacy: true })).resolves.toEqual({
      ok: true,
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [, meta] = logger.warn.mock.calls[0];
    expect(meta).toMatchObject({ issuer: ref.issuer, clientId: ref.clientId, legacy: true });
    expect(JSON.stringify(meta)).not.toContain(ref.sid);
  });

  it('enforce mode: a database failure throws ProviderSessionUnavailableError with the original error as cause', async () => {
    const methods = makeMethods();
    const dbError = new Error('connection lost');
    methods.authorize.mockRejectedValue(dbError);
    const authorizer = createProviderSessionAuthorizer({
      methods,
      getConfig: async () => makeConfig({ mode: 'enforce' }),
      logger: makeLogger(),
      now: () => now,
    });
    const rejection = authorizer.authorize({ ref, expiresAt, legacy: false });
    await expect(rejection).rejects.toBeInstanceOf(ProviderSessionUnavailableError);
    await expect(rejection).rejects.toMatchObject({ cause: dbError });
  });

  it('record mode: a database failure fails open and logs without the raw sid', async () => {
    const methods = makeMethods();
    methods.authorize.mockRejectedValue(new Error('connection lost'));
    const logger = makeLogger();
    const authorizer = createProviderSessionAuthorizer({
      methods,
      getConfig: async () => makeConfig({ mode: 'record' }),
      logger,
      now: () => now,
    });
    await expect(authorizer.authorize({ ref, expiresAt, legacy: false })).resolves.toEqual({
      ok: true,
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.warn.mock.calls[0][1])).not.toContain(ref.sid);
  });

  it('never caches a result: two authorize calls hit the database twice', async () => {
    const methods = makeMethods();
    methods.authorize.mockResolvedValue({ ok: true });
    const authorizer = createProviderSessionAuthorizer({
      methods,
      getConfig: async () => makeConfig({ mode: 'enforce' }),
      logger: makeLogger(),
      now: () => now,
    });
    await authorizer.authorize({ ref, expiresAt, legacy: false });
    await authorizer.authorize({ ref, expiresAt, legacy: false });
    expect(methods.authorize).toHaveBeenCalledTimes(2);
  });
});

describe('createProviderSessionAuthorizer: preCheck', () => {
  it('reuses authorize, passing legacy: false', async () => {
    const methods = makeMethods();
    methods.authorize.mockResolvedValue({ ok: true });
    const authorizer = createProviderSessionAuthorizer({
      methods,
      getConfig: async () => makeConfig({ mode: 'enforce' }),
      logger: makeLogger(),
      now: () => now,
    });
    await expect(authorizer.preCheck({ ref, subject: 'user-1', expiresAt })).resolves.toEqual({
      ok: true,
    });
    expect(methods.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'user-1', expiresAt }),
    );
  });

  it('denies the same way authorize would for an ended session', async () => {
    const methods = makeMethods();
    methods.authorize.mockResolvedValue({ ok: false, code: 'ENDED' });
    const authorizer = createProviderSessionAuthorizer({
      methods,
      getConfig: async () => makeConfig({ mode: 'enforce' }),
      logger: makeLogger(),
      now: () => now,
    });
    await expect(authorizer.preCheck({ ref, expiresAt })).resolves.toEqual({
      ok: false,
      code: OPENID_SESSION_ENDED,
    });
  });
});

describe('createProviderSessionAuthorizer: config load failure', () => {
  it('establish: a rejected getConfig throws ProviderSessionUnavailableError, not mode "off"', async () => {
    const methods = makeMethods();
    const loadError = new Error('config unavailable');
    const authorizer = createProviderSessionAuthorizer({
      methods,
      getConfig: () => Promise.reject(loadError),
      logger: makeLogger(),
      now: () => now,
    });
    const rejection = authorizer.establish({ ref, expiresAt, callbackIssuedAt: now });
    await expect(rejection).rejects.toBeInstanceOf(ProviderSessionUnavailableError);
    await expect(rejection).rejects.toMatchObject({ cause: loadError });
    expect(methods.establish).not.toHaveBeenCalled();
  });

  it('authorize: a rejected getConfig throws ProviderSessionUnavailableError, not mode "off"', async () => {
    const methods = makeMethods();
    const loadError = new Error('config unavailable');
    const authorizer = createProviderSessionAuthorizer({
      methods,
      getConfig: () => Promise.reject(loadError),
      logger: makeLogger(),
      now: () => now,
    });
    const rejection = authorizer.authorize({ ref, expiresAt, legacy: false });
    await expect(rejection).rejects.toBeInstanceOf(ProviderSessionUnavailableError);
    await expect(rejection).rejects.toMatchObject({ cause: loadError });
    expect(methods.authorize).not.toHaveBeenCalled();
  });

  it('getMode: a rejected getConfig throws ProviderSessionUnavailableError', async () => {
    const methods = makeMethods();
    const loadError = new Error('config unavailable');
    const authorizer = createProviderSessionAuthorizer({
      methods,
      getConfig: () => Promise.reject(loadError),
      logger: makeLogger(),
      now: () => now,
    });
    await expect(authorizer.getMode()).rejects.toBeInstanceOf(ProviderSessionUnavailableError);
  });

  it('a slow-but-eventually-successful getConfig is awaited rather than skipped', async () => {
    const methods = makeMethods();
    methods.authorize.mockResolvedValue({ ok: true });
    const authorizer = createProviderSessionAuthorizer({
      methods,
      getConfig: () =>
        new Promise((resolve) => setTimeout(() => resolve(makeConfig({ mode: 'enforce' })), 5)),
      logger: makeLogger(),
      now: () => now,
    });
    await expect(authorizer.authorize({ ref, expiresAt, legacy: false })).resolves.toEqual({
      ok: true,
    });
    expect(methods.authorize).toHaveBeenCalledTimes(1);
  });
});

describe('createProviderSessionAuthorizer: getMode', () => {
  it.each(['off', 'record', 'enforce'] as const)(
    'resolves the configured mode: %s',
    async (mode) => {
      const methods = makeMethods();
      const authorizer = createProviderSessionAuthorizer({
        methods,
        getConfig: async () => makeConfig({ mode }),
        logger: makeLogger(),
        now: () => now,
      });
      await expect(authorizer.getMode()).resolves.toBe(mode);
    },
  );
});
