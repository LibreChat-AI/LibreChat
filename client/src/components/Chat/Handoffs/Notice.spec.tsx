import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DynamicQueryKeys, EModelEndpoint, QueryKeys, dataService } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import AgentRoutingNotice from './Notice';

let mockHandoffsEnabled = true;

jest.mock('librechat-data-provider', () => {
  const actual =
    jest.requireActual<typeof import('librechat-data-provider')>('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getConversationAgentRouting: jest.fn(() => new Promise(() => {})),
    },
  };
});

jest.mock('~/Providers/AgentsMapContext', () => ({
  useAgentsMapContext: () => ({
    agent_target: { id: 'agent_target', name: 'Specialist' },
  }),
}));
jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: () => ({
    data: { agents: { conversationHandoffsEnabled: mockHandoffsEnabled } },
  }),
  useGetStartupConfig: () => ({ data: { modelSpecs: { enforce: false } } }),
}));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, replacements?: { 0?: string }) => {
    if (key === 'com_ui_agent_handoff_future_agent') {
      return `Future messages will go to ${replacements?.[0]}.`;
    }
    return key;
  },
}));

afterEach(() => {
  mockHandoffsEnabled = true;
  jest.restoreAllMocks();
});

it('shows a committed destination but no Switch back when its previous agent is unavailable', async () => {
  const conversation = {
    conversationId: 'convo-1',
    endpoint: EModelEndpoint.agents,
    agent_id: 'agent_target',
    agentRoutingRevision: 2,
  } as TConversation;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData([QueryKeys.endpoints], {
    [EModelEndpoint.agents]: { conversationHandoffsEnabled: true },
  });
  client.setQueryData(DynamicQueryKeys.agentRouting('convo-1', 2), {
    agentId: 'agent_target',
    revision: 2,
    automaticHandoffsEnabled: true,
    previousAgentId: 'agent_removed',
    transitionId: 'transition-1',
  });
  render(
    <QueryClientProvider client={client}>
      <AgentRoutingNotice conversation={conversation} setConversation={jest.fn()} />
    </QueryClientProvider>,
  );
  expect(await screen.findByRole('status')).toHaveTextContent(
    'Future messages will go to Specialist.',
  );
  expect(screen.queryByRole('button', { name: /switch back/i })).not.toBeInTheDocument();
});

it('shows retry guidance if the initial routing request fails before any decision is cached', async () => {
  jest
    .mocked(dataService.getConversationAgentRouting)
    .mockRejectedValueOnce(new Error('database unavailable'));
  const conversation = {
    conversationId: 'convo-1',
    endpoint: EModelEndpoint.agents,
    agentRoutingRevision: 2,
  } as TConversation;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AgentRoutingNotice conversation={conversation} setConversation={jest.fn()} />
    </QueryClientProvider>,
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_agent_handoff_update_failed');
  expect(screen.getByRole('button', { name: 'com_ui_retry' })).toBeEnabled();
});

it('disallows re-enabling automatic handoffs after the operator disables the feature', async () => {
  mockHandoffsEnabled = false;
  const conversation = {
    conversationId: 'convo-1',
    endpoint: EModelEndpoint.agents,
    agentRoutingRevision: 2,
  } as TConversation;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(DynamicQueryKeys.agentRouting('convo-1', 2), {
    agentId: 'agent_target',
    revision: 2,
    automaticHandoffsEnabled: false,
  });
  render(
    <QueryClientProvider client={client}>
      <AgentRoutingNotice conversation={conversation} setConversation={jest.fn()} />
    </QueryClientProvider>,
  );
  expect(
    await screen.findByRole('switch', { name: 'com_ui_agent_handoff_automatic' }),
  ).toBeDisabled();
});
