import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { dataService, EModelEndpoint } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import type t from 'librechat-data-provider';
import Marketplace from '../Marketplace';

const mockCategories = [
  { value: 'promoted', label: 'com_agents_top_picks' },
  { value: 'all', label: 'com_agents_all' },
  { value: 'productivity', label: 'Productivity', description: 'Get things done' },
];

const mockLocalize = jest.fn((key: string, options?: { count?: number; category?: string }) => {
  const translations: Record<string, string> = {
    com_ui_back: 'Back',
    com_ui_forward: 'Forward',
    com_nav_toggle_nav: 'Open sidebar',
    com_agents_marketplace: 'Agent Marketplace',
    com_agents_filter_mine: 'Only Agents I created',
    com_agents_my_agents: 'My agents',
    com_agents_sort_label: 'Sort by',
    com_agents_sort_newest: 'Newest first',
    com_agents_sort_oldest: 'Oldest first',
    com_agents_sort_popular: 'Popular',
    com_agents_sort_author: 'By creator name',
    com_agents_top_picks: 'Top Picks',
    com_agents_recommended: 'Our recommended agents',
    com_agents_all: 'All Agents',
    com_agents_all_category: 'All',
    com_agents_all_description: 'Browse all shared agents across all categories',
    com_agents_category_empty: `No agents found in the ${options?.category ?? ''} category`,
    com_agents_empty_state_heading: 'No agents found',
    com_agents_mine_empty_state_heading: "You haven't created any Agents yet",
    com_agents_search_empty_heading: 'No search results',
    com_agents_grid_announcement: `Showing ${options?.count ?? 0} agents in ${options?.category ?? ''} category`,
    com_agents_category_tabs_label: 'Agent Categories',
    com_agents_category_tab_label: `${options?.category ?? ''} category`,
    com_agents_loading: 'Loading...',
    com_agents_no_more_results: "You've reached the end of the results",
    com_agents_search_aria: 'Search agents',
    com_agents_search_instructions: 'Type to search agents by name or description',
    com_agents_clear_search: 'Clear search',
  };
  return translations[key] || key;
});

let mockHasAccess = true;

jest.mock('~/hooks', () => ({
  useLocalize: () => mockLocalize,
  useDocumentTitle: jest.fn(),
  useHasAccess: jest.fn(() => mockHasAccess),
  useAgentCategories: jest.fn(() => ({ categories: mockCategories })),
  useDebounce: (value: string) => value,
}));

jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: jest.fn(() => ({ data: {} })),
  useGetAgentCategoriesQuery: jest.fn(() => ({ data: mockCategories, isLoading: false })),
}));

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: { ...actual.dataService, getMarketplaceAgents: jest.fn() },
  };
});

jest.mock('~/components/SidePanel', () => ({
  SidePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock('~/components/Chat/Menus/OpenSidebar', () => ({
  __esModule: true,
  default: () => <button type="button">{mockLocalize('com_nav_toggle_nav')}</button>,
}));

jest.mock('../MarketplaceAdminSettings', () => ({
  __esModule: true,
  default: () => <div data-testid="admin-settings" />,
}));

jest.mock('../AgentCard', () => ({
  __esModule: true,
  default: ({ agent }: { agent: t.Agent }) => (
    <button type="button" data-testid={`agent-card-${agent.id}`}>
      {agent.name}
    </button>
  ),
}));

const marketplace = jest.mocked(dataService.getMarketplaceAgents);
const queryClients = new Set<QueryClient>();

const response = (agents: t.Agent[]): t.AgentListResponse => ({
  object: 'list',
  data: agents,
  first_id: agents[0]?.id ?? '',
  last_id: agents.at(-1)?.id ?? '',
  has_more: false,
});

const agent = (id: string, name = id): t.Agent => ({
  id,
  name,
  description: '',
  category: 'productivity',
  created_at: 0,
  avatar: null,
  provider: EModelEndpoint.openAI,
  model: 'gpt-4o-mini',
  model_parameters: {
    temperature: null,
    maxContextTokens: null,
    max_context_tokens: null,
    max_output_tokens: null,
    top_p: null,
    frequency_penalty: null,
    presence_penalty: null,
  },
});

const LocationDisplay = () => {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <div data-testid="location">{`${location.pathname}${location.search}`}</div>
      <button onClick={() => navigate(-1)}>{mockLocalize('com_ui_back')}</button>
      <button onClick={() => navigate(1)}>{mockLocalize('com_ui_forward')}</button>
    </>
  );
};

const renderMarketplace = (
  initialEntry = '/agents/productivity',
  agents: t.Agent[] = [agent('one')],
) => {
  marketplace.mockResolvedValue(response(agents));

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClients.add(queryClient);
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <LocationDisplay />
        <Routes>
          <Route path="/agents" element={<Marketplace />} />
          <Route path="/agents/:category" element={<Marketplace />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

const currentUrl = () => screen.getByTestId('location').textContent;

describe('Marketplace controls and agent results', () => {
  beforeEach(() => {
    mockHasAccess = true;
    marketplace.mockReset();
  });

  afterEach(() => {
    for (const queryClient of queryClients) {
      queryClient.clear();
    }
    queryClients.clear();
  });

  it('shows the newly sorted results after changing the sort control', async () => {
    const first = agent('one', 'Alpha');
    const second = agent('two', 'Beta');
    renderMarketplace('/agents/productivity?mine=1', [first, second]);
    await screen.findByRole('list');
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Alpha',
      'Beta',
    ]);

    marketplace.mockResolvedValue(response([second, first]));
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: 'Popular' }));

    await waitFor(() =>
      expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
        'Beta',
        'Alpha',
      ]),
    );
  });

  it('preserves the selected route when changing sort', async () => {
    renderMarketplace('/agents/all?q=invoice');

    fireEvent.click(screen.getByTestId('agent-sort-dropdown'));
    fireEvent.click(await screen.findByText('Popular'));

    await waitFor(() => {
      expect(currentUrl()).toBe('/agents/all?q=invoice&sort=popular');
    });
  });
  it('applies rapid category changes immediately without locking the filters', async () => {
    renderMarketplace('/agents/all');
    await screen.findByRole('list');
    fireEvent.click(screen.getByRole('tab', { name: /Productivity/ }));
    expect(screen.getByRole('tab', { name: /Productivity/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    fireEvent.click(screen.getByRole('tab', { name: /^All category/ }));
    expect(currentUrl()).toBe('/agents/all');
    expect(screen.getByRole('tab', { name: /^All category/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await screen.findAllByRole('tabpanel')).toHaveLength(1);
  });

  it('preserves search and mine filters while switching categories', async () => {
    renderMarketplace('/agents/all?q=invoice&mine=1');

    fireEvent.click(screen.getByRole('tab', { name: /Productivity/ }));

    await waitFor(() => {
      expect(currentUrl()).toBe('/agents/productivity?q=invoice&mine=1');
    });
  });

  it('uses the category empty state for mine results outside all', async () => {
    renderMarketplace('/agents/productivity?mine=1', []);

    expect(
      await screen.findByRole('status', { name: 'No agents found in the Productivity category' }),
    ).toBeInTheDocument();
  });

  it('uses the account-wide mine empty state only on all', async () => {
    renderMarketplace('/agents/all?mine=1', []);

    expect(
      await screen.findByRole('status', { name: "You haven't created any Agents yet" }),
    ).toBeInTheDocument();
  });

  it('filters the rendered results when the mine button is toggled', async () => {
    const owned = agent('owned', 'Owned Agent');
    renderMarketplace('/agents/productivity', [owned, agent('other', 'Other Agent')]);
    await screen.findByText('Other Agent');
    marketplace.mockResolvedValue(response([owned]));

    fireEvent.click(screen.getByRole('button', { name: 'My agents' }));
    expect(screen.getByRole('button', { name: 'My agents' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(currentUrl()).toBe('/agents/productivity?mine=1');
    await waitFor(() => {
      expect(screen.queryByText('Other Agent')).not.toBeInTheDocument();
      expect(screen.getByText('Owned Agent')).toBeInTheDocument();
    });
  });

  it('announces search emptiness instead of claiming no owned agents', async () => {
    renderMarketplace('/agents/productivity?q=invoice&mine=1', []);
    const status = await screen.findByRole('status', { name: 'No search results' });
    expect(status).toHaveAccessibleName(status.textContent ?? '');
    expect(screen.queryByText("You haven't created any Agents yet")).not.toBeInTheDocument();
  });

  it('restores sort and mine state through browser history without dropping search', async () => {
    renderMarketplace('/agents/all?q=invoice');
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: 'Popular' }));
    fireEvent.click(screen.getByRole('button', { name: 'My agents' }));
    expect(currentUrl()).toBe('/agents/all?q=invoice&sort=popular&mine=1');

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('button', { name: 'My agents' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByRole('combobox')).toHaveTextContent('Popular');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('combobox')).toHaveTextContent('Newest first');
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }));
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }));
    expect(screen.getByRole('button', { name: 'My agents' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('combobox')).toHaveTextContent('Popular');
    expect(screen.getByRole('textbox', { name: 'Search agents' })).toHaveValue('invoice');
  });
});
