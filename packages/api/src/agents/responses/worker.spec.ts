import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createModels,
  createMethods,
  createResponseStorage,
  tenantStorage,
  runAsSystem,
  getTenantId,
} from '@librechat/data-schemas';
import type { ResponseStorage } from '@librechat/data-schemas';
import { createBackgroundResponseEnvelope, createResponseResumeEnvelope } from './queue';
import type { ServerRequest } from '~/types/http';
import {
  createBackgroundResponseWorkerAuth,
  mintBackgroundResponseWorkerToken,
  mintResponseResumeWorkerToken,
  getBackgroundResponseWorkerRecord,
} from './worker';

const secret = 'worker-test-secret';
const userId = new mongoose.Types.ObjectId().toString();
const responseId = 'resp_worker';
let mongo: MongoMemoryReplSet;
let storage: ResponseStorage;
let methods: ReturnType<typeof createMethods>;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  createModels(mongoose);
  methods = createMethods(mongoose);
  storage = createResponseStorage(mongoose);
});
beforeEach(async () => {
  await runAsSystem(async () => {
    await mongoose.models.StoredResponse.deleteMany({});
    await mongoose.models.ResponseScope.deleteMany({});
    await mongoose.models.User.deleteMany({});
  });
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

async function fixture(tenantId?: string) {
  const owner = { userId, tenantId };
  return tenantStorage.run(owner, async () => {
    await mongoose.models.User.create({
      _id: userId,
      tenantId,
      email: 'worker@example.com',
      provider: 'local',
    });
    const saved = await storage.reserve({
      ...owner,
      responseId,
      agentId: 'agent',
      sourceKeyId: 'original-key',
      requestKey: 'request',
      fingerprint: 'fingerprint',
      conversationId: 'conversation',
      parentMessageId: 'root',
      requestJSON: JSON.stringify({ model: 'agent', input: 'Saved input', background: true }),
    });
    if (!saved.ok) throw new Error('Fixture reservation failed');
    return saved.record;
  });
}

function app(contextTenant?: string) {
  const server = express();
  const findUser = jest.fn((id: string) => methods.findUser({ _id: id }));
  const authorize = jest.fn().mockResolvedValue(true);
  const onError = jest.fn();
  server.use((req, res, next) => tenantStorage.run({ tenantId: contextTenant }, next));
  server.use(
    createBackgroundResponseWorkerAuth(
      { storage, signingSecret: () => secret, findUser, authorize, onError },
      (req, res) => {
        res.status(403).end();
      },
    ),
  );
  server.post('/', (req, res) => {
    const principal = (req as ServerRequest).user;
    if (!principal) throw new Error('Worker principal missing');
    res.json({
      tenant: getTenantId() ?? null,
      userTenant: principal.tenantId ?? null,
      userId: principal.id,
      body: req.body,
      admitted: getBackgroundResponseWorkerRecord(req)?.responseId,
    });
  });
  return { server, findUser, authorize, onError };
}

const legacy = [undefined, null, ''];
it.each(legacy.flatMap((stored) => legacy.map((user) => [stored, user])))(
  'admits legacy stored tenant %p and user tenant %p using canonical worker claims',
  async (stored, user) => {
    await fixture();
    await mongoose.models.StoredResponse.collection.updateOne(
      { responseId },
      stored === undefined ? { $unset: { tenantId: 1 } } : { $set: { tenantId: stored } },
    );
    await mongoose.models.User.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(userId) },
      user === undefined ? { $unset: { tenantId: 1 } } : { $set: { tenantId: user } },
    );
    const record = await storage.read({ userId }, responseId);
    if (!record) throw new Error('Fixture disappeared');
    const token = mintBackgroundResponseWorkerToken(record, secret);
    expect(jwt.decode(token)).not.toHaveProperty('tenantId');
    const f = app();
    const result = await request(f.server)
      .post('/')
      .set('x-lc-response-worker', '1')
      .auth(token, { type: 'bearer' })
      .send({ model: 'attacker', input: 'Replaced input' });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      tenant: null,
      userTenant: null,
      userId,
      admitted: responseId,
      body: { model: 'agent', input: 'Saved input', background: true },
    });
    expect(f.authorize).toHaveBeenCalledTimes(1);
    expect(f.onError).not.toHaveBeenCalled();
    const persisted = await methods.findUser({ _id: userId });
    expect(persisted?.tenantId).toBe(user);
    expect(createBackgroundResponseEnvelope(record).principal.tenantId).toBeUndefined();
    const resumeRecord: Parameters<typeof mintResponseResumeWorkerToken>[0] = {
      ...record,
      generationCreatedAt: 123,
      resume: {
        intentId: 'intent',
        actionId: 'action',
        previousProviderExecutionId: 'previous',
        providerExecutionId: 'provider',
        fingerprint: 'fingerprint',
        resolutionJSON: '{}',
        state: 'reserved',
        reservedAt: 1,
      },
    };
    const resume = mintResponseResumeWorkerToken(resumeRecord, secret);
    expect(createResponseResumeEnvelope(resumeRecord).principal.tenantId).toBeUndefined();
    expect(jwt.decode(resume)).not.toHaveProperty('tenantId');
  },
);

it('preserves named partitions and rejects a different request tenant before database access', async () => {
  const record = await fixture('tenant-a');
  const token = mintBackgroundResponseWorkerToken(record, secret);
  const own = app('tenant-a');
  expect(
    (
      await request(own.server)
        .post('/')
        .set('x-lc-response-worker', '1')
        .auth(token, { type: 'bearer' })
    ).status,
  ).toBe(200);
  const other = app('tenant-b');
  expect(
    (
      await request(other.server)
        .post('/')
        .set('x-lc-response-worker', '1')
        .auth(token, { type: 'bearer' })
    ).status,
  ).toBe(401);
  expect(other.findUser).not.toHaveBeenCalled();
  expect(other.authorize).not.toHaveBeenCalled();
});

it.each(['', '_', '__SYSTEM__'])('rejects noncanonical wire tenant %p', async (tenantId) => {
  await fixture();
  const token = jwt.sign(
    { purpose: 'responses_background', responseId, userId, tenantId, sourceKeyId: 'original-key' },
    secret,
    { algorithm: 'HS256', audience: 'librechat-responses-worker', expiresIn: '60s' },
  );
  const f = app();
  expect(
    (
      await request(f.server)
        .post('/')
        .set('x-lc-response-worker', '1')
        .auth(token, { type: 'bearer' })
    ).status,
  ).toBe(401);
  expect(f.findUser).not.toHaveBeenCalled();
  expect(f.authorize).not.toHaveBeenCalled();
});

it.each(['_', '__SYSTEM__'])(
  'refuses to mint execution authority for internal partition %p',
  async (tenantId) => {
    const record = await fixture();
    expect(() => mintBackgroundResponseWorkerToken({ ...record, tenantId }, secret)).toThrow();
  },
);
