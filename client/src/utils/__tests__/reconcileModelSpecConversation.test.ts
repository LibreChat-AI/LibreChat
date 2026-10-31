import type { TConversation, TStartupConfig } from 'librechat-data-provider';
import { reconcileModelSpecConversation } from '../reconcileModelSpecConversation';

const savedConversation = {
  conversationId: 'conversation-1',
  spec: 'ClickHouse Agent',
  endpoint: 'bedrock',
  endpointType: 'bedrock',
  model: 'claude-sonnet-4-6',
  title: 'Existing chat',
} as unknown as TConversation;

const startupConfig = {
  modelSpecs: {
    list: [
      {
        name: 'ClickHouse Agent',
        label: 'ClickHouse Agent',
        preset: { endpoint: 'Claude', model: 'claude-sonnet-5' },
      },
    ],
  },
} as unknown as TStartupConfig;

describe('reconcileModelSpecConversation', () => {
  it('uses the currently advertised route and model for a saved spec conversation', () => {
    expect(reconcileModelSpecConversation(savedConversation, startupConfig)).toEqual({
      ...savedConversation,
      endpoint: 'Claude',
      endpointType: undefined,
      model: 'claude-sonnet-5',
    });
  });

  it('preserves a legacy spec omitted from the client config', () => {
    expect(
      reconcileModelSpecConversation(savedConversation, {
        modelSpecs: { list: [] },
      } as unknown as TStartupConfig),
    ).toBe(savedConversation);
  });

  it('preserves user settings when the provider already matches', () => {
    const currentConversation = {
      ...savedConversation,
      endpoint: 'Claude',
      temperature: 0.6,
    } as unknown as TConversation;
    expect(reconcileModelSpecConversation(currentConversation, startupConfig)).toBe(
      currentConversation,
    );
  });

  it('leaves saved agent identities for the agent authorization path', () => {
    const agentConversation = {
      ...savedConversation,
      endpoint: 'agents',
      agent_id: 'agent-1',
    } as TConversation;
    expect(reconcileModelSpecConversation(agentConversation, startupConfig)).toBe(
      agentConversation,
    );
  });
});
