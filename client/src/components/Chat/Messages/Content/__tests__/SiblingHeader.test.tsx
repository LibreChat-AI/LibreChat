import React from 'react';
import { QueryKeys } from 'librechat-data-provider';
import { act, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TMessage, TModelSpec } from 'librechat-data-provider';
import SiblingHeader from '~/components/Chat/Messages/Content/SiblingHeader';

const ROUTER_SPEC = 'litellm-model-router';
const mockModelSpecs: TModelSpec[] = [
  {
    name: 'litellm-model-router',
    label: 'Claude Auto',
    litellmRoutedModel: {
      showOnResponses: true,
      labels: [{ model: 'bedrock/claude-haiku', label: 'Claude Haiku' }],
    },
    preset: { endpoint: 'AnthropicClaude', model: 'litellm-model-router' },
  } as TModelSpec,
];

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { modelSpecs: { list: mockModelSpecs } } }),
}));

jest.mock('~/data-provider/Messages', () => ({
  useBranchMessageMutation: () => ({ mutate: jest.fn(), isLoading: false }),
}));

/** The app host's label member is the real cache-backed hook; only toasts are stubbed. */
jest.mock('~/Providers/MessagePartsHostContext', () => {
  const { default: useRoutedModelLabel } = jest.requireActual(
    '~/hooks/Messages/useRoutedModelLabel',
  );
  const host = { useToast: () => jest.fn(), useRoutedModelLabel };
  return { useMessagePartsHost: () => host };
});

jest.mock('~/Providers', () => ({
  useAgentsMapContext: () => undefined,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/components/Share/MessageIcon', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@librechat/chat/components', () => ({
  MessageTimestamp: () => null,
}));

const PRIMARY = 'AnthropicClaude__litellm-model-router___Claude';
const ADDED = 'AnthropicClaude__claude-opus-4-6-cached___Claude____1';
const ROUTER_ADDED = 'AnthropicClaude__litellm-model-router___Claude____1';

const response = (metadata?: TMessage['metadata']): TMessage =>
  ({
    messageId: 'response-1',
    conversationId: 'convo-1',
    endpoint: 'AnthropicClaude',
    model: 'litellm-model-router',
    sender: 'Claude',
    isCreatedByUser: false,
    text: '',
    metadata,
  }) as TMessage;

const routed = { litellmModelName: 'bedrock/claude-haiku', litellmRoutedModelSpec: ROUTER_SPEC };

function renderHeader(agentId: string, messages: TMessage[]) {
  const queryClient = new QueryClient();
  queryClient.setQueryData([QueryKeys.messages, 'convo-1'], messages);
  render(
    <QueryClientProvider client={queryClient}>
      <SiblingHeader agentId={agentId} messageId="response-1" conversationId="convo-1" />
    </QueryClientProvider>,
  );
  return queryClient;
}

describe('SiblingHeader routed-model label', () => {
  it("labels the primary column with the response's routed model", () => {
    renderHeader(PRIMARY, [response(routed)]);

    expect(screen.getByText('Claude Haiku')).toBeInTheDocument();
  });

  it("does not give an added-convo column the primary agent's model", () => {
    renderHeader(ADDED, [response(routed)]);

    expect(screen.getByText('Claude')).toBeInTheDocument();
    expect(screen.queryByText('Claude Haiku')).not.toBeInTheDocument();
  });

  it("labels an added-convo column with its own agent's routed model", () => {
    renderHeader(ROUTER_ADDED, [
      response({
        litellmAgentModels: [
          { agentId: ROUTER_ADDED, modelName: 'bedrock/claude-haiku', spec: ROUTER_SPEC },
        ],
      }),
    ]);

    expect(screen.getByText('Claude Haiku')).toBeInTheDocument();
  });

  it('keeps the parsed sender when nothing was captured', () => {
    renderHeader(PRIMARY, [response()]);

    expect(screen.getByText('Claude')).toBeInTheDocument();
  });

  it('switches to the routed model once the saved response reaches the cache', async () => {
    const queryClient = renderHeader(PRIMARY, [response()]);
    expect(screen.getByText('Claude')).toBeInTheDocument();

    /** The message cache delivers writes after the current task. */
    await act(async () => {
      queryClient.setQueryData([QueryKeys.messages, 'convo-1'], [response(routed)]);
    });

    expect(screen.getByText('Claude Haiku')).toBeInTheDocument();
  });
});
