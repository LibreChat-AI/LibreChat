import React from 'react';
import * as t from 'librechat-data-provider';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CategoryTabs from '../CategoryTabs';
import ErrorDisplay from '../ErrorDisplay';
import AgentGrid from '../AgentGrid';
import AgentCard from '../AgentCard';
import SearchBar from '../SearchBar';

// Mock matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: jest.fn().mockImplementation(() => ({
    matches: false,
    media: '',
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })),
});

// Mock Recoil
jest.mock('recoil', () => ({
  useRecoilValue: jest.fn(() => 'en'),
  RecoilRoot: ({ children }: any) => children,
  atom: jest.fn(() => ({})),
  atomFamily: jest.fn(() => ({})),
  selector: jest.fn(() => ({})),
  selectorFamily: jest.fn(() => ({})),
  useRecoilState: jest.fn(() => ['en', jest.fn()]),
  useSetRecoilState: jest.fn(() => jest.fn()),
}));

// Mock react-i18next
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: jest.fn() },
  }),
}));

// Create the localize function once to be reused
const mockLocalize = jest.fn((key: string, options?: any) => {
  const translations: Record<string, string> = {
    com_agents_category_tabs_label: 'Agent Categories',
    com_agents_category_tab_label: `${options?.category} category, ${options?.position} of ${options?.total}`,
    com_agents_search_instructions: 'Type to search agents by name or description',
    com_agents_search_aria: 'Search agents',
    com_agents_clear_search: 'Clear search',
    com_agents_agent_card_label: `${options?.name} agent. ${options?.description}`,
    com_agents_grid_announcement: `Showing ${options?.count} agents in ${options?.category} category`,
    com_agents_load_more_label: `Load more agents from ${options?.category} category`,
    com_agents_error_retry: 'Try Again',
    com_agents_loading: 'Loading...',
    com_agents_empty_state_heading: 'No agents found',
    com_agents_search_empty_heading: 'No search results',
    com_agents_created_by: 'by',
    com_agents_top_picks: 'Top Picks',
    com_agents_all_category: 'All',
    // ErrorDisplay translations
    com_agents_error_suggestion_generic: 'Try refreshing the page or check your network connection',
    com_agents_error_network_title: 'Network Error',
    com_agents_error_network_suggestion: 'Check your internet connection and try again',
    com_agents_error_not_found_title: 'Not Found',
    com_agents_error_invalid_request: 'Invalid Request',
    com_agents_error_bad_request_suggestion: 'Please check your input and try again',
    com_agents_error_server_title: 'Server Error',
    com_agents_error_server_suggestion: 'Please try again later',
    com_agents_error_title: 'Error',
    com_agents_error_search_title: 'Search Error',
    com_agents_error_category_title: 'Category Error',
    com_agents_search_no_results: `No results found for "${options?.query}"`,
    com_agents_category_empty: `No agents found in ${options?.category} category`,
    com_agents_error_not_found_message: 'The requested resource could not be found',
  };
  return translations[key] || key;
});

// Mock useLocalize specifically
jest.mock('~/hooks/useLocalize', () => ({
  __esModule: true,
  default: () => mockLocalize,
}));

// Mock hooks
jest.mock('~/hooks', () => ({
  useLocalize: () => mockLocalize,
  useDebounce: jest.fn(),
  useAgentCategories: jest.fn(),
  useDefaultConvo: jest.fn(() => jest.fn(() => ({}))),
  useFavorites: jest.fn(() => ({
    isFavoriteAgent: jest.fn(() => false),
    toggleFavoriteAgent: jest.fn(),
  })),
}));

// Mock Providers
jest.mock('~/Providers', () => ({
  useChatContext: jest.fn(() => ({
    conversation: null,
    newConversation: jest.fn(),
  })),
}));

// Mock @librechat/client toast context
jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: jest.fn(() => ({
    showToast: jest.fn(),
  })),
}));

jest.mock('~/data-provider/Agents', () => ({
  useMarketplaceAgentsInfiniteQuery: jest.fn(),
  useGetAgentByIdQuery: jest.fn(() => ({ error: null, isFetching: false })),
}));

/* These cases render the error card on its own, without the app's query client. */
jest.mock('~/data-provider', () => ({
  useGetStartupConfig: jest.fn(() => ({ data: undefined })),
}));

// Mock utility functions
jest.mock('~/utils/agents', () => ({
  renderAgentAvatar: jest.fn(() => <div data-testid="agent-avatar" />),
  getContactDisplayName: jest.fn((agent) => agent.authorName),
}));

// Mock SmartLoader
jest.mock('../SmartLoader', () => ({
  SmartLoader: ({ children, isLoading }: any) => (isLoading ? <div>Loading...</div> : children),
  useHasData: jest.fn(() => true),
}));

// Mock AgentDetailContent to avoid testing dialog internals
jest.mock('../AgentDetailContent', () => ({
  __esModule: true,
  // eslint-disable-next-line i18next/no-literal-string
  default: () => <div data-testid="agent-detail-content">Agent Detail Content</div>,
}));

// Import the actual modules to get the mocked functions
import { useMarketplaceAgentsInfiniteQuery } from '~/data-provider/Agents';
import { useAgentCategories, useDebounce } from '~/hooks';

// Get typed mock functions
const mockUseMarketplaceAgentsInfiniteQuery = jest.mocked(useMarketplaceAgentsInfiniteQuery);
const mockUseAgentCategories = jest.mocked(useAgentCategories);
const mockUseDebounce = jest.mocked(useDebounce);

// Create wrapper with QueryClient
const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

describe('Accessibility Improvements', () => {
  beforeEach(() => {
    mockUseMarketplaceAgentsInfiniteQuery.mockClear();
    mockUseAgentCategories.mockClear();
    mockUseDebounce.mockClear();

    // Default mock implementations
    mockUseDebounce.mockImplementation((value) => value);
    mockUseAgentCategories.mockReturnValue({
      categories: [
        { value: 'promoted', label: 'Top Picks' },
        { value: 'all', label: 'All' },
        { value: 'productivity', label: 'Productivity' },
      ],
      emptyCategory: { value: 'all', label: 'All' },
      isLoading: false,
      error: null,
    });
  });

  describe('CategoryTabs Accessibility', () => {
    const categories = [
      { value: 'promoted', label: 'Top Picks', count: 5 },
      { value: 'all', label: 'All', count: 20 },
      { value: 'productivity', label: 'Productivity', count: 8 },
    ];

    it('implements proper tablist role and ARIA attributes', () => {
      render(
        <CategoryTabs
          categories={categories}
          activeTab="promoted"
          isLoading={false}
          onChange={jest.fn()}
        />,
      );

      // Check tablist role
      const tablist = screen.getByRole('tablist');
      expect(tablist).toBeInTheDocument();
      expect(tablist).toHaveAttribute('aria-label', 'Agent Categories');
      expect(tablist).toHaveAttribute('aria-orientation', 'horizontal');

      // Check individual tabs
      const tabs = screen.getAllByRole('tab');
      expect(tabs).toHaveLength(3);

      tabs.forEach((tab) => {
        expect(tab).toHaveAttribute('aria-selected');
        expect(tab).toHaveAttribute('aria-controls');
        expect(tab).toHaveAttribute('id');
      });
    });

    it('supports keyboard navigation', () => {
      const onChange = jest.fn();
      render(
        <CategoryTabs
          categories={categories}
          activeTab="promoted"
          isLoading={false}
          onChange={onChange}
        />,
      );

      const promotedTab = screen.getByRole('tab', { name: /Top Picks category/ });

      // Test arrow key navigation
      fireEvent.keyDown(promotedTab, { key: 'ArrowRight' });
      expect(onChange).toHaveBeenCalledWith('all');

      fireEvent.keyDown(promotedTab, { key: 'ArrowLeft' });
      expect(onChange).toHaveBeenCalledWith('productivity');

      fireEvent.keyDown(promotedTab, { key: 'Home' });
      expect(onChange).toHaveBeenCalledWith('promoted');

      fireEvent.keyDown(promotedTab, { key: 'End' });
      expect(onChange).toHaveBeenCalledWith('productivity');
    });

    it('manages focus correctly', () => {
      const onChange = jest.fn();
      render(
        <CategoryTabs
          categories={categories}
          activeTab="promoted"
          isLoading={false}
          onChange={onChange}
        />,
      );

      const promotedTab = screen.getByRole('tab', { name: /Top Picks category/ });
      const allTab = screen.getByRole('tab', { name: /All category/ });

      // Active tab should be focusable
      expect(promotedTab).toHaveAttribute('tabIndex', '0');
      expect(allTab).toHaveAttribute('tabIndex', '-1');
    });
  });

  describe('SearchBar Accessibility', () => {
    it('provides proper search role and labels', () => {
      render(<SearchBar value="" onSearch={jest.fn()} />);

      // Check search landmark
      const searchRegion = screen.getByRole('search');
      expect(searchRegion).toBeInTheDocument();

      // Check input accessibility
      const searchInput = screen.getByRole('textbox');
      expect(searchInput).toHaveAttribute('id', 'agent-search');
      expect(searchInput).toHaveAttribute('aria-label', 'Search agents');
      expect(searchInput).toHaveAttribute(
        'aria-describedby',
        'search-instructions search-results-count',
      );

      // Check hidden label exists
      const hiddenLabel = screen.getByLabelText('Search agents');
      expect(hiddenLabel).toBeInTheDocument();
    });

    it('provides accessible clear button', () => {
      render(<SearchBar value="test" onSearch={jest.fn()} />);

      const clearButton = screen.getByRole('button', { name: 'Clear search' });
      expect(clearButton).toBeInTheDocument();
      expect(clearButton).toHaveAttribute('aria-label', 'Clear search');
    });

    it('hides the decorative clear icon from screen readers', () => {
      render(<SearchBar value="test" onSearch={jest.fn()} />);
      const clearButton = screen.getByRole('button', { name: 'Clear search' });
      expect(clearButton.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    });
  });

  describe('AgentCard Accessibility', () => {
    const mockAgent = {
      id: 'test-agent',
      name: 'Test Agent',
      description: 'A test agent for testing',
      authorName: 'Test Author',
      created_at: 1704067200000,
      avatar: null,
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

    it('provides an accessible native dialog trigger', () => {
      const Wrapper = createWrapper();
      render(
        <Wrapper>
          <AgentCard agent={mockAgent as t.Agent} onSelect={jest.fn()} />
        </Wrapper>,
      );

      const card = screen.getByRole('button', { name: 'Test Agent' });
      expect(card).toHaveAttribute('type', 'button');
      expect(card).toHaveAccessibleDescription(mockAgent.description);
      expect(screen.getAllByRole('button')).toHaveLength(1);
    });

    it('supports keyboard interaction', () => {
      const Wrapper = createWrapper();
      render(
        <Wrapper>
          <AgentCard agent={mockAgent as t.Agent} onSelect={jest.fn()} />
        </Wrapper>,
      );

      const card = screen.getByRole('button', { name: 'Test Agent' });

      // Native buttons provide Enter and Space activation without custom key handlers.
      expect(card).not.toHaveAttribute('tabindex');
      expect(() => fireEvent.keyDown(card, { key: 'Enter' })).not.toThrow();
      expect(() => fireEvent.keyDown(card, { key: ' ' })).not.toThrow();
    });
  });

  describe('AgentGrid Accessibility', () => {
    beforeEach(() => {
      mockUseMarketplaceAgentsInfiniteQuery.mockReturnValue({
        data: {
          pages: [
            {
              data: [
                { id: '1', name: 'Agent 1', description: 'First agent' },
                { id: '2', name: 'Agent 2', description: 'Second agent' },
              ],
            },
          ],
        },
        isLoading: false,
        error: null,
      } as any);
    });

    it('implements proper tabpanel structure', () => {
      const Wrapper = createWrapper();
      render(
        <Wrapper>
          <AgentGrid
            category="all"
            searchQuery=""
            onSelectAgent={jest.fn()}
            scrollElementRef={React.createRef<HTMLElement>()}
          />
        </Wrapper>,
      );

      // Check tabpanel role
      const tabpanel = screen.getByRole('tabpanel');
      expect(tabpanel).toHaveAttribute('id', 'category-panel-all');
      expect(tabpanel).toHaveAttribute('aria-labelledby', 'category-tab-all');
    });

    it('provides list structure with accessible names', () => {
      const Wrapper = createWrapper();
      render(
        <Wrapper>
          <AgentGrid
            category="all"
            searchQuery=""
            onSelectAgent={jest.fn()}
            scrollElementRef={React.createRef<HTMLElement>()}
          />
        </Wrapper>,
      );

      const list = screen.getByRole('list');
      expect(list).toHaveAttribute('aria-label', 'Showing 2 agents in All category');

      const listItems = screen.getAllByRole('listitem');
      expect(listItems).toHaveLength(2);
    });

    it('announces loading states to screen readers', () => {
      mockUseMarketplaceAgentsInfiniteQuery.mockReturnValue({
        data: {
          pages: [{ data: [{ id: '1', name: 'Agent 1' }] }],
        },
        isFetching: true,
        hasNextPage: true,
        isFetchingNextPage: true,
        isLoading: false,
        error: null,
      } as any);

      const Wrapper = createWrapper();
      render(
        <Wrapper>
          <AgentGrid
            category="all"
            searchQuery=""
            onSelectAgent={jest.fn()}
            scrollElementRef={React.createRef<HTMLElement>()}
          />
        </Wrapper>,
      );

      // Check for loading announcement when fetching more data
      const loadingStatus = screen.getByRole('status');
      expect(loadingStatus).toBeInTheDocument();
      expect(loadingStatus).toHaveAttribute('aria-live', 'polite');
      expect(loadingStatus).toHaveAttribute('aria-label', 'Loading...');

      // Check for screen reader text
      const srText = screen.getByText('Loading...');
      expect(srText).toHaveClass('sr-only');
    });

    it('provides accessible empty states', () => {
      mockUseMarketplaceAgentsInfiniteQuery.mockReturnValue({
        data: {
          pages: [{ data: [] }],
        },
        isLoading: false,
        isFetching: false,
        error: null,
      } as any);

      const Wrapper = createWrapper();
      render(
        <Wrapper>
          <AgentGrid
            category="all"
            searchQuery=""
            onSelectAgent={jest.fn()}
            scrollElementRef={React.createRef<HTMLElement>()}
          />
        </Wrapper>,
      );

      // Check empty state accessibility
      const emptyState = screen.getByRole('status');
      expect(emptyState).toHaveAttribute('aria-live', 'polite');
      expect(emptyState).toHaveAttribute('aria-label', 'No agents found');
    });
  });

  describe('ErrorDisplay Accessibility', () => {
    const mockError = {
      response: {
        data: {
          userMessage: 'Unable to load agents. Please try refreshing the page.',
          suggestion: 'Try refreshing the page or check your network connection',
        },
      },
    };

    it('implements proper alert role and ARIA attributes', () => {
      render(<ErrorDisplay error={mockError} onRetry={jest.fn()} />);

      // Check alert role
      const alert = screen.getByRole('alert');
      expect(alert).toHaveAttribute('aria-atomic', 'true');

      // Check heading structure
      const heading = screen.getByRole('heading', { level: 3 });
      expect(alert).toContainElement(heading);
    });

    it('points the retry button at the failure it would retry', () => {
      const onRetry = jest.fn();
      render(<ErrorDisplay error={mockError} onRetry={onRetry} />);

      const retryButton = screen.getByRole('button', { name: 'Try Again' });
      const describedBy = retryButton.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      expect(document.getElementById(describedBy as string)).toHaveTextContent(
        /unable to load agents/i,
      );

      fireEvent.click(retryButton);
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('structures error content with proper semantics', () => {
      render(<ErrorDisplay error={mockError} />);

      // The message is announced with the alert, not left outside it
      expect(screen.getByRole('alert')).toContainElement(
        screen.getByText(/unable to load agents/i),
      );
    });
  });

  describe('Focus Management', () => {
    it('provides visible focus indicators on interactive elements', () => {
      render(
        <CategoryTabs
          categories={[{ value: 'test', label: 'Test', count: 1 }]}
          activeTab="test"
          isLoading={false}
          onChange={jest.fn()}
        />,
      );

      const tab = screen.getByRole('tab');
      // Check that the tab has proper ARIA attributes for accessibility
      expect(tab).toHaveAttribute('aria-selected', 'true');
      expect(tab).toHaveAttribute('tabIndex', '0');
      // Check that tab has proper role and can receive focus
      expect(tab).toHaveAttribute('role', 'tab');
    });
  });

  describe('Screen Reader Announcements', () => {
    it('includes live regions for dynamic content', () => {
      const Wrapper = createWrapper();
      render(
        <Wrapper>
          <AgentGrid
            category="all"
            searchQuery=""
            onSelectAgent={jest.fn()}
            scrollElementRef={React.createRef<HTMLElement>()}
          />
        </Wrapper>,
      );

      // Check for live region
      const liveRegion = document.querySelector('[aria-live="polite"]');
      expect(liveRegion).toBeInTheDocument();
    });

    it('provides screen reader only content', () => {
      render(<SearchBar value="" onSearch={jest.fn()} />);

      // Check for screen reader only instructions
      const srOnlyElement = document.querySelector('.sr-only');
      expect(srOnlyElement).toBeInTheDocument();
    });
  });
});
