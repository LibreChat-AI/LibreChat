import React from 'react';
import userEvent from '@testing-library/user-event';
import { FEEDBACK_REASON_KEYS } from 'librechat-data-provider';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  TInsightsAgentVersion,
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
  models: [],
  latest: { conversations: [], page: 1, pageSize: 10, pages: 1 },
  topUsers: [],
  churnedUsers: [],
};

const mockUseInsightsQuery = jest.fn(
  (
    params: TInsightsParams,
    _options?: { enabled?: boolean; retry?: boolean },
  ): {
    data?: TInsightsResponse;
    isLoading: boolean;
    isFetching: boolean;
    isPreviousData?: boolean;
    isError?: boolean;
    error: Error | null;
    params: TInsightsParams;
  } => ({
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
  useLocalize:
    () =>
    (
      key: string,
      options?: {
        count?: number;
        name?: string;
        label?: string;
        versionNumber?: number;
      },
    ) => {
      if (options?.count != null) {
        return `${key}:${options.count}`;
      }
      if (options?.name) return `${key}:${options.name}`;
      if (options?.label) return `${key}:${options.label}`;
      if (options?.versionNumber != null) return `${key}:${options.versionNumber}`;
      return key;
    },
  useAuthContext: () => ({ user: { id: 'user-1' } }),
  useDocumentTitle: () => undefined,
  useElementSize: () => ({ ref: jest.fn(), width: 0, height: 0 }),
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

function queryResult(params: TInsightsParams, data?: TInsightsResponse) {
  return { data, isLoading: false, isFetching: false, error: null, params };
}

function renderView(path = '/insights') {
  return render(
    <MemoryRouter initialEntries={[path]}>
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
  it('opens with no agents selected and lets admins choose All agents explicitly', async () => {
    mockUseInsightsQuery.mockImplementation((params) =>
      queryResult(params, {
        ...insightsData,
        selectionRequired: !params.agentIds?.length && !params.allAgents,
      }),
    );
    const user = userEvent.setup();
    renderView();
    expect(screen.getByText('com_insights_select_agents_to_load')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'com_insights_models' })).not.toBeInTheDocument();
    await user.click(screen.getByText('com_insights_no_agents_selected'));
    const allAgents = screen.getByRole('button', { name: 'com_insights_select_all_agents' });
    expect(allAgents).toBeEnabled();
    await user.click(allAgents);
    await waitFor(() => expect(lastQueryParams().allAgents).toBe(true));
    expect(lastQueryParams().agentIds).toBeUndefined();
    expect(screen.getByRole('combobox', { hidden: true })).toHaveTextContent(
      'com_insights_all_agents:3',
    );
    expect(screen.queryByText('com_insights_select_agents_to_load')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('lets admins reach every agent one by one when automatic selection is off', async () => {
    mockUseInsightsQuery.mockImplementation((params) =>
      queryResult(params, {
        ...insightsData,
        selectionRequired: !params.agentIds?.length && !params.allAgents,
      }),
    );
    const user = userEvent.setup();
    renderView();
    await user.click(screen.getByText('com_insights_no_agents_selected'));
    for (const name of ['Alpha', 'Beta', 'Gamma']) {
      await user.click(screen.getByRole('option', { name }));
    }
    await waitFor(() => expect(lastQueryParams().allAgents).toBe(true));
    expect(screen.getByRole('option', { name: 'Gamma' })).toHaveAttribute('aria-selected', 'true');
  });

  it('lets an administrator explicitly select their only available agent', async () => {
    mockUseInsightsQuery.mockImplementation((params) =>
      queryResult(params, {
        ...insightsData,
        agents: [insightsData.agents[0]],
        selectionRequired: !params.agentIds?.length && !params.allAgents,
      }),
    );
    const user = userEvent.setup();
    renderView();
    await user.click(screen.getByText('com_insights_no_agents_selected'));
    await user.click(await screen.findByRole('option', { name: 'Alpha' }));
    await waitFor(() => expect(lastQueryParams().agentIds).toEqual(['agent-1']));
    expect(screen.getByRole('combobox', { hidden: true })).toHaveTextContent('Alpha');
  });

  it('recovers agent filters the server rejects without showing them as selected', async () => {
    mockUseInsightsQuery.mockImplementation((params) => {
      if (params.agentIds?.length === insightsData.agents.length) {
        return {
          ...queryResult(params),
          isError: true,
          error: Object.assign(new Error('Forbidden'), { response: { status: 403 } }),
        };
      }
      return queryResult(params, { ...insightsData, selectionRequired: true });
    });
    renderView('/insights?agentIds=agent-1&agentIds=agent-2&agentIds=agent-3');
    await waitFor(() => expect(lastQueryParams().agentIds).toBeUndefined());
    expect(screen.getByText('com_insights_no_agents_selected')).toBeInTheDocument();
    expect(screen.getByText('com_insights_select_agents_to_load')).toBeInTheDocument();
  });

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

  it('keeps agent choices available but hides previous statistics while a new selection loads', () => {
    mockUseInsightsQuery.mockImplementation((params) => ({
      ...queryResult(params, insightsData),
      isFetching: true,
      isPreviousData: true,
    }));
    renderView('/insights?agentIds=agent-2');
    expect(lastQueryParams().agentIds).toEqual(['agent-2']);
    expect(screen.getByRole('combobox')).toHaveTextContent('Beta');
    expect(screen.getByText('com_insights_loading')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'com_insights_models' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'com_insights_total_messages' }),
    ).not.toBeInTheDocument();
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
    mockUseInsightsQuery.mockImplementation((params) =>
      queryResult(params, {
        agents: insightsData.agents,
        summary: insightsData.summary,
        daily: insightsData.daily,
        models: insightsData.models,
      }),
    );
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
    mockUseInsightsQuery.mockImplementation((params) =>
      queryResult(params, {
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
        models: [],
      }),
    );

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
    [null, '$0.00'],
    [0.0000000012, '$0.0000000012'],
  ])('shows missing spend as zero and preserves small recorded spend: %s', (spendUSD, expected) => {
    mockUseInsightsQuery.mockImplementation((params) =>
      queryResult(params, { ...insightsData, summary: { ...insightsData.summary, spendUSD } }),
    );

    renderView();

    expect(metricCard('com_insights_spend').getByText(expected)).toBeInTheDocument();
  });

  it('shows missing period activity and categorized feedback without inventing values', () => {
    mockUseInsightsQuery.mockImplementation((params) =>
      queryResult(params, {
        ...insightsData,
        summary: { ...insightsData.summary, lastUsed: null },
      }),
    );

    renderView();

    expect(screen.getByText('com_insights_no_activity')).toBeInTheDocument();
    expect(screen.getByText('com_insights_no_feedback_categories')).toBeInTheDocument();
    expect(metricCard('com_insights_thumbs_up').getByText('0')).toBeInTheDocument();
    expect(metricCard('com_insights_thumbs_down').getByText('0')).toBeInTheDocument();
  });

  it('lists recorded models, an unknown-model row and missing spend as zero', () => {
    const counts = {
      completedResponses: 0,
      failedResponses: 0,
      interruptedResponses: 0,
      thumbsUp: 0,
      thumbsDown: 0,
    };
    mockUseInsightsQuery.mockImplementation((params) =>
      queryResult(params, {
        ...insightsData,
        models: [
          {
            ...counts,
            model: 'gpt-4.1',
            responses: 3,
            completedResponses: 2,
            failedResponses: 1,
            thumbsUp: 1,
            usageTokens: 1234,
            spendUSD: 0.5,
          },
          { ...counts, model: 'title-model', responses: 0, usageTokens: 20, spendUSD: 0.01 },
          {
            ...counts,
            model: null,
            responses: 1,
            interruptedResponses: 1,
            thumbsDown: 1,
            usageTokens: 0,
            spendUSD: null,
          },
        ],
      }),
    );

    renderView();

    const panel = metricCard('com_insights_models');
    expect(panel.getByText('com_insights_models_definition')).toBeInTheDocument();
    expect(panel.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'com_insights_model',
      'com_insights_responses',
      'com_insights_completed',
      'com_insights_failed',
      'com_insights_interrupted',
      'com_insights_thumbs_up',
      'com_insights_thumbs_down',
      'com_insights_usage_tokens',
      'com_insights_spend',
    ]);
    const rows = panel
      .getAllByRole('row')
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole('cell')
          .map((cell) => cell.textContent),
      );
    expect(rows).toEqual([
      ['gpt-4.1', '3', '2', '1', '0', '1', '0', '1,234', '$0.50'],
      ['title-model', '0', '0', '0', '0', '0', '0', '20', '$0.01'],
      ['com_insights_unknown_model', '1', '0', '0', '1', '0', '1', '0', '$0.00'],
    ]);
  });

  it('shows an empty models panel when no usage or responses were recorded', () => {
    renderView();

    const panel = metricCard('com_insights_models');
    expect(panel.getByText('com_insights_no_data')).toBeInTheDocument();
    expect(panel.queryByRole('table')).not.toBeInTheDocument();
  });

  const versionedData = (agentVersions: TInsightsAgentVersion[]) => ({
    ...insightsData,
    daily: ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'].map((date) =>
      dailyPoint(date, 0.1),
    ),
    agentVersions,
  });

  it('marks saved agent versions on every trend chart for one selected agent', () => {
    mockUseInsightsQuery.mockImplementation((params) =>
      queryResult(
        params,
        versionedData([
          { agentId: 'agent-1', version: 1, savedAt: '2026-09-01T12:00:00.000Z', active: false },
          { agentId: 'agent-1', version: 2, savedAt: '2026-10-03T12:00:00.000Z', active: true },
          { agentId: 'agent-1', version: 3, savedAt: null, active: false },
        ]),
      ),
    );
    renderView('/insights?agentIds=agent-1');

    for (const title of ['com_insights_messages', 'com_insights_spend', 'com_insights_failed']) {
      const trend = metricCard(title).getByRole('img');
      expect(within(trend).getAllByTestId('insights-version-marker')).toHaveLength(1);
      expect(trend).toHaveAccessibleName(
        expect.stringContaining('com_insights_version_saved_marker:2'),
      );
    }
    const trend = metricCard('com_insights_messages').getByRole('img');
    expect(within(trend).getByText('com_insights_version_tag:2')).toBeVisible();
    fireEvent.focus(trend);
    expect(within(trend).getByText('com_ui_agent_version_title:2')).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'com_insights_agent_versions' }),
    ).not.toBeInTheDocument();
  });

  it('does not mark versions when several agents are selected', () => {
    mockUseInsightsQuery.mockImplementation((params) =>
      queryResult(
        params,
        versionedData([
          { agentId: 'agent-1', version: 1, savedAt: '2026-10-02T12:00:00.000Z', active: true },
          { agentId: 'agent-2', version: 1, savedAt: '2026-10-03T12:00:00.000Z', active: true },
        ]),
      ),
    );
    renderView('/insights?agentIds=agent-1&agentIds=agent-2');
    const trend = metricCard('com_insights_messages').getByRole('img');
    expect(within(trend).queryByTestId('insights-version-marker')).not.toBeInTheDocument();
    expect(within(trend).queryByText(/com_insights_version_tag/)).not.toBeInTheDocument();
    fireEvent.focus(trend);
    expect(within(trend).queryByText(/com_ui_agent_version_title/)).not.toBeInTheDocument();
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
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-setsize', '12');
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
