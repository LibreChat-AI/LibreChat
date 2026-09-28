import React from 'react';
import { Provider } from 'jotai';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ContentTypes, QueryKeys, dataService } from 'librechat-data-provider';
import { act, render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import type {
  TMessage,
  TAgentsMap,
  TTracePage,
  TTraceRecord,
  TStartupConfig,
} from 'librechat-data-provider';
import { keepNewestTracePage } from '~/data-provider/Traces/queries';
import { AgentsMapContext } from '~/Providers/AgentsMapContext';
import Viewer from '../Viewer';

jest.mock('librechat-data-provider', () => {
  const actual =
    jest.requireActual<typeof import('librechat-data-provider')>('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService } };
});

type MockStartupConfig = Omit<Partial<TStartupConfig>, 'interface'> & {
  interface?: Partial<NonNullable<TStartupConfig['interface']>>;
};

let mockStartupConfig: MockStartupConfig = {};

jest.mock('~/data-provider/Endpoints/queries', () => ({
  useGetStartupConfig: () => ({ data: mockStartupConfig }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, options?: Record<string, string | number>) =>
    options ? `${key} ${Object.values(options).join(' ')}` : key,
}));

const BASE = Date.UTC(2026, 8, 12, 11, 30, 0);
const at = (offsetMs: number) => new Date(BASE + offsetMs).toISOString();

function record(overrides: Partial<TTraceRecord> & Pick<TTraceRecord, 'id'>): TTraceRecord {
  return {
    traceId: 'trace-1',
    messageId: 'response-1',
    parentId: null,
    kind: 'span',
    name: overrides.id,
    startTime: at(0),
    endTime: at(1000),
    status: 'ok',
    ...overrides,
  };
}

const records: TTraceRecord[] = [
  record({ id: 'root', kind: 'agent', name: 'AgentGraph', startTime: at(0), endTime: at(4000) }),
  record({
    id: 'llm',
    parentId: 'root',
    kind: 'generation',
    name: 'llm',
    model: 'gpt-5',
    startTime: at(100),
    endTime: at(2100),
    completionStartTime: at(600),
    usage: { input: 1200, output: 300, total: 1500 },
    cost: 0.02,
  }),
  record({
    id: 'tool',
    parentId: 'root',
    kind: 'tool',
    name: 'web_search',
    status: 'error',
    statusMessage: 'Error: search backend unavailable',
    startTime: at(2200),
    endTime: at(3000),
  }),
];

/** The chat's copy of the response: what the model wrote and asked for, which the ledger previews. */
const responseMessage = {
  messageId: 'response-1',
  conversationId: 'convo-1',
  parentMessageId: 'user-1',
  isCreatedByUser: false,
  text: '',
  content: [
    { type: ContentTypes.TEXT, text: 'Let me look that up.' },
    { type: ContentTypes.TOOL_CALL, tool_call: { name: 'web_search', args: { query: 'weather' } } },
  ],
} as unknown as TMessage;

function axiosError(status: number, errorCode: string) {
  return Object.assign(new Error(errorCode), {
    isAxiosError: true,
    response: { status, data: { error: errorCode, errorCode } },
  });
}

function renderViewer(onClose = jest.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
    logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
  });
  const utils = render(
    <Provider>
      <QueryClientProvider client={client}>
        <Viewer conversationId="convo-1" onClose={onClose} />
      </QueryClientProvider>
    </Provider>,
  );
  return { ...utils, onClose, client };
}

const treeItem = (name: RegExp) => screen.findByRole('treeitem', { name });
/** A record row's accessible name; step and turn rows are named by their own labels. */
const recordName = (name: string) => new RegExp(`^com_ui_trace_bar_description ${name}`);
const recordRow = (name: string) => treeItem(recordName(name));
const stepRow = (index: number) =>
  screen.getByRole('treeitem', { name: new RegExp(`^com_ui_trace_step ${index},`) });
const toggle = (name: string) => screen.getByRole('button', { name });

describe('Trace Viewer', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockStartupConfig = { interface: { traceViewer: { enabled: true } } };
    jest
      .spyOn(dataService, 'getConversationTraceRecords')
      .mockResolvedValue({ records, sourceId: 'tenant-project' } satisfies TTracePage);
    jest.spyOn(dataService, 'getConversationTraceRecord').mockResolvedValue({
      record: records[1],
      contentAvailable: true,
      input: { value: '{"messages":[{"role":"user","content":"hi"}]}', truncated: false },
      output: { value: 'partial outp', truncated: true },
    });
    jest.spyOn(dataService, 'getLangfuseSessionLink').mockResolvedValue({
      url: 'https://langfuse.test/project/p/sessions/convo-1',
      destinationId: 'tenant-project',
    });
    jest.spyOn(dataService, 'getMessagesByConvoId').mockResolvedValue([]);
  });

  it('shows a loading state, then the summary, overview and the response grouped into steps', async () => {
    renderViewer();

    expect(screen.getByRole('status')).toHaveTextContent('com_ui_trace_loading');
    expect(await recordRow('llm')).toHaveAttribute('aria-level', '3');
    expect(
      screen.getByRole('treeitem', {
        name: recordName('com_ui_tool_name_web_search.*com_ui_trace_status_error'),
      }),
    ).toBeInTheDocument();
    const turn = screen.getByRole('treeitem', { name: /^com_ui_trace_turn/ });
    expect(turn).toHaveAttribute('aria-level', '1');
    expect(turn).toHaveAccessibleName(/com_ui_trace_model_calls_count_one 1/);
    expect(turn).toHaveAccessibleName(/com_ui_trace_tool_calls_count_one 1/);
    expect(stepRow(1)).toHaveAttribute('aria-level', '2');
    expect(stepRow(1)).toHaveAccessibleName(/com_ui_tool_name_web_search/);
    expect(
      screen.queryByRole('treeitem', { name: recordName('AgentGraph') }),
    ).not.toBeInTheDocument();

    const summary = screen.getByLabelText('com_ui_trace_summary');
    expect(
      within(summary).getByText('com_ui_trace_summary_generations').nextSibling,
    ).toHaveTextContent('1');
    expect(within(summary).getByText('com_ui_trace_summary_errors').nextSibling).toHaveTextContent(
      '1',
    );
    expect(within(summary).queryByText('com_ui_trace_summary_cost')).not.toBeInTheDocument();
    expect(screen.getByTestId('trace-overview')).toHaveAttribute('data-scale', 'sequence');
    expect(dataService.getConversationTraceRecords).toHaveBeenCalledWith(
      { conversationId: 'convo-1', cursor: undefined },
      expect.any(AbortSignal),
    );
  });

  it('shows every recorded span when asked, and lists the model calls and tools otherwise', async () => {
    renderViewer();
    await recordRow('llm');

    await userEvent.click(toggle('com_ui_trace_all_spans'));

    expect(toggle('com_ui_trace_all_spans')).toHaveAttribute('aria-pressed', 'true');
    expect(await recordRow('AgentGraph')).toHaveAttribute('aria-level', '2');
    expect(screen.getByRole('treeitem', { name: recordName('llm') })).toHaveAttribute(
      'aria-level',
      '3',
    );
    expect(screen.queryByRole('treeitem', { name: /^com_ui_trace_step/ })).not.toBeInTheDocument();

    await userEvent.click(toggle('com_ui_trace_all_spans'));

    await waitFor(() =>
      expect(
        screen.queryByRole('treeitem', { name: recordName('AgentGraph') }),
      ).not.toBeInTheDocument(),
    );
    expect(stepRow(1)).toBeInTheDocument();
  });

  it('clears a selection the simple mode no longer lists', async () => {
    renderViewer();
    await recordRow('llm');
    await userEvent.click(toggle('com_ui_trace_all_spans'));
    await userEvent.click(await recordRow('AgentGraph'));
    expect(screen.getByTestId('trace-inspector')).toBeInTheDocument();

    await userEvent.click(toggle('com_ui_trace_all_spans'));

    await waitFor(() => expect(screen.queryByTestId('trace-inspector')).not.toBeInTheDocument());
  });

  it('keeps a focused record range on the same records when an older page renumbers them', async () => {
    const newest = ['a', 'b', 'c'].map((suffix, index) =>
      record({
        id: `later-${suffix}`,
        messageId: 'response-2',
        traceId: 'trace-2',
        name: `later-${suffix}`,
        kind: 'generation',
        startTime: at(10_000 + index * 1000),
        endTime: at(10_500 + index * 1000),
      }),
    );
    jest
      .spyOn(dataService, 'getConversationTraceRecords')
      .mockImplementation(async ({ cursor }) =>
        cursor == null ? { records: newest, nextCursor: 'older' } : { records },
      );
    renderViewer();
    await recordRow('later-b');
    const overview = screen.getByTestId('trace-overview');
    fireEvent.keyDown(overview, { key: '+' });
    fireEvent.keyDown(overview, { key: '+' });
    await waitFor(() =>
      expect(
        screen.queryByRole('treeitem', { name: recordName('later-a') }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText('com_ui_trace_selection_records 2 2')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'com_ui_trace_load_older' }));

    expect(await screen.findByText('com_ui_trace_selection_records 4 4')).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: recordName('later-b') })).toBeInTheDocument();
    expect(screen.queryByRole('treeitem', { name: recordName('llm') })).not.toBeInTheDocument();
    expect(screen.queryByRole('treeitem', { name: recordName('later-a') })).not.toBeInTheDocument();
  });

  it('previews a response split across pages from its end, then its earlier steps as they load', async () => {
    const generation = (id: string, offset: number) =>
      record({
        id,
        messageId: 'response-2',
        traceId: 'trace-2',
        parentId: 'wrapper-the-limit-cut',
        name: id,
        kind: 'generation',
        startTime: at(offset),
        endTime: at(offset + 500),
      });
    jest
      .spyOn(dataService, 'getConversationTraceRecords')
      .mockImplementation(async ({ cursor }) =>
        cursor == null
          ? { records: [generation('later-2', 12_000)], nextCursor: 'older' }
          : { records: [generation('later-1', 10_000), ...records] },
      );
    const { client } = renderViewer();
    act(() =>
      client.setQueryData(
        [QueryKeys.messages, 'convo-1'],
        [
          {
            ...responseMessage,
            messageId: 'response-2',
            content: [
              { type: ContentTypes.TEXT, text: 'First round.' },
              { type: ContentTypes.TOOL_CALL, tool_call: { name: 'noop', args: {}, stepId: 's1' } },
              { type: ContentTypes.TEXT, text: 'Second round.' },
            ],
          },
        ],
      ),
    );
    expect(await recordRow('later-2: Second round\\.')).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: /^com_ui_trace_step 2,/ })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'com_ui_trace_load_older' }));

    expect(await recordRow('later-2: Second round\\.')).toBeInTheDocument();
    expect(
      screen.getByRole('treeitem', { name: recordName('later-1: First round\\.') }),
    ).toBeInTheDocument();
  });

  it('previews what a step wrote and what a tool was asked, from the chat message', async () => {
    const { client } = renderViewer();
    await recordRow('llm');

    act(() => client.setQueryData([QueryKeys.messages, 'convo-1'], [responseMessage]));

    expect(await recordRow('llm: Let me look that up\\.')).toBeInTheDocument();
    expect(
      screen.getByRole('treeitem', {
        name: recordName('com_ui_tool_name_web_search: query: weather'),
      }),
    ).toBeInTheDocument();
    expect(dataService.getMessagesByConvoId).not.toHaveBeenCalled();
  });

  it('scales the overview by recorded time on request', async () => {
    renderViewer();
    await recordRow('llm');
    const overview = screen.getByTestId('trace-overview');

    fireEvent.keyDown(overview, { key: '+' });
    expect(screen.getByText(/^com_ui_trace_selection_records/)).toBeInTheDocument();

    await userEvent.click(toggle('com_ui_trace_scale_duration'));

    expect(overview).toHaveAttribute('data-scale', 'time');
    expect(screen.queryByTestId('trace-overview-selection')).not.toBeInTheDocument();
    fireEvent.keyDown(overview, { key: '+' });
    expect(screen.getByText(/^com_ui_trace_selection /)).toBeInTheDocument();
  });

  it('shows cost only when the deployment shows context cost', async () => {
    mockStartupConfig = { interface: { traceViewer: { enabled: true }, contextCost: true } };
    renderViewer();

    const modelCall = await recordRow('llm');
    const summary = screen.getByLabelText('com_ui_trace_summary');
    expect(within(summary).getByText('com_ui_trace_summary_cost').nextSibling).toHaveTextContent(
      '$0.02',
    );
    /** The ledger carries it too: a column, each priced record, and its step and response. */
    const ledger = screen.getByTestId('trace-ledger');
    expect(within(ledger).getByText('com_ui_trace_summary_cost')).toBeInTheDocument();
    expect(within(modelCall).getByText('$0.02')).toBeInTheDocument();
    /** Rows name themselves, so a screen reader hears the cost only if the name carries it. */
    expect(modelCall).toHaveAccessibleName(/com_ui_trace_summary_cost \$0\.02/);
    expect(stepRow(1)).toHaveAccessibleName(/com_ui_trace_summary_cost \$0\.02/);
    expect(within(stepRow(1)).getByText('$0.02')).toBeInTheDocument();
    expect(
      within(screen.getByRole('treeitem', { name: /^com_ui_trace_turn/ })).getByText('$0.02'),
    ).toBeInTheDocument();
  });

  it('shows no cost anywhere while the deployment does not show context cost', async () => {
    renderViewer();

    expect(await recordRow('llm')).not.toHaveAccessibleName(/com_ui_trace_summary_cost/);
    expect(screen.queryByText('com_ui_trace_summary_cost')).not.toBeInTheDocument();
    expect(screen.queryByText('$0.02')).not.toBeInTheDocument();
  });

  it('explains a failure by its error code and recovers on retry', async () => {
    jest
      .spyOn(dataService, 'getConversationTraceRecords')
      .mockRejectedValueOnce(axiosError(501, 'unsupported'));
    renderViewer();

    expect(await screen.findByText('com_ui_trace_error_unsupported')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));

    expect(await recordRow('llm')).toBeInTheDocument();
  });

  it('falls back to a generic message for an unknown failure', async () => {
    jest
      .spyOn(dataService, 'getConversationTraceRecords')
      .mockRejectedValueOnce(new Error('network down'));
    renderViewer();

    expect(await screen.findByText('com_ui_trace_error_generic')).toBeInTheDocument();
  });

  it('shows an empty state that can refresh when no records have arrived yet', async () => {
    const list = jest
      .spyOn(dataService, 'getConversationTraceRecords')
      .mockResolvedValueOnce({ records: [] });
    renderViewer();

    const title = await screen.findByText('com_ui_trace_empty_title');
    const emptyState = title.parentElement as HTMLElement;
    await userEvent.click(within(emptyState).getByRole('button', { name: 'com_ui_trace_refresh' }));

    expect(await recordRow('llm')).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('inspects a record without requesting content the deployment withholds', async () => {
    renderViewer();

    await userEvent.click(await recordRow('llm'));

    const inspector = screen.getByTestId('trace-inspector');
    expect(within(inspector).getByRole('heading', { name: 'llm' })).toBeInTheDocument();
    expect(within(inspector).getByText('com_ui_trace_ttft')).toBeInTheDocument();
    expect(within(inspector).getByText('com_ui_trace_decoding')).toBeInTheDocument();
    expect(within(inspector).getByText('gpt-5')).toBeInTheDocument();
    expect(within(inspector).queryByText('com_ui_trace_content')).not.toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: recordName('llm') })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(dataService.getConversationTraceRecord).not.toHaveBeenCalled();
  });

  it('loads input and output for the selected record when the deployment allows it', async () => {
    mockStartupConfig = { interface: { traceViewer: { enabled: true, showInputOutput: true } } };
    renderViewer();

    await userEvent.click(await recordRow('llm'));

    const inspector = screen.getByTestId('trace-inspector');
    expect(await within(inspector).findByText(/"content": "hi"/)).toBeInTheDocument();
    expect(within(inspector).getByText('partial outp')).toBeInTheDocument();
    expect(within(inspector).getByText('com_ui_trace_truncated')).toBeInTheDocument();
    expect(dataService.getConversationTraceRecord).toHaveBeenCalledWith(
      {
        conversationId: 'convo-1',
        recordId: 'llm',
        messageId: 'response-1',
        sourceId: 'tenant-project',
      },
      expect.any(AbortSignal),
    );
  });

  it('shows the error message for a failed record', async () => {
    renderViewer();

    await userEvent.click(await recordRow('com_ui_tool_name_web_search'));

    expect(
      within(screen.getByTestId('trace-inspector')).getByText('Error: search backend unavailable'),
    ).toBeInTheDocument();
  });

  it('does not call a failed record with no end time running', async () => {
    jest.spyOn(dataService, 'getConversationTraceRecords').mockResolvedValue({
      records: [
        record({
          id: 'broken',
          name: 'broken_tool',
          kind: 'tool',
          status: 'error',
          endTime: undefined,
        }),
      ],
    });
    renderViewer();

    const row = await recordRow('broken_tool');

    expect(row).not.toHaveAccessibleName(/com_ui_trace_status_running/);
    expect(row).toHaveAccessibleName(/com_ui_trace_status_error/);
    await userEvent.click(row);
    const inspector = screen.getByTestId('trace-inspector');
    expect(within(inspector).queryByText('com_ui_trace_status_running')).not.toBeInTheDocument();
    expect(within(inspector).getByText('—')).toBeInTheDocument();
  });

  it('filters the tree by search and keeps the match context', async () => {
    renderViewer();
    await recordRow('llm');

    await userEvent.type(screen.getByLabelText('com_ui_trace_search'), 'web');

    await waitFor(() =>
      expect(screen.queryByRole('treeitem', { name: recordName('llm') })).not.toBeInTheDocument(),
    );
    expect(stepRow(1)).toBeInTheDocument();
    expect(
      screen.getByRole('treeitem', { name: recordName('com_ui_tool_name_web_search') }),
    ).toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText('com_ui_trace_search'));
    await userEvent.type(screen.getByLabelText('com_ui_trace_search'), 'nothing matches');
    expect(await screen.findByText('com_ui_trace_no_matches')).toBeInTheDocument();
  });

  it('folds and unfolds rows from the keyboard', async () => {
    renderViewer();
    await recordRow('llm');
    const tree = screen.getByRole('tree');

    await userEvent.click(stepRow(1));
    await waitFor(() =>
      expect(screen.queryByRole('treeitem', { name: recordName('llm') })).not.toBeInTheDocument(),
    );
    expect(stepRow(1)).toHaveAttribute('aria-expanded', 'false');

    fireEvent.keyDown(tree, { key: 'ArrowRight' });
    expect(await recordRow('llm')).toBeInTheDocument();
    expect(stepRow(1)).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    expect(tree).toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('treeitem', { name: recordName('llm') }).id,
    );
    fireEvent.keyDown(tree, { key: 'ArrowLeft' });
    expect(tree).toHaveAttribute('aria-activedescendant', stepRow(1).id);
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    fireEvent.keyDown(tree, { key: 'Enter' });
    expect(screen.getByTestId('trace-inspector')).toBeInTheDocument();
  });

  it('keeps the active row mounted while the ledger scrolls away from it', async () => {
    const many = [
      record({
        id: 'root',
        kind: 'agent',
        name: 'AgentGraph',
        startTime: at(0),
        endTime: at(9000),
      }),
      ...Array.from({ length: 150 }, (_, index) =>
        record({
          id: `call-${index}`,
          parentId: 'root',
          kind: 'tool',
          name: `call-${index}`,
          startTime: at(index),
        }),
      ),
    ];
    jest.spyOn(dataService, 'getConversationTraceRecords').mockResolvedValue({ records: many });
    renderViewer();
    await recordRow('call-0,');
    const tree = screen.getByRole('tree');

    fireEvent.focus(tree);
    const activeId = await waitFor(() => {
      const id = tree.getAttribute('aria-activedescendant');
      expect(id).toBeTruthy();
      return id as string;
    });
    tree.scrollTop = 140 * 32;
    fireEvent.scroll(tree);

    expect(await recordRow('call-140')).toBeInTheDocument();
    expect(tree.getAttribute('aria-activedescendant')).toBe(activeId);
    expect(document.getElementById(activeId)).toHaveAttribute('role', 'treeitem');
  });

  it('collapses and expands everything', async () => {
    renderViewer();
    await recordRow('llm');

    await userEvent.click(screen.getByRole('button', { name: 'com_ui_trace_collapse_all' }));
    expect(screen.queryByRole('treeitem', { name: recordName('llm') })).not.toBeInTheDocument();
    expect(screen.queryByRole('treeitem', { name: /^com_ui_trace_step/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'com_ui_trace_expand_all' }));
    expect(screen.getByRole('treeitem', { name: recordName('llm') })).toBeInTheDocument();
  });

  it('focuses an interval from the overview keyboard and clears it', async () => {
    renderViewer();
    await recordRow('llm');
    const overview = screen.getByTestId('trace-overview');

    fireEvent.keyDown(overview, { key: '+' });

    expect(screen.getByTestId('trace-overview-selection')).toBeInTheDocument();
    expect(screen.getByText(/^com_ui_trace_selection/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'com_ui_trace_clear_selection' }));
    expect(screen.queryByTestId('trace-overview-selection')).not.toBeInTheDocument();
  });

  it('loads older records on demand and merges them into the tree', async () => {
    const list = jest
      .spyOn(dataService, 'getConversationTraceRecords')
      .mockImplementation(async ({ cursor }) =>
        cursor == null
          ? { records: records.slice(1), nextCursor: 'older' }
          : { records: records.slice(0, 1) },
      );
    renderViewer();

    expect(await screen.findByText('com_ui_trace_partial 2')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'com_ui_trace_load_older' }));

    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith(
        { conversationId: 'convo-1', cursor: 'older' },
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'com_ui_trace_load_older' }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('treeitem', { name: recordName('llm') })).toHaveAttribute(
      'aria-level',
      '3',
    );
    await userEvent.click(toggle('com_ui_trace_all_spans'));
    expect(await recordRow('AgentGraph')).toHaveAttribute('aria-level', '2');
  });

  it('reports a failed refresh while every page is already loaded, with a retry', async () => {
    const list = jest
      .spyOn(dataService, 'getConversationTraceRecords')
      .mockResolvedValueOnce({ records })
      .mockRejectedValueOnce(axiosError(504, 'timeout'))
      .mockResolvedValue({ records });
    renderViewer();
    await recordRow('llm');

    await userEvent.click(screen.getByRole('button', { name: 'com_ui_trace_refresh' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_trace_error_timeout');
    expect(screen.getByRole('treeitem', { name: recordName('llm') })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(list).toHaveBeenCalledTimes(3);
  });

  it('refreshes by rereading only the newest page, not every loaded page', async () => {
    const list = jest
      .spyOn(dataService, 'getConversationTraceRecords')
      .mockImplementation(async ({ cursor }) =>
        cursor == null
          ? { records: records.slice(1), nextCursor: 'older' }
          : { records: records.slice(0, 1) },
      );
    renderViewer();
    await userEvent.click(await screen.findByRole('button', { name: 'com_ui_trace_load_older' }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));

    await userEvent.click(screen.getByRole('button', { name: 'com_ui_trace_refresh' }));

    expect(
      await screen.findByRole('button', { name: 'com_ui_trace_load_older' }),
    ).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(3);
    expect(list).toHaveBeenLastCalledWith(
      { conversationId: 'convo-1', cursor: undefined },
      expect.any(AbortSignal),
    );
  });

  it('opens the newest response and folds older ones to their summary as they load', async () => {
    const newest = [
      record({
        id: 'later',
        messageId: 'response-2',
        traceId: 'trace-2',
        name: 'later-llm',
        kind: 'generation',
        startTime: at(10_000),
        endTime: at(12_000),
      }),
    ];
    jest
      .spyOn(dataService, 'getConversationTraceRecords')
      .mockImplementation(async ({ cursor }) =>
        cursor == null ? { records: newest, nextCursor: 'older' } : { records },
      );
    renderViewer();
    await recordRow('later-llm');

    await userEvent.click(screen.getByRole('button', { name: 'com_ui_trace_load_older' }));

    const turns = await screen.findAllByRole('treeitem', { name: /^com_ui_trace_turn/ });
    expect(turns).toHaveLength(2);
    expect(turns[0]).toHaveAttribute('aria-expanded', 'false');
    expect(turns[1]).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('treeitem', { name: recordName('llm,') })).not.toBeInTheDocument();

    await userEvent.click(turns[0]);

    expect(await recordRow('llm,')).toBeInTheDocument();
  });

  it('drops an interval and a selection on older pages when a refresh trims them', async () => {
    const newest = [
      record({
        id: 'later',
        messageId: 'response-2',
        traceId: 'trace-2',
        name: 'later-llm',
        kind: 'generation',
        startTime: at(10_000),
        endTime: at(12_000),
      }),
    ];
    jest
      .spyOn(dataService, 'getConversationTraceRecords')
      .mockImplementation(async ({ cursor }) =>
        cursor == null ? { records: newest, nextCursor: 'older' } : { records },
      );
    renderViewer();
    await userEvent.click(await screen.findByRole('button', { name: 'com_ui_trace_load_older' }));
    await userEvent.click(
      (await screen.findAllByRole('treeitem', { name: /^com_ui_trace_turn/ }))[0],
    );
    await userEvent.click(await recordRow('llm,'));
    /** Two zooms narrow the sequence to the one middle record, leaving the newest page out. */
    fireEvent.keyDown(screen.getByTestId('trace-overview'), { key: '+' });
    fireEvent.keyDown(screen.getByTestId('trace-overview'), { key: '+' });
    expect(
      screen.queryByRole('treeitem', { name: recordName('later-llm') }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('trace-inspector')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'com_ui_trace_refresh' }));

    expect(await recordRow('later-llm')).toBeInTheDocument();
    expect(screen.queryByTestId('trace-overview-selection')).not.toBeInTheDocument();
    expect(screen.queryByTestId('trace-inspector')).not.toBeInTheDocument();

    await userEvent.click(await screen.findByRole('button', { name: 'com_ui_trace_load_older' }));

    await waitFor(() =>
      expect(screen.getAllByRole('treeitem', { name: /^com_ui_trace_turn/ })).toHaveLength(2),
    );
    expect(screen.queryByTestId('trace-inspector')).not.toBeInTheDocument();
  });

  it('keeps a newest-page selection but drops an older one when a settled run trims the cache', async () => {
    jest
      .spyOn(dataService, 'getConversationTraceRecords')
      .mockImplementation(async ({ cursor }) =>
        cursor == null
          ? { records: records.slice(1), nextCursor: 'older' }
          : { records: records.slice(0, 1) },
      );
    const { client } = renderViewer();
    const inspectorHeading = () =>
      within(screen.getByTestId('trace-inspector')).getByRole('heading', { level: 3 });

    await userEvent.click(await screen.findByRole('button', { name: 'com_ui_trace_load_older' }));
    await userEvent.click(await recordRow('com_ui_tool_name_web_search'));
    act(() => keepNewestTracePage(client, 'convo-1'));

    expect(await screen.findByRole('button', { name: 'com_ui_trace_load_older' })).toBeVisible();
    expect(inspectorHeading()).toHaveTextContent('com_ui_tool_name_web_search');

    await userEvent.click(screen.getByRole('button', { name: 'com_ui_trace_load_older' }));
    await userEvent.click(toggle('com_ui_trace_all_spans'));
    await userEvent.click(await recordRow('AgentGraph'));
    expect(inspectorHeading()).toHaveTextContent('AgentGraph');
    act(() => keepNewestTracePage(client, 'convo-1'));

    await waitFor(() => expect(screen.queryByTestId('trace-inspector')).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'com_ui_trace_load_older' }));

    expect(await recordRow('AgentGraph')).toBeInTheDocument();
    expect(screen.queryByTestId('trace-inspector')).not.toBeInTheDocument();
  });

  it('retries the read that failed: an older page retries that page', async () => {
    const list = jest
      .spyOn(dataService, 'getConversationTraceRecords')
      .mockResolvedValueOnce({ records: records.slice(1), nextCursor: 'older' })
      .mockRejectedValueOnce(axiosError(504, 'timeout'))
      .mockResolvedValue({ records: records.slice(0, 1) });
    renderViewer();
    await userEvent.click(await screen.findByRole('button', { name: 'com_ui_trace_load_older' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_trace_error_timeout');

    await userEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));

    await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
    expect(list).toHaveBeenLastCalledWith(
      { conversationId: 'convo-1', cursor: 'older' },
      expect.any(AbortSignal),
    );
  });

  it('reloads from the newest page when an older page no longer matches the trace', async () => {
    const list = jest
      .spyOn(dataService, 'getConversationTraceRecords')
      .mockResolvedValueOnce({ records: records.slice(1), nextCursor: 'older' })
      .mockRejectedValueOnce(axiosError(400, 'invalid_request'))
      .mockResolvedValue({ records: records.slice(1), nextCursor: 'older' });
    renderViewer();
    await userEvent.click(await screen.findByRole('button', { name: 'com_ui_trace_load_older' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_trace_error_changed');

    await userEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));

    await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
    expect(list).toHaveBeenLastCalledWith(
      { conversationId: 'convo-1', cursor: undefined },
      expect.any(AbortSignal),
    );
  });

  it('rereads an open record detail when the trace is refreshed', async () => {
    mockStartupConfig = { interface: { traceViewer: { enabled: true, showInputOutput: true } } };
    renderViewer();
    await userEvent.click(await recordRow('llm'));
    await waitFor(() => expect(dataService.getConversationTraceRecord).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole('button', { name: 'com_ui_trace_refresh' }));

    await waitFor(() => expect(dataService.getConversationTraceRecord).toHaveBeenCalledTimes(2));
  });

  it('returns focus to the search field when closing the inspector after a filter hid every row', async () => {
    renderViewer();
    await userEvent.click(await recordRow('llm'));
    const search = screen.getByLabelText('com_ui_trace_search');
    await userEvent.type(search, 'no-such-record');
    expect(screen.queryByRole('tree')).not.toBeInTheDocument();

    const inspector = screen.getByTestId('trace-inspector');
    await userEvent.click(
      within(inspector).getByRole('button', { name: 'com_ui_trace_close_details' }),
    );

    expect(screen.queryByTestId('trace-inspector')).not.toBeInTheDocument();
    expect(search).toHaveFocus();
  });

  it('closes the inspector on Escape before closing the trace', async () => {
    const { onClose } = renderViewer();
    await userEvent.click(await recordRow('llm'));

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('trace-inspector')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('links to Langfuse only for users who manage the connection', async () => {
    const first = renderViewer();
    await recordRow('llm');
    expect(
      screen.queryByRole('link', { name: /com_ui_trace_open_langfuse/ }),
    ).not.toBeInTheDocument();
    expect(dataService.getLangfuseSessionLink).not.toHaveBeenCalled();
    first.unmount();

    mockStartupConfig = {
      interface: { traceViewer: { enabled: true } },
      langfuseConnectionAccess: true,
    };
    renderViewer();

    const link = await screen.findByRole('link', { name: /com_ui_trace_open_langfuse/ });
    expect(link).toHaveAttribute('href', 'https://langfuse.test/project/p/sessions/convo-1');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('does not link to a Langfuse project other than the one that served the trace', async () => {
    mockStartupConfig = {
      interface: { traceViewer: { enabled: true } },
      langfuseConnectionAccess: true,
    };
    jest
      .spyOn(dataService, 'getConversationTraceRecords')
      .mockResolvedValue({ records, sourceId: 'central-project' });
    renderViewer();

    await recordRow('llm');
    await waitFor(() => expect(dataService.getLangfuseSessionLink).toHaveBeenCalled());
    expect(
      screen.queryByRole('link', { name: /com_ui_trace_open_langfuse/ }),
    ).not.toBeInTheDocument();
  });

  it('cancels an in-flight trace read when the viewer closes', async () => {
    let signal: AbortSignal | undefined;
    jest
      .spyOn(dataService, 'getConversationTraceRecords')
      .mockImplementation((_params, requestSignal) => {
        signal = requestSignal;
        return new Promise(() => undefined);
      });
    const { unmount } = renderViewer();
    await waitFor(() => expect(signal).toBeDefined());

    unmount();

    await waitFor(() => expect(signal?.aborted).toBe(true));
  });

  it('moves focus into the trace when it opens', async () => {
    renderViewer();

    expect(screen.getByRole('button', { name: 'com_ui_trace_close' })).toHaveFocus();
  });

  describe('a run as the agents SDK records it', () => {
    const scout = { id: 'agent_scout', name: 'Codebase Scout', description: 'Reads the repo.' };
    const sdkRecords: TTraceRecord[] = [
      record({ id: 'run', kind: 'agent', role: 'run', name: 'AgentGraph', endTime: at(5000) }),
      record({
        id: 'scout',
        parentId: 'run',
        role: 'agent',
        agentId: 'agent_scout',
        name: 'agent_scout',
        endTime: at(5000),
      }),
      record({
        id: 'llm-1',
        parentId: 'scout',
        kind: 'generation',
        role: 'model',
        name: 'llm',
        startTime: at(100),
      }),
      record({
        id: 'label-1',
        parentId: 'scout',
        kind: 'generation',
        role: 'stepLabel',
        name: 'StepLabel',
        startTime: at(1050),
      }),
      record({
        id: 'round-1',
        parentId: 'scout',
        role: 'tools',
        name: 'tool-dispatch',
        startTime: at(1100),
        endTime: at(2000),
      }),
      record({
        id: 'llm-2',
        parentId: 'scout',
        kind: 'generation',
        role: 'model',
        name: 'llm',
        startTime: at(2100),
      }),
    ];
    const messages = [
      {
        messageId: 'user-1',
        conversationId: 'convo-1',
        parentMessageId: null,
        isCreatedByUser: true,
        text: 'Where does the  trace viewer\nread from?',
      },
      {
        ...responseMessage,
        content: [
          { type: ContentTypes.TEXT, text: 'Let me look that up.' },
          { type: ContentTypes.ACTIVITY_LABEL, activity_label: 'Finding the trace reader' },
          {
            type: ContentTypes.TOOL_CALL,
            tool_call: { name: 'web_search', args: { query: 'weather' }, output: 'Sunny.' },
          },
          { type: ContentTypes.TEXT, text: 'It reads from Langfuse.' },
        ],
      },
    ] as unknown as TMessage[];

    function renderSdkRun(listed: TTraceRecord[] = sdkRecords) {
      jest
        .spyOn(dataService, 'getConversationTraceRecords')
        .mockResolvedValue({ records: listed, sourceId: 'tenant-project' });
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
        logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
      });
      client.setQueryData([QueryKeys.messages, 'convo-1'], messages);
      return render(
        <MemoryRouter>
          <Provider>
            <QueryClientProvider client={client}>
              <AgentsMapContext.Provider value={{ agent_scout: scout } as unknown as TAgentsMap}>
                <Viewer conversationId="convo-1" onClose={jest.fn()} />
              </AgentsMapContext.Provider>
            </QueryClientProvider>
          </Provider>
        </MemoryRouter>,
      );
    }

    it('reads as the chat does: the question, the model, the label it showed and the tools it ran', async () => {
      renderSdkRun();

      expect(await recordRow('com_ui_model: Let me look that up\\.')).toBeInTheDocument();
      const turn = screen.getByRole('treeitem', { name: /^com_ui_trace_turn/ });
      expect(turn).toHaveAccessibleName(/Where does the trace viewer read from\?/);
      expect(turn).toHaveAccessibleName(/com_ui_trace_model_calls_count 2/);
      expect(turn).toHaveAccessibleName(/com_ui_trace_tool_calls_count_one 1/);
      expect(
        screen.getByRole('treeitem', {
          name: recordName('com_ui_trace_role_step_label: Finding the trace reader'),
        }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('treeitem', { name: /tool-dispatch|StepLabel/ })).toBeNull();
      const summary = screen.getByLabelText('com_ui_trace_summary');
      expect(within(summary).getByText('com_ui_trace_summary_tools').nextSibling).toHaveTextContent(
        '1',
      );

      await userEvent.click(await recordRow('com_ui_tool_name_web_search: query: weather'));

      const inspector = screen.getByTestId('trace-inspector');
      expect(within(inspector).getByText(/"query": "weather"/)).toBeInTheDocument();
      expect(within(inspector).getByText('Sunny.')).toBeInTheDocument();
      expect(within(inspector).getByText('com_ui_trace_from_conversation')).toBeInTheDocument();
      expect(within(inspector).getByText('tool-dispatch')).toBeInTheDocument();
      expect(dataService.getConversationTraceRecord).not.toHaveBeenCalled();
    });

    it('shows a model call as a conversation, newest messages open, with the raw form one click away', async () => {
      mockStartupConfig = {
        interface: { traceViewer: { enabled: true, showInputOutput: true } },
      };
      const content = (value: string) => ({ value, truncated: false });
      jest.spyOn(dataService, 'getConversationTraceRecord').mockResolvedValue({
        record: sdkRecords[2],
        contentAvailable: true,
        input: { value: '{"messages":[{"role":"sys', truncated: true },
        prompt: {
          total: 40,
          omitted: 37,
          tools: ['web_search', 'read_file'],
          messages: [
            { role: 'system', text: content('You are Codebase Scout.') },
            { role: 'user', text: content('Where does it read from?') },
            { role: 'tool', toolName: 'web_search', text: content('ten results') },
          ],
        },
        reply: {
          role: 'assistant',
          text: content('Let me look that up.'),
          toolCalls: [{ name: 'web_search', args: content('{"query":"weather"}') }],
        },
      });
      renderSdkRun();

      await userEvent.click(await recordRow('com_ui_model: Let me look that up\\.'));

      const inspector = screen.getByTestId('trace-inspector');
      expect(await within(inspector).findByText('com_ui_trace_reply')).toBeInTheDocument();
      expect(within(inspector).getByText('Where does it read from?')).toBeVisible();
      expect(within(inspector).getByText('com_ui_trace_prompt_omitted 37')).toBeInTheDocument();
      expect(
        within(inspector).getByText('com_ui_trace_message_tool com_ui_tool_name_web_search'),
      ).toBeInTheDocument();
      expect(
        within(inspector).getByText('com_ui_trace_message_asked_tool com_ui_tool_name_web_search'),
      ).toBeInTheDocument();
      expect(
        within(inspector).getByText('You are Codebase Scout.').closest('details'),
      ).not.toHaveAttribute('open');
      expect(within(inspector).queryByText(/"messages":\[/)).not.toBeInTheDocument();

      await userEvent.click(
        within(inspector).getByRole('button', { name: 'com_ui_trace_view_raw' }),
      );

      expect(within(inspector).getByText(/"messages":\[/)).toBeInTheDocument();
      expect(within(inspector).queryByText('com_ui_trace_reply')).not.toBeInTheDocument();
    });

    it('says a round came from the conversation only when it did', async () => {
      const namedRound = sdkRecords.map((entry) =>
        entry.id === 'round-1' ? { ...entry, tools: ['bash_tool'] } : entry,
      );
      renderSdkRun(namedRound);

      /** The chat's round called web_search, so the trace's bash_tool round stays unmatched. */
      await userEvent.click(await recordRow('com_ui_tool_name_code'));

      const inspector = screen.getByTestId('trace-inspector');
      expect(within(inspector).getAllByText('com_ui_tool_name_code').length).toBeGreaterThan(0);
      expect(within(inspector).queryByText('com_ui_trace_from_conversation')).toBeNull();
      expect(within(inspector).queryByText('Sunny.')).toBeNull();
    });

    it('shows the agent by name with its id to copy and a chat one click away', async () => {
      renderSdkRun();
      await recordRow('com_ui_model: Let me look that up\\.');

      await userEvent.click(toggle('com_ui_trace_all_spans'));
      await userEvent.click(await recordRow('Codebase Scout'));

      const inspector = screen.getByTestId('trace-inspector');
      expect(within(inspector).getByText('Reads the repo.')).toBeInTheDocument();
      expect(within(inspector).getByText('agent_scout', { selector: '.select-all' })).toBeVisible();
      expect(
        within(inspector).getByRole('link', { name: 'com_ui_trace_chat_with_agent' }),
      ).toHaveAttribute('href', '/c/new?agent_id=agent_scout');
      expect(
        within(inspector).getByRole('button', { name: 'com_ui_trace_copy_agent_id' }),
      ).toBeInTheDocument();
    });
  });
});
