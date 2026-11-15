/**
 * @jest-environment jsdom
 */
import React, { useState } from 'react';
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
import PackageSubagentCall, { SUBAGENT_TICKER_THROTTLE_MS } from '../SubagentCall';
import { ParentSubagentsProvider } from '../../../react/subagents/parents';
import { createSubagentsHost } from '../../../__fixtures__/subagentsHost';
import { createMessagePartsHost } from '../../../__fixtures__/partsHost';
import { ChatSurfaceProvider } from '../../../react/subagents/provider';
import { SubagentsHostProvider } from '../../../react/subagents/host';
import { StreamHostProvider } from '../../../react/stream/host';
import { MessagePartsHostProvider } from '../../../react/host';
import { FailedRevealContext } from '../reveal';
import { FOLD_GLYPH_SELECTOR } from '../rows';
import { litFoldPath } from '../rail';

const mockMCPServerNames: string[] = [];
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
      mcpServerNames={mockMCPServerNames}
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
const partsHost = createMessagePartsHost();

const subagentsHost = createSubagentsHost({
  useAgentsMap: () => agents,
});

const streamHost = {
  useParentSubagentIndex: () => ({
    data: {
      parentConversationId: 'parent-conversation',
      children: [...mockIndexedChildren.values()],
      childrenTruncated: false,
    },
    isError: false,
    refetch: async () => ({ data: undefined }),
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
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  const card = (
    <FailedRevealContext.Provider value={{ tick, claimFocus: () => true }}>
      <MessagePartsHostProvider host={partsHost}>{children}</MessagePartsHostProvider>
    </FailedRevealContext.Provider>
  );
  return (
    <QueryClientProvider client={queryClient}>
      <StreamHostProvider host={streamHost}>
        <ParentSubagentsProvider conversationId="parent-conversation" enabled>
          <JotaiProvider store={store}>
            <SubagentsHostProvider host={subagentsHost}>
              {withSurface ? (
                <ChatSurfaceProvider value={surface}>{card}</ChatSurfaceProvider>
              ) : (
                card
              )}
            </SubagentsHostProvider>
          </JotaiProvider>
        </ParentSubagentsProvider>
      </StreamHostProvider>
    </QueryClientProvider>
  );
}

afterEach(() => {
  jest.useRealTimers();
  mockMCPServerNames.length = 0;
  mockIndexedChildren = new Map();
  currentMessage = defaultMessage;
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
      state: { initialProgress: 0.1, toolArgs: { subagent_type: 'self' } },
      pulses: true,
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

  it('keeps the compact semantic ticker while selecting the shared panel', async () => {
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

    await waitFor(() => expect(screen.getByText('Using')).toBeInTheDocument());
    expect(screen.getByText('Working…')).toBeInTheDocument();
    expect(screen.queryByText('Writing')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Running agent' }));

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

  it('preserves a configured MCP server boundary in the live ticker', () => {
    mockMCPServerNames.push('Google_mcp_Workspace');
    renderWithState({
      toolCallId: 'call_mcp_ticker',
      initialProgress: 0.3,
      isSubmitting: true,
      progress: progressFromEvents({
        subagentRunId: 'run_a',
        subagentType: 'self',
        status: 'run_step',
        events: [
          {
            runId: 'p',
            subagentRunId: 'run_a',
            subagentType: 'self',
            phase: 'run_step',
            data: {
              stepDetails: {
                type: 'tool_calls',
                tool_calls: [
                  {
                    id: 'c1',
                    name: 'search_documents_mcp_Google_mcp_Workspace',
                  },
                ],
              },
            },
            timestamp: '',
          } as SubagentUpdateEvent,
        ],
      }),
    });

    expect(screen.getByText('Google_mcp_Workspace')).toBeInTheDocument();
  });

  it('refreshes a long ticker preview only after the throttle window', () => {
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
    const card = within(screen.getByRole('button', { name: 'Running agent' }));
    rendered.setProgress(progressFor(second));
    expect(card.getByText(first)).toBeInTheDocument();
    act(() => jest.advanceTimersByTime(SUBAGENT_TICKER_THROTTLE_MS));
    expect(card.getByText(second)).toBeInTheDocument();
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
