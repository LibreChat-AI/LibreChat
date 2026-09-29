import { EModelEndpoint } from 'librechat-data-provider';
import type { ConversationMethods } from '@librechat/data-schemas';
import {
  createAgentRoutingMiddleware,
  resolveAgentRoutingSelection,
  shouldLoadAgentRoutingConversation,
} from './routing';

const identity = { user: 'owner', tenantId: null, conversationId: 'conversation-1' };
const stored = {
  ...identity,
  endpoint: EModelEndpoint.agents,
  agent_id: 'agent_b',
  agentRoutingRevision: 2,
};
const read = jest.fn<
  ReturnType<ConversationMethods['getConvoAgentRoutingLookup']>,
  [typeof identity]
>(async () => ({
  kind: 'eligible',
  decision: { agentId: 'agent_b', revision: 2, automaticHandoffsEnabled: true },
}));

beforeEach(() => read.mockClear());

describe('shouldLoadAgentRoutingConversation', () => {
  const ordinary = { baseUrl: '/api/agents/chat', path: '/', body: { endpoint: 'agents' } };

  it('loads the owned row once on an ordinary agent turn, including after the rollout is disabled', () => {
    expect(shouldLoadAgentRoutingConversation(ordinary)).toBe(true);
  });

  it.each([
    { baseUrl: '/api/assistants/chat' },
    { path: '/resume' },
    { body: { endpoint: 'openAI' } },
    { body: { endpoint: 'agents', isRegenerate: true } },
    { body: { endpoint: 'agents', addedConvo: {} } },
    { _isAgentTrigger: true },
    { config: { modelSpecs: { enforce: true } } },
  ])('does not force an unrelated or snapshot-owned turn to reload: %o', (change) => {
    expect(shouldLoadAgentRoutingConversation({ ...ordinary, ...change })).toBe(false);
  });
});

describe('createAgentRoutingMiddleware', () => {
  it('replaces stale request agent before the downstream VIEW permission check', async () => {
    const request = {
      path: '/',
      user: { id: identity.user },
      body: {
        endpoint: EModelEndpoint.agents,
        conversationId: identity.conversationId,
        agent_id: 'agent_a',
      },
      config: { endpoints: { agents: { conversationHandoffs: { enabled: true } } } },
      resolvedConversation: stored,
    };
    const next = jest.fn(() => {
      expect(request.body.agent_id).toBe('agent_b');
    });
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await createAgentRoutingMiddleware(read)(request as never, res as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('preserves a tenant-stamped web conversation without a trusted tenant identity', async () => {
    const request = {
      path: '/',
      user: { id: identity.user },
      body: {
        endpoint: EModelEndpoint.agents,
        conversationId: identity.conversationId,
        agent_id: 'agent_a',
      },
      config: { endpoints: { agents: { conversationHandoffs: { enabled: false } } } },
      resolvedConversation: { ...stored, tenantId: 'tenant-a' },
    };
    const next = jest.fn();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await createAgentRoutingMiddleware(read)(request as never, res as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(request.body.agent_id).toBe('agent_a');
    expect(res.status).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('defers to a mandatory model spec even after a previous committed handoff', async () => {
    const request = {
      path: '/',
      user: { id: identity.user },
      body: {
        endpoint: EModelEndpoint.agents,
        conversationId: identity.conversationId,
        agent_id: 'agent_a',
      },
      config: {
        endpoints: { agents: { conversationHandoffs: { enabled: true } } },
        modelSpecs: { enforce: true },
      },
      resolvedConversation: stored,
    };
    const next = jest.fn();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await createAgentRoutingMiddleware(read)(request as never, res as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(request.body.agent_id).toBe('agent_a');
    expect(res.status).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('does not reroute a paused generation with a different current conversation agent', async () => {
    const request = {
      path: '/resume',
      user: { id: identity.user },
      body: {
        endpoint: EModelEndpoint.agents,
        conversationId: identity.conversationId,
        agent_id: 'agent_a',
      },
      config: { endpoints: { agents: { conversationHandoffs: { enabled: true } } } },
      resolvedConversation: stored,
    };
    const next = jest.fn();
    await createAgentRoutingMiddleware(read)(request as never, {} as never, next);
    expect(request.body.agent_id).toBe('agent_a');
    expect(next).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('resolveAgentRoutingSelection', () => {
  it('takes the durable agent instead of a stale submitted agent without another read', async () => {
    await expect(
      resolveAgentRoutingSelection(
        {
          identity,
          requestedAgentId: 'agent_a',
          enabled: true,
          ordinaryUserTurn: true,
          conversation: stored,
        },
        read,
      ),
    ).resolves.toMatchObject({ status: 'selected', agentId: 'agent_b', decision: { revision: 2 } });
    expect(read).not.toHaveBeenCalled();
  });

  it('allows a new conversation without querying for a nonexistent routing row', async () => {
    await expect(
      resolveAgentRoutingSelection(
        {
          identity,
          requestedAgentId: 'agent_a',
          enabled: true,
          ordinaryUserTurn: true,
          conversation: null,
        },
        read,
      ),
    ).resolves.toEqual({ status: 'passthrough' });
    expect(read).not.toHaveBeenCalled();
  });

  it('consults MongoDB when cached conversation authorization did not load the row', async () => {
    const selected = await resolveAgentRoutingSelection(
      { identity, requestedAgentId: 'agent_a', enabled: true, ordinaryUserTurn: true },
      read,
    );
    expect(selected).toMatchObject({ status: 'selected', agentId: 'agent_b' });
    expect(read).toHaveBeenCalledWith(identity);
  });

  it('passes through an existing non-agent or child conversation even with a warm access cache', async () => {
    read.mockResolvedValueOnce({ kind: 'passthrough' });
    expect(
      await resolveAgentRoutingSelection(
        { identity, requestedAgentId: 'agent_a', enabled: false, ordinaryUserTurn: true },
        read,
      ),
    ).toEqual({ status: 'passthrough' });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('preserves an unscoped legacy request when a warm access cache omitted a tenant-stamped row', async () => {
    read.mockResolvedValueOnce(null);
    expect(
      await resolveAgentRoutingSelection(
        { identity, requestedAgentId: 'agent_a', enabled: false, ordinaryUserTurn: true },
        read,
      ),
    ).toEqual({ status: 'passthrough' });
  });

  it('fails closed when a scoped tenant lookup misses', async () => {
    read.mockResolvedValueOnce(null);
    expect(
      await resolveAgentRoutingSelection(
        {
          identity: { ...identity, tenantId: 'tenant-a' },
          requestedAgentId: 'agent_a',
          enabled: true,
          ordinaryUserTurn: true,
        },
        read,
      ),
    ).toEqual({ status: 'missing' });
  });

  it('keeps an already-committed route when the operator disables new switches', async () => {
    await expect(
      resolveAgentRoutingSelection(
        { identity, requestedAgentId: 'agent_a', enabled: false, ordinaryUserTurn: true },
        read,
      ),
    ).resolves.toMatchObject({ status: 'selected', agentId: 'agent_b' });
  });

  it('leaves a legacy conversation untouched when the feature is off', async () => {
    await expect(
      resolveAgentRoutingSelection(
        {
          identity,
          requestedAgentId: 'agent_a',
          enabled: false,
          ordinaryUserTurn: true,
          conversation: { ...stored, agentRoutingRevision: undefined },
        },
        read,
      ),
    ).resolves.toEqual({ status: 'passthrough' });
  });

  it('never trusts a row owned by another user or conversation', async () => {
    for (const mismatched of [
      { ...stored, user: 'other' },
      { ...stored, conversationId: 'other' },
    ]) {
      await expect(
        resolveAgentRoutingSelection(
          {
            identity,
            requestedAgentId: 'agent_a',
            enabled: true,
            ordinaryUserTurn: true,
            conversation: mismatched,
          },
          read,
        ),
      ).resolves.toEqual({ status: 'missing' });
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps an owner-checked tenant-stamped chat usable without a trusted tenant context', async () => {
    for (const enabled of [false, true]) {
      expect(
        await resolveAgentRoutingSelection(
          {
            identity,
            requestedAgentId: 'agent_a',
            enabled,
            ordinaryUserTurn: true,
            conversation: { ...stored, tenantId: 'tenant-a' },
          },
          read,
        ),
      ).toEqual({ status: 'passthrough' });
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects a tenant mismatch when an explicit tenant identity was supplied', async () => {
    expect(
      await resolveAgentRoutingSelection(
        {
          identity: { ...identity, tenantId: 'tenant-b' },
          requestedAgentId: 'agent_a',
          enabled: true,
          ordinaryUserTurn: true,
          conversation: { ...stored, tenantId: 'tenant-a' },
        },
        read,
      ),
    ).toEqual({ status: 'missing' });
  });

  it('keeps resume and child turns on their original route', async () => {
    expect(
      await resolveAgentRoutingSelection(
        { identity, requestedAgentId: 'agent_a', enabled: true, ordinaryUserTurn: false },
        read,
      ),
    ).toEqual({ status: 'passthrough' });
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['ephemeral', undefined])(
    'uses the committed agent when an existing-chat request posts %s',
    async (requestedAgentId) => {
      await expect(
        resolveAgentRoutingSelection(
          {
            identity,
            requestedAgentId,
            enabled: true,
            ordinaryUserTurn: true,
            conversation: stored,
          },
          read,
        ),
      ).resolves.toMatchObject({ status: 'selected', agentId: 'agent_b' });
      expect(read).not.toHaveBeenCalled();
    },
  );

  it('leaves forced model-spec routing authoritative even after a previous handoff', async () => {
    for (const enabled of [false, true]) {
      expect(
        await resolveAgentRoutingSelection(
          {
            identity,
            requestedAgentId: 'agent_a',
            enabled,
            ordinaryUserTurn: true,
            modelSpecEnforced: true,
            conversation: stored,
          },
          read,
        ),
      ).toEqual({ status: 'passthrough' });
    }
    expect(read).not.toHaveBeenCalled();
  });
});
