import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { PermissionBits, FileSources, RetentionMode } from 'librechat-data-provider';
import {
  createModels,
  createMethods,
  createResponseStorage,
  tenantStorage,
  runAsSystem,
  AGENT_TRIGGER_WORKER_CAPABILITY_RESPONSES_RESUME_V1,
} from '@librechat/data-schemas';
import type { AppConfig, IUser, ResponseStorage } from '@librechat/data-schemas';
import type { RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AgentTriggerDeliveryPersistence } from '../triggers/service';
import type { AgentExecutionEnrollment } from '../remote/lifecycle';
import type { BackgroundResponsesHostDependencies } from './host';
import type { ApiKeyAuthRequest } from '~/apiKeys/middleware';
import type { ServerRequest } from '~/types/http';
import {
  buildAggregatedResponse,
  createResponseAggregator,
  createResponseContext,
} from './service';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { createCheckpointNamespace } from '~/stream/checkpoints';
import { createAgentTriggerService } from '../triggers/service';
import { createRequireApiKeyAuth } from '~/apiKeys/middleware';
import { buildPendingBackgroundResponse } from './background';
import { mintBackgroundResponseWorkerToken } from './worker';
import { enrollAgentExecution } from '../remote/lifecycle';
import { createResponseExecutionRuntime } from './runtime';
import { createBackgroundResponsesHost } from './host';
import { getSafeErrorMetadata } from '~/utils/errors';
import { createAgentRunEnvelope } from '../envelope';
import { buildPendingAction } from '../hitl/policy';
import { executeAgentRun } from '../remote/host';
import { GenerationJobManager } from '~/stream';

let mongo: MongoMemoryReplSet;
let db: ReturnType<typeof createMethods>;
let storage: ResponseStorage;
let user: IUser;
const tenantId = 'responses-host-test';
const scoped = <T>(work: () => Promise<T>) => tenantStorage.run({ tenantId }, work);
const cleanup: Array<() => Promise<void>> = [];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ args: ['--nounixsocket'] }],
  });
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  createModels(mongoose);
  db = createMethods(mongoose);
  storage = createResponseStorage(mongoose);
});
beforeEach(async () => {
  await runAsSystem(async () => {
    await Promise.all(
      [
        'StoredResponse',
        'ResponseScope',
        'AgentTriggerDelivery',
        'AgentTriggerLaneSequence',
        'AgentTriggerUserPurge',
        'AgentApiKey',
        'User',
      ].map((name) => mongoose.models[name].deleteMany({})),
    );
  });
  user = await scoped(async () =>
    mongoose.models.User.create({
      email: 'response-host@example.test',
      name: 'Response test',
      role: 'USER',
      provider: 'local',
      tenantId,
    }),
  );
  GenerationJobManager.configure({
    jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
    eventTransport: new InMemoryEventTransport(),
    cleanupOnComplete: false,
  });
  GenerationJobManager.initialize();
});
afterEach(async () => {
  await GenerationJobManager.destroy();
  while (cleanup.length) await cleanup.pop()!();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

function persistence(): AgentTriggerDeliveryPersistence {
  return {
    ...db,
    getAgentTriggerDeliveryBatch: (delivery) =>
      db.getAgentTriggerDeliveryBatch({
        id: delivery.id,
        batchMemberIds: delivery.batchMemberIds?.map(
          (id) => new mongoose.Types.ObjectId(String(id)),
        ),
      }),
  };
}

async function fixture(
  decisions?: BackgroundResponsesHostDependencies['decisions'],
  interactive?: BackgroundResponsesHostDependencies['interactive'],
) {
  const config: AppConfig = {
    config: {},
    fileStrategy: FileSources.local,
    imageOutputType: 'png',
    endpoints: {
      agents: { remoteApi: { background: { enabled: true, acknowledgementTimeoutMs: 1000 } } },
    },
  };
  const errors: unknown[] = [];
  const inputs: unknown[] = [];
  let browserUser: IUser | undefined = user;
  let browserMode: 'owner' | 'trigger' | 'key' = 'owner';
  let generate = async (
    _signal: AbortSignal,
    _context: { streamId: string | null; jobCreatedAt?: number },
    _execution: AgentExecutionEnrollment,
  ) => '# Real Responses lifecycle';
  const host = createBackgroundResponsesHost({
    decisions,
    interactive,
    storage,
    jobs: GenerationJobManager,
    publicBaseURL: 'https://agents.example',
    findUser: (id) => db.findUser({ _id: id }),
    getKey: db.getAgentApiKeyById,
    getRole: async () =>
      new mongoose.models.Role({ name: 'USER', permissions: { REMOTE_AGENTS: { USE: true } } }),
    getConfig: async () => config,
    isPrincipalActive: async () => true,
    getAgentPermissions: async (agentId) => (agentId === 'agent' ? PermissionBits.VIEW : 0),
    getMessage: db.getMessage,
    getConvoRetention: db.getConvoRetention,
    enqueue: (...args) => service.enqueue(...args),
    signingSecret: () => 'isolated-background-host-secret',
    onError: (error) => {
      errors.push(error);
    },
  });
  const apiKeyAuth = createRequireApiKeyAuth({
    validateAgentApiKey: db.validateAgentApiKey,
    findUser: db.findUser,
    isPrincipalActive: async () => true,
    enrollmentRequired: () => false,
  });
  const handlers = host.handlers({
    create: async (req, res) => {
      const current = (req as ServerRequest).user!;
      const envelope = createAgentRunEnvelope({
        protocol: 'responses',
        requestId: 'http-request',
        receivedAt: Date.now(),
        principal: { id: current.id, tenantId: current.tenantId },
        payload: req.body,
      });
      const runtime = createResponseExecutionRuntime(req, res, {
        getMessage: db.getMessage,
        jobs: GenerationJobManager,
      });
      const continuation = await runtime.resolveContinuation(envelope);
      await executeAgentRun({
        envelope,
        runId: runtime.responseId,
        conversationId: continuation.conversationId,
        connection: runtime.connection,
        ...runtime.hooks,
        isPrincipalActive: async () => true,
        execute: async (execution) => {
          inputs.push(envelope.payload);
          const text = await generate(execution.signal, runtime.toolContext(execution), execution);
          const aggregator = createResponseAggregator();
          aggregator.addText(text);
          res.json({
            ...buildAggregatedResponse(
              createResponseContext(envelope.payload, runtime.responseId),
              aggregator,
            ),
            store: true,
          });
        },
        handleExecutionError: () => {
          res.status(409).json({ error: { code: 'execution_failed' } });
        },
        onSettlementError: (error) => {
          errors.push(error);
        },
      });
    },
    retrieve: (_req, res) => {
      res.status(404).json({ error: { code: 'ordinary_response_not_found' } });
    },
  });
  const app = express();
  app.use(express.json());
  const browserAuth: RequestHandler = (req, _res, next) => {
    Object.assign(req, {
      user: browserUser,
      _isAgentTrigger: browserMode === 'trigger',
      apiKeyId: browserMode === 'key' ? 'execution-key' : undefined,
    });
    next();
  };
  app.get('/api/agents/responses/:id/review', browserAuth, host.review);
  app.post('/api/agents/responses/:id/review', browserAuth, host.submitReview);
  app.post('/api/agents/responses/:id/cancel', browserAuth, host.cancelReview);
  app.use((_req, _res, next) => {
    tenantStorage.run({ tenantId }, async () => {
      next();
    });
  });
  const router = express.Router();
  router.use(
    host.authenticate(async (req, res, next) => {
      await apiKeyAuth(req as ApiKeyAuthRequest, res, next);
    }),
  );
  router.post('/', handlers.create);
  router.get('/:id', handlers.retrieve);
  router.post('/:id/cancel', handlers.cancel);
  app.use('/api/agents/v1/responses', router);
  const server: Server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  cleanup.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  host.initialize(server.address());
  const service = createAgentTriggerService({
    methods: persistence(),
    sourceDispatchers: host.sourceDispatchers,
    deliveryOptions: { tickMs: 10 },
  });
  await service.initialize({ address: server.address() });
  cleanup.push(() => service.stop());
  const credential = await scoped(async () =>
    db.createAgentApiKey({ userId: user._id, name: 'background-test' }),
  );
  const client = request(server);
  async function readUntil(id: string, status: string) {
    let observed: { httpStatus: number; status?: string; errorCode?: string } | undefined;
    const failure = () =>
      new Error(
        `Response did not reach ${status}: ${JSON.stringify({
          observed,
          executions: inputs.length,
          workerErrors: errors.map(getSafeErrorMetadata),
        })}`,
      );
    for (let attempt = 0; attempt < 150; attempt++) {
      const response = await client
        .get(`/api/agents/v1/responses/${id}`)
        .auth(credential.key, { type: 'bearer' });
      observed = {
        httpStatus: response.status,
        status: response.body.status,
        errorCode: response.body.error?.code,
      };
      if (response.body.status === status) return response;
      if (['completed', 'failed', 'cancelled', 'incomplete'].includes(response.body.status)) {
        throw failure();
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw failure();
  }
  return {
    host,
    client,
    credential,
    inputs,
    config,
    errors,
    readUntil,
    setBrowserUser: (value?: IUser) => {
      browserUser = value;
    },
    setBrowserMode: (value: typeof browserMode) => {
      browserMode = value;
    },
    setGenerate: (value: typeof generate) => {
      generate = value;
    },
  };
}

async function ownerPause(keyId: string) {
  return scoped(async () => {
    const owner = { userId: String(user._id), tenantId };
    const id = 'resp_owner_review';
    const execution = await enrollAgentExecution({
      runId: id,
      ...owner,
      agentId: 'agent',
      conversationId: 'review-conversation',
      protocol: 'responses',
      isPrincipalActive: async () => true,
    });
    const reserved = await storage.reserve({
      ...owner,
      responseId: id,
      sourceKeyId: keyId,
      agentId: 'agent',
      requestKey: id,
      fingerprint: id,
      conversationId: 'review-conversation',
      parentMessageId: 'root',
      requestJSON: '{"model":"agent","input":"Question","background":true,"store":true}',
    });
    if (!reserved.ok) throw new Error('Review reservation failed');
    const body = JSON.stringify({
      ...buildPendingBackgroundResponse(reserved.record),
      status: 'in_progress',
    });
    await storage.publish(owner, id, 0, {
      status: 'in_progress',
      generationCreatedAt: execution.createdAt,
      responseJSON: body,
    });
    await execution.beginProviderExecution();
    const job = (await GenerationJobManager.getJob(id))!;
    const action = buildPendingAction(
      { type: 'ask_user_question', question: { question: 'Choose an environment' } },
      {
        streamId: id,
        responseMessageId: id,
        conversationId: 'review-conversation',
        threadId: 'review-conversation',
        ttlMs: 60000,
      },
    );
    expect(
      await execution.pauseForReview(action, async () => {
        const published = await storage.publishReview(
          owner,
          id,
          1,
          execution.createdAt,
          {
            actionId: action.actionId,
            providerExecutionId: job.metadata.providerExecutionId!,
            expiresAt: action.expiresAt!,
            partialResponseJSON: body,
            pendingActionJSON: JSON.stringify(action),
          },
          body,
        );
        if (!published.ok) throw new Error('Review publication failed');
      }),
    ).toBe(true);
    await execution.settle();
    return { id, action, owner };
  });
}

it('requires owner browser authentication and leaves submission closed without an installed validator/queue', async () => {
  const f = await fixture();
  const path = '/api/agents/responses/anything/review';
  const closed = await f.client
    .post(path)
    .send({ actionId: 'action', answer: 'staging' })
    .expect(503);
  expect(closed.body).toEqual({ error: 'response_decision_unavailable' });
  expect(closed.headers['cache-control']).toBe('no-store');
  f.setBrowserUser(undefined);
  await f.client.post(path).send({}).expect(401);
  f.setBrowserUser(user);
  for (const mode of ['trigger', 'key'] as const) {
    f.setBrowserMode(mode);
    await f.client.post(path).send({}).expect(401);
    await f.client.get(path).expect(401);
  }
});

it('submits an owner decision through HTTP once, rechecks the source key, and never executes from the control route', async () => {
  const queued: string[] = [];
  const validate = jest.fn(async () => true);
  const f = await fixture({
    validate,
    enqueue: async (record) => {
      queued.push(record.resume!.intentId);
    },
  });
  const { id, action, owner } = await ownerPause(f.credential.id);
  const path = `/api/agents/responses/${id}/review`;
  for (const other of [
    new mongoose.models.User({ ...user.toObject(), _id: new mongoose.Types.ObjectId() }),
    new mongoose.models.User({ ...user.toObject(), tenantId: 'another-tenant' }),
  ]) {
    f.setBrowserUser(other);
    await f.client.post(path).send({ actionId: action.actionId, answer: 'staging' }).expect(404);
  }
  expect(validate).not.toHaveBeenCalled();
  f.setBrowserUser(user);
  const first = await f.client
    .post(path)
    .send({ actionId: action.actionId, answer: 'staging' })
    .expect(202);
  const again = await f.client
    .post(path)
    .send({ answer: 'staging', actionId: action.actionId })
    .expect(202);
  expect(again.body).toEqual(first.body);
  expect(first.body).toMatchObject({ responseId: id, actionId: action.actionId, status: 'queued' });
  expect(JSON.stringify(first.body)).not.toContain('staging');
  expect(new Set(queued)).toEqual(new Set([first.body.intentId]));
  expect((await GenerationJobManager.getJob(id))?.status).toBe('requires_action');
  expect(f.inputs).toEqual([]);
  await f.client
    .post(path)
    .send({ actionId: action.actionId, answer: 'staging', userId: 'another-owner' })
    .expect(400);
  await scoped(() => db.deleteAgentApiKey(f.credential.id, user._id));
  await f.client.post(path).send({ actionId: action.actionId, answer: 'staging' }).expect(404);
  expect(queued).toHaveLength(2);
  expect((await scoped(() => storage.read(owner, id)))?.resume?.intentId).toBe(first.body.intentId);
});

it('denies owner review and first decision after the paused original source key is revoked', async () => {
  const validate = jest.fn(async () => true);
  const enqueue = jest.fn(async () => {});
  const f = await fixture({ validate, enqueue });
  const { id, action, owner } = await ownerPause(f.credential.id);
  const path = `/api/agents/responses/${id}/review`;
  await scoped(() => db.deleteAgentApiKey(f.credential.id, user._id));

  await f.client.get(path).expect(404);
  await f.client.post(path).send({ actionId: action.actionId, answer: 'staging' }).expect(404);

  expect(validate).not.toHaveBeenCalled();
  expect(enqueue).not.toHaveBeenCalled();
  expect(f.inputs).toEqual([]);
  const retained = await scoped(() => storage.read(owner, id));
  expect(retained?.status).toBe('requires_action');
  expect(retained?.resume).toBeUndefined();
  expect((await GenerationJobManager.getJob(id))?.status).toBe('requires_action');
});

it('reuses canonical decision receipts and source preflight for a trusted native transport without browser tokens', async () => {
  const queued: string[] = [];
  const f = await fixture({
    validate: async () => true,
    enqueue: async (record) => {
      queued.push(record.resume!.intentId);
    },
  });
  const { id, action, owner } = await ownerPause(f.credential.id);
  const view = await scoped(() => f.host.readInteractiveReview(owner, id));
  expect(view?.pendingAction?.actionId).toBe(action.actionId);
  expect(view?.oauth).toEqual([]);
  for (const other of [
    { ...owner, userId: 'another-user' },
    { ...owner, tenantId: 'another-tenant' },
  ]) {
    expect(await f.host.readInteractiveReview(other, id)).toBeNull();
    expect(
      await f.host.submitInteractiveReview(other, id, { actionId: action.actionId, answer: 'yes' }),
    ).toMatchObject({ ok: false, status: 404 });
  }
  const input = { actionId: action.actionId, answer: 'yes' };
  const first = await scoped(() => f.host.submitInteractiveReview(owner, id, input));
  expect(first).toMatchObject({ ok: true, receipt: { responseId: id, actionId: action.actionId } });
  expect(await scoped(() => f.host.submitInteractiveReview(owner, id, input))).toEqual(first);
  expect(
    await scoped(() => f.host.submitInteractiveReview(owner, id, { ...input, answer: 'changed' })),
  ).toMatchObject({ ok: false, status: 409 });
  expect(new Set(queued).size).toBe(1);
  expect(f.inputs).toEqual([]);
  await scoped(() => db.deleteAgentApiKey(f.credential.id, user._id));
  expect(await scoped(() => f.host.readInteractiveReview(owner, id))).toBeNull();
  expect(await scoped(() => f.host.submitInteractiveReview(owner, id, input))).toMatchObject({
    ok: false,
    status: 404,
  });
});

it('registers only resume-capable initial/resume workers and dispatches saved intent through signed Responses ingress', async () => {
  const admitResume = jest.fn<
    ReturnType<NonNullable<BackgroundResponsesHostDependencies['interactive']>['admitResume']>,
    Parameters<NonNullable<BackgroundResponsesHostDependencies['interactive']>['admitResume']>
  >(async () => ({ ok: false, code: 'response_resume_unavailable' }));
  const validate = jest.fn(async () => true);
  const f = await fixture(undefined, { validate, admitResume });
  expect([...f.host.sourceDispatchers.keys()].sort()).toEqual(['responses', 'responses.resume']);
  for (const dispatcher of f.host.sourceDispatchers.values()) {
    expect(dispatcher.workerCapability).toBe(AGENT_TRIGGER_WORKER_CAPABILITY_RESPONSES_RESUME_V1);
  }
  const { id, action, owner } = await ownerPause(f.credential.id);
  const receipt = await f.client
    .post(`/api/agents/responses/${id}/review`)
    .send({ actionId: action.actionId, answer: 'staging' })
    .expect(202);
  for (let attempt = 0; attempt < 100 && !admitResume.mock.calls.length; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(validate).toHaveBeenCalledTimes(1);
  expect(admitResume).toHaveBeenCalled();
  const [record, authenticatedUser, intentId] = admitResume.mock.calls[0];
  expect(record.responseId).toBe(id);
  expect(record.resume?.decisionJSON).toBe(
    JSON.stringify({ actionId: action.actionId, answer: 'staging' }),
  );
  expect(String(authenticatedUser._id)).toBe(owner.userId);
  expect(intentId).toBe(receipt.body.intentId);
  expect(f.inputs).toEqual([]);
  expect((await GenerationJobManager.getJob(id))?.status).toBe('requires_action');
});

it('returns a safe retryable HTTP failure when queue publication fails after saving the owner decision', async () => {
  let calls = 0;
  const f = await fixture({
    validate: async () => true,
    enqueue: async () => {
      if (++calls === 1) throw new Error('private queue diagnostics');
    },
  });
  const { id, action, owner } = await ownerPause(f.credential.id);
  const path = `/api/agents/responses/${id}/review`;
  const failed = await f.client
    .post(path)
    .send({ actionId: action.actionId, answer: 'staging' })
    .expect(503);
  expect(failed.body).toEqual({ error: 'response_service_unavailable' });
  expect(JSON.stringify(failed.body)).not.toContain('private queue');
  const restored = await f.client.get(path).expect(200);
  expect(restored.body.canSubmitDecision).toBe(true);
  expect(restored.body.pendingDecision.decision).toEqual({
    actionId: action.actionId,
    answer: 'staging',
  });
  const native = await scoped(() => f.host.readInteractiveReview(owner, id));
  expect(native?.pendingDecision).toEqual(restored.body.pendingDecision);
  expect(native?.pendingAction?.actionId).toBe(action.actionId);
  const retry = await f.client.post(path).send(restored.body.pendingDecision.decision).expect(202);
  expect(retry.body.intentId).toBe(restored.body.pendingDecision.intentId);
  expect(calls).toBe(2);
  expect(f.errors).toHaveLength(1);
});

it('does not publish a completed response while its provider has durably paused for review', async () => {
  const f = await fixture();
  f.setGenerate(async (_signal, _context, execution) => {
    const job = await GenerationJobManager.getJob(execution.runId);
    if (!job?.metadata.conversationId) throw new Error('Missing admitted conversation');
    const action = buildPendingAction(
      { type: 'ask_user_question', question: { question: 'Which environment?' } },
      {
        streamId: execution.runId,
        responseMessageId: execution.runId,
        runId: execution.runId,
        conversationId: job.metadata.conversationId,
        threadId: job.metadata.conversationId,
        ttlMs: 60_000,
      },
    );
    const checkpointNamespace = createCheckpointNamespace(String(user._id), tenantId);
    await GenerationJobManager.getJobStore().updateJob(execution.runId, { checkpointNamespace });
    if (
      !(await execution.pauseForReview(action, async () => {
        const record = (await storage.read(
          { userId: String(user._id), tenantId },
          execution.runId,
        ))!;
        const published = await storage.publishReview(
          record,
          record.responseId,
          record.revision,
          execution.createdAt,
          {
            actionId: action.actionId,
            providerExecutionId: job.metadata.providerExecutionId!,
            expiresAt: action.expiresAt!,
            pendingActionJSON: JSON.stringify(action),
            partialResponseJSON: '{}',
            checkpointConfigJSON: JSON.stringify({
              type: 'mongo',
              checkpointCollectionName: 'responses_pause_checkpoints',
              checkpointWritesCollectionName: 'responses_pause_checkpoint_writes',
            }),
          },
          JSON.stringify({
            id: record.responseId,
            object: 'response',
            model: 'agent',
            status: 'in_progress',
            background: true,
            store: true,
            output: [],
            completed_at: null,
          }),
        );
        if (!published.ok) throw new Error('Pause journal publication failed');
        for (const name of ['responses_pause_checkpoints', 'responses_pause_checkpoint_writes']) {
          await mongoose.connection.db!.collection(name).insertMany([
            {
              thread_id: record.conversationId,
              checkpoint_ns: checkpointNamespace,
              checkpoint_id: 'paused-root',
            },
            {
              thread_id: record.conversationId,
              checkpoint_ns: `${checkpointNamespace}|child`,
              checkpoint_id: 'paused-child',
            },
            {
              thread_id: record.conversationId,
              checkpoint_ns: 'other-generation',
              checkpoint_id: 'keep-me',
            },
          ]);
        }
      }))
    )
      throw new Error('Pause admission failed');
    return 'This candidate must not become a completed public response.';
  });
  const created = await f.client
    .post('/api/agents/v1/responses')
    .auth(f.credential.key, { type: 'bearer' })
    .send({ model: 'agent', input: 'Ask a question', background: true, store: true })
    .expect(202);
  let job = await GenerationJobManager.getJob(created.body.id);
  for (
    let attempt = 0;
    attempt < 150 &&
    (job?.status !== 'requires_action' ||
      job.metadata.terminalPersistencePending !== false ||
      job.metadata.providerDrained !== true);
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    job = await GenerationJobManager.getJob(created.body.id);
  }
  expect(job).toMatchObject({
    status: 'requires_action',
    metadata: { providerDrained: true, terminalPersistencePending: false },
  });
  const observed = await f.client
    .get(`/api/agents/v1/responses/${created.body.id}`)
    .auth(f.credential.key, { type: 'bearer' })
    .expect(200);
  expect(observed.body).toMatchObject({
    status: 'in_progress',
    output: [],
    completed_at: null,
    required_action: { type: 'librechat_review', kind: 'question' },
  });
  expect(JSON.stringify(observed.body)).not.toContain('This candidate');
  expect(f.errors).toEqual([]);
  const cancelled = await f.client
    .post(`/api/agents/v1/responses/${created.body.id}/cancel`)
    .auth(f.credential.key, { type: 'bearer' })
    .send({})
    .expect(200);
  expect(cancelled.body).toMatchObject({ status: 'cancelled', output: [] });
  for (const name of ['responses_pause_checkpoints', 'responses_pause_checkpoint_writes']) {
    const rows = await mongoose.connection.db!.collection(name).find({}).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].checkpoint_id).toBe('keep-me');
  }
  expect(f.errors).toEqual([]);
});

it('serves OAuth secrets only to the authenticated current owner, never the API key caller', async () => {
  const f = await fixture();
  let finish: (value: string) => void = () => {};
  f.setGenerate(async (_signal, context) => {
    expect(context.streamId).toMatch(/^resp_/);
    expect(context.jobCreatedAt).toEqual(expect.any(Number));
    await GenerationJobManager.emitChunk(
      context.streamId!,
      {
        event: 'on_run_step',
        data: {
          id: 'oauth-step',
          runId: 'oauth-run',
          index: 0,
          stepDetails: {
            type: 'tool_calls',
            tool_calls: [{ id: 'oauth-call', name: 'oauth_mcp_example', args: '' }],
          },
        },
      },
      { expectedCreatedAt: context.jobCreatedAt },
    );
    await GenerationJobManager.emitChunk(
      context.streamId!,
      {
        event: 'on_run_step_delta',
        data: {
          id: 'oauth-step',
          delta: {
            type: 'tool_calls',
            tool_calls: [{ name: 'oauth_mcp_example', args: 'private-args' }],
            auth: 'https://oauth.example/authorize?state=private-state',
            expires_at: Date.now() + 60_000,
          },
        },
      },
      { expectedCreatedAt: context.jobCreatedAt },
    );
    return new Promise<string>((resolve) => {
      finish = resolve;
    });
  });
  try {
    const created = await f.client
      .post('/api/agents/v1/responses')
      .auth(f.credential.key, { type: 'bearer' })
      .send({ model: 'agent', input: 'Use a tool', background: true, store: true });
    const id = created.body.id;
    let observed = await f.readUntil(id, 'in_progress');
    for (let n = 0; n < 100 && !observed.body.required_action; n++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      observed = await f.client
        .get(`/api/agents/v1/responses/${id}`)
        .auth(f.credential.key, { type: 'bearer' });
    }
    expect(observed.body.required_action).toMatchObject({
      kind: 'oauth',
      review_url: `https://agents.example/responses/${id}/review`,
    });
    expect(JSON.stringify(observed.body)).not.toMatch(/private-|oauth.example|oauth_mcp_example/);
    const review = await f.client.get(`/api/agents/responses/${id}/review`);
    expect(review.status).toBe(200);
    expect(review.headers['cache-control']).toBe('no-store');
    expect(review.body.oauth).toEqual([
      expect.objectContaining({ authURL: 'https://oauth.example/authorize?state=private-state' }),
    ]);
    f.setBrowserUser(undefined);
    expect(
      (
        await f.client
          .get(`/api/agents/responses/${id}/review`)
          .auth(f.credential.key, { type: 'bearer' })
      ).status,
    ).toBe(401);
    f.setBrowserUser(
      new mongoose.models.User({ ...user.toObject(), _id: new mongoose.Types.ObjectId() }),
    );
    expect((await f.client.get(`/api/agents/responses/${id}/review`)).status).toBe(404);
    f.setBrowserUser(new mongoose.models.User({ ...user.toObject(), tenantId: 'another-tenant' }));
    expect((await f.client.get(`/api/agents/responses/${id}/review`)).status).toBe(404);
    f.setBrowserUser(user);
    await scoped(() => db.deleteAgentApiKey(f.credential.id, String(user._id)));
    expect((await f.client.get(`/api/agents/responses/${id}/review`)).status).toBe(404);
  } finally {
    finish('Authorization finished');
  }
});

it('creates, executes and retrieves a background response through HTTP, real auth and the durable queue', async () => {
  const f = await fixture();
  const body = {
    model: 'agent',
    input: 'Keep original input',
    instructions: 'Keep these instructions',
    background: true,
    store: true,
    max_output_tokens: 100,
    metadata: { purpose: 'test' },
  };
  const created = await f.client
    .post('/api/agents/v1/responses')
    .auth(f.credential.key, { type: 'bearer' })
    .set('Idempotency-Key', 'same-event')
    .send(body);
  expect(created.status).toBe(202);
  const result = await f.readUntil(created.body.id, 'completed');
  expect(result.body.output[0].content[0].text).toBe('# Real Responses lifecycle');
  expect(f.inputs).toEqual([body]);
  const replay = await f.client
    .post('/api/agents/v1/responses')
    .auth(f.credential.key, { type: 'bearer' })
    .set('Idempotency-Key', 'same-event')
    .send(body);
  expect(replay.body.id).toBe(created.body.id);
  expect(f.inputs).toHaveLength(1);
  expect(f.errors).toEqual([]);
});

it.each([RetentionMode.ALL, RetentionMode.EPHEMERAL])(
  'captures %s retention before storing a new private background request',
  async (retentionMode) => {
    const f = await fixture();
    f.config.interfaceConfig = {
      retentionMode,
      generalChatRetention: 2,
      temporaryChatRetention: 1,
    };
    const created = await f.client
      .post('/api/agents/v1/responses')
      .auth(f.credential.key, { type: 'bearer' })
      .send({ model: 'agent', input: 'retained private', background: true });
    expect(created.status).toBe(202);
    const row = await scoped(() =>
      storage.read({ userId: String(user._id), tenantId }, created.body.id),
    );
    expect(row?.expiredAt).toBeInstanceOf(Date);
    const hours = retentionMode === RetentionMode.ALL ? 2 : 1;
    expect(row!.expiredAt!.getTime() - row!.createdAt.getTime()).toBeGreaterThan(
      hours * 3_600_000 - 5000,
    );
    expect(row!.expiredAt!.getTime() - row!.createdAt.getTime()).toBeLessThanOrEqual(
      hours * 3_600_000,
    );
    expect(row?.isTemporary).toBe(retentionMode === RetentionMode.EPHEMERAL);
    await f.readUntil(created.body.id, 'completed');
    expect(f.errors).toEqual([]);
  },
);

it('inherits the existing temporary parent deadline instead of renewing its retention window', async () => {
  const f = await fixture();
  f.config.interfaceConfig = {
    retentionMode: RetentionMode.ALL,
    generalChatRetention: 2,
    temporaryChatRetention: 1,
  };
  const conversationId = '00000000-0000-4000-8000-000000000001';
  const expiredAt = new Date(Date.now() + 300_000);
  await scoped(() =>
    mongoose.models.Conversation.create({
      user: String(user._id),
      conversationId,
      expiredAt,
      isTemporary: true,
      endpoint: 'agents',
    }),
  );
  const created = await f.client
    .post('/api/agents/v1/responses')
    .auth(f.credential.key, { type: 'bearer' })
    .send({
      model: 'agent',
      input: 'continued',
      background: true,
      previous_response_id: conversationId,
    });
  expect(created.status).toBe(202);
  expect(
    await scoped(() => storage.read({ userId: String(user._id), tenantId }, created.body.id)),
  ).toMatchObject({ expiredAt, isTemporary: true, conversationId });
  await f.readUntil(created.body.id, 'completed');
  expect(f.errors).toEqual([]);
});

it('rejects an expired or missing continuation before writing its private request', async () => {
  const f = await fixture();
  const conversationId = 'expired-response-parent';
  await scoped(() =>
    mongoose.models.Conversation.create({
      user: String(user._id),
      conversationId,
      expiredAt: new Date(Date.now() - 1),
      isTemporary: true,
      endpoint: 'agents',
    }),
  );
  const expired = await f.client
    .post('/api/agents/v1/responses')
    .auth(f.credential.key, { type: 'bearer' })
    .send({
      model: 'agent',
      input: 'must not persist',
      background: true,
      previous_response_id: conversationId,
    });
  expect(expired.status).toBe(409);
  const missing = await f.client
    .post('/api/agents/v1/responses')
    .auth(f.credential.key, { type: 'bearer' })
    .send({
      model: 'agent',
      input: 'also must not persist',
      background: true,
      previous_response_id: 'missing-parent',
    });
  expect(missing.status).toBeGreaterThanOrEqual(400);
  expect(await scoped(() => mongoose.models.StoredResponse.countDocuments({}))).toBe(0);
  expect(f.inputs).toHaveLength(0);
});

it('keeps expired output private and releases a drained provider even after TTL removes its row', async () => {
  const f = await fixture();
  let started!: () => void;
  let finish!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.setGenerate(async () => {
    started();
    await gate;
    return 'late private output';
  });
  const created = await f.client
    .post('/api/agents/v1/responses')
    .auth(f.credential.key, { type: 'bearer' })
    .send({ model: 'agent', input: 'private', background: true });
  await running;
  const owner = { userId: String(user._id), tenantId };
  const record = (await scoped(() => storage.read(owner, created.body.id)))!;
  await scoped(() =>
    db.saveConvo(
      { userId: owner.userId, expiredAt: new Date(Date.now() - 1) },
      {
        conversationId: record.conversationId,
        endpoint: 'agents',
      },
    ),
  );
  expect(
    (
      await f.client
        .get(`/api/agents/v1/responses/${record.responseId}`)
        .auth(f.credential.key, { type: 'bearer' })
    ).status,
  ).toBe(404);
  await scoped(() => mongoose.models.StoredResponse.deleteOne({ responseId: record.responseId }));
  finish();
  for (let attempt = 0; attempt < 100; attempt++) {
    const job = await GenerationJobManager.getJob(record.responseId);
    if (job?.metadata.providerDrained && job.metadata.terminalPersistencePending !== true) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(await GenerationJobManager.getJob(record.responseId)).toMatchObject({
    metadata: {
      providerDrained: true,
      terminalPersistencePending: false,
    },
  });
  expect(
    await scoped(() =>
      mongoose.models.StoredResponse.countDocuments({ responseId: record.responseId }),
    ),
  ).toBe(0);
  expect(f.errors).toEqual([]);
});

it('does not start a provider when expiry wins enrollment publication and releases that job', async () => {
  const f = await fixture();
  const publish = storage.publish.bind(storage);
  const interrupted = jest.spyOn(storage, 'publish').mockImplementationOnce(async (...args) => {
    const record = (await storage.read(args[0], args[1]))!;
    await db.saveConvo(
      { userId: record.userId, expiredAt: new Date(Date.now() - 1) },
      {
        conversationId: record.conversationId,
        endpoint: 'agents',
      },
    );
    return publish(...args);
  });
  try {
    const created = await f.client
      .post('/api/agents/v1/responses')
      .auth(f.credential.key, { type: 'bearer' })
      .send({ model: 'agent', input: 'expired before start', background: true });
    for (let attempt = 0; attempt < 100; attempt++) {
      const job = await GenerationJobManager.getJob(created.body.id);
      if (job?.metadata.providerDrained && job.metadata.terminalPersistencePending === false) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(f.inputs).toHaveLength(0);
    expect(await GenerationJobManager.getJob(created.body.id)).toMatchObject({
      metadata: {
        providerDrained: true,
        terminalPersistencePending: false,
      },
    });
    expect(
      await scoped(() => storage.read({ userId: String(user._id), tenantId }, created.body.id)),
    ).toBeNull();
  } finally {
    interrupted.mockRestore();
  }
});

it('publishes terminal output when a concurrent read updates the review projection', async () => {
  const f = await fixture();
  const stageTerminal = storage.stageTerminal.bind(storage);
  const stage = jest.spyOn(storage, 'stageTerminal').mockImplementationOnce(async (...args) => {
    const observed = await f.client
      .get(`/api/agents/v1/responses/${args[1]}`)
      .auth(f.credential.key, { type: 'bearer' });
    expect(observed.body).toMatchObject({
      status: 'in_progress',
      recovery: 'execution_state_unavailable',
    });
    return stageTerminal(...args);
  });
  try {
    const created = await f.client
      .post('/api/agents/v1/responses')
      .auth(f.credential.key, { type: 'bearer' })
      .send({ model: 'agent', input: 'Finish despite polling', background: true, store: true });
    expect(created.status).toBe(202);
    const result = await f.readUntil(created.body.id, 'completed');
    expect(result.body.output[0].content[0].text).toBe('# Real Responses lifecycle');
    expect(f.inputs).toHaveLength(1);
    expect(f.errors).toEqual([]);
  } finally {
    stage.mockRestore();
  }
});

it('cancels the exact running response and waits for actual execution settlement', async () => {
  const f = await fixture();
  f.setGenerate(
    async (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      }),
  );
  const created = await f.client
    .post('/api/agents/v1/responses')
    .auth(f.credential.key, { type: 'bearer' })
    .send({ model: 'agent', input: 'Wait for Stop', background: true, store: true });
  await f.readUntil(created.body.id, 'in_progress');
  const cancelled = await f.client
    .post(`/api/agents/v1/responses/${created.body.id}/cancel`)
    .auth(f.credential.key, { type: 'bearer' })
    .send({});
  expect(cancelled.status).toBe(200);
  await f.readUntil(created.body.id, 'cancelled');
  expect(f.inputs).toHaveLength(1);
});

it('lets only the browser owner stop the exact response after provider settlement', async () => {
  GenerationJobManager.configure({
    jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
    eventTransport: new InMemoryEventTransport(),
  });
  const f = await fixture();
  let started!: () => void;
  const providerStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const drained = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.setGenerate(async (signal) => {
    started();
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
    await drained;
    throw new Error('cancelled');
  });
  const created = await f.client
    .post('/api/agents/v1/responses')
    .auth(f.credential.key, { type: 'bearer' })
    .send({ model: 'agent', input: 'Owner Stop', background: true, store: true });
  await providerStarted;
  const id = created.body.id;
  const exact = await GenerationJobManager.getJob(id);
  let settled = false;
  const stopping = f.client
    .post(`/api/agents/responses/${id}/cancel`)
    .send({})
    .then((result) => {
      settled = true;
      return result;
    });
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect((await scoped(() => storage.read({ userId: user.id, tenantId }, id)))?.status).toBe(
      'in_progress',
    );
    expect(await GenerationJobManager.getJob(id)).toMatchObject({
      createdAt: exact!.createdAt,
      metadata: {
        providerExecutionId: exact!.metadata.providerExecutionId,
        providerDrained: false,
      },
    });
  } finally {
    release();
  }
  const stopped = await stopping;
  expect(stopped.status).toBe(200);
  expect(stopped.headers['cache-control']).toBe('no-store');
  expect(stopped.body).toMatchObject({ id, status: 'cancelled' });
  expect(await GenerationJobManager.getJob(id)).toBeUndefined();
  expect(f.inputs).toHaveLength(1);
  await f.client.post(`/api/agents/responses/${id}/cancel`).send({}).expect(200);
});

it('denies browser cancellation for foreign owners, tenants, execution credentials, disabled policy and revoked source', async () => {
  const f = await fixture();
  const { id, owner } = await ownerPause(f.credential.id);
  const path = `/api/agents/responses/${id}/cancel`;
  for (const other of [
    new mongoose.models.User({ ...user.toObject(), _id: new mongoose.Types.ObjectId() }),
    new mongoose.models.User({ ...user.toObject(), tenantId: 'another-tenant' }),
  ]) {
    f.setBrowserUser(other);
    await f.client.post(path).send({}).expect(404);
  }
  f.setBrowserUser(undefined);
  await f.client.post(path).send({}).expect(401);
  f.setBrowserUser(user);
  for (const mode of ['trigger', 'key'] as const) {
    f.setBrowserMode(mode);
    await f.client.post(path).send({}).expect(401);
  }
  f.setBrowserMode('owner');
  f.config.endpoints!.agents!.remoteApi!.background!.enabled = false;
  await f.client.post(path).send({}).expect(404);
  f.config.endpoints!.agents!.remoteApi!.background!.enabled = true;
  await scoped(() => db.deleteAgentApiKey(f.credential.id, user._id));
  await f.client.post(path).send({}).expect(404);
  expect((await scoped(() => storage.read(owner, id)))?.cancellationRequestedAt).toBeUndefined();
  expect((await GenerationJobManager.getJob(id))?.status).toBe('requires_action');
  expect(f.inputs).toEqual([]);
});

it('does not let a new valid key resurrect an original revoked credential grant', async () => {
  const f = await fixture();
  const created = await f.client
    .post('/api/agents/v1/responses')
    .auth(f.credential.key, { type: 'bearer' })
    .send({ model: 'agent', input: 'Hello', background: true, store: true });
  await f.readUntil(created.body.id, 'completed');
  const replacement = await scoped(async () =>
    db.createAgentApiKey({ userId: user._id, name: 'replacement-test' }),
  );
  await scoped(async () => db.deleteAgentApiKey(f.credential.id, String(user._id)));
  const result = await f.client
    .get(`/api/agents/v1/responses/${created.body.id}`)
    .auth(replacement.key, { type: 'bearer' });
  expect(result.status).toBe(404);
});

it('preserves ordinary synchronous Responses and defaults background execution off when disabled', async () => {
  const f = await fixture();
  f.config.endpoints!.agents!.remoteApi!.background!.enabled = false;
  const ordinary = await f.client
    .post('/api/agents/v1/responses')
    .auth(f.credential.key, { type: 'bearer' })
    .send({ model: 'agent', input: 'Ordinary request' });
  expect(ordinary.status).toBe(200);
  expect(ordinary.body.status).toBe('completed');
  const denied = await f.client
    .post('/api/agents/v1/responses')
    .auth(f.credential.key, { type: 'bearer' })
    .send({ model: 'agent', input: 'Background request', background: true, store: true });
  expect(denied.status).toBe(403);
  expect(f.inputs).toHaveLength(1);
});

async function reserveUnstarted(credentialId: string) {
  const result = await scoped(() =>
    storage.reserve({
      userId: String(user._id),
      tenantId,
      sourceKeyId: credentialId,
      responseId: 'resp_delayed_worker',
      requestKey: 'delayed-worker',
      fingerprint: 'request',
      agentId: 'agent',
      requestJSON: JSON.stringify({
        model: 'agent',
        input: 'Delayed delivery',
        background: true,
        store: true,
      }),
      conversationId: 'delayed-conversation',
      parentMessageId: 'root',
    }),
  );
  if (!result.ok) throw new Error('Reservation failed');
  return result.record;
}

it('cancels an unstarted response durably and prevents a delayed worker from starting the provider', async () => {
  const f = await fixture();
  const record = await reserveUnstarted(f.credential.id);
  await expect(scoped(() => f.host.retireResponse(record, record.responseId))).resolves.toBe(
    'stopped',
  );
  const retired = await f.client
    .get(`/api/agents/v1/responses/${record.responseId}`)
    .auth(f.credential.key, { type: 'bearer' });
  expect(retired.body.status).toBe('cancelled');
  const delayed = await f.client
    .post('/api/agents/v1/responses')
    .set('x-lc-response-worker', '1')
    .auth(mintBackgroundResponseWorkerToken(record, 'isolated-background-host-secret'), {
      type: 'bearer',
    })
    .send({});
  expect(delayed.status).toBe(409);
  expect(f.inputs).toHaveLength(0);
  expect((await scoped(() => storage.read(record, record.responseId)))?.status).toBe('cancelled');
});

it('does not turn a missing admitted job into a fabricated stop confirmation', async () => {
  const f = await fixture();
  const record = await reserveUnstarted(f.credential.id);
  await scoped(() =>
    storage.publish(record, record.responseId, record.revision, {
      status: 'in_progress',
      responseJSON: JSON.stringify({}),
      generationCreatedAt: 1234,
    }),
  );
  await expect(scoped(() => f.host.retireResponse(record, record.responseId))).resolves.toBe(
    'pending',
  );
  expect((await scoped(() => storage.read(record, record.responseId)))?.status).toBe('in_progress');
});
