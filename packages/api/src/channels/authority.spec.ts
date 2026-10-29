import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { Readable } from 'node:stream';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { PermissionBits, Permissions, PermissionTypes, FileSources } from 'librechat-data-provider';
import {
  createModels,
  createMethods,
  createChannelIdentityStorage,
  createChannelRunStorage,
  createResponseStorage,
  hashToken,
  tenantStorage,
  runAsSystem,
} from '@librechat/data-schemas';
import type {
  ChannelRunAdmission,
  ChannelIdentityResult,
  ChannelRunSnapshot,
  ChannelRunSummary,
} from 'librechat-data-provider';
import type { IUser, ChannelRunRecord } from '@librechat/data-schemas';
import type { BackgroundResponsesHost } from '~/agents/responses/host';
import type { ApiKeyAuthRequest } from '~/apiKeys/middleware';
import {
  createChannelAuthority,
  channelExternalIdentity,
  admitChannelGeneration,
} from './authority';
import { createAgentTriggerEnvelope } from '~/agents/triggers/envelope';
import { createChannelResponseCredentials } from './credentials';
import { createRequireApiKeyAuth } from '~/apiKeys/middleware';
import { createChannelArtifactService } from './artifacts';
import { ChannelExecutionError } from './execution';
import { createChannelHandlers } from './service';
import { createChannelRunHandlers } from './runs';

let mongo: MongoMemoryReplSet;
let db: ReturnType<typeof createMethods>;
let models: ReturnType<typeof createModels>;
let authority: ReturnType<typeof createChannelAuthority>;
let storage: ReturnType<typeof createChannelRunStorage>;
let users: IUser[];
let acl: Map<string, number>;
let invoked: ChannelRunRecord[];
let advanceError: ChannelExecutionError | undefined;
let retired: ChannelRunRecord[];
let retirement: 'stopped' | 'pending';
let artifactRead: () => Promise<void>;
let nextSnapshot: ChannelRunSnapshot;
let summarize: jest.Mock<Promise<ChannelRunSummary>, [ChannelRunRecord, ChannelRunSnapshot]>;
let responseCredential: jest.Mock<Promise<string>, [ChannelRunRecord]>;
let app: express.Express;
let interactive: Pick<BackgroundResponsesHost, 'readInteractiveReview' | 'submitInteractiveReview'>;
const tenantId = 'tenant-channel-authority';
const token = 'test-channel-service-bearer-32-characters';
const scoped = (work: () => Promise<void>) => () => tenantStorage.run({ tenantId }, work);
const value = <T>(result: ChannelIdentityResult<T>): T => {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
};

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  models = createModels(mongoose);
  db = createMethods(mongoose);
  storage = createChannelRunStorage(mongoose);
  await Promise.all([
    models.ChannelIdentity.init(),
    models.ChannelRun.init(),
    models.ChannelLane.init(),
  ]);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  await runAsSystem(async () => {
    await Promise.all([
      models.ChannelIdentity.deleteMany({}),
      models.StoredResponse.deleteMany({}),
      models.ResponseScope.deleteMany({}),
      models.ChannelRun.deleteMany({}),
      models.ChannelLane.deleteMany({}),
      models.AgentChannel.deleteMany({}),
      models.User.deleteMany({}),
      models.Role.deleteMany({}),
      models.File.deleteMany({}),
    ]);
  });
  await tenantStorage.run({ tenantId }, async () => {
    users = await models.User.create([
      { email: 'a@example.test', name: 'Account A', role: 'USER' },
      { email: 'b@example.test', name: 'Account B', role: 'USER' },
    ]);
    await models.Role.create({
      name: 'USER',
      permissions: { [PermissionTypes.REMOTE_AGENTS]: { [Permissions.USE]: true } },
    });
    await db.createAgentChannel({
      channelId: 'channel',
      tenantId,
      agentId: 'agent',
      createdBy: users[0].id,
      type: 'slack',
      status: 'active',
      credentialMode: 'per_user',
      revision: 'revision-1',
      slack: { teamId: 'T1', appId: 'A1', botUserId: 'UBOT' },
    });
  });
  acl = new Map(users.map((user) => [user.id, PermissionBits.VIEW]));
  invoked = [];
  advanceError = undefined;
  retired = [];
  retirement = 'stopped';
  artifactRead = async () => {};
  nextSnapshot = { status: 'running', text: '', elapsedMs: 1 };
  summarize = jest.fn<Promise<ChannelRunSummary>, [ChannelRunRecord, ChannelRunSnapshot]>(
    async () => ({
      version: 1,
      scope: 'actor_lane',
      throughSequence: 1,
      includesCurrent: true,
      priorRuns: 0,
      expectedRuns: 1,
      observedRuns: 1,
      costUSD: { coverage: 'unavailable', coveredRuns: 0 },
      elapsedMs: { coverage: 'complete', coveredRuns: 1, value: 12 },
      tokens: { coverage: 'unavailable', coveredRuns: 0 },
    }),
  );
  authority = createChannelAuthority({
    channels: db,
    identityStorage: createChannelIdentityStorage(mongoose),
    runs: storage,
    findUser: (id) => db.findUser({ _id: id }),
    getRole: (name) => models.Role.findOne({ name }),
    isPrincipalActive: async () => true,
    getAgentPermissions: async (_id, user) => acl.get(user.id) ?? 0,
    publicBaseUrl: 'http://127.0.0.1:3088',
  });
  const handlers = createChannelHandlers({
    db,
    serviceToken: () => token,
    config: async () => ({ enabled: true }),
    getAgent: async (id) => ({ id }),
    deleteApiKey: async () => true,
    verifySlackToken: async () => null,
    logError: jest.fn(),
  });
  responseCredential = jest.fn<Promise<string>, [ChannelRunRecord]>(async () => 'sk-test');
  interactive = {
    readInteractiveReview: jest.fn(async (_owner, responseId) => ({
      responseId,
      status: 'in_progress' as const,
      oauth: [],
      canSubmitDecision: true,
      pendingAction: {
        actionId: 'native-action',
        expiresAt: Date.now() + 60000,
        payload: { type: 'ask_user_question' as const, question: { question: 'Private question' } },
      },
    })),
    submitInteractiveReview: jest.fn(async (_owner, responseId, decision) => ({
      ok: true as const,
      receipt: {
        responseId,
        actionId: (decision as { actionId: string }).actionId,
        intentId: 'intent',
        status: 'queued' as const,
      },
    })),
  };
  const runs = createChannelRunHandlers({
    interactive,
    responseCredential,
    storage,
    artifacts: createChannelArtifactService({
      listFiles: db.listRunArtifacts,
      readFile: async () => {
        await artifactRead();
        return Readable.from(Buffer.from('file'));
      },
      limits: async () => ({
        artifactMaxBytes: 1000,
        artifactMaxFiles: 1,
        artifactReadTimeoutMs: 1000,
      }),
    }),
    guard: handlers.service,
    resolvePrincipal: authority.resolvePrincipal,
    summarize: (run, snapshot) => summarize(run, snapshot),
    publicBaseUrl: 'http://127.0.0.1:3088',
    advance: async (run) => {
      if (advanceError) throw advanceError;
      invoked.push(run);
      return { snapshot: { ...nextSnapshot } };
    },
    retireForAuthorityLoss: async (run) => {
      retired.push(run);
      return retirement;
    },
  });
  app = express();
  app.use(express.json());
  app.post('/service/:channelId/runs', runs.admit);
  app.post('/service/:channelId/runs/claim', runs.claim);
  app.post('/service/:channelId/runs/stop-thread', runs.stopThread);
  app.post('/service/:channelId/runs/:runId/yield', runs.yieldLease);
  app.post('/service/:channelId/runs/:runId/advance', runs.advance);
  app.post('/service/:channelId/runs/:runId/response/prepare', runs.prepareResponse);
  app.post('/service/:channelId/runs/:runId/response/bind', runs.bindResponse);
  app.post('/service/:channelId/runs/:runId/cancel', runs.cancel);
  app.post('/service/:channelId/runs/:runId/review', runs.review);
  app.post('/service/:channelId/runs/:runId/review/decision', runs.submitReview);
  app.post('/service/:channelId/runs/:runId/plan', runs.plan);
  app.post('/service/:channelId/runs/:runId/artifacts/:artifactId', runs.artifact);
});

function event(actor = 'U1', eventId = `Ev-${actor}`): ChannelRunAdmission {
  return {
    eventId,
    externalChannelId: 'C1',
    externalThreadKey: 'C1:1.000001',
    externalMessageKey: `C1:${eventId}`,
    actor: { teamId: 'T1', appId: 'A1', externalUserId: actor },
    input: 'Use my own permissions',
  };
}

function responseCredentials() {
  const key = randomBytes(32);
  return createChannelResponseCredentials({
    storage,
    responses: createResponseStorage(mongoose),
    getChannel: db.getAgentChannelMetadata,
    resolvePrincipal: authority.resolvePrincipal,
    createKey: db.createAgentApiKey,
    getKey: db.getAgentApiKeyById,
    deleteKey: db.deleteAgentApiKey,
    lifetimeMs: async () => 60000,
    encrypt: async (value) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
    },
    decrypt: async (value) => {
      const encoded = Buffer.from(value, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, encoded.subarray(0, 12));
      decipher.setAuthTag(encoded.subarray(12, 28));
      return Buffer.concat([decipher.update(encoded.subarray(28)), decipher.final()]).toString(
        'utf8',
      );
    },
  });
}

it(
  'provisions one encrypted, run-bound credential under concurrent gateway retries',
  scoped(async () => {
    await link('U1', users[0]);
    const admitted = await post('runs').send(event()).expect(201);
    const claimed = await post('runs/claim').send({ owner: 'worker' }).expect(200);
    const run = await storage.prepareExecution(tenantId, claimed.body.fence, Date.now());
    const credentials = responseCredentials();
    const keys = await Promise.all([
      credentials.provision(run),
      credentials.provision(run),
      credentials.provision(run),
    ]);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^sk-bound-/);
    const saved = (await storage.read(tenantId, 'channel', admitted.body.runId))!;
    expect(saved.execution?.encryptedApiKey).not.toContain(keys[0]);
    expect(saved.execution?.protocol).toBe('responses');
    expect(await db.listAgentApiKeys(users[0].id)).toHaveLength(1);
    const validated = await db.validateAgentApiKey(keys[0]);
    expect(validated?.binding).toEqual({ kind: 'channel_run', id: `channel/${run.runId}` });
    // The pre-binding validator used the raw-token hash. An old replica must not admit this key.
    expect(
      await mongoose.models.AgentApiKey.findOne({ keyHash: await hashToken(keys[0]) }),
    ).toBeNull();
    await db.deleteAgentApiKey(saved.execution!.apiKeyId!, users[0].id);
    await expect(credentials.provision(saved)).rejects.toThrow('authority changed');
  }),
);

it(
  'enforces run, input, endpoint and live actor-link authority for bound API keys',
  scoped(async () => {
    const linked = await link('U1', users[0]);
    await post('runs').send(event()).expect(201);
    const claimed = await post('runs/claim').send({ owner: 'worker' }).expect(200);
    const run = await storage.prepareExecution(tenantId, claimed.body.fence, Date.now());
    const credentials = responseCredentials();
    const key = await credentials.provision(run);
    const saved = (await storage.read(tenantId, 'channel', run.runId))!;
    const authenticate = createRequireApiKeyAuth({
      validateAgentApiKey: db.validateAgentApiKey,
      findUser: db.findUser,
      isPrincipalActive: db.isAgentTriggerPrincipalActive,
      authorizeBinding: credentials.authorizeRequest,
      enrollmentRequired: () => false,
    });
    const api = express();
    api.use(express.json());
    api.use((_req, _res, next) => {
      tenantStorage.run({ tenantId }, next);
    });
    api.use(async (req, res, next) => {
      await authenticate(req as ApiKeyAuthRequest, res, next);
    });
    api.post(/.*/, (_req, res) => {
      res.sendStatus(204);
    });
    const body = {
      model: 'agent',
      input: event().input,
      background: true,
      store: true,
      stream: false,
    };
    const call = (path = '/api/agents/v1/responses', bearer = key) =>
      request(api)
        .post(path)
        .auth(bearer, { type: 'bearer' })
        .set('Idempotency-Key', `channel:${run.runId}`);
    await call().send(body).expect(204);
    await call()
      .send({ ...body, model: 'other-agent' })
      .expect(403);
    await call()
      .send({ ...body, input: 'Not the admitted Slack message' })
      .expect(403);
    await call('/api/agents/v1/chat/completions').send(body).expect(403);
    const orphan = await db.createAgentApiKey({
      userId: users[0].id,
      name: 'Unpublished candidate',
      binding: { kind: 'channel_run', id: `channel/${run.runId}` },
    });
    await call('/api/agents/v1/responses', orphan.key).send(body).expect(403);
    const ordinary = await db.createAgentApiKey({ userId: users[0].id, name: 'Ordinary key' });
    await call('/api/agents/v1/chat/completions', ordinary.key).send(body).expect(204);
    await storage.requestCancel(tenantId, 'channel', run.runId, 'U1');
    await call().send(body).expect(403);
    const response = await createResponseStorage(mongoose).reserve({
      tenantId,
      userId: users[0].id,
      responseId: `resp_${run.runId}`,
      requestKey: `channel:${run.runId}`,
      sourceKeyId: saved.execution!.apiKeyId,
      agentId: 'agent',
      fingerprint: 'cancelled-request',
      requestJSON: JSON.stringify(body),
      conversationId: 'canonical-cancelled',
      parentMessageId: '00000000-0000-0000-0000-000000000000',
    });
    if (!response.ok) throw new Error('Reservation failed');
    const recovered = await storage.recoverResponse(tenantId, claimed.body.fence, Date.now());
    expect(await credentials.provision(recovered!)).toBe(key);
    await call().send(body).expect(403);
    await call(`/api/agents/v1/responses/${response.record.responseId}/cancel`)
      .send({})
      .expect(204);
    await call('/api/agents/v1/responses/resp_unrelated/cancel').send({}).expect(403);
    value(
      await authority.identity.revoke(
        { tenantId, userId: users[0].id, accountLabel: 'A' },
        linked.linkId,
        linked.revision,
      ),
    );
    await call().send(body).expect(403);
    await call(`/api/agents/v1/responses/${response.record.responseId}/cancel`)
      .send({})
      .expect(403);
    expect(
      await credentials.authorizeSource(
        { kind: 'channel_run', id: `channel/${run.runId}` },
        saved.execution!.apiKeyId!,
        { userId: users[0].id, tenantId },
        'agent',
      ),
    ).toBe(false);
  }),
);

it(
  'prepares and binds a canonical Response without executing through the Channels service',
  scoped(async () => {
    await link('U1', users[0]);
    const admitted = await post('runs').send(event()).expect(201);
    const claimed = await post('runs/claim').send({ owner: 'worker' }).expect(200);
    const route = `runs/${admitted.body.runId}/response`;
    const prepared = await post(`${route}/prepare`).send({ fence: claimed.body.fence }).expect(200);
    expect(prepared.body).toEqual({
      apiKey: 'sk-test',
      requestKey: `channel:${admitted.body.runId}`,
      request: { model: 'agent', input: event().input, background: true, store: true },
    });
    expect(invoked).toHaveLength(0);
    await post(`${route}/bind`)
      .send({ fence: claimed.body.fence, responseId: 'resp_missing' })
      .expect(409);
    const reserved = await createResponseStorage(mongoose).reserve({
      tenantId,
      userId: users[0].id,
      responseId: `resp_${admitted.body.runId}`,
      requestKey: prepared.body.requestKey,
      fingerprint: 'request',
      agentId: 'agent',
      requestJSON: JSON.stringify(prepared.body.request),
      conversationId: 'canonical-conversation',
      parentMessageId: '00000000-0000-0000-0000-000000000000',
    });
    if (!reserved.ok) throw new Error('Reservation failed');
    const body = { fence: claimed.body.fence, responseId: reserved.record.responseId };
    await post(`${route}/bind`).send(body).expect(200);
    await post(`${route}/bind`).send(body).expect(200);
    const run = await storage.read(tenantId, 'channel', admitted.body.runId);
    expect(run?.execution).toMatchObject({
      protocol: 'responses',
      responseId: reserved.record.responseId,
      conversationId: 'canonical-conversation',
    });
    await storage.saveSnapshot(
      tenantId,
      claimed.body.fence,
      {
        responseId: reserved.record.responseId,
        status: 'requires_action',
        text: '',
        elapsedMs: 1,
        pendingAction: { actionId: 'oauth-action', kind: 'oauth', expiresAt: Date.now() + 60_000 },
      },
      Date.now(),
    );
    const reviewPath = `runs/${admitted.body.runId}/review`;
    const review = await post(reviewPath)
      .send({ actor: event().actor, revision: 'revision-1' })
      .expect(200);
    expect(review.body.url).toBe(
      `http://127.0.0.1:3088/responses/${reserved.record.responseId}/review`,
    );
    await post(reviewPath)
      .send({ actor: event('U2').actor, revision: 'revision-1' })
      .expect(403);
    expect(invoked).toHaveLength(0);
  }),
);

it(
  'holds cancelled unbound credentials and recovers a late canonical response without execution',
  scoped(async () => {
    await link('U1', users[0]);
    const admitted = await post('runs').send(event()).expect(201);
    const claimed = await post('runs/claim').send({ owner: 'worker' }).expect(200);
    const route = `runs/${admitted.body.runId}/response`;
    await storage.prepareExecution(tenantId, claimed.body.fence, Date.now());
    await storage.attachResponseCredential(
      tenantId,
      claimed.body.fence,
      { apiKeyId: 'issued-key', encryptedApiKey: 'ciphertext' },
      Date.now(),
    );
    await post(`runs/${admitted.body.runId}/cancel`)
      .send({ actor: event().actor, revision: 'revision-1' })
      .expect(202);
    await post(`${route}/prepare`)
      .send({ fence: claimed.body.fence })
      .expect(409, { error: 'response_cancellation_pending' });
    expect(responseCredential).not.toHaveBeenCalled();
    const reserved = await createResponseStorage(mongoose).reserve({
      tenantId,
      userId: users[0].id,
      responseId: `resp_${admitted.body.runId}`,
      requestKey: `channel:${admitted.body.runId}`,
      sourceKeyId: 'issued-key',
      fingerprint: 'late-request',
      agentId: 'agent',
      requestJSON: JSON.stringify({
        model: 'agent',
        input: event().input,
        background: true,
        store: true,
      }),
      conversationId: 'late-canonical-conversation',
      parentMessageId: '00000000-0000-0000-0000-000000000000',
    });
    if (!reserved.ok) throw new Error('Reservation failed');
    for (let attempt = 0; attempt < 2; attempt++) {
      const prepared = await post(`${route}/prepare`)
        .send({ fence: claimed.body.fence })
        .expect(200);
      expect(prepared.body.responseId).toBe(reserved.record.responseId);
    }
    expect(responseCredential).toHaveBeenCalledTimes(2);
    expect(responseCredential.mock.calls[0][0]).toMatchObject({ cancellationRequested: true });
    expect(invoked).toHaveLength(0);
    expect(
      (await storage.read(tenantId, 'channel', admitted.body.runId))?.snapshot,
    ).toBeUndefined();
    expect(
      await createResponseStorage(mongoose).read(reserved.record, reserved.record.responseId),
    ).toEqual(reserved.record);
  }),
);

it.each(['per_user', 'shared'] as const)(
  'keeps native review private and actor-bound in %s mode, including same-account thread participants',
  (mode) =>
    tenantStorage.run({ tenantId }, async () => {
      if (mode === 'shared')
        await models.AgentChannel.updateOne(
          { channelId: 'channel' },
          { $set: { credentialMode: 'shared' } },
        );
      const linked = await link('U1', users[0]);
      await link('U2', users[0]);
      const admitted = await post('runs').send(event()).expect(201);
      const claimed = await post('runs/claim').send({ owner: 'worker' }).expect(200);
      const base = `runs/${admitted.body.runId}`;
      const prepared = await post(`${base}/response/prepare`)
        .send({ fence: claimed.body.fence })
        .expect(200);
      const responseId = `resp_${admitted.body.runId}`;
      await createResponseStorage(mongoose).reserve({
        tenantId,
        userId: users[0].id,
        responseId,
        requestKey: prepared.body.requestKey,
        fingerprint: 'request',
        agentId: 'agent',
        requestJSON: JSON.stringify(prepared.body.request),
        conversationId: 'native-conversation',
        parentMessageId: 'root',
      });
      await post(`${base}/response/bind`)
        .send({ fence: claimed.body.fence, responseId })
        .expect(200);
      await storage.saveSnapshot(
        tenantId,
        claimed.body.fence,
        {
          responseId,
          status: 'requires_action',
          text: '',
          elapsedMs: 1,
          pendingAction: {
            actionId: 'native-action',
            kind: 'ask_user_question',
            expiresAt: Date.now() + 60000,
          },
        },
        Date.now(),
      );
      const body = { actor: event().actor, revision: 'revision-1', externalChannelId: 'C1' };
      const view = await post(`${base}/review`).send(body).expect(200);
      expect(view.body.pendingAction.payload.question.question).toBe('Private question');
      const savedView = await interactive.readInteractiveReview(
        { userId: users[0].id, tenantId },
        responseId,
      );
      if (!savedView) throw new Error('Expected the current actor review');
      const pendingDecision = {
        intentId: 'saved-native-intent',
        decision: { actionId: 'native-action', answer: 'Private saved answer' },
      };
      jest.mocked(interactive.readInteractiveReview).mockImplementation(async () => ({
        ...savedView,
        pendingDecision,
      }));
      const saved = await post(`${base}/review`).send(body).expect(200);
      expect(saved.body.pendingDecision).toEqual(pendingDecision);
      const browser = await post(`${base}/review`)
        .send({ actor: event().actor, revision: 'revision-1' })
        .expect(200);
      expect(browser.body.pendingAction).toBeUndefined();
      expect(browser.body.pendingDecision).toBeUndefined();
      for (const invalid of [
        { ...body, actor: event('U2').actor },
        { ...body, externalChannelId: 'C2' },
        { ...body, revision: 'stale' },
      ]) {
        await post(`${base}/review`).send(invalid).expect(403);
        await post(`${base}/review/decision`)
          .send({ ...invalid, decision: { actionId: 'native-action', answer: 'yes' } })
          .expect(403);
      }
      expect(interactive.submitInteractiveReview).not.toHaveBeenCalled();
      await post(`${base}/review/decision`)
        .send({ ...body, decision: { actionId: 'native-action', answer: 'yes' } })
        .expect(202);
      expect(interactive.submitInteractiveReview).toHaveBeenCalledWith(
        { userId: users[0].id, tenantId },
        responseId,
        { actionId: 'native-action', answer: 'yes' },
      );
      value(
        await authority.identity.revoke(
          { tenantId, userId: users[0].id, accountLabel: 'A' },
          linked.linkId,
          linked.revision,
        ),
      );
      await post(`${base}/review`).send(body).expect(403);
      await post(`${base}/review/decision`)
        .send({ ...body, decision: { actionId: 'native-action', answer: 'yes' } })
        .expect(403);
      expect(interactive.submitInteractiveReview).toHaveBeenCalledTimes(1);
      expect(invoked).toHaveLength(0);
    }),
);

it(
  'native Stop resolves only the current actor lane and ignores stale or foreign clicks',
  scoped(async () => {
    await link('U1', users[0]);
    await link('U2', users[1]);
    const admission = event();
    const admitted = await post('runs').send(admission).expect(201);
    await post('runs/claim').send({ owner: 'worker' }).expect(200);
    const stop = {
      actor: admission.actor,
      externalThreadKey: admission.externalThreadKey,
      eventAt: Date.now(),
    };
    const route = 'runs/stop-thread';
    await post(route)
      .send({ ...stop, actor: { ...stop.actor, externalUserId: 'U2' } })
      .expect(200, { cancellationRequested: false });
    await post(route)
      .send({ ...stop, externalThreadKey: 'C1:other' })
      .expect(200, { cancellationRequested: false });
    await post(route)
      .send({ ...stop, eventAt: 1 })
      .expect(200, { cancellationRequested: false });
    await post(route)
      .send({ ...stop, actor: { ...stop.actor, teamId: 'other' } })
      .expect(403);
    expect(
      (await storage.read(tenantId, 'channel', admitted.body.runId))?.cancellationRequested,
    ).toBe(false);
    await post(route).send(stop).expect(202, { cancellationRequested: true });
    await post(route).send(stop).expect(202, { cancellationRequested: true });
    expect(
      (await storage.read(tenantId, 'channel', admitted.body.runId))?.cancellationRequested,
    ).toBe(true);
  }),
);

it(
  'summarizes only terminal snapshots and freezes the first summary across advance retries',
  scoped(async () => {
    await link('U1', users[0]);
    const admitted = await post('runs').send(event()).expect(201);
    const claimed = await post('runs/claim').send({ owner: 'worker' }).expect(200);
    const route = `runs/${admitted.body.runId}/advance`;
    const body = { fence: claimed.body.fence };
    await post(route).send(body).expect(200);
    expect(summarize).not.toHaveBeenCalled();
    nextSnapshot = { status: 'completed', text: 'Answer', elapsedMs: 12 };
    const first = await post(route).send(body).expect(200);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(first.body.snapshot.summary).toMatchObject({ version: 1, throughSequence: 1 });
    summarize.mockRejectedValue(new Error('Must not recompute'));
    const replay = await post(route).send(body).expect(200);
    expect(replay.body.snapshot.summary).toEqual(first.body.snapshot.summary);
    expect(summarize).toHaveBeenCalledTimes(1);
  }),
);

it(
  'keeps a valid terminal answer when optional summary storage is unavailable',
  scoped(async () => {
    await link('U1', users[0]);
    const admitted = await post('runs').send(event()).expect(201);
    const claimed = await post('runs/claim').send({ owner: 'worker' }).expect(200);
    nextSnapshot = { status: 'completed', text: 'Answer', elapsedMs: 12 };
    summarize.mockRejectedValue(new Error('Private database failure'));
    const response = await post(`runs/${admitted.body.runId}/advance`)
      .send({ fence: claimed.body.fence })
      .expect(200);
    expect(response.body.snapshot).toMatchObject({ status: 'completed', text: 'Answer' });
    expect(response.body.snapshot).not.toHaveProperty('summary');
    expect(JSON.stringify(response.body)).not.toContain('Private database failure');
  }),
);

it(
  'rechecks actor authority after summary retrieval before persisting or returning the answer',
  scoped(async () => {
    const linked = await link('U1', users[0]);
    const admitted = await post('runs').send(event()).expect(201);
    const claimed = await post('runs/claim').send({ owner: 'worker' }).expect(200);
    nextSnapshot = { status: 'completed', text: 'Do not deliver', elapsedMs: 12 };
    summarize.mockImplementation(async () => {
      value(
        await authority.identity.revoke(
          { tenantId, userId: users[0].id, accountLabel: 'A' },
          linked.linkId,
          linked.revision,
        ),
      );
      throw new Error('Optional metadata unavailable after revocation');
    });
    const response = await post(`runs/${admitted.body.runId}/advance`)
      .send({ fence: claimed.body.fence })
      .expect(403);
    expect(response.body).toEqual({ error: 'channel_authority_changed' });
    const persisted = await storage.read(tenantId, 'channel', admitted.body.runId);
    expect(persisted?.state).toBe('cancelled');
    expect(persisted?.snapshot).toBeUndefined();
    expect(retired).toHaveLength(1);
  }),
);

it(
  'does not swallow an authority lookup outage as an optional summary failure',
  scoped(async () => {
    await link('U1', users[0]);
    const admitted = await post('runs').send(event()).expect(201);
    const claimed = await post('runs/claim').send({ owner: 'worker' }).expect(200);
    nextSnapshot = { status: 'completed', text: 'Do not deliver', elapsedMs: 12 };
    const lookup = jest.spyOn(db, 'findUser');
    summarize.mockImplementation(async () => {
      lookup.mockRejectedValue(new Error('Authority storage unavailable'));
      throw new Error('Optional summary unavailable');
    });
    try {
      await post(`runs/${admitted.body.runId}/advance`)
        .send({ fence: claimed.body.fence })
        .expect(503);
      const persisted = await storage.read(tenantId, 'channel', admitted.body.runId);
      expect(persisted?.state).toBe('executing');
      expect(persisted?.snapshot).toBeUndefined();
      expect(retired).toHaveLength(0);
    } finally {
      lookup.mockRestore();
    }
  }),
);

it(
  'reports only a stable execution hold code without exposing diagnostics or fabricating completion',
  scoped(async () => {
    await link('U1', users[0]);
    const admitted = await post('runs').send(event()).expect(201);
    const claimed = await post('runs/claim').send({ owner: 'worker-A' }).expect(200);
    advanceError = new ChannelExecutionError('dispatch_outcome_unknown');
    advanceError.message = 'sensitive provider details must remain private';
    const response = await post(`runs/${admitted.body.runId}/advance`)
      .send({ fence: claimed.body.fence })
      .expect(409);
    expect(response.body).toEqual({ error: 'dispatch_outcome_unknown' });
    const persisted = await storage.read(tenantId, 'channel', admitted.body.runId);
    expect(persisted?.state).toBe('executing');
    expect(persisted?.snapshot).toBeUndefined();
    expect(invoked).toHaveLength(0);
  }),
);

it(
  'validates and durably preserves opaque provider presentation with an immutable text fallback',
  scoped(async () => {
    await link('U1', users[0]);
    const admitted = await post('runs').send(event()).expect(201);
    const claimed = await post('runs/claim').send({ owner: 'worker-A' }).expect(200);
    const fence = claimed.body.fence;
    await post(`runs/${admitted.body.runId}/advance`).send({ fence }).expect(200);
    await storage.saveSnapshot(
      tenantId,
      fence,
      { status: 'completed', responseId: 'reply-1', text: '# Answer', elapsedMs: 1 },
      Date.now(),
    );
    const payload = JSON.stringify([
      { type: 'header', text: { type: 'plain_text', text: 'Answer' } },
    ]);
    const part = {
      operationId: 'reply-part',
      kind: 'message',
      required: true,
      text: '*Answer*',
      presentation: { format: 'slack-blocks-v1', payload },
    };
    const plan = { revision: 'plan-1', rendererVersion: 'slack-structured-v2', parts: [part] };
    const route = `runs/${admitted.body.runId}/plan`;
    for (const invalid of [
      { ...part, kind: 'artifact' },
      { ...part, presentation: { format: 'bad format', payload } },
      { ...part, presentation: { format: 'slack-blocks-v1', payload: '{' } },
      { ...part, presentation: { format: 'slack-blocks-v1', payload: 'null' } },
      {
        ...part,
        presentation: { format: 'slack-blocks-v1', payload: JSON.stringify(['界'.repeat(22_000)]) },
      },
    ]) {
      await post(route)
        .send({ fence, plan: { ...plan, parts: [invalid] } })
        .expect(400);
    }
    await post(route).send({ fence, plan }).expect(200);
    expect((await storage.read(tenantId, 'channel', admitted.body.runId))?.plan).toEqual(plan);
    await post(route).send({ fence, plan }).expect(200);
    await post(route)
      .send({
        fence,
        plan: {
          ...plan,
          parts: [{ ...part, presentation: { ...part.presentation, payload: '[]' } }],
        },
      })
      .expect(409);
  }),
);
function post(path: string) {
  return request(app)
    .post(`/service/channel/${path}`)
    .set('Authorization', `Bearer ${token}`)
    .set('X-Tenant-Id', tenantId);
}

it(
  'yields only a currently authorized exact polling lease and rejects revoked authority',
  scoped(async () => {
    await link('U1', users[0]);
    const admitted = await post('runs').send(event()).expect(201);
    const claimed = await post('runs/claim').send({ owner: 'worker' }).expect(200);
    const run = await storage.prepareExecution(tenantId, claimed.body.fence, Date.now());
    await models.ChannelRun.updateOne(
      { tenantId, runId: run.runId },
      {
        $set: { execution: { ...run.execution, protocol: 'responses', responseId: 'response-1' } },
      },
    );
    const route = `runs/${admitted.body.runId}/yield`;
    await request(app)
      .post(`/service/channel/${route}`)
      .send({ fence: claimed.body.fence })
      .expect(401);
    await post(route)
      .send({ fence: { ...claimed.body.fence, runId: 'foreign' } })
      .expect(400);
    await post(route)
      .send({ fence: { ...claimed.body.fence, owner: 'foreign' } })
      .expect(409);
    const yieldSpy = jest.spyOn(storage, 'yieldLease');
    acl.set(users[0].id, 0);
    await post(route).send({ fence: claimed.body.fence }).expect(403);
    expect(yieldSpy).not.toHaveBeenCalled();
    yieldSpy.mockRestore();
  }),
);

it(
  'acknowledges a safe polling yield without invoking an Agent or releasing its lane',
  scoped(async () => {
    await link('U1', users[0]);
    const admitted = await post('runs').send(event()).expect(201);
    const claimed = await post('runs/claim').send({ owner: 'worker' }).expect(200);
    const run = await storage.prepareExecution(tenantId, claimed.body.fence, Date.now());
    await models.ChannelRun.updateOne(
      { tenantId, runId: run.runId },
      {
        $set: { execution: { ...run.execution, protocol: 'responses', responseId: 'response-1' } },
      },
    );
    const route = `runs/${admitted.body.runId}/yield`;
    await post(route).send({ fence: claimed.body.fence }).expect(204);
    await post(route).send({ fence: claimed.body.fence }).expect(409);
    expect((await storage.read(tenantId, 'channel', run.runId))?.leaseOwner).toBeUndefined();
    expect(invoked).toHaveLength(0);
    const lane = await models.ChannelLane.findOne({ tenantId, laneId: run.laneId }).lean();
    expect(lane?.activeRunId).toBe(run.runId);
  }),
);
async function link(actor: string, user: IUser) {
  const channel = (await db.getAgentChannel('channel'))!;
  const identity = channelExternalIdentity(channel, actor);
  const issued = value(await authority.identity.issue(identity));
  const ticket = new URL(issued.url).hash.slice(1);
  const principal = { tenantId, userId: user.id, accountLabel: user.name! };
  const preview = value(await authority.identity.preview(principal, ticket));
  const accepted = value(await authority.identity.accept(principal, ticket, preview.revision));
  return value(await authority.identity.confirm(identity, accepted.linkId, accepted.revision));
}

it(
  'routes same-thread A and B to their own linked principals and independent histories through actual service handlers',
  scoped(async () => {
    await link('U1', users[0]);
    await post('runs').send(event('U2')).expect(403);
    await link('U2', users[1]);
    const a = await post('runs').send(event()).expect(201);
    const b = await post('runs').send(event('U2')).expect(201);
    const claimedA = await post('runs/claim').send({ owner: 'worker-A' }).expect(200);
    await post(`runs/${a.body.runId}/advance`).send({ fence: claimedA.body.fence }).expect(200);
    const claimedB = await post('runs/claim').send({ owner: 'worker-B' }).expect(200);
    await post(`runs/${b.body.runId}/advance`).send({ fence: claimedB.body.fence }).expect(200);
    expect(invoked.map((run) => run.principal.userId)).toEqual([users[0].id, users[1].id]);
    expect(invoked[0].execution?.conversationId).not.toBe(invoked[1].execution?.conversationId);
    expect(invoked[1].execution?.parentMessageId).toBe('00000000-0000-0000-0000-000000000000');
    expect(await storage.requestCancel(tenantId, 'channel', a.body.runId, 'U2')).toBe(false);
  }),
);

it(
  'accepts cancel only from the original actor with its current account link and channel revision',
  scoped(async () => {
    const linked = await link('U1', users[0]);
    await link('U2', users[0]);
    const admitted = await post('runs').send(event()).expect(201);
    const path = `runs/${admitted.body.runId}/cancel`;
    await post(path)
      .send({ actor: event('U2').actor, revision: 'revision-1' })
      .expect(403);
    await post(path).send({ actor: event().actor, revision: 'old' }).expect(403);
    expect(
      (await storage.read(tenantId, 'channel', admitted.body.runId))?.cancellationRequested,
    ).toBe(false);
    await post(path).send({ actor: event().actor, revision: 'revision-1' }).expect(202);
    expect(
      (await storage.read(tenantId, 'channel', admitted.body.runId))?.cancellationRequested,
    ).toBe(true);
    value(
      await authority.identity.revoke(
        { tenantId, userId: users[0].id, accountLabel: 'A' },
        linked.linkId,
        linked.revision,
      ),
    );
    await post(path).send({ actor: event().actor, revision: 'revision-1' }).expect(403);
  }),
);

it(
  'shared mode is deny-by-default owner-only and never falls back to creator authority for B',
  scoped(async () => {
    await db.updateAgentChannel('channel', users[0].id, { credentialMode: 'shared' });
    await link('U1', users[0]);
    await expect(link('U2', users[1])).rejects.toThrow('forbidden');
    await post('runs').send(event('U2')).expect(403);
    await post('runs')
      .send({ ...event('U2'), principal: { userId: users[0].id } })
      .expect(400);
    await post('runs').send(event()).expect(201);
  }),
);

it(
  'rechecks link revocation and current ACL before execution, not only at admission',
  scoped(async () => {
    const linked = await link('U1', users[0]);
    const admitted = await post('runs').send(event()).expect(201);
    const claimed = await post('runs/claim').send({ owner: 'worker' }).expect(200);
    acl.set(users[0].id, 0);
    await post(`runs/${admitted.body.runId}/advance`)
      .send({ fence: claimed.body.fence })
      .expect(403);
    expect((await storage.read(tenantId, 'channel', admitted.body.runId))?.state).toBe('cancelled');
    acl.set(users[0].id, PermissionBits.VIEW);
    const next = await post('runs').send(event('U1', 'after-acl-restored')).expect(201);
    const nextClaim = await post('runs/claim').send({ owner: 'worker' }).expect(200);
    value(
      await authority.identity.revoke(
        { tenantId, userId: users[0].id, accountLabel: 'A' },
        linked.linkId,
        linked.revision,
      ),
    );
    await post(`runs/${next.body.runId}/advance`).send({ fence: nextClaim.body.fence }).expect(403);
    expect(invoked).toHaveLength(0);
  }),
);

it(
  'revalidates channel source authority at queued dispatch and rejects changed principal, cancellation and revocation',
  scoped(async () => {
    const linked = await link('U1', users[0]);
    const channel = (await db.getAgentChannel('channel'))!;
    const principal = (await authority.resolvePrincipal(channel, event().actor))!;
    await storage.admit(
      { tenantId, channelId: 'channel', agentId: 'agent', principal, admission: event() },
      Date.now(),
    );
    const claimed = (await storage.claim(tenantId, 'channel', 'worker', Date.now(), 60_000))!;
    const run = await storage.prepareExecution(
      tenantId,
      { runId: claimed.runId, owner: 'worker', epoch: claimed.leaseEpoch },
      Date.now(),
    );
    const envelope = createAgentTriggerEnvelope({
      mode: 'fire',
      requestId: run.execution!.requestId,
      deliveryId: run.runId,
      receivedAt: run.receivedAt,
      principal: { id: users[0].id, tenantId },
      input: run.admission.input,
      target: { agentId: 'agent' },
      run: { conversationId: run.execution!.conversationId },
      event: {
        id: run.runId,
        type: 'message',
        occurredAt: run.receivedAt,
        source: { type: 'channel', id: 'channel' },
      },
    });
    await expect(authority.authorizeTrigger(envelope)).resolves.toBeUndefined();
    await expect(
      authority.authorizeTrigger({ ...envelope, principal: { userId: users[1].id, tenantId } }),
    ).rejects.toMatchObject({ code: 'CHANNEL_AUTHORITY_CHANGED' });
    await storage.requestCancel(tenantId, 'channel', run.runId, 'U1');
    await expect(authority.authorizeTrigger(envelope)).rejects.toMatchObject({
      code: 'CHANNEL_AUTHORITY_CHANGED',
    });
    value(
      await authority.identity.revoke(
        { tenantId, userId: users[0].id, accountLabel: 'A' },
        linked.linkId,
        linked.revision,
      ),
    );
    await expect(authority.authorizeTrigger(envelope)).rejects.toMatchObject({
      code: 'CHANNEL_AUTHORITY_CHANGED',
    });
  }),
);

it(
  'retires revoked queued work without exposing its view, then admits the next actor lane',
  scoped(async () => {
    const linked = await link('U1', users[0]);
    await link('U2', users[1]);
    const a = await post('runs').send(event()).expect(201);
    const b = await post('runs').send(event('U2')).expect(201);
    value(
      await authority.identity.revoke(
        { tenantId, userId: users[0].id, accountLabel: 'A' },
        linked.linkId,
        linked.revision,
      ),
    );
    await post('runs/claim').send({ owner: 'cleanup-worker' }).expect(204);
    expect(retired).toHaveLength(1);
    expect(retired[0]).toMatchObject({
      runId: a.body.runId,
      cancellationRequested: true,
      errorCode: 'channel_authority_changed',
    });
    expect(retired[0].execution).toBeUndefined();
    expect((await storage.read(tenantId, 'channel', a.body.runId))?.state).toBe('cancelled');
    const next = await post('runs/claim').send({ owner: 'next-worker' }).expect(200);
    expect(next.body.run.runId).toBe(b.body.runId);
    expect(invoked).toHaveLength(0);
  }),
);

it(
  'requires the exact worker fence for cleanup, never another actor action, and latches authority loss',
  scoped(async () => {
    await link('U1', users[0]);
    await link('U2', users[0]);
    const admitted = await post('runs').send(event()).expect(201);
    const claimed = await post('runs/claim').send({ owner: 'worker' }).expect(200);
    acl.set(users[0].id, 0);
    await post(`runs/${admitted.body.runId}/cancel`)
      .send({ actor: event('U2').actor, revision: 'revision-1' })
      .expect(403);
    await post(`runs/${admitted.body.runId}/advance`)
      .send({ fence: { ...claimed.body.fence, owner: 'other-worker' } })
      .expect(409);
    expect(retired).toHaveLength(0);
    retirement = 'pending';
    await post(`runs/${admitted.body.runId}/advance`)
      .send({ fence: claimed.body.fence })
      .expect(403);
    expect((await storage.read(tenantId, 'channel', admitted.body.runId))?.state).toBe('queued');
    acl.set(users[0].id, PermissionBits.VIEW);
    retirement = 'stopped';
    await post(`runs/${admitted.body.runId}/advance`)
      .send({ fence: claimed.body.fence })
      .expect(403);
    expect((await storage.read(tenantId, 'channel', admitted.body.runId))?.state).toBe('cancelled');
    expect(invoked).toHaveLength(0);
  }),
);

it(
  'does not turn a permission lookup outage into revocation or cleanup',
  scoped(async () => {
    await link('U1', users[0]);
    const admitted = await post('runs').send(event()).expect(201);
    const claimed = await post('runs/claim').send({ owner: 'worker' }).expect(200);
    const lookup = jest
      .spyOn(db, 'getAgentChannel')
      .mockRejectedValueOnce(new Error('database unavailable'));
    await post(`runs/${admitted.body.runId}/advance`)
      .send({ fence: claimed.body.fence })
      .expect(503);
    lookup.mockRestore();
    expect(retired).toHaveLength(0);
    expect(await storage.read(tenantId, 'channel', admitted.body.runId)).toMatchObject({
      cancellationRequested: false,
      state: 'queued',
    });
    await post(`runs/${admitted.body.runId}/advance`)
      .send({ fence: claimed.body.fence })
      .expect(200);
  }),
);

it(
  'rejects wrong workspace/app, foreign tenant and unauthenticated admission',
  scoped(async () => {
    await link('U1', users[0]);
    const forged = event();
    forged.actor.teamId = 'T2';
    await post('runs').send(forged).expect(403);
    await request(app).post('/service/channel/runs').send(event()).expect(401);
    await request(app)
      .post('/service/channel/runs')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Id', 'other')
      .send(event())
      .expect(404);
    expect(invoked).toHaveLength(0);
  }),
);

it(
  'reauthorizes after artifact retrieval and never sends bytes after link revocation',
  scoped(async () => {
    const linked = await link('U1', users[0]);
    await post('runs').send(event()).expect(201);
    const claimed = await post('runs/claim').send({ owner: 'worker' }).expect(200);
    const fence = claimed.body.fence;
    const run = await storage.prepareExecution(tenantId, fence, Date.now());
    const file = await db.publishRunArtifactFile({
      scope: {
        userId: users[0].id,
        tenantId,
        conversationId: run.execution!.conversationId,
        runId: 'response',
        executionId: 'execution',
        agentId: 'agent',
        sourceFileId: 'source',
      },
      provenance: {
        runId: 'response',
        executionId: 'execution',
        agentId: 'agent',
        sourceFileId: 'source',
        publishedAt: new Date().toISOString(),
        inputFileIds: [],
      },
      file: {
        filename: 'result.txt',
        filepath: '/synthetic/result.txt',
        bytes: 4,
        type: 'text/plain',
        source: FileSources.local,
      },
    });
    const sha256 = createHash('sha256').update('file').digest('hex');
    const descriptor = {
      artifactId: `${file.file_id}:${sha256}`,
      filename: 'result.txt',
      mediaType: 'text/plain',
      bytes: 4,
      sha256,
    };
    await storage.saveSnapshot(
      tenantId,
      fence,
      {
        status: 'completed',
        responseId: 'response',
        text: 'answer',
        elapsedMs: 1,
        artifacts: [descriptor],
      },
      Date.now(),
    );
    artifactRead = async () => {
      value(
        await authority.identity.revoke(
          { tenantId, userId: users[0].id, accountLabel: 'A' },
          linked.linkId,
          linked.revision,
        ),
      );
    };
    const response = await post(
      `runs/${run.runId}/artifacts/${encodeURIComponent(descriptor.artifactId)}`,
    )
      .send({ fence })
      .expect(403);
    expect(response.body).toEqual({ error: 'channel_authority_changed' });
    expect(response.headers['x-artifact-sha256']).toBeUndefined();
    expect((await storage.read(tenantId, 'channel', run.runId))?.state).toBe('cancelled');
  }),
);

it(
  'fences browser review and generation resume to the original live actor link and exact execution',
  scoped(async () => {
    const linked = await link('U1', users[0]);
    await link('U2', users[0]);
    const channel = (await db.getAgentChannel('channel'))!;
    const principal = (await authority.resolvePrincipal(channel, event().actor))!;
    await storage.admit(
      { tenantId, channelId: 'channel', agentId: 'agent', principal, admission: event() },
      Date.now(),
    );
    const claimed = (await storage.claim(tenantId, 'channel', 'worker', Date.now(), 60_000))!;
    const fence = { runId: claimed.runId, owner: 'worker', epoch: claimed.leaseEpoch };
    const run = await storage.prepareExecution(tenantId, fence, Date.now());
    await mongoose.models.ChannelRun.updateOne(
      { tenantId, runId: run.runId },
      {
        $set: {
          'execution.deliveryKey': 'delivery-key',
          'execution.enqueueAttemptedAt': Date.now(),
        },
      },
    );
    const input = {
      channelExecution: { channelId: 'channel', runId: run.runId },
      userId: users[0].id,
      tenantId,
      conversationId: run.execution!.conversationId,
      agentId: 'agent',
      clientRequestId: 'delivery-key',
    };
    expect(await authority.authorizeGeneration(input)).toBe(true);
    expect(
      await admitChannelGeneration(
        { ...input, isAgentTrigger: true },
        authority.authorizeGeneration,
      ),
    ).toEqual({ ok: true, channelExecution: input.channelExecution });
    expect(
      await authority.authorizeGeneration({
        ...input,
        channelExecution: { channelId: { $ne: '' }, runId: run.runId },
      }),
    ).toBe(false);
    expect(
      await authority.authorizeGeneration({ ...input, clientRequestId: 'different-delivery' }),
    ).toBe(false);
    const epoch = Date.now();
    await storage.saveSnapshot(
      tenantId,
      fence,
      {
        status: 'requires_action',
        text: '',
        elapsedMs: 1,
        pendingAction: {
          actionId: 'action',
          kind: 'tool_approval',
          expiresAt: Date.now() + 60_000,
        },
      },
      Date.now(),
      epoch,
    );
    const job = {
      createdAt: epoch,
      metadata: {
        userId: users[0].id,
        tenantId,
        conversationId: input.conversationId,
        agent_id: 'agent',
        idempotencyClientRequestId: 'delivery-key',
        channelExecution: input.channelExecution,
      },
    };
    expect(await authority.authorizeResume({ job, userId: users[0].id, tenantId })).toBe(true);
    expect(
      await authority.authorizeResume({
        job: { ...job, createdAt: epoch + 1 },
        userId: users[0].id,
        tenantId,
      }),
    ).toBe(false);
    expect(await authority.authorizeResume({ job, userId: users[1].id, tenantId })).toBe(false);
    const path = `runs/${run.runId}/review`;
    await post(path)
      .send({ actor: event('U2').actor, revision: 'revision-1' })
      .expect(403);
    const review = await post(path)
      .send({ actor: event().actor, revision: 'revision-1' })
      .expect(200);
    expect(review.body.url).toBe(`http://127.0.0.1:3088/c/${input.conversationId}`);
    value(
      await authority.identity.revoke(
        { tenantId, userId: users[0].id, accountLabel: 'A' },
        linked.linkId,
        linked.revision,
      ),
    );
    expect(await authority.authorizeResume({ job, userId: users[0].id, tenantId })).toBe(false);
    await post(path).send({ actor: event().actor, revision: 'revision-1' }).expect(403);
  }),
);

it('ignores untrusted browser metadata and absent trigger markers without invoking authority', async () => {
  const authorize = jest.fn(async () => true);
  const input = {
    channelExecution: { channelId: 'channel', runId: 'run' },
    userId: 'user',
    tenantId,
    conversationId: 'conversation',
    agentId: 'agent',
    clientRequestId: 'request',
  };
  for (const isAgentTrigger of [false, undefined, null, 'true', 1]) {
    expect(await admitChannelGeneration({ ...input, isAgentTrigger }, authorize)).toEqual({
      ok: true,
    });
  }
  for (const channelExecution of [undefined, null]) {
    expect(
      await admitChannelGeneration({ ...input, isAgentTrigger: true, channelExecution }, authorize),
    ).toEqual({ ok: true });
  }
  expect(authorize).not.toHaveBeenCalled();
});

it('rejects malformed trusted markers before any authority lookup and returns safe denied/unavailable results', async () => {
  const authorize = jest.fn(async () => true);
  const input = {
    isAgentTrigger: true,
    channelExecution: { channelId: 'channel', runId: 'run' },
    userId: 'user',
    tenantId,
    conversationId: 'conversation',
    agentId: 'agent',
    clientRequestId: 'request',
  };
  const denied = {
    ok: false,
    status: 403,
    body: { code: 'CHANNEL_AUTHORITY_CHANGED', error: 'Channel authority is no longer valid.' },
  };
  for (const channelExecution of [
    false,
    [],
    '',
    { channelId: 'channel' },
    { channelId: { $ne: '' }, runId: 'run' },
    { channelId: 'channel', runId: { $gt: '' } },
    { channelId: 'channel', runId: 'run', userId: 'foreign' },
    { channelId: '../channel', runId: 'run' },
  ]) {
    expect(await admitChannelGeneration({ ...input, channelExecution }, authorize)).toEqual(denied);
  }
  expect(authorize).not.toHaveBeenCalled();
  authorize.mockResolvedValueOnce(false);
  expect(await admitChannelGeneration(input, authorize)).toEqual(denied);
  authorize.mockRejectedValueOnce(new Error('private database selector diagnostic'));
  expect(await admitChannelGeneration(input, authorize)).toEqual({
    ok: false,
    status: 503,
    body: { code: 'CHANNEL_AUTHORITY_UNAVAILABLE', error: 'Channel authority is unavailable.' },
  });
  expect(await admitChannelGeneration(input, authorize)).toEqual({
    ok: true,
    channelExecution: input.channelExecution,
  });
  expect(authorize).toHaveBeenLastCalledWith({
    channelExecution: input.channelExecution,
    userId: input.userId,
    tenantId,
    conversationId: input.conversationId,
    agentId: input.agentId,
    clientRequestId: input.clientRequestId,
  });
});
