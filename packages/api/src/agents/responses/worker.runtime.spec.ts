import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { FileSources, PermissionBits } from 'librechat-data-provider';
import {
  createModels,
  createMethods,
  createResponseStorage,
  tenantStorage,
  runAsSystem,
} from '@librechat/data-schemas';
import type { StoredResponseRecord, ResponseStorage, IUser } from '@librechat/data-schemas';
import type { RequestHandler, Request, Response } from 'express';
import type { RunStreamConfig } from '@librechat/agents';
import type { BackgroundResponseWorkerDependencies } from './worker';
import type { ServerRequest } from '~/types/http';
import {
  createBackgroundResponseWorkerAuth,
  mintBackgroundResponseWorkerToken,
  getBackgroundResponseWorkerRecord,
  mintResponseResumeWorkerToken,
} from './worker';
import {
  createResponseCompletion,
  createResponseExecutionRelease,
  createResponseExecutionConfirmation,
} from './completion';
import { buildPendingBackgroundResponse, createBackgroundResponseService } from './background';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { createResponseContext, convertInputToMessages } from './service';
import { createResponseExecutionRuntime } from './runtime';
import { enrollAgentExecution } from '../remote/lifecycle';
import { createResponsePersistence } from './foreground';
import { createResponseResumeAdmission } from './resume';
import { buildResponseInputChain } from './persistence';
import { createAgentRunEnvelope } from '../envelope';
import { buildPendingAction } from '../hitl/policy';
import { executeAgentRun } from '../remote/host';
import { GenerationJobManager } from '~/stream';
import { createResponseTurn } from './turn';

let mongo: MongoMemoryReplSet;
let storage: ResponseStorage;
const secret = 'isolated-response-worker-test-secret';
const owner = { userId: '000000000000000000000001', tenantId: 'worker-test' };
const scope = <T>(work: () => Promise<T>) => tenantStorage.run({ tenantId: owner.tenantId }, work);
let record: StoredResponseRecord;
let user: IUser;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ args: ['--nounixsocket'] }],
  });
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  createModels(mongoose);
  storage = createResponseStorage(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  await runAsSystem(async () => {
    await mongoose.models.StoredResponse.deleteMany({});
    await mongoose.models.ResponseScope?.deleteMany({});
    await mongoose.models.Message.deleteMany({});
    await mongoose.models.Conversation.deleteMany({});
  });
  user = new mongoose.models.User({
    _id: owner.userId,
    tenantId: owner.tenantId,
    email: 'worker@example.test',
  });
  await scope(async () => {
    const result = await storage.reserve({
      ...owner,
      responseId: 'resp_worker',
      requestKey: 'request',
      fingerprint: 'fingerprint',
      agentId: 'agent',
      sourceKeyId: 'original-key',
      requestJSON: JSON.stringify({
        model: 'agent',
        input: 'Saved input',
        instructions: 'Saved instructions',
        store: true,
        background: true,
      }),
      conversationId: '1cb257b0-56a6-40a6-b096-cd6e05f26963',
      parentMessageId: 'root',
    });
    if (!result.ok) throw new Error('Reservation failed');
    record = result.record;
  });
});

function fixture(
  handler?: RequestHandler,
  admitResume?: BackgroundResponseWorkerDependencies['admitResume'],
) {
  let authorized = true;
  const errors: unknown[] = [];
  const app = express();
  app.use(express.json());
  app.use(
    createBackgroundResponseWorkerAuth(
      {
        storage,
        signingSecret: () => secret,
        findUser: async (id) => (id === owner.userId ? user : null),
        authorize: async (stored) => authorized && stored.sourceKeyId === 'original-key',
        admitResume,
        onError: (error) => {
          errors.push(error);
        },
      },
      (_req, res) => {
        res.status(418).json({ ordinaryAuth: true });
      },
    ),
  );
  app.all(
    /.*/,
    handler ??
      ((req, res) => {
        res.json({
          responseId: getBackgroundResponseWorkerRecord(req)?.responseId,
          body: req.body,
          userId: req.user && 'id' in req.user ? req.user.id : undefined,
        });
      }),
  );
  return {
    app,
    errors,
    revoke: () => {
      authorized = false;
    },
  };
}

it('accepts only a response-bound server token and restores the exact persisted request', async () => {
  const { app } = fixture();
  const response = await request(app)
    .post('/')
    .set('x-lc-response-worker', '1')
    .auth(mintBackgroundResponseWorkerToken(record, secret), { type: 'bearer' })
    .send({ model: 'attacker-agent', input: 'tampered', instructions: 'override' });
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    responseId: record.responseId,
    userId: owner.userId,
    body: { model: 'agent', input: 'Saved input', instructions: 'Saved instructions' },
  });
});

it('preserves ordinary remote authentication when there is no worker marker', async () => {
  const { app } = fixture();
  const response = await request(app).post('/').auth('ordinary-token', { type: 'bearer' }).send({});
  expect(response.status).toBe(418);
  expect(response.body).toEqual({ ordinaryAuth: true });
});

it('does not accept another JWT purpose or a forged worker token', async () => {
  const { app } = fixture();
  for (const token of [
    jwt.sign({ id: owner.userId, scope: 'agent_trigger' }, secret),
    mintBackgroundResponseWorkerToken(record, 'different-secret'),
  ]) {
    const response = await request(app)
      .post('/')
      .set('x-lc-response-worker', '1')
      .auth(token, { type: 'bearer' })
      .send({});
    expect(response.status).toBe(401);
    expect(response.body).not.toHaveProperty('responseId');
  }
});

it('rechecks original key authority rather than letting the worker token outlive revocation', async () => {
  const { app, revoke } = fixture();
  const token = mintBackgroundResponseWorkerToken(record, secret);
  revoke();
  const response = await request(app)
    .post('/')
    .set('x-lc-response-worker', '1')
    .auth(token, { type: 'bearer' })
    .send({});
  expect(response.status).toBe(401);
});

it('cannot use a worker token to read/cancel another response through a different route', async () => {
  const { app } = fixture();
  const token = mintBackgroundResponseWorkerToken(record, secret);
  for (const path of ['/resp_other/cancel', '/resp_other/execute']) {
    expect(
      (
        await request(app)
          .post(path)
          .set('x-lc-response-worker', '1')
          .auth(token, { type: 'bearer' })
          .send({})
      ).status,
    ).toBe(401);
  }
  expect(
    (await request(app).get('/').set('x-lc-response-worker', '1').auth(token, { type: 'bearer' }))
      .status,
  ).toBe(401);
});

it('does not accept a stale token after the original key reference changes', async () => {
  const { app } = fixture();
  const token = mintBackgroundResponseWorkerToken(
    { ...record, sourceKeyId: 'different-key' },
    secret,
  );
  expect(
    (
      await request(app)
        .post('/')
        .set('x-lc-response-worker', '1')
        .auth(token, { type: 'bearer' })
        .send({})
    ).status,
  ).toBe(401);
});

describe('background Responses execution handoff', () => {
  it.each(['completed', 'cancelled', 'publication_failure', 'lost_finalizer'] as const)(
    'retains exact terminal proof until Responses publication with default cleanup (%s)',
    async (outcome) => {
      GenerationJobManager.configure({
        jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
        eventTransport: new InMemoryEventTransport(),
      });
      const errors: unknown[] = [];
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      if (outcome === 'publication_failure')
        jest
          .spyOn(storage, 'finishTerminal')
          .mockRejectedValueOnce(new Error('Injected Mongo publication failure'));
      const { app } = fixture(async (req, res) => {
        const runtime = createResponseExecutionRuntime(req, res, {
          getMessage: async () => null,
          jobs: GenerationJobManager,
        });
        try {
          await executeAgentRun({
            envelope: createAgentRunEnvelope({
              protocol: 'responses',
              requestId: record.responseId,
              receivedAt: Date.now(),
              principal: { id: owner.userId, tenantId: owner.tenantId },
              payload: req.body,
            }),
            runId: record.responseId,
            conversationId: record.conversationId,
            ...runtime.hooks,
            ...(outcome === 'lost_finalizer'
              ? {
                  afterSettle: async () => {
                    throw new Error('Injected request-process loss after provider drain');
                  },
                }
              : {}),
            isPrincipalActive: async () => true,
            execute: async (execution) => {
              if (outcome === 'cancelled') {
                await GenerationJobManager.abortJob(record.responseId, {
                  expectedCreatedAt: execution.createdAt,
                });
              }
              await runtime.completion!.prepare({
                ...buildPendingBackgroundResponse(record),
                status: 'completed',
                output: [],
              });
            },
            onSettlementError: (error) => {
              errors.push(error);
            },
          });
        } finally {
          finish();
        }
      });
      await request(app)
        .post('/')
        .set('x-lc-response-worker', '1')
        .auth(mintBackgroundResponseWorkerToken(record, secret), { type: 'bearer' })
        .send({})
        .expect(202);
      await finished;
      let saved = (await scope(() => storage.read(owner, record.responseId)))!;
      if (outcome === 'publication_failure' || outcome === 'lost_finalizer') {
        expect(errors).toHaveLength(1);
        if (outcome === 'lost_finalizer') {
          expect(saved.preparedTerminal).toBeDefined();
          expect(saved.pendingTerminal).toBeUndefined();
        } else expect(saved.pendingTerminal).toBeDefined();
        await GenerationJobManager.getJobStore().updateJob(
          record.responseId,
          { terminalPersistenceStartedAt: Date.now() - 60_000 },
          saved.generationCreatedAt,
        );
        expect(await GenerationJobManager.getJob(record.responseId)).toMatchObject({
          createdAt: saved.generationCreatedAt,
          status: 'complete',
          metadata: { providerDrained: true, terminalPersistencePending: true },
        });
        // A fresh completion instance resumes only the persisted receipt, never the provider.
        saved = await scope(() =>
          createResponseCompletion({
            storage,
            cleanupCheckpoint: async () => {},
            confirmExecution: createResponseExecutionConfirmation(GenerationJobManager),
            releaseExecution: createResponseExecutionRelease(GenerationJobManager),
          }).finish(saved),
        );
      } else expect(errors).toEqual([]);
      expect(saved.status).toBe(outcome === 'cancelled' ? 'cancelled' : 'completed');
      expect(saved.pendingTerminal).toBeUndefined();
      expect(await GenerationJobManager.getJob(record.responseId)).toBeUndefined();
    },
  );
  it('publishes a safe failure when a required background projection preparation fails', async () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const errors: unknown[] = [];
    const saveMessage = jest.fn(async () => null);
    const prepare = jest.spyOn(storage, 'prepareTerminal');
    const { app } = fixture(async (req, res) => {
      const runtime = createResponseExecutionRuntime(req, res, {
        getMessage: async () => null,
        jobs: GenerationJobManager,
      });
      const turn = createResponseTurn({
        runtime,
        context: createResponseContext(req.body, record.responseId),
        requestedStore: true,
        logger: { error: jest.fn() },
      });
      try {
        await executeAgentRun({
          envelope: createAgentRunEnvelope({
            protocol: 'responses',
            requestId: record.responseId,
            receivedAt: Date.now(),
            principal: { id: owner.userId, tenantId: owner.tenantId },
            payload: req.body,
          }),
          runId: record.responseId,
          conversationId: record.conversationId,
          connection: runtime.connection,
          ...turn.hooks,
          isPrincipalActive: async () => true,
          execute: async (execution) => {
            await turn.stage(
              {
                run: { getInterrupt: () => undefined },
                execution,
                agents: [],
                request: { user: { id: owner.userId }, body: { isTemporary: false } },
                response: { ...buildPendingBackgroundResponse(record), status: 'completed' },
                conversationId: record.conversationId,
                agentId: record.agentId,
                agent: { id: record.agentId },
                messages: [],
                parentMessageId: record.parentMessageId,
                transport: { type: 'json', response: res },
              },
              {
                saveConvo: async () => ({ message: 'private database failure' }),
                saveMessage,
                announceReply: async () => {},
                resolveTitle: () => null,
                traceFields: async () => {
                  throw new Error('private database failure');
                },
              },
            );
          },
          onSettlementError: (error) => {
            errors.push(error);
          },
        });
      } catch (error) {
        expect(error).toMatchObject({ code: 'response_storage_unavailable' });
      } finally {
        finish();
      }
    });
    await request(app)
      .post('/')
      .set('x-lc-response-worker', '1')
      .auth(mintBackgroundResponseWorkerToken(record, secret), { type: 'bearer' })
      .send({})
      .expect(202);
    await finished;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'response_storage_unavailable' });
    expect(saveMessage).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    const saved = (await scope(() => storage.read(owner, record.responseId)))!;
    expect(saved.status).toBe('failed');
    expect(saved.preparedTerminal).toBeUndefined();
    expect(saved.pendingTerminal).toBeUndefined();
    expect(JSON.parse(saved.responseJSON!)).toMatchObject({
      status: 'failed',
      output: [],
      error: { code: 'execution_failed' },
    });
    expect(saved.responseJSON).not.toContain('private database failure');
    expect(await GenerationJobManager.getJob(record.responseId)).toMatchObject({
      status: 'error',
      metadata: { providerDrained: true, terminalPersistencePending: false },
    });
  });

  it('keeps memory-checkpointer background calls on the ordinary SDK stream with interactive host installed', async () => {
    const processStream = jest.fn(async () => undefined);
    const resume = jest.fn(async () => undefined);
    const { app } = fixture(
      async (req, res) => {
        (req as ServerRequest).config = {
          config: {},
          fileStrategy: FileSources.local,
          imageOutputType: 'png',
          endpoints: { agents: { checkpointer: { type: 'memory' } } },
        };
        const runtime = createResponseExecutionRuntime(req, res, {
          getMessage: async () => null,
          jobs: GenerationJobManager,
        });
        expect(await runtime.graphOptions()).toEqual({ hitlCapable: false });
        await runtime.processRun({ processStream, resume }, { messages: [] }, { version: 'v2' });
        res.json({ ordinary: true });
      },
      async () => ({ ok: false, code: 'response_resume_unavailable' }),
    );
    await request(app)
      .post('/')
      .set('x-lc-response-worker', '1')
      .auth(mintBackgroundResponseWorkerToken(record, secret), { type: 'bearer' })
      .send({})
      .expect(200, { ordinary: true });
    expect(processStream).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();
  });
  it('does not enable interactive execution from caller fields without an installed resume validator', async () => {
    const { app } = fixture(async (req, res) => {
      const runtime = createResponseExecutionRuntime(req, res, {
        getMessage: async () => null,
        jobs: GenerationJobManager,
      });
      expect(await runtime.graphOptions()).toEqual({ hitlCapable: false });
      res.json({ ok: true });
    });
    await request(app)
      .post('/')
      .set('x-lc-response-worker', '1')
      .auth(mintBackgroundResponseWorkerToken(record, secret), { type: 'bearer' })
      .send({ interactive: true, hitlCapable: true })
      .expect(200, { ok: true });
  });
  beforeEach(() => {
    GenerationJobManager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    GenerationJobManager.initialize();
  });
  afterEach(async () => {
    await GenerationJobManager.destroy();
  });

  async function prepareResume() {
    await scope(async () => {
      const execution = await enrollAgentExecution({
        runId: record.responseId,
        userId: owner.userId,
        agentId: record.agentId,
        conversationId: record.conversationId,
        protocol: 'responses',
        retainTerminalPersistence: true,
        isPrincipalActive: async () => true,
      });
      await storage.publish(owner, record.responseId, 0, {
        status: 'in_progress',
        generationCreatedAt: execution.createdAt,
        responseJSON: JSON.stringify(buildPendingBackgroundResponse(record)),
      });
      await execution.beginProviderExecution();
      const job = (await GenerationJobManager.getJob(record.responseId))!;
      const action = buildPendingAction(
        { type: 'ask_user_question', question: { question: 'Which environment?' } },
        {
          streamId: record.responseId,
          responseMessageId: record.responseId,
          conversationId: record.conversationId,
          threadId: record.conversationId,
          ttlMs: 60_000,
          interruptId: 'interrupt-one',
        },
      );
      await execution.pauseForReview(action, async () => {
        const result = await storage.publishReview(
          owner,
          record.responseId,
          { execution: (await storage.read(owner, record.responseId))! },
          execution.createdAt,
          {
            actionId: action.actionId,
            providerExecutionId: job.metadata.providerExecutionId!,
            expiresAt: action.expiresAt!,
            partialResponseJSON: '{}',
            pendingActionJSON: JSON.stringify(action),
            checkpointId: 'checkpoint-exact',
            checkpointNs: '',
            checkpointConfigJSON: JSON.stringify({
              type: 'mongo',
              checkpointCollectionName: 'worker_checkpoints',
              checkpointWritesCollectionName: 'worker_checkpoint_writes',
            }),
          },
          JSON.stringify({ ...buildPendingBackgroundResponse(record), status: 'requires_action' }),
        );
        if (!result.ok) throw new Error('Pause failed');
      });
      await execution.settle();
      const result = await storage.reserveResume(
        owner,
        record.responseId,
        {
          generationCreatedAt: execution.createdAt,
          intentId: 'intent-one',
          actionId: action.actionId,
          previousProviderExecutionId: job.metadata.providerExecutionId!,
          providerExecutionId: 'resume-provider',
          fingerprint: 'answer',
          resolutionJSON: '{"answer":"staging"}',
          decisionJSON: JSON.stringify({ actionId: action.actionId, answer: 'staging' }),
        },
        Date.now(),
      );
      if (!result.ok) throw new Error('Resume reservation failed');
      record = result.record;
    });
  }

  it('rejects resume-purpose tokens when no capable admission validator is installed', async () => {
    await prepareResume();
    const { app } = fixture();
    await request(app)
      .post('/')
      .set('x-lc-response-worker', '1')
      .auth(mintResponseResumeWorkerToken(record, secret), { type: 'bearer' })
      .send({})
      .expect(401);
    expect((await scope(() => storage.read(owner, record.responseId)))?.status).toBe(
      'requires_action',
    );
  });

  it('rejects a saved resume worker token after original authority revocation without admission or provider effects', async () => {
    await prepareResume();
    const handler = jest.fn((_req: Request, res: Response) => {
      res.status(200).end();
    });
    const admit = jest.fn(async () => ({
      ok: false as const,
      code: 'response_resume_unavailable' as const,
    }));
    const { app, revoke } = fixture(handler, admit);
    const token = mintResponseResumeWorkerToken(record, secret);
    revoke();

    await request(app)
      .post('/')
      .set('x-lc-response-worker', '1')
      .auth(token, { type: 'bearer' })
      .send({})
      .expect(401);

    expect(admit).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(await GenerationJobManager.getJob(record.responseId)).toMatchObject({
      status: 'requires_action',
      createdAt: record.generationCreatedAt,
      metadata: { providerExecutionId: record.review!.providerExecutionId },
    });
    const retained = await scope(() => storage.read(owner, record.responseId));
    expect(retained?.status).toBe('requires_action');
    expect(retained?.resume).toEqual(record.resume);
  });

  it('never lets an initial-purpose delivery replace an already-paused response', async () => {
    await prepareResume();
    const handler = jest.fn((_req: Request, res: Response) => {
      res.status(200).end();
    });
    const { app } = fixture(handler);
    await request(app)
      .post('/')
      .set('x-lc-response-worker', '1')
      .auth(mintBackgroundResponseWorkerToken(record, secret), { type: 'bearer' })
      .send({})
      .expect(409, { code: 'RUN_ALREADY_ADMITTED' });
    expect(handler).not.toHaveBeenCalled();
    expect(await GenerationJobManager.getJob(record.responseId)).toMatchObject({
      status: 'requires_action',
      createdAt: record.generationCreatedAt,
      metadata: { providerExecutionId: record.review!.providerExecutionId },
    });
  });

  it('binds resume tokens to the exact saved intent, epoch and selected provider', async () => {
    await prepareResume();
    const admit = jest.fn(async () => ({
      ok: false as const,
      code: 'response_resume_unavailable' as const,
    }));
    const { app } = fixture(undefined, admit);
    for (const changed of [
      { ...record, generationCreatedAt: record.generationCreatedAt! + 1 },
      { ...record, resume: { ...record.resume!, intentId: 'other-intent' } },
      { ...record, resume: { ...record.resume!, providerExecutionId: 'other-provider' } },
    ]) {
      await request(app)
        .post('/')
        .set('x-lc-response-worker', '1')
        .auth(mintResponseResumeWorkerToken(changed, secret), { type: 'bearer' })
        .send({})
        .expect(401);
    }
    expect(admit).not.toHaveBeenCalled();
  });

  it('resumes through HTTP using only the saved decision and publishes after the owning segment settles', async () => {
    GenerationJobManager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: new InMemoryEventTransport(),
    });
    await prepareResume();
    const originalEpoch = record.generationCreatedAt;
    const admit = createResponseResumeAdmission({
      storage,
      jobs: GenerationJobManager,
      authorize: async () => true,
      validate: async () => ({ ok: true, provenance: {} }),
    });
    const processStream = jest.fn(async () => undefined);
    const resume = jest.fn(async (value: unknown, config: RunStreamConfig) => {
      expect(value).toEqual({ answer: 'staging' });
      expect(config.configurable).toMatchObject({
        thread_id: record.conversationId,
        checkpoint_id: 'checkpoint-exact',
        checkpoint_ns: '',
        private_option: 'preserved',
      });
      return undefined;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let done!: () => void;
    const finished = new Promise<void>((resolve) => {
      done = resolve;
    });
    const { app } = fixture(
      async (req, res) => {
        const runtime = createResponseExecutionRuntime(req, res, {
          getMessage: async () => null,
          jobs: GenerationJobManager,
        });
        const envelope = createAgentRunEnvelope({
          protocol: 'responses',
          requestId: record.responseId,
          receivedAt: Date.now(),
          principal: { id: owner.userId, tenantId: owner.tenantId },
          payload: req.body,
        });
        try {
          await executeAgentRun({
            envelope,
            runId: runtime.responseId,
            conversationId: record.conversationId,
            ...runtime.hooks,
            isPrincipalActive: async () => true,
            execute: async () => {
              await runtime.processRun(
                { processStream, resume },
                { messages: [] },
                {
                  configurable: {
                    thread_id: 'tampered',
                    checkpoint_id: 'wrong',
                    private_option: 'preserved',
                  },
                  version: 'v2',
                },
              );
              await gate;
              await runtime.completion!.prepare({
                ...buildPendingBackgroundResponse(record),
                status: 'completed',
                output: [],
              });
            },
            afterSettle: async (execution, error) => {
              await runtime.hooks.afterSettle?.(execution, error);
              done();
            },
          });
        } catch {
          if (!res.writableEnded) res.status(409).json({ error: 'resume_conflict' });
        }
      },
      (saved, _user, intentId) => admit(saved, saved.responseId, intentId),
    );
    const token = mintResponseResumeWorkerToken(record, secret);
    const send = () =>
      request(app)
        .post('/')
        .set('x-lc-response-worker', '1')
        .auth(token, { type: 'bearer' })
        .send({ resume: { answer: 'attacker answer' }, model: 'wrong' });
    await send().expect(202);
    await send().expect(202);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(processStream).not.toHaveBeenCalled();
    release();
    await finished;
    expect(await scope(() => storage.read(owner, record.responseId))).toMatchObject({
      status: 'completed',
      generationCreatedAt: originalEpoch,
    });
    expect(await GenerationJobManager.getJob(record.responseId)).toBeUndefined();
  });

  it.each([false, true])(
    'keeps final output private until drain and recovers canonical materialization (outage=%s)',
    async (materializationOutage) => {
      let markPrepared!: () => void;
      let failPreparation!: (error: unknown) => void;
      let executionError: unknown;
      const settlementErrors: unknown[] = [];
      const preparation = new Promise<void>((resolve, reject) => {
        markPrepared = resolve;
        failPreparation = reject;
      });
      preparation.catch(() => {});
      let release!: () => void;
      const trailingWrite = new Promise<void>((resolve) => {
        release = resolve;
      });
      let settled!: () => void;
      const finished = new Promise<void>((resolve) => {
        settled = resolve;
      });
      const prepare = storage.prepareTerminal.bind(storage);
      const prepareWithConcurrentProgress = jest
        .spyOn(storage, 'prepareTerminal')
        .mockImplementationOnce(async (...args) => {
          for (let step = 0; step < 30; step++) {
            const current = (await storage.read(owner, record.responseId))!;
            const projected = await storage.publish(owner, current.responseId, current.revision, {
              status: 'in_progress',
              responseJSON: JSON.stringify({
                ...buildPendingBackgroundResponse(current),
                status: 'in_progress',
                metadata: { progress: step },
              }),
            });
            expect(projected.ok).toBe(true);
          }
          const result = await prepare(...args);
          markPrepared();
          return result;
        });
      let starts = 0;
      const announce = jest.fn(async () => {
        expect((await storage.read(owner, record.responseId))?.status).toBe('completed');
        expect(
          await mongoose.models.Message.findOne({
            user: owner.userId,
            messageId: record.responseId,
          }),
        ).not.toBeNull();
      });
      const { app } = fixture(async (req, res) => {
        const runtime = createResponseExecutionRuntime(req, res, {
          getMessage: async () => null,
          jobs: GenerationJobManager,
        });
        const turn = createResponseTurn({
          runtime,
          context: createResponseContext(req.body, record.responseId),
          requestedStore: true,
          logger: { error: jest.fn() },
        });
        const methods = createMethods(mongoose);
        const envelope = createAgentRunEnvelope({
          protocol: 'responses',
          requestId: record.responseId,
          receivedAt: Date.now(),
          principal: { id: owner.userId, tenantId: owner.tenantId },
          payload: req.body,
        });
        try {
          await executeAgentRun({
            envelope,
            runId: runtime.responseId,
            conversationId: record.conversationId,
            connection: runtime.connection,
            ...turn.hooks,
            isPrincipalActive: async () => true,
            onSettlementError: (error) => {
              settlementErrors.push(error);
            },
            execute: async (execution) => {
              starts++;
              execution.track(trailingWrite);
              await turn.stage(
                {
                  run: { getInterrupt: () => undefined },
                  execution,
                  agents: [],
                  request: { user: { id: owner.userId }, body: {} },
                  conversationId: record.conversationId,
                  agentId: record.agentId,
                  agent: { id: record.agentId },
                  ...buildResponseInputChain(
                    convertInputToMessages(JSON.parse(record.requestJSON).input),
                    record.parentMessageId,
                  ),
                  transport: { type: 'json', response: res },
                  response: {
                    ...buildPendingBackgroundResponse(record),
                    status: 'completed',
                    output: [
                      {
                        type: 'message',
                        role: 'assistant',
                        status: 'completed',
                        id: 'message',
                        content: [
                          {
                            type: 'output_text',
                            text: '# Exact final answer',
                            annotations: [],
                            logprobs: [],
                          },
                        ],
                      },
                    ],
                  },
                },
                {
                  saveConvo: methods.saveConvo,
                  saveMessage: async (...args) => {
                    const saved = await methods.saveMessage(...args);
                    return saved
                      ? { messageId: saved.messageId, conversationId: saved.conversationId }
                      : null;
                  },
                  announceReply: announce,
                  resolveTitle: () => null,
                  traceFields: async () => ({ langfuseSampled: false }),
                },
              );
            },
          });
        } catch (error) {
          executionError = error;
          failPreparation(error);
          if (!res.writableEnded) res.status(409).json({ code: 'failed' });
        } finally {
          settled();
        }
      });
      const token = mintBackgroundResponseWorkerToken(record, secret);
      const first = await request(app)
        .post('/')
        .set('x-lc-response-worker', '1')
        .auth(token, { type: 'bearer' })
        .send({});
      expect(first.status).toBe(202);
      try {
        await preparation;
        expect(announce).not.toHaveBeenCalled();
        expect(
          await scope(() =>
            mongoose.models.Message.findOne({
              user: owner.userId,
              messageId: record.responseId,
            }).lean(),
          ),
        ).toBeNull();
        const recovery = createResponseCompletion({
          storage,
          cleanupCheckpoint: async () => {},
          confirmExecution: createResponseExecutionConfirmation(GenerationJobManager),
          releaseExecution: createResponseExecutionRelease(GenerationJobManager),
        });
        const service = createBackgroundResponseService({
          storage,
          authorize: async () => true,
          resolveContinuation: async () => ({
            conversationId: record.conversationId,
            parentMessageId: record.parentMessageId,
          }),
          enqueue: async () => {
            throw new Error('Prepared work must not be enqueued again');
          },
          observe: async () => {
            throw new Error('Prepared work must go to its completion owner');
          },
          recoverTerminal: recovery.finish,
          cancel: async () => {},
        });
        const visible = await scope(() => service.retrieve(owner, record.responseId));
        expect(visible).toMatchObject({ ok: true, response: { status: 'in_progress' } });
        expect(JSON.stringify(visible)).not.toContain('# Exact final answer');
        const beforeDrain = (await scope(() => storage.read(owner, record.responseId)))!;
        expect(beforeDrain.preparedTerminal).toBeDefined();
        expect(beforeDrain.pendingTerminal).toBeUndefined();
        expect((await scope(async () => storage.read(owner, record.responseId)))?.status).toBe(
          'materializing',
        );
        const duplicate = await request(app)
          .post('/')
          .set('x-lc-response-worker', '1')
          .auth(token, { type: 'bearer' })
          .send({});
        expect(duplicate.status).toBe(409);
        expect(duplicate.body.code).toBe('RUN_ALREADY_ADMITTED');
        expect(starts).toBe(1);
        if (materializationOutage) {
          jest
            .spyOn(mongoose.models.Conversation, 'findOneAndUpdate')
            .mockImplementationOnce(() => {
              throw new Error('Canonical materialization temporarily unavailable');
            });
        }
      } finally {
        release();
      }
      await finished;
      if (materializationOutage) {
        expect(settlementErrors).toHaveLength(1);
        const pending = (await scope(() => storage.read(owner, record.responseId)))!;
        expect(pending.status).toBe('materializing');
        expect(pending.pendingTerminal?.status).toBe('completed');
        expect(pending.pendingTerminal?.responseJSON).toContain('# Exact final answer');
        expect(
          await scope(() => mongoose.models.Message.countDocuments({ user: owner.userId })),
        ).toBe(0);
        expect(announce).not.toHaveBeenCalled();
        const recovery = createResponseCompletion({
          storage,
          cleanupCheckpoint: async () => {},
          confirmExecution: createResponseExecutionConfirmation(GenerationJobManager),
          releaseExecution: createResponseExecutionRelease(GenerationJobManager),
        });
        await scope(() => recovery.finish(pending));
      }
      if (materializationOutage)
        expect(executionError).toMatchObject({
          message: 'Canonical materialization temporarily unavailable',
        });
      else expect(executionError).toBeUndefined();
      expect(announce).toHaveBeenCalledTimes(materializationOutage ? 0 : 1);
      const committedMessage = await scope(() =>
        mongoose.models.Message.findOne({
          user: owner.userId,
          messageId: record.responseId,
        }).lean(),
      );
      expect(committedMessage).toMatchObject({
        text: '# Exact final answer',
        finish_reason: 'stop',
        unfinished: false,
      });
      expect(
        await scope(() => mongoose.models.Message.countDocuments({ user: owner.userId })),
      ).toBe(2);
      const saved = await scope(async () => storage.read(owner, record.responseId));
      expect(prepareWithConcurrentProgress).toHaveBeenCalledTimes(1);
      prepareWithConcurrentProgress.mockRestore();
      expect(saved?.status).toBe('completed');
      expect(saved?.preparedTerminal).toBeUndefined();
      expect(JSON.parse(saved!.responseJSON!).output[0].content[0].text).toBe(
        '# Exact final answer',
      );
    },
  );

  it('recovers runtime terminal publication failure without executing the provider again', async () => {
    let done!: () => void;
    const finished = new Promise<void>((resolve) => {
      done = resolve;
    });
    const errors: unknown[] = [];
    let starts = 0;
    const publication = jest
      .spyOn(storage, 'finishTerminal')
      .mockRejectedValueOnce(new Error('terminal publication unavailable'));
    const { app } = fixture(async (req, res) => {
      const runtime = createResponseExecutionRuntime(req, res, {
        getMessage: async () => null,
        jobs: GenerationJobManager,
      });
      const envelope = createAgentRunEnvelope({
        protocol: 'responses',
        requestId: record.responseId,
        receivedAt: Date.now(),
        principal: { id: owner.userId, tenantId: owner.tenantId },
        payload: req.body,
      });
      try {
        await executeAgentRun({
          envelope,
          runId: runtime.responseId,
          conversationId: record.conversationId,
          ...runtime.hooks,
          isPrincipalActive: async () => true,
          execute: async () => {
            starts++;
            await runtime.completion!.prepare({
              ...buildPendingBackgroundResponse(record),
              status: 'completed',
              metadata: { marker: 'exact-runtime-result' },
            });
          },
          onSettlementError: (error) => {
            errors.push(error);
          },
        });
      } finally {
        done();
      }
    });
    const send = () =>
      request(app)
        .post('/')
        .set('x-lc-response-worker', '1')
        .auth(mintBackgroundResponseWorkerToken(record, secret), { type: 'bearer' })
        .send({});
    await send().expect(202);
    await finished;
    expect(errors).toHaveLength(1);
    const pending = (await scope(() => storage.read(owner, record.responseId)))!;
    expect(pending.status).toBe('in_progress');
    expect(JSON.parse(pending.pendingTerminal!.responseJSON).metadata.marker).toBe(
      'exact-runtime-result',
    );
    await send().expect(409);
    const recovered = await scope(() =>
      createResponseCompletion({
        storage,
        cleanupCheckpoint: async () => {},
        confirmExecution: createResponseExecutionConfirmation(GenerationJobManager),
        releaseExecution: createResponseExecutionRelease(GenerationJobManager),
      }).finish(pending),
    );
    expect(recovered.status).toBe('completed');
    expect(JSON.parse(recovered.responseJSON!).metadata.marker).toBe('exact-runtime-result');
    expect(recovered.pendingTerminal).toBeUndefined();
    expect(starts).toBe(1);
    publication.mockRestore();
  });

  it.each([
    ['owner', 'enrollment'],
    ['conversation', 'enrollment'],
    ['expiry', 'enrollment'],
    ['owner', 'settlement'],
    ['conversation', 'settlement'],
    ['expiry', 'settlement'],
  ] as const)(
    'releases the exact runtime after %s retirement during %s without restoring private output',
    async (kind, phase) => {
      const errors: unknown[] = [];
      let starts = 0;
      let done!: () => void;
      const finished = new Promise<void>((resolve) => {
        done = resolve;
      });
      const retire = async () => {
        const methods = createMethods(mongoose);
        if (kind === 'owner') {
          await mongoose.models.User.updateOne(
            { _id: owner.userId },
            { $set: { tenantId: owner.tenantId, email: 'retired-worker@example.test' } },
            { upsert: true },
          );
          await methods.deleteUserById(owner.userId);
        } else if (kind === 'conversation')
          await methods.deleteConvos(owner.userId, { conversationId: record.conversationId });
        else
          await methods.saveConvo(
            { userId: owner.userId, expiredAt: new Date(Date.now() - 1000) },
            { conversationId: record.conversationId, endpoint: 'agents' },
          );
      };
      const { app } = fixture(async (req, res) => {
        const runtime = createResponseExecutionRuntime(req, res, {
          getMessage: async () => null,
          jobs: GenerationJobManager,
        });
        try {
          await executeAgentRun({
            envelope: createAgentRunEnvelope({
              protocol: 'responses',
              requestId: record.responseId,
              receivedAt: Date.now(),
              principal: { id: owner.userId, tenantId: owner.tenantId },
              payload: req.body,
            }),
            runId: record.responseId,
            conversationId: record.conversationId,
            ...runtime.hooks,
            onEnrolled: async (execution) => {
              if (phase === 'enrollment') await retire();
              await runtime.hooks.onEnrolled!(execution);
            },
            isPrincipalActive: async () => true,
            execute: async () => {
              starts++;
              await retire();
              await runtime.completion!.prepare({
                ...buildPendingBackgroundResponse(record),
                status: 'completed',
                output: [],
              });
            },
            onSettlementError: (error) => {
              errors.push(error);
            },
          });
        } catch (error) {
          errors.push(error);
          if (!res.writableEnded) res.status(409).json({ error: 'execution_unavailable' });
        } finally {
          done();
        }
      });
      await request(app)
        .post('/')
        .set('x-lc-response-worker', '1')
        .auth(mintBackgroundResponseWorkerToken(record, secret), { type: 'bearer' })
        .send({})
        .expect(phase === 'enrollment' ? 409 : 202);
      await finished;
      expect(starts).toBe(phase === 'enrollment' ? 0 : 1);
      expect(errors).toHaveLength(phase === 'enrollment' ? 1 : 0);
      expect(await scope(() => storage.read(owner, record.responseId))).toBeNull();
      expect(await GenerationJobManager.getJob(record.responseId)).toMatchObject({
        status: phase === 'enrollment' ? 'error' : 'complete',
        metadata: { providerDrained: true, terminalPersistencePending: false },
      });
    },
  );

  it.each(['before enrollment', 'during publication'])(
    'honors queued cancellation %s without provider work',
    async (phase) => {
      if (phase === 'before enrollment') {
        await scope(async () => storage.requestCancellation(owner, record.responseId, Date.now()));
      } else {
        const publish = storage.publish.bind(storage);
        jest.spyOn(storage, 'publish').mockImplementationOnce(async (...args) => {
          await storage.requestCancellation(owner, record.responseId, Date.now());
          return publish(...args);
        });
      }
      let settled!: () => void;
      const finished = new Promise<void>((resolve) => {
        settled = resolve;
      });
      let starts = 0;
      const { app } = fixture(async (req, res) => {
        const runtime = createResponseExecutionRuntime(req, res, {
          getMessage: async () => null,
          jobs: GenerationJobManager,
        });
        const envelope = createAgentRunEnvelope({
          protocol: 'responses',
          requestId: record.responseId,
          receivedAt: Date.now(),
          principal: { id: owner.userId, tenantId: owner.tenantId },
          payload: req.body,
        });
        await executeAgentRun({
          envelope,
          runId: runtime.responseId,
          conversationId: record.conversationId,
          connection: runtime.connection,
          ...runtime.hooks,
          isPrincipalActive: async () => true,
          execute: async () => {
            starts++;
          },
          handleExecutionError: () => {
            if (!res.writableEnded) res.status(409).json({ code: 'cancelled' });
          },
        });
        settled();
      });
      const response = await request(app)
        .post('/')
        .set('x-lc-response-worker', '1')
        .auth(mintBackgroundResponseWorkerToken(record, secret), { type: 'bearer' })
        .send({});
      expect(response.status).toBe(202);
      await finished;
      expect(starts).toBe(0);
      expect((await scope(async () => storage.read(owner, record.responseId)))?.status).toBe(
        'cancelled',
      );
    },
  );

  it.each(['stop', 'error'] as const)(
    'does not publish a completed candidate after %s wins settlement',
    async (mode) => {
      let done!: () => void;
      const finished = new Promise<void>((resolve) => {
        done = resolve;
      });
      const errors: unknown[] = [];
      const { app } = fixture(async (req, res) => {
        const runtime = createResponseExecutionRuntime(req, res, {
          getMessage: async () => null,
          jobs: GenerationJobManager,
        });
        const envelope = createAgentRunEnvelope({
          protocol: 'responses',
          requestId: record.responseId,
          receivedAt: Date.now(),
          principal: { id: owner.userId, tenantId: owner.tenantId },
          payload: req.body,
        });
        try {
          await executeAgentRun({
            envelope,
            runId: runtime.responseId,
            conversationId: record.conversationId,
            ...runtime.hooks,
            isPrincipalActive: async () => true,
            execute: async (execution) => {
              const response = {
                ...buildPendingBackgroundResponse(record),
                status: 'completed' as const,
                output: [
                  {
                    type: 'message' as const,
                    role: 'assistant' as const,
                    status: 'completed' as const,
                    id: 'candidate-message',
                    content: [
                      {
                        type: 'output_text' as const,
                        text: 'Candidate answer',
                        annotations: [],
                        logprobs: [],
                      },
                    ],
                  },
                ],
              };
              const methods = createMethods(mongoose);
              const persistence = createResponsePersistence(
                {
                  request: { user: { id: owner.userId }, body: {} },
                  conversationId: record.conversationId,
                  agentId: record.agentId,
                  agent: { id: record.agentId },
                  ...buildResponseInputChain(
                    convertInputToMessages(JSON.parse(record.requestJSON).input),
                    record.parentMessageId,
                  ),
                },
                {
                  saveConvo: methods.saveConvo,
                  saveMessage: async (...args) => {
                    const saved = await methods.saveMessage(...args);
                    return saved
                      ? { messageId: saved.messageId, conversationId: saved.conversationId }
                      : null;
                  },
                  announceReply: async () => {},
                  resolveTitle: () => null,
                  traceFields: async () => ({ langfuseSampled: false }),
                },
              );
              await runtime.completion!.prepare(response, await persistence.prepare(response));
              expect(
                await mongoose.models.Message.findOne({
                  user: owner.userId,
                  messageId: record.responseId,
                }),
              ).toBeNull();
              if (mode === 'stop')
                await GenerationJobManager.abortJob(runtime.responseId, {
                  expectedCreatedAt: execution.createdAt,
                });
              if (mode === 'error') throw new Error('private provider diagnostics');
            },
            onSettlementError: (error) => {
              errors.push(error);
            },
          });
        } catch {
          /* The execution failure is represented by the canonical safe response. */
        } finally {
          done();
        }
      });
      await request(app)
        .post('/')
        .set('x-lc-response-worker', '1')
        .auth(mintBackgroundResponseWorkerToken(record, secret), { type: 'bearer' })
        .send({})
        .expect(202);
      await finished;
      expect(errors).toEqual([]);
      const saved = (await scope(() => storage.read(owner, record.responseId)))!;
      expect(saved.status).toBe(mode === 'stop' ? 'cancelled' : 'failed');
      expect(saved.responseJSON).not.toContain('private provider diagnostics');
      expect(saved.pendingTerminal).toBeUndefined();
      const readApp = express();
      const methods = createMethods(mongoose);
      readApp.use((req, _res, next) => {
        Object.assign(req, { user });
        tenantStorage.run(owner, next);
      });
      // Exercise the compiled host and its actual foreground fallback over committed history.
      const compiled = jest.requireActual<{
        createStoredForegroundResponseReader: typeof import('./stored').createStoredForegroundResponseReader;
        createBackgroundResponsesHost: typeof import('./host').createBackgroundResponsesHost;
      }>('@librechat/api');
      const readHost = compiled.createBackgroundResponsesHost({
        isQueueReady: () => false,
        storage,
        jobs: GenerationJobManager,
        findUser: async () => user,
        getKey: async () => ({}),
        getRole: async () =>
          new mongoose.models.Role({ name: 'USER', permissions: { REMOTE_AGENTS: { USE: true } } }),
        getConfig: async () => ({
          config: {},
          fileStrategy: FileSources.local,
          imageOutputType: 'png',
          endpoints: {
            agents: {
              remoteApi: { background: { enabled: true, acknowledgementTimeoutMs: 1000 } },
            },
          },
        }),
        isPrincipalActive: async () => true,
        getAgentPermissions: async () => PermissionBits.VIEW,
        getMessage: methods.getMessage,
        getConvoRetention: methods.getConvoRetention,
        enqueue: async () => {
          throw new Error('Retrieval must not enqueue another provider');
        },
        signingSecret: () => secret,
        onError: (error) => {
          errors.push(error);
        },
      });
      const readHandlers = readHost.handlers({
        create: (_req, res) => {
          res.sendStatus(500);
        },
        retrieve: compiled.createStoredForegroundResponseReader({
          ...methods,
          logger: { error: jest.fn() },
        }),
      });
      readApp.get('/:id', readHandlers.retrieve);
      const read = await request(readApp)
        .get('/' + record.responseId)
        .expect(200);
      expect(read.body.status).toBe(saved.status);
      expect(read.body.background).toBe(true);
      expect(read.body.error).toEqual(JSON.parse(saved.responseJSON!).error);
      expect(JSON.stringify(read.body)).not.toContain('private provider diagnostics');

      await scope(() => mongoose.models.ResponseScope.updateMany({}, { $set: { closed: true } }));
      await request(readApp)
        .get('/' + record.responseId)
        .expect(404);
      await scope(() =>
        mongoose.models.StoredResponse.deleteOne({ responseId: record.responseId }),
      );
      await request(readApp)
        .get('/' + record.responseId)
        .expect(404);

      expect(
        await scope(() =>
          mongoose.models.Message.findOne({
            user: owner.userId,
            messageId: record.responseId,
          }).lean(),
        ),
      ).toMatchObject({
        text: 'Candidate answer',
        finish_reason: mode === 'stop' ? 'cancelled' : 'failed',
        unfinished: false,
      });
    },
  );
});
