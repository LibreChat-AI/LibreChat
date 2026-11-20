import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { FileSources, Constants } from 'librechat-data-provider';
import { HumanMessage } from '@librechat/agents/langchain/messages';
import { emptyCheckpoint, INTERRUPT } from '@langchain/langgraph-checkpoint';
import {
  createModels,
  createMethods,
  createResponseStorage,
  tenantStorage,
} from '@librechat/data-schemas';
import type { Agent, Agents, ResponseReviewDecision } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { ResponseResumeValidationDependencies } from './resume';
import {
  getAgentCheckpointer,
  __resetCheckpointerForTests,
  LIBRECHAT_CHECKPOINT_NAMESPACE_KEY,
} from '../checkpointer';
import {
  computeAgentRequestFingerprint,
  computeLegacyAgentRequestFingerprint,
} from '../hitl/policy';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import { createCheckpointNamespace } from '~/stream/checkpoints';
import { NO_CHAT_PROJECT_CONTEXT_KEY } from '~/projects/context';
import { resolveResponseReviewDecision } from './decision';
import { enrollAgentExecution } from '../remote/lifecycle';
import { captureRunPendingAction } from '../hitl/capture';
import { createResponseResumeValidation } from './resume';
import { canonicalResponseJSON } from './background';

const owner = { userId: new mongoose.Types.ObjectId().toString(), tenantId: 'preflight-tenant' };
const responseId = 'resp_preflight';
const conversationId = 'conversation';
const checkpointConfig = {
  type: 'mongo' as const,
  ttl: 3600,
  checkpointCollectionName: 'preflight_checkpoints',
  checkpointWritesCollectionName: 'preflight_writes',
};
let mongo: MongoMemoryReplSet;
let manager: GenerationJobManagerClass;
const scoped = <T>(work: () => Promise<T>) => tenantStorage.run(owner, work);
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  createModels(mongoose);
  await scoped(async () => {
    await mongoose.models.User.create({
      _id: owner.userId,
      tenantId: owner.tenantId,
      email: 'preflight@example.com',
      provider: 'local',
      role: 'USER',
    });
  });
});
beforeEach(async () => {
  __resetCheckpointerForTests();
  for (const name of [
    'storedresponses',
    'responsescopes',
    checkpointConfig.checkpointCollectionName,
    checkpointConfig.checkpointWritesCollectionName,
  ])
    await mongoose.connection.db!.collection(name).deleteMany({});
  manager = new GenerationJobManagerClass();
  manager.configure({
    jobStore: new InMemoryJobStore(),
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

function agent(id: string): Agent {
  return {
    id,
    name: id,
    description: null,
    created_at: 1,
    avatar: null,
    provider: 'openAI',
    model: 'model',
    model_parameters: {
      temperature: null,
      maxContextTokens: null,
      max_context_tokens: null,
      max_output_tokens: null,
      top_p: null,
      frequency_penalty: null,
      presence_penalty: null,
    },
  };
}

async function fixture(
  payload: Agents.HumanInterruptPayload = {
    type: 'ask_user_question',
    question: { question: 'Continue?' },
  },
  childId = 'child',
) {
  const methods = createMethods(mongoose);
  const storage = createResponseStorage(mongoose);
  const original = { model: 'agent', input: 'Original' };
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
  const saved = await storage.reserve({
    ...owner,
    responseId,
    requestKey: 'request',
    fingerprint: 'request',
    agentId: 'agent',
    sourceKeyId: 'key',
    conversationId,
    parentMessageId: 'root',
    requestJSON: JSON.stringify(original),
  });
  if (!saved.ok) throw new Error('Reservation failed');
  await storage.publish(owner, responseId, 0, {
    status: 'in_progress',
    generationCreatedAt: execution.createdAt,
    responseJSON: '{}',
  });
  await execution.beginProviderExecution();
  const initialJob = await manager.getJob(responseId);
  const providerExecutionId = initialJob?.metadata.providerExecutionId;
  if (!providerExecutionId) throw new Error('Provider identity missing');
  const namespace = createCheckpointNamespace(owner.userId, owner.tenantId);
  const checkpoint = emptyCheckpoint();
  checkpoint.channel_values.messages = [
    new HumanMessage({ content: 'Original', id: 'user-message' }),
  ];
  const config = {
    configurable: {
      thread_id: conversationId,
      checkpoint_ns: '',
      [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: namespace,
    },
  };
  const saver = await getAgentCheckpointer(checkpointConfig);
  if (!saver) throw new Error('Saver unavailable');
  await saver.putWrites(
    { configurable: { ...config.configurable, checkpoint_id: checkpoint.id } },
    [[INTERRUPT, { id: 'interrupt', value: payload }]],
    'task',
  );
  await saver.put(config, checkpoint, { source: 'input', step: -1, parents: {} });
  const action = captureRunPendingAction({
    run: {},
    payload,
    agents: [{ id: 'agent' }, { id: childId }],
    resumeAgentIds: ['agent', childId],
    aliases: [],
    context: {
      streamId: responseId,
      responseMessageId: responseId,
      conversationId,
      threadId: conversationId,
      interruptId: 'interrupt',
      ttlMs: 60_000,
      projectContextKey: NO_CHAT_PROJECT_CONTEXT_KEY,
      requestFingerprint: computeLegacyAgentRequestFingerprint(original),
      requestFingerprintV2: computeAgentRequestFingerprint(original),
    },
  });
  await manager.getJobStore().updateJob(responseId, {
    checkpointNamespace: namespace,
    userMessage: {
      messageId: 'user-message',
      parentMessageId: String(Constants.NO_PARENT),
      text: 'Original',
    },
  });
  if (
    !(await execution.pauseForReview(action, async () => {
      const published = await storage.publishReview(
        owner,
        responseId,
        { execution: (await storage.read(owner, responseId))! },
        execution.createdAt,
        {
          actionId: action.actionId,
          providerExecutionId: providerExecutionId,
          expiresAt: action.expiresAt!,
          partialResponseJSON: '{}',
          pendingActionJSON: JSON.stringify(action),
          checkpointConfigJSON: JSON.stringify(checkpointConfig),
          checkpointId: checkpoint.id,
          checkpointNs: '',
        },
        '{}',
      );
      if (!published.ok) throw new Error('Pause publication failed');
    }))
  )
    throw new Error('Pause failed');
  await execution.settle();
  let decision: ResponseReviewDecision;
  if (payload.type === 'tool_approval')
    decision = {
      actionId: action.actionId,
      decisions: [
        {
          tool_call_id: 'answers',
          decision: 'edit',
          editedArguments: { query: 'PRIVATE-ARGUMENT' },
        },
      ],
    };
  else if (payload.questions?.length)
    decision = {
      actionId: action.actionId,
      answers: Object.fromEntries(payload.questions.map((question) => [question.id, 'yes'])),
    };
  else decision = { actionId: action.actionId, answer: 'yes' };
  const mapped = resolveResponseReviewDecision(action, decision);
  if (!('resolution' in mapped)) throw new Error('Invalid fixture resolution');
  const reserved = await storage.reserveResume(
    owner,
    responseId,
    {
      generationCreatedAt: execution.createdAt,
      intentId: 'intent',
      actionId: action.actionId,
      previousProviderExecutionId: providerExecutionId,
      providerExecutionId: 'selected-provider',
      fingerprint: 'decision',
      decisionJSON: canonicalResponseJSON(decision),
      resolutionJSON: canonicalResponseJSON(mapped.resolution.value),
    },
    Date.now(),
  );
  if (!reserved.ok) throw new Error('Intent reservation failed');
  const primary = { ...agent('agent'), agent_ids: [childId] };
  const graph = new Map<string, Agent>([
    ['agent', primary],
    [childId, agent(childId)],
  ]);
  const denied = new Set<string>();
  const configValue: AppConfig = {
    config: {},
    fileStrategy: FileSources.local,
    imageOutputType: 'webp',
    endpoints: { agents: { checkpointer: checkpointConfig } },
    filters: {},
  };
  const deps: ResponseResumeValidationDependencies = {
    findUser: (id) => methods.findUser({ _id: id }),
    getConfig: jest.fn().mockResolvedValue(configValue),
    jobs: manager,
    projects: {
      getConvo: async () => null,
      getChatProject: async () => null,
      getProjectFiles: async () => [],
    },
    content: {
      getAgentCheckpointer,
      getAgent: jest.fn(async ({ id }) => graph.get(id) ?? null),
      canAccessAgent: jest.fn(async (candidate) => !denied.has(candidate.id)),
      getMessages: jest.fn().mockResolvedValue([
        {
          messageId: 'user-message',
          parentMessageId: String(Constants.NO_PARENT),
          conversationId,
          text: 'Original',
          isCreatedByUser: true,
        },
      ]),
      getFiles: async () => [],
      getActions: async () => [],
      getUserMemories: async () => [],
      getRoleByName: jest.fn().mockResolvedValue({ permissions: {} }),
      checkAccess: async () => true,
      decryptMetadata: async (metadata) => metadata,
    },
  };
  const job = await manager.getJob(responseId);
  if (!job) throw new Error('Job missing');
  return {
    deps,
    graph,
    denied,
    primary,
    configValue,
    validation: createResponseResumeValidation(deps),
    input: { record: reserved.record, job, action, decision, resolution: mapped.resolution },
  };
}

it('validates a durable pause with all participants even when content filters are disabled', () =>
  scoped(async () => {
    const f = await fixture();
    expect(await f.validation.validateDecision(f.input)).toBe(true);
    expect(await f.validation.validateResume(f.input.record, f.input.job)).toMatchObject({
      ok: true,
    });
    expect(f.deps.content.getAgent).toHaveBeenCalledWith({ id: 'child' });
  }));

it.each(['revoked', 'removed', 'missing-reference'])(
  'rejects %s participant authority with filters disabled',
  (failure) =>
    scoped(async () => {
      const f = await fixture();
      if (failure === 'revoked') f.denied.add('child');
      if (failure === 'removed') {
        f.primary.agent_ids = [];
        f.graph.delete('child');
      }
      if (failure === 'missing-reference') f.primary.agent_ids.push('missing');
      expect(await f.validation.validateDecision(f.input)).toBe(false);
      expect(await f.validation.validateResume(f.input.record, f.input.job)).toEqual({ ok: false });
      expect(f.deps.content.getMessages).not.toHaveBeenCalled();
    }),
);

it.each([undefined, '', 'null', '{invalid'])(
  'controls missing or malformed retained checkpoint settings %p',
  (checkpointConfigJSON) =>
    scoped(async () => {
      const f = await fixture();
      f.input.record.review!.checkpointConfigJSON = checkpointConfigJSON;
      expect(await f.validation.validateDecision(f.input)).toBe(false);
      expect(await f.validation.validateResume(f.input.record, f.input.job)).toEqual({ ok: false });
    }),
);

it('rejects a legacy pause without a participant witness', () =>
  scoped(async () => {
    const f = await fixture();
    delete f.input.action.resumeAgentIds;
    f.input.record.review!.pendingActionJSON = JSON.stringify(f.input.action);
    expect(await f.validation.validateDecision(f.input)).toBe(false);
    expect(await f.validation.validateResume(f.input.record, f.input.job)).toEqual({ ok: false });
  }));

it('inspects edited arguments for a tool call named answers under tool-argument-only policy', () =>
  scoped(async () => {
    const payload: Agents.ToolApprovalInterruptPayload = {
      type: 'tool_approval',
      action_requests: [{ name: 'lookup', tool_call_id: 'answers', arguments: {} }],
      review_configs: [
        { action_name: 'lookup', tool_call_id: 'answers', allowed_decisions: ['edit'] },
      ],
    };
    const f = await fixture(payload);
    jest.mocked(f.deps.getConfig).mockResolvedValue({
      ...f.configValue,
      filters: {
        toolArguments: {
          pii: {
            starterPatterns: [],
            customPatterns: [{ id: 'private', label: 'private', regex: 'PRIVATE-ARGUMENT' }],
          },
        },
      },
    });
    await expect(f.validation.validateDecision(f.input)).rejects.toMatchObject({
      code: 'content_filter_block',
    });
    await expect(f.validation.validateResume(f.input.record, f.input.job)).rejects.toMatchObject({
      code: 'content_filter_block',
    });
  }));

it('rejects an inaccessible configured graph member outside the retained participant set', () =>
  scoped(async () => {
    const f = await fixture();
    f.primary.agent_ids = [];
    f.primary.subagents = {
      enabled: true,
      graphs: [
        {
          type: 'team',
          name: 'Team',
          description: 'Team',
          agent_ids: ['child', 'graph-member'],
          edges: [],
          entry_agent_id: 'child',
          result_agent_id: 'graph-member',
        },
      ],
    };
    f.graph.set('graph-member', agent('graph-member'));
    f.denied.add('graph-member');
    expect(await f.validation.validateDecision(f.input)).toBe(false);
    expect(await f.validation.validateResume(f.input.record, f.input.job)).toEqual({ ok: false });
  }));

it('retains authority checks for a paused child removed from current graph settings', () =>
  scoped(async () => {
    const f = await fixture();
    f.primary.agent_ids = [];
    f.denied.add('child');
    expect(await f.validation.validateDecision(f.input)).toBe(false);
    expect(await f.validation.validateResume(f.input.record, f.input.job)).toEqual({ ok: false });
  }));

it('preserves a complete question batch through durable decision and worker validation', () =>
  scoped(async () => {
    const f = await fixture({
      type: 'ask_user_question',
      question: { question: 'Environment?' },
      questions: [
        { id: 'environment', question: 'Environment?' },
        { id: 'window', question: 'Window?' },
      ],
    });
    expect(f.input.resolution).toEqual({
      type: 'ask_user_question',
      value: { answers: { environment: 'yes', window: 'yes' } },
    });
    expect(await f.validation.validateDecision(f.input)).toBe(true);
    expect(await f.validation.validateResume(f.input.record, f.input.job)).toMatchObject({
      ok: true,
    });
  }));

it('accepts existing authorized agent identifiers beyond an arbitrary 256-character cap', () =>
  scoped(async () => {
    const f = await fixture(undefined, 'participant-'.repeat(30));
    expect(await f.validation.validateDecision(f.input)).toBe(true);
    expect(await f.validation.validateResume(f.input.record, f.input.job)).toMatchObject({
      ok: true,
    });
  }));
