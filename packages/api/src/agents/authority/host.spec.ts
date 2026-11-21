import type { AgentKeyMCPIdentity, ScheduledMCPIdentity } from 'librechat-data-provider';
import type { ScheduleHost, ScheduleInput } from '~/schedules/authorization/subject';
import type { SubjectAdapter, SubjectInput, Resolved } from './subject';
import type { KeyInput } from '~/apiKeys/grants';
import type { Without } from './execution';
import {
  getSourceKey,
  restoreExecutionContext,
  createRemoteExecutionContext,
  createTriggerExecutionContext,
} from './context';
import { initializeWithAuthority, isCompletionTurn, placeRun } from './host';
import { scheduleSubject } from '~/schedules/authorization/subject';
import { parseRunTrigger, captureTrigger } from './trigger';
import { createMCPRequestContext } from '~/mcp/request';
import { RunGrantPolicyError } from './policy';
import { keySubject } from '~/apiKeys/grants';

const user = { id: 'owner', tenantId: 'tenant' };
const scheduleIdentity: ScheduledMCPIdentity = {
  scheduleId: 'schedule',
  ownerId: 'owner',
  tenantId: 'tenant',
  agentId: 'root-agent',
  invocationMode: 'delegated',
};
const keyIdentity: AgentKeyMCPIdentity = {
  keyId: 'key-1',
  ownerId: 'owner',
  tenantId: 'tenant',
  agentId: 'root-agent',
  invocationMode: 'delegated',
};

/**
 * The two subjects over hosts that record what the run host asks of them. Each host resolves
 * nothing unless a test says who the run acts for, and counts how often it was built.
 */
function hosts() {
  const order: string[] = [];
  const execution = (name: string) => ({
    resolve: jest.fn(async () => undefined),
    attach: jest.fn(async () => {
      order.push(`${name}:attach`);
      return true;
    }),
  });
  const scheduleHost = {
    resolve: jest.fn(async (): Promise<Resolved<ScheduledMCPIdentity> | undefined> => {
      order.push('schedule');
      return undefined;
    }),
    restore: jest.fn(async (): Promise<Without | undefined> => undefined),
    execution: execution('schedule'),
  } satisfies ScheduleHost;
  const keyHost = {
    resolve: jest.fn(async (): Promise<Resolved<AgentKeyMCPIdentity> | undefined> => {
      order.push('key');
      return undefined;
    }),
    execution: execution('key'),
  };
  const built = { schedule: 0, key: 0 };
  const retain = jest.fn(async () => void order.push('retain'));
  const schedule = scheduleSubject(() => {
    built.schedule += 1;
    return scheduleHost;
  }, retain);
  const key = keySubject(() => {
    built.key += 1;
    return keyHost;
  });
  const initialize = jest.fn(async () => {
    order.push('initialize');
    return 'client';
  });
  const adapters: SubjectAdapter<
    ScheduledMCPIdentity | AgentKeyMCPIdentity,
    ScheduleInput & KeyInput
  >[] = [schedule, key];
  return { order, scheduleHost, keyHost, built, retain, initialize, adapters };
}

/** The request the trigger host makes for an event `keyId` posted through the public route. */
function delivery(keyId = 'key-1') {
  return {
    user,
    _isAgentTrigger: true,
    body: {
      agent_id: 'root-agent',
      clientRequestId: 'trigger_abc',
      agentTrigger: {
        version: 1,
        event: {
          id: 'event-1',
          type: 'review.submitted',
          occurredAt: 1_000,
          source: { type: 'remote_api_key', id: keyId },
        },
      },
    },
  };
}

function scheduleFire() {
  return {
    user,
    _isAgentTrigger: true,
    _isScheduledFire: true,
    body: {
      agent_id: 'root-agent',
      agentTrigger: {
        version: 1,
        event: {
          id: 'occurrence-1',
          type: 'schedule.occurrence',
          occurredAt: 0,
          source: { type: 'schedule', id: 'schedule' },
        },
      },
    },
  };
}

/** The turn the trigger host starts to report a task, with what the task kept of its run. */
function completion(
  began: ReturnType<typeof createTriggerExecutionContext>,
  marker: Record<string, unknown> = {},
) {
  const trigger = captureTrigger(began);
  return {
    user,
    _isAgentTrigger: true,
    body: {
      agent_id: 'root-agent',
      conversationId: 'conversation',
      clientRequestId: 'trigger_wake',
      agentEvent: {
        id: 'task-1',
        type: 'background_tool.completed',
        occurredAt: 2_000,
        source: { type: 'internal', id: 'background-tool-completion' },
      },
      agentCompletion: {
        version: 1,
        sourceId: 'background-tool-completion',
        ...(trigger && { trigger }),
        ...marker,
      },
    },
  };
}

it("puts a key's delivery under the key before the run initializes", async () => {
  const h = hosts();
  const req = delivery();
  const executionContext = createTriggerExecutionContext(req);
  const signal = new AbortController().signal;
  const context = createMCPRequestContext();
  h.keyHost.resolve.mockImplementationOnce(async () => {
    h.order.push('key');
    return {
      identity: keyIdentity,
      context,
      stage: 'invoke',
      require: 'run',
      agentId: 'root-agent',
    };
  });
  await expect(
    initializeWithAuthority({ req, executionContext, signal }, h.adapters, h.initialize),
  ).resolves.toBe('client');
  expect(h.order).toEqual(['key', 'key:attach', 'initialize']);
  expect(h.keyHost.resolve).toHaveBeenCalledWith({ req, executionContext, signal });
  expect(h.keyHost.execution.attach).toHaveBeenCalledWith(
    context,
    keyIdentity,
    'invoke',
    false,
    {},
  );
  expect(h.built.schedule).toBe(0);
  expect(h.retain).not.toHaveBeenCalled();
});

it('does not initialize a run the key refuses, and hands the refusal on as it is', async () => {
  const h = hosts();
  const refusal = new RunGrantPolicyError('binding_mismatch', '');
  h.keyHost.resolve.mockRejectedValueOnce(refusal);
  const req = delivery();
  const input = { req, executionContext: createTriggerExecutionContext(req) };
  await expect(initializeWithAuthority(input, h.adapters, h.initialize)).rejects.toBe(refusal);
  // A key has no run record for a failure to be stored on, so one that is not a refusal
  // reaches the caller unchanged.
  const outage = new Error('config service down');
  h.keyHost.resolve.mockRejectedValueOnce(outage);
  await expect(initializeWithAuthority(input, h.adapters, h.initialize)).rejects.toBe(outage);
  expect(h.initialize).not.toHaveBeenCalled();
});

it('refuses a run its subject requires a place for and cannot be given one, naming the agent', async () => {
  const h = hosts();
  const req = delivery();
  const context = createMCPRequestContext();
  h.keyHost.resolve.mockResolvedValueOnce({
    identity: keyIdentity,
    context,
    stage: 'invoke',
    require: 'run',
    agentId: 'root-agent',
  });
  h.keyHost.execution.attach.mockResolvedValueOnce(false);
  const failure = await initializeWithAuthority(
    { req, executionContext: createTriggerExecutionContext(req) },
    h.adapters,
    h.initialize,
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(RunGrantPolicyError);
  expect(failure).toMatchObject({
    failure: { reason: 'binding_mismatch' },
    outcomes: [{ agentId: 'root-agent' }],
  });
  expect(h.initialize).not.toHaveBeenCalled();
});

it('initializes an ordinary chat request as it is, building no host for it', async () => {
  const h = hosts();
  await expect(
    initializeWithAuthority({ req: { user, body: {} } }, h.adapters, h.initialize),
  ).resolves.toBe('client');
  expect(h.order).toEqual(['initialize']);
  expect(h.built).toEqual({ schedule: 0, key: 0 });
});

it('sends a schedule occurrence to the schedule and not to the key', async () => {
  const h = hosts();
  const req = scheduleFire();
  const context = createMCPRequestContext();
  const without = { skip: ['warehouse'], servers: ['warehouse', 'notes'] };
  h.scheduleHost.resolve.mockImplementationOnce(async () => {
    h.order.push('schedule');
    return {
      identity: scheduleIdentity,
      context,
      stage: 'invoke',
      require: 'grant',
      options: { manual: true },
    };
  });
  h.scheduleHost.restore.mockResolvedValueOnce(without);
  await initializeWithAuthority(
    { req, context, executionContext: createTriggerExecutionContext(req) },
    h.adapters,
    h.initialize,
  );
  expect(h.order).toEqual(['schedule', 'schedule:attach', 'initialize']);
  // A schedule that holds a grant runs under it or not at all, and goes without what its
  // delivery went without.
  expect(h.scheduleHost.execution.attach).toHaveBeenCalledWith(
    context,
    scheduleIdentity,
    'invoke',
    true,
    { manual: true, without },
  );
  expect(h.built.key).toBe(0);
  // An occurrence is not a completion turn: nothing is kept on its job.
  expect(h.retain).not.toHaveBeenCalled();
});

it('reports a failure to put a run under a schedule as the grant being unavailable', async () => {
  const h = hosts();
  const req = scheduleFire();
  h.scheduleHost.resolve.mockRejectedValueOnce(new Error('PRIVATE schedule query'));
  const failure = await initializeWithAuthority(
    {
      req,
      context: createMCPRequestContext(),
      executionContext: createTriggerExecutionContext(req),
    },
    h.adapters,
    h.initialize,
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(RunGrantPolicyError);
  expect(failure).toMatchObject({ failure: { reason: 'dependency_unavailable' } });
  expect(String(failure)).not.toContain('PRIVATE');
  expect(h.initialize).not.toHaveBeenCalled();
});

it("puts a key's delivery under the key again when its saved job resumes it", async () => {
  const h = hosts();
  const req = { user, body: {} };
  const executionContext = restoreExecutionContext(req, {
    userId: 'owner',
    tenantId: 'tenant',
    agent_id: 'root-agent',
    trigger: parseRunTrigger(createTriggerExecutionContext(delivery())?.source),
  });
  await initializeWithAuthority({ req, executionContext }, h.adapters, h.initialize);
  expect(h.order).toEqual(['key', 'initialize']);
  expect(h.keyHost.resolve).toHaveBeenCalledWith({ req, executionContext });
  expect(getSourceKey(executionContext)).toBe('key-1');
  expect(executionContext?.source).toMatchObject({ resumed: true });
});

it("puts the turn that reports a key run's task under the key, and builds no schedule host", async () => {
  const h = hosts();
  const req = completion(createTriggerExecutionContext(delivery()));
  const executionContext = createTriggerExecutionContext(req);
  expect(isCompletionTurn(req)).toBe(true);
  await initializeWithAuthority(
    { req, context: createMCPRequestContext(), executionContext },
    h.adapters,
    h.initialize,
  );
  // The turn names no schedule on its marker, so the schedule does not claim it.
  expect(h.order).toEqual(['key', 'initialize']);
  expect(h.built.schedule).toBe(0);
  expect(getSourceKey(executionContext)).toBe('key-1');
});

it("puts the turn that reports a schedule's task under the schedule, and keeps it on the job", async () => {
  const h = hosts();
  const req = completion(createTriggerExecutionContext(scheduleFire()), {
    scheduleMCPIdentity: scheduleIdentity,
  });
  const executionContext = createTriggerExecutionContext(req);
  expect(executionContext?.source).toMatchObject({ subject: { kind: 'schedule', id: 'schedule' } });
  const context = createMCPRequestContext();
  h.scheduleHost.resolve.mockImplementationOnce(async () => {
    h.order.push('schedule');
    return {
      identity: scheduleIdentity,
      context,
      stage: 'invoke',
      require: 'run',
      options: { completion: true },
    };
  });
  await initializeWithAuthority({ req, context, executionContext }, h.adapters, h.initialize);
  expect(h.order).toEqual(['schedule', 'schedule:attach', 'retain', 'initialize']);
  expect(h.retain).toHaveBeenCalledWith(scheduleIdentity);
  expect(h.built.key).toBe(0);
});

it('does not keep a schedule on the job of a turn it was not put over', async () => {
  const h = hosts();
  const req = completion(createTriggerExecutionContext(scheduleFire()), {
    scheduleMCPIdentity: scheduleIdentity,
  });
  await initializeWithAuthority(
    { req, context: createMCPRequestContext(), executionContext: undefined },
    h.adapters,
    h.initialize,
  );
  // The schedule found nothing to put the turn under.
  expect(h.order).toEqual(['schedule', 'initialize']);
  expect(h.retain).not.toHaveBeenCalled();
});

it("leaves the turn that reports an interactive chat's task as it was", async () => {
  const h = hosts();
  const req = completion(undefined);
  const executionContext = createTriggerExecutionContext(req);
  expect(executionContext?.source).not.toHaveProperty('subject');
  expect(executionContext?.source).not.toHaveProperty('origin');
  await initializeWithAuthority(
    { req, context: createMCPRequestContext(), executionContext },
    h.adapters,
    h.initialize,
  );
  expect(h.order).toEqual(['initialize']);
  expect(h.built).toEqual({ schedule: 0, key: 0 });
});

it('refuses a completion turn that is malformed or has nowhere to hold a grant, whoever it is for', async () => {
  const h = hosts();
  const forged = completion(undefined, { sourceId: 'someone-else' });
  await expect(
    initializeWithAuthority(
      { req: forged, context: createMCPRequestContext() },
      h.adapters,
      h.initialize,
    ),
  ).rejects.toMatchObject({ failure: { reason: 'binding_mismatch' } });
  await expect(
    initializeWithAuthority({ req: completion(undefined) }, h.adapters, h.initialize),
  ).rejects.toMatchObject({ failure: { reason: 'binding_mismatch' } });
  expect(h.initialize).not.toHaveBeenCalled();
  expect(h.built).toEqual({ schedule: 0, key: 0 });
});

it('initializes a delivery no subject started as it is', async () => {
  const h = hosts();
  const req = {
    user,
    _isAgentTrigger: true,
    body: {
      agent_id: 'root-agent',
      conversationId: 'conversation',
      clientRequestId: 'trigger_ghi',
      agentEvent: {
        id: 'event-2',
        type: 'agent.queued-turn',
        occurredAt: 2_000,
        source: { type: 'internal', id: 'agent-queued-turn' },
      },
      agentContinuationAdmission: {},
    },
  };
  const executionContext = createTriggerExecutionContext(req);
  expect(executionContext?.source).toMatchObject({ type: 'trigger', resumed: false });
  await initializeWithAuthority(
    { req, context: createMCPRequestContext(), executionContext },
    h.adapters,
    h.initialize,
  );
  expect(h.built).toEqual({ schedule: 0, key: 0 });
});

it('leaves a run the remote API started to the controller that already prepared it', async () => {
  const h = hosts();
  await initializeWithAuthority(
    {
      req: { user, body: {} },
      executionContext: createRemoteExecutionContext({
        principal: { userId: 'owner', tenantId: 'tenant' },
        agentId: 'root-agent',
        protocol: 'responses',
        background: true,
        keyId: 'key-1',
      }),
    },
    h.adapters,
    h.initialize,
  );
  expect(h.built.key).toBe(0);
  expect(h.order).toEqual(['initialize']);
});

it('runs a third kind of subject with nothing in the host written for it', async () => {
  const order: string[] = [];
  const context = createMCPRequestContext();
  const without = { skip: ['warehouse'], servers: ['warehouse'] };
  // A subscription holds its grant like a key does; the host never looks inside an identity.
  const identity: AgentKeyMCPIdentity = { ...keyIdentity, keyId: 'subscription-1' };
  type Input = SubjectInput & {
    req: SubjectInput['req'] & { user: typeof user; subscription?: string };
  };
  const subscription: SubjectAdapter<AgentKeyMCPIdentity, Input> = {
    kind: 'subscription',
    claims: ({ req }) => req.subscription != null,
    resolve: async () => {
      order.push('resolve');
      return { identity, context, stage: 'invoke', require: 'run' };
    },
    restore: async () => {
      order.push('restore');
      return without;
    },
    execution: {
      resolve: async () => undefined,
      attach: jest.fn(async () => {
        order.push('attach');
        return true;
      }),
    },
    retain: async (kept) => {
      order.push(`retain:${kept.keyId}`);
    },
  };
  const initialize = jest.fn(async () => 'client');
  await initializeWithAuthority({ req: { user } }, [subscription], initialize);
  expect(order).toEqual([]);
  await initializeWithAuthority(
    { req: { user, subscription: 'subscription-1' } },
    [subscription],
    initialize,
  );
  expect(order).toEqual(['resolve', 'restore', 'attach', 'retain:subscription-1']);
  expect(subscription.execution.attach).toHaveBeenCalledWith(context, identity, 'invoke', false, {
    without,
  });
  expect(initialize).toHaveBeenCalledTimes(2);
  // The same adapter, asked outside the chat route.
  order.length = 0;
  await placeRun([subscription], { req: { user, subscription: 'subscription-1' } });
  expect(order).toEqual(['resolve', 'restore', 'attach', 'retain:subscription-1']);
});
