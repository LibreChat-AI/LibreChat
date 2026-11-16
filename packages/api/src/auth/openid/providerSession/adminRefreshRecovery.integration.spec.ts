import mongoose from 'mongoose';
import crypto from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import type { ProviderSessionRef } from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import type {
  AdminOpenIdRefreshPrepareResult,
  AdminRefreshGrantDeps,
  BuildAdminRefreshProviderSessionDepsInput,
} from './adminRefreshDeps';
import type { OpenIDRefreshRecoveryDeps } from '~/auth/openid/recovery';
import type { SharedOpenIDRefreshResult } from '~/auth/openid/types';
import type { RefreshTokenBridgeDeps } from '~/auth/openid/bridge';
import type { ResolvedBackchannelLogoutConfig } from './config';
import type { TokenResult } from '~/auth/openid/flight';
import type { RefreshTokenset } from '~/auth/refresh';
import { prepareAdminOpenIdRefresh, runAdminOpenIdRefreshGrant } from './adminRefreshDeps';
import { createOpenIDRefreshRecoveryService } from '~/auth/openid/recovery';
import { createOpenIDRefreshFlightService } from '~/auth/openid/flight';
import { createRefreshTokenBridgeService } from '~/auth/openid/bridge';
import { createRefreshTokenBridgeIdentity } from '~/utils/identity';
import { createProviderSessionAuthorizer } from './authorize';
import { mapAdminAuthError } from '~/auth/adminAuthErrors';
import { applyAdminRefresh } from '~/auth/refresh';

/**
 * End-to-end coverage for the admin refresh recovery sequence
 * (`prepareAdminOpenIdRefresh` -> `runAdminOpenIdRefreshGrant` -> `applyAdminRefresh`) against a
 * real database, in both `record` and `enforce` mode. Only the IdP grant is mocked. Covers:
 *   - the bridge-before-missing-session-denial ordering: a retry that presents a refresh token a
 *     prior rotation already replaced must recover through the refresh-token bridge instead of
 *     being denied as an unassociated credential;
 *   - the Session row a bridged-and-rotated retry replaces is deleted, not left orphaned, while a
 *     bridged retry a non-rotating IdP answers keeps its Session row; and
 *   - a tenant user's bridge is found on retry regardless of whether the request carries tenant
 *     context, as long as it carries the same context (or lack of it) on both requests.
 */

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;

const ISSUER = 'https://idp.example.com';
const CLIENT_ID = 'librechat-admin';
const SID = 'sid-admin-1';

const testUserId = new mongoose.Types.ObjectId();
const ADMIN_USER_ID = testUserId.toString();
const testUser = {
  _id: testUserId,
  email: 'admin@example.com',
  name: 'Admin User',
  username: 'admin',
  role: 'ADMIN',
  provider: 'openid',
  openidId: 'sub-1',
  openidIssuer: ISSUER,
} as unknown as IUser;

const TENANT_ID = 'tenant-t';
const tenantUserId = new mongoose.Types.ObjectId();
const TENANT_USER_ID = tenantUserId.toString();
const tenantUser = {
  _id: tenantUserId,
  email: 'tenant-admin@example.com',
  name: 'Tenant Admin User',
  username: 'tenant-admin',
  role: 'ADMIN',
  provider: 'openid',
  openidId: 'sub-tenant-1',
  openidIssuer: ISSUER,
  tenantId: TENANT_ID,
} as unknown as IUser;

function makeLogger() {
  return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function future(ms = 60_000): Date {
  return new Date(Date.now() + ms);
}

function makeConfig(
  mode: ResolvedBackchannelLogoutConfig['mode'],
): ResolvedBackchannelLogoutConfig {
  return {
    mode,
    algorithms: ['RS256'],
    clockToleranceSec: 60,
    maxTokenAgeSec: 120,
    maxBodyBytes: 16384,
    rateLimit: { windowMs: 60_000, max: 60 },
    processingTimeoutMs: 5000,
    callbackGraceMs: 600_000,
  };
}

function makeTokenset(
  presentedRefreshToken: string,
  sid: string = SID,
  sub: string = 'sub-1',
): RefreshTokenset {
  return {
    access_token: `at-${presentedRefreshToken}`,
    refresh_token: `${presentedRefreshToken}-r`,
    claims: () => ({ sub, iss: ISSUER, sid }),
  };
}

function makeGrant(sub?: string): jest.Mock<Promise<RefreshTokenset>, [string]> {
  return jest.fn((presented: string) => Promise.resolve(makeTokenset(presented, SID, sub)));
}

/** A grant whose first call rotates the presented token (establishing the bridge a retry will
 *  recover), but whose second call — the retry's grant against the bridged token — returns no
 *  `refresh_token`, mirroring an IdP with rotation disabled. */
function makeNonRotatingRetryGrant(): jest.Mock<Promise<RefreshTokenset>, [string]> {
  let calls = 0;
  return jest.fn((presented: string) => {
    calls += 1;
    if (calls === 1) {
      return Promise.resolve(makeTokenset(presented));
    }
    return Promise.resolve({
      access_token: `at-${presented}`,
      refresh_token: undefined,
      claims: () => ({ sub: 'sub-1', iss: ISSUER, sid: SID }),
    });
  });
}

async function makeBridgeService() {
  return createRefreshTokenBridgeService({
    db: {
      upsertRefreshTokenBridge: methods.upsertRefreshTokenBridge,
      findRefreshTokenBridge: methods.findRefreshTokenBridge,
      deleteRefreshTokenBridges: methods.deleteRefreshTokenBridges,
    } as RefreshTokenBridgeDeps['db'],
    logger: makeLogger(),
    encrypt: async (value: string) => value,
    decrypt: async (value: string) => value,
    math: (_value: string | undefined, fallback: number) => fallback,
    defaultRefreshTokenExpiry: 1000 * 60 * 60 * 24 * 7,
    createIdentity: createRefreshTokenBridgeIdentity,
  });
}

/** Mirrors the admin route's own `findProviderSessionBinding` wrapper in
 *  `api/server/routes/admin/auth.js`: reads the binding off the Session row keyed by the
 *  presented refresh token. */
function findProviderSessionBinding(token: string) {
  return methods.findSession({ refreshToken: token }, { lean: true }).then((session) => {
    if (!session) return null;
    return {
      userId: session.user ? String(session.user) : undefined,
      tenantId: session.tenantId,
      providerSession: session.providerSession,
    };
  });
}

/** Builds a fresh, individually-spied `prepareAdminOpenIdRefresh` input so a test can assert
 *  exactly how many times each provider-session/bridge dependency was touched by one call. */
function buildDepsInput(
  config: ResolvedBackchannelLogoutConfig,
  bridgeService: Awaited<ReturnType<typeof makeBridgeService>>,
  overrides: Partial<BuildAdminRefreshProviderSessionDepsInput> = {},
): BuildAdminRefreshProviderSessionDepsInput {
  return {
    authorizer: createProviderSessionAuthorizer({
      methods: {
        establish: methods.establishProviderSession,
        authorize: methods.authorizeProviderSession,
      },
      getConfig: () => Promise.resolve(config),
      logger: makeLogger(),
    }),
    getProviderSessionClient: jest.fn(() => ({ issuer: ISSUER, clientId: CLIENT_ID })),
    findProviderSessionBinding: jest.fn(findProviderSessionBinding),
    getRefreshTokenBridge: jest.fn(bridgeService.getRefreshTokenBridge),
    storeRefreshTokenBridge: jest.fn(bridgeService.storeRefreshTokenBridge),
    deleteRefreshTokenBridges: jest.fn(bridgeService.deleteRefreshTokenBridges),
    bridgeGraceMs: bridgeService.OPENID_REFRESH_BRIDGE_GRACE_MS,
    upsertSession: jest.fn(methods.upsertSession),
    deleteSession: jest.fn(methods.deleteSession),
    getRefreshTokenExpiryMs: jest.fn(() => 1000 * 60 * 60 * 24 * 90),
    ...overrides,
  };
}

/** Seeds the state an admin panel already holds: an established provider session and the
 *  Session row the login flow would have created for it. */
async function seedLoggedIn(
  refreshToken: string,
  userId: string,
  options: { tenantId?: string; sid?: string; subject?: string } = {},
): Promise<ProviderSessionRef> {
  const ref: ProviderSessionRef = { issuer: ISSUER, clientId: CLIENT_ID, sid: options.sid ?? SID };
  await methods.establishProviderSession({
    issuer: ref.issuer,
    clientId: ref.clientId,
    sid: ref.sid,
    subject: options.subject ?? 'sub-1',
    expiresAt: future(),
    now: new Date(),
  });
  await methods.upsertSession(userId, refreshToken, {
    expiration: future(),
    tenantId: options.tenantId,
    providerSession: ref,
    authMethod: 'openid',
  });
  return ref;
}

type RunOutcome = {
  status: number;
  body: Record<string, unknown>;
  depsInput: BuildAdminRefreshProviderSessionDepsInput;
  prepared?: AdminOpenIdRefreshPrepareResult;
};

/** Replicates the `/api/admin/oauth/refresh` route handler's exact sequence:
 *  `prepareAdminOpenIdRefresh` -> `runAdminOpenIdRefreshGrant` -> `applyAdminRefresh`. */
async function runAdminRefresh(args: {
  refreshToken: string;
  config: ResolvedBackchannelLogoutConfig;
  bridgeService: Awaited<ReturnType<typeof makeBridgeService>>;
  userId?: string;
  tenantId?: string;
  grant: (presented: string) => Promise<RefreshTokenset>;
  flightDeps?: AdminRefreshGrantDeps;
  depsOverrides?: Partial<BuildAdminRefreshProviderSessionDepsInput>;
}): Promise<RunOutcome> {
  const depsInput = buildDepsInput(args.config, args.bridgeService, args.depsOverrides);

  let prepared: AdminOpenIdRefreshPrepareResult;
  try {
    prepared = await prepareAdminOpenIdRefresh(args.refreshToken, depsInput, {
      expectedIssuer: ISSUER,
      userId: args.userId,
      tenantId: args.tenantId,
    });
  } catch (error) {
    const mapped = mapAdminAuthError(error);
    if (!mapped) throw error;
    return { status: mapped.status, body: mapped.body, depsInput };
  }

  let tokenset: RefreshTokenset;
  try {
    tokenset = await runAdminOpenIdRefreshGrant(
      () => args.grant(prepared.grantRefreshToken),
      args.refreshToken,
      prepared,
      args.flightDeps ?? {},
    );
  } catch (error) {
    const mapped = mapAdminAuthError(error);
    if (!mapped) throw error;
    return { status: mapped.status, body: mapped.body, depsInput, prepared };
  }

  try {
    const result = await applyAdminRefresh(
      tokenset,
      {
        findUsers: jest.fn().mockResolvedValue([]),
        getUserById: async (id: string) => {
          if (id === ADMIN_USER_ID) return testUser;
          if (id === TENANT_USER_ID) return tenantUser;
          return null;
        },
        mintToken: async (_user, ts) => ({
          token: `minted-${ts.refresh_token}`,
          expiresAt: Date.now() + 100_000,
        }),
        ...prepared.providerSessionDeps,
      },
      {
        userId: args.userId,
        previousRefreshToken: args.refreshToken,
        grantRefreshToken: prepared.grantRefreshToken,
        expectedIssuer: ISSUER,
        tenantId: args.tenantId,
        boundProviderSession: prepared.binding.ref,
        bridgeIdentity: prepared.identity,
      },
    );
    return {
      status: 200,
      body: result as unknown as Record<string, unknown>,
      depsInput,
      prepared,
    };
  } catch (error) {
    const mapped = mapAdminAuthError(error);
    if (!mapped) throw error;
    return { status: mapped.status, body: mapped.body, depsInput, prepared };
  }
}

/** A faithful-enough in-memory fake of the flight-coordination deps: tracks one in-flight grant
 *  per key, and lets a loser wait for the winner's published result, matching the contract
 *  `runAdminOpenIdRefreshGrant` relies on. `onWaiterRegistered` fires exactly when a loser starts
 *  waiting, giving a test a deterministic signal instead of a fixed sleep. */
function makeFlightDeps(onWaiterRegistered?: () => void): AdminRefreshGrantDeps {
  const flights = new Map<
    string,
    {
      ownerId: string;
      result: TokenResult | null;
      waiters: Array<(result: TokenResult | null) => void>;
    }
  >();

  return {
    createRefreshTokenBridgeFlightKey: ({ oldRefreshToken, userId, tenantId, openidIssuer }) => {
      if (!oldRefreshToken || !userId) return null;
      return ['flight', userId, tenantId ?? '', openidIssuer ?? '', oldRefreshToken].join('|');
    },
    acquireOpenIDRefreshFlight: async ({ key }) => {
      if (!key) return { acquired: true, ownerId: crypto.randomUUID() };
      const existing = flights.get(key);
      if (existing) return { acquired: false, ownerId: existing.ownerId };
      const ownerId = crypto.randomUUID();
      flights.set(key, { ownerId, result: null, waiters: [] });
      return { acquired: true, ownerId };
    },
    completeOpenIDRefreshFlight: async ({ key, tokens }) => {
      if (!key) return null;
      const flight = flights.get(key);
      if (!flight) return null;
      flight.result = tokens ?? null;
      flight.waiters.forEach((resolve) => resolve(flight.result));
      flight.waiters = [];
      flights.delete(key);
      return null;
    },
    waitForOpenIDRefreshFlight: ({ key }) => {
      if (!key) return Promise.resolve(null);
      const flight = flights.get(key);
      if (!flight) return Promise.resolve(null);
      if (flight.result) return Promise.resolve(flight.result);
      const pending = new Promise<TokenResult | null>((resolve) => flight.waiters.push(resolve));
      onWaiterRegistered?.();
      return pending;
    },
    withOpenIDRefreshFlightLease: ({ operation }) =>
      operation({ assertLeaseOwned: async () => true }),
  };
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
  process.env.NODE_ENV = 'test';
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

/** Clears documents only (not indexes): `dropDatabase()` would also drop the unique index that
 *  `ensureIndexes()` memoizes creating just once per `methods` instance. */
beforeEach(async () => {
  await Promise.all(
    Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})),
  );
});

describe.each(['record', 'enforce'] as const)('admin refresh recovery (%s mode)', (mode) => {
  const config = makeConfig(mode);

  it('(a) recovers a bridged rotation when the lost response is retried with the spent token', async () => {
    const bridgeService = await makeBridgeService();
    const A = 'refresh-a';
    await seedLoggedIn(A, ADMIN_USER_ID);
    const grant = makeGrant();

    const first = await runAdminRefresh({
      refreshToken: A,
      config,
      bridgeService,
      userId: ADMIN_USER_ID,
      grant,
    });
    expect(first.status).toBe(200);
    expect(grant).toHaveBeenNthCalledWith(1, A);
    // The response is "lost": the client never persists `first.body`, and retries with A again.

    const retry = await runAdminRefresh({
      refreshToken: A,
      config,
      bridgeService,
      userId: ADMIN_USER_ID,
      grant,
    });

    expect(retry.status).toBe(200);
    expect(grant).toHaveBeenNthCalledWith(2, `${A}-r`); // grant uses the bridged token (C), not A
    expect(grant).toHaveBeenCalledTimes(2);

    const newSession = await methods.findSession({ refreshToken: `${A}-r-r` }, { lean: true });
    expect(newSession).not.toBeNull();

    // Orphan-session fix: the Session row the first (lost) request wrote for the bridged token
    // (A-r, i.e. C) must not outlive the retry that rotated it again — only Session(C2) survives.
    const staleA = await methods.findSession({ refreshToken: A }, { lean: true });
    expect(staleA).toBeNull();
    const staleC = await methods.findSession({ refreshToken: `${A}-r` }, { lean: true });
    expect(staleC).toBeNull();

    const bridge = await bridgeService.getRefreshTokenBridge({
      oldRefreshToken: A,
      userId: ADMIN_USER_ID,
      openidIssuer: ISSUER,
    });
    expect(bridge?.refreshToken).toBe(`${A}-r-r`); // re-pointed from A-r to A-r-r
  });

  it('(b) denies a retry with 401 and leaves no bridge once the provider session ended between requests', async () => {
    const bridgeService = await makeBridgeService();
    const A = 'refresh-b';
    const ref = await seedLoggedIn(A, ADMIN_USER_ID);
    const grant = makeGrant();

    const first = await runAdminRefresh({
      refreshToken: A,
      config,
      bridgeService,
      userId: ADMIN_USER_ID,
      grant,
    });
    expect(first.status).toBe(200);

    await methods.revokeProviderSession({
      issuer: ref.issuer,
      clientId: ref.clientId,
      sid: ref.sid,
      expiresAt: future(),
      now: new Date(),
    });

    const retry = await runAdminRefresh({
      refreshToken: A,
      config,
      bridgeService,
      userId: ADMIN_USER_ID,
      grant,
    });

    expect(retry.status).toBe(401);
    expect(retry.body.error_code).toBe('OPENID_SESSION_ENDED');
    expect(grant).toHaveBeenCalledTimes(1); // only the first (pre-logout) call ever reached the IdP

    const bridge = await bridgeService.getRefreshTokenBridge({
      oldRefreshToken: A,
      userId: ADMIN_USER_ID,
      openidIssuer: ISSUER,
    });
    expect(bridge).toBeNull();
  });

  it('(c) tolerates a session-store failure after rotation, then recovers the bridge on retry', async () => {
    const bridgeService = await makeBridgeService();
    const A = 'refresh-c';
    await seedLoggedIn(A, ADMIN_USER_ID);
    const grant = makeGrant();

    const first = await runAdminRefresh({
      refreshToken: A,
      config,
      bridgeService,
      userId: ADMIN_USER_ID,
      grant,
      depsOverrides: {
        upsertSession: jest.fn().mockRejectedValue(new Error('session store unavailable')),
      },
    });

    if (mode === 'enforce') {
      expect(first.status).toBe(503);
    } else {
      expect(first.status).toBe(200);
    }

    // The bridge is stored right after the grant, before the failing session-store step, so it
    // survives regardless of mode.
    const bridgeAfterFirst = await bridgeService.getRefreshTokenBridge({
      oldRefreshToken: A,
      userId: ADMIN_USER_ID,
      openidIssuer: ISSUER,
    });
    expect(bridgeAfterFirst?.refreshToken).toBe(`${A}-r`);

    const retry = await runAdminRefresh({
      refreshToken: A,
      config,
      bridgeService,
      userId: ADMIN_USER_ID,
      grant,
    });

    expect(retry.status).toBe(200);
    expect(grant).toHaveBeenNthCalledWith(2, `${A}-r`);

    const newSession = await methods.findSession({ refreshToken: `${A}-r-r` }, { lean: true });
    expect(newSession).not.toBeNull();
  });

  it('(d) answers 503 and never calls the IdP grant when the bridge lookup itself throws', async () => {
    const bridgeService = await makeBridgeService();
    const A = 'refresh-d';
    await seedLoggedIn(A, ADMIN_USER_ID);
    const grant = makeGrant();
    const failingGetRefreshTokenBridge = jest.fn().mockRejectedValue(new Error('bridge db down'));

    const result = await runAdminRefresh({
      refreshToken: A,
      config,
      bridgeService,
      userId: ADMIN_USER_ID,
      grant,
      depsOverrides: { getRefreshTokenBridge: failingGetRefreshTokenBridge },
    });

    expect(result.status).toBe(503);
    expect(grant).not.toHaveBeenCalled();
  });

  it('(e) has no binding and no bridge: enforce denies as missing, record proceeds', async () => {
    const bridgeService = await makeBridgeService();
    const unknownToken = 'refresh-e-unknown';
    const grant = makeGrant();

    const result = await runAdminRefresh({
      refreshToken: unknownToken,
      config,
      bridgeService,
      userId: ADMIN_USER_ID,
      grant,
    });

    if (mode === 'enforce') {
      expect(result.status).toBe(401);
      expect(result.body.error_code).toBe('OPENID_SESSION_ENDED');
      expect(grant).not.toHaveBeenCalled();
    } else {
      expect(result.status).toBe(200);
      expect(grant).toHaveBeenCalledTimes(1);
    }
  });

  it('(f) coalesces two concurrent retries sharing a bridge into a single IdP grant', async () => {
    const bridgeService = await makeBridgeService();
    const A = 'refresh-f';
    await seedLoggedIn(A, ADMIN_USER_ID);
    const setupGrant = makeGrant();
    await runAdminRefresh({
      refreshToken: A,
      config,
      bridgeService,
      userId: ADMIN_USER_ID,
      grant: setupGrant,
    }); // response "lost"; the bridge now points A -> `${A}-r`

    let releaseGrant: (() => void) | undefined;
    let grantStartedResolve: (() => void) | undefined;
    const grantStarted = new Promise<void>((resolve) => {
      grantStartedResolve = resolve;
    });
    const grant = jest.fn((presented: string) => {
      grantStartedResolve?.();
      return new Promise<RefreshTokenset>((resolve) => {
        releaseGrant = () => resolve(makeTokenset(presented));
      });
    });
    let waiterRegisteredResolve: (() => void) | undefined;
    const waiterRegistered = new Promise<void>((resolve) => {
      waiterRegisteredResolve = resolve;
    });
    const flightDeps = makeFlightDeps(() => waiterRegisteredResolve?.());

    const call1 = runAdminRefresh({
      refreshToken: A,
      config,
      bridgeService,
      userId: ADMIN_USER_ID,
      grant,
      flightDeps,
    });
    await grantStarted; // call1 is now inside the grant, holding the flight lease
    const call2 = runAdminRefresh({
      refreshToken: A,
      config,
      bridgeService,
      userId: ADMIN_USER_ID,
      grant,
      flightDeps,
    });
    await waiterRegistered; // call2 saw the flight held and is now waiting for call1's result
    releaseGrant?.();

    const [result1, result2] = await Promise.all([call1, call2]);

    expect(grant).toHaveBeenCalledTimes(1);
    expect(result1.status).toBe(200);
    expect(result2.status).toBe(200);
  });

  it("(g) mode 'off' touches no provider-session or bridge dependency", async () => {
    const bridgeService = await makeBridgeService();
    const offConfig = makeConfig('off');
    const A = 'refresh-g';
    const grant = makeGrant();

    const result = await runAdminRefresh({
      refreshToken: A,
      config: offConfig,
      bridgeService,
      userId: ADMIN_USER_ID,
      grant,
    });

    expect(result.status).toBe(200);
    expect(result.depsInput.findProviderSessionBinding).not.toHaveBeenCalled();
    expect(result.depsInput.getRefreshTokenBridge).not.toHaveBeenCalled();
    expect(result.depsInput.storeRefreshTokenBridge).not.toHaveBeenCalled();
    expect(result.depsInput.deleteRefreshTokenBridges).not.toHaveBeenCalled();
    expect(result.depsInput.upsertSession).not.toHaveBeenCalled();
    expect(result.depsInput.deleteSession).not.toHaveBeenCalled();
    expect(result.depsInput.getProviderSessionClient).not.toHaveBeenCalled();
    expect(grant).toHaveBeenCalledTimes(1);
  });

  it('(h) keeps the bridged Session when a non-rotating IdP returns the same token on the retry grant', async () => {
    const bridgeService = await makeBridgeService();
    const A = 'refresh-h';
    await seedLoggedIn(A, ADMIN_USER_ID);
    const grant = makeNonRotatingRetryGrant();

    const first = await runAdminRefresh({
      refreshToken: A,
      config,
      bridgeService,
      userId: ADMIN_USER_ID,
      grant,
    });
    expect(first.status).toBe(200);
    // response "lost"; the bridge now points A -> C (`${A}-r`), and Session(C) exists.

    const C = `${A}-r`;
    const sessionCBeforeRetry = await methods.findSession({ refreshToken: C }, { lean: true });
    expect(sessionCBeforeRetry).not.toBeNull();

    const retry = await runAdminRefresh({
      refreshToken: A,
      config,
      bridgeService,
      userId: ADMIN_USER_ID,
      grant,
    });

    expect(retry.status).toBe(200);
    expect(grant).toHaveBeenNthCalledWith(2, C); // retry's grant uses the bridged token C
    expect(grant).toHaveBeenCalledTimes(2);

    // The IdP didn't rotate C, so the token being stored IS the grant token: Session(C) must
    // survive, not be deleted as a stale bridged predecessor.
    const sessionCAfterRetry = await methods.findSession({ refreshToken: C }, { lean: true });
    expect(sessionCAfterRetry).not.toBeNull();
    const staleA = await methods.findSession({ refreshToken: A }, { lean: true });
    expect(staleA).toBeNull();
  });

  it('(i) recovers a bridged retry for a tenant user when neither request carries tenant context', async () => {
    const bridgeService = await makeBridgeService();
    const A = 'refresh-i';
    await seedLoggedIn(A, TENANT_USER_ID, { tenantId: TENANT_ID, subject: 'sub-tenant-1' });
    const grant = makeGrant('sub-tenant-1');

    const first = await runAdminRefresh({
      refreshToken: A,
      config,
      bridgeService,
      userId: TENANT_USER_ID,
      // tenantId intentionally omitted on both requests: no X-Tenant-Id / tenant ALS context.
      grant,
    });
    expect(first.status).toBe(200);
    // response "lost"; Session(A) is gone by the time the retry presents A again.

    const retry = await runAdminRefresh({
      refreshToken: A,
      config,
      bridgeService,
      userId: TENANT_USER_ID,
      grant,
    });

    expect(retry.status).toBe(200);
    expect(grant).toHaveBeenNthCalledWith(2, `${A}-r`); // the retry recovered the bridge
    expect(grant).toHaveBeenCalledTimes(2);

    const newSession = await methods.findSession({ refreshToken: `${A}-r-r` }, { lean: true });
    expect(newSession).not.toBeNull();
    expect(newSession?.tenantId).toBe(TENANT_ID); // the user's own tenant, not the absent request tenant
  });

  it('(j) recovers a bridged retry for a tenant user when both requests carry the same tenant context', async () => {
    const bridgeService = await makeBridgeService();
    const A = 'refresh-j';
    await seedLoggedIn(A, TENANT_USER_ID, { tenantId: TENANT_ID, subject: 'sub-tenant-1' });
    const grant = makeGrant('sub-tenant-1');

    const first = await runAdminRefresh({
      refreshToken: A,
      config,
      bridgeService,
      userId: TENANT_USER_ID,
      tenantId: TENANT_ID,
      grant,
    });
    expect(first.status).toBe(200);

    const retry = await runAdminRefresh({
      refreshToken: A,
      config,
      bridgeService,
      userId: TENANT_USER_ID,
      tenantId: TENANT_ID,
      grant,
    });

    expect(retry.status).toBe(200);
    expect(grant).toHaveBeenNthCalledWith(2, `${A}-r`);
    expect(grant).toHaveBeenCalledTimes(2);

    const newSession = await methods.findSession({ refreshToken: `${A}-r-r` }, { lean: true });
    expect(newSession).not.toBeNull();
    expect(newSession?.tenantId).toBe(TENANT_ID);
  });

  it('(k) keeps the rotated tokenset and repoints the bridge when completeOpenIDRefreshFlight rejects on a bridged retry', async () => {
    const bridgeService = await makeBridgeService();
    const A = 'refresh-k';
    await seedLoggedIn(A, ADMIN_USER_ID);
    const grant = makeGrant();

    const first = await runAdminRefresh({
      refreshToken: A,
      config,
      bridgeService,
      userId: ADMIN_USER_ID,
      grant,
    });
    expect(first.status).toBe(200);
    // response "lost"; the bridge now points A -> `${A}-r`

    const failingComplete = jest.fn().mockRejectedValue(new Error('flight store unavailable'));
    const flightDeps: AdminRefreshGrantDeps = {
      ...makeFlightDeps(),
      completeOpenIDRefreshFlight: failingComplete,
    };

    const retry = await runAdminRefresh({
      refreshToken: A,
      config,
      bridgeService,
      userId: ADMIN_USER_ID,
      grant,
      flightDeps,
    });

    // The IdP already rotated the token at this point; the response must still succeed with it.
    expect(retry.status).toBe(200);
    expect(grant).toHaveBeenNthCalledWith(2, `${A}-r`);
    expect(failingComplete).toHaveBeenCalledTimes(1);

    const newSession = await methods.findSession({ refreshToken: `${A}-r-r` }, { lean: true });
    expect(newSession).not.toBeNull();

    const bridge = await bridgeService.getRefreshTokenBridge({
      oldRefreshToken: A,
      userId: ADMIN_USER_ID,
      openidIssuer: ISSUER,
    });
    // Repointed to the newly rotated token despite the flight's own completion write failing.
    expect(bridge?.refreshToken).toBe(`${A}-r-r`);
  });

  it('(l) answers 503, not 401, when flight coordination fails before the grant runs', async () => {
    const bridgeService = await makeBridgeService();
    const A = 'refresh-l';
    await seedLoggedIn(A, ADMIN_USER_ID);
    const grant = makeGrant();

    const first = await runAdminRefresh({
      refreshToken: A,
      config,
      bridgeService,
      userId: ADMIN_USER_ID,
      grant,
    });
    expect(first.status).toBe(200);
    // response "lost"; the bridge now points A -> `${A}-r`, so the retry below is bridged.

    const retryGrant = jest.fn();
    const flightDeps: AdminRefreshGrantDeps = {
      createRefreshTokenBridgeFlightKey: makeFlightDeps().createRefreshTokenBridgeFlightKey,
      acquireOpenIDRefreshFlight: jest.fn().mockRejectedValue(new Error('flight store down')),
      withOpenIDRefreshFlightLease: jest.fn(),
    };

    const retry = await runAdminRefresh({
      refreshToken: A,
      config,
      bridgeService,
      userId: ADMIN_USER_ID,
      grant: retryGrant,
      flightDeps,
    });

    expect(retry.status).toBe(503);
    expect(retryGrant).not.toHaveBeenCalled();
  });

  it('(m) keeps the rotated tokenset and repoints the bridge when the flight lease itself fails after the grant', async () => {
    const bridgeService = await makeBridgeService();
    const A = 'refresh-m';
    await seedLoggedIn(A, ADMIN_USER_ID);
    const grant = makeGrant();

    const first = await runAdminRefresh({
      refreshToken: A,
      config,
      bridgeService,
      userId: ADMIN_USER_ID,
      grant,
    });
    expect(first.status).toBe(200);
    // response "lost"; the bridge now points A -> `${A}-r`

    const baseFlightDeps = makeFlightDeps();
    const flightDeps: AdminRefreshGrantDeps = {
      ...baseFlightDeps,
      withOpenIDRefreshFlightLease: async ({ operation }) => {
        await baseFlightDeps.withOpenIDRefreshFlightLease?.({ operation });
        throw new Error('lease renewal failed after the operation settled');
      },
    };

    const retry = await runAdminRefresh({
      refreshToken: A,
      config,
      bridgeService,
      userId: ADMIN_USER_ID,
      grant,
      flightDeps,
    });

    // The IdP already rotated the token at this point; the response must still succeed with it.
    expect(retry.status).toBe(200);
    expect(grant).toHaveBeenNthCalledWith(2, `${A}-r`);

    const newSession = await methods.findSession({ refreshToken: `${A}-r-r` }, { lean: true });
    expect(newSession).not.toBeNull();

    const bridge = await bridgeService.getRefreshTokenBridge({
      oldRefreshToken: A,
      userId: ADMIN_USER_ID,
      openidIssuer: ISSUER,
    });
    // Repointed to the newly rotated token despite the lease itself failing after the grant.
    expect(bridge?.refreshToken).toBe(`${A}-r-r`);
  });
});

/** The real flight service on the same database, as the admin route and the browser refresh
 *  controller wire it. Encryption is the identity function. */
function makeRealFlightService() {
  return createOpenIDRefreshFlightService({
    db: {
      acquireOpenIDRefreshFlight: methods.acquireOpenIDRefreshFlight,
      completeOpenIDRefreshFlight: methods.completeOpenIDRefreshFlight,
      renewOpenIDRefreshFlight: methods.renewOpenIDRefreshFlight,
      failOpenIDRefreshFlight: methods.failOpenIDRefreshFlight,
      revokeOpenIDRefreshFlight: methods.revokeOpenIDRefreshFlight,
      findOpenIDRefreshFlight: methods.findOpenIDRefreshFlight,
      claimOpenIDRefreshFlightDelivery: methods.claimOpenIDRefreshFlightDelivery,
      releaseOpenIDRefreshFlightDelivery: methods.releaseOpenIDRefreshFlightDelivery,
    } as Parameters<typeof createOpenIDRefreshFlightService>[0]['db'],
    logger: makeLogger(),
    encrypt: async (value: string) => value,
    decrypt: async (value: string) => value,
  });
}

type RealFlightService = ReturnType<typeof makeRealFlightService>;
type BridgeService = Awaited<ReturnType<typeof makeBridgeService>>;

/** The grant deps the admin route passes, backed by the real flight and bridge services. */
function makeRealGrantDeps(
  flights: RealFlightService,
  bridgeService: BridgeService,
): AdminRefreshGrantDeps {
  return {
    createRefreshTokenBridgeFlightKey: bridgeService.createRefreshTokenBridgeFlightKey,
    createAdminRefreshGrantFlightKey: (
      bridgeService as Partial<Pick<BridgeService, 'createAdminRefreshGrantFlightKey'>>
    ).createAdminRefreshGrantFlightKey,
    acquireOpenIDRefreshFlight: flights.acquireOpenIDRefreshFlight,
    completeOpenIDRefreshFlight: flights.completeOpenIDRefreshFlight,
    assertOpenIDRefreshFlightAvailable: flights.assertOpenIDRefreshFlightAvailable,
    waitForOpenIDRefreshFlight: flights.waitForOpenIDRefreshFlight,
    withOpenIDRefreshFlightLease: flights.withOpenIDRefreshFlightLease,
  };
}

function bridgeFlightKey(bridgeService: BridgeService, oldRefreshToken: string): string {
  const key = bridgeService.createRefreshTokenBridgeFlightKey({
    oldRefreshToken,
    userId: ADMIN_USER_ID,
    openidIssuer: ISSUER,
  });
  if (!key) throw new Error('bridge flight key is unavailable');
  return key;
}

/** Completes a flight the way another writer does: acquire, then complete with `tokens`. */
async function completeFlightAs(
  flights: RealFlightService,
  key: string,
  tokens: TokenResult | SharedOpenIDRefreshResult,
): Promise<void> {
  const flight = await flights.acquireOpenIDRefreshFlight({ key });
  expect(flight.acquired).toBe(true);
  const completed = await flights.completeOpenIDRefreshFlight({
    key,
    ownerId: flight.ownerId,
    tokens: tokens as TokenResult,
  });
  expect(completed).not.toBeNull();
}

/** The result `sendOpenIDAuthResponse` publishes for a browser login when
 *  `OPENID_REUSE_TOKENS` is on: keyed by the login's own refresh token, which the IdP has not
 *  spent yet, so the published `tokenset.refresh_token` is that same token. */
function browserLoginPublication(refreshToken: string): SharedOpenIDRefreshResult {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  return {
    tokenset: {
      access_token: `browser-at-${refreshToken}`,
      id_token: `browser-id-${refreshToken}`,
      refresh_token: refreshToken,
      expires_at: expiresAt,
    },
    claims: { sub: 'sub-1' },
    openidIssuer: ISSUER,
    expires_at: expiresAt,
    appAuthToken: `browser-app-${refreshToken}`,
    acceptedIdentity: {
      appUserId: ADMIN_USER_ID,
      openidSubject: 'sub-1',
      openidIssuer: ISSUER,
    },
    providerSession: { issuer: ISSUER, clientId: CLIENT_ID, sid: SID },
  };
}

/** A browser refresh-recovery service on the real flight and bridge services. Only the IdP
 *  grant (`refreshOpenIDSession`) and the cookie writers are stubs. */
function makeBrowserRecovery(flights: RealFlightService, bridgeService: BridgeService) {
  const bridgeUser = {
    _id: ADMIN_USER_ID,
    provider: 'openid',
    openidId: 'sub-1',
    openidIssuer: ISSUER,
  };
  const refreshOpenIDSession = jest.fn(
    async (req: { session: { openidTokens: { refreshToken: string } } }) => {
      const granted = req.session.openidTokens.refreshToken;
      return {
        access_token: `at-${granted}`,
        id_token: `id-${granted}`,
        refresh_token: `${granted}-r`,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        claims: () => ({ sub: 'sub-1', iss: ISSUER, sid: SID }),
      };
    },
  );
  const deps = {
    jwt: { decode: jest.fn() },
    cookies: { parse: jest.fn(() => ({})) },
    getJwtRefreshSecret: () => 'refresh-secret',
    findOpenIDUser: jest.fn().mockResolvedValue({ user: bridgeUser, error: null }),
    findUser: jest.fn(),
    getOpenIdConfig: jest.fn(),
    getOpenIdEmail: jest.fn(),
    getOpenIdIssuer: jest.fn(() => ISSUER),
    createAuthIdentityContext: jest.fn(() => ({
      appUserId: ADMIN_USER_ID,
      openidSubject: 'sub-1',
      openidIssuer: ISSUER,
    })),
    refreshOpenIDSession,
    clearOpenIDAuthTokens: jest.fn(),
    deleteOpenIDSession: jest.fn(),
    createOpenIDRefreshFlightKey: jest.fn(() => null),
    storeRefreshTokenBridge: bridgeService.storeRefreshTokenBridge,
    deleteRefreshTokenBridges: bridgeService.deleteRefreshTokenBridges,
    createRefreshTokenBridgeFlightKey: bridgeService.createRefreshTokenBridgeFlightKey,
    acquireOpenIDRefreshFlight: flights.acquireOpenIDRefreshFlight,
    completeOpenIDRefreshFlight: flights.completeOpenIDRefreshFlight,
    failOpenIDRefreshFlight: flights.failOpenIDRefreshFlight,
    waitForOpenIDRefreshFlight: flights.waitForOpenIDRefreshFlight,
    assertOpenIDRefreshFlightAvailable: flights.assertOpenIDRefreshFlightAvailable,
    assertOpenIDRefreshSessionGenerationAvailable:
      flights.assertOpenIDRefreshSessionGenerationAvailable,
    revokeOpenIDRefreshFlights: flights.revokeOpenIDRefreshFlights,
    withOpenIDRefreshFlightLease: flights.withOpenIDRefreshFlightLease,
    bridgeGraceMs: bridgeService.OPENID_REFRESH_BRIDGE_GRACE_MS,
    logger: { debug: jest.fn(), warn: jest.fn(), info: jest.fn(), error: jest.fn() },
    getOpenIDAppAuthToken: jest.fn(
      (tokens: { access_token?: string }) => `app-${tokens.access_token}`,
    ),
    storeOpenIDSession: jest.fn().mockResolvedValue(undefined),
    setOpenIDAuthTokens: jest.fn(
      (tokens: { access_token?: string }) => `app-${tokens.access_token}`,
    ),
    getRefreshTokenExpiryMs: jest.fn(() => 1000 * 60 * 60 * 24 * 90),
    providerSessionAuthorizer: {
      establish: jest.fn().mockResolvedValue({ ok: true }),
      authorize: jest.fn().mockResolvedValue({ ok: true }),
      preCheck: jest.fn().mockResolvedValue({ ok: true }),
      getMode: jest.fn().mockResolvedValue('enforce'),
    },
    getProviderSessionClient: jest.fn(() => ({ issuer: ISSUER, clientId: CLIENT_ID })),
  } as unknown as OpenIDRefreshRecoveryDeps;
  const service = createOpenIDRefreshRecoveryService(deps);
  const recover = async (refreshToken: string) => {
    const bridge = await bridgeService.getRefreshTokenBridge({
      oldRefreshToken: refreshToken,
      userId: ADMIN_USER_ID,
      openidIssuer: ISSUER,
    });
    if (!bridge) throw new Error('no bridge to recover');
    return service.recoverOpenIDRefreshBridge({
      req: {
        session: {
          save: (callback: (error?: Error | null) => void) => callback(null),
          reload: (callback: (error?: Error | null) => void) => callback(null),
        },
      } as never,
      res: {} as never,
      refreshToken,
      bridgedRefreshToken: bridge.refreshToken,
      bridgeUser: bridgeUser as never,
      bridgeProviderSession: bridge.providerSession ?? null,
      markerProviderSession: null,
    });
  };
  return { recover, refreshOpenIDSession, deps, service };
}

/**
 * The browser and the admin share the bridge flight key of a refresh token. A browser login with
 * `OPENID_REUSE_TOKENS` completes that flight for a token the IdP has not spent yet, and the
 * admin's first grant then spends it. These cases run against the real flight service, the real
 * bridge service, and a real database; only the IdP is mocked.
 */
describe.each(['record', 'enforce'] as const)(
  'admin refresh retries next to a browser publication of the same token (%s mode)',
  (mode) => {
    const config = makeConfig(mode);

    async function setup(R0: string, options: { publishBrowserLogin?: boolean } = {}) {
      const bridgeService = await makeBridgeService();
      const flights = makeRealFlightService();
      const ref = await seedLoggedIn(R0, ADMIN_USER_ID);
      if (options.publishBrowserLogin !== false) {
        await completeFlightAs(
          flights,
          bridgeFlightKey(bridgeService, R0),
          browserLoginPublication(R0),
        );
      }
      const grant = makeGrant();
      const flightDeps = makeRealGrantDeps(flights, bridgeService);
      const run = () =>
        runAdminRefresh({
          refreshToken: R0,
          config,
          bridgeService,
          userId: ADMIN_USER_ID,
          grant,
          flightDeps,
        });
      return { bridgeService, flights, ref, grant, run };
    }

    it('(a) answers a sequential retry with the tokens of the first grant, calling the IdP once', async () => {
      const R0 = 'refresh-shared-a';
      const { grant, run } = await setup(R0);

      const first = await run();
      expect(first.status).toBe(200);
      expect(first.body.refreshToken).toBe(`${R0}-r`);
      expect(grant).toHaveBeenCalledTimes(1);
      expect(grant).toHaveBeenCalledWith(R0);

      // The client ignores the first response and retries with R0.
      const retry = await run();
      expect(retry.status).toBe(200);
      expect(retry.body.refreshToken).toBe(`${R0}-r`);
      expect(retry.body.token).toBe(first.body.token);
      expect(grant).toHaveBeenCalledTimes(1);
      expect(await methods.findSession({ refreshToken: `${R0}-r` }, { lean: true })).not.toBeNull();
    });

    it('(b) answers two concurrent first requests with the same R1, calling the IdP once', async () => {
      const R0 = 'refresh-shared-first';
      const { bridgeService, flights } = await setup(R0, { publishBrowserLogin: false });
      /** A rotating IdP with reuse 0: a token it already spent is rejected. */
      const spent = new Set<string>();
      const grant = jest.fn(async (presented: string) => {
        if (spent.has(presented)) {
          throw Object.assign(new Error('invalid_grant'), { code: 'invalid_grant' });
        }
        spent.add(presented);
        await new Promise((resolve) => setTimeout(resolve, 250));
        return makeTokenset(presented);
      });
      const run = () =>
        runAdminRefresh({
          refreshToken: R0,
          config,
          bridgeService,
          userId: ADMIN_USER_ID,
          grant,
          flightDeps: makeRealGrantDeps(flights, bridgeService),
        });

      const [first1, first2] = await Promise.all([run(), run()]);

      expect(first1.status).toBe(200);
      expect(first2.status).toBe(200);
      expect(first1.body.refreshToken).toBe(`${R0}-r`);
      expect(first2.body.refreshToken).toBe(`${R0}-r`);
      expect(grant).toHaveBeenCalledTimes(1);
    });

    it('(b) answers two concurrent retries with the same successor tokens, calling the IdP once', async () => {
      const R0 = 'refresh-shared-b';
      const { grant, run } = await setup(R0);
      expect((await run()).status).toBe(200);

      const [retry1, retry2] = await Promise.all([run(), run()]);

      expect(retry1.status).toBe(200);
      expect(retry2.status).toBe(200);
      expect(retry1.body.refreshToken).toBe(`${R0}-r`);
      expect(retry2.body.refreshToken).toBe(`${R0}-r`);
      expect(grant).toHaveBeenCalledTimes(1);
    });

    it('(c) answers 401 OPENID_SESSION_ENDED without tokens and deletes the bridge once the provider session ended', async () => {
      const R0 = 'refresh-shared-c';
      const { bridgeService, ref, grant, run } = await setup(R0);
      expect((await run()).status).toBe(200);

      await methods.revokeProviderSession({
        issuer: ref.issuer,
        clientId: ref.clientId,
        sid: ref.sid,
        expiresAt: future(),
        now: new Date(),
      });
      const retry = await run();

      expect(retry.status).toBe(401);
      expect(retry.body.error_code).toBe('OPENID_SESSION_ENDED');
      expect(retry.body).not.toHaveProperty('token');
      expect(retry.body).not.toHaveProperty('refreshToken');
      expect(grant).toHaveBeenCalledTimes(1);
      expect(
        await bridgeService.getRefreshTokenBridge({
          oldRefreshToken: R0,
          userId: ADMIN_USER_ID,
          openidIssuer: ISSUER,
        }),
      ).toBeNull();
    });

    it('(d) lets a browser retry with R0 recover through the bridge after the admin rotated R0', async () => {
      const R0 = 'refresh-shared-d';
      const { bridgeService, flights, grant, run } = await setup(R0, {
        publishBrowserLogin: false,
      });
      expect((await run()).status).toBe(200);

      const browser = makeBrowserRecovery(flights, bridgeService);
      const recovered = await browser.recover(R0);

      expect(recovered.appAuthToken).toBe(`app-at-${R0}-r`);
      expect(recovered.tokenset.refresh_token).toBe(`${R0}-r-r`);
      expect(browser.refreshOpenIDSession).toHaveBeenCalledTimes(1);
      expect(grant).toHaveBeenCalledTimes(1);
    });

    it('(d) never returns the presented token when the browser recovery meets its login publication', async () => {
      const R0 = 'refresh-shared-login';
      const { bridgeService, flights, grant, run } = await setup(R0, {
        publishBrowserLogin: false,
      });
      const browser = makeBrowserRecovery(flights, bridgeService);
      const loginTokens = browserLoginPublication(R0).tokenset;
      // The browser login with OPENID_REUSE_TOKENS on, as `oauth.js` calls it.
      await browser.service.sendOpenIDAuthResponse({
        tokenset: loginTokens,
        user: { _id: ADMIN_USER_ID, openidId: 'sub-1', openidIssuer: ISSUER } as never,
        existingRefreshToken: R0,
        openidSubject: 'sub-1',
        openidIssuer: ISSUER,
        discardSessionTokens: true,
        req: {
          session: {
            save: (callback: (error?: Error | null) => void) => callback(null),
            reload: (callback: (error?: Error | null) => void) => callback(null),
          },
        } as never,
        res: {} as never,
      });
      expect((await run()).status).toBe(200); // the admin spends R0; the bridge points to R1

      const outcome = await browser.recover(R0).then(
        (result) => ({ refreshToken: result.tokenset?.refresh_token }),
        (error: unknown) => ({ error }),
      );

      expect(outcome).not.toEqual({ refreshToken: R0 });
      expect(outcome).toEqual({
        error: expect.objectContaining({ name: 'ProviderSessionUnavailableError', status: 503 }),
      });
      expect(grant).toHaveBeenCalledTimes(1);
    });

    it('(d) answers a browser retry that meets an admin-written bridge result with a retryable 503', async () => {
      const R0 = 'refresh-shared-d2';
      const { bridgeService, flights } = await setup(R0, { publishBrowserLogin: false });
      await bridgeService.storeRefreshTokenBridge({
        oldRefreshToken: R0,
        newRefreshToken: `${R0}-r`,
        userId: ADMIN_USER_ID,
        openidIssuer: ISSUER,
      });
      await completeFlightAs(flights, bridgeFlightKey(bridgeService, R0), {
        access_token: `at-${R0}-r`,
        refresh_token: `${R0}-r-r`,
        __identityClaims: { sub: 'sub-1', iss: ISSUER, sid: SID },
      });

      const browser = makeBrowserRecovery(flights, bridgeService);
      const error = await browser.recover(R0).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ name: 'ProviderSessionUnavailableError', status: 503 });
      expect(browser.refreshOpenIDSession).not.toHaveBeenCalled();
    });

    describe('(e) with a record that older code left under the bridge flight key', () => {
      async function setupBridged(R0: string, record: TokenResult | SharedOpenIDRefreshResult) {
        const context = await setup(R0, { publishBrowserLogin: false });
        await context.bridgeService.storeRefreshTokenBridge({
          oldRefreshToken: R0,
          newRefreshToken: `${R0}-r`,
          userId: ADMIN_USER_ID,
          openidIssuer: ISSUER,
          providerSession: context.ref,
        });
        await completeFlightAs(context.flights, bridgeFlightKey(context.bridgeService, R0), record);
        return context;
      }

      it('answers 503, not 502, when the record is the browser publication of R0 itself', async () => {
        const R0 = 'refresh-old-login';
        const { grant, run } = await setupBridged(R0, browserLoginPublication(R0));

        const retry = await run();

        expect(retry.status).toBe(503);
        expect(grant).not.toHaveBeenCalled();
      });

      it('answers 503, not 502, when the record has no access token', async () => {
        const R0 = 'refresh-old-incomplete';
        const { grant, run } = await setupBridged(R0, {
          refresh_token: `${R0}-r-r`,
          __identityClaims: { sub: 'sub-1', iss: ISSUER, sid: SID },
        });

        const retry = await run();

        expect(retry.status).toBe(503);
        expect(grant).not.toHaveBeenCalled();
      });

      it('answers 200 with the successor tokens of an admin grant written by older code', async () => {
        const R0 = 'refresh-old-admin';
        const { grant, run } = await setupBridged(R0, {
          access_token: `at-${R0}-r`,
          refresh_token: `${R0}-r-r`,
          __identityClaims: { sub: 'sub-1', iss: ISSUER, sid: SID },
        });

        const retry = await run();

        expect(retry.status).toBe(200);
        expect(retry.body.refreshToken).toBe(`${R0}-r-r`);
        expect(grant).not.toHaveBeenCalled();
      });

      it('answers 200 with the successor tokens of a browser bridge recovery', async () => {
        const R0 = 'refresh-old-browser-recovery';
        const published = browserLoginPublication(`${R0}-r-r`);
        const { grant, run } = await setupBridged(R0, published);

        const retry = await run();

        expect(retry.status).toBe(200);
        expect(retry.body.refreshToken).toBe(`${R0}-r-r`);
        expect(grant).not.toHaveBeenCalled();
      });
    });
  },
);
