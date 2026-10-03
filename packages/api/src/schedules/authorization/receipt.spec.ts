import { z } from 'zod';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { AIMessage } from '@librechat/agents/langchain/messages';
import { createModels, createMethods } from '@librechat/data-schemas';
import { Constants, HookRegistry, ToolNode, executeHooks } from '@librechat/agents';
import type { AppConfig, AgentGraphAccessContext } from '@librechat/data-schemas';
import type { SchedulesServiceDeps } from '../service';
import {
  createSchedulesService,
  createScheduledMCPPolicyRecorder,
  recordScheduledMCPToolAuthFailure,
} from '../service';
import { createScheduleMCPRuntimeHost, initializeWithScheduleMCPExecution } from './runtime';
import { createScheduleMCPExecution, getScheduleMCPExecution } from './execution';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { createAgentTriggerExecutionHost } from '~/agents/triggers/host';
import { createAgentTriggerEnvelope } from '~/agents/triggers/envelope';
import { GenerationJobManager } from '~/stream/GenerationJobManager';
import { executionFixture, readTool } from './execution.helper';
import { resolveScheduleMCPCompletion } from './continuation';
import { retainScheduleMCPCompletion } from './continuation';
import { createScheduleMCPConsentService } from './service';
import { createMCPRequestContext } from '~/mcp/request';
import { createScheduledMCPRunPolicy } from './run';
import { ScheduledMCPPolicyError } from './policy';

let mongo: MongoMemoryServer;
let store: InMemoryJobStore;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  await Promise.all([mongoose.models.Schedule.init(), mongoose.models.ScheduleRun.init()]);
}, 60_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
}, 60_000);
beforeEach(async () => {
  await Promise.all([
    mongoose.models.Schedule.deleteMany({}),
    mongoose.models.ScheduleRun.deleteMany({}),
  ]);
  store = new InMemoryJobStore();
  // The generation store is the injected external state. SDK policy and Mongo methods stay real.
  jest.spyOn(GenerationJobManager, 'getJobStore').mockReturnValue(store);
  jest
    .spyOn(GenerationJobManager, 'updateMetadata')
    .mockImplementation((id, patch, epoch) => store.updateJob(id, patch, epoch));
});
afterEach(async () => {
  jest.restoreAllMocks();
  await store.destroy();
});

async function setup(legacy = false) {
  const methods = createMethods(mongoose);
  const owner = new mongoose.Types.ObjectId();
  const fixture = await executionFixture();
  const identity = { ...fixture.identity, ownerId: owner.toString() };
  const schedule = await methods.createSchedule({
    id: 'schedule',
    user: owner,
    tenantId: 'tenant',
    agent_id: 'root',
    name: 'Read',
    prompt: 'Read',
    enabled: true,
    timezone: 'UTC',
    cadence: { frequency: 'hourly', minute: 0, hour: 1 },
  });
  const consent = createScheduleMCPConsentService({
    storage: methods,
    resolveEnrollment: async () => [fixture.target],
    getLimits: async () => ({ enabled: true, maxLifetimeHours: 24 }),
    canUse: async () => true,
    checkToolPolicy: async () => true,
  });
  const enroll = async () => {
    const offer = await consent.view(identity);
    await consent.confirm(identity, {
      offerDigest: offer.offer!.digest,
      expectedRevision: offer.revision,
      lifetimeHours: 1,
    });
  };
  if (!legacy) await enroll();
  const loadAuthorization = jest.fn(async () => ({
    authority: consent.authority,
    policy: fixture.policy,
  }));
  const factory = createScheduleMCPExecution({ storage: methods, loadAuthorization });
  const execution = (await factory.resolve(identity, 'invoke'))!;
  const scheduledFor = new Date('2026-10-02T12:00:00Z');
  await methods.insertScheduleRun({
    scheduleId: schedule.id,
    user: owner,
    tenantId: 'tenant',
    scheduledFor,
    conversationId: 'stream',
    status: 'started',
    configRevision: 0,
  });
  const job = await store.createJob('stream', owner.toString(), 'stream', 'tenant', {
    scheduleId: schedule.id,
    scheduledFor: scheduledFor.toISOString(),
    agent_id: 'root',
  });
  const config = {
    interfaceConfig: { schedules: { use: true, autoDisableAfterFailures: 99 } },
  } as AppConfig;
  const deps: SchedulesServiceDeps = {
    methods: {
      ...methods,
      getRoleByName: async () => null,
      getFiles: async () => [],
      extendFilesTTL: async () => 0,
    },
    getAppConfig: async () => config,
    findUserById: async () => ({ _id: owner, tenantId: 'tenant', role: 'USER' }),
    findBalance: async () => null,
    upsertBalance: async () => null,
    initializeNullBalance: async () => null,
    getChatProject: async () => null,
    resolveAgentFireAccess: async () => 'ok',
    isUserDeleting: async () => false,
    preflightMCP: async () => [],
    enqueueAgentTrigger: async () => undefined,
    getTriggerDelivery: async () => null,
  };
  const service = createSchedulesService(deps);
  const scope = {
    streamId: 'stream',
    jobCreatedAt: job.createdAt,
    userId: owner.toString(),
    tenantId: 'tenant',
  };
  const record = createScheduledMCPPolicyRecorder(execution, scope, (input) =>
    recordScheduledMCPToolAuthFailure(input, () => service.recordMCPToolAuthFailure),
  )!;
  return {
    methods,
    execution,
    schedule,
    scheduledFor,
    job,
    scope,
    record,
    service,
    enroll,
    deps,
    loadAuthorization,
    consent,
    fixture,
  };
}

it.each(['root', 'child'])(
  'records a late direct-action denial from %s before handled-success settlement',
  async (agentId) => {
    const f = await setup();
    const policy = createScheduledMCPRunPolicy(
      f.execution,
      [{ id: 'root' }, { id: 'child' }],
      [],
      f.record,
    );
    const hooks = new HookRegistry();
    hooks.register('PreToolUse', { hooks: [policy.hook, policy.receipt] });
    const body = jest.fn(async () => 'write executed');
    const action = new DynamicStructuredTool({
      name: 'write_action_api',
      description: 'Late action',
      schema: z.object({ privateValue: z.string() }),
      func: body,
    });
    const node = new ToolNode({ agentId, tools: [action], hookRegistry: hooks });
    const result = await node.invoke(
      {
        messages: [
          new AIMessage({
            content: '',
            tool_calls: [{ id: 'call', name: action.name, args: { privateValue: 'PRIVATE' } }],
          }),
        ],
      },
      { configurable: { run_id: 'run', thread_id: 'thread' } },
    );
    expect(body).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).toContain('Blocked:');
    const before = await f.methods.getScheduleRunAbortState(f.schedule.id, f.scheduledFor);
    expect(before?.mcp).toEqual([
      {
        server: '',
        agentId,
        reason: 'tool_policy_denied',
        status: 'mcp_permission_denied',
        recovery: 'configure',
        automaticReplay: false,
      },
    ]);
    expect(JSON.stringify(before)).not.toContain('PRIVATE');
    await f.service.recordScheduleOutcome({
      scheduleId: f.schedule.id,
      scheduledFor: f.scheduledFor,
      status: 'success',
      conversationId: 'stream',
      streamId: 'stream',
      jobCreatedAt: f.job.createdAt,
    });
    const card = await f.methods.getScheduleById(f.schedule.id);
    expect(card).toMatchObject({
      enabled: false,
      disabledReason: 'mcp_permission_denied',
      failureCount: 1,
      lastRun: { status: 'error', mcp: before?.mcp },
    });
    expect((await store.getJob('stream'))?.scheduleOutcome).toBe('error');
  },
);

it.each([
  { createdAt: -1 },
  { userId: 'other' },
  { tenantId: 'other' },
  { scheduleId: 'other' },
  { agent_id: 'other' },
])('never stamps a different persisted job identity %j', async (change) => {
  const f = await setup();
  await store.updateJob('stream', change, f.job.createdAt);
  expect(await f.record(new ScheduledMCPPolicyError('tool_policy_denied', '', 'child'))).toBe(
    false,
  );
  expect(
    (await f.methods.getScheduleRunAbortState(f.schedule.id, f.scheduledFor))?.mcp,
  ).toBeUndefined();
});

it('captures recorder scope and does not initialize it for legacy runs', async () => {
  const f = await setup();
  f.scope.streamId = 'spoofed';
  f.scope.jobCreatedAt = -1;
  expect(await f.record(new ScheduledMCPPolicyError('tool_policy_denied', '', 'child'))).toBe(true);
  expect(createScheduledMCPPolicyRecorder(undefined, f.scope, jest.fn())).toBeUndefined();
});

it.each(['throw', 'timeout'] as const)(
  'keeps the SDK ceiling denied when receipt persistence %s fails',
  async (failure) => {
    const f = await setup();
    const record = jest.fn(async () => {
      if (failure === 'throw') throw new Error('PRIVATE database details');
      return new Promise<boolean>(() => undefined);
    });
    const policy = createScheduledMCPRunPolicy(f.execution, [{ id: 'root' }], [], record);
    const hooks = new HookRegistry();
    hooks.register('PreToolUse', { hooks: [policy.hook, policy.receipt], internal: true });
    const result = await executeHooks({
      registry: hooks,
      timeoutMs: 10,
      input: {
        hook_event_name: 'PreToolUse',
        runId: 'run',
        executingAgentId: 'root',
        toolName: 'write',
        toolInput: {},
        toolUseId: 'call',
      },
    });
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('tool_policy_denied');
    expect(result.reason).not.toContain('PRIVATE');
  },
);

it('fences a real legacy SDK action when narrowed consent is confirmed after initialization', async () => {
  const f = await setup(true);
  const policy = createScheduledMCPRunPolicy(f.execution, [{ id: 'root' }], [], f.record);
  const hooks = new HookRegistry();
  hooks.register('PreToolUse', { hooks: [policy.hook, policy.receipt] });
  const body = jest.fn(async () => 'legacy write');
  const action = new DynamicStructuredTool({
    name: 'write_action_api',
    description: 'Cached legacy action',
    schema: z.object({}),
    func: body,
  });
  const node = new ToolNode({ agentId: 'root', tools: [action], hookRegistry: hooks });
  const call = () =>
    node.invoke(
      {
        messages: [
          new AIMessage({
            content: '',
            tool_calls: [{ id: 'legacy-call', name: action.name, args: {} }],
          }),
        ],
      },
      { configurable: { run_id: 'legacy', thread_id: 'thread' } },
    );
  await call();
  expect(body).toHaveBeenCalledTimes(1);
  await f.enroll();
  const result = await call();
  expect(JSON.stringify(result)).toContain('Blocked:');
  expect(body).toHaveBeenCalledTimes(1);
  await f.service.recordScheduleOutcome({
    scheduleId: f.schedule.id,
    scheduledFor: f.scheduledFor,
    status: 'success',
    conversationId: 'stream',
    streamId: 'stream',
    jobCreatedAt: f.job.createdAt,
  });
  expect(await f.methods.getScheduleById(f.schedule.id)).toMatchObject({
    enabled: false,
    lastRun: { status: 'error', mcp: [expect.objectContaining({ reason: 'binding_mismatch' })] },
  });
});

it('retains a failed Mongo receipt in the job store and replays it after service reconstruction', async () => {
  const f = await setup();
  jest
    .spyOn(f.service.engineDeps.methods, 'recordMCPToolAuthFailure')
    .mockRejectedValueOnce(new Error('Storage outage PRIVATE'));
  const failure = new ScheduledMCPPolicyError('tool_policy_denied', '', 'child');
  expect(await f.record(failure)).toBe(true);
  expect((await store.getJob('stream'))?.scheduleMCPFailure).toEqual(failure.outcomes[0]);
  expect(
    (await f.methods.getScheduleRunAbortState(f.schedule.id, f.scheduledFor))?.mcp,
  ).toBeUndefined();
  const recovered = createSchedulesService(f.deps);
  await recovered.recordScheduleOutcome({
    scheduleId: f.schedule.id,
    scheduledFor: f.scheduledFor,
    status: 'success',
    conversationId: 'stream',
    streamId: 'stream',
    jobCreatedAt: f.job.createdAt,
  });
  expect(await f.methods.getScheduleById(f.schedule.id)).toMatchObject({
    enabled: false,
    disabledReason: 'mcp_permission_denied',
    lastRun: { status: 'error', mcp: failure.outcomes },
  });
});

it('defers success while both receipt channels are unavailable, then settles the retained denial', async () => {
  const f = await setup();
  const mongoWrite = jest
    .spyOn(f.service.engineDeps.methods, 'recordMCPToolAuthFailure')
    .mockRejectedValue(new Error('Mongo outage'));
  const jobWrite = jest.spyOn(store, 'updateJob').mockRejectedValue(new Error('Job store outage'));
  const failure = new ScheduledMCPPolicyError('tool_policy_denied', '', 'root');
  expect(await f.record(failure)).toBe(false);
  const settle = () =>
    f.service.recordScheduleOutcome({
      scheduleId: f.schedule.id,
      scheduledFor: f.scheduledFor,
      status: 'success',
      conversationId: 'stream',
      streamId: 'stream',
      jobCreatedAt: f.job.createdAt,
    });
  expect(await settle()).toBe(false);
  expect(await f.methods.getScheduleById(f.schedule.id)).toMatchObject({
    enabled: true,
    failureCount: 0,
  });
  jobWrite.mockRestore();
  mongoWrite.mockRestore();
  expect(await settle()).toBe(true);
  expect(await f.methods.getScheduleById(f.schedule.id)).toMatchObject({
    enabled: false,
    disabledReason: 'mcp_permission_denied',
    lastRun: { status: 'error', mcp: failure.outcomes },
  });
});

it('retains a denial before a failed first job lookup and does not stamp a replacement generation', async () => {
  const f = await setup();
  const epoch = f.job.createdAt;
  const recorder = jest.spyOn(f.service, 'recordMCPToolAuthFailure');
  const read = jest.spyOn(store, 'getJob').mockRejectedValueOnce(new Error('Lookup outage'));
  expect(await f.record(new ScheduledMCPPolicyError('tool_policy_denied', '', 'child'))).toBe(
    false,
  );
  read.mockRestore();
  expect(recorder).toHaveBeenCalledWith(
    expect.objectContaining({ identity: f.execution.identity, jobCreatedAt: epoch }),
  );
  expect(await f.service.engineDeps.getJobStatus('stream')).toMatchObject({
    scheduleMCPFailure: expect.objectContaining({ reason: 'tool_policy_denied' }),
  });
  await store.updateJob(
    'stream',
    { createdAt: f.job.createdAt + 1, scheduleId: 'other' },
    f.job.createdAt,
  );
  const outcome = jest.spyOn(f.service.engineDeps.methods, 'recordRunOutcome');
  expect(
    await f.service.recordScheduleOutcome({
      scheduleId: f.schedule.id,
      scheduledFor: f.scheduledFor,
      status: 'success',
      conversationId: 'stream',
      streamId: 'stream',
      jobCreatedAt: epoch,
    }),
  ).toBe(true);
  expect(outcome).toHaveBeenCalledWith(
    expect.objectContaining({
      status: 'error',
      mcp: [expect.objectContaining({ reason: 'tool_policy_denied' })],
    }),
  );
  expect((await store.getJob('stream'))?.scheduleMCPFailure).toBeUndefined();
  expect(await f.methods.getScheduleById(f.schedule.id)).toMatchObject({
    enabled: false,
    lastRun: { status: 'error', mcp: [expect.objectContaining({ reason: 'tool_policy_denied' })] },
  });
});

it('upgrades a transient receipt to a later permanent policy denial', async () => {
  const f = await setup();
  expect(await f.record(new ScheduledMCPPolicyError('dependency_unavailable', '', 'root'))).toBe(
    true,
  );
  const permanent = new ScheduledMCPPolicyError('tool_policy_denied', '', 'child');
  expect(await f.record(permanent)).toBe(true);
  expect((await store.getJob('stream'))?.scheduleMCPFailure).toEqual(permanent.outcomes[0]);
  await f.service.recordScheduleOutcome({
    scheduleId: f.schedule.id,
    scheduledFor: f.scheduledFor,
    status: 'success',
    conversationId: 'stream',
    streamId: 'stream',
    jobCreatedAt: f.job.createdAt,
  });
  expect(await f.methods.getScheduleById(f.schedule.id)).toMatchObject({
    enabled: false,
    disabledReason: 'mcp_permission_denied',
  });
});

it('keeps a failed receipt through approval pause and a rebuilt settlement service', async () => {
  const f = await setup();
  const mongoWrite = jest
    .spyOn(f.service.engineDeps.methods, 'recordMCPToolAuthFailure')
    .mockRejectedValue(new Error('Mongo outage'));
  const jobWrite = jest.spyOn(store, 'updateJob').mockRejectedValue(new Error('Job outage'));
  const failure = new ScheduledMCPPolicyError('tool_policy_denied', '', 'child');
  expect(await f.record(failure)).toBe(false);
  const pause = () =>
    f.service.recordScheduleOutcome({
      scheduleId: f.schedule.id,
      scheduledFor: f.scheduledFor,
      status: 'requires_action',
      conversationId: 'stream',
      streamId: 'stream',
      jobCreatedAt: f.job.createdAt,
    });
  expect(await pause()).toBe(false);
  mongoWrite.mockRestore();
  jobWrite.mockRestore();
  expect(await pause()).toBe(true);
  const resumed = createSchedulesService(f.deps);
  expect(
    await resumed.recordScheduleOutcome({
      scheduleId: f.schedule.id,
      scheduledFor: f.scheduledFor,
      status: 'success',
      conversationId: 'stream',
      streamId: 'stream',
      jobCreatedAt: f.job.createdAt,
    }),
  ).toBe(true);
  expect(await f.methods.getScheduleById(f.schedule.id)).toMatchObject({
    enabled: false,
    lastRun: { status: 'error', mcp: failure.outcomes },
  });
});

it('retains a transport consent denial before a transient first job lookup', async () => {
  const f = await setup();
  const invocation = f.execution.bind('child', 'query');
  const failure = new ScheduledMCPPolicyError('consent_revoked', 'warehouse', 'child');
  const read = jest
    .spyOn(store, 'getJob')
    .mockRejectedValueOnce(new Error('Transient lookup outage'));
  const persisted = await recordScheduledMCPToolAuthFailure(
    {
      error: failure,
      identity: invocation.identity,
      streamId: 'stream',
      jobCreatedAt: f.job.createdAt,
      userId: f.execution.identity.ownerId,
      serverName: 'warehouse',
    },
    () => f.service.recordMCPToolAuthFailure,
  );
  expect(persisted).toBe(false);
  read.mockRestore();
  expect(
    await f.service.recordScheduleOutcome({
      scheduleId: f.schedule.id,
      scheduledFor: f.scheduledFor,
      status: 'success',
      conversationId: 'stream',
      streamId: 'stream',
      jobCreatedAt: f.job.createdAt,
    }),
  ).toBe(true);
  expect(await f.methods.getScheduleById(f.schedule.id)).toMatchObject({
    enabled: false,
    disabledReason: 'mcp_reauth_required',
    lastRun: { status: 'error', mcp: failure.outcomes },
  });
});

it.each(['success', 'error', 'skipped_balance'] as const)(
  'merges an earlier Mongo receipt with a job-only permanent denial during %s settlement',
  async (status) => {
    const f = await setup(true);
    const transient = new ScheduledMCPPolicyError('dependency_unavailable', '', 'root');
    expect(await f.record(transient)).toBe(true);
    await f.enroll();
    const permanent = new ScheduledMCPPolicyError('binding_mismatch', '', 'child');
    const write = jest
      .spyOn(f.service.engineDeps.methods, 'recordMCPToolAuthFailure')
      .mockRejectedValueOnce(new Error('Transient Mongo receipt outage'));
    expect(await f.record(permanent)).toBe(true);
    write.mockRestore();
    expect((await store.getJob('stream'))?.scheduleMCPFailure).toEqual(permanent.outcomes[0]);
    expect((await f.methods.getScheduleRunAbortState(f.schedule.id, f.scheduledFor))?.mcp).toEqual(
      transient.outcomes,
    );
    expect(
      await f.service.recordScheduleOutcome({
        scheduleId: f.schedule.id,
        scheduledFor: f.scheduledFor,
        status,
        conversationId: 'stream',
        streamId: 'stream',
        jobCreatedAt: f.job.createdAt,
      }),
    ).toBe(true);
    const card = await f.methods.getScheduleById(f.schedule.id);
    expect(card).toMatchObject({
      enabled: false,
      disabledReason: 'mcp_reauth_required',
      failureCount: 1,
      lastRun: { status: 'error' },
    });
    expect(card!.lastRun!.mcp).toEqual([...transient.outcomes, ...permanent.outcomes]);
  },
);

it.each(['root', 'child'])(
  'blocks enrolled background delegation from %s before a completion can be registered',
  async (agentId) => {
    const f = await setup();
    const policy = createScheduledMCPRunPolicy(
      f.execution,
      [{ id: 'root' }, { id: 'child' }],
      [],
      f.record,
    );
    const registry = new HookRegistry();
    registry.register('PreToolUse', { hooks: [policy.hook, policy.receipt] });
    const start = jest.fn(async () => 'background handle');
    const delegate = new DynamicStructuredTool({
      name: Constants.SUBAGENT,
      description: 'SDK delegation surface',
      schema: z.object({
        run_in_background: z.boolean().optional(),
        subagent_thread_id: z.string().optional(),
      }),
      func: start,
    });
    const node = new ToolNode({ agentId, tools: [delegate], hookRegistry: registry });
    const call = (args: Record<string, unknown>, id: string) =>
      node.invoke(
        {
          messages: [
            new AIMessage({ content: '', tool_calls: [{ id, name: delegate.name, args }] }),
          ],
        },
        { configurable: { run_id: 'scheduled', thread_id: 'thread' } },
      );
    for (const args of [
      { run_in_background: true },
      { run_in_background: true, subagent_thread_id: 'saved-thread' },
    ]) {
      expect(JSON.stringify(await call(args, 'detached'))).toContain('Blocked:');
      expect(start).not.toHaveBeenCalled();
    }
    await call({ run_in_background: false }, 'foreground');
    expect(start).toHaveBeenCalledTimes(1);
    await f.service.recordScheduleOutcome({
      scheduleId: f.schedule.id,
      scheduledFor: f.scheduledFor,
      status: 'success',
      conversationId: 'stream',
      streamId: 'stream',
      jobCreatedAt: f.job.createdAt,
    });
    expect(await f.methods.getScheduleById(f.schedule.id)).toMatchObject({
      enabled: false,
      disabledReason: 'mcp_permission_denied',
      lastRun: {
        status: 'error',
        mcp: [expect.objectContaining({ agentId, reason: 'tool_policy_denied' })],
      },
    });
  },
);

it('fences both newly prepared and already serialized legacy completion turns after enrollment', async () => {
  const f = await setup(true);
  const scope = {
    ownerId: f.execution.identity.ownerId,
    tenantId: 'tenant',
    scheduleMCPIdentity: f.execution.identity,
  };
  const identity = await resolveScheduleMCPCompletion(
    scope,
    f.methods.getScheduleMCPCompletionState,
  );
  expect(identity).toEqual(f.execution.identity);
  await f.enroll();
  await expect(
    resolveScheduleMCPCompletion(scope, f.methods.getScheduleMCPCompletionState),
  ).rejects.toMatchObject({ failure: { reason: 'binding_mismatch' } });
  const host = createScheduleMCPRuntimeHost({
    methods: f.methods,
    getScheduleMCPCompletionState: f.methods.getScheduleMCPCompletionState,
    findUser: async () => null,
    getRoleByName: async () => null,
    canViewAgent: async () => false,
    enrollment: {
      findUser: async () => null,
      canUseRoot: async () => false,
      getAppConfig: async () => undefined,
      resolveGraphAccess: async () => ({}) as AgentGraphAccessContext,
      getNodes: async () => [],
      getModelsConfig: async () => ({}),
      getServers: async () => ({}),
    },
  });
  for (const sourceId of ['subagent-completion', 'background-tool-completion']) {
    for (const marker of [{ version: 1, sourceId, scheduleMCPIdentity: identity }]) {
      const initialize = jest.fn(async () => 'mutation would execute');
      const req = {
        user: { id: f.execution.identity.ownerId, tenantId: 'tenant' },
        _isAgentTrigger: true,
        _isScheduledFire: false,
        body: { conversationId: 'stream', agent_id: 'root', agentCompletion: marker },
      };
      await expect(
        initializeWithScheduleMCPExecution(
          { req, context: createMCPRequestContext() },
          () => host,
          initialize,
        ),
      ).rejects.toMatchObject({ failure: { reason: 'binding_mismatch' } });
      expect(initialize).not.toHaveBeenCalled();
    }
  }
});

it('atomically keeps a permanent denial when an older delayed transient job write lands last', async () => {
  const f = await setup();
  const mongoWrite = jest
    .spyOn(f.service.engineDeps.methods, 'recordMCPToolAuthFailure')
    .mockRejectedValue(new Error('Receipt storage outage'));
  const original = store.updateJob.bind(store);
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  jest.spyOn(store, 'updateJob').mockImplementation(async (id, patch, epoch) => {
    if (patch.scheduleMCPFailure?.reason === 'dependency_unavailable') {
      enter();
      await gate;
    }
    await original(id, patch, epoch);
  });
  const earlier = f.record(new ScheduledMCPPolicyError('dependency_unavailable', '', 'root'));
  await entered;
  const permanent = new ScheduledMCPPolicyError('binding_mismatch', '', 'child');
  expect(await f.record(permanent)).toBe(true);
  release();
  expect(await earlier).toBe(true);
  expect((await store.getJob('stream'))?.scheduleMCPFailure).toEqual(permanent.outcomes[0]);
  mongoWrite.mockRestore();
  const rebuilt = createSchedulesService(f.deps);
  await rebuilt.recordScheduleOutcome({
    scheduleId: f.schedule.id,
    scheduledFor: f.scheduledFor,
    status: 'success',
    conversationId: 'stream',
    streamId: 'stream',
    jobCreatedAt: f.job.createdAt,
  });
  expect(await f.methods.getScheduleById(f.schedule.id)).toMatchObject({
    enabled: false,
    disabledReason: 'mcp_reauth_required',
    failureCount: 1,
    lastRun: { status: 'error', mcp: permanent.outcomes },
  });
});

it('projects the original schedule identity from the production host into a queued completion', async () => {
  const f = await setup(true);
  const identity = await resolveScheduleMCPCompletion(
    {
      ownerId: f.execution.identity.ownerId,
      tenantId: 'tenant',
      scheduleMCPIdentity: f.execution.identity,
    },
    f.methods.getScheduleMCPCompletionState,
  );
  let body: Record<string, unknown> | undefined;
  const trigger = createAgentTriggerExecutionHost({
    getBaseUrl: () => 'http://localhost:3080',
    mintToken: async () => 'fixture-token',
    prepareContinue: async () => ({
      status: 'ready',
      input: 'completed',
      parentMessageId: 'response',
      scheduleMCPIdentity: identity,
    }),
    fetch: async (_url, request) => {
      body = JSON.parse(String(request?.body));
      return new Response(
        JSON.stringify({
          status: 'started',
          conversationId: 'stream',
          streamId: 'stream',
          generationCreatedAt: 1,
        }),
        { status: 200 },
      );
    },
  });
  await trigger.dispatch(
    createAgentTriggerEnvelope({
      mode: 'continue',
      requestId: 'request',
      deliveryId: 'task',
      receivedAt: Date.now(),
      principal: { id: f.execution.identity.ownerId, tenantId: 'tenant' },
      event: {
        id: 'task',
        type: 'subagent.completion',
        occurredAt: Date.now(),
        source: { id: 'subagent-completion', type: 'internal' },
      },
      target: { agentId: 'root', conversationId: 'stream', parentMessageId: 'response' },
      input: 'completed',
    }),
  );
  expect(body).toMatchObject({
    agentCompletion: { version: 1, sourceId: 'subagent-completion', scheduleMCPIdentity: identity },
  });
  expect(body).not.toHaveProperty('agentTrigger');
});

it('keeps a legacy continuation guarded if confirmation lands after request admission', async () => {
  const f = await setup(true);
  const context = createMCPRequestContext();
  const host = createScheduleMCPRuntimeHost({
    methods: f.methods,
    getScheduleMCPCompletionState: f.methods.getScheduleMCPCompletionState,
    findUser: async () => null,
    getRoleByName: async () => null,
    canViewAgent: async () => false,
    enrollment: {
      findUser: async () => null,
      canUseRoot: async () => false,
      getAppConfig: async () => undefined,
      resolveGraphAccess: async () => ({}) as AgentGraphAccessContext,
      getNodes: async () => [],
      getModelsConfig: async () => ({}),
      getServers: async () => ({}),
    },
  });
  await host.prepare({
    context,
    req: {
      user: { id: f.execution.identity.ownerId, tenantId: 'tenant' },
      _isAgentTrigger: true,
      body: {
        conversationId: 'stream',
        agent_id: 'child',
        agentCompletion: {
          version: 1,
          sourceId: 'subagent-completion',
          scheduleMCPIdentity: f.execution.identity,
        },
      },
    },
  });
  const execution = getScheduleMCPExecution(context)!;
  expect(execution.enrolled).toBe(false);
  expect(execution.identity.agentId).toBe('root');
  await f.enroll();
  const policy = createScheduledMCPRunPolicy(execution, [{ id: 'child' }]);
  const registry = new HookRegistry();
  registry.register('PreToolUse', { hooks: [policy.hook] });
  const mutate = jest.fn(async () => 'mutated');
  const action = new DynamicStructuredTool({
    name: 'mutation',
    description: 'Write',
    schema: z.object({}),
    func: mutate,
  });
  const node = new ToolNode({ agentId: 'child', tools: [action], hookRegistry: registry });
  expect(
    JSON.stringify(
      await node.invoke(
        {
          messages: [
            new AIMessage({
              content: '',
              tool_calls: [{ id: 'write', name: action.name, args: {} }],
            }),
          ],
        },
        { configurable: { run_id: 'completion', thread_id: 'stream' } },
      ),
    ),
  ).toContain('Blocked:');
  expect(mutate).not.toHaveBeenCalled();
});

it('scopes captured completion lineage to its owner, tenant and root, and rejects deleted authority', async () => {
  const f = await setup(true);
  const lookup = jest.spyOn(f.methods, 'getScheduleMCPCompletionState');
  const scope = {
    ownerId: f.scope.userId,
    tenantId: 'tenant',
    scheduleMCPIdentity: f.execution.identity,
  };
  expect(
    await resolveScheduleMCPCompletion(
      { ...scope, scheduleMCPIdentity: null },
      f.methods.getScheduleMCPCompletionState,
    ),
  ).toBeUndefined();
  expect(lookup).not.toHaveBeenCalled();
  for (const identity of [
    { ...f.execution.identity, tenantId: 'foreign' },
    { ...f.execution.identity, ownerId: new mongoose.Types.ObjectId().toString() },
    { ...f.execution.identity, agentId: 'replacement-root' },
  ])
    await expect(
      resolveScheduleMCPCompletion(
        { ...scope, scheduleMCPIdentity: identity },
        f.methods.getScheduleMCPCompletionState,
      ),
    ).rejects.toMatchObject({ failure: { reason: 'binding_mismatch' } });
  await mongoose.models.Schedule.deleteOne({ id: f.schedule.id });
  await expect(
    resolveScheduleMCPCompletion(scope, f.methods.getScheduleMCPCompletionState),
  ).rejects.toMatchObject({
    failure: { reason: 'binding_mismatch' },
  });
});

it('refuses an authenticated completion approval after its original schedule was enrolled and revoked', async () => {
  const f = await setup(true);
  const identity = f.execution.identity;
  const host = createScheduleMCPRuntimeHost({
    methods: f.methods,
    getScheduleMCPCompletionState: f.methods.getScheduleMCPCompletionState,
    findUser: async () => null,
    getRoleByName: async () => null,
    canViewAgent: async () => false,
    enrollment: {
      findUser: async () => null,
      canUseRoot: async () => false,
      getAppConfig: async () => undefined,
      resolveGraphAccess: async () => ({}) as AgentGraphAccessContext,
      getNodes: async () => [],
      getModelsConfig: async () => ({}),
      getServers: async () => ({}),
    },
  });
  await f.enroll();
  const snapshot = await f.methods.readScheduleMCPConsent(identity);
  await f.methods.revokeScheduleMCPConsent(identity, snapshot!.enrollment!.revision);
  const provider = jest.fn(async () => 'approved read would execute');
  const req = {
    user: { id: identity.ownerId, tenantId: 'tenant' },
    _isAgentTrigger: false,
    _isScheduledFire: false,
    body: {
      conversationId: 'stream',
      agent_id: 'child',
      agentCompletion: {
        version: 1,
        sourceId: 'subagent-completion',
        scheduleMCPIdentity: f.execution.identity,
      },
    },
  };
  await expect(
    initializeWithScheduleMCPExecution(
      {
        req,
        context: createMCPRequestContext(),
        restoredJob: { scheduleMCPCompletion: identity } as never,
      },
      () => host,
      provider,
    ),
  ).rejects.toMatchObject({ failure: { reason: 'binding_mismatch' } });
  expect(provider).not.toHaveBeenCalled();
});

it('persists completion identity before tool construction and restores its monitor across repeated approvals', async () => {
  const f = await setup(true);
  const host = createScheduleMCPRuntimeHost({
    methods: f.methods,
    getScheduleMCPCompletionState: f.methods.getScheduleMCPCompletionState,
    findUser: async () => null,
    getRoleByName: async () => null,
    canViewAgent: async () => false,
    enrollment: {
      findUser: async () => null,
      canUseRoot: async () => false,
      getAppConfig: async () => undefined,
      resolveGraphAccess: async () => ({}) as AgentGraphAccessContext,
      getNodes: async () => [],
      getModelsConfig: async () => ({}),
      getServers: async () => ({}),
    },
  });
  const req = {
    user: { id: f.execution.identity.ownerId, tenantId: 'tenant' },
    _isAgentTrigger: true,
    body: {
      conversationId: 'stream',
      agent_id: 'child',
      agentCompletion: {
        version: 1,
        sourceId: 'subagent-completion',
        scheduleMCPIdentity: f.execution.identity,
      },
    },
  };
  const provider = jest.fn(async () => {
    expect((await store.getJob('stream'))?.scheduleMCPCompletion).toEqual(f.execution.identity);
  });
  await initializeWithScheduleMCPExecution(
    { req, context: createMCPRequestContext() },
    () => host,
    provider,
    (identity) =>
      retainScheduleMCPCompletion(
        identity,
        { streamId: 'stream', createdAt: f.job.createdAt },
        store,
      ),
  );
  expect(provider).toHaveBeenCalledTimes(1);
  const lineage = (await store.getJob('stream'))!.scheduleMCPCompletion!;
  for (let i = 0; i < 2; i++) {
    const context = createMCPRequestContext();
    await initializeWithScheduleMCPExecution(
      {
        req: { ...req, _isAgentTrigger: false },
        context,
        restoredJob: { scheduleMCPCompletion: lineage },
      },
      () => host,
      async () => {
        expect(getScheduleMCPExecution(context)?.identity).toEqual(lineage);
        expect(getScheduleMCPExecution(context)?.stage).toBe('resume');
      },
    );
  }
  await f.enroll();
  const context = createMCPRequestContext();
  await expect(
    initializeWithScheduleMCPExecution(
      {
        req: { ...req, _isAgentTrigger: false },
        context,
        restoredJob: { scheduleMCPCompletion: lineage },
      },
      () => host,
      provider,
    ),
  ).rejects.toMatchObject({ failure: { reason: 'binding_mismatch' } });
  expect(provider).toHaveBeenCalledTimes(1);
});

it('cannot launch a completion when its lineage cannot be durably retained', async () => {
  const f = await setup(true);
  const scope = { streamId: 'stream', createdAt: f.job.createdAt };
  jest.spyOn(store, 'updateJob').mockResolvedValueOnce(undefined);
  await expect(
    retainScheduleMCPCompletion(f.execution.identity, scope, store),
  ).rejects.toMatchObject({ failure: { reason: 'dependency_unavailable' } });
  await expect(
    retainScheduleMCPCompletion(
      f.execution.identity,
      { ...scope, createdAt: scope.createdAt - 1 },
      store,
    ),
  ).rejects.toMatchObject({ failure: { reason: 'binding_mismatch' } });
  await expect(
    retainScheduleMCPCompletion({ ...f.execution.identity, tenantId: 'foreign' }, scope, store),
  ).rejects.toMatchObject({ failure: { reason: 'binding_mismatch' } });
});

it.each(['snapshot', 'consent', 'admission', 'catalog'] as const)(
  'retains a safe %s authorization failure when the model handles it as success',
  async (phase) => {
    const f = await setup();
    const internal = new Error('PRIVATE authorization dependency details');
    if (phase === 'snapshot') f.loadAuthorization.mockRejectedValue(internal);
    if (phase === 'consent')
      jest.spyOn(f.consent.authority, 'authorize').mockRejectedValue(internal);
    if (phase === 'admission')
      jest.spyOn(f.methods, 'admitScheduleMCPConsent').mockRejectedValue(internal);
    const provider = jest.fn(async () => 'read executed');
    const tool = new DynamicStructuredTool({
      name: 'query_mcp_warehouse',
      description: 'Read',
      schema: z.object({}),
      func: async () => {
        try {
          await f.execution.bind('child', 'query').authorize({
            user: { id: f.scope.userId, tenantId: 'tenant' },
            serverName: 'warehouse',
            serverConfig: f.fixture.config,
            toolName: 'query',
            loadTools: async () => {
              if (phase === 'catalog') throw internal;
              return { tools: [readTool], complete: true };
            },
          });
          return provider();
        } catch (error) {
          await recordScheduledMCPToolAuthFailure(
            {
              error,
              identity: f.execution.identity,
              streamId: 'stream',
              jobCreatedAt: f.job.createdAt,
              userId: f.scope.userId,
              serverName: 'warehouse',
            },
            () => f.service.recordMCPToolAuthFailure,
          );
          throw error;
        }
      },
    });
    const result = await new ToolNode({ agentId: 'child', tools: [tool] }).invoke(
      {
        messages: [
          new AIMessage({ content: '', tool_calls: [{ id: 'read', name: tool.name, args: {} }] }),
        ],
      },
      { configurable: { run_id: 'scheduled', thread_id: 'stream' } },
    );
    expect(provider).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).toContain('dependency_unavailable');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect((await store.getJob('stream'))?.scheduleMCPFailure).toMatchObject({
      server: 'warehouse',
      agentId: 'child',
      reason: 'dependency_unavailable',
    });
    await f.service.recordScheduleOutcome({
      scheduleId: f.schedule.id,
      scheduledFor: f.scheduledFor,
      status: 'success',
      conversationId: 'stream',
      streamId: 'stream',
      jobCreatedAt: f.job.createdAt,
    });
    const saved = await f.methods.getScheduleById(f.schedule.id);
    expect(saved).toMatchObject({
      enabled: true,
      failureCount: 1,
      lastRun: {
        status: 'error',
        mcp: [
          expect.objectContaining({ reason: 'dependency_unavailable', automaticReplay: false }),
        ],
      },
    });
    expect(JSON.stringify(saved)).not.toContain('PRIVATE');
  },
);

it('stores only a safe preparation outage when initial authorization fails after readiness', async () => {
  const f = await setup();
  const host = createScheduleMCPRuntimeHost({
    methods: {
      ...f.methods,
      getScheduleById: async () => {
        throw new Error('PRIVATE database query');
      },
    },
    getScheduleMCPCompletionState: f.methods.getScheduleMCPCompletionState,
    findUser: async () => null,
    getRoleByName: async () => null,
    canViewAgent: async () => false,
    enrollment: {
      findUser: async () => null,
      canUseRoot: async () => false,
      getAppConfig: async () => undefined,
      resolveGraphAccess: async () => ({}) as AgentGraphAccessContext,
      getNodes: async () => [],
      getModelsConfig: async () => ({}),
      getServers: async () => ({}),
    },
  });
  const provider = jest.fn();
  let failure: unknown;
  try {
    await initializeWithScheduleMCPExecution(
      {
        req: {
          user: { id: f.scope.userId, tenantId: 'tenant' },
          _isScheduledFire: true,
          _isAgentTrigger: true,
          body: {
            agent_id: 'root',
            agentTrigger: {
              version: 1,
              event: {
                type: 'schedule.occurrence',
                occurredAt: 0,
                source: { id: f.schedule.id, type: 'schedule' },
              },
            },
          },
        },
        context: createMCPRequestContext(),
      },
      () => host,
      provider,
    );
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ScheduledMCPPolicyError);
  if (!(failure instanceof ScheduledMCPPolicyError)) throw new Error('Expected safe denial');
  await f.service.recordScheduleOutcome({
    scheduleId: f.schedule.id,
    scheduledFor: f.scheduledFor,
    status: 'error',
    error: failure.message,
    conversationId: 'stream',
    streamId: 'stream',
    jobCreatedAt: f.job.createdAt,
  });
  const saved = await f.methods.getScheduleById(f.schedule.id);
  expect(saved).toMatchObject({
    enabled: true,
    failureCount: 1,
    lastRun: { status: 'error', error: failure.message },
  });
  expect(saved?.lastRun?.error).toContain('dependency_unavailable');
  expect(JSON.stringify(saved)).not.toContain('PRIVATE');
  expect(provider).not.toHaveBeenCalled();
});

it.each(
  ['subagent-completion', 'background-tool-completion'].flatMap((sourceId) =>
    ['legacy', 'enrolled', 'deleted'].map((scheduleState) => ({ sourceId, scheduleState })),
  ),
)(
  'does not apply historical schedule authority to an ordinary task: %s',
  async ({ sourceId, scheduleState }) => {
    const f = await setup(true);
    await f.service.recordScheduleOutcome({
      scheduleId: f.schedule.id,
      scheduledFor: f.scheduledFor,
      status: 'success',
      conversationId: 'stream',
      streamId: 'stream',
      jobCreatedAt: f.job.createdAt,
    });
    if (scheduleState === 'enrolled') await f.enroll();
    if (scheduleState === 'deleted')
      await mongoose.models.Schedule.deleteOne({ id: f.schedule.id });
    const host = createScheduleMCPRuntimeHost({
      methods: f.methods,
      getScheduleMCPCompletionState: f.methods.getScheduleMCPCompletionState,
      findUser: async () => null,
      getRoleByName: async () => null,
      canViewAgent: async () => false,
      enrollment: {
        findUser: async () => null,
        canUseRoot: async () => false,
        getAppConfig: async () => undefined,
        resolveGraphAccess: async () => ({}) as AgentGraphAccessContext,
        getNodes: async () => [],
        getModelsConfig: async () => ({}),
        getServers: async () => ({}),
      },
    });
    const context = createMCPRequestContext();
    const initialize = jest.fn(async () => 'ordinary continuation');
    await expect(
      initializeWithScheduleMCPExecution(
        {
          context,
          req: {
            user: { id: f.scope.userId, tenantId: 'tenant' },
            _isAgentTrigger: true,
            body: {
              conversationId: 'stream',
              agent_id: 'root',
              agentCompletion: { version: 1, sourceId, scheduleMCPIdentity: null },
            },
          },
        },
        () => host,
        initialize,
      ),
    ).resolves.toBe('ordinary continuation');
    expect(getScheduleMCPExecution(context)).toBeUndefined();
    expect(initialize).toHaveBeenCalledTimes(1);
  },
);
