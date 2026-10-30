import React from 'react';
import { render, screen } from '@testing-library/react';
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

/** The app host's label member is the real hook; only toasts are stubbed. */
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

jest.mock('~/components/Chat/Messages/ui/MessageTimestamp', () => ({
  __esModule: true,
  default: () => null,
}));

const PRIMARY = 'AnthropicClaude__litellm-model-router___Claude';
const ADDED = 'AnthropicClaude__claude-opus-4-6-cached___Claude____1';
const ROUTER_ADDED = 'AnthropicClaude__litellm-model-router___Claude____1';

const routed = { litellmModelName: 'bedrock/claude-haiku', litellmRoutedModelSpec: ROUTER_SPEC };

const header = (agentId: string, metadata?: TMessage['metadata']) => (
  <SiblingHeader
    agentId={agentId}
    metadata={metadata}
    messageId="response-1"
    conversationId="convo-1"
  />
);

function renderHeader(agentId: string, metadata?: TMessage['metadata']) {
  return render(header(agentId, metadata));
}

describe('SiblingHeader routed-model label', () => {
  it("labels the primary column with the response's routed model", () => {
    renderHeader(PRIMARY, routed);

    expect(screen.getByText('Claude Haiku')).toBeInTheDocument();
  });

  it("does not give an added-convo column the primary agent's model", () => {
    renderHeader(ADDED, routed);

    expect(screen.getByText('Claude')).toBeInTheDocument();
    expect(screen.queryByText('Claude Haiku')).not.toBeInTheDocument();
  });

  it("labels an added-convo column with its own agent's routed model", () => {
    renderHeader(ROUTER_ADDED, {
      litellmAgentModels: [
        { agentId: ROUTER_ADDED, modelName: 'bedrock/claude-haiku', spec: ROUTER_SPEC },
      ],
    });

    expect(screen.getByText('Claude Haiku')).toBeInTheDocument();
  });

  it('keeps the parsed sender when nothing was captured', () => {
    renderHeader(PRIMARY);

    expect(screen.getByText('Claude')).toBeInTheDocument();
  });

  it('switches to the routed model once the saved response brings its metadata', () => {
    const { rerender } = renderHeader(PRIMARY);
    expect(screen.getByText('Claude')).toBeInTheDocument();

    rerender(header(PRIMARY, routed));

    expect(screen.getByText('Claude Haiku')).toBeInTheDocument();
  });
});
