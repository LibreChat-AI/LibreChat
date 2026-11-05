/** Integration coverage for back-channel logout against two mongoose connections (simulating
 *  read replicas) on one `mongodb-memory-server`. */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const {
  generateKeyPair,
  SignJWT,
  exportJWK,
  calculateJwkThumbprint,
  createLocalJWKSet,
} = require('jose');
const {
  createOpenIDAuthorizationMethods,
  resolveAuthorizationQueryOptions,
} = require('@librechat/data-schemas');
const {
  createBackchannelLogoutVerifier,
  createBackchannelLogoutReceiver,
  createOpenIDSessionAuthorization,
  createOpenIDSessionCache,
  authorizeOpenIDSession,
} = require('@librechat/api');

const mockGetUserById = jest.fn();
const mockUpdateUser = jest.fn();
const mockFindUser = jest.fn();
const mockIsAgentTriggerPrincipalActive = jest.fn();
jest.mock('~/models', () => ({
  getUserById: (...args) => mockGetUserById(...args),
  updateUser: (...args) => mockUpdateUser(...args),
  findUser: (...args) => mockFindUser(...args),
  isAgentTriggerPrincipalActive: (...args) => mockIsAgentTriggerPrincipalActive(...args),
}));
jest.mock('~/cache/getLogStores', () => jest.fn());

const jwtLogin = require('~/strategies/jwtStrategy');
const openIdJwtLogin = require('~/strategies/openIdJwtStrategy');
const openIdSessions = require('~/server/services/OpenIDSessions');

const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
const bareIssuer = 'https://issuer.example.com';
/** Discovery commonly publishes a trailing-slash `issuer`; sessions store and compare the
 *  normalized (slash-stripped) form. */
const discoveryIssuer = `${bareIssuer}/`;
const clientId = 'replica-test-client';

let mongoServer;
let connectionA;
let connectionB;
let methodsA;
let methodsB;
let privateKey;
let getKey;
let kid;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  connectionA = await mongoose.createConnection(mongoServer.getUri()).asPromise();
  connectionB = await mongoose.createConnection(mongoServer.getUri()).asPromise();
  const keyPair = await generateKeyPair('RS256');
  privateKey = keyPair.privateKey;
  const jwk = await exportJWK(keyPair.publicKey);
  kid = await calculateJwkThumbprint(jwk);
  getKey = createLocalJWKSet({ keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] });
}, 60_000);

afterAll(async () => {
  await connectionA?.close();
  await connectionB?.close();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await connectionA.dropDatabase();
  const queryOptions = resolveAuthorizationQueryOptions('standalone', { maxTimeMS: 2000 });
  methodsA = createOpenIDAuthorizationMethods(connectionA, queryOptions);
  methodsB = createOpenIDAuthorizationMethods(connectionB, queryOptions);
  process.env.OPENID_CLIENT_ID = clientId;
  process.env.JWT_SECRET = 'replica-test-secret';
});

afterEach(() => {
  for (const key of Object.keys(openIdSessions.sessionAuthorizationRef)) {
    delete openIdSessions.sessionAuthorizationRef[key];
  }
  delete process.env.OPENID_CLIENT_ID;
  delete process.env.JWT_SECRET;
  jest.clearAllMocks();
});

/** Wires `sessionAuthorizationRef` the way `OpenIDSessions.connectOpenIDAuthorization` does,
 *  but bound directly to the given methods (one of the two replica connections). */
function wireAuthorization(methods) {
  const { authorizationDeps } = createOpenIDSessionAuthorization({
    authorization: methods,
    enforcement: true,
    timeoutMs: 2000,
    logger: { warn: jest.fn() },
  });
  Object.assign(openIdSessions.sessionAuthorizationRef, authorizationDeps);
  return authorizationDeps;
}

function buildReceiver(methods) {
  const verifier = createBackchannelLogoutVerifier({
    getKey,
    issuer: discoveryIssuer,
    clientId,
    algorithms: ['RS256'],
    maxAgeSeconds: 300,
  });
  return createBackchannelLogoutReceiver({
    methods,
    verifier,
    config: { enabled: true },
    logger: { warn: jest.fn(), error: jest.fn() },
  });
}

async function signLogoutToken({ subject, sid, iat }) {
  return new SignJWT({ sub: subject, sid, events: { [BACKCHANNEL_LOGOUT_EVENT]: {} } })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(discoveryIssuer)
    .setAudience(clientId)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 120)
    .setJti(`jti-${sid}-${iat}`)
    .sign(privateKey);
}

function fakeRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.end = jest.fn();
  return res;
}

function invokeVerify(verify, req, payload) {
  return new Promise((resolve, reject) => {
    verify(req, payload, (err, user, info) => (err ? reject(err) : resolve({ user, info })));
  });
}

describe('backchannel logout, received on one replica, denies both bearer types read through the other', () => {
  it('denies a LibreChat-signed bearer and a provider ID-token bearer once the event lands', async () => {
    wireAuthorization(methodsB);
    const subject = 'subject-replica';
    const sid = 'sid-replica-1';
    const userId = new mongoose.Types.ObjectId().toString();
    const tenantId = 'tenant-replica';
    const loginIat = Math.floor(Date.now() / 1000) - 60;

    const { session } = await methodsA.recordOpenIDLogin({
      issuer: discoveryIssuer,
      clientId,
      subject,
      sid,
      loginIat,
    });
    await methodsA.upsertOpenIDBinding({ sessionId: session._id, user: userId, tenantId });

    const user = {
      _id: { toString: () => userId },
      role: 'USER',
      provider: 'openid',
      openidId: subject,
      openidIssuer: bareIssuer,
      tenantId,
    };
    mockGetUserById.mockResolvedValue(user);
    mockFindUser.mockResolvedValue(user);
    mockIsAgentTriggerPrincipalActive.mockResolvedValue(true);
    mockUpdateUser.mockResolvedValue({});

    const jwtVerify = jwtLogin()._verify;
    const openIdVerify = openIdJwtLogin({
      serverMetadata: () => ({ issuer: discoveryIssuer, jwks_uri: `${bareIssuer}/jwks` }),
    })._verify;

    const libreChatPayload = {
      id: userId,
      openidSessionId: session._id.toString(),
      tenantId,
      iat: loginIat,
    };
    const idTokenPayload = {
      sub: subject,
      iss: discoveryIssuer,
      aud: clientId,
      sid,
      iat: loginIat,
    };

    const admittedBefore = await Promise.all([
      invokeVerify(jwtVerify, { headers: {} }, libreChatPayload),
      invokeVerify(openIdVerify, { headers: {} }, idTokenPayload),
    ]);
    expect(admittedBefore[0].user).toBeTruthy();
    expect(admittedBefore[1].user).toBeTruthy();

    const receiver = buildReceiver(methodsA);
    const req = {
      body: { logout_token: await signLogoutToken({ subject, sid, iat: loginIat + 30 }) },
    };
    const res = fakeRes();
    await receiver(req, res);
    expect(res.status).toHaveBeenCalledWith(200);

    const deniedAfter = await Promise.all([
      invokeVerify(jwtVerify, { headers: {} }, libreChatPayload),
      invokeVerify(openIdVerify, { headers: {} }, idTokenPayload),
    ]);
    expect(deniedAfter[0].user).toBeFalsy();
    expect(deniedAfter[0].info?.code).toBe('denied');
    expect(deniedAfter[1].user).toBeFalsy();
    expect(deniedAfter[1].info?.code).toBe('denied');
  });
});

describe('a warm session-location cache never substitutes a stale authorization decision', () => {
  it('denies after a boundary-raising write on another connection, despite a warm cache hit', async () => {
    const subject = 'subject-cache';
    const sid = 'sid-cache-1';
    const user = new mongoose.Types.ObjectId().toString();
    const tenantId = 'tenant-cache';
    const { session } = await methodsA.recordOpenIDLogin({
      issuer: bareIssuer,
      clientId,
      subject,
      sid,
      loginIat: 100,
    });
    await methodsA.upsertOpenIDBinding({ sessionId: session._id, user, tenantId });

    const cache = createOpenIDSessionCache();
    const deps = { authorization: methodsB, enforcement: true, timeoutMs: 2000, cache };
    // A trailing-slash issuer, as a caller might read it from live discovery metadata,
    // against a session recorded under the normalized form.
    const input = { issuer: discoveryIssuer, clientId, subject, sid, user, tenantId };

    const first = await authorizeOpenIDSession(input, deps);
    expect(first.ok).toBe(true);
    // The cache resolved only `sid`'s session location; it never held a decision.
    expect(cache.get({ issuer: bareIssuer, clientId, sid })).toEqual({
      sessionId: session._id.toString(),
      subject,
    });

    // A logout event, written on the other connection, raises the boundary past firstLoginIat.
    await methodsA.upsertOpenIDSubjectBoundary({
      issuer: bareIssuer,
      clientId,
      subject,
      boundaryIat: 110,
    });

    const second = await authorizeOpenIDSession(input, deps);
    expect(second).toEqual({ ok: false, code: 'denied' });
  });
});
