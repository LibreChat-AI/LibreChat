import { z } from 'zod';
import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { tool } from '@langchain/core/tools';
import { FileSources } from 'librechat-data-provider';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Run, Providers, Constants } from '@librechat/agents';
import { FakeChatModel } from '@langchain/core/utils/testing';
import { AIMessageChunk, HumanMessage } from '@langchain/core/messages';
import {
  createResponseStorage,
  tenantStorage,
  runAsSystem,
  createModels,
  createMethods,
} from '@librechat/data-schemas';
import type { AppConfig, ResponseStorage } from '@librechat/data-schemas';
import type { RunInterruptResult, RunConfig } from '@librechat/agents';
import type { BaseMessage } from '@langchain/core/messages';
import type { Agent } from 'librechat-data-provider';
import type { AgentExecutionEnrollment } from '../remote/lifecycle';
import type { ResponseExecutionRuntime } from './runtime';
import type { ServerRequest } from '~/types/http';
import type { createRun } from '../run';
import {
  buildAggregatedResponse,
  createAggregatorEventHandlers,
  createResponseAggregator,
  createResponseContext,
} from './service';
import {
  createBackgroundResponseWorkerAuth,
  mintResponseResumeWorkerToken,
  mintBackgroundResponseWorkerToken,
} from './worker';
import {
  buildPendingAction,
  computeAgentRequestFingerprint,
  computeLegacyAgentRequestFingerprint,
} from '../hitl/policy';
import {
  getAgentCheckpointer,
  LIBRECHAT_CHECKPOINT_NAMESPACE_KEY,
  __resetCheckpointerForTests,
} from '../checkpointer';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { createResponseResumeAdmission, createResponseResumeValidation } from './resume';
import { createResponseCompletion, createResponseExecutionRelease } from './completion';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { createAskUserQuestionTool } from '../hitl/askUserQuestionTool';
import { createResponseAccountingCollector } from './accounting';
import { NO_CHAT_PROJECT_CONTEXT_KEY } from '~/projects/context';
import { buildPendingBackgroundResponse } from './background';
import { createResponseDecisionSubmission } from './decision';
import { resolveToolApprovalResume } from '../hitl/resume';
import { enrollAgentExecution } from '../remote/lifecycle';
import { createResponseExecutionRuntime } from './runtime';
import { captureRunPendingAction } from '../hitl/capture';
import { cleanupResponseCheckpoint } from './checkpoint';
import { createResponseRetirement } from './retirement';
import { buildHITLRunWiring } from '../hitl/runtime';
import { GenerationJobManagerClass } from '~/stream';
import { createAgentRunEnvelope } from '../envelope';
import { pauseResponseForReview } from './pause';
import { executeAgentRun } from '../remote/host';

let mongo: MongoMemoryReplSet;
let storage: ResponseStorage;
let manager: GenerationJobManagerClass;
const owner = { userId: '000000000000000000000012', tenantId: 'sdk-pause-tenant' };
const responseId = 'resp_sdk_pause';
const conversationId = 'sdk-pause-conversation';
const scoped = <T>(work: () => Promise<T>) => tenantStorage.run(owner, work);
const checkpointer = { type: 'mongo' as const, ttl: 3600 };

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ args: ['--nounixsocket'] }],
  });
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  createModels(mongoose);
  storage = createResponseStorage(mongoose);
});
beforeEach(async () => {
  __resetCheckpointerForTests();
  await runAsSystem(async () => {
    await mongoose.models.StoredResponse.deleteMany({});
    await mongoose.models.ResponseScope?.deleteMany({});
  });
  manager = new GenerationJobManagerClass();
  manager.configure({
    jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
    eventTransport: new InMemoryEventTransport(),
    cleanupOnComplete: false,
  });
  manager.initialize();
});
afterEach(async () => {
  await manager.destroy();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

async function reserveOriginal() {
  return storage.reserve({
    ...owner,
    responseId,
    requestKey: 'request',
    fingerprint: 'request',
    agentId: 'agent',
    sourceKeyId: 'key',
    requestJSON: JSON.stringify({
      model: 'agent',
      input: 'Ask which environment.',
      background: true,
      store: true,
    }),
    conversationId,
    parentMessageId: 'root',
  });
}

async function setup(
  onEnrolled?: (execution: AgentExecutionEnrollment) => Promise<void>,
  processRun?: ResponseExecutionRuntime['processRun'],
  toolReviews = false,
  reviewedToolName = 'review_lookup',
) {
  const execution = await enrollAgentExecution(
    {
      runId: responseId,
      userId: owner.userId,
      conversationId,
      agentId: 'agent',
      protocol: 'responses',
      isPrincipalActive: async () => true,
    },
    { manager },
  );
  await reserveOriginal();
  if (onEnrolled) await onEnrolled(execution);
  else
    await storage.publish(owner, responseId, 0, {
      status: 'in_progress',
      responseJSON: '{}',
      generationCreatedAt: execution.createdAt,
    });
  await execution.beginProviderExecution();
  const job = (await manager.getJob(responseId))!;
  const saver = await getAgentCheckpointer(checkpointer);
  if (!saver || !job.metadata.checkpointNamespace) throw new Error('Missing real durable saver');
  const config = {
    configurable: {
      thread_id: conversationId,
      [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: job.metadata.checkpointNamespace,
    },
    version: 'v2' as const,
  };
  let modelCalls = 0;
  let toolExecutions = 0;
  const buildRun = async (customHandlers?: RunConfig['customHandlers']) => {
    const wiring = toolReviews ? buildHITLRunWiring({ enabled: true }) : undefined;
    const run = await Run.create({
      runId: responseId,
      skipCleanup: true,
      tokenCounter: () => 1,
      customHandlers,
      humanInTheLoop: { enabled: true },
      hooks: wiring?.hooks,
      interruptingToolNames: toolReviews ? [] : ['ask_user_question'],
      graphConfig: {
        type: 'standard',
        maxContextTokens: 100_000,
        llmConfig: { provider: Providers.OPENAI, streaming: false, streamUsage: false },
        compileOptions: { checkpointer: saver },
        tools: toolReviews
          ? [
              tool(
                async ({ value }) => {
                  toolExecutions++;
                  return value;
                },
                {
                  name: reviewedToolName,
                  description: 'A reviewed lookup',
                  schema: z.object({ value: z.string() }),
                },
              ),
            ]
          : [createAskUserQuestionTool()],
      },
    });
    if (!run.Graph) throw new Error('Missing SDK graph');
    const model = new FakeChatModel({});
    model._generate = async (messages: BaseMessage[]) => {
      modelCalls++;
      const answer = messages.find((message) => message.getType() === 'tool');
      if (toolReviews) {
        const results = messages.filter((message) => message.getType() === 'tool').length;
        return {
          generations: [
            {
              text: '',
              message:
                results < 2
                  ? new AIMessageChunk({
                      content: '',
                      tool_calls: [
                        {
                          id: `review-${results + 1}`,
                          name: reviewedToolName,
                          args: { value: `result-${results + 1}` },
                        },
                      ],
                    })
                  : new AIMessageChunk({ content: 'Both reviewed calls completed.' }),
            },
          ],
        };
      }
      const message = answer
        ? new AIMessageChunk({
            content: `Received ${String(answer.content)}`,
            usage_metadata: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
          })
        : new AIMessageChunk({
            content: '',
            usage_metadata: { input_tokens: 7, output_tokens: 7, total_tokens: 14 },
            tool_calls: [
              {
                id: 'ask-environment',
                name: 'ask_user_question',
                args: { questions: [{ id: 'environment', question: 'Which environment?' }] },
              },
            ],
          });
      return {
        generations: [
          { message, text: typeof message.content === 'string' ? message.content : '' },
        ],
      };
    };
    run.Graph.overrideModel = model;
    return run;
  };
  const run = await buildRun();
  const input = { messages: [new HumanMessage('Ask which environment.')] };
  if (processRun) await processRun(run, input, config);
  else await run.processStream(input, config);
  const record = (await storage.read(owner, responseId))!;
  const partial = buildPendingBackgroundResponse(record);
  let unfinishedWrites = 0;
  const deps = {
    storage,
    jobs: manager,
    buildAction: async (interrupt: RunInterruptResult) =>
      buildPendingAction(interrupt.payload, {
        streamId: responseId,
        responseMessageId: responseId,
        conversationId,
        threadId: interrupt.threadId ?? conversationId,
        runId: interrupt.checkpointNs ?? responseId,
        interruptId: interrupt.interruptId,
        ttlMs: 60_000,
        projectContextKey: 'private-project-binding',
        requestFingerprint: computeLegacyAgentRequestFingerprint(JSON.parse(record.requestJSON)),
        requestFingerprintV2: computeAgentRequestFingerprint(JSON.parse(record.requestJSON)),
        resumeContext: {
          discoveredToolNames: ['retained_lookup'],
          responseParentMessageId: 'original-user-message',
        },
      }),
    persistUnfinished: async () => {
      await mongoose.connection
        .db!.collection('sdk_unfinished_turns')
        .insertOne({ responseId, generationCreatedAt: execution.createdAt });
      unfinishedWrites++;
    },
  };
  return {
    run,
    buildRun,
    execution,
    record,
    partial,
    config,
    deps,
    modelCalls: () => modelCalls,
    toolExecutions: () => toolExecutions,
    unfinishedWrites: () => unfinishedWrites,
  };
}

it.each([false, true])(
  'retains a real SDK pause or cleans its checkpoint after initial persistence failure (%s)',
  (failPersistence) =>
    scoped(async () => {
      const reserved = await reserveOriginal();
      if (!reserved.ok) throw new Error('Reservation failed');
      const secret = 'runtime-pause-test-secret';
      const user = new mongoose.models.User({
        _id: owner.userId,
        tenantId: owner.tenantId,
        email: 'pause@example.test',
      });
      const errors: unknown[] = [];
      const complete = jest.fn(async () => 'must not complete');
      const order: string[] = [];
      let done!: () => void;
      const finished = new Promise<void>((resolve) => {
        done = resolve;
      });
      const app = express();
      app.use(express.json());
      app.use(
        createBackgroundResponseWorkerAuth(
          {
            storage,
            signingSecret: () => secret,
            findUser: async () => user,
            authorize: async () => true,
            admitResume: async () => ({ ok: false, code: 'response_resume_unavailable' }),
            onError: (error) => {
              errors.push(error);
            },
          },
          (_req, res) => {
            res.status(401).end();
          },
        ),
      );
      app.post('/', async (req, res) => {
        try {
          (req as ServerRequest).config = {
            config: {},
            fileStrategy: FileSources.local,
            imageOutputType: 'png',
            endpoints: { agents: { checkpointer } },
          };
          const runtime = createResponseExecutionRuntime(req, res, {
            getMessage: async () => null,
            jobs: manager,
          });
          expect(
            runtime.inputChain({
              messages: [{ messageId: 'original-user-message' }],
              parentMessageId: 'original-user-message',
            }).messages,
          ).toHaveLength(1);
          expect(runtime.graphOptions()).toMatchObject({ hitlCapable: true });
          const f = await setup(
            async (execution) => {
              await runtime.hooks.onEnrolled!(execution);
            },
            (run, input, config) =>
              runtime.processRun(run, input, {
                ...config,
                configurable: {
                  thread_id: 'wrong-thread',
                  [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: 'wrong-owner-namespace',
                },
              }),
          );
          await runtime
            .completeTurn(
              {
                run: f.run,
                execution: f.execution,
                agents: [],
                visibleOutputTokens: 0,
                buildPartial: () => f.partial,
                persistence: {
                  saveConversation: async () => {
                    order.push('conversation');
                  },
                  saveInput: async () => {
                    order.push('input');
                  },
                  saveOutput: async (partial) => {
                    order.push('output');
                    if (failPersistence) throw new Error('Injected unfinished output failure');
                    await mongoose.connection.db!.collection('runtime_unfinished_turns').insertOne({
                      responseId,
                      epoch: f.execution.createdAt,
                      responseJSON: JSON.stringify(partial),
                    });
                  },
                },
              },
              complete,
            )
            .catch(async (error) => {
              if (!failPersistence) throw error;
              await f.execution.settle(error);
              await runtime.hooks.afterSettle!(f.execution, error);
            });
          await f.execution.settle();
          await runtime.hooks.afterSettle!(f.execution, undefined);
          expect(f.execution.isPaused).toBe(!failPersistence);
          expect(f.modelCalls()).toBe(1);
        } catch (error) {
          errors.push(error);
          if (!res.writableEnded) res.status(500).end();
        } finally {
          done();
        }
      });
      await request(app)
        .post('/')
        .set('x-lc-response-worker', '1')
        .auth(mintBackgroundResponseWorkerToken(reserved.record, secret), { type: 'bearer' })
        .send({})
        .expect(202);
      await finished;
      expect(errors).toEqual([]);
      expect(complete).not.toHaveBeenCalled();
      expect(order).toEqual(['conversation', 'input', 'output']);
      const record = (await storage.read(owner, responseId))!;
      if (failPersistence) {
        expect(record.status).toBe('failed');
        expect(record.review).toBeUndefined();
        expect(record.pendingTerminal).toBeUndefined();
        const job = (await manager.getJob(responseId))!;
        expect(
          await (await getAgentCheckpointer(checkpointer))!.getTuple({
            configurable: {
              thread_id: conversationId,
              [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: job.metadata.checkpointNamespace,
            },
          }),
        ).toBeUndefined();
        return;
      }
      expect(record.status).toBe('requires_action');
      expect(record.pendingTerminal).toBeUndefined();
      expect(JSON.parse(record.review!.pendingActionJSON!)).toMatchObject({
        streamId: responseId,
        responseMessageId: responseId,
        conversationId,
        payload: { type: 'ask_user_question' },
        requestFingerprintV2: expect.any(String),
      });
      const saved = await mongoose.connection
        .db!.collection('runtime_unfinished_turns')
        .findOne({ responseId, epoch: record.generationCreatedAt });
      expect(JSON.parse(saved!.responseJSON)).toMatchObject({
        id: responseId,
        status: 'in_progress',
      });
      expect(JSON.parse(record.responseJSON!).output).toEqual([]);
    }),
);

it('captures a real SDK question interrupt and cancels its actual durable checkpoint safely', () =>
  scoped(async () => {
    const f = await setup();
    const interrupt = f.run.getInterrupt();
    expect(interrupt?.payload.type).toBe('ask_user_question');
    expect(interrupt?.checkpointId).toEqual(expect.any(String));
    expect({
      recordId: f.record.responseId,
      executionId: f.execution.runId,
      epoch: f.record.generationCreatedAt === f.execution.createdAt,
      metadata: (await manager.getJob(responseId))!.metadata,
      partialId: f.partial.id,
      partialModel: f.partial.model,
      thread: interrupt?.threadId,
    }).toMatchObject({
      recordId: responseId,
      executionId: responseId,
      epoch: true,
      metadata: {
        userId: owner.userId,
        tenantId: owner.tenantId,
        agent_id: 'agent',
        endpoint: 'responses',
        conversationId,
        checkpointNamespace: expect.stringContaining('lcg:v2:'),
      },
      partialId: responseId,
      partialModel: 'agent',
      thread: conversationId,
    });
    expect(await pauseResponseForReview({ ...f, checkpointer }, f.deps)).toBe(true);
    await f.execution.settle();
    expect(f.execution.isPaused).toBe(true);
    expect(f.unfinishedWrites()).toBe(1);
    const saved = (await storage.read(owner, responseId))!;
    expect(saved).toMatchObject({
      status: 'requires_action',
      review: {
        checkpointId: interrupt!.checkpointId,
        checkpointNs: interrupt!.checkpointNs ?? '',
        pendingActionJSON: expect.stringContaining('Which environment?'),
      },
    });
    expect(saved.responseJSON).not.toContain('Which environment?');
    expect(saved.responseJSON).not.toContain('private-project-binding');
    const retire = createResponseRetirement({
      storage,
      jobs: manager,
      cleanupCheckpoint: cleanupResponseCheckpoint,
    });
    expect(await retire(owner, responseId)).toBe('stopped');
    expect((await storage.read(owner, responseId))?.status).toBe('cancelled');
    const saver = await getAgentCheckpointer(checkpointer);
    expect(await saver!.getTuple(f.config)).toBeUndefined();
  }));

it.each(['cleanup', 'stage'] as const)(
  'recovers a real SDK paused Stop after %s failure with default job cleanup',
  (failure) =>
    scoped(async () => {
      manager.configure({
        jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
        eventTransport: new InMemoryEventTransport(),
      });
      const f = await setup();
      expect(
        await pauseResponseForReview({ ...f, visibleOutputTokens: 0, checkpointer }, f.deps),
      ).toBe(true);
      await f.execution.settle();
      let failing = true;
      const originalStage = storage.stageTerminal.bind(storage);
      if (failure === 'stage')
        jest.spyOn(storage, 'stageTerminal').mockImplementation(async (...args) => {
          if (failing) throw new Error('Injected paused cancellation stage failure');
          return originalStage(...args);
        });
      const cleanup = async (
        record: Parameters<typeof cleanupResponseCheckpoint>[0],
        namespace: string,
      ) => {
        if (failure === 'cleanup' && failing)
          throw new Error('Injected paused checkpoint cleanup failure');
        await cleanupResponseCheckpoint(record, namespace);
      };
      const freshRetirement = () => {
        const completion = createResponseCompletion({
          storage,
          cleanupCheckpoint: cleanup,
          releaseExecution: createResponseExecutionRelease(manager),
        });
        return createResponseRetirement({
          storage,
          jobs: manager,
          cleanupCheckpoint: cleanup,
          recoverTerminal: completion.finish,
        });
      };
      await expect(freshRetirement()(owner, responseId)).rejects.toThrow();
      const saved = (await storage.read(owner, responseId))!;
      expect(saved.status).toBe('requires_action');
      if (failure === 'stage') {
        expect(saved.pendingTerminal).toBeUndefined();
        expect(await manager.getJob(responseId)).toMatchObject({
          status: 'aborted',
          createdAt: f.execution.createdAt,
          metadata: { providerDrained: true, terminalPersistencePending: true },
        });
      } else {
        expect(saved.pendingTerminal?.status).toBe('cancelled');
        expect(await manager.getJob(responseId)).toMatchObject({
          status: 'aborted',
          createdAt: f.execution.createdAt,
          metadata: {
            providerExecutionId: saved.pendingTerminal!.providerExecutionId,
            providerDrained: true,
            terminalPersistencePending: true,
          },
        });
      }
      expect(await (await getAgentCheckpointer(checkpointer))!.getTuple(f.config)).toBeDefined();
      failing = false;
      expect(await freshRetirement()(owner, responseId)).toBe('stopped');
      const cancelled = (await storage.read(owner, responseId))!;
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.pendingTerminal).toBeUndefined();
      expect(await manager.getJob(responseId)).toBeUndefined();
      expect(await (await getAgentCheckpointer(checkpointer))!.getTuple(f.config)).toBeUndefined();
      expect(f.modelCalls()).toBe(1);
    }),
);

it.each(['unchanged', 'environment', 'definition', 'workspace'] as const)(
  'checks the actual resumed native-code target before SDK tool effects (%s)',
  (change) =>
    scoped(async () => {
      const f = await setup(undefined, undefined, true, Constants.BASH_TOOL);
      const agent: Parameters<typeof createRun>[0]['agents'][number] = {
        id: 'agent',
        name: 'Code agent',
        description: null,
        created_at: 1,
        avatar: null,
        provider: 'openAI',
        model: 'fixture',
        model_parameters: {
          temperature: null,
          maxContextTokens: null,
          max_context_tokens: null,
          max_output_tokens: null,
          top_p: null,
          frequency_penalty: null,
          presence_penalty: null,
        },
        codeExecutionContext: {
          baseUrl: 'https://bridge.example/v1',
          codeSessionKey: 'private-session',
          executionProfile: 'stateful',
          statefulSessions: true,
          environmentId: 'environment-a',
          bridgeWorkerId: 'worker-a',
          codeWorkspace: {
            environmentId: 'environment-a',
            workspaceId: 'project-a',
            workspaceInstanceId: 'a'.repeat(64),
            operations: ['execute_command'],
            environment: { fingerprint: 'a'.repeat(64), actions: ['typecheck'] },
          },
        },
      };
      const buildAction = f.deps.buildAction;
      f.deps.buildAction = async (interrupt) =>
        captureRunPendingAction({
          run: f.run,
          payload: interrupt.payload,
          agents: [agent],
          aliases: [],
          context: { ...(await buildAction(interrupt)), ttlMs: 60_000 },
        });
      expect(f.toolExecutions()).toBe(0);
      expect(
        await pauseResponseForReview({ ...f, visibleOutputTokens: 0, checkpointer }, f.deps),
      ).toBe(true);
      await f.execution.settle();
      const paused = (await storage.read(owner, responseId))!;
      const action = JSON.parse(paused.review!.pendingActionJSON!);
      expect(action.codeExecutionBinding?.targets).toHaveLength(1);
      expect(JSON.stringify(action.codeExecutionBinding)).not.toContain('private-session');
      const decisions = [{ tool_call_id: 'review-1', decision: 'approve' as const }];
      const mapped = resolveToolApprovalResume(action.payload, decisions);
      if (!('resumeValue' in mapped)) throw new Error('Missing native-code decision');
      const reserved = await storage.reserveResume(
        owner,
        responseId,
        {
          generationCreatedAt: f.execution.createdAt,
          intentId: 'native-code-intent',
          actionId: action.actionId,
          previousProviderExecutionId: paused.review!.providerExecutionId,
          providerExecutionId: 'native-code-provider',
          fingerprint: 'native-code-review',
          decisionJSON: JSON.stringify({ actionId: action.actionId, decisions }),
          resolutionJSON: JSON.stringify(mapped.resumeValue),
        },
        Date.now(),
      );
      if (!reserved.ok) throw new Error('Missing native-code resume intent');
      const original = agent.codeExecutionContext!;
      const rebuiltAgent = {
        ...agent,
        codeExecutionContext: {
          ...original,
          environmentId: change === 'environment' ? 'environment-b' : original.environmentId,
          codeWorkspace: {
            ...original.codeWorkspace!,
            workspaceInstanceId:
              change === 'workspace' ? 'b'.repeat(64) : original.codeWorkspace!.workspaceInstanceId,
            environment: {
              ...original.codeWorkspace!.environment!,
              fingerprint:
                change === 'definition'
                  ? 'b'.repeat(64)
                  : original.codeWorkspace!.environment!.fingerprint,
            },
          },
        },
      };
      const admit = createResponseResumeAdmission({
        storage,
        jobs: manager,
        authorize: async () => true,
        validate: async () => ({ ok: true, provenance: {} }),
      });
      const user = new mongoose.models.User({ _id: owner.userId, tenantId: owner.tenantId });
      const errors: string[] = [];
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const app = express();
      app.use(express.json());
      app.use(
        createBackgroundResponseWorkerAuth(
          {
            storage,
            signingSecret: () => 'native-code-test-secret',
            findUser: async () => user,
            authorize: async () => true,
            admitResume: (record, _user, intentId) => admit(record, record.responseId, intentId),
            onError: () => {
              errors.push('authentication');
            },
          },
          (_req, res) => {
            res.status(401).end();
          },
        ),
      );
      app.post('/', async (req, res) => {
        (req as ServerRequest).config = {
          config: {},
          fileStrategy: FileSources.local,
          imageOutputType: 'png',
          endpoints: { agents: { checkpointer } },
        };
        const runtime = createResponseExecutionRuntime(req, res, {
          getMessage: async () => null,
          jobs: manager,
        });
        try {
          await executeAgentRun(
            {
              envelope: createAgentRunEnvelope({
                protocol: 'responses',
                requestId: responseId,
                receivedAt: Date.now(),
                principal: { id: owner.userId, tenantId: owner.tenantId },
                payload: req.body,
              }),
              runId: responseId,
              conversationId,
              ...runtime.hooks,
              isPrincipalActive: async () => true,
              execute: async (execution) => {
                expect(
                  runtime.graphOptions([rebuiltAgent]).reviewedToolApprovals?.decisions,
                ).toEqual(decisions);
                const rebuilt = await f.buildRun();
                await runtime.processRun(rebuilt, { messages: [] }, f.config);
                await runtime.completeTurn(
                  {
                    run: rebuilt,
                    execution,
                    agents: [rebuiltAgent],
                    buildPartial: () => f.partial,
                    visibleOutputTokens: 0,
                    persistence: {
                      saveConversation: async () => {},
                      saveInput: async () => {},
                      saveOutput: async () => {},
                    },
                  },
                  async () => {
                    throw new Error('Expected the second native-code review');
                  },
                );
              },
            },
            { manager },
          );
        } catch (error) {
          errors.push(error instanceof Error ? error.name : 'unexpected');
        } finally {
          finish();
        }
      });
      await request(app)
        .post('/')
        .set('x-lc-response-worker', '1')
        .auth(mintResponseResumeWorkerToken(reserved.record, 'native-code-test-secret'), {
          type: 'bearer',
        })
        .send({})
        .expect(202);
      await finished;
      expect(f.toolExecutions()).toBe(change === 'unchanged' ? 1 : 0);
      expect(f.modelCalls()).toBe(change === 'unchanged' ? 2 : 1);
      expect(errors).toEqual(
        change === 'unchanged' ? [] : ['CodeExecutionApprovalTargetChangedError'],
      );
      expect((await storage.read(owner, responseId))?.status).toBe(
        change === 'unchanged' ? 'requires_action' : 'failed',
      );
    }),
);

it('executes reviewed SDK tool calls once across two same-epoch pauses', () =>
  scoped(async () => {
    const f = await setup(undefined, undefined, true);
    let run = f.run;
    let record = f.record;
    let execution = f.execution;
    for (let round = 0; round < 2; round++) {
      expect(run.getInterrupt()?.payload.type).toBe('tool_approval');
      expect(f.toolExecutions()).toBe(round);
      if (round === 0) {
        expect(
          await pauseResponseForReview(
            { run, record, execution, partial: f.partial, visibleOutputTokens: 0, checkpointer },
            f.deps,
          ),
        ).toBe(true);
        await execution.settle();
      }
      record = (await storage.read(owner, responseId))!;
      const action = JSON.parse(record.review!.pendingActionJSON!);
      const decisions = [{ tool_call_id: `review-${round + 1}`, decision: 'approve' as const }];
      const mapped = resolveToolApprovalResume(action.payload, decisions);
      if (!('resumeValue' in mapped)) throw new Error('Missing SDK tool decision');
      const reserved = await storage.reserveResume(
        owner,
        responseId,
        {
          generationCreatedAt: execution.createdAt,
          intentId: `repeat-intent-${round}`,
          actionId: action.actionId,
          previousProviderExecutionId: record.review!.providerExecutionId,
          providerExecutionId: `repeat-provider-${round}`,
          fingerprint: `repeat-${round}`,
          decisionJSON: JSON.stringify({ actionId: action.actionId, decisions }),
          resolutionJSON: JSON.stringify(mapped.resumeValue),
        },
        Date.now(),
      );
      expect(reserved.ok).toBe(true);
      const admit = createResponseResumeAdmission({
        storage,
        jobs: manager,
        authorize: async () => true,
        validate: async () => ({ ok: true, provenance: {} }),
      });
      const admitted = await admit(owner, responseId, `repeat-intent-${round}`);
      if (!admitted.ok) throw new Error('Missing repeated SDK admission');
      record = admitted.record;
      run = await f.buildRun();
      const nextRun = run;
      await executeAgentRun(
        {
          envelope: createAgentRunEnvelope({
            protocol: 'responses',
            requestId: responseId,
            receivedAt: Date.now(),
            principal: { id: owner.userId, tenantId: owner.tenantId },
            payload: JSON.parse(record.requestJSON),
          }),
          runId: responseId,
          conversationId,
          isPrincipalActive: async () => true,
          resume: {
            generationCreatedAt: f.execution.createdAt,
            providerExecutionId: record.resume!.providerExecutionId,
          },
          execute: async (currentExecution) => {
            execution = currentExecution;
            await nextRun.resume(mapped.resumeValue, {
              ...f.config,
              configurable: {
                ...f.config.configurable,
                checkpoint_id: record.review!.checkpointId,
                checkpoint_ns: record.review!.checkpointNs,
              },
            });
            if (nextRun.getInterrupt()) {
              expect(
                await pauseResponseForReview(
                  {
                    run: nextRun,
                    record,
                    execution: currentExecution,
                    partial: f.partial,
                    visibleOutputTokens: 0,
                    checkpointer,
                  },
                  f.deps,
                ),
              ).toBe(true);
            }
          },
        },
        { manager },
      );
      if (round === 0) {
        record = (await storage.read(owner, responseId))!;
        expect(record.status).toBe('requires_action');
        expect(record.generationCreatedAt).toBe(f.execution.createdAt);
      }
    }
    expect(f.toolExecutions()).toBe(2);
    expect(f.modelCalls()).toBe(3);
    await cleanupResponseCheckpoint(
      record,
      (await manager.getJob(responseId))!.metadata.checkpointNamespace!,
    );
  }));

it('rebuilds the pinned SDK graph from the captured Mongo checkpoint and consumes the answer once', () =>
  scoped(async () => {
    const f = await setup();
    expect(await pauseResponseForReview({ ...f, checkpointer }, f.deps)).toBe(true);
    await f.execution.settle();
    expect(f.modelCalls()).toBe(1);
    const paused = (await storage.read(owner, responseId))!;
    const reserved = await storage.reserveResume(
      owner,
      responseId,
      {
        generationCreatedAt: f.execution.createdAt,
        intentId: 'sdk-resume-intent',
        actionId: paused.review!.actionId,
        previousProviderExecutionId: paused.review!.providerExecutionId,
        providerExecutionId: 'sdk-resumed-provider',
        fingerprint: 'sdk-owner-answer',
        resolutionJSON: JSON.stringify({ answers: { environment: 'staging' } }),
      },
      Date.now(),
    );
    if (!reserved.ok) throw new Error('Failed to reserve SDK resume');
    const admit = createResponseResumeAdmission({
      storage,
      jobs: manager,
      authorize: async () => true,
      // The host's full graph/tool-binding validator is a separate production integration.
      validate: async () => ({ ok: true, provenance: {} }),
    });
    const admitted = await admit(owner, responseId, 'sdk-resume-intent');
    if (!admitted.ok) throw new Error('Failed to admit SDK resume');
    const envelope = createAgentRunEnvelope({
      protocol: 'responses',
      requestId: 'sdk-resume-http',
      receivedAt: Date.now(),
      principal: { id: owner.userId, tenantId: owner.tenantId },
      payload: JSON.parse(admitted.record.requestJSON),
    });
    let final: ReturnType<typeof buildAggregatedResponse> | undefined;
    const response = await executeAgentRun(
      {
        envelope,
        runId: responseId,
        conversationId,
        isPrincipalActive: async () => true,
        resume: {
          generationCreatedAt: f.execution.createdAt,
          providerExecutionId: 'sdk-resumed-provider',
        },
        execute: async () => {
          const aggregator = createResponseAggregator();
          const rebuilt = await f.buildRun(createAggregatorEventHandlers(aggregator));
          await rebuilt.resume(JSON.parse(admitted.record.resume!.resolutionJSON), f.config);
          expect(rebuilt.getInterrupt()).toBeUndefined();
          final = {
            ...buildAggregatedResponse(
              createResponseContext(envelope.payload, responseId),
              aggregator,
            ),
            background: true,
            store: true,
          };
          return final;
        },
        afterSettle: async () => {
          if (!final) throw new Error('Missing resumed output');
          const current = (await storage.read(owner, responseId))!;
          await cleanupResponseCheckpoint(
            current,
            (await manager.getJob(responseId))!.metadata.checkpointNamespace!,
          );
          expect(
            (
              await storage.publish(owner, responseId, current.revision, {
                status: final.status,
                responseJSON: JSON.stringify(final),
                generationCreatedAt: f.execution.createdAt,
              })
            ).ok,
          ).toBe(true);
        },
      },
      { manager },
    );
    expect(f.modelCalls()).toBe(2);
    expect(response).toMatchObject({
      id: responseId,
      model: 'agent',
      status: 'completed',
      background: true,
      store: true,
    });
    expect(JSON.stringify(response.output)).toContain('staging');
    expect(await storage.read(owner, responseId)).toMatchObject({
      status: 'completed',
      generationCreatedAt: f.execution.createdAt,
      responseJSON: JSON.stringify(response),
    });
    expect(await manager.getJob(responseId)).toMatchObject({
      status: 'complete',
      createdAt: f.execution.createdAt,
      metadata: { providerExecutionId: 'sdk-resumed-provider', providerDrained: true },
    });
  }));

it('refuses a missing durable checkpoint before publishing a review action', () =>
  scoped(async () => {
    const f = await setup();
    const real = f.run.getInterrupt()!;
    await expect(
      pauseResponseForReview(
        {
          ...f,
          checkpointer,
          run: { getInterrupt: () => ({ ...real, checkpointId: 'not-a-durable-checkpoint' }) },
        },
        f.deps,
      ),
    ).rejects.toThrow('Response interrupt checkpoint is unavailable');
    expect((await storage.read(owner, responseId))?.status).toBe('in_progress');
    expect(f.unfinishedWrites()).toBe(0);
    await f.execution.settle(new Error('Checkpoint unavailable'));
  }));

it('replays a real SDK checkpoint through authenticated HTTP and the actual runtime publisher', () =>
  scoped(async () => {
    const f = await setup();
    const prefix = createResponseAggregator();
    prefix.addText('Before the checkpoint. ');
    prefix.toolCalls.set('ask-environment', {
      id: 'ask-environment',
      name: 'ask_user_question',
      arguments: JSON.stringify({
        questions: [{ id: 'environment', question: 'Which environment?' }],
      }),
    });
    const priorAccounting = createResponseAccountingCollector({
      quote: () => ({ amount: '0.1', basis: 'application_billing' }),
    });
    priorAccounting.record({ input_tokens: 7, output_tokens: 7 });
    const partial = {
      ...f.partial,
      output: buildAggregatedResponse({ responseId, model: 'agent', createdAt: 1 }, prefix).output,
      usage: {
        input_tokens: 7,
        output_tokens: 7,
        total_tokens: 14,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
      accounting: priorAccounting.snapshot(),
    };
    expect(
      await pauseResponseForReview({ ...f, partial, visibleOutputTokens: 7, checkpointer }, f.deps),
    ).toBe(true);
    await f.execution.settle();
    const paused = (await storage.read(owner, responseId))!;
    const reserved = await storage.reserveResume(
      owner,
      responseId,
      {
        generationCreatedAt: f.execution.createdAt,
        intentId: 'http-sdk-intent',
        actionId: paused.review!.actionId,
        previousProviderExecutionId: paused.review!.providerExecutionId,
        providerExecutionId: 'http-sdk-provider',
        fingerprint: 'owner-answer',
        decisionJSON: JSON.stringify({
          actionId: paused.review!.actionId,
          answers: { environment: 'staging' },
        }),
        resolutionJSON: JSON.stringify({ answers: { environment: 'staging' } }),
      },
      Date.now(),
    );
    if (!reserved.ok) throw new Error('Missing HTTP SDK intent');
    const admit = createResponseResumeAdmission({
      storage,
      jobs: manager,
      authorize: async () => true,
      validate: async () => ({ ok: true, provenance: {} }),
    });
    const secret = 'isolated-sdk-http-resume-secret';
    const user = new mongoose.models.User({
      _id: owner.userId,
      tenantId: owner.tenantId,
      email: 'sdk-resume@example.test',
    });
    const errors: unknown[] = [];
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const app = express();
    app.use(express.json());
    app.use(
      createBackgroundResponseWorkerAuth(
        {
          storage,
          signingSecret: () => secret,
          findUser: async () => user,
          authorize: async (record) => record.sourceKeyId === 'key',
          admitResume: (record, _user, intentId) => admit(record, responseId, intentId),
          onError: (error) => {
            errors.push(error);
          },
        },
        (_req, res) => {
          res.status(401).end();
        },
      ),
    );
    app.post('/', async (req, res) => {
      const runtime = createResponseExecutionRuntime(req, res, {
        getMessage: async () => null,
        jobs: manager,
      });
      expect(
        runtime.inputChain({
          messages: [{ messageId: 'fresh-duplicate-must-not-save' }],
          parentMessageId: 'fresh-duplicate-must-not-save',
        }),
      ).toEqual({
        messages: [],
        parentMessageId: 'original-user-message',
      });
      expect(runtime.graphOptions([])).toMatchObject({
        sessionStartSource: 'resume',
        discoveredToolNames: ['retained_lookup'],
        reviewedToolApprovals: { decisions: [] },
      });
      const envelope = createAgentRunEnvelope({
        protocol: 'responses',
        requestId: responseId,
        receivedAt: Date.now(),
        principal: { id: owner.userId, tenantId: owner.tenantId },
        payload: req.body,
      });
      try {
        await executeAgentRun(
          {
            envelope,
            runId: responseId,
            conversationId,
            ...runtime.hooks,
            isPrincipalActive: async () => true,
            execute: async () => {
              const aggregator = createResponseAggregator();
              runtime.seedAggregator(aggregator);
              const rebuilt = await f.buildRun(createAggregatorEventHandlers(aggregator));
              await runtime.processRun(rebuilt, { messages: [] }, f.config);
              const accounting = createResponseAccountingCollector({
                quote: () => ({ amount: '0.2', basis: 'application_billing' }),
              });
              accounting.record({
                input_tokens: aggregator.usage.inputTokens,
                output_tokens: aggregator.usage.outputTokens,
              });
              expect(runtime.visibleOutputTokens(aggregator.usage.outputTokens)).toBe(12);
              res.json(
                runtime.composeResponse(
                  buildAggregatedResponse(
                    createResponseContext(envelope.payload, responseId),
                    aggregator,
                    undefined,
                    accounting.snapshot(),
                  ),
                ),
              );
            },
            onSettlementError: (error) => {
              errors.push(error);
            },
          },
          { manager },
        );
      } catch (error) {
        errors.push(error);
        if (!res.writableEnded) res.status(409).end();
      } finally {
        finish();
      }
    });
    await request(app)
      .post('/')
      .set('x-lc-response-worker', '1')
      .auth(mintResponseResumeWorkerToken(reserved.record, secret), { type: 'bearer' })
      .send({ answers: { environment: 'attacker override' }, model: 'wrong-agent' })
      .expect(202);
    await finished;
    expect(errors).toEqual([]);
    const complete = (await storage.read(owner, responseId))!;
    expect(complete).toMatchObject({
      status: 'completed',
      generationCreatedAt: f.execution.createdAt,
    });
    const response = JSON.parse(complete.responseJSON!);
    expect(response).toMatchObject({
      id: responseId,
      model: 'agent',
      status: 'completed',
      background: true,
      store: true,
    });
    expect(JSON.stringify(response.output)).toContain('staging');
    expect(JSON.stringify(response.output)).not.toContain('attacker override');
    expect(JSON.stringify(response.output)).toContain('Before the checkpoint.');
    expect(
      response.output.filter((item: { type: string }) => item.type === 'function_call_output'),
    ).toHaveLength(1);
    expect(response.usage).toMatchObject({ input_tokens: 12, output_tokens: 12, total_tokens: 24 });
    expect(response.accounting).toMatchObject({ status: 'available', amount: '0.3' });
    expect(f.modelCalls()).toBe(2);
    expect(await (await getAgentCheckpointer(checkpointer))!.getTuple(f.config)).toBeUndefined();
  }));

it('uses production validation for a real retained question and rejects changed graph, project, access and checkpoint', () =>
  scoped(async () => {
    const f = await setup();
    const requestBody = JSON.parse(f.record.requestJSON);
    const buildAction = f.deps.buildAction;
    f.deps.buildAction = async (interrupt) => ({
      ...(await buildAction(interrupt)),
      projectContextKey: NO_CHAT_PROJECT_CONTEXT_KEY,
      requestFingerprint: computeLegacyAgentRequestFingerprint(requestBody),
      requestFingerprintV2: computeAgentRequestFingerprint(requestBody),
    });
    expect(await pauseResponseForReview({ ...f, checkpointer }, f.deps)).toBe(true);
    await f.execution.settle();
    await mongoose.models.User.create({
      _id: owner.userId,
      tenantId: owner.tenantId,
      role: 'USER',
      email: 'resume-validation@example.test',
    });
    const methods = createMethods(mongoose);
    const leanUser = await methods.findUser({ _id: owner.userId });
    expect(leanUser?._id.toString()).toBe(owner.userId);
    expect(leanUser?.id).toBeUndefined();
    const agent: Agent = {
      id: 'agent',
      name: 'Agent',
      description: null,
      created_at: 1,
      avatar: null,
      provider: 'openAI',
      model: 'fixture',
      model_parameters: {
        temperature: null,
        maxContextTokens: null,
        max_context_tokens: null,
        max_output_tokens: null,
        top_p: null,
        frequency_penalty: null,
        presence_penalty: null,
      },
      tools: ['ask_user_question'],
    };
    const config: AppConfig = {
      config: {},
      fileStrategy: FileSources.local,
      imageOutputType: 'png',
      endpoints: { agents: { checkpointer } },
    };
    let allowed = true;
    let projectId: string | null = null;
    const validation = createResponseResumeValidation({
      jobs: manager,
      findUser: (userId) => methods.findUser({ _id: userId }),
      getConfig: async (currentUser) => {
        expect(currentUser.id).toBe(owner.userId);
        return config;
      },
      projects: {
        getConvo: async () => ({
          conversationId,
          user: owner.userId,
          tenantId: owner.tenantId,
          chatProjectId: projectId,
        }),
        getChatProject: async () => ({
          _id: 'changed',
          instructions: 'changed',
          contextRevision: 1,
          file_ids: [],
          tenantId: owner.tenantId,
        }),
        getProjectFiles: async () => [],
      },
      content: {
        getAgentCheckpointer,
        getAgent: async () => agent,
        canAccessAgent: async (_agent, currentUser) =>
          allowed && currentUser.id === owner.userId && currentUser.tenantId === owner.tenantId,
        checkAccess: async () => true,
        getMessages: async () => [],
        getFiles: async () => [],
        getActions: async () => [],
        getUserMemories: async () => [],
        getRoleByName: async () => null,
        decryptMetadata: async (metadata) => metadata,
      },
    });
    const paused = (await storage.read(owner, responseId))!;
    const action = JSON.parse(paused.review!.pendingActionJSON!);
    const job = (await manager.getJob(responseId))!;
    const decision = { actionId: action.actionId, answers: { environment: 'staging' } };
    const input = {
      record: paused,
      job,
      action,
      decision,
      resolution: { answers: decision.answers },
    };
    expect(await validation.validateDecision(input)).toBe(true);
    allowed = false;
    expect(await validation.validateDecision(input)).toBe(false);
    allowed = true;
    projectId = 'changed';
    expect(await validation.validateDecision(input)).toBe(false);
    projectId = null;
    expect(
      await validation.validateDecision({
        ...input,
        action: { ...action, requestFingerprintV2: 'changed' },
      }),
    ).toBe(false);
    const enqueued: string[] = [];
    const submit = createResponseDecisionSubmission({
      storage,
      jobs: manager,
      authorize: async () => true,
      validate: validation.validateDecision,
      enqueue: async (record) => {
        enqueued.push(record.resume!.intentId);
      },
    });
    const submitted = await submit(owner, responseId, decision);
    expect(submitted.ok).toBe(true);
    expect(enqueued).toHaveLength(1);
    const admit = createResponseResumeAdmission({
      storage,
      jobs: manager,
      authorize: async () => true,
      validate: validation.validateResume,
    });
    const admitted = await admit(owner, responseId, enqueued[0]);
    expect(admitted.ok).toBe(true);
    const current = (await storage.read(owner, responseId))!;
    const rebuilt = await f.buildRun();
    await executeAgentRun(
      {
        envelope: createAgentRunEnvelope({
          protocol: 'responses',
          requestId: responseId,
          receivedAt: Date.now(),
          principal: { id: owner.userId, tenantId: owner.tenantId },
          payload: requestBody,
        }),
        runId: responseId,
        conversationId,
        isPrincipalActive: async () => true,
        resume: {
          generationCreatedAt: job.createdAt,
          providerExecutionId: current.resume!.providerExecutionId,
        },
        execute: async () =>
          rebuilt.resume(JSON.parse(current.resume!.resolutionJSON), {
            ...f.config,
            configurable: {
              ...f.config.configurable,
              checkpoint_id: current.review!.checkpointId,
              checkpoint_ns: current.review!.checkpointNs,
            },
          }),
      },
      { manager },
    );
    expect(f.modelCalls()).toBe(2);
    await cleanupResponseCheckpoint(current, job.metadata.checkpointNamespace!);
    expect(await validation.validateResume(current, (await manager.getJob(responseId))!)).toEqual({
      ok: false,
    });
    expect(f.modelCalls()).toBe(2);
  }));

it('does not expose a resumable action when unfinished-turn persistence fails', () =>
  scoped(async () => {
    const f = await setup();
    const failure = new Error('private unfinished-turn storage failure');
    await expect(
      pauseResponseForReview(
        { ...f, checkpointer },
        {
          ...f.deps,
          persistUnfinished: async () => {
            throw failure;
          },
        },
      ),
    ).rejects.toBe(failure);
    await f.execution.settle(failure);
    expect(f.execution.isPaused).toBe(false);
    const record = (await storage.read(owner, responseId))!;
    expect(record.review).toBeUndefined();
    expect(record.status).toBe('in_progress');
    const job = (await manager.getJob(responseId))!;
    expect(job).toMatchObject({ status: 'error', metadata: { providerDrained: true } });
    expect(JSON.stringify(job)).not.toContain(failure.message);
  }));
