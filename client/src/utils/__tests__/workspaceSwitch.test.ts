import { EModelEndpoint } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import buildDefaultConvo from '../buildDefaultConvo';
import { getConvoSwitchLogic } from '../endpoints';

const selection = { environmentId: 'old-machine', workspaceId: 'project' };

function switchAgent(conversation: TConversation) {
  const result = getConvoSwitchLogic({
    conversation,
    newEndpoint: EModelEndpoint.agents,
    endpointsConfig: { agents: { order: 0 } },
    modularChat: true,
  });
  return buildDefaultConvo({
    conversation,
    endpoint: EModelEndpoint.agents,
    lastConversationSetup: { ...result.template, agent_id: 'agent_coding' } as TConversation,
    models: [],
  });
}

it.each([
  {},
  { codeEnvironmentMode: 'without_attached' as const },
  { codeEnvironmentMode: 'attached' as const, codeWorkspaces: [selection] },
  { codeWorkspaces: [selection] },
])('keeps saved identity and workspace consent across a coding-agent selection: %j', (decision) => {
  const conversation = {
    conversationId: 'saved-chat',
    endpoint: EModelEndpoint.agents,
    agent_id: 'agent_ordinary',
    title: 'History stays here',
    ...decision,
  } as TConversation;
  const next = switchAgent(conversation);
  expect(next.conversationId).toBe('saved-chat');
  expect(next.agent_id).toBe('agent_coding');
  expect(next.codeEnvironmentMode).toBe(conversation.codeEnvironmentMode);
  expect(next.codeWorkspaces).toEqual(conversation.codeWorkspaces);
  expect(conversation.agent_id).toBe('agent_ordinary');
});

it.each([
  { endpoint: EModelEndpoint.openAI, modularChat: true, expected: true },
  { endpoint: EModelEndpoint.openAI, modularChat: false, expected: false },
  { endpoint: EModelEndpoint.assistants, modularChat: true, expected: false },
])(
  'respects existing endpoint-switch rules: $endpoint, modular=$modularChat',
  ({ endpoint, modularChat, expected }) => {
    const result = getConvoSwitchLogic({
      conversation: { conversationId: 'saved-chat', endpoint } as TConversation,
      newEndpoint: EModelEndpoint.agents,
      endpointsConfig: { agents: { order: 0 }, openAI: { order: 1 }, assistants: { order: 2 } },
      modularChat,
    });
    expect(result.isCurrentModular && result.isNewModular && result.shouldSwitch).toBe(expected);
  },
);

it('keeps a new-chat selection new', () => {
  expect(
    switchAgent({
      conversationId: 'new',
      endpoint: EModelEndpoint.agents,
    } as TConversation).conversationId,
  ).toBe('new');
});

describe('model identity during endpoint switches', () => {
  const conversation = {
    conversationId: 'saved',
    endpoint: EModelEndpoint.openAI,
    model: 'gpt-4o',
  } as TConversation;
  beforeEach(() => localStorage.clear());
  it('clears an inherited model before destination discovery', () => {
    const { template } = getConvoSwitchLogic({
      conversation,
      newEndpoint: EModelEndpoint.anthropic,
      endpointsConfig: {},
      modularChat: true,
    });
    expect(template.model).toBeUndefined();
    const next = buildDefaultConvo({
      conversation,
      endpoint: EModelEndpoint.anthropic,
      lastConversationSetup: template,
    });
    expect(next.model).toBeUndefined();
  });
  it('preserves an explicit destination model without needing its catalog', () => {
    const next = buildDefaultConvo({
      conversation,
      endpoint: EModelEndpoint.anthropic,
      lastConversationSetup: { endpoint: EModelEndpoint.anthropic, model: 'claude-explicit' },
    });
    expect(next.model).toBe('claude-explicit');
  });
  it('uses only destination models when resolving an endpoint fallback', () => {
    const next = buildDefaultConvo({
      conversation,
      endpoint: EModelEndpoint.anthropic,
      lastConversationSetup: conversation,
      models: ['claude-default'],
    });
    expect(next.model).toBe('claude-default');
  });
});
