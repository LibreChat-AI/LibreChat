import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods, tenantStorage, runAsSystem } from '@librechat/data-schemas';
import type { ChannelDependencies } from './service';
import { acceptsChannelServiceToken, createChannelHandlers, publicChannel } from './service';

jest.mock('@librechat/data-schemas', () => {
  process.env.CREDS_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  return jest.requireActual('@librechat/data-schemas');
});

const serviceToken = 'local-test-service-token-32-characters';
const owner = '507f1f77bcf86cd799439011';
const tenantId = 'tenant-a';
let mongo: MongoMemoryServer;
let db: ReturnType<typeof createMethods>;
let app: express.Express;
let deps: ChannelDependencies;
let revokedKeys: string[];

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  db = createMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await runAsSystem(async () => {
    await mongoose.models.AgentChannel.deleteMany({});
    await mongoose.models.AgentChannelThread.deleteMany({});
    await mongoose.models.ChannelRun.deleteMany({});
  });
  revokedKeys = [];
  deps = {
    db,
    serviceToken: () => serviceToken,
    config: async () => ({ enabled: true }),
    getAgent: async (id) => ({ id, name: 'Test Agent' }),
    deleteApiKey: async (id) => {
      revokedKeys.push(id);
      return true;
    },
    verifySlackToken: async () => ({ teamId: 'TTEST', botUserId: 'UTEST' }),
    logError: jest.fn(),
  };
  const handlers = createChannelHandlers(deps);
  app = express();
  app.use(express.json());
  app.use('/ui', (req, _res, next) => {
    Object.assign(req, { user: { id: req.get('x-test-user') ?? owner, tenantId } });
    tenantStorage.run({ tenantId }, async () => next());
  });
  app.get('/ui/:agentId/channels', handlers.list);
  app.post('/ui/:agentId/channels', handlers.create);
  app.patch('/ui/:agentId/channels/:channelId', handlers.update);
  app.delete('/ui/:agentId/channels/:channelId', handlers.remove);
  app.get('/service/slack/:tenantId/:channelId', handlers.bundle);
  app.put('/service/:channelId/threads/:externalThreadKey', handlers.putThread);
  app.get('/service/:channelId/threads/:externalThreadKey', handlers.getThread);
});

async function createChannel(): Promise<string> {
  const response = await request(app)
    .post('/ui/agent-test/channels')
    .send({ type: 'slack', credentialMode: 'shared' })
    .expect(201);
  return response.body.channelId;
}

function activation(channelId: string) {
  return request(app)
    .patch(`/ui/agent-test/channels/${channelId}`)
    .send({
      slack: { botToken: 'xoxb-local-test', appId: 'ATEST' },
    });
}

it('requires an adequately sized service secret and compares the complete bearer', () => {
  expect(acceptsChannelServiceToken(`Bearer ${serviceToken}`, serviceToken)).toBe(true);
  expect(acceptsChannelServiceToken(`Bearer ${serviceToken}extra`, serviceToken)).toBe(false);
  expect(acceptsChannelServiceToken('Bearer short', 'short')).toBe(false);
  expect(acceptsChannelServiceToken(undefined, serviceToken)).toBe(false);
});

it('persists encrypted credentials and returns them only through the authenticated tenant bundle', async () => {
  const id = await createChannel();
  const active = await activation(id).expect(200);
  expect(JSON.stringify(active.body)).not.toMatch(/xoxb-|sk-test-|encrypted|apiKeyId/);
  const stored = await tenantStorage.run({ tenantId }, async () => db.getAgentChannel(id));
  expect(stored?.tenantId).toBe(tenantId);
  expect(stored?.encryptedBotToken).toMatch(/^v3:/);
  expect(stored?.encryptedApiKey).toBe('');
  expect(stored?.apiKeyId).toBe('');
  expect(JSON.stringify(publicChannel(stored!))).not.toContain('encrypted');
  await request(app).get(`/service/slack/${tenantId}/${id}`).expect(401);
  await request(app)
    .get(`/service/slack/tenant-b/${id}`)
    .set('Authorization', `Bearer ${serviceToken}`)
    .expect(404);
  const bundle = await request(app)
    .get(`/service/slack/${tenantId}/${id}`)
    .set('Authorization', `Bearer ${serviceToken}`)
    .expect(200);
  expect(bundle.body.credentials.botToken).toBe('xoxb-local-test');
  expect(bundle.body.credentials).not.toHaveProperty('sharedApiKey');
  expect(bundle.headers['cache-control']).toBe('no-store');
});

it('rejects creator changes and unsupported credential modes before activation', async () => {
  await request(app)
    .post('/ui/agent-test/channels')
    .send({ type: 'slack', credentialMode: 'borrow_user' })
    .expect(400);
  const id = await createChannel();
  await request(app)
    .patch(`/ui/agent-test/channels/${id}`)
    .set('x-test-user', '507f1f77bcf86cd799439012')
    .send({ slack: { botToken: 'xoxb-local-test', appId: 'ATEST' } })
    .expect(404);
  expect(await tenantStorage.run({ tenantId }, () => db.getAgentChannel(id))).toMatchObject({
    status: 'pending_install',
  });
});

it('activates per-user channels without minting or exporting an owner key and rejects legacy shared history', async () => {
  const created = await request(app)
    .post('/ui/agent-test/channels')
    .send({ type: 'slack', credentialMode: 'per_user' })
    .expect(201);
  await activation(created.body.channelId).expect(200);
  const bundle = await request(app)
    .get(`/service/slack/${tenantId}/${created.body.channelId}`)
    .set('Authorization', `Bearer ${serviceToken}`)
    .expect(200);
  expect(bundle.body.credentials).not.toHaveProperty('sharedApiKey');
  await request(app)
    .get(`/service/${created.body.channelId}/threads/CTEST:123.456`)
    .set('Authorization', `Bearer ${serviceToken}`)
    .set('X-Tenant-Id', tenantId)
    .expect(410);
});

it('requires disabled state and exact revision to change credential mode', async () => {
  const id = await createChannel();
  const active = await activation(id).expect(200);
  await request(app)
    .patch(`/ui/agent-test/channels/${id}`)
    .send({ credentialMode: 'per_user', revision: active.body.revision })
    .expect(409);
  const disabled = await request(app)
    .patch(`/ui/agent-test/channels/${id}`)
    .send({ status: 'disabled' })
    .expect(200);
  await request(app)
    .patch(`/ui/agent-test/channels/${id}`)
    .send({ credentialMode: 'per_user', revision: active.body.revision })
    .expect(409);
  const changed = await request(app)
    .patch(`/ui/agent-test/channels/${id}`)
    .send({ credentialMode: 'per_user', revision: disabled.body.revision })
    .expect(200);
  expect(changed.body.credentialMode).toBe('per_user');
  expect(changed.body.revision).not.toBe(disabled.body.revision);
  await request(app)
    .patch(`/ui/agent-test/channels/${id}`)
    .send({ credentialMode: 'shared', revision: disabled.body.revision })
    .expect(409);
});

it('isolates durable thread mappings and denies disabled channels', async () => {
  const id = await createChannel();
  await activation(id).expect(200);
  await request(app)
    .put(`/service/${id}/threads/CTEST:123.456`)
    .set('Authorization', `Bearer ${serviceToken}`)
    .set('X-Tenant-Id', tenantId)
    .send({ conversationId: 'resp_test' })
    .expect(410);
  await request(app)
    .get(`/service/${id}/threads/CTEST:123.456`)
    .set('Authorization', `Bearer ${serviceToken}`)
    .set('X-Tenant-Id', tenantId)
    .expect(410);
  await request(app)
    .get(`/service/${id}/threads/CTEST:123.456`)
    .set('Authorization', `Bearer ${serviceToken}`)
    .set('X-Tenant-Id', 'tenant-b')
    .expect(404);
  await request(app)
    .patch(`/ui/agent-test/channels/${id}`)
    .send({ status: 'disabled' })
    .expect(200);
  await request(app)
    .get(`/service/slack/${tenantId}/${id}`)
    .set('Authorization', `Bearer ${serviceToken}`)
    .expect(404);
  expect(await tenantStorage.run({ tenantId }, () => db.getAgentChannel(id))).toMatchObject({
    status: 'disabled',
  });
});

it('fails closed when retiring a legacy unrestricted owner key fails', async () => {
  const id = await createChannel();
  await activation(id).expect(200);
  await request(app)
    .patch(`/ui/agent-test/channels/${id}`)
    .send({ status: 'disabled' })
    .expect(200);
  await tenantStorage.run({ tenantId }, () =>
    db.updateAgentChannel(id, owner, { apiKeyId: 'legacy-key' }),
  );
  deps.deleteApiKey = async (keyId) => {
    revokedKeys.push(keyId);
    throw new Error('sensitive upstream diagnostics');
  };
  await activation(id).expect(503);
  expect(revokedKeys).toContain('legacy-key');
  const stored = await tenantStorage.run({ tenantId }, async () => db.getAgentChannel(id));
  expect(stored?.apiKeyId).toBe('legacy-key');
  expect(stored?.status).toBe('disabled');
});

it('leaves a failed deletion closed and retryable without allowing reactivation', async () => {
  const id = await createChannel();
  await activation(id).expect(200);
  await tenantStorage.run({ tenantId }, () =>
    db.updateAgentChannel(id, owner, { apiKeyId: 'legacy-key' }),
  );
  deps.deleteApiKey = async () => {
    throw new Error('sensitive upstream diagnostics');
  };
  const failed = await request(app).delete(`/ui/agent-test/channels/${id}`).expect(503);
  expect(failed.body).toEqual({ error: 'channel_operation_failed' });
  await activation(id).expect(409);
  await request(app)
    .get(`/service/slack/${tenantId}/${id}`)
    .set('Authorization', `Bearer ${serviceToken}`)
    .expect(404);
  deps.deleteApiKey = async () => true;
  await request(app).delete(`/ui/agent-test/channels/${id}`).expect(204);
});

it('returns a safe deleting state while a persisted run is still active', async () => {
  const id = await createChannel();
  await activation(id).expect(200);
  await tenantStorage.run({ tenantId }, () =>
    mongoose.models.ChannelRun.create({
      tenantId,
      channelId: id,
      agentId: 'agent-test',
      runId: 'pending-run',
      laneId: 'lane',
      state: 'queued',
      principal: { userId: owner, channelRevision: 'old' },
      admission: {},
      payloadHash: 'hash',
      sequence: 1,
      receivedAt: 1,
      receipts: [],
    }),
  );
  const response = await request(app).delete(`/ui/agent-test/channels/${id}`).expect(202);
  expect(response.body).toMatchObject({ channelId: id, status: 'deleting' });
  expect(JSON.stringify(response.body)).not.toMatch(/encrypted|xoxb|apiKey/);
  await request(app)
    .get(`/service/slack/${tenantId}/${id}`)
    .set('Authorization', `Bearer ${serviceToken}`)
    .expect(404);
  expect(await tenantStorage.run({ tenantId }, () => db.getAgentChannel(id))).toMatchObject({
    status: 'deleting',
  });
});

it('retains the deleting parent when dependent thread cleanup fails', async () => {
  const id = await createChannel();
  await tenantStorage.run({ tenantId }, async () => {
    await db.putAgentChannelThread(id, 'CTEST:123.456', 'resp_test');
    expect(await db.deleteAgentChannel(id, 'another-owner')).toBe(false);
    expect(await db.getAgentChannelThread(id, 'CTEST:123.456')).not.toBeNull();
  });
  const cleanup = jest.spyOn(mongoose.models.AgentChannelThread, 'deleteMany');
  cleanup.mockRejectedValueOnce(new Error('temporary database failure'));
  try {
    await request(app).delete(`/ui/agent-test/channels/${id}`).expect(503);
    const stored = await tenantStorage.run({ tenantId }, () => db.getAgentChannel(id));
    expect(stored?.status).toBe('deleting');
    await activation(id).expect(409);
    await request(app).delete(`/ui/agent-test/channels/${id}`).expect(204);
    await tenantStorage.run({ tenantId }, async () => {
      expect(await db.getAgentChannel(id)).toBeNull();
      expect(await db.getAgentChannelThread(id, 'CTEST:123.456')).toBeNull();
    });
  } finally {
    cleanup.mockRestore();
  }
});
