import type { AuthorityHosts } from './host';
import { createRemoteExecutionContext, createTriggerExecutionContext } from './context';
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
