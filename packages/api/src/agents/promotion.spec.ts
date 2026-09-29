import { EModelEndpoint } from 'librechat-data-provider';
import type { ConversationMethods } from '@librechat/data-schemas';
import type { HandoffOutcome } from '@librechat/agents';
import type { CommitAgentHandoffInput } from './promotion';
import {
  commitAgentHandoff,
  getCommittableAgentHandoff,
  resolveInitialHandoffRunSnapshot,
  isAgentHandoffRunSnapshot,
  admitAgentHandoffRun,
  recordAgentHandoffSnapshot,
  createAgentHandoffAuthorization,
  reconcileTerminalAgentHandoff,
} from './promotion';

const identity = { user: 'owner', conversationId: 'conversation-1', tenantId: null };
const admission = { agentId: 'agent_a', revision: 1, generation: 100, maxHandoffs: 10 };
const transition = {
  id: 'transition-1',
  sourceAgentId: 'agent_a',
  targetAgentId: 'agent_b',
  toolCallId: 'call-1',
  scope: 'conversation' as const,
  depth: 0,
};
const outcome: HandoffOutcome = {
  status: 'candidate',
  executionId: 'sdk-execution-1',
  entryAgentId: 'agent_a',
  transitions: [transition],
  agentId: 'agent_b',
  transitionId: transition.id,
};
const input = (candidate: HandoffOutcome | undefined = outcome): CommitAgentHandoffInput => ({
  identity,
  admission,
  run: { getHandoffOutcome: () => candidate },
  enabled: true,
  completed: true,
});

const commit = jest.fn<
  ReturnType<ConversationMethods['commitConvoAgentHandoff']>,
  [Parameters<ConversationMethods['commitConvoAgentHandoff']>[0]]
>(async () => ({
  status: 'committed',
  decision: { agentId: 'agent_b', revision: 2, automaticHandoffsEnabled: true },
}));
const read = jest.fn<
  ReturnType<ConversationMethods['getConvoAgentRoutingDecision']>,
  [typeof identity]
>(async () => null);
const finish = jest.fn<
  ReturnType<ConversationMethods['finishConvoAgentRoutingGeneration']>,
  [Parameters<ConversationMethods['finishConvoAgentRoutingGeneration']>[0]]
>(async () => ({ agentId: 'agent_a', revision: 1, automaticHandoffsEnabled: true }));
const canAccessDestination = jest.fn(async () => true);
const deps = { commit, finish, read, canAccessDestination };

beforeEach(() => {
  jest.clearAllMocks();
  commit.mockResolvedValue({
    status: 'committed',
    decision: { agentId: 'agent_b', revision: 2, automaticHandoffsEnabled: true },
  });
  read.mockResolvedValue(null);
  finish.mockResolvedValue({ agentId: 'agent_a', revision: 1, automaticHandoffsEnabled: true });
  canAccessDestination.mockResolvedValue(true);
});

describe('handoff run snapshot', () => {
  const valid = {
    enabled: true,
    maxHandoffs: 10,
    endpoint: EModelEndpoint.agents,
    persistedAgent: true,
  };

  it('opts only ordinary persisted-agent turns into a bounded snapshot', () => {
    expect(resolveInitialHandoffRunSnapshot(valid)).toEqual({ version: 1, maxHandoffs: 10 });
    expect(isAgentHandoffRunSnapshot({ version: 1, maxHandoffs: 10 })).toBe(true);
  });

  it.each([
    { enabled: false },
    { persistedAgent: false },
    { isAutomated: true },
    { isTemporary: true },
    { isRegenerate: true },
    { isContinued: true },
    { isEdited: true },
    { isCompaction: true },
    { hasAddedConversation: true },
    { modelSpecEnforced: true },
    { endpoint: EModelEndpoint.openAI },
  ])('does not opt unsupported origin %o into routing', (change) => {
    expect(resolveInitialHandoffRunSnapshot({ ...valid, ...change })).toBeUndefined();
  });

  it('binds one admitted next-turn candidate to the exact completed user generation', async () => {
    const admit = jest.fn().mockResolvedValue({
      agentId: 'agent_a',
      revision: 1,
      generation: 100,
      automaticHandoffsEnabled: true,
    });
    const record = jest.fn().mockResolvedValue(true);
    const snapshot = resolveInitialHandoffRunSnapshot(valid)!;
    const result = await admitAgentHandoffRun(
      { identity, agentId: 'agent_a', generation: 100, snapshot },
      { admit, read, record },
    );
    expect(admit).toHaveBeenCalledWith({
      ...identity,
      expectedAgentId: 'agent_a',
      expectedRevision: 0,
      generation: 100,
    });
    expect(result.admission).toMatchObject({ agentId: 'agent_a', generation: 100, revision: 1 });
    expect(record).toHaveBeenCalledWith(result);
  });

  it('propagates an unverifiable database admission outage to the generation owner', async () => {
    const admit = jest.fn().mockRejectedValue(new Error('write unavailable'));
    read.mockRejectedValueOnce(new Error('read unavailable'));
    const snapshot = resolveInitialHandoffRunSnapshot(valid)!;
    await expect(
      admitAgentHandoffRun(
        { identity, agentId: 'agent_a', generation: 100, snapshot },
        { admit, read, record: jest.fn() },
      ),
    ).rejects.toThrow('Agent routing admission could not be verified');
  });

  it('degrades a stale admission to an unpromotable turn, including same-agent revisions', async () => {
    const admit = jest.fn().mockResolvedValue(null);
    const record = jest.fn();
    const snapshot = resolveInitialHandoffRunSnapshot(valid)!;
    read.mockResolvedValueOnce({
      agentId: 'agent_a',
      revision: 1,
      automaticHandoffsEnabled: false,
    });
    expect(
      await admitAgentHandoffRun(
        { identity, agentId: 'agent_a', generation: 100, snapshot },
        { admit, read, record },
      ),
    ).toBe(snapshot);
    read.mockResolvedValueOnce({
      agentId: 'agent_c',
      revision: 2,
      automaticHandoffsEnabled: true,
    });
    await expect(
      admitAgentHandoffRun(
        { identity, agentId: 'agent_a', generation: 100, snapshot },
        { admit, read, record },
      ),
    ).resolves.toBe(snapshot);
    read.mockResolvedValueOnce({
      agentId: 'agent_a',
      revision: 1,
      automaticHandoffsEnabled: true,
    });
    await expect(
      admitAgentHandoffRun(
        { identity, agentId: 'agent_a', generation: 100, snapshot },
        { admit, read, record },
      ),
    ).resolves.toBe(snapshot);
    expect(record).not.toHaveBeenCalled();
  });

  it('recovers an ambiguous Mongo admission only from the exact generation and revision', async () => {
    const admit = jest.fn().mockRejectedValue(new Error('lost acknowledgement'));
    const record = jest.fn().mockResolvedValue(true);
    const snapshot = resolveInitialHandoffRunSnapshot(valid)!;
    read.mockResolvedValueOnce({
      agentId: 'agent_a',
      revision: 1,
      generation: 100,
      automaticHandoffsEnabled: true,
    });
    expect(
      (
        await admitAgentHandoffRun(
          { identity, agentId: 'agent_a', generation: 100, snapshot },
          { admit, read, record },
        )
      ).admission,
    ).toMatchObject({ agentId: 'agent_a', generation: 100, revision: 1 });
    read.mockResolvedValueOnce({
      agentId: 'agent_a',
      revision: 2,
      generation: 200,
      automaticHandoffsEnabled: true,
    });
    await expect(
      admitAgentHandoffRun(
        { identity, agentId: 'agent_a', generation: 100, snapshot },
        { admit, read, record },
      ),
    ).resolves.toBe(snapshot);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('handles a failed job recording (throws=%s)', async (throws) => {
    const admit = jest.fn().mockResolvedValue({
      agentId: 'agent_a',
      revision: 1,
      generation: 100,
      automaticHandoffsEnabled: true,
    });
    const record = jest
      .fn()
      .mockImplementation(() =>
        throws ? Promise.reject(new Error('job unavailable')) : Promise.resolve(false),
      );
    const snapshot = resolveInitialHandoffRunSnapshot(valid)!;
    const attempt = admitAgentHandoffRun(
      { identity, agentId: 'agent_a', generation: 100, snapshot },
      { admit, read, record },
    );
    if (throws) {
      await expect(attempt).rejects.toThrow('Agent routing admission could not be recorded');
    } else {
      await expect(attempt).resolves.toBe(snapshot);
    }
  });

  it('refuses an admission if the job record was replaced before durable recording', async () => {
    const snapshot = { ...resolveInitialHandoffRunSnapshot(valid)!, admission };
    const write = jest.fn().mockResolvedValue(undefined);
    const readJob = jest.fn().mockResolvedValue({
      createdAt: 101,
      metadata: { agentHandoffRun: snapshot },
    });
    expect(await recordAgentHandoffSnapshot(snapshot, 100, { write, read: readJob })).toBe(false);
    expect(write).toHaveBeenCalledWith(snapshot);
    readJob.mockResolvedValueOnce({ createdAt: 100, metadata: { agentHandoffRun: snapshot } });
    expect(await recordAgentHandoffSnapshot(snapshot, 100, { write, read: readJob })).toBe(true);
  });

  it('rejects an untrusted or malformed resumed budget and admission', () => {
    for (const value of [
      { version: 1, maxHandoffs: 0 },
      { version: 1, maxHandoffs: 101 },
      { version: 1, maxHandoffs: 10, admission: { ...admission, generation: -1 } },
      { version: 1, maxHandoffs: 10, admission: { ...admission, maxHandoffs: 9 } },
    ]) {
      expect(isAgentHandoffRunSnapshot(value)).toBe(false);
    }
  });
});

describe('terminal conversation handoff promotion', () => {
  it('publishes only a committed transition and updates the outgoing conversation selection', async () => {
    const conversation = { agent_id: 'agent_a', agentRoutingRevision: 1 };
    commit.mockResolvedValueOnce({
      status: 'committed',
      decision: {
        agentId: 'agent_b',
        revision: 2,
        transitionId: transition.id,
        automaticHandoffsEnabled: true,
      },
    });
    await expect(
      reconcileTerminalAgentHandoff({ ...input(), conversation }, deps),
    ).resolves.toEqual({
      fromAgentId: 'agent_a',
      toAgentId: 'agent_b',
      transitionId: transition.id,
      revision: 2,
    });
    expect(conversation).toEqual({
      agent_id: 'agent_b',
      agentRoutingRevision: 2,
      automaticHandoffsEnabled: true,
    });
  });

  it('never publishes a winning switch after a manual selection beats the terminal CAS', async () => {
    const conversation = { agent_id: 'agent_a', agentRoutingRevision: 1 };
    commit.mockResolvedValueOnce({
      status: 'conflict',
      decision: { agentId: 'agent_c', revision: 2, automaticHandoffsEnabled: true },
    });
    await expect(
      reconcileTerminalAgentHandoff({ ...input(), conversation }, deps),
    ).resolves.toBeNull();
    expect(conversation).toEqual({
      agent_id: 'agent_c',
      agentRoutingRevision: 2,
      automaticHandoffsEnabled: true,
    });
  });

  it('projects the winning opt-out preference when the toggle races terminal promotion', async () => {
    const conversation = {
      agent_id: 'agent_a',
      agentRoutingRevision: 1,
      automaticHandoffsEnabled: true,
    };
    commit.mockResolvedValueOnce({
      status: 'conflict',
      decision: { agentId: 'agent_a', revision: 2, automaticHandoffsEnabled: false },
    });
    finish.mockResolvedValueOnce(null);
    await expect(
      reconcileTerminalAgentHandoff({ ...input(), conversation }, deps),
    ).resolves.toBeNull();
    expect(conversation).toEqual({
      agent_id: 'agent_a',
      agentRoutingRevision: 2,
      automaticHandoffsEnabled: false,
    });
  });

  it('ignores an error response with an SDK candidate left behind', async () => {
    const responseContent = [{ type: 'error' }];
    await expect(
      reconcileTerminalAgentHandoff(
        { ...input(), responseContent, conversation: { agent_id: 'agent_a' } },
        deps,
      ),
    ).resolves.toBeNull();
    expect(commit).not.toHaveBeenCalled();
  });

  it('authorizes the destination and commits the exact admitted SDK transition', async () => {
    expect(await commitAgentHandoff(input(), deps)).toMatchObject({ status: 'committed' });
    expect(canAccessDestination).toHaveBeenCalledWith('agent_b');
    expect(commit).toHaveBeenCalledWith({
      ...identity,
      expected: { agentId: 'agent_a', revision: 1, generation: 100 },
      agentId: 'agent_b',
      transitionId: transition.id,
    });
  });

  it.each([
    ['disabled', { enabled: false }],
    ['interrupted', { completed: false }],
    ['not admitted', { admission: null }],
    ['halted', { run: { getHandoffOutcome: () => outcome, getHaltReason: () => 'handoff_limit' } }],
  ])('does not promote %s turns', async (_label, change) => {
    expect(await commitAgentHandoff({ ...input(), ...change }, deps)).toBeNull();
    expect(canAccessDestination).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it.each(['unchanged', 'ambiguous', 'incomplete'] as const)(
    'does not promote an SDK %s outcome',
    async (status) => {
      const candidate =
        status === 'incomplete' ? { ...outcome, status, reason: 'paused' } : { ...outcome, status };
      expect(getCommittableAgentHandoff(input(candidate))).toBeNull();
    },
  );

  it('rejects a mismatched entry or unverified transition', async () => {
    expect(
      getCommittableAgentHandoff(input({ ...outcome, entryAgentId: 'agent_other' })),
    ).toBeNull();
    expect(
      getCommittableAgentHandoff(input({ ...outcome, transitionId: 'not-recorded' })),
    ).toBeNull();
    expect(
      getCommittableAgentHandoff(
        input({ ...outcome, transitions: [{ ...transition, scope: 'turn' }] }),
      ),
    ).toBeNull();
  });

  it('uses a fresh agent lookup and resource VIEW permission for the target', async () => {
    const getAgent = jest
      .fn()
      .mockResolvedValue({ id: 'agent_b', _id: { toString: () => 'db-agent-b' } });
    const checkPermission = jest.fn().mockResolvedValue(true);
    const authorized = createAgentHandoffAuthorization({
      userId: identity.user,
      role: 'USER',
      getAgent,
      checkPermission,
    });
    expect(await authorized('agent_b')).toBe(true);
    expect(getAgent).toHaveBeenCalledWith({ id: 'agent_b' });
    expect(checkPermission).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: 'db-agent-b', requiredPermission: 1 }),
    );
    getAgent.mockResolvedValueOnce(null);
    expect(await authorized('agent_b')).toBe(false);
    checkPermission.mockResolvedValueOnce(false);
    expect(await authorized('agent_b')).toBe(false);
  });

  it('cannot commit when the target loses access before the database write', async () => {
    canAccessDestination.mockResolvedValueOnce(false);
    expect(await commitAgentHandoff(input(), deps)).toBeNull();
    expect(commit).not.toHaveBeenCalled();
  });

  it('recovers a successful commit when its database acknowledgement was lost', async () => {
    commit.mockRejectedValueOnce(new Error('lost acknowledgement'));
    read.mockResolvedValueOnce({
      agentId: 'agent_b',
      revision: 2,
      automaticHandoffsEnabled: true,
      transitionId: transition.id,
    });
    expect(await commitAgentHandoff(input(), deps)).toMatchObject({
      status: 'already_committed',
      decision: { agentId: 'agent_b' },
    });
  });

  it('reports a competing decision without claiming a failed routing write', async () => {
    commit.mockRejectedValueOnce(new Error('write failed'));
    read.mockResolvedValueOnce({
      agentId: 'agent_c',
      revision: 2,
      automaticHandoffsEnabled: true,
      transitionId: 'other',
    });
    await expect(commitAgentHandoff(input(), deps)).resolves.toMatchObject({
      status: 'conflict',
      decision: { agentId: 'agent_c' },
    });
  });

  it('does not fail an assistant response when both Mongo commit and readback are unavailable', async () => {
    const conversation = { agent_id: 'agent_a', agentRoutingRevision: 1 };
    commit.mockRejectedValueOnce(new Error('db unavailable'));
    read.mockRejectedValueOnce(new Error('read unavailable'));
    await expect(
      reconcileTerminalAgentHandoff({ ...input(), conversation }, deps),
    ).resolves.toBeNull();
    expect(conversation.agent_id).toBe('agent_a');
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it('consumes the ticket after a terminal run with no candidate', async () => {
    const conversation = { agent_id: 'agent_a', agentRoutingRevision: 1 };
    expect(
      await reconcileTerminalAgentHandoff(
        { ...input({ ...outcome, status: 'unchanged' }), conversation },
        deps,
      ),
    ).toBeNull();
    expect(finish).toHaveBeenCalledWith({
      ...identity,
      expectedAgentId: 'agent_a',
      expectedRevision: 1,
      generation: 100,
    });
    expect(commit).not.toHaveBeenCalled();
  });
});
