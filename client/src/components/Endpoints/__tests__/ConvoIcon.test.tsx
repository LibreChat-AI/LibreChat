import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { EModelEndpoint, ProviderId } from 'librechat-data-provider';
import type {
  Agent,
  Assistant,
  TConversation,
  TAgentsMap,
  TAssistantsMap,
  TEndpointsConfig,
} from 'librechat-data-provider';
import ConvoIcon from '../ConvoIcon';

const endpointsConfig = {
  [EModelEndpoint.agents]: { order: 0 },
  [EModelEndpoint.assistants]: { order: 1 },
  [EModelEndpoint.anthropic]: { order: 2 },
  [ProviderId.cohere]: { order: 3 },
} as TEndpointsConfig;

const agent = {
  id: 'agent_123',
  name: 'Research Agent',
  avatar: { filepath: '/images/agents/agent_123/avatar.png', source: 'local' },
} as Agent;

const agentsMap = { [agent.id]: agent } as TAgentsMap;

const assistant = {
  id: 'asst_123',
  name: 'Support Assistant',
  metadata: { avatar: '/images/assistants/asst_123/avatar.png' },
} as unknown as Assistant;

const assistantMap = {
  [EModelEndpoint.assistants]: { [assistant.id]: assistant },
} as TAssistantsMap;

const cohereConversation = { endpoint: ProviderId.cohere } as unknown as TConversation;

const renderIcon = (conversation: TConversation) =>
  render(
    <ConvoIcon
      conversation={conversation}
      endpointsConfig={endpointsConfig}
      assistantMap={assistantMap}
      agentsMap={agentsMap}
      className="h-2/3 w-2/3 text-text-primary"
      context="landing"
      size={41}
    />,
  );

describe('ConvoIcon', () => {
  it('renders the provider mark for a first-class endpoint', () => {
    renderIcon({ endpoint: EModelEndpoint.anthropic } as TConversation);

    expect(screen.getByRole('img', { name: 'Anthropic' })).toBeInTheDocument();
  });

  it('keeps the agent avatar rather than provider art', () => {
    renderIcon({
      endpoint: EModelEndpoint.agents,
      agent_id: agent.id,
    } as TConversation);

    expect(screen.getByAltText('Research Agent')).toHaveAttribute(
      'src',
      '/images/agents/agent_123/avatar.png',
    );
  });

  it('falls back to the agent mark when the agent has no avatar', () => {
    renderIcon({
      endpoint: EModelEndpoint.agents,
      agent_id: 'missing_agent',
    } as TConversation);

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('keeps the assistant avatar rather than provider art', () => {
    renderIcon({
      endpoint: EModelEndpoint.assistants,
      assistant_id: assistant.id,
    } as TConversation);

    expect(screen.getByAltText('Support Assistant')).toHaveAttribute(
      'src',
      '/images/assistants/asst_123/avatar.png',
    );
  });

  it('keeps Cohere landing padding off other contexts and on landing', () => {
    const { container: landing } = renderIcon(cohereConversation);
    expect(landing.querySelector('img')).toHaveClass('p-2');

    const { container: nav } = render(
      <ConvoIcon
        conversation={cohereConversation}
        endpointsConfig={endpointsConfig}
        assistantMap={assistantMap}
        agentsMap={agentsMap}
        context="nav"
        size={20}
      />,
    );
    expect(nav.querySelector('img')).not.toHaveClass('p-2');
  });
});
