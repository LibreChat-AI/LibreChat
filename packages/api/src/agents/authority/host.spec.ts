import type { AuthorityHosts } from './host';
import {
  getSourceKey,
  restoreExecutionContext,
  createRemoteExecutionContext,
  createTriggerExecutionContext,
} from './context';
import { parseRunTrigger, captureTrigger } from './trigger';
import { createMCPRequestContext } from '~/mcp/request';
import { initializeWithAuthority } from './host';
import { RunGrantPolicyError } from './policy';

const user = { id: 'owner', tenantId: 'tenant' };

function hosts() {
  const order: string[] = [];
  const schedule = { prepare: jest.fn(async () => void order.push('schedule')) };
  const key = { prepare: jest.fn(async () => void order.push('key')) };
  const initialize = jest.fn(async () => {
    order.push('initialize');
    return 'client';
  });
  const get = (): AuthorityHosts => ({ schedule, key });
  return { order, schedule, key, initialize, get };
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

it("puts a key's delivery under the key host before the run initializes", async () => {
  const h = hosts();
  const req = delivery();
  const executionContext = createTriggerExecutionContext(req);
  const signal = new AbortController().signal;
  await expect(
    initializeWithAuthority({ req, executionContext, signal }, h.get, h.initialize),
  ).resolves.toBe('client');
  expect(h.order).toEqual(['key', 'initialize']);
  expect(h.key.prepare).toHaveBeenCalledWith({ req, executionContext, signal });
  expect(h.schedule.prepare).not.toHaveBeenCalled();
});

it('does not initialize a run the key host refuses', async () => {
  const h = hosts();
  const refusal = new RunGrantPolicyError('binding_mismatch', '');
  h.key.prepare.mockRejectedValueOnce(refusal);
  const req = delivery();
  await expect(
    initializeWithAuthority(
      { req, executionContext: createTriggerExecutionContext(req) },
      h.get,
      h.initialize,
    ),
  ).rejects.toBe(refusal);
  expect(h.initialize).not.toHaveBeenCalled();
});

it('initializes an ordinary chat request as it is', async () => {
  const h = hosts();
  await expect(
    initializeWithAuthority({ req: { user, body: {} } }, h.get, h.initialize),
  ).resolves.toBe('client');
  expect(h.order).toEqual(['initialize']);
});

it('sends a schedule occurrence to the schedule host and not to the key host', async () => {
  const h = hosts();
  const req = scheduleFire();
  await initializeWithAuthority(
    {
      req,
      context: createMCPRequestContext(),
      executionContext: createTriggerExecutionContext(req),
    },
    h.get,
    h.initialize,
  );
  expect(h.order).toEqual(['schedule', 'initialize']);
  expect(h.key.prepare).not.toHaveBeenCalled();
});

it("puts a key's delivery under the key host again when its saved job resumes it", async () => {
  const h = hosts();
  const req = { user, body: {} };
  const executionContext = restoreExecutionContext(req, {
    userId: 'owner',
    tenantId: 'tenant',
    agent_id: 'root-agent',
    trigger: parseRunTrigger(createTriggerExecutionContext(delivery())?.source),
  });
  await initializeWithAuthority({ req, executionContext }, h.get, h.initialize);
  expect(h.order).toEqual(['key', 'initialize']);
  expect(h.key.prepare).toHaveBeenCalledWith({ req, executionContext, signal: undefined });
  expect(getSourceKey(executionContext)).toBe('key-1');
  expect(executionContext?.source).toMatchObject({ resumed: true });
});

/** The turn the trigger host starts to report a task, with what the task kept of its run. */
function completion(began: ReturnType<typeof createTriggerExecutionContext>) {
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
      },
    },
  };
}

it("puts the turn that reports a key run's task under the key host, after the schedule host", async () => {
  const h = hosts();
  const req = completion(createTriggerExecutionContext(delivery()));
  const executionContext = createTriggerExecutionContext(req);
  await initializeWithAuthority(
    { req, context: createMCPRequestContext(), executionContext },
    h.get,
    h.initialize,
  );
  // The schedule host is asked about every completion turn, and finds no schedule on this one.
  expect(h.order).toEqual(['schedule', 'key', 'initialize']);
  expect(h.key.prepare).toHaveBeenCalledWith({ req, executionContext, signal: undefined });
  expect(getSourceKey(executionContext)).toBe('key-1');
});

it("leaves the turn that reports a schedule's task to the schedule host", async () => {
  const h = hosts();
  const req = completion(createTriggerExecutionContext(scheduleFire()));
  const executionContext = createTriggerExecutionContext(req);
  expect(executionContext?.source).toMatchObject({ subject: { kind: 'schedule', id: 'schedule' } });
  await initializeWithAuthority(
    { req, context: createMCPRequestContext(), executionContext },
    h.get,
    h.initialize,
  );
  expect(h.order).toEqual(['schedule', 'initialize']);
  expect(h.key.prepare).not.toHaveBeenCalled();
});

it("leaves the turn that reports an interactive chat's task as it was", async () => {
  const h = hosts();
  const req = completion(undefined);
  const executionContext = createTriggerExecutionContext(req);
  expect(executionContext?.source).not.toHaveProperty('subject');
  expect(executionContext?.source).not.toHaveProperty('origin');
  await initializeWithAuthority(
    { req, context: createMCPRequestContext(), executionContext },
    h.get,
    h.initialize,
  );
  expect(h.order).toEqual(['schedule', 'initialize']);
  expect(h.key.prepare).not.toHaveBeenCalled();
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
    h.get,
    h.initialize,
  );
  expect(h.key.prepare).not.toHaveBeenCalled();
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
    h.get,
    h.initialize,
  );
  expect(h.key.prepare).not.toHaveBeenCalled();
  expect(h.order).toEqual(['initialize']);
});
