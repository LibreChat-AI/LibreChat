import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type t from 'librechat-data-provider';
import AgentCard from '../AgentCard';

jest.mock('~/utils', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  return {
    cn: (...classes: string[]) => classes.filter(Boolean).join(' '),
    renderAgentAvatar: (agent: any) => {
      const avatar = agent.avatar;
      const src = typeof avatar === 'string' ? avatar : avatar?.filepath;
      if (src) {
        return <img src={src} alt={`${agent.name} avatar`} />;
      }
      return <svg className="lucide-feather" />;
    },
  };
});

// Mock useLocalize hook
jest.mock('~/hooks/useLocalize', () => () => (key: string) => {
  const mockTranslations: Record<string, string> = {
    com_agents_created_by: 'Created by',
    com_agents_agent_card_label: '{{name}} agent. {{description}}',
    com_agents_category_general: 'General',
    com_agents_category_hr: 'Human Resources',
    com_agents_contact: 'Contact',
    com_agents_no_contact_available: 'No contact available',
    com_agents_description_card: '{{description}}',
  };
  return mockTranslations[key] || key;
});

// Mock useAgentCategories hook
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string | number>) => {
    const mockTranslations: Record<string, string> = {
      com_agents_created_by: 'Created by',
      com_agents_agent_card_label: '{{name}} agent. {{description}}',
      com_agents_category_general: 'General',
      com_agents_category_hr: 'Human Resources',
      com_agents_contact: 'Contact',
      com_agents_no_contact_available: 'No contact available',
      com_agents_description_card: '{{description}}',
    };
    let translation = mockTranslations[key] || key;

    // Replace placeholders with actual values
    if (values) {
      Object.entries(values).forEach(([placeholder, value]) => {
        translation = translation.replace(
          new RegExp(`\\{\\{${placeholder}\\}\\}`, 'g'),
          String(value),
        );
      });
    }

    return translation;
  },
  useAgentCategories: () => ({
    categories: [
      { value: 'general', label: 'com_agents_category_general' },
      { value: 'hr', label: 'com_agents_category_hr' },
      { value: 'custom', label: 'Custom Category' }, // Non-localized custom category
    ],
  }),
  useDefaultConvo: jest.fn(() => jest.fn(() => ({}))),
  useFavorites: jest.fn(() => ({
    isFavoriteAgent: jest.fn(() => false),
    toggleFavoriteAgent: jest.fn(),
  })),
}));

// Mock AgentDetailContent to avoid testing dialog internals
jest.mock('../AgentDetailContent', () => ({
  __esModule: true,
  // eslint-disable-next-line i18next/no-literal-string
  default: () => <div data-testid="agent-detail-content">Agent Detail Content</div>,
}));

// Mock Providers
jest.mock('~/Providers', () => ({
  useChatContext: jest.fn(() => ({
    conversation: null,
    newConversation: jest.fn(),
  })),
}));

// Mock @librechat/client with proper Dialog behavior
jest.mock('@librechat/client', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  return {
    useToastContext: jest.fn(() => ({
      showToast: jest.fn(),
    })),
    OGDialog: ({ children, open, onOpenChange }: any) => {
      // Store onOpenChange in context for trigger to call
      return (
        <div data-testid="dialog-wrapper" data-open={open}>
          {React.Children.map(children, (child: any) => {
            if (child?.type?.displayName === 'OGDialogTrigger' || child?.props?.['data-trigger']) {
              return React.cloneElement(child, { onOpenChange });
            }
            // Only render content when open
            if (child?.type?.displayName === 'OGDialogContent' && !open) {
              return null;
            }
            return child;
          })}
        </div>
      );
    },
    OGDialogTrigger: ({ children, asChild, onOpenChange }: any) => {
      if (asChild && React.isValidElement(children)) {
        return React.cloneElement(children as React.ReactElement<any>, {
          onClick: (e: any) => {
            (children as any).props?.onClick?.(e);
            onOpenChange?.(true);
          },
        });
      }
      return <div onClick={() => onOpenChange?.(true)}>{children}</div>;
    },
    OGDialogContent: ({ children }: any) => <div data-testid="dialog-content">{children}</div>,
    Label: ({ children, className }: any) => <span className={className}>{children}</span>,
  };
});

// Create wrapper with QueryClient
const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

describe('AgentCard', () => {
  const mockAgent: t.Agent = {
    id: '1',
    name: 'Test Agent',
    description: 'A test agent for testing purposes',
    support_contact: {
      name: 'Test Support',
      email: 'test@example.com',
    },
    avatar: { filepath: '/test-avatar.png', source: 'local' },
    created_at: 1672531200000,
    instructions: 'Test instructions',
    provider: 'openai' as const,
    model: 'gpt-4',
    model_parameters: {
      temperature: 0.7,
      maxContextTokens: 4096,
      max_context_tokens: 4096,
      max_output_tokens: 1024,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    },
  };

  const mockOnSelect = jest.fn();
  const Wrapper = createWrapper();

  beforeEach(() => {
    mockOnSelect.mockClear();
  });

  it('renders agent information correctly', () => {
    render(
      <Wrapper>
        <AgentCard agent={mockAgent} onSelect={mockOnSelect} />
      </Wrapper>,
    );

    expect(screen.getByText('Test Agent')).toBeInTheDocument();
    expect(screen.getByText('A test agent for testing purposes')).toBeInTheDocument();
  });

  it('renders an HTML description as plain text in the card and accessible label', () => {
    render(
      <Wrapper>
        <AgentCard
          agent={{
            ...mockAgent,
            description:
              '<span>Assistant for projects. <a href="https://example.com">Read the guide</a></span>',
          }}
        />
      </Wrapper>,
    );

    expect(screen.getByText('Assistant for projects. Read the guide')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Read the guide' })).not.toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveAttribute(
      'aria-label',
      'Test Agent agent. Assistant for projects. Read the guide',
    );
  });

  it('displays avatar when provided as object', () => {
    render(
      <Wrapper>
        <AgentCard agent={mockAgent} onSelect={mockOnSelect} />
      </Wrapper>,
    );

    const avatarImg = screen.getByAltText('Test Agent avatar');
    expect(avatarImg).toBeInTheDocument();
    expect(avatarImg).toHaveAttribute('src', '/test-avatar.png');
  });

  it('displays avatar when provided as string', () => {
    const agentWithStringAvatar = {
      ...mockAgent,
      avatar: '/string-avatar.png' as any, // Legacy support for string avatars
    };

    render(
      <Wrapper>
        <AgentCard agent={agentWithStringAvatar} onSelect={mockOnSelect} />
      </Wrapper>,
    );

    const avatarImg = screen.getByAltText('Test Agent avatar');
    expect(avatarImg).toBeInTheDocument();
    expect(avatarImg).toHaveAttribute('src', '/string-avatar.png');
  });

  it('displays Feather icon fallback when no avatar is provided', () => {
    const agentWithoutAvatar = {
      ...mockAgent,
      avatar: undefined,
    };

    render(
      <Wrapper>
        <AgentCard agent={agentWithoutAvatar as any as t.Agent} onSelect={mockOnSelect} />
      </Wrapper>,
    );

    // Check for Feather icon presence by looking for the svg with lucide-feather class
    const featherIcon = document.querySelector('.lucide-feather');
    expect(featherIcon).toBeInTheDocument();
  });

  it('card is clickable and has dialog trigger', () => {
    render(
      <Wrapper>
        <AgentCard agent={mockAgent} onSelect={mockOnSelect} />
      </Wrapper>,
    );

    const card = screen.getByRole('button');
    // Card should be clickable - the actual dialog behavior is handled by Radix
    expect(card).toBeInTheDocument();
    expect(() => fireEvent.click(card)).not.toThrow();
  });

  it('handles Enter key press', () => {
    render(
      <Wrapper>
        <AgentCard agent={mockAgent} onSelect={mockOnSelect} />
      </Wrapper>,
    );

    const card = screen.getByRole('button');
    // Card should respond to keyboard - the actual dialog behavior is handled by Radix
    expect(() => fireEvent.keyDown(card, { key: 'Enter' })).not.toThrow();
  });

  it('handles Space key press', () => {
    render(
      <Wrapper>
        <AgentCard agent={mockAgent} onSelect={mockOnSelect} />
      </Wrapper>,
    );

    const card = screen.getByRole('button');
    // Card should respond to keyboard - the actual dialog behavior is handled by Radix
    expect(() => fireEvent.keyDown(card, { key: ' ' })).not.toThrow();
  });

  it('does not call onSelect for other keys', () => {
    render(
      <Wrapper>
        <AgentCard agent={mockAgent} onSelect={mockOnSelect} />
      </Wrapper>,
    );

    const card = screen.getByRole('button');
    fireEvent.keyDown(card, { key: 'Escape' });

    expect(mockOnSelect).not.toHaveBeenCalled();
  });

  it('applies additional className when provided', () => {
    render(
      <Wrapper>
        <AgentCard agent={mockAgent} onSelect={mockOnSelect} className="custom-class" />
      </Wrapper>,
    );

    const card = screen.getByRole('button');
    expect(card).toHaveClass('custom-class');
  });

  it('handles missing support contact gracefully', () => {
    const agentWithoutContact = {
      ...mockAgent,
      support_contact: undefined,
      authorName: undefined,
    };

    render(
      <Wrapper>
        <AgentCard agent={agentWithoutContact} onSelect={mockOnSelect} />
      </Wrapper>,
    );

    expect(screen.getByText('Test Agent')).toBeInTheDocument();
    expect(screen.getByText('A test agent for testing purposes')).toBeInTheDocument();
    expect(screen.getByText('No contact available')).toBeInTheDocument();
  });

  it('falls back to owner contact when support_contact is missing', () => {
    const agentWithAuthorName = {
      ...mockAgent,
      support_contact: undefined,
      authorName: 'John Doe',
      owner_contact: {
        name: 'Owner User',
      },
    };

    render(
      <Wrapper>
        <AgentCard agent={agentWithAuthorName} onSelect={mockOnSelect} />
      </Wrapper>,
    );

    expect(screen.getByText('Contact:')).toBeInTheDocument();
    expect(screen.getByText('Owner User')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Owner User' })).not.toBeInTheDocument();
    expect(screen.queryByText('by John Doe')).not.toBeInTheDocument();
  });

  it('has proper accessibility attributes', () => {
    render(
      <Wrapper>
        <AgentCard agent={mockAgent} onSelect={mockOnSelect} />
      </Wrapper>,
    );

    const card = screen.getByRole('button');
    expect(card).toHaveAttribute('tabIndex', '0');
    expect(card).toHaveAttribute(
      'aria-label',
      'Test Agent agent. A test agent for testing purposes',
    );
  });

  it('keeps long names clear of the category badge without squeezing the card', () => {
    const longName = 'Customer Support Escalation Specialist With Extended Coverage';
    const longDescription =
      'A deliberately long description that exercises every available line in the marketplace card.';
    const agentWithLongContent = {
      ...mockAgent,
      name: longName,
      description: longDescription,
      category: 'general',
    };

    render(
      <Wrapper>
        <AgentCard agent={agentWithLongContent} onSelect={mockOnSelect} />
      </Wrapper>,
    );

    const card = screen.getByRole('button');
    const title = screen.getByText(longName);
    const description = screen.getByText(longDescription);

    /** Fixed heights only. A min-height under a fixed height would never apply. */
    expect(card).toHaveClass('h-40', 'lg:h-44');
    expect(card.className).not.toMatch(/min-h-/);

    /** Title and description are clamped, and the column stops flex from slicing lines */
    expect(title).toHaveClass('line-clamp-2');
    expect(description).toHaveClass('line-clamp-2', 'lg:line-clamp-3');
    expect(title.parentElement).toHaveClass('[&>*]:shrink-0');

    /**
     * The name must not render through the shared Label component. Label hardcodes
     * `block`, which overrides the `display: -webkit-box` that line-clamp needs and
     * leaves the clamp inert, plus `break-all`, which splits names mid-word.
     */
    expect(title.tagName).toBe('SPAN');
    expect(title).toHaveClass('break-words');
    expect(title.className).not.toMatch(/\bbreak-all\b/);

    /** A floated spacer reserves badge room on the first title line only */
    const spacer = title.querySelector('[aria-hidden="true"]');
    expect(spacer).toHaveClass('float-right');
  });

  it('omits the badge spacer when the agent has no category', () => {
    const uncategorizedName = 'Agent Without A Category';
    const agentWithoutCategory = { ...mockAgent, name: uncategorizedName, category: '' };

    render(
      <Wrapper>
        <AgentCard agent={agentWithoutCategory} onSelect={mockOnSelect} />
      </Wrapper>,
    );

    const title = screen.getByText(uncategorizedName);
    expect(title.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('displays localized category label', () => {
    const agentWithCategory = {
      ...mockAgent,
      category: 'general',
    };

    render(
      <Wrapper>
        <AgentCard agent={agentWithCategory} onSelect={mockOnSelect} />
      </Wrapper>,
    );

    expect(screen.getByText('General')).toBeInTheDocument();
  });

  it('displays custom category label', () => {
    const agentWithCustomCategory = {
      ...mockAgent,
      category: 'custom',
    };

    render(
      <Wrapper>
        <AgentCard agent={agentWithCustomCategory} onSelect={mockOnSelect} />
      </Wrapper>,
    );

    expect(screen.getByText('Custom Category')).toBeInTheDocument();
  });

  it('displays capitalized fallback for unknown category', () => {
    const agentWithUnknownCategory = {
      ...mockAgent,
      category: 'unknown',
    };

    render(
      <Wrapper>
        <AgentCard agent={agentWithUnknownCategory} onSelect={mockOnSelect} />
      </Wrapper>,
    );

    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('does not display category tag when category is not provided', () => {
    render(
      <Wrapper>
        <AgentCard agent={mockAgent} onSelect={mockOnSelect} />
      </Wrapper>,
    );

    expect(screen.queryByText('General')).not.toBeInTheDocument();
    expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
  });

  it('works without onSelect callback', () => {
    render(
      <Wrapper>
        <AgentCard agent={mockAgent} />
      </Wrapper>,
    );

    const card = screen.getByRole('button');
    // Should not throw when clicking without onSelect
    expect(() => fireEvent.click(card)).not.toThrow();
  });
});
