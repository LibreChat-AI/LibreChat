import React from 'react';
import { RecoilRoot } from 'recoil';
import { renderHook } from '@testing-library/react';
import { EModelEndpoint } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Agent, TConversation, TMessage, TModelSpec } from 'librechat-data-provider';
import type { TMessageChatContext } from '~/common/types';
import { getHeaderHoverLabel } from '~/components/Chat/Messages/ui/HeaderLabel';
import useMessageActions from '~/hooks/Messages/useMessageActions';

let mockAgentsMap: Record<string, Agent> | undefined;
let mockModelSpecs: TModelSpec[] = [];

/** A custom endpoint name from `librechat.yaml`; not a member of the built-in enum. */
const CUSTOM_ENDPOINT = 'AnthropicClaude' as EModelEndpoint;

jest.mock('~/Providers', () => ({
  useAgentsMapContext: () => mockAgentsMap,
  useAssistantsMapContext: () => undefined,
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { modelSpecs: { list: mockModelSpecs } } }),
}));

jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({ user: { name: 'Ada', username: 'ada' } }),
}));

jest.mock('~/hooks/Conversations/useGetAddedConvo', () => ({
  __esModule: true,
  default: () => () => null,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const makeChatContext = (conversation: Partial<TConversation>): TMessageChatContext =>
  ({
    ask: jest.fn(),
    index: 0,
    regenerate: jest.fn(),
    conversation: { conversationId: 'convo-1', ...conversation } as TConversation,
    latestMessageId: 'response-1',
    latestMessageDepth: 1,
    handleContinue: jest.fn(),
    feedbackEnabled: false,
    isSubmitting: false,
  }) as TMessageChatContext;

const ROUTER_SPEC = 'litellm-model-router';
const ROUTER_MODEL = 'litellm-model-router';
const routerChat = { endpoint: CUSTOM_ENDPOINT, model: ROUTER_MODEL, spec: ROUTER_SPEC };
/** The conversation after the user switched it from Claude Auto to an unflagged spec. */
const switchedChat = {
  endpoint: CUSTOM_ENDPOINT,
  model: 'claude-sonnet-5-5',
  spec: 'claude-sonnet',
};

const response = (over: Partial<TMessage> = {}): TMessage =>
  ({
    messageId: 'response-1',
    parentMessageId: 'user-1',
    conversationId: 'convo-1',
    sender: 'Claude Sonnet (Search)',
    isCreatedByUser: false,
    text: 'Hi',
    ...over,
  }) as TMessage;

/** A Claude Auto response as the server saves it: served model plus the spec that enabled it. */
const routedResponse = (over: Partial<TMessage> = {}, modelName = 'bedrock/claude-sonnet-5-5') =>
  response({
    endpoint: CUSTOM_ENDPOINT,
    model: ROUTER_MODEL,
    metadata: { litellmModelName: modelName, litellmRoutedModelSpec: ROUTER_SPEC },
    ...over,
  });

const renderActions = (message: TMessage, conversation: Partial<TConversation>) => {
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <RecoilRoot>{children}</RecoilRoot>
    </QueryClientProvider>
  );
  const { result } = renderHook(
    () =>
      useMessageActions({
        message,
        currentEditId: null,
        setCurrentEditId: jest.fn(),
        chatContext: makeChatContext(conversation),
      }),
    { wrapper },
  );
  return result.current;
};

const renderLabel = (message: TMessage, conversation: Partial<TConversation>) =>
  renderActions(message, conversation).messageLabel;

/** The header's hover / focus / screen-reader model text, computed as the message
 *  renderers compute it from the hook (see `ContentRender` and `MessageRender`). */
const renderHoverLabel = (message: TMessage, conversation: Partial<TConversation>) =>
  getHeaderHoverLabel(
    renderActions(message, conversation).hasConfiguredSender,
    message.model,
    conversation.model,
  );

describe('useMessageActions messageLabel', () => {
  beforeEach(() => {
    mockAgentsMap = undefined;
    mockModelSpecs = [
      {
        name: ROUTER_SPEC,
        label: 'Claude Auto',
        litellmRoutedModel: {
          showOnResponses: true,
          labels: [{ model: 'bedrock/us.anthropic.claude-haiku-5-5', label: 'Claude Haiku 5.5' }],
        },
        preset: { endpoint: CUSTOM_ENDPOINT, model: 'litellm-model-router' },
      },
      {
        name: 'claude-sonnet',
        label: 'Claude Sonnet',
        preset: { endpoint: CUSTOM_ENDPOINT, model: 'claude-sonnet-5-5' },
      },
    ] as TModelSpec[];
  });

  it('shows the LiteLLM model when the spec sets litellmRoutedModel.showOnResponses', () => {
    expect(renderLabel(routedResponse(), routerChat)).toBe('bedrock/claude-sonnet-5-5');
  });

  it('shows the configured label for a listed model', () => {
    const message = routedResponse({}, 'bedrock/us.anthropic.claude-haiku-5-5');

    expect(renderLabel(message, routerChat)).toBe('Claude Haiku 5.5');
  });

  it('shows the model name for a model missing from the labels', () => {
    expect(renderLabel(routedResponse({}, 'bedrock/unlisted'), routerChat)).toBe(
      'bedrock/unlisted',
    );
  });

  describe('after switching the conversation to another spec and reopening it', () => {
    it('keeps the served-model label on earlier Claude Auto responses', () => {
      const earlier = routedResponse({}, 'bedrock/us.anthropic.claude-haiku-5-5');

      expect(renderLabel(earlier, switchedChat)).toBe('Claude Haiku 5.5');
    });

    it('labels later responses from the new spec with their sender', () => {
      const later = response({ endpoint: CUSTOM_ENDPOINT, model: 'claude-sonnet-5-5' });

      expect(renderLabel(later, switchedChat)).toBe('Claude Sonnet (Search)');
    });
  });

  it('keeps the sender for a response saved without its spec on another model', () => {
    const legacy = response({
      endpoint: CUSTOM_ENDPOINT,
      model: 'claude-sonnet-5-5',
      metadata: { litellmModelName: 'bedrock/claude-sonnet-5-5' },
    });

    expect(renderLabel(legacy, routerChat)).toBe('Claude Sonnet (Search)');
  });

  it('keeps the sender once the saved spec no longer sets showOnResponses', () => {
    mockModelSpecs = mockModelSpecs.map((modelSpec) =>
      modelSpec.name === ROUTER_SPEC
        ? { ...modelSpec, litellmRoutedModel: { showOnResponses: false } }
        : modelSpec,
    );

    expect(renderLabel(routedResponse(), routerChat)).toBe('Claude Sonnet (Search)');
  });

  it('keeps the sender when the saved spec was removed from the config', () => {
    mockModelSpecs = mockModelSpecs.filter((modelSpec) => modelSpec.name !== ROUTER_SPEC);

    expect(renderLabel(routedResponse(), routerChat)).toBe('Claude Sonnet (Search)');
  });

  it('keeps the sender when no model name was captured', () => {
    const message = response({ endpoint: CUSTOM_ENDPOINT, model: ROUTER_MODEL });

    expect(renderLabel(message, routerChat)).toBe('Claude Sonnet (Search)');
  });

  it('keeps a named agent label', () => {
    mockAgentsMap = { agent_lia: { id: 'agent_lia', name: 'Lia' } as Agent };
    const message = routedResponse({ model: 'agent_lia' });

    expect(
      renderLabel(message, {
        endpoint: EModelEndpoint.agents,
        agent_id: 'agent_lia',
        spec: ROUTER_SPEC,
      }),
    ).toBe('Lia');
  });

  it('never relabels the user message', () => {
    expect(renderLabel(routedResponse({ isCreatedByUser: true }), routerChat)).toBe('Ada');
  });

  describe('header hover label', () => {
    /** A specless router chat: no configured sender, so the hover label would
     *  otherwise reveal the logical model `litellm-model-router`. */
    const routerModelChat = { endpoint: CUSTOM_ENDPOINT, model: ROUTER_MODEL };

    it('keeps the routed-model label on hover, focus and for screen readers', () => {
      const message = routedResponse(
        { sender: undefined },
        'bedrock/us.anthropic.claude-haiku-5-5',
      );

      expect(renderLabel(message, routerModelChat)).toBe('Claude Haiku 5.5');
      expect(renderActions(message, routerModelChat).hasConfiguredSender).toBe(true);
      expect(renderHoverLabel(message, routerModelChat)).toBeUndefined();
    });

    it('still reveals the model on hover when no routed model is shown', () => {
      const message = response({
        endpoint: CUSTOM_ENDPOINT,
        model: ROUTER_MODEL,
        sender: undefined,
      });

      expect(renderActions(message, routerModelChat).hasConfiguredSender).toBe(false);
      expect(renderHoverLabel(message, routerModelChat)).toBe(ROUTER_MODEL);
    });

    it('does not mark user rows as configured senders', () => {
      const message = routedResponse({ isCreatedByUser: true });

      expect(renderActions(message, routerModelChat).hasConfiguredSender).toBe(false);
    });
  });
});
