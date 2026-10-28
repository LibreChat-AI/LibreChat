const AgentClient = require('./client');

describe('AgentClient code environment save options', () => {
  const mac = { environmentId: 'code-mac', workspaceId: 'primary' };
  const vm = { environmentId: 'code-vm', workspaceId: 'primary' };
  const conversationId = 'conversation-1';

  const buildClient = (resolvedConversation) => {
    const client = Object.create(AgentClient.prototype);
    client.options = {
      req: {
        body: { conversationId },
        config: {},
        resolvedConversation,
        _codeEnvironmentDecision: { mode: 'attached', codeWorkspaces: [mac] },
      },
      endpoint: 'agents',
      agent: { id: 'agent_1', provider: 'openai' },
    };
    return client;
  };

  it('recognizes an existing conversation before the client initializes its ID', () => {
    const client = buildClient({
      conversationId,
      codeEnvironmentMode: 'attached',
      codeWorkspaces: [vm],
    });

    expect(client.conversationId).toBeUndefined();
    const initial = client.getSaveOptions();
    expect(initial).not.toHaveProperty('codeEnvironmentMode');
    expect(initial).not.toHaveProperty('codeWorkspaces');

    client.conversationId = conversationId;
    expect(client.getSaveOptions()).toEqual(initial);
  });

  it('seeds a new conversation and omits its decision after the row becomes available', () => {
    const client = buildClient(null);
    const initial = client.getSaveOptions();
    expect(initial).toMatchObject({ codeEnvironmentMode: 'attached', codeWorkspaces: [mac] });

    client.conversationId = conversationId;
    client.options.req.resolvedConversation = { conversationId, ...initial };
    const paused = client.getSaveOptions();
    expect(paused).not.toHaveProperty('codeEnvironmentMode');
    expect(paused).not.toHaveProperty('codeWorkspaces');
  });
});
