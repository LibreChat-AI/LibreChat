import { EModelEndpoint } from 'librechat-data-provider';
import type { HandoffOutcome } from '@librechat/agents';
import type { AgentHandoffRunSnapshot } from '../promotion';
import { createAgentHandoffLifecycle, resolveAgentHandoffStartup } from './lifecycle';

const identity = { user: 'owner', tenantId: null, conversationId: 'convo-1' };
const candidate: HandoffOutcome = {
  status: 'candidate',
  entryAgentId: 'agent_a',
  executionId: 'execution-1',
  agentId: 'agent_b',
  transitionId: 'transition-1',
  transitions: [
    {
      id: 'transition-1',
      sourceAgentId: 'agent_a',
      targetAgentId: 'agent_b',
      toolCallId: 'call-1',
      scope: 'conversation',
      depth: 0,
    },
  ],
};
const initial = { version: 1 as const, maxHandoffs: 10, expectedRevision: 0 };
const admission = {
  agentId: 'agent_a',
  revision: 1,
  generation: 100,
  maxHandoffs: 10,
};

function fixture(snapshot: AgentHandoffRunSnapshot = initial, enabled = true) {
  let stored: AgentHandoffRunSnapshot = snapshot;
  const deps = {
    admit: jest.fn(async () => ({
      agentId: 'agent_a',
      revision: 1,
      generation: 100,
      automaticHandoffsEnabled: true,
    })),
    read: jest.fn(async () => null),
    commit: jest.fn(async () => ({
      status: 'committed' as const,
      decision: {
        agentId: 'agent_b',
        revision: 2,
        transitionId: 'transition-1',
        automaticHandoffsEnabled: true,
      },
    })),
    finish: jest.fn(async () => ({
      agentId: 'agent_a',
      revision: 1,
      automaticHandoffsEnabled: true,
    })),
    getAgent: jest.fn(async () => ({ id: 'agent_b', _id: { toString: () => 'mongo-b' } })),
    checkPermission: jest.fn(async () => true),
    updateMetadata: jest.fn(async (_id: string, value: { agentHandoffRun: typeof stored }) => {
      stored = value.agentHandoffRun;
    }),
    getJob: jest.fn(async () => ({ createdAt: 100, metadata: { agentHandoffRun: stored } })),
  };
  return {
    deps,
    lifecycle: createAgentHandoffLifecycle(
      { identity, agentId: 'agent_a', generation: 100, role: 'USER', enabled, snapshot },
      deps,
    ),
  };
}

it('owns the same default-off eligibility for fresh and resumed handoffs', () => {
  const input = { agentId: 'agent_a', endpoint: EModelEndpoint.agents, config: { enabled: true } };
  expect(resolveAgentHandoffStartup(input)).toEqual({ version: 1, maxHandoffs: 10 });
  expect(resolveAgentHandoffStartup({ ...input, config: { enabled: false } })).toBeUndefined();
  expect(resolveAgentHandoffStartup({ ...input, trigger: true })).toBeUndefined();
  expect(resolveAgentHandoffStartup({ ...input, editedContent: 'replacement' })).toBeUndefined();
  expect(resolveAgentHandoffStartup({ ...input, expectedRevision: 5 })).toMatchObject({
    expectedRevision: 5,
  });
});

it('records one fresh admission and commits only after a durable user write and terminal response', async () => {
  const { lifecycle, deps } = fixture();
  const ready = lifecycle.begin(
    Promise.resolve({
      message: { _id: 'user-message' },
      conversation: { conversationId: 'convo-1' },
    }),
    false,
    'agent_a',
  );
  const conversation = { agent_id: 'agent_a', agentRoutingRevision: 0 };
  const result = await lifecycle.complete({
    ready,
    status: 'complete',
    unfinished: false,
    run: { getHandoffOutcome: () => candidate },
    conversation,
  });
  expect(result).toMatchObject({ toAgentId: 'agent_b', revision: 2 });
  expect(deps.admit).toHaveBeenCalledTimes(1);
  expect(deps.updateMetadata).toHaveBeenCalledWith(
    'convo-1',
    {
      agentHandoffRun: { ...initial, admission },
    },
    100,
  );
  expect(deps.commit).toHaveBeenCalledWith({
    ...identity,
    agentId: 'agent_b',
    transitionId: 'transition-1',
    expected: { agentId: 'agent_a', revision: 1, generation: 100 },
  });
  expect(deps.updateMetadata.mock.invocationCallOrder[0]).toBeLessThan(
    deps.commit.mock.invocationCallOrder[0],
  );
  expect(conversation).toMatchObject({ agent_id: 'agent_b', automaticHandoffsEnabled: true });
});

it('reuses the original admitted generation on resume without admitting it a second time', async () => {
  const { deps, lifecycle } = fixture({ ...initial, admission });
  const conversation = { agent_id: 'agent_a' };
  expect(
    await lifecycle.complete({
      status: 'complete',
      unfinished: false,
      run: { getHandoffOutcome: () => candidate },
      conversation,
    }),
  ).toMatchObject({ toAgentId: 'agent_b' });
  expect(deps.admit).not.toHaveBeenCalled();
});

it('does not promote a paused, failed, or operator-disabled turn', async () => {
  const { deps, lifecycle } = fixture({ ...initial, admission }, false);
  expect(
    await lifecycle.complete({
      status: 'complete',
      unfinished: false,
      run: { getHandoffOutcome: () => candidate },
      conversation: { agent_id: 'agent_a' },
    }),
  ).toBeNull();
  expect(deps.commit).not.toHaveBeenCalled();
  expect(deps.finish).toHaveBeenCalledTimes(1);
});

it('propagates an unverifiable terminal admission outage instead of publishing a false success', async () => {
  const { deps, lifecycle } = fixture();
  deps.admit.mockRejectedValueOnce(new Error('Mongo unavailable'));
  deps.read.mockRejectedValueOnce(new Error('Mongo read unavailable'));
  await expect(
    lifecycle.complete({
      status: 'complete',
      unfinished: false,
      run: { getHandoffOutcome: () => candidate },
      conversation: { agent_id: 'agent_a' },
    }),
  ).rejects.toThrow('Agent routing admission could not be verified');
  expect(deps.commit).not.toHaveBeenCalled();
});
