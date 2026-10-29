import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createModels,
  createMethods,
  createChannelIdentityStorage,
  tenantStorage,
  runAsSystem,
} from '@librechat/data-schemas';
import { createChannelIdentityHandlers } from './identityHttp';
import { createSameOriginGuard } from '~/middleware/origin';
import { createChannelIdentityService } from './identity';
import { createChannelHandlers } from './service';

const serviceToken = 'local-channel-identity-test-token-32-characters';
const tenantId = 'tenant-a';
let mongo: MongoMemoryServer;
let app: express.Express;
let db: ReturnType<typeof createMethods>;
let identity: ReturnType<typeof createChannelIdentityService>;
let mode: 'shared' | 'per_user';

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  db = createMethods(mongoose);
  await mongoose.models.ChannelIdentity.init();
}, 60_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  await runAsSystem(async () => {
    await mongoose.models.ChannelIdentity.deleteMany({});
    await mongoose.models.AgentChannel.deleteMany({});
  });
  mode = 'per_user';
  await tenantStorage.run({ tenantId }, () =>
    db.createAgentChannel({
      channelId: 'channel-a',
      agentId: 'agent-a',
      createdBy: 'user-a',
      type: 'slack',
      status: 'active',
      credentialMode: 'per_user',
      revision: 'rev-1',
      slack: { teamId: 'T1', appId: 'A1', botUserId: 'UBOT' },
    }),
  );
  const channelHandlers = createChannelHandlers({
    db,
    serviceToken: () => serviceToken,
    config: async () => ({ enabled: true }),
    getAgent: async () => ({ id: 'agent-a' }),
    deleteApiKey: async () => false,
    verifySlackToken: async () => null,
    logError: () => {},
  });
  identity = createChannelIdentityService({
    storage: createChannelIdentityStorage(mongoose),
    channelIsCurrent: async (actor) => {
      const channel = await db.getAgentChannel(actor.channelId);
      return (
        channel?.status === 'active' &&
        channel.revision === actor.channelRevision &&
        channel.agentId === actor.agentId &&
        channel.slack?.teamId === actor.teamId
      );
    },
    canUse: async (_actor, userId) =>
      ['user-a', 'user-b'].includes(userId) && (mode === 'per_user' || userId === 'user-a'),
    publicBaseUrl: 'http://127.0.0.1:3088',
    ticketLifetimeMs: 60000,
    linkLifetimeMs: 600000,
  });
  const handlers = createChannelIdentityHandlers({ identity, guard: channelHandlers.service });
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.get('x-test-user'))
      Object.assign(req, {
        user: {
          id: req.get('x-test-user'),
          tenantId: req.get('x-test-user-tenant') ?? tenantId,
          name: 'Account name',
          email: 'private@example.com',
        },
      });
    tenantStorage.run({ tenantId: req.get('x-test-tenant') ?? tenantId }, () => next());
  });
  const sameOrigin = createSameOriginGuard({ trustedOrigins: [] });
  app.post('/links/preview', sameOrigin, handlers.preview);
  app.post('/links/accept', sameOrigin, handlers.accept);
  app.get('/links', handlers.list);
  app.delete('/links/:linkId', sameOrigin, handlers.revoke);
  app.get('/service/:channelId/identity/:externalUserId', handlers.inspectActor);
  app.post('/service/:channelId/identity/:externalUserId/ticket', handlers.issue);
  app.post('/service/:channelId/identity/:externalUserId/confirm', handlers.confirm);
});
const svc = (path: string) =>
  request(app)
    .post(path)
    .set('Authorization', `Bearer ${serviceToken}`)
    .set('x-tenant-id', tenantId);
const browser = (path: string, user = 'user-a') =>
  request(app).post(path).set('x-test-user', user).set('Sec-Fetch-Site', 'same-origin');
async function accepted(user = 'user-a') {
  const issued = await svc('/service/channel-a/identity/U1/ticket').send({}).expect(200);
  const ticket = new URL(issued.body.value.url).hash.slice(1);
  const preview = await browser('/links/preview', user).send({ ticket }).expect(200);
  const accept = await browser('/links/accept', user)
    .send({ ticket, revision: preview.body.value.revision })
    .expect(200);
  return { ticket, accepted: accept.body.value };
}

test('HTTP acceptance plus verified actor confirmation activates without exposing credentials or internal user ID', async () => {
  const { accepted: link } = await accepted();
  const confirmed = await svc('/service/channel-a/identity/U1/confirm')
    .send({ linkId: link.linkId, revision: link.revision })
    .expect(200);
  expect(confirmed.body).toMatchObject({
    ok: true,
    value: { state: 'active', accountLabel: 'Account name' },
  });
  expect(JSON.stringify(confirmed.body)).not.toMatch(
    /private@example.com|userId|apiKey|accessToken/,
  );
  const list = await request(app).get('/links').set('x-test-user', 'user-a').expect(200);
  expect(list.headers['cache-control']).toBe('no-store');
  expect(list.body).toHaveLength(1);
  await request(app).get('/links/accept').expect(404);
  await browser('/links/confirm')
    .send({ linkId: link.linkId, revision: link.revision })
    .expect(404);
});

test('HTTP B cannot confirm a forwarded A ticket and never receives A links', async () => {
  const { accepted: link } = await accepted('user-b');
  const denied = await svc('/service/channel-a/identity/U2/confirm')
    .send({ linkId: link.linkId, revision: link.revision })
    .expect(200);
  expect(denied.body).toEqual({ ok: false, error: { code: 'forbidden' } });
  const actorB = await request(app)
    .get('/service/channel-a/identity/U2')
    .set('Authorization', `Bearer ${serviceToken}`)
    .set('x-tenant-id', tenantId)
    .expect(200);
  expect(actorB.body).toEqual({ ok: true, value: null });
  const accountA = await request(app).get('/links').set('x-test-user', 'user-a').expect(200);
  expect(accountA.body).toEqual([]);
});

test('shared owner-only policy rejects B browser account instead of inheriting creator authority', async () => {
  mode = 'shared';
  const issued = await svc('/service/channel-a/identity/U2/ticket').send({}).expect(200);
  const ticket = new URL(issued.body.value.url).hash.slice(1);
  const denied = await browser('/links/preview', 'user-b').send({ ticket }).expect(200);
  expect(denied.body).toEqual({ ok: false, error: { code: 'forbidden' } });
});

test('requires service auth and authenticated same-tenant browser; rejects cross-site writes and injected identity fields', async () => {
  const unauthenticated = await request(app)
    .post('/service/channel-a/identity/U1/ticket')
    .send({})
    .expect(401);
  expect(unauthenticated.body).toEqual({ error: 'invalid_service_auth' });
  await svc('/service/channel-a/identity/U1/ticket')
    .set('x-tenant-id', 'tenant-b')
    .send({})
    .expect(404);
  await svc('/service/channel-a/identity/U1/ticket').send({ userId: 'user-a' }).expect(400);
  await request(app).get('/links').expect(401);
  await request(app)
    .get('/links')
    .set('x-test-user', 'user-a')
    .set('x-test-user-tenant', 'tenant-b')
    .expect(403);
  const { ticket, accepted: link } = await accepted();
  await browser('/links/accept')
    .set('Sec-Fetch-Site', 'cross-site')
    .set('Origin', 'https://evil.invalid')
    .send({ ticket, revision: link.revision })
    .expect(403);
  await browser('/links/accept')
    .send({ ticket, revision: link.revision, userId: 'user-b' })
    .expect(400);
  await request(app)
    .delete(`/links/${link.linkId}`)
    .set('x-test-user', 'user-a')
    .set('Sec-Fetch-Site', 'cross-site')
    .send({ revision: link.revision })
    .expect(403);
});
