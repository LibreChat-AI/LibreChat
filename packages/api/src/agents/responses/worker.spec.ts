import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import mongoose from 'mongoose';
import { FileSources } from 'librechat-data-provider';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createModels,
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
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { createResponseCompletion, createResponseExecutionRelease } from './completion';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { buildPendingBackgroundResponse } from './background';
import { createResponseExecutionRuntime } from './runtime';
import { enrollAgentExecution } from '../remote/lifecycle';
import { createResponseResumeAdmission } from './resume';
import { createAgentRunEnvelope } from '../envelope';
import { buildPendingAction } from '../hitl/policy';
import { executeAgentRun } from '../remote/host';
import { GenerationJobManager } from '~/stream';

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
      conversationId: 'conversation',
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
  it.each(['completed', 'cancelled', 'publication_failure'] as const)(
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
            isPrincipalActive: async () => true,
            execute: async (execution) => {
              if (outcome === 'cancelled') {
                await GenerationJobManager.abortJob(record.responseId, {
                  expectedCreatedAt: execution.createdAt,
                });
              }
              res.json({
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
      if (outcome === 'publication_failure') {
        expect(errors).toHaveLength(1);
        expect(saved.pendingTerminal).toBeDefined();
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
            releaseExecution: createResponseExecutionRelease(GenerationJobManager),
          }).finish(saved),
        );
      } else expect(errors).toEqual([]);
      expect(saved.status).toBe(outcome === 'cancelled' ? 'cancelled' : 'completed');
      expect(saved.pendingTerminal).toBeUndefined();
      expect(await GenerationJobManager.getJob(record.responseId)).toBeUndefined();
    },
  );
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
        expect(runtime.graphOptions()).toEqual({ hitlCapable: false });
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
    const { app } = fixture((req, res) => {
      const runtime = createResponseExecutionRuntime(req, res, {
        getMessage: async () => null,
        jobs: GenerationJobManager,
      });
      expect(runtime.graphOptions()).toEqual({ hitlCapable: false });
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
          1,
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
              res.json({
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

  it('keeps final output private until provider drain and prevents a retried HTTP request starting another run', async () => {
    let release!: () => void;
    const trailingWrite = new Promise<void>((resolve) => {
      release = resolve;
    });
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
      try {
        await executeAgentRun({
          envelope,
          runId: runtime.responseId,
          conversationId: record.conversationId,
          connection: runtime.connection,
          ...runtime.hooks,
          isPrincipalActive: async () => true,
          execute: async (execution) => {
            starts++;
            execution.track(trailingWrite);
            res.json({
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
            });
          },
        });
        settled();
      } catch (error) {
        res
          .status(409)
          .json({ code: error instanceof Error && 'code' in error ? error.code : 'failed' });
      }
    });
    const token = mintBackgroundResponseWorkerToken(record, secret);
    const first = await request(app)
      .post('/')
      .set('x-lc-response-worker', '1')
      .auth(token, { type: 'bearer' })
      .send({});
    expect(first.status).toBe(202);
    expect((await scope(async () => storage.read(owner, record.responseId)))?.status).toBe(
      'in_progress',
    );
    const duplicate = await request(app)
      .post('/')
      .set('x-lc-response-worker', '1')
      .auth(token, { type: 'bearer' })
      .send({});
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('RUN_ALREADY_ADMITTED');
    expect(starts).toBe(1);
    release();
    await finished;
    const saved = await scope(async () => storage.read(owner, record.responseId));
    expect(saved?.status).toBe('completed');
    expect(JSON.parse(saved!.responseJSON!).output[0].content[0].text).toBe('# Exact final answer');
  });

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
            res.json({
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
      }).finish(pending),
    );
    expect(recovered.status).toBe('completed');
    expect(JSON.parse(recovered.responseJSON!).metadata.marker).toBe('exact-runtime-result');
    expect(recovered.pendingTerminal).toBeUndefined();
    expect(starts).toBe(1);
    publication.mockRestore();
  });

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
            res.status(409).json({ code: 'cancelled' });
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
              if (mode === 'stop')
                await GenerationJobManager.abortJob(runtime.responseId, {
                  expectedCreatedAt: execution.createdAt,
                });
              res.json({ ...buildPendingBackgroundResponse(record), status: 'completed' });
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
    },
  );
});
