import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createMethods, createModels, createBrowserSetupBackend } from '@librechat/data-schemas';
import {
  browserSetupRequestHash,
  signBrowserSetupProof,
  isBrowserEnrollmentApproval,
  isBrowserEnrollmentStatusRequest,
  isBrowserEnrollmentRedemption,
  signBrowserEnrollmentRedemption,
} from '@librechat/code/browser-enrollment';
import type {
  BrowserSetupProof,
  BrowserEnrollmentRequest,
  BrowserEnrollmentApproval,
} from '@librechat/code/browser-enrollment';
import type { AppConfig } from '@librechat/data-schemas';
import { createCodeEnvironmentRegistry } from '../environments';
import { createSameOriginGuard } from '~/middleware/origin';
import { createCodeSetupRouter } from './router';

const identity = generateKeyPairSync('ed25519');
const publicKey = identity.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privateKey = identity.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const other = generateKeyPairSync('ed25519');
const otherPrivateKey = other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const instance = 'https://chat.example.test/base';

function config(): AppConfig {
  return {
    endpoints: {
      agents: {
        statefulCodeSessions: {
          principalWorkers: {
            enabled: true,
            maxPerUser: 1,
            browserSetup: {
              enabled: true,
              instance,
              maxPending: 2,
              maxPerIp: 2,
              requestsPerMinute: 1200,
              requestsPerIpMinute: 120,
              proofWindowMs: 60_000,
              maxProofsPerAttempt: 1024,
              reconcileIntervalMs: 10_000,
              retentionMs: 86_400_000,
            },
          },
          environments: [
            {
              id: 'code-api',
              name: 'Code API',
              type: 'attached',
              owner: 'deployment',
              baseURL: 'https://code.example.test/v1',
              pairing: { tokenEnv: 'CODE_SETUP_TEST_ADMIN', allowPrincipalWorkers: true },
            },
          ],
        },
      },
    },
  } as AppConfig;
}

function setupRequest(): BrowserEnrollmentRequest {
  return {
    version: 1,
    instance,
    attemptId: randomBytes(32).toString('base64url'),
    createdAt: new Date().toISOString(),
    publicKey,
    machineName: 'Browser worker',
    workspace: { type: 'private' },
    allowWorkspaceWrites: false,
    allowWorkspaceCommands: false,
  };
}

function body(
  input: BrowserEnrollmentRequest,
  operation: BrowserSetupProof['operation'] = 'setup.start',
  changes: Partial<BrowserSetupProof> = {},
  signingKey = privateKey,
) {
  const proof: BrowserSetupProof = {
    operation,
    instance: input.instance,
    attemptId: input.attemptId,
    requestHash: browserSetupRequestHash(input),
    timestamp: new Date().toISOString(),
    nonce: randomBytes(32).toString('base64url'),
    ...changes,
  };
  return { request: input, proof, signature: signBrowserSetupProof(signingKey, proof) };
}

describe('browser setup HTTP protocol boundary', () => {
  let mongo: MongoMemoryServer;
  let owner: string;
  let base: AppConfig;
  let support = true;
  let refreshCount = 0;
  const lifetimes: AbortController[] = [];
  let approval: BrowserEnrollmentApproval | undefined;
  let completed = false;
  let credentialExpiresAt: string;
  const previous = {
    jwt: process.env.CODEAPI_JWT_ENABLED,
    key: process.env.CODEAPI_JWT_PRIVATE_KEY,
    token: process.env.CODE_SETUP_TEST_ADMIN,
  };
  beforeAll(async () => {
    process.env.CODEAPI_JWT_ENABLED = 'true';
    process.env.CODEAPI_JWT_PRIVATE_KEY = privateKey;
    process.env.CODE_SETUP_TEST_ADMIN = 'server-only-administrator';
    mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
    await mongoose.connect(mongo.getUri());
    createModels(mongoose);
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  });
  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    await createMethods(mongoose).seedDefaultRoles();
    const user = await mongoose.models.User.create({
      name: 'Signed-in owner',
      email: 'setup@example.test',
      provider: 'local',
      emailVerified: true,
      termsAccepted: true,
      role: 'USER',
    });
    refreshCount = 0;
    owner = user._id.toString();
    base = config();
    support = true;
    approval = undefined;
    completed = false;
    credentialExpiresAt = new Date(Date.now() + 900_000).toISOString();
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (
        init?.redirect !== 'error' ||
        new Headers(init?.headers).get('Authorization') !== 'Bearer server-only-administrator'
      ) {
        throw new Error('Invalid administrator transport');
      }
      if (String(url).endsWith('/capabilities'))
        return Response.json(
          support ? { browserEnrollmentVersion: 1, serverId: 'https://code.example.test' } : {},
          { status: support ? 200 : 404 },
        );
      const payload: unknown = JSON.parse(String(init?.body));
      if (String(url).endsWith('/status')) {
        if (!isBrowserEnrollmentStatusRequest(payload))
          throw new Error('Invalid upstream status request');
        return approval
          ? Response.json({
              protocolVersion: 1,
              workerId: approval.workerId,
              status: completed ? 'completed' : 'pending',
            })
          : Response.json({}, { status: 409 });
      }
      if (String(url).endsWith('/redeem')) {
        if (!isBrowserEnrollmentRedemption(payload)) throw new Error('Invalid upstream redemption');
        completed = true;
        return Response.json({
          protocolVersion: 1,
          workerId: approval!.workerId,
          credential: 'key-bound-credential-that-is-long-enough',
          expiresAt: credentialExpiresAt,
        });
      }
      if (!isBrowserEnrollmentApproval(payload)) throw new Error('invalid upstream approval');
      approval = payload;
      return Response.json(payload);
    });
  });
  afterEach(() => {
    lifetimes.splice(0).forEach((controller) => controller.abort());
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    for (const [name, value] of Object.entries({
      CODEAPI_JWT_ENABLED: previous.jwt,
      CODEAPI_JWT_PRIVATE_KEY: previous.key,
      CODE_SETUP_TEST_ADMIN: previous.token,
    })) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
    await mongoose.disconnect();
    await mongo.stop();
  });

  function app(options: { registrationUnavailable?: boolean } = {}) {
    const lifetime = new AbortController();
    lifetimes.push(lifetime);
    const backend = createBrowserSetupBackend(mongoose);
    if (options.registrationUnavailable)
      backend.ensureRegistration = async () => {
        throw new Error('Index enforcement unavailable');
      };
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use(
      '/api/code-environments/setup',
      createCodeSetupRouter({
        backend,
        signal: lifetime.signal,
        getAppConfig: async (options) => {
          if (options.refresh) refreshCount++;
          return base;
        },
        registry: () => createCodeEnvironmentRegistry(mongoose),
        requireJwtAuth: (req, res, next) => {
          if (req.headers.authorization !== 'Bearer browser-session') {
            res.status(401).json({ code: 'AUTH_REQUIRED' });
            return;
          }
          Object.assign(req, { user: { id: owner } });
          next();
        },
        checkBan: (_req, _res, next) => next(),
        requireSameOrigin: createSameOriginGuard({ trustedOrigins: [instance] }),
        banStore: { get: async () => undefined },
      }),
    );
    return app;
  }

  test('real CLI-shaped start and signed completion pass through explicit browser approval only', async () => {
    const first = app();
    const second = app();
    const input = setupRequest();
    const capabilities = await request(first).get('/api/code-environments/setup/capabilities');
    expect(capabilities.status).toBe(200);
    expect(capabilities.body).toEqual({ browserEnrollmentVersion: 1 });
    const initial = await request(first)
      .post('/api/code-environments/setup/start')
      .send(body(input));
    expect(initial.status).toBe(200);
    expect(initial.body.status).toBe('pending');
    expect(initial.body.verificationUrl).toBe(`${instance}/code/setup/${input.attemptId}`);
    const path = `/api/code-environments/setup/${input.attemptId}`;
    expect((await request(first).get(path)).status).toBe(401);
    const inspect = await request(first).get(path).set('Authorization', 'Bearer browser-session');
    expect(inspect.status).toBe(200);
    expect(inspect.body.status).toBe('pending');
    expect(approval).toBeUndefined();
    const crossOrigin = await request(first)
      .post(`${path}/approve`)
      .set('Authorization', 'Bearer browser-session')
      .set('Origin', 'https://attacker.example')
      .send({ controlPlaneId: 'code-api' });
    expect(crossOrigin.status).toBe(403);
    expect(approval).toBeUndefined();
    const approved = await request(first)
      .post(`${path}/approve`)
      .set('Authorization', 'Bearer browser-session')
      .set('Origin', 'https://chat.example.test')
      .send({ controlPlaneId: 'code-api' });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');
    expect(JSON.stringify(approved.body)).not.toMatch(
      /server-only-administrator|credential|binding|codeApiUrl/,
    );
    const complete = {
      ...body(input, 'setup.complete'),
      redemptionSignature: signBrowserEnrollmentRedemption(privateKey, approval!),
    };
    const response = await request(second)
      .post('/api/code-environments/setup/complete')
      .send(complete);
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('completed');
    expect(response.body.credential.workerId).toBe(approval!.workerId);
    expect(
      (
        await request(first)
          .post('/api/code-environments/setup/complete')
          .send({
            ...body(input, 'setup.complete'),
            redemptionSignature: complete.redemptionSignature,
          })
      ).body.credential,
    ).toEqual(response.body.credential);
  });

  test.each([
    'operation',
    'audience',
    'attempt',
    'hash',
    'signature',
    'stale',
    'future',
    'nonce',
  ] as const)('rejects a %s mismatch without durable allocation', async (kind) => {
    const server = app();
    const input = setupRequest();
    let value = body(input);
    if (kind === 'operation') value = body(input, 'setup.poll');
    if (kind === 'audience') value = body({ ...input, instance: 'https://other.example.test' });
    if (kind === 'attempt')
      value = body(input, 'setup.start', { attemptId: randomBytes(32).toString('base64url') });
    if (kind === 'hash') value = body(input, 'setup.start', { requestHash: 'f'.repeat(64) });
    if (kind === 'signature') value = body(input, 'setup.start', {}, otherPrivateKey);
    if (kind === 'stale')
      value = body(input, 'setup.start', {
        timestamp: new Date(Date.now() - 61_000).toISOString(),
      });
    if (kind === 'future')
      value = body(input, 'setup.start', {
        timestamp: new Date(Date.now() + 61_000).toISOString(),
      });
    if (kind === 'nonce') value.proof.nonce = 'malformed';
    const response = await request(server).post('/api/code-environments/setup/start').send(value);
    expect([400, 401]).toContain(response.status);
    expect(await mongoose.connection.collection('browser_setup_sessions').countDocuments()).toBe(0);
  });

  test('replay is shared across replicas, identical starts resume, and immutable changes conflict', async () => {
    const first = app();
    const second = app();
    const input = setupRequest();
    const signed = body(input);
    const response = await request(first).post('/api/code-environments/setup/start').send(signed);
    expect(response.status).toBe(200);
    expect(
      (await request(second).post('/api/code-environments/setup/start').send(signed)).status,
    ).toBe(409);
    const resumed = await request(second)
      .post('/api/code-environments/setup/start')
      .send(body(input));
    expect(resumed.body).toEqual(response.body);
    expect(
      (
        await request(second)
          .post('/api/code-environments/setup/start')
          .send(body({ ...input, machineName: 'Changed' }))
      ).status,
    ).toBe(409);
    expect(await mongoose.connection.collection('browser_setup_sessions').countDocuments()).toBe(1);
  });

  test('capability fails closed for policy withdrawal, absent credentials, and unsupported Code API', async () => {
    const server = app();
    support = false;
    expect((await request(server).get('/api/code-environments/setup/capabilities')).status).toBe(
      503,
    );
    support = true;
    delete process.env.CODE_SETUP_TEST_ADMIN;
    expect((await request(server).get('/api/code-environments/setup/capabilities')).status).toBe(
      503,
    );
    process.env.CODE_SETUP_TEST_ADMIN = 'server-only-administrator';
    base.endpoints!.agents!.statefulCodeSessions!.principalWorkers!.enabled = false;
    expect((await request(server).get('/api/code-environments/setup/capabilities')).status).toBe(
      503,
    );
  });

  test('rate-limited and invalid machine requests never trigger a forced configuration reload', async () => {
    const server = app();
    const settings = base.endpoints!.agents!.statefulCodeSessions!.principalWorkers!.browserSetup!;
    settings.requestsPerMinute = 2;
    settings.requestsPerIpMinute = 2;
    expect(
      (await request(server).post('/api/code-environments/setup/start').send({ invalid: true }))
        .status,
    ).toBe(400);
    expect(refreshCount).toBe(0);
    expect((await request(server).get('/api/code-environments/setup/capabilities')).status).toBe(
      200,
    );
    const admitted = refreshCount;
    expect((await request(server).get('/api/code-environments/setup/capabilities')).status).toBe(
      429,
    );
    expect(refreshCount).toBe(admitted);
  });

  test('capabilities fail closed when the required unique registration indexes cannot be enforced', async () => {
    const response = await request(app({ registrationUnavailable: true })).get(
      '/api/code-environments/setup/capabilities',
    );
    expect(response.status).toBe(503);
    expect(response.body.browserEnrollmentVersion).toBeUndefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('bounded anonymous allocation cannot grow by changing attempt IDs or forwarded IPs', async () => {
    const server = app();
    for (let i = 0; i < 2; i++)
      expect(
        (
          await request(server)
            .post('/api/code-environments/setup/start')
            .set('X-Forwarded-For', `198.51.100.${i + 1}`)
            .send(body(setupRequest()))
        ).status,
      ).toBe(200);
    expect(
      (
        await request(server)
          .post('/api/code-environments/setup/start')
          .set('X-Forwarded-For', '198.51.100.200')
          .send(body(setupRequest()))
      ).status,
    ).toBe(429);
    expect(await mongoose.connection.collection('browser_setup_sessions').countDocuments()).toBe(2);
  });
});
