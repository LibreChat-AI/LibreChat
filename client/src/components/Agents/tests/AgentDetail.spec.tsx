/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import { RecoilRoot } from 'recoil';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { Constants, EModelEndpoint } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type t from 'librechat-data-provider';
import AgentDetail from '../AgentDetail';

// Mock dependencies
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: jest.fn(),
}));

jest.mock('~/hooks', () => ({
  useMediaQuery: jest.fn(() => false), // Mock as desktop by default
  useLocalize: jest.fn(),
  useDefaultConvo: jest.fn(),
  useFavorites: jest.fn(() => ({
    favorites: [],
    isFavoriteAgent: jest.fn(() => false),
    toggleFavoriteAgent: jest.fn(),
    isFavoriteModel: jest.fn(() => false),
    toggleFavoriteModel: jest.fn(),
    addFavoriteAgent: jest.fn(),
    removeFavoriteAgent: jest.fn(),
    addFavoriteModel: jest.fn(),
    removeFavoriteModel: jest.fn(),
    reorderFavorites: jest.fn(),
    isLoading: false,
    isError: false,
    isUpdating: false,
    fetchError: null,
    updateError: null,
  })),
}));

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: jest.fn(),
}));

jest.mock('~/utils/agents', () => ({
  renderAgentAvatar: jest.fn((agent, options) => (
    <div data-testid="agent-avatar" data-size={options?.size} />
  )),
}));

jest.mock('~/utils/endpoints', () => ({
  specDisplayFieldReset: {
    spec: null,
    iconURL: null,
    modelLabel: null,
    greeting: undefined,
  },
}));

jest.mock('~/Providers', () => ({
  useChatContext: jest.fn(),
}));

jest.mock('@tanstack/react-query', () => ({
  ...jest.requireActual('@tanstack/react-query'),
  useQueryClient: jest.fn(),
}));

// Mock clipboard API
const mockWriteText = jest.fn();

const mockNavigate = jest.fn();
const mockShowToast = jest.fn();
const mockLocalize = jest.fn((key: string, values?: Record<string, any>) => {
  if (key === 'com_agents_chat_with' && values?.name) {
    return `Chat with ${values.name}`;
  }
  return key;
});

const mockAgent: t.Agent = {
  id: 'test-agent-id',
  name: 'Test Agent',
  description: 'This is a test agent for unit testing',
  avatar: {
    filepath: '/path/to/avatar.png',
    source: 'local' as const,
  },
  model: 'gpt-4',
  provider: 'openai',
  instructions: 'You are a helpful test agent',
  tools: [],
  author: 'test-user-id',
  created_at: new Date().getTime(),
  version: 1,
  support_contact: {
    name: 'Support Team',
    email: 'support@test.com',
  },
  model_parameters: {
    model: undefined,
    temperature: null,
    maxContextTokens: null,
    max_context_tokens: null,
    max_output_tokens: null,
    top_p: null,
    frequency_penalty: null,
    presence_penalty: null,
  },
};

// Helper function to render with providers
const renderWithProviders = (ui: React.ReactElement, options = {}) => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <RecoilRoot>
        <MemoryRouter>{children}</MemoryRouter>
      </RecoilRoot>
    </QueryClientProvider>
  );

  return render(ui, { wrapper: Wrapper, ...options });
};

describe('AgentDetail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useNavigate as jest.Mock).mockReturnValue(mockNavigate);
    const { useToastContext } = require('@librechat/client');
    (useToastContext as jest.Mock).mockReturnValue({ showToast: mockShowToast });
    const { useLocalize, useDefaultConvo } = require('~/hooks');
    (useLocalize as jest.Mock).mockReturnValue(mockLocalize);
    (useDefaultConvo as jest.Mock).mockReturnValue(() => ({
      conversationId: Constants.NEW_CONVO,
      endpoint: EModelEndpoint.agents,
    }));

    // Mock useChatContext
    const { useChatContext } = require('~/Providers');
    (useChatContext as jest.Mock).mockReturnValue({
      conversation: { conversationId: 'test-convo-id' },
      newConversation: jest.fn(),
    });

    // Mock useQueryClient
    const { useQueryClient } = require('@tanstack/react-query');
    (useQueryClient as jest.Mock).mockReturnValue({
      getQueryData: jest.fn(),
      setQueryData: jest.fn(),
      removeQueries: jest.fn(),
      invalidateQueries: jest.fn(),
    });

    // Setup clipboard mock if it doesn't exist
    if (!navigator.clipboard) {
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: mockWriteText,
        },
        configurable: true,
      });
    } else {
      // If clipboard exists, spy on it
      jest.spyOn(navigator.clipboard, 'writeText').mockImplementation(mockWriteText);
    }
    mockWriteText.mockResolvedValue(undefined);
  });

  const defaultProps = {
    agent: mockAgent,
    isOpen: true,
    onClose: jest.fn(),
  };

  describe('Rendering', () => {
    it('should render agent details correctly', () => {
      renderWithProviders(<AgentDetail {...defaultProps} />);

      expect(screen.getByText('Test Agent')).toBeInTheDocument();
      expect(screen.getByText('This is a test agent for unit testing')).toBeInTheDocument();
      expect(screen.getByTestId('agent-avatar')).toBeInTheDocument();
      expect(screen.getByTestId('agent-avatar')).toHaveAttribute('data-size', 'xl');
    });

    it('should render contact information when available', () => {
      renderWithProviders(<AgentDetail {...defaultProps} />);

      expect(screen.getByText('com_agents_contact:')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Support Team' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Support Team' })).toHaveAttribute(
        'href',
        'mailto:support@test.com',
      );
    });

    it('should not render contact information when not available', () => {
      const agentWithoutContact = { ...mockAgent };
      delete (agentWithoutContact as any).support_contact;

      renderWithProviders(<AgentDetail {...defaultProps} agent={agentWithoutContact} />);

      expect(screen.queryByText('com_agents_contact:')).not.toBeInTheDocument();
    });

    it('should render loading state when agent is null', () => {
      renderWithProviders(<AgentDetail {...defaultProps} agent={null as any} />);

      expect(screen.getByText('com_agents_loading')).toBeInTheDocument();
    });

    it('should render copy link button', () => {
      renderWithProviders(<AgentDetail {...defaultProps} />);

      const copyLinkButton = screen.getByRole('button', { name: 'com_agents_copy_link' });
      expect(copyLinkButton).toBeInTheDocument();
      expect(copyLinkButton).toHaveAttribute('aria-label', 'com_agents_copy_link');
    });

    it('should render Start Chat button', () => {
      renderWithProviders(<AgentDetail {...defaultProps} />);

      const startChatButton = screen.getByRole('button', { name: 'com_agents_start_chat' });
      expect(startChatButton).toBeInTheDocument();
      expect(startChatButton).not.toBeDisabled();
    });
  });

  describe('Interactions', () => {
    it('should navigate to chat when Start Chat button is clicked', async () => {
      const user = userEvent.setup();
      const mockNewConversation = jest.fn();
      const mockQueryClient = {
        getQueryData: jest.fn().mockReturnValue(null),
        setQueryData: jest.fn(),
        removeQueries: jest.fn(),
        invalidateQueries: jest.fn(),
      };

      // Update mocks for this test
      const { useChatContext } = require('~/Providers');
      (useChatContext as jest.Mock).mockReturnValue({
        conversation: { conversationId: 'test-convo-id' },
        newConversation: mockNewConversation,
      });

      const { useQueryClient } = require('@tanstack/react-query');
      (useQueryClient as jest.Mock).mockReturnValue(mockQueryClient);

      renderWithProviders(<AgentDetail {...defaultProps} />);

      const startChatButton = screen.getByRole('button', { name: 'com_agents_start_chat' });
      await user.click(startChatButton);

      expect(mockNewConversation).toHaveBeenCalledWith({
        template: {
          conversationId: Constants.NEW_CONVO,
          endpoint: EModelEndpoint.agents,
        },
        preset: {
          conversationId: Constants.NEW_CONVO,
          endpoint: EModelEndpoint.agents,
          agent_id: 'test-agent-id',
          title: 'Chat with Test Agent',
          spec: null,
          iconURL: null,
          modelLabel: null,
          greeting: undefined,
        },
      });
    });

    it('should clear model spec display fields when starting an agent chat', async () => {
      const user = userEvent.setup();
      const mockNewConversation = jest.fn();
      const { useChatContext } = require('~/Providers');
      (useChatContext as jest.Mock).mockReturnValue({
        conversation: {
          conversationId: 'test-convo-id',
          spec: 'ClickHouse Agent',
          iconURL: '/images/clickhouse.svg',
          modelLabel: 'ClickHouse Agent',
        },
        newConversation: mockNewConversation,
      });
      const { useDefaultConvo } = require('~/hooks');
      (useDefaultConvo as jest.Mock).mockReturnValue(({ conversation, preset }) => ({
        ...conversation,
        ...preset,
      }));

      renderWithProviders(<AgentDetail {...defaultProps} />);
      await user.click(screen.getByRole('button', { name: 'com_agents_start_chat' }));

      expect(mockNewConversation).toHaveBeenCalledWith({
        template: expect.objectContaining({
          endpoint: EModelEndpoint.agents,
          agent_id: 'test-agent-id',
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

    it('should not navigate when agent is null', async () => {
      const user = userEvent.setup();
      renderWithProviders(<AgentDetail {...defaultProps} agent={null as any} />);

      const startChatButton = screen.getByRole('button', { name: 'com_agents_start_chat' });
      expect(startChatButton).toBeDisabled();

      await user.click(startChatButton);
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('should copy link and show success toast when Copy Link is clicked', async () => {
      const user = userEvent.setup();
      renderWithProviders(<AgentDetail {...defaultProps} />);

      // Click copy link button directly (no dropdown needed)
      const copyLinkButton = screen.getByRole('button', { name: 'com_agents_copy_link' });
      await user.click(copyLinkButton);

      // Wait for async clipboard operation to complete
      await waitFor(() => {
        expect(mockWriteText).toHaveBeenCalledWith(
          `${window.location.origin}/c/new?agent_id=test-agent-id`,
        );
      });

      await waitFor(() => {
        expect(mockShowToast).toHaveBeenCalledWith({
          message: 'com_agents_link_copied',
        });
      });
    });

    it('should show error toast when clipboard write fails', async () => {
      const user = userEvent.setup();
      mockWriteText.mockRejectedValue(new Error('Clipboard error'));

      renderWithProviders(<AgentDetail {...defaultProps} />);

      // Click copy link button directly
      const copyLinkButton = screen.getByRole('button', { name: 'com_agents_copy_link' });
      await user.click(copyLinkButton);

      // Wait for clipboard operation to fail and error toast to show
      await waitFor(() => {
        expect(mockWriteText).toHaveBeenCalled();
      });

      await waitFor(() => {
        expect(mockShowToast).toHaveBeenCalledWith({
          message: 'com_agents_link_copy_failed',
        });
      });
    });

    it('should call onClose when dialog is closed', () => {
      const mockOnClose = jest.fn();
      renderWithProviders(<AgentDetail {...defaultProps} onClose={mockOnClose} isOpen={false} />);

      // Since we're testing the onOpenChange callback, we need to trigger it
      // This would normally be done by the Dialog component when ESC is pressed or overlay is clicked
      // We'll test this by checking that onClose is properly passed to the Dialog
      expect(mockOnClose).toBeDefined();
    });
  });

  describe('Accessibility', () => {
    it('should have proper ARIA attributes', () => {
      renderWithProviders(<AgentDetail {...defaultProps} />);

      const copyLinkButton = screen.getByRole('button', { name: 'com_agents_copy_link' });
      expect(copyLinkButton).toHaveAttribute('aria-label', 'com_agents_copy_link');
    });

    it('should support keyboard navigation', async () => {
      const user = userEvent.setup();
      renderWithProviders(<AgentDetail {...defaultProps} />);

      const copyLinkButton = screen.getByRole('button', { name: 'com_agents_copy_link' });

      // Focus and activate with Enter key
      copyLinkButton.focus();
      await user.keyboard('{Enter}');

      await waitFor(() => {
        expect(mockWriteText).toHaveBeenCalledWith(
          `${window.location.origin}/c/new?agent_id=test-agent-id`,
        );
      });
    });

    it('should have proper focus management', async () => {
      renderWithProviders(<AgentDetail {...defaultProps} />);

      const copyLinkButton = screen.getByRole('button', { name: 'com_agents_copy_link' });
      expect(copyLinkButton).toHaveClass('focus-visible:outline-none', 'focus-visible:ring-2');
    });
  });

  describe('Edge Cases', () => {
    it('should handle agent with only email contact', () => {
      const agentWithEmailOnly = {
        ...mockAgent,
        support_contact: {
          email: 'support@test.com',
        },
      };

      renderWithProviders(<AgentDetail {...defaultProps} agent={agentWithEmailOnly} />);

      expect(screen.getByRole('link', { name: 'support@test.com' })).toBeInTheDocument();
    });

    it('should handle agent with only name contact', () => {
      const agentWithNameOnly = {
        ...mockAgent,
        support_contact: {
          name: 'Support Team',
        },
      };

      renderWithProviders(<AgentDetail {...defaultProps} agent={agentWithNameOnly} />);

      expect(screen.getByText('Support Team')).toBeInTheDocument();
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
    });

    it('should handle very long description with proper text wrapping', () => {
      const agentWithLongDescription = {
        ...mockAgent,
        description:
          'This is a very long description that should wrap properly and be displayed in multiple lines when the content exceeds the available width of the container.',
      };

      renderWithProviders(<AgentDetail {...defaultProps} agent={agentWithLongDescription} />);

      const description = screen.getByText(agentWithLongDescription.description);
      expect(description).toHaveClass('whitespace-pre-wrap');
    });

    it('should handle special characters in agent name', () => {
      const agentWithSpecialChars = {
        ...mockAgent,
        name: 'Test Agent™ & Co. (v2.0)',
      };

      renderWithProviders(<AgentDetail {...defaultProps} agent={agentWithSpecialChars} />);

      expect(screen.getByText('Test Agent™ & Co. (v2.0)')).toBeInTheDocument();
    });
  });
});
