import React from 'react';
import userEvent from '@testing-library/user-event';
import { FEEDBACK_REASON_KEYS } from 'librechat-data-provider';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  TInsightsDailyPoint,
  TInsightsParams,
  TInsightsResponse,
} from 'librechat-data-provider';
import InsightsView from '../InsightsView';

const insightsData: TInsightsResponse = {
  agents: [
    { id: 'agent-1', name: 'Alpha' },
    { id: 'agent-2', name: 'Beta' },
    { id: 'agent-3', name: 'Gamma' },
  ],
  summary: {
    totalConversations: 4,
    totalUsers: 2,
    totalMessages: 8,
    totalTokens: 100,
    totalResponses: 4,
    completedResponses: 3,
    failedResponses: 1,
    interruptedResponses: 0,
    lastUsed: '2026-10-01T12:00:00.000Z',
    spendUSD: null,
    feedback: {
      thumbsUp: 0,
      thumbsDown: 0,
      categories: FEEDBACK_REASON_KEYS.map((key) => ({ key, count: 0 })),
    },
  },
  daily: [],
  latest: { conversations: [], page: 1, pageSize: 10, pages: 1 },
  topUsers: [],
  churnedUsers: [],
};

const mockUseInsightsQuery = jest.fn(
  (params: TInsightsParams, _options?: { enabled?: boolean; retry?: boolean }) => ({
    data: insightsData,
    isLoading: false,
    isFetching: false,
    error: null,
    params,
  }),
);
const mockStartupConfig = jest.fn(() => ({
  data: { insightsEnabled: true },
  isLoading: false,
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => mockStartupConfig(),
  useInsightsQuery: (params: TInsightsParams, options?: { enabled?: boolean; retry?: boolean }) =>
    mockUseInsightsQuery(params, options),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, options?: { count?: number; name?: string; label?: string }) => {
    if (options?.count != null) {
      return `${key}:${options.count}`;
    }
    if (options?.name) return `${key}:${options.name}`;
    if (options?.label) return `${key}:${options.label}`;
    return key;
  },
  useAuthContext: () => ({ user: { id: 'user-1' } }),
  useDocumentTitle: () => undefined,
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { language: 'en', resolvedLanguage: 'en' } }),
}));

jest.mock('~/components/Chat/Menus/OpenSidebar', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('~/components/ui', () => ({
  LocalizedDateRangePicker: () => null,
}));

function lastQueryParams(): TInsightsParams {
  return mockUseInsightsQuery.mock.calls[mockUseInsightsQuery.mock.calls.length - 1][0];
}

function renderView() {
  return render(
    <MemoryRouter initialEntries={['/insights']}>
      <InsightsView />
    </MemoryRouter>,
  );
}

function metricCard(title: string) {
  const card = screen.getByRole('heading', { name: title }).closest('section');
  if (!card) throw new Error(`Missing metric card: ${title}`);
  return within(card);
}

function dailyPoint(date: string, spendUSD: number | null): TInsightsDailyPoint {
  return {
    date,
    conversations: 1,
    users: 1,
    messages: 3,
    totalTokens: 50,
    responses: 2,
    completedResponses: 1,
    failedResponses: 1,
    interruptedResponses: 0,
    feedback: insightsData.summary.feedback,
    spendUSD,
  };
}

async function openAgentMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByText('com_insights_all_agents:3'));
  await screen.findByRole('option', { name: 'Alpha' });
}

describe('InsightsView agent selection', () => {
  beforeEach(() => {
    mockStartupConfig.mockReturnValue({ data: { insightsEnabled: true }, isLoading: false });
    mockUseInsightsQuery.mockClear();
    mockUseInsightsQuery.mockImplementation((params) => ({
      data: insightsData,
      isLoading: false,
      isFetching: false,
      error: null,
      params,
    }));
  });

  it('redirects a direct visit and disables statistics loading when startup disables Insights', () => {
    mockStartupConfig.mockReturnValue({ data: { insightsEnabled: false }, isLoading: false });
    render(
      <MemoryRouter initialEntries={['/insights']}>
        <Routes>
          <Route path="/insights" element={<InsightsView />} />
          <Route path="/c/new" element={<div data-testid="chat-destination" />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByTestId('chat-destination')).toBeInTheDocument();
    expect(mockUseInsightsQuery).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ enabled: false }),
    );
  });

  it('renders an aggregate-only response without detail tables or identity search', () => {
    mockUseInsightsQuery.mockImplementation((params) => ({
      data: {
        agents: insightsData.agents,
        summary: insightsData.summary,
        daily: insightsData.daily,
      },
      isLoading: false,
      isFetching: false,
      error: null,
      params,
    }));
    renderView();
    expect(screen.getByText('com_insights_total_conversations')).toBeInTheDocument();
    expect(screen.queryByText('com_insights_top_users')).not.toBeInTheDocument();
    expect(screen.queryByText('com_insights_churned_users')).not.toBeInTheDocument();
    expect(screen.queryByText('com_insights_latest_conversations')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('textbox', { name: 'com_insights_search_placeholder' }),
    ).not.toBeInTheDocument();
  });

  it('shows the aggregate response, outcome, feedback and period-activity fields', () => {
    const categoryCounts = new Map([
      ['inaccurate', 2],
      ['clear_well_written', 3],
    ]);
    mockUseInsightsQuery.mockImplementation((params) => ({
      data: {
        agents: insightsData.agents,
        summary: {
          ...insightsData.summary,
          feedback: {
            thumbsUp: 5,
            thumbsDown: 2,
            categories: FEEDBACK_REASON_KEYS.map((key) => ({
              key,
              count: categoryCounts.get(key) ?? 0,
            })),
          },
        },
        daily: [dailyPoint('2026-10-01', null), dailyPoint('2026-10-02', null)],
      },
      isLoading: false,
      isFetching: false,
      error: null,
      params,
    }));

    renderView();

    expect(metricCard('com_insights_responses').getByText('4')).toBeInTheDocument();
    expect(metricCard('com_insights_completed').getByText('3')).toBeInTheDocument();
    expect(metricCard('com_insights_failed').getByText('1')).toBeInTheDocument();
    expect(metricCard('com_insights_interrupted').getByText('0')).toBeInTheDocument();
    expect(metricCard('com_insights_thumbs_up').getByText('5')).toBeInTheDocument();
    expect(metricCard('com_insights_thumbs_down').getByText('2')).toBeInTheDocument();
    expect(screen.getByText('com_ui_feedback_tag_inaccurate').nextElementSibling).toHaveTextContent(
      '2',
    );
    expect(
      screen.getByText('com_ui_feedback_tag_clear_well_written').nextElementSibling,
    ).toHaveTextContent('3');
    expect(screen.queryByText('com_ui_feedback_tag_other')).not.toBeInTheDocument();
    expect(screen.getByText('com_insights_last_used').querySelector('time')).toHaveAttribute(
      'datetime',
      insightsData.summary.lastUsed,
    );

    const responseTrend = metricCard('com_insights_responses').getByRole('img');
    fireEvent.focus(responseTrend);
    expect(within(responseTrend).getByText('2')).toBeInTheDocument();
    expect(screen.queryByText('com_insights_latest_conversations')).not.toBeInTheDocument();
  });

  it.each([
    [null, 'com_insights_unavailable'],
    [0, '$0.00'],
    [0.0045, '$0.0045'],
    [0.0000000012, '$0.0000000012'],
  ])('distinguishes unavailable, zero and small recorded spend: %s', (spendUSD, expected) => {
    mockUseInsightsQuery.mockImplementation((params) => ({
      data: { ...insightsData, summary: { ...insightsData.summary, spendUSD } },
      isLoading: false,
      isFetching: false,
      error: null,
      params,
    }));

    renderView();

    expect(metricCard('com_insights_spend').getByText(expected)).toBeInTheDocument();
  });

  it('shows missing period activity and categorized feedback without inventing values', () => {
    mockUseInsightsQuery.mockImplementation((params) => ({
      data: { ...insightsData, summary: { ...insightsData.summary, lastUsed: null } },
      isLoading: false,
      isFetching: false,
      error: null,
      params,
    }));

    renderView();

    expect(screen.getByText('com_insights_no_activity')).toBeInTheDocument();
    expect(screen.getByText('com_insights_no_feedback_categories')).toBeInTheDocument();
    expect(metricCard('com_insights_thumbs_up').getByText('0')).toBeInTheDocument();
    expect(metricCard('com_insights_thumbs_down').getByText('0')).toBeInTheDocument();
  });

  it('leaves gaps in the spend trend and labels unavailable days instead of showing zero', () => {
    const spend = [0.0001, 0.0002, null, 0.0003, 0.0004, null];
    mockUseInsightsQuery.mockImplementation((params) => ({
      data: {
        ...insightsData,
        summary: { ...insightsData.summary, spendUSD: 0.001 },
        daily: spend.map((value, index) => dailyPoint(`2026-10-0${index + 1}`, value)),
      },
      isLoading: false,
      isFetching: false,
      error: null,
      params,
    }));

    renderView();

    const trend = metricCard('com_insights_spend').getByRole('img');
    expect(trend.querySelectorAll('polyline')).toHaveLength(2);
    const firstSegment = trend.querySelector('polyline');
    const heights = firstSegment
      ?.getAttribute('points')
      ?.split(' ')
      .map((point) => Number(point.split(',')[1]));
    expect(heights).toHaveLength(2);
    expect(Math.abs((heights?.[0] ?? 0) - (heights?.[1] ?? 0))).toBeGreaterThan(1);
    fireEvent.focus(trend);
    expect(within(trend).getByText('com_insights_unavailable')).toBeInTheDocument();
    expect(within(trend).queryByText('$0.00')).not.toBeInTheDocument();
  });

  it('filters names without changing selection and clears search on close', async () => {
    mockUseInsightsQuery.mockImplementation((params) => ({
      data: {
        ...insightsData,
        agents: Array.from({ length: 12 }, (_, i) => ({ id: `agent-${i}`, name: `Agent ${i}` })),
      },
      isLoading: false,
      isFetching: false,
      error: null,
      params,
    }));
    const user = userEvent.setup();
    renderView();
    await user.click(screen.getByText('com_insights_all_agents:12'));
    const search = screen.getByRole('textbox', { name: 'com_insights_search_agents' });
    await user.type(search, 'AGENT 11');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(lastQueryParams().agentIds).toBeUndefined();
    await user.click(screen.getByRole('button', { name: 'com_ui_clear_all' }));
    await user.click(screen.getByRole('button', { name: 'com_insights_select_all_agents' }));
    expect(screen.getByText('com_insights_all_agents:12')).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, 'no match');
    expect(screen.getByRole('status')).toHaveTextContent('com_insights_no_agents_found');
    await user.keyboard('{Escape}');
    await user.click(screen.getByText('com_insights_all_agents:12'));
    expect(screen.getByRole('textbox', { name: 'com_insights_search_agents' })).toHaveValue('');
    expect(screen.getAllByRole('option')).toHaveLength(12);
  });

  it('clears every agent without committing the empty selection', async () => {
    const user = userEvent.setup();
    renderView();
    await openAgentMenu(user);

    await user.click(screen.getByRole('button', { name: 'com_ui_clear_all' }));

    expect(screen.getByText('com_insights_no_agents_selected')).toBeInTheDocument();
    for (const option of screen.getAllByRole('option')) {
      expect(option).toHaveAttribute('aria-selected', 'false');
    }
    expect(lastQueryParams().agentIds).toBeUndefined();
  });

  it('commits only the agents picked after clearing', async () => {
    const user = userEvent.setup();
    renderView();
    await openAgentMenu(user);

    await user.click(screen.getByRole('button', { name: 'com_ui_clear_all' }));
    await user.click(screen.getByRole('option', { name: 'Beta' }));

    await waitFor(() => expect(lastQueryParams().agentIds).toEqual(['agent-2']));
  });

  it('restores the committed selection when the menu closes while empty', async () => {
    const user = userEvent.setup();
    renderView();
    await openAgentMenu(user);

    await user.click(screen.getByRole('button', { name: 'com_ui_clear_all' }));
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.getByText('com_insights_all_agents:3')).toBeInTheDocument());
    expect(lastQueryParams().agentIds).toBeUndefined();
  });

  it('re-enables select all from the cleared state', async () => {
    const user = userEvent.setup();
    renderView();
    await openAgentMenu(user);

    await user.click(screen.getByRole('button', { name: 'com_ui_clear_all' }));
    const selectAll = screen.getByRole('button', { name: 'com_insights_select_all_agents' });

    await user.click(selectAll);
    expect(screen.getByText('com_insights_all_agents:3')).toBeInTheDocument();
    expect(lastQueryParams().agentIds).toBeUndefined();
  });
});
