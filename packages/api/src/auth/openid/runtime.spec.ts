const mockCreateOpenIDAuthorizationMethods = jest.fn();
const mockCreateResourceLockModel = jest.fn();
const mockCreateResourceLockMethods = jest.fn();
const mockDetectMongoEngine = jest.fn();
const mockResolveAuthorizationQueryOptions = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  createOpenIDAuthorizationMethods: (...args: unknown[]) =>
    mockCreateOpenIDAuthorizationMethods(...args),
  createResourceLockModel: (...args: unknown[]) => mockCreateResourceLockModel(...args),
  createResourceLockMethods: (...args: unknown[]) => mockCreateResourceLockMethods(...args),
  detectMongoEngine: (...args: unknown[]) => mockDetectMongoEngine(...args),
  resolveAuthorizationQueryOptions: (...args: unknown[]) =>
    mockResolveAuthorizationQueryOptions(...args),
}));

import { createOpenIDSessionsRuntime } from './runtime';

const ORIGINAL_ENV = process.env;

const mockIsOpenIdConfigured = jest.fn();
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const mockAsPromise = jest.fn();
const mockCreateConnection = jest.fn((..._args: unknown[]) => ({ asPromise: mockAsPromise }));
const fakeMongoose = { createConnection: (...args: unknown[]) => mockCreateConnection(...args) };

function buildRuntime() {
  return createOpenIDSessionsRuntime({
    mongoose: fakeMongoose as unknown as typeof import('mongoose'),
    logger: mockLogger,
    isOpenIdConfigured: mockIsOpenIdConfigured,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
  process.env = { ...ORIGINAL_ENV, MONGO_URI: 'mongodb://localhost/test' };
  mockIsOpenIdConfigured.mockReturnValue(true);
  mockDetectMongoEngine.mockResolvedValue('standalone');
  mockResolveAuthorizationQueryOptions.mockReturnValue({ maxTimeMS: 3_000 });
  mockCreateOpenIDAuthorizationMethods.mockReturnValue({ methodsMarker: true });
  mockCreateResourceLockMethods.mockReturnValue({ leaseMarker: true });
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  jest.useRealTimers();
});

describe('isOpenIdConfigured', () => {
  it('delegates to the injected leaf check', () => {
    const runtime = buildRuntime();
    mockIsOpenIdConfigured.mockReturnValue(false);
    expect(runtime.isOpenIdConfigured()).toBe(false);
    expect(mockIsOpenIdConfigured).toHaveBeenCalledTimes(1);
  });
});

describe('getOpenIdClientId', () => {
  it('reads OPENID_CLIENT_ID from the environment', () => {
    const runtime = buildRuntime();
    process.env.OPENID_CLIENT_ID = 'client-123';
    expect(runtime.getOpenIdClientId()).toBe('client-123');
  });
});

describe('connectOpenIDAuthorization', () => {
  it('returns undefined without attempting a connection when OpenID is not configured', async () => {
    const runtime = buildRuntime();
    mockIsOpenIdConfigured.mockReturnValue(false);
    const result = await runtime.connectOpenIDAuthorization({});
    expect(result).toBeUndefined();
    expect(mockCreateConnection).not.toHaveBeenCalled();
  });

  it('fails authorization closed when enforcement is on but OpenID is not configured', async () => {
    const runtime = buildRuntime();
    mockIsOpenIdConfigured.mockReturnValue(false);

    const result = await runtime.connectOpenIDAuthorization({
      registration: { openidSessionEnforcement: true },
    });

    expect(result).toBeUndefined();
    expect(mockCreateConnection).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('not configured'));

    const deps = runtime.sessionAuthorizationRef;
    expect(deps).toMatchObject({ enforcement: true });
    const authorize = await import('./sessions').then((mod) => mod.authorizeOpenIDSession);
    const authResult = await authorize(
      {
        issuer: 'https://issuer.test',
        clientId: 'client',
        subject: 'sub',
        user: 'user-1',
        sid: 'sid-1',
      },
      deps as Parameters<typeof authorize>[1],
    );
    expect(authResult).toEqual({ ok: false, code: 'unavailable' });

    await runtime.connectOpenIDAuthorization({ registration: { openidSessionEnforcement: true } });
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
  });

  it('stays unchanged when enforcement is off and OpenID is not configured', async () => {
    const runtime = buildRuntime();
    mockIsOpenIdConfigured.mockReturnValue(false);

    const result = await runtime.connectOpenIDAuthorization({
      registration: { openidSessionEnforcement: false },
    });

    expect(result).toBeUndefined();
    expect(mockCreateConnection).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(runtime.sessionAuthorizationRef).toEqual({});
  });

  it('getters resolve to undefined before any connection attempt', () => {
    const runtime = buildRuntime();
    expect(runtime.getAuthorizationMethods()).toBeUndefined();
    expect(runtime.getAuthorizationDeps()).toBeUndefined();
    expect(runtime.getLoginDeps()).toBeUndefined();
    expect(runtime.getRevokeDeps()).toBeUndefined();
    expect(runtime.getLeaseMethods()).toBeUndefined();
  });

  it('connects successfully and populates every getter', async () => {
    const runtime = buildRuntime();
    mockAsPromise.mockResolvedValue({ connectionMarker: true });

    const authorization = await runtime.connectOpenIDAuthorization({
      registration: { openidSessionEnforcement: true },
    });

    expect(authorization).toBeDefined();
    expect(runtime.getAuthorizationMethods()).toEqual({ methodsMarker: true });
    expect(runtime.getAuthorizationDeps()).toMatchObject({ enforcement: true });
    expect(runtime.getLoginDeps()).toBeDefined();
    expect(runtime.getRevokeDeps()).toBeDefined();
  });

  it('builds the backchannel-logout worker lease on the authorization connection, not the main one', async () => {
    const runtime = buildRuntime();
    const authConnection = { connectionMarker: true };
    mockAsPromise.mockResolvedValue(authConnection);

    await runtime.connectOpenIDAuthorization({});

    expect(mockCreateResourceLockModel).toHaveBeenCalledWith(authConnection);
    expect(mockCreateResourceLockMethods).toHaveBeenCalledWith(authConnection);
    expect(runtime.getLeaseMethods()).toEqual({ leaseMarker: true });
  });

  it('clears the lease methods on a failed connection', async () => {
    const runtime = buildRuntime();
    mockAsPromise.mockRejectedValue(new Error('ECONNREFUSED'));

    await runtime.connectOpenIDAuthorization({});

    expect(runtime.getLeaseMethods()).toBeUndefined();
  });

  it('honors MONGO_AUTH_MAX_POOL_SIZE, defaulting to 10 when unset', async () => {
    const runtime = buildRuntime();
    mockAsPromise.mockResolvedValue({ connectionMarker: true });
    await runtime.connectOpenIDAuthorization({});
    expect(mockCreateConnection).toHaveBeenCalledWith(
      'mongodb://localhost/test',
      expect.objectContaining({ maxPoolSize: 10 }),
    );
  });

  it('honors a custom MONGO_AUTH_MAX_POOL_SIZE', async () => {
    process.env.MONGO_AUTH_MAX_POOL_SIZE = '42';
    const runtime = buildRuntime();
    mockAsPromise.mockResolvedValue({ connectionMarker: true });
    await runtime.connectOpenIDAuthorization({});
    expect(mockCreateConnection).toHaveBeenCalledWith(
      'mongodb://localhost/test',
      expect.objectContaining({ maxPoolSize: 42 }),
    );
  });

  it('defaults serverSelectionTimeoutMS and socketTimeoutMS to 5000', async () => {
    const runtime = buildRuntime();
    mockAsPromise.mockResolvedValue({ connectionMarker: true });
    await runtime.connectOpenIDAuthorization({});
    expect(mockCreateConnection).toHaveBeenCalledWith(
      'mongodb://localhost/test',
      expect.objectContaining({ serverSelectionTimeoutMS: 5000, socketTimeoutMS: 5000 }),
    );
  });

  it('honors custom MONGO_AUTH_SERVER_SELECTION_TIMEOUT_MS and MONGO_AUTH_SOCKET_TIMEOUT_MS', async () => {
    process.env.MONGO_AUTH_SERVER_SELECTION_TIMEOUT_MS = '1234';
    process.env.MONGO_AUTH_SOCKET_TIMEOUT_MS = '5678';
    const runtime = buildRuntime();
    mockAsPromise.mockResolvedValue({ connectionMarker: true });
    await runtime.connectOpenIDAuthorization({});
    expect(mockCreateConnection).toHaveBeenCalledWith(
      'mongodb://localhost/test',
      expect.objectContaining({ serverSelectionTimeoutMS: 1234, socketTimeoutMS: 5678 }),
    );
  });

  it('returns the already-open authorization on a later call without reconnecting', async () => {
    const runtime = buildRuntime();
    mockAsPromise.mockResolvedValue({ connectionMarker: true });
    const first = await runtime.connectOpenIDAuthorization({});
    const second = await runtime.connectOpenIDAuthorization({});
    expect(second).toBe(first);
    expect(mockCreateConnection).toHaveBeenCalledTimes(1);
  });

  it('shares a single in-flight connection attempt across concurrent callers', async () => {
    const runtime = buildRuntime();
    let resolveAsPromise: (value: unknown) => void;
    mockAsPromise.mockReturnValue(
      new Promise((resolve) => {
        resolveAsPromise = resolve;
      }),
    );
    const firstCall = runtime.connectOpenIDAuthorization({});
    const secondCall = runtime.connectOpenIDAuthorization({});
    resolveAsPromise!({ connectionMarker: true });
    const [first, second] = await Promise.all([firstCall, secondCall]);
    expect(mockCreateConnection).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it('never throws on a failed connection; it logs, attaches a pending stub, and schedules a retry', async () => {
    jest.useFakeTimers();
    const runtime = buildRuntime();
    mockAsPromise.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await runtime.connectOpenIDAuthorization({
      registration: { openidSessionEnforcement: true },
    });

    expect(result).toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Authorization connection failed'),
      expect.any(Error),
    );
    expect(runtime.getAuthorizationMethods()).toBeUndefined();

    expect(runtime.getAuthorizationDeps()).toBeUndefined();
    const deps = runtime.sessionAuthorizationRef;
    expect(deps).toMatchObject({ enforcement: true });
    await expect(
      (
        deps.authorization as { findOpenIDSession: (query: object) => Promise<unknown> }
      ).findOpenIDSession({}),
    ).rejects.toThrow('OpenID authorization connection is not ready');

    expect(jest.getTimerCount()).toBeGreaterThan(0);
    jest.useRealTimers();
  });

  it('closes the opened connection when a later startup step fails, so the retry does not leak it', async () => {
    jest.useFakeTimers();
    const runtime = buildRuntime();
    const mockClose = jest.fn().mockResolvedValue(undefined);
    mockAsPromise.mockResolvedValue({ connectionMarker: true, close: mockClose });
    mockDetectMongoEngine.mockRejectedValue(new Error('engine detection failed'));

    const result = await runtime.connectOpenIDAuthorization({
      registration: { openidSessionEnforcement: true },
    });

    expect(result).toBeUndefined();
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(runtime.getAuthorizationMethods()).toBeUndefined();
    jest.useRealTimers();
  });

  it('retries in the background after a failed connection and succeeds once Mongo recovers', async () => {
    jest.useFakeTimers();
    const runtime = buildRuntime();
    mockAsPromise.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    mockAsPromise.mockResolvedValueOnce({ connectionMarker: true });

    await runtime.connectOpenIDAuthorization({});
    expect(runtime.getAuthorizationMethods()).toBeUndefined();

    jest.runOnlyPendingTimers();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.getAuthorizationMethods()).toEqual({ methodsMarker: true });
    jest.useRealTimers();
  });
});
