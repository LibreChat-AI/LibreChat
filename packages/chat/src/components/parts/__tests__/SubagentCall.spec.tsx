/**
 * @jest-environment jsdom
 */
import React, { useState, useEffect, useContext } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Provider as JotaiProvider, createStore, useAtomValue, useStore } from 'jotai';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  Agent,
  PartMetadata,
  TAttachment,
  SubagentIdentity,
  SubagentUpdateEvent,
  ParentSubagentSummary,
} from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type {
  SubagentAggregatorState,
  SubagentContentPart,
  SubagentTickerState,
} from '../../../core/subagents/content';
import type { ActiveSubagentPanel, SubagentProgress } from '../../../react/subagents/state';
import type { ChatSurface } from '../../../react/subagents/context';
import type { StreamHost } from '../../../react/stream/host';
import type { SubagentCallProps } from '../SubagentCall';
import {
  foldSubagentEvent,
  foldSubagentEventIntoTicker,
  initSubagentAggregatorState,
  initSubagentTickerState,
} from '../../../core/subagents/content';
import {
  activeSubagentPanel,
  subagentProgressByToolCallId,
  subagentProgressKey,
} from '../../../react/subagents/state';
import { MAX_PREVIEWED_THREADS, useThreadInterest } from '../../../react/subagents/follows';
import { MessagePartsHostProvider, useMessagePartsHost } from '../../../react/host';
import PackageSubagentCall, { SUBAGENT_TICKER_THROTTLE_MS } from '../SubagentCall';
import { ParentSubagentsProvider } from '../../../react/subagents/parents';
import { createSubagentsHost } from '../../../__fixtures__/subagentsHost';
import { createMessagePartsHost } from '../../../__fixtures__/partsHost';
import { ChatSurfaceProvider } from '../../../react/subagents/provider';
import { SubagentCallerContext } from '../../../react/subagents/author';
import { SubagentsHostProvider } from '../../../react/subagents/host';
import { useIsPartsPreview } from '../../../react/parts/preview';
import { StreamHostProvider } from '../../../react/stream/host';
import { ToolPreparation } from '../preparation';
import { FailedRevealContext } from '../reveal';
import { FOLD_GLYPH_SELECTOR } from '../rows';
import { litFoldPath } from '../rail';

let mockIndexedChildren = new Map<string, ParentSubagentSummary>();

type CardMessage = {
  messageId: string;
  conversationId?: string | null;
  partIndex?: number;
};

const defaultMessage: CardMessage = {
  messageId: 'parent-message',
  conversationId: 'parent-conversation',
  partIndex: 0,
};

let currentMessage: CardMessage = defaultMessage;

const localize = (key: string): string => {
  const translations: Record<string, string> = {
    com_ui_subagent_running: 'Running agent',
    com_ui_subagent_activity: 'Agent activity',
    com_ui_subagent_complete: 'Ran agent',
    com_ui_subagent_cancelled: 'Cancelled agent',
    com_ui_subagent_errored: 'Agent errored',
    com_ui_subagent_waiting: 'Waiting for first update…',
    com_ui_subagent_briefing: 'Writing the brief…',
    com_ui_subagent_starting: 'Starting…',
    com_ui_starting_one_subagent: 'Starting a subagent',
    com_ui_subagent_ticker_writing: 'Writing',
    com_ui_subagent_ticker_reasoning: 'Reasoning',
    com_ui_subagent_ticker_error: 'Error',
    com_ui_subagent_ticker_using: 'Using',
    com_ui_subagent_ticker_tool_done: 'done',
  };
  return translations[key] ?? key;
};

const agents = {
  'agent-1': { id: 'agent-1', name: 'Analyst One', avatar: { filepath: '/analyst.png' } },
  agent_reviewer: {
    id: 'agent_reviewer',
    name: 'Code Reviewer',
    avatar: { filepath: '/reviewer.png' },
  },
} as unknown as Record<string, Agent | undefined>;

function SubagentCall(props: SubagentCallProps) {
  return (
    <PackageSubagentCall
      {...props}
      message={currentMessage}
      agentsMap={agents}
      localize={localize}
      renderAgentIcon={(agent) =>
        agent?.avatar?.filepath != null ? (
          <img alt={agent.name ?? ''} src={agent.avatar.filepath} />
        ) : null
      }
      renderAttachments={(attachments) => (
        <>
          <div data-testid="attachment-group">{JSON.stringify(attachments)}</div>
          <div data-testid="app-views">{JSON.stringify(attachments)}</div>
        </>
      )}
    />
  );
}
/** A part as one line, so a spec reads which row the thread's renderer was handed. */
const partLine = (part: object | undefined): string => {
  const {
    text,
    think,
    tool_call: toolCall,
  } = (part ?? {}) as {
    text?: string;
    think?: string;
    tool_call?: { name?: string };
  };
  return toolCall?.name ?? text ?? think ?? '';
};
/** What a row is told when it is drawn, read the way the app's parts read it. */
function ThreadRow({ line, live }: { line: string; live: boolean }): ReactNode {
  const [claim, setClaim] = useMessagePartsHost().useToolArtifactClaim('artifact-1');
  const reveal = useContext(FailedRevealContext);
  useEffect(() => {
    setClaim('thread-row');
  }, [setClaim]);
  return (
    <div
      data-testid="thread-row"
      data-live={String(live)}
      data-preview={String(useIsPartsPreview())}
      data-claim={String(claim)}
      data-reveal={String(reveal.tick)}
    >
      {line}
    </div>
  );
}

let claimedArtifact: string | null = null;
const partsHost = createMessagePartsHost({
  /** One claim for the page, as the app keeps one per artifact. */
  useToolArtifactClaim: () => [
    claimedArtifact,
    (next) => {
      claimedArtifact = typeof next === 'function' ? next(claimedArtifact) : next;
    },
  ],
  renderContentParts: ({ content, isSubmitting, isLatestMessage }) => (
    <ThreadRow
      line={content.map(partLine).join('|')}
      live={isSubmitting && isLatestMessage === true}
    />
  ),
});

const mockUseThreadChat = jest.fn();
const mockRefetchIndex = jest.fn(async () => ({ data: undefined }));
let seedQueries: ((client: QueryClient) => void) | undefined;
/** Other readers on the page, mounted ahead of the card under the same providers. */
let neighbours: ReactNode;

/** Another running child's card, as far as the page's followers are concerned. */
function OtherPreview({ threadId }: { threadId: string }): null {
  useThreadInterest(threadId, { live: true, enabled: true, passive: true });
  return null;
}

const subagentsHost = createSubagentsHost({
  useAgentsMap: () => agents,
  useThreadChat: (...args) => mockUseThreadChat(...args),
});

const streamHost = {
  useParentSubagentIndex: () => ({
    data: {
      parentConversationId: 'parent-conversation',
      children: [...mockIndexedChildren.values()],
      childrenTruncated: false,
    },
    isError: false,
    refetch: mockRefetchIndex,
  }),
} as unknown as StreamHost;

const surface: ChatSurface = {
  enterToSend: true,
  maximizeChatSpace: false,
  showScrollButton: true,
  composerBindings: {
    shortcutsEnabled: true,
    submitOverride: undefined,
    yieldedChords: new Set<string>(),
  },
  claimForeground: () => undefined,
  handOffComposerText: () => undefined,
};

function Providers({
  surface: withSurface = true,
  seed,
  tick = 0,
  children,
}: {
  surface?: boolean;
  seed?: (store: ReturnType<typeof createStore>) => void;
  tick?: number;
  children: ReactNode;
}) {
  const [store] = useState(() => {
    const created = createStore();
    seed?.(created);
    return created;
  });
  const [queryClient] = useState(() => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedQueries?.(client);
    return client;
  });
  const card = (
    <FailedRevealContext.Provider value={{ tick, claimFocus: () => true }}>
      <MessagePartsHostProvider host={partsHost}>{children}</MessagePartsHostProvider>
    </FailedRevealContext.Provider>
  );
  return (
    <QueryClientProvider client={queryClient}>
      <StreamHostProvider host={streamHost}>
        {/* The page's followers read the subagents host, so it sits above the index provider. */}
        <SubagentsHostProvider host={subagentsHost}>
          <ParentSubagentsProvider conversationId="parent-conversation" enabled>
            <JotaiProvider store={store}>
              {neighbours}
              {withSurface ? (
                <ChatSurfaceProvider value={surface}>{card}</ChatSurfaceProvider>
              ) : (
                card
              )}
            </JotaiProvider>
          </ParentSubagentsProvider>
        </SubagentsHostProvider>
      </StreamHostProvider>
    </QueryClientProvider>
  );
}

afterEach(() => {
  jest.useRealTimers();
  mockIndexedChildren = new Map();
  currentMessage = defaultMessage;
  seedQueries = undefined;
  neighbours = undefined;
  claimedArtifact = null;
  mockUseThreadChat.mockReset();
  mockRefetchIndex.mockClear();
});

function foldEvents(events: SubagentUpdateEvent[]): {
  contentParts: SubagentContentPart[];
  aggregatorState: SubagentAggregatorState;
  tickerState: SubagentTickerState;
} {
  let contentParts: SubagentContentPart[] = [];
  let aggregatorState = initSubagentAggregatorState();
  let tickerState = initSubagentTickerState();
  for (const update of events) {
    ({ parts: contentParts, state: aggregatorState } = foldSubagentEvent(
      contentParts,
      aggregatorState,
      update,
    ));
    tickerState = foldSubagentEventIntoTicker(tickerState, update);
  }
  return { contentParts, aggregatorState, tickerState };
}

function progressFromEvents(
  base: { events: SubagentUpdateEvent[] } & Omit<
    SubagentProgress,
    'contentParts' | 'aggregatorState' | 'tickerState'
  >,
): SubagentProgress {
  const { events, ...rest } = base;
  return { ...rest, ...foldEvents(events) };
}

function renderWithState(args: {
  toolCallId: string;
  initialProgress: number;
  isSubmitting?: boolean;
  progress?: SubagentProgress | null;
  output?: string;
  toolArgs?: Record<string, unknown>;
  subagentIdentity?: SubagentIdentity;
  runStepStatus?: PartMetadata['runStepStatus'];
  selection?: ActiveSubagentPanel;
}) {
  const setter = { current: null as null | ((next: SubagentProgress | null) => void) };
  let selection: ActiveSubagentPanel | null = null;
  const SeedHelper = () => {
    const store = useStore();
    setter.current = (next: SubagentProgress | null) =>
      store.set(
        subagentProgressByToolCallId(subagentProgressKey('parent-message', args.toolCallId, 0)),
        next,
      );
    return null;
  };
  const SelectionObserver = () => {
    selection = useAtomValue(activeSubagentPanel);
    return null;
  };
  const tree = (tick: number) => (
    <Providers tick={tick} seed={(store) => store.set(activeSubagentPanel, args.selection ?? null)}>
      <SeedHelper />
      <SelectionObserver />
      <SubagentCall
        toolCallId={args.toolCallId}
        initialProgress={args.initialProgress}
        isSubmitting={args.isSubmitting ?? false}
        args={args.toolArgs ?? { subagent_type: 'self', description: 'compute' }}
        output={args.output}
        runStepStatus={args.runStepStatus}
        subagentIdentity={args.subagentIdentity}
      />
    </Providers>
  );
  const rendered = render(tree(0));
  act(() => setter.current?.(args.progress ?? null));
  return {
    ...rendered,
    getSelection: () => selection,
    setProgress: (next: SubagentProgress | null) => act(() => setter.current?.(next)),
    reveal: () => rendered.rerender(tree(1)),
  };
}

const event = (
  phase: SubagentUpdateEvent['phase'],
  data: SubagentUpdateEvent['data'],
): SubagentUpdateEvent => ({
  runId: 'parent-run',
  subagentRunId: 'child-run',
  subagentType: 'self',
  subagentAgentId: 'child',
  phase,
  data,
  timestamp: '',
});

describe('SubagentCall', () => {
  it('registers its existing header glyph as a branch of its fold', () => {
    renderWithState({ toolCallId: 'fold-glyph', initialProgress: 1 });
    const row = screen.getByRole('button', { name: 'Ran agent' }).cloneNode(true) as HTMLElement;
    const glyph = row.querySelector<HTMLElement>(FOLD_GLYPH_SELECTOR);
    expect(glyph).not.toBeNull();
    expect(glyph).toHaveClass('h-5', 'w-5');
    expect(glyph).not.toHaveClass('min-w-6');
    glyph!.getBoundingClientRect = () => ({ top: 150, height: 20 }) as DOMRect;
    const root = document.createElement('div');
    let parent = root;
    const rails: HTMLElement[] = [];
    for (const top of [40, 104]) {
      const panel = document.createElement('div');
      panel.setAttribute('data-fold-panel', '');
      const rail = document.createElement('button');
      rail.setAttribute('data-fold-rail', '');
      rail.getBoundingClientRect = () => ({ top }) as DOMRect;
      panel.append(rail);
      parent.append(panel);
      parent = panel;
      rails.push(rail);
    }
    parent.append(row);
    /** The outer fold holds no row of its own above this one, so it has no branch to light. */
    expect(litFoldPath(root, row, 155)).toEqual([{ rail: rails[1], branch: 0 }]);
  });

  it.each([
    { child: 'streams', progress: { initialProgress: 0.1, isSubmitting: true }, running: 'true' },
    {
      child: 'has a result',
      progress: { initialProgress: 1, isSubmitting: true },
      running: 'false',
    },
    {
      child: 'stops before a result',
      progress: { initialProgress: 0.1, isSubmitting: false },
      running: 'false',
    },
    {
      child: 'is cancelled',
      progress: {
        initialProgress: 0.1,
        isSubmitting: true,
        runStepStatus: 'cancelled' as const,
      },
      running: 'false',
    },
  ])('marks the card as running only while its child $child', ({ progress, running }) => {
    renderWithState({ toolCallId: 'pulse', ...progress });
    expect(screen.getByRole('button')).toHaveAttribute('data-running', running);
  });

  it.each([
    {
      child: 'streams with no saved agent',
      state: {
        initialProgress: 0.1,
        toolArgs: { subagent_type: 'self' },
        progress: progressFromEvents({
          subagentRunId: 'child-run',
          subagentType: 'self',
          status: 'start',
          events: [],
        }),
      },
      pulses: true,
    },
    {
      child: 'has not reported yet, so it wears the pending face instead',
      state: { initialProgress: 0.1, toolArgs: { subagent_type: 'self' } },
      pulses: false,
    },
    {
      child: 'streams as a saved agent',
      state: {
        initialProgress: 0.1,
        toolArgs: { subagent_type: 'agent-1' },
        subagentIdentity: { subagentKind: 'agent' as const, subagentAgentId: 'agent-1' },
      },
      pulses: false,
    },
    {
      child: 'has a result',
      state: { initialProgress: 1, toolArgs: { subagent_type: 'self' } },
      pulses: false,
    },
  ])(
    'pulses the glyph of an unnamed agent only while its child $child, and stops under reduced motion',
    ({ state, pulses }) => {
      renderWithState({ toolCallId: 'glyph-pulse', isSubmitting: true, ...state });
      const glyph = screen.getByRole('button').querySelector<HTMLElement>(FOLD_GLYPH_SELECTOR);
      expect(glyph?.classList.contains('animate-pulse')).toBe(pulses);
      expect(glyph?.classList.contains('motion-reduce:animate-none')).toBe(pulses);
    },
  );

  it('keeps the configured name and avatar after live progress is cleared', () => {
    const { setProgress } = renderWithState({
      toolCallId: 'identity',
      initialProgress: 1,
      toolArgs: { subagent_type: 'agent-1' },
      subagentIdentity: { subagentKind: 'agent', subagentAgentId: 'agent-1' },
      progress: progressFromEvents({
        subagentRunId: 'child-run',
        subagentType: 'agent-1',
        subagentAgentId: 'agent-1',
        status: 'stop',
        events: [],
      }),
    });
    expect(screen.getByText('Analyst One')).toBeInTheDocument();
    expect(screen.getByRole('img', { hidden: true })).toHaveAttribute('src', '/analyst.png');
    setProgress(null);
    expect(screen.getByText('Analyst One')).toBeInTheDocument();
    expect(screen.getByRole('img', { hidden: true })).toHaveAttribute('src', '/analyst.png');
  });

  it.each([undefined, { subagentKind: 'graph' as const, subagentAgentId: 'graph:agent-1' }])(
    'does not infer a saved agent from an ambiguous graph or legacy type',
    (subagentIdentity) => {
      const { getSelection } = renderWithState({
        toolCallId: 'graph-identity',
        initialProgress: 1,
        toolArgs: { subagent_type: 'agent-1' },
        output: 'Graph result',
        subagentIdentity,
      });
      expect(screen.queryByText('Analyst One')).not.toBeInTheDocument();
      const fallbackButton = screen.getByRole('button', { name: 'Ran agent' });
      expect(fallbackButton.querySelector('img')).toBeNull();
      expect(fallbackButton.querySelectorAll('svg').length).toBeGreaterThan(1);
      fireEvent.click(screen.getByRole('button', { name: 'Ran agent' }));
      expect(getSelection()?.subagentIdentity).toEqual(subagentIdentity);
    },
  );

  it.each(['agent-1', 'missing-agent', 'self'])(
    'renders saved identity %s without streaming state',
    (agentId) => {
      renderWithState({
        toolCallId: 'saved-identity',
        initialProgress: 1,
        toolArgs: { subagent_type: agentId },
        subagentIdentity: { subagentKind: 'agent', subagentAgentId: agentId },
      });
      expect(screen.queryByText('Analyst One') != null).toBe(agentId === 'agent-1');
      expect(screen.getByRole('button').querySelector('img') != null).toBe(agentId === 'agent-1');
    },
  );

  it.each([
    ['Running agent', 0.3, true, 'run_step'],
    ['Ran agent', 1, false, undefined],
    ['Cancelled agent', 0.3, false, 'run_step'],
    ['Agent errored', 0.3, true, 'error'],
  ] as const)('renders the %s lifecycle label', (label, initialProgress, isSubmitting, phase) => {
    renderWithState({
      toolCallId: `call-${label}`,
      initialProgress,
      isSubmitting,
      progress:
        phase == null
          ? null
          : progressFromEvents({
              subagentRunId: 'child-run',
              subagentType: 'self',
              status: phase,
              events: [],
            }),
    });
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it.each([
    { output: 'Error: tool call failed: child crashed', runStepStatus: 'completed' as const },
    { output: 'Partial output', runStepStatus: 'failed' as const },
  ])('opens a failed subagent panel from its parent reveal (%p)', (failure) => {
    const rendered = renderWithState({
      toolCallId: 'failed-child',
      initialProgress: 1,
      ...failure,
    });
    expect(screen.getByRole('button', { name: 'Agent errored' })).toBeInTheDocument();
    expect(rendered.getSelection()).toBeNull();

    rendered.reveal();

    expect(rendered.getSelection()).toEqual(
      expect.objectContaining({ toolCallId: 'failed-child' }),
    );
  });

  it('does not reveal a cancelled subagent with error-shaped output', () => {
    const rendered = renderWithState({
      toolCallId: 'cancelled-child',
      initialProgress: 1,
      output: 'Error: tool call failed: abort',
      runStepStatus: 'cancelled',
    });
    expect(screen.getByRole('button', { name: 'Cancelled agent' })).toBeInTheDocument();
    rendered.reveal();
    expect(rendered.getSelection()).toBeNull();
  });

  it('shows the row the child is on, drawn by the thread renderer, over the card and not in its button', () => {
    const progress = progressFromEvents({
      subagentRunId: 'child-run',
      subagentType: 'self',
      status: 'run_step',
      events: [
        event('message_delta', { delta: { content: [{ type: 'text', text: 'Working…' }] } }),
        event('run_step', {
          stepDetails: {
            type: 'tool_calls',
            tool_calls: [{ id: 'inner-1', name: 'calculator', args: '{"value":4}' }],
          },
        }),
      ],
    });
    const rendered = renderWithState({
      toolCallId: 'call-live',
      initialProgress: 0.3,
      isSubmitting: true,
      progress,
    });

    /** One row: the newest part, not the ones before it. */
    const row = screen.getByTestId('thread-row');
    expect(row).toHaveTextContent('calculator');
    expect(row).not.toHaveTextContent('Working…');
    /** Drawn as a live row, or a tool still running would read as one that was stopped. */
    expect(row).toHaveAttribute('data-live', 'true');
    /** And as a picture of that row: it is told so, it takes no artifact from the row it
     *  pictures, and a request to reveal a failure does not reach it. */
    expect(row).toHaveAttribute('data-preview', 'true');
    expect(claimedArtifact).toBeNull();
    rendered.reveal();
    expect(screen.getByTestId('thread-row')).toHaveAttribute('data-reveal', '0');
    const preview = row.closest('[data-subagent-preview]');
    expect(preview).toHaveAttribute('aria-hidden', 'true');
    expect(preview).toHaveAttribute('inert');
    const card = screen.getByRole('button', { name: 'Running agent' });
    expect(card.contains(row)).toBe(false);
    fireEvent.click(card);

    expect(rendered.getSelection()).toEqual(
      expect.objectContaining({
        parentConversationId: 'parent-conversation',
        toolCallId: 'call-live',
        subagentType: 'self',
        initialProgress: 0.3,
        isSubmitting: true,
      }),
    );
    expect(rendered.getSelection()?.durable).toBeUndefined();
  });

  it('says it is starting until the child reports, waiting until it has a row, and shows none once it is done', () => {
    const rendered = renderWithState({
      toolCallId: 'call-waiting',
      initialProgress: 0.3,
      isSubmitting: true,
    });
    expect(screen.getByText('Starting…')).toBeInTheDocument();
    expect(screen.queryByText('Waiting for first update…')).toBeNull();

    rendered.setProgress(
      progressFromEvents({
        subagentRunId: 'child-run',
        subagentType: 'self',
        status: 'start',
        events: [],
      }),
    );
    expect(screen.getByText('Waiting for first update…')).toBeInTheDocument();
    expect(screen.queryByText('Starting…')).toBeNull();
    expect(screen.queryByTestId('thread-row')).toBeNull();

    rendered.setProgress(
      progressFromEvents({
        subagentRunId: 'child-run',
        subagentType: 'self',
        status: 'stop',
        events: [event('message_delta', { delta: { content: [{ type: 'text', text: 'Done' }] } })],
      }),
    );
    expect(screen.queryByText('Waiting for first update…')).toBeNull();
    expect(screen.queryByTestId('thread-row')).toBeNull();
  });

  it('refreshes a long live row only after the throttle window', () => {
    jest.useFakeTimers();
    const progressFor = (text: string) =>
      progressFromEvents({
        subagentRunId: 'child-run',
        subagentType: 'self',
        status: 'message_delta',
        events: [event('message_delta', { delta: { content: [{ type: 'text', text }] } })],
      });
    const first = 'First live preview '.repeat(8).trim();
    const second = 'Second live preview '.repeat(8).trim();
    const rendered = renderWithState({
      toolCallId: 'call-throttle',
      initialProgress: 0.3,
      isSubmitting: true,
      progress: progressFor(first),
    });
    rendered.setProgress(progressFor(second));
    expect(screen.getByTestId('thread-row')).toHaveTextContent(first);
    act(() => jest.advanceTimersByTime(SUBAGENT_TICKER_THROTTLE_MS));
    expect(screen.getByTestId('thread-row')).toHaveTextContent(second);
  });

  describe('a detached child', () => {
    const detachedOutput = JSON.stringify({
      background_task_id: 'task-1',
      subagent_thread_id: 'child-thread-1',
      tool: 'subagent',
      subagent_type: 'agent_reviewer',
      status: 'running',
      message: 'Started subagent background task. Poll with background_task_id task-1.',
    });
    const indexed = (status: ParentSubagentSummary['status']) =>
      new Map([
        [
          'child-thread-1',
          {
            threadId: 'child-thread-1',
            status,
            latestTaskId: 'task-1',
            agentId: 'agent_reviewer',
            tasks: [{ taskId: 'task-1', status }],
          } as ParentSubagentSummary,
        ],
      ]);
    const threadMessages = [
      { messageId: 'task-1:user', isCreatedByUser: true, text: 'Review it' },
      {
        messageId: 'task-1:assistant',
        parentMessageId: 'task-1:user',
        isCreatedByUser: false,
        text: '',
        content: [
          { type: 'text', text: 'Reading the diff' },
          { type: 'tool_call', tool_call: { id: 'c1', name: 'read_file', args: '{}' } },
        ],
      },
    ];
    const mountDetached = () =>
      renderWithState({
        toolCallId: 'detached-live',
        initialProgress: 1,
        output: detachedOutput,
        toolArgs: { subagent_type: 'agent_reviewer', run_in_background: true },
      });

    beforeEach(() => {
      mockUseThreadChat.mockReturnValue({ messages: [], isLoading: true });
      seedQueries = (client) => client.setQueryData(['messages', 'child-thread-1'], threadMessages);
    });

    it('is followed while it runs, once, and shows the row its thread is on', () => {
      mockIndexedChildren = indexed('running');
      mountDetached();

      expect(mockUseThreadChat).toHaveBeenCalledWith('parent-conversation', 'child-thread-1', {
        live: true,
        enabled: true,
      });
      expect(screen.getByTestId('thread-row')).toHaveTextContent('read_file');
      /** Named by the index, which is all that names a child once the parent's stream is gone. */
      expect(
        screen.getByRole('button', {
          name: 'Code Reviewer com_ui_subagent_thread_status_running',
        }),
      ).toBeInTheDocument();
    });

    it('keeps the last row that draws something when an empty label reservation follows it', () => {
      mockIndexedChildren = indexed('running');
      seedQueries = (client) =>
        client.setQueryData(
          ['messages', 'child-thread-1'],
          [
            threadMessages[0],
            {
              ...threadMessages[1],
              content: [
                ...(threadMessages[1].content ?? []),
                { type: 'activity_label', activity_label: '' },
              ],
            },
          ],
        );
      mountDetached();

      expect(screen.getByTestId('thread-row')).toHaveTextContent('read_file');
    });

    it('shows no row for a child the page has no room to follow, whatever was last read for it', () => {
      mockIndexedChildren = indexed('running');
      neighbours = Array.from({ length: MAX_PREVIEWED_THREADS }, (_, n) => (
        <OtherPreview key={n} threadId={`other-thread-${n}`} />
      ));
      mountDetached();

      /** Its messages are in the cache, but nothing is reading its stream, so they are stale. */
      expect(mockUseThreadChat).not.toHaveBeenCalledWith(
        'parent-conversation',
        'child-thread-1',
        expect.anything(),
      );
      expect(screen.queryByTestId('thread-row')).toBeNull();
    });

    it('refreshes a long live row on the throttle, as a foreground child does', async () => {
      jest.useFakeTimers();
      mockIndexedChildren = indexed('running');
      const first = 'First live preview '.repeat(8).trim();
      const second = 'Second live preview '.repeat(8).trim();
      const withText = (text: string) => [
        threadMessages[0],
        { ...threadMessages[1], content: [{ type: 'text', text }] },
      ];
      let cache: QueryClient | undefined;
      seedQueries = (client) => {
        cache = client;
        client.setQueryData(['messages', 'child-thread-1'], withText(first));
      };
      mountDetached();
      expect(screen.getByTestId('thread-row')).toHaveTextContent(first);

      /** The cache tells its readers on a timer; a moment later the newer text has reached the
       *  card and is being held back. */
      await act(async () => {
        cache?.setQueryData(['messages', 'child-thread-1'], withText(second));
        await jest.advanceTimersByTimeAsync(1);
      });
      expect(screen.getByTestId('thread-row')).toHaveTextContent(first);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(SUBAGENT_TICKER_THROTTLE_MS);
      });
      expect(screen.getByTestId('thread-row')).toHaveTextContent(second);
    });

    it('is not followed and shows no row once it has finished', () => {
      mockIndexedChildren = indexed('completed');
      mountDetached();

      expect(mockUseThreadChat).not.toHaveBeenCalled();
      expect(screen.queryByTestId('thread-row')).toBeNull();
    });

    it('asks the index to look again for a child it does not list, once', async () => {
      mountDetached();

      await waitFor(() => expect(mockRefetchIndex).toHaveBeenCalledTimes(1));
      expect(mockUseThreadChat).not.toHaveBeenCalled();
    });
  });

  it('opens a foreground legacy invocation in the shared panel with persisted activity', () => {
    let selection: ActiveSubagentPanel | null = null;
    const Observer = () => {
      selection = useAtomValue(activeSubagentPanel);
      return null;
    };
    const persistedContent = [
      { type: 'think', think: 'Visible reasoning.' },
      {
        type: 'tool_call',
        tool_call: { id: 'inner-1', name: 'calculator', args: '{}', output: '4', progress: 1 },
      },
      { type: 'text', text: 'The answer is 4.' },
    ] as Parameters<typeof SubagentCall>[0]['persistedContent'];
    currentMessage = { messageId: 'parent', conversationId: 'parent-conversation' };
    render(
      <Providers>
        <Observer />
        <SubagentCall
          toolCallId="foreground-call"
          initialProgress={1}
          args={{ subagent_type: 'self', description: 'Compute the answer.' }}
          output="legacy fallback"
          persistedContent={persistedContent}
        />
      </Providers>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Ran agent' }));
    expect(selection).toEqual(
      expect.objectContaining({
        prompt: 'Compute the answer.',
        legacyOutput: 'legacy fallback',
        persistedContent,
      }),
    );
    expect((selection as ActiveSubagentPanel | null)?.durable).toBeUndefined();
  });

  it.each([
    { threadId: 'child-thread-1', taskId: 'task-2', parentConversationId: 'parent-conversation' },
    { threadId: 'child-thread-2', taskId: 'task-1', parentConversationId: 'parent-conversation' },
    { threadId: 'child-thread-1', taskId: 'task-1', parentConversationId: 'other-conversation' },
  ])('does not replace a retained task on dispatch remount: %p', (identity) => {
    const retained: ActiveSubagentPanel = {
      host: 'conversation',
      parentConversationId: identity.parentConversationId,
      parentMessageId: 'parent-message',
      toolCallId: 'detached-call',
      partIndex: 0,
      subagentType: 'self',
      initialProgress: 0,
      isSubmitting: false,
      durable: { threadId: identity.threadId, taskId: identity.taskId },
    };
    const rendered = renderWithState({
      toolCallId: 'detached-call',
      initialProgress: 1,
      output: JSON.stringify({
        background_task_id: 'task-1',
        subagent_thread_id: 'child-thread-1',
        tool: 'subagent',
        subagent_type: 'self',
        status: 'running',
      }),
      toolArgs: { subagent_type: 'self', run_in_background: true },
      selection: retained,
    });
    expect(rendered.getSelection()).toBe(retained);
  });

  it('opens an exact host-issued detached invocation in the same panel', () => {
    const output = JSON.stringify({
      background_task_id: 'task-1',
      subagent_thread_id: 'child-thread-1',
      tool: 'subagent',
      subagent_type: 'self',
      status: 'running',
      message:
        'Started subagent "self" background task. Poll the host background-task tool with background_task_id "task-1".',
    });
    const rendered = renderWithState({
      toolCallId: 'detached-call',
      initialProgress: 1,
      output,
      toolArgs: { subagent_type: 'self', run_in_background: true },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Agent activity' }));
    expect(rendered.getSelection()).toEqual(
      expect.objectContaining({
        toolCallId: 'detached-call',
        durable: { threadId: 'child-thread-1', taskId: 'task-1' },
      }),
    );
    expect(rendered.getSelection()?.legacyOutput).toBeUndefined();
  });

  it('leads a detached agent card with its name, face and the indexed task status', () => {
    const output = JSON.stringify({
      background_task_id: 'task-1',
      subagent_thread_id: 'child-thread-1',
      tool: 'subagent',
      subagent_type: 'agent_reviewer',
      status: 'running',
      message:
        'Started subagent "agent_reviewer" background task. Poll the host background-task tool with background_task_id "task-1".',
    });
    mockIndexedChildren = new Map([
      [
        'child-thread-1',
        {
          threadId: 'child-thread-1',
          status: 'completed',
          latestTaskId: 'task-1',
          tasks: [{ taskId: 'task-1', status: 'completed' }],
        } as ParentSubagentSummary,
      ],
    ]);
    /** Saved identity disambiguates agent ids from graph aliases. */
    renderWithState({
      toolCallId: 'named-detached',
      initialProgress: 1,
      subagentIdentity: { subagentKind: 'agent', subagentAgentId: 'agent_reviewer' },
      output,
      toolArgs: { subagent_type: 'agent_reviewer', run_in_background: true },
    });

    const card = screen.getByRole('button', {
      name: 'Code Reviewer com_ui_subagent_thread_status_completed',
    });
    expect(within(card).getByText('Code Reviewer')).toBeInTheDocument();
    expect(within(card).getByRole('img', { hidden: true })).toHaveAttribute('src', '/reviewer.png');
    expect(within(card).getByText('com_ui_subagent_thread_status_completed')).toBeInTheDocument();
    expect(within(card).queryByText(/agent_reviewer/)).not.toBeInTheDocument();
  });

  it.each(['self', 'researcher', 'agent_missing'])(
    'exposes the indexed outcome for an unnamed detached %s child',
    (subagentType) => {
      mockIndexedChildren = new Map([
        [
          'child-thread-1',
          {
            threadId: 'child-thread-1',
            latestTaskId: 'task-1',
            status: 'failed',
            tasks: [{ taskId: 'task-1', status: 'failed' }],
          } as ParentSubagentSummary,
        ],
      ]);
      renderWithState({
        toolCallId: 'unnamed-detached',
        initialProgress: 1,
        toolArgs: { subagent_type: subagentType, run_in_background: true },
        output: JSON.stringify({
          background_task_id: 'task-1',
          subagent_thread_id: 'child-thread-1',
          tool: 'subagent',
          subagent_type: subagentType,
          status: 'running',
          message: 'Started subagent background task. Poll with background_task_id task-1.',
        }),
      });
      expect(
        screen.getByRole('button', { name: 'com_ui_subagent_thread_status_failed' }),
      ).not.toHaveAttribute('aria-label');
    },
  );

  it('keeps the neutral label for a detached child the index has not reported', () => {
    const output = JSON.stringify({
      background_task_id: 'task-1',
      subagent_thread_id: 'child-thread-1',
      tool: 'subagent',
      subagent_type: 'agent_reviewer',
      status: 'running',
      message:
        'Started subagent "agent_reviewer" background task. Poll the host background-task tool with background_task_id "task-1".',
    });
    renderWithState({
      toolCallId: 'unindexed-detached',
      initialProgress: 1,
      subagentIdentity: { subagentKind: 'agent', subagentAgentId: 'agent_reviewer' },
      output,
      toolArgs: { subagent_type: 'agent_reviewer', run_in_background: true },
    });

    const card = screen.getByRole('button', { name: 'Code Reviewer Agent activity' });
    expect(within(card).getByText('Agent activity')).toBeInTheDocument();
  });

  it('opens with the subagent whose thread it sits in as its caller, and with none in main chat', () => {
    let selection: ActiveSubagentPanel | null = null;
    const Observer = () => {
      selection = useAtomValue(activeSubagentPanel);
      return null;
    };
    const card = (
      <SubagentCall
        toolCallId="relayed-call"
        initialProgress={1}
        args={{ subagent_type: 'agent-1', description: 'Report the total.' }}
        output="The total is 4217."
      />
    );
    currentMessage = { messageId: 'parent', conversationId: 'parent-conversation' };
    const { unmount } = render(
      <Providers>
        <Observer />
        {card}
      </Providers>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Ran agent/ }));
    expect(selection).toEqual(expect.objectContaining({ toolCallId: 'relayed-call' }));
    expect((selection as ActiveSubagentPanel | null)?.caller).toBeUndefined();
    unmount();

    selection = null;
    currentMessage = {
      messageId: 'parent:outer-call:assistant',
      conversationId: 'parent-conversation',
    };
    render(
      <Providers>
        <Observer />
        <SubagentCallerContext.Provider value={{ agentId: 'agent_relay', name: 'Relay' }}>
          {card}
        </SubagentCallerContext.Provider>
      </Providers>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Ran agent/ }));
    expect((selection as ActiveSubagentPanel | null)?.caller).toEqual({
      agentId: 'agent_relay',
      name: 'Relay',
    });
  });

  it('disables an inaccessible nested detached drilldown without renderable activity', () => {
    const output = JSON.stringify({
      background_task_id: 'task-1',
      subagent_thread_id: 'child-thread-1',
      tool: 'subagent',
      subagent_type: 'self',
      status: 'running',
      message:
        'Started subagent "self" background task. Poll the host background-task tool with background_task_id "task-1".',
    });

    currentMessage = { messageId: 'nested-message', conversationId: null };
    render(
      <Providers>
        <SubagentCall
          toolCallId="nested-detached-call"
          initialProgress={1}
          args={{ subagent_type: 'self', run_in_background: true }}
          output={output}
        />
      </Providers>,
    );

    expect(screen.getByRole('button', { name: 'Agent activity' })).toBeDisabled();
  });

  it('disables a nested fallback that cannot remain attached to the conversation host', () => {
    currentMessage = { messageId: 'nested-message', conversationId: null };
    render(
      <Providers>
        <SubagentCall
          toolCallId="nested-foreground-call"
          initialProgress={1}
          args={{ subagent_type: 'self' }}
          output="Nested result"
        />
      </Providers>,
    );

    expect(screen.getByRole('button', { name: 'Ran agent' })).toBeDisabled();
  });

  /** Search results render this same card through `Part`, and that route is not
   *  a chat surface, so there is no panel on it to open. The card still has to
   *  render; it just cannot be opened from there. */
  it('renders outside a chat surface with its details control disabled', () => {
    currentMessage = { messageId: 'parent', conversationId: 'parent-conversation' };
    render(
      <Providers surface={false}>
        <SubagentCall
          toolCallId="hostless-call"
          initialProgress={1}
          args={{ subagent_type: 'self', description: 'Compute the answer.' }}
          output="A result worth reading."
        />
      </Providers>,
    );

    expect(screen.getByRole('button', { name: 'Ran agent' })).toBeDisabled();
  });

  /** A tool inside the run saves its MCP App under the child call id, so the
   *  standalone card is the only row that can show it. */
  it('renders the MCP Apps its run produced beside its files', () => {
    const app = {
      type: 'ui_resources',
      toolCallId: 'child-app-call',
      ui_resources: [{ uri: 'ui://e2e/app', toolName: 'show_app', serverName: 'e2e-app' }],
    } as unknown as TAttachment;
    currentMessage = { messageId: 'parent', conversationId: 'parent-conversation' };
    const tree = (hideAttachments: boolean) => (
      <Providers>
        <SubagentCall
          toolCallId="app-call"
          initialProgress={1}
          args={{ subagent_type: 'self', description: 'Show the app.' }}
          output="Shown."
          attachments={[app]}
          hideAttachments={hideAttachments}
        />
      </Providers>
    );
    const rendered = render(tree(false));

    expect(JSON.parse(screen.getByTestId('app-views').textContent ?? '')).toEqual([app]);

    rendered.rerender(tree(true));
    expect(screen.queryByTestId('app-views')).toBeNull();
  });

  it('keeps model-authored lookalike output on the foreground adapter', () => {
    const output = JSON.stringify({
      background_task_id: 'task-1',
      subagent_thread_id: 'child-thread-1',
      tool: 'subagent',
      subagent_type: 'self',
      status: 'running',
      message: 'background_task_id task-1',
    });
    const rendered = renderWithState({
      toolCallId: 'spoofed-call',
      initialProgress: 1,
      output,
      toolArgs: { subagent_type: 'self' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Ran agent' }));
    expect(rendered.getSelection()?.durable).toBeUndefined();
    expect(rendered.getSelection()?.legacyOutput).toBe(output);
  });
});

describe('a subagent call the parent is still writing', () => {
  const openSelection: ActiveSubagentPanel = {
    host: 'conversation',
    parentConversationId: 'parent-conversation',
    parentMessageId: 'parent-message',
    toolCallId: 'writing',
    partIndex: 0,
    subagentType: '',
    initialProgress: 0,
    isSubmitting: true,
  };

  function renderWriting(
    toolArgs: string | Record<string, unknown>,
    options: { preparationStartedAt?: number; progress?: SubagentProgress } = {},
  ) {
    let selection: ActiveSubagentPanel | null = null;
    const SelectionObserver = () => {
      selection = useAtomValue(activeSubagentPanel);
      return null;
    };
    const tree = (args: string | Record<string, unknown>) => (
      <Providers
        seed={(store) => {
          store.set(activeSubagentPanel, openSelection);
          if (options.progress != null) {
            store.set(
              subagentProgressByToolCallId(subagentProgressKey('parent-message', 'writing', 0)),
              options.progress,
            );
          }
        }}
      >
        <SelectionObserver />
        <ToolPreparation
          call={{
            name: 'subagent',
            args,
            ...(options.preparationStartedAt == null
              ? {}
              : { toolPreparationStartedAt: options.preparationStartedAt }),
          }}
          isSubmitting
        >
          <SubagentCall toolCallId="writing" initialProgress={0.1} isSubmitting args={args} />
        </ToolPreparation>
      </Providers>
    );
    const rendered = render(tree(toolArgs));
    return {
      ...rendered,
      getSelection: () => selection,
      write: (next: string | Record<string, unknown>) => rendered.rerender(tree(next)),
    };
  }

  const card = () => screen.getByRole('button');
  const pendingFace = () => card().querySelector('[data-subagent-pending-face]');

  it('starts as a generic placeholder while nothing of the call is known', () => {
    renderWriting('{"inte');
    expect(card()).toHaveAccessibleName('Starting a subagent, Writing the brief…');
    expect(screen.getByText('Starting a subagent')).toHaveClass('shimmer');
    expect(screen.getByText('Writing the brief…')).not.toHaveClass('shimmer');
    expect(pendingFace()).not.toBeNull();
    expect(card().querySelector(FOLD_GLYPH_SELECTOR)).not.toHaveClass('animate-pulse');
    expect(screen.queryByText('Waiting for first update…')).toBeNull();
    expect(screen.queryByText(/Preparing/)).toBeNull();
  });

  it('takes the intent as its title as soon as it streams, and sweeps the waiting line instead', () => {
    renderWriting('{"intent":"Asking the reviewer to restate its findings","description":"Ask');
    expect(card()).toHaveAccessibleName(
      'Asking the reviewer to restate its findings, Writing the brief…',
    );
    expect(screen.getByText('Writing the brief…')).toHaveClass('shimmer');
    expect(pendingFace()).not.toBeNull();
  });

  it('names the agent once the requested type has closed, and not from a half-written one', () => {
    const head = '{"intent":"Reviewing","description":"Look at the change","subagent_type":"agent-';
    const { write } = renderWriting(head);
    expect(screen.queryByText('Analyst One')).toBeNull();
    expect(pendingFace()).not.toBeNull();

    write(`${head}1"`);
    expect(screen.getByText('Analyst One')).toBeInTheDocument();
    expect(screen.getByRole('img', { hidden: true })).toHaveAttribute('src', '/analyst.png');
    expect(pendingFace()).toBeNull();
    expect(card()).toHaveAccessibleName('Analyst One: Reviewing, Writing the brief…');
  });

  it('shows no name for a self-spawn, which keeps the pending face until it starts', () => {
    renderWriting('{"intent":"Reviewing","description":"Look","subagent_type":"self"');
    expect(screen.getByText('Reviewing')).toBeInTheDocument();
    expect(pendingFace()).not.toBeNull();
  });

  it('says it is starting once the call is written but the child has not reported', () => {
    renderWriting('{"intent":"Reviewing","description":"Look","subagent_type":"agent-1"}', {
      preparationStartedAt: 100,
    });
    expect(card()).toHaveAccessibleName('Analyst One: Reviewing, Starting…');
    expect(screen.getByText('Starting…')).toHaveClass('shimmer');
    expect(screen.queryByText('Writing the brief…')).toBeNull();
  });

  it('goes back to the child’s own progress once it reports', () => {
    renderWriting('{"intent":"Reviewing","description":"Look","subagent_type":"agent-1"}', {
      progress: progressFromEvents({
        subagentRunId: 'child-run',
        subagentType: 'agent-1',
        subagentAgentId: 'agent-1',
        status: 'start',
        events: [],
      }),
    });
    expect(screen.getByText('Waiting for first update…')).toBeInTheDocument();
    expect(screen.queryByText('Starting…')).toBeNull();
    expect(screen.getByText('Analyst One')).toBeInTheDocument();
    expect(pendingFace()).toBeNull();
  });

  it('streams the brief into the open panel and says when it is no longer being written', () => {
    const { write, getSelection } = renderWriting(
      '{"intent":"Reviewing","description":"Look at the \\"change\\" and',
    );
    expect(getSelection()?.briefing).toBe(true);
    expect(getSelection()?.prompt).toBe('Look at the "change" and');
    expect(getSelection()?.subagentType).toBe('');

    write('{"intent":"Reviewing","description":"Look at the change","subagent_type":"agent-1"}');
    expect(getSelection()?.briefing).toBeUndefined();
    expect(getSelection()?.prompt).toBe('Look at the change');
    expect(getSelection()?.subagentType).toBe('agent-1');
  });
});
