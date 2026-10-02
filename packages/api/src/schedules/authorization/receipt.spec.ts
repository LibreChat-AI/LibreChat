import { z } from 'zod';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { AIMessage } from '@librechat/agents/langchain/messages';
import { createModels, createMethods } from '@librechat/data-schemas';
import { HookRegistry, ToolNode, executeHooks } from '@librechat/agents';
import type { AppConfig } from '@librechat/data-schemas';
import type { SchedulesServiceDeps } from '../service';
import {
  createSchedulesService,
  createScheduledMCPPolicyRecorder,
  recordScheduledMCPToolAuthFailure,
} from '../service';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManager } from '~/stream/GenerationJobManager';
import { createScheduleMCPConsentService } from './service';
import { createScheduleMCPExecution } from './execution';
import { executionFixture } from './execution.helper';
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
  const factory = createScheduleMCPExecution({
    storage: methods,
    loadAuthorization: async () => ({ authority: consent.authority, policy: fixture.policy }),
  });
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
  return { methods, execution, schedule, scheduledFor, job, scope, record, service, enroll, deps };
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
