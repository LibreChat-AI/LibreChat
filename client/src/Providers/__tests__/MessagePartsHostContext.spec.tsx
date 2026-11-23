import { render, screen } from '@testing-library/react';
import { AgentUpdate } from '@librechat/chat/components';
import { Constants, QueryKeys } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Agent, ModelSpecHandoffTarget } from 'librechat-data-provider';
import { appMessagePartsHost, MessagePartsHostProvider } from '../MessagePartsHostContext';
import { AgentsMapContext } from '../AgentsMapContext';

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useLocalize: () => (key: string) => (key === 'com_ui_agent' ? 'Agent' : key),
}));

const saved: Agent = {
  id: 'agent_saved',
  name: 'Saved Agent',
  provider: 'openAI',
  model: 'gpt-4o',
  avatar: null,
  description: null,
  created_at: 0,
  model_parameters: {
    temperature: null,
    maxContextTokens: null,
    max_context_tokens: null,
    max_output_tokens: null,
    top_p: null,
    frequency_penalty: null,
    presence_penalty: null,
  },
};
const id = Constants.MODEL_SPEC_AGENT_PREFIX + 'abc123';
const target: ModelSpecHandoffTarget = {
  id,
  name: 'Preset Specialist',
  provider: 'openAI',
  model: 'gpt-4o',
  avatar: null,
};

function header(agentId: string, targets: ModelSpecHandoffTarget[] = [target]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData([QueryKeys.modelSpecHandoffs], targets);
  return render(
    <QueryClientProvider client={client}>
      <AgentsMapContext.Provider value={{ [saved.id]: saved }}>
        <MessagePartsHostProvider host={{ ...appMessagePartsHost, renderAgentIcon: () => null }}>
          <AgentUpdate currentAgentId={agentId} />
        </MessagePartsHostProvider>
      </AgentsMapContext.Provider>
    </QueryClientProvider>,
  );
}

test('shared transcript headers resolve preset display identity with a parallel suffix', () => {
  header(id + '____2');
  expect(screen.getByText('Preset Specialist')).toBeInTheDocument();
});

test('shared transcript headers retain saved-agent identity', () => {
  header(saved.id + '____1');
  expect(screen.getByText('Saved Agent')).toBeInTheDocument();
});

test('retired preset headers use a generic label instead of a hash', () => {
  header(id, []);
  expect(screen.getByText('Agent')).toBeInTheDocument();
  expect(document.body.textContent).not.toContain('abc123');
});
