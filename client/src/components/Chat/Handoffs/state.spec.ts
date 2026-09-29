import { keepNewerAgentRouting } from './state';

describe('keepNewerAgentRouting', () => {
  const current = {
    conversationId: 'chat-1',
    agent_id: 'agent_selected',
    agentRoutingRevision: 5,
    automaticHandoffsEnabled: false,
  };

  it('keeps an explicit selection ahead of a delayed older FINAL', () => {
    const oldFinal = { conversationId: 'chat-1', agent_id: 'agent_old', agentRoutingRevision: 3 };
    expect(keepNewerAgentRouting(oldFinal, current, 'chat-1')).toMatchObject(current);
  });

  it('allows the newly committed route while keeping its response agent separate', () => {
    const final = { conversationId: 'chat-1', agent_id: 'agent_new', agentRoutingRevision: 6 };
    expect(keepNewerAgentRouting(final, current, 'chat-1')).toBe(final);
  });

  it('never copies an agent selection across conversations or onto an older local record', () => {
    const final = { conversationId: 'chat-2', agent_id: 'agent_second', agentRoutingRevision: 2 };
    expect(keepNewerAgentRouting(final, current, 'chat-2')).toBe(final);
    expect(keepNewerAgentRouting(final, current, 'chat-1')).toBe(final);
  });
});
