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
