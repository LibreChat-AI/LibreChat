import type { ConversationMethods } from '@librechat/data-schemas';
import {
  createAgentRoutingReadHandler,
  createAgentRoutingUpdateHandler,
  parseAgentRoutingAction,
} from './routingHttp';

const current = {
  agentId: 'agent_b',
  revision: 2,
  transitionId: 'transfer-1',
  previousAgentId: 'agent_a',
  generation: 100,
  automaticHandoffsEnabled: true,
};
const get = jest.fn<
  ReturnType<ConversationMethods['getConvoAgentRoutingDecision']>,
  [Parameters<ConversationMethods['getConvoAgentRoutingDecision']>[0]]
>(async () => current);
const select = jest.fn<
  ReturnType<ConversationMethods['selectConvoAgentRoutingDecision']>,
  [Parameters<ConversationMethods['selectConvoAgentRoutingDecision']>[0]]
>(async () => ({ agentId: 'agent_a', revision: 3, automaticHandoffsEnabled: true }));
const setAutomatic = jest.fn<
  ReturnType<ConversationMethods['setConvoAutomaticHandoffs']>,
  [Parameters<ConversationMethods['setConvoAutomaticHandoffs']>[0]]
>(async () => ({ agentId: 'agent_b', revision: 3, automaticHandoffsEnabled: false }));
const canAccess = jest.fn(async () => true);
const deps = { get, select, setAutomatic, canAccess };
const request = (body?: object) => ({
  params: { conversationId: 'conversation-1' },
  user: { id: 'owner', role: 'USER' },
  config: { endpoints: { agents: { conversationHandoffs: { enabled: true } } } },
  body,
});
const response = () => {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  get.mockResolvedValue(current);
  select.mockResolvedValue({ agentId: 'agent_a', revision: 3, automaticHandoffsEnabled: true });
  setAutomatic.mockResolvedValue({
    agentId: 'agent_b',
    revision: 3,
    automaticHandoffsEnabled: false,
  });
  canAccess.mockResolvedValue(true);
});

describe('conversation agent routing API', () => {
  it('returns only public routing state, not the private admitted generation', async () => {
    const res = response();
    await createAgentRoutingReadHandler(deps)(request() as never, res as never, jest.fn());
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      agentId: 'agent_b',
      revision: 2,
      transitionId: 'transfer-1',
      previousAgentId: 'agent_a',
      automaticHandoffsEnabled: true,
    });
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('generation');
    expect(get).toHaveBeenCalledWith({
      user: 'owner',
      conversationId: 'conversation-1',
      tenantId: null,
    });
  });

  it('rejects wrong transition, stale revision, and denied destination without mutation', async () => {
    for (const [body, status] of [
      [{ action: 'switch_back', transitionId: 'other', expectedRevision: 2 }, 409],
      [{ action: 'switch_back', transitionId: 'transfer-1', expectedRevision: 1 }, 409],
      [{ action: 'select', agentId: '', expectedRevision: 2 }, 400],
    ] as const) {
      const res = response();
      await createAgentRoutingUpdateHandler(deps)(request(body) as never, res as never, jest.fn());
      expect(res.status).toHaveBeenCalledWith(status);
    }
    canAccess.mockResolvedValue(false);
    const res = response();
    await createAgentRoutingUpdateHandler(deps)(
      request({ action: 'switch_back', transitionId: 'transfer-1', expectedRevision: 2 }) as never,
      res as never,
      jest.fn(),
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(select).not.toHaveBeenCalled();
  });

  it('switches back only to the previous agent under the exact revision', async () => {
    const res = response();
    await createAgentRoutingUpdateHandler(deps)(
      request({ action: 'switch_back', transitionId: 'transfer-1', expectedRevision: 2 }) as never,
      res as never,
      jest.fn(),
    );
    expect(canAccess).toHaveBeenCalledWith('agent_a', 'owner', 'USER');
    expect(select).toHaveBeenCalledWith({
      user: 'owner',
      tenantId: null,
      conversationId: 'conversation-1',
      agentId: 'agent_a',
      expectedRevision: 2,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      agentId: 'agent_a',
      revision: 3,
      automaticHandoffsEnabled: true,
    });
  });

  it('disabling and re-enabling consume a revision, but cannot override deployment disablement', async () => {
    const res = response();
    await createAgentRoutingUpdateHandler(deps)(
      request({ action: 'automatic', enabled: false, expectedRevision: 2 }) as never,
      res as never,
      jest.fn(),
    );
    expect(setAutomatic).toHaveBeenCalledWith({
      user: 'owner',
      tenantId: null,
      conversationId: 'conversation-1',
      enabled: false,
      expectedRevision: 2,
      action: 'automatic',
    });
    const denied = response();
    await createAgentRoutingUpdateHandler(deps)(
      {
        ...request({ action: 'automatic', enabled: true, expectedRevision: 2 }),
        config: {},
      } as never,
      denied as never,
      jest.fn(),
    );
    expect(denied.status).toHaveBeenCalledWith(403);
    const enforced = response();
    await createAgentRoutingUpdateHandler(deps)(
      {
        ...request({ action: 'automatic', enabled: true, expectedRevision: 2 }),
        config: {
          endpoints: { agents: { conversationHandoffs: { enabled: true } } },
          modelSpecs: { enforce: true },
        },
      } as never,
      enforced as never,
      jest.fn(),
    );
    expect(enforced.status).toHaveBeenCalledWith(403);
    expect(setAutomatic).toHaveBeenCalledTimes(1);
  });

  it('requires a valid action, finite revision and non-ephemeral target', () => {
    for (const action of [
      null,
      {},
      { action: 'automatic', enabled: true, expectedRevision: -1 },
      { action: 'automatic', enabled: true, expectedRevision: 1.5 },
      { action: 'select', agentId: 'ephemeral', expectedRevision: 2 },
      { action: 'switch_back', expectedRevision: 2 },
    ]) {
      expect(parseAgentRoutingAction(action)).toBeNull();
    }
  });
});
