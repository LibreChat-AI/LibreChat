import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TConversation } from 'librechat-data-provider';
import '@testing-library/jest-dom';
import type t from 'librechat-data-provider';
import AgentDetailContent from '../AgentDetailContent';

const mockNewConversation = jest.fn();
let mockConversation: Partial<TConversation> | undefined;
const mockIsFavoriteAgent = jest.fn(() => false);

jest.mock('librechat-data-provider', () => ({
  QueryKeys: {
    agents: 'agents',
    messages: 'messages',
  },
  Constants: {
    NEW_CONVO: 'new',
  },
  EModelEndpoint: {
    agents: 'agents',
  },
  PermissionBits: {
    EDIT: 2,
  },
  LocalStorageKeys: {
    AGENT_ID_PREFIX: 'agent:',
  },
}));

jest.mock('@librechat/client', () => {
  const { createPinMorphIconMock } = jest.requireActual('~/../test/mockMorphIcon');
  return {
    OGDialogContent: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="dialog-content">{children}</div>
    ),
    Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button {...props}>{children}</button>
    ),
    TooltipAnchor: ({ render }: { render: React.ReactNode }) => render,
    MorphIcon: createPinMorphIconMock(),
    useToastContext: () => ({
      showToast: jest.fn(),
    }),
  };
});

jest.mock('~/hooks', () => ({
  useDefaultConvo: () => jest.fn((value) => value.conversation),
  useFavorites: () => ({
    isFavoriteAgent: mockIsFavoriteAgent,
    toggleFavoriteAgent: jest.fn(),
  }),
  useLocalize: () => (key: string, values?: Record<string, string>) => {
    const translations: Record<string, string> = {
      com_agents_contact: 'Contact',
      com_agents_no_contact_available: 'No contact available',
      com_agents_loading: 'Loading',
      com_agents_link_copied: 'Link copied',
      com_agents_link_copy_failed: 'Link copy failed',
      com_agents_start_chat: 'Start chat',
      com_agents_chat_with: `Chat with ${values?.name ?? ''}`,
      com_ui_agent: 'Agent',
      com_ui_pin: 'Pin',
      com_ui_unpin: 'Unpin',
      com_agents_copy_link: 'Copy link',
    };
    return translations[key] || key;
  },
}));

jest.mock('~/Providers', () => ({
  useChatContext: () => ({
    conversation: mockConversation,
    newConversation: mockNewConversation,
  }),
}));

jest.mock('~/utils', () => ({
  cn: (...classes: string[]) => classes.filter(Boolean).join(' '),
  clearMessagesCache: jest.fn(),
  renderAgentAvatar: () => <div data-testid="agent-avatar" />,
  specDisplayFieldReset: {
    spec: null,
    iconURL: null,
    modelLabel: null,
    greeting: undefined,
  },
}));

const renderWithClient = (children: React.ReactNode) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>);
};

const baseAgent: t.Agent = {
  id: 'agent-1',
  name: 'Agent One',
  description: 'Agent description',
  created_at: 0,
  avatar: null,
  provider: 'openai',
  model: 'gpt-4',
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

describe('AgentDetailContent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConversation = undefined;
    mockIsFavoriteAgent.mockReturnValue(false);
  });

  it('renders support contact with mailto link', () => {
    renderWithClient(
      <AgentDetailContent
        agent={{
          ...baseAgent,
          support_contact: { name: 'Support Team', email: 'support@example.com' },
          owner_contact: { name: 'Owner User' },
        }}
      />,
    );

    expect(screen.getByText('Contact:')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Support Team' })).toHaveAttribute(
      'href',
      'mailto:support@example.com',
    );
    expect(screen.queryByText('Owner User')).not.toBeInTheDocument();
  });

  it('renders sanitized HTML descriptions with safe links', () => {
    renderWithClient(
      <AgentDetailContent
        agent={{
          ...baseAgent,
          description:
            '<span onclick="alert(1)">Assistant. <a href="https://example.com">Read the guide</a><script>alert(1)</script></span>',
        }}
      />,
    );

    const link = screen.getByRole('link', { name: 'Read the guide' });
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(document.querySelector('[onclick]')).not.toBeInTheDocument();
    expect(document.querySelector('script')).not.toBeInTheDocument();
  });

  it('falls back to owner contact when support contact is missing', () => {
    renderWithClient(
      <AgentDetailContent
        agent={{
          ...baseAgent,
          owner_contact: { name: 'Owner User' },
        }}
      />,
    );

    expect(screen.getByText('Owner User')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Owner User' })).not.toBeInTheDocument();
  });

  it('clears model spec display fields when starting an agent chat', async () => {
    const user = userEvent.setup();
    mockConversation = {
      conversationId: 'existing-conversation',
      spec: 'ClickHouse Agent',
      iconURL: '/images/clickhouse.svg',
      modelLabel: 'ClickHouse Agent',
    };

    renderWithClient(<AgentDetailContent agent={baseAgent} />);
    await user.click(screen.getByRole('button', { name: 'Start chat' }));

    expect(mockNewConversation).toHaveBeenCalledWith({
      template: expect.objectContaining({
        endpoint: 'agents',
        agent_id: 'agent-1',
        spec: null,
        iconURL: null,
        modelLabel: null,
      }),
      preset: expect.objectContaining({
        spec: null,
        iconURL: null,
        modelLabel: null,
      }),
    });
  });

  it('shows pin icon when agent is not a favorite and pin-off when it is', () => {
    const { unmount } = renderWithClient(<AgentDetailContent agent={baseAgent} />);
    expect(screen.getByRole('button', { name: 'Pin' })).toBeInTheDocument();
    expect(screen.getByTestId('morph-icon')).toHaveAttribute('data-icon', 'pin');
    unmount();

    mockIsFavoriteAgent.mockReturnValue(true);
    renderWithClient(<AgentDetailContent agent={baseAgent} />);
    expect(screen.getByRole('button', { name: 'Unpin' })).toBeInTheDocument();
    expect(screen.getByTestId('morph-icon')).toHaveAttribute('data-icon', 'pin-off');
  });
});
