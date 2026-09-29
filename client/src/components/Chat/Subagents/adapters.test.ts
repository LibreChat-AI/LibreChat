import { ContentTypes } from 'librechat-data-provider';
import type {
  SubagentThreadView,
  SubagentUpdateEvent,
  TMessageContentParts,
} from 'librechat-data-provider';
import type { ChildConversationTurn } from './adapters';
import {
  adaptDurableThreadActivity,
  adaptLivePersistedActivity,
  MAX_RETAINED_MOVING_WINDOW_TURNS,
  mergeChildConversationTurns,
  retainBoundedMovingWindowTurns,
} from './adapters';
import {
  aggregateSubagentContent,
  initSubagentAggregatorState,
  initSubagentTickerState,
} from '~/utils/subagentContent';

describe('child activity adapters', () => {
  it('passes child dispatch and completed durations to the generic tool card', () => {
    const progress = {
      subagentRunId: 'child',
      subagentType: 'researcher',
      status: 'tool_calls_dispatched' as const,
      contentParts: aggregateSubagentContent([
        {
          runId: 'parent',
          subagentRunId: 'child',
          subagentType: 'researcher',
          subagentAgentId: 'agent',
          timestamp: '2026-09-28T00:00:00Z',
          phase: 'run_step',
          data: {
            id: 'step-child',
            stepDetails: {
              type: 'tool_calls',
              tool_calls: [{ id: 'call-child', name: 'query', args: '{}' }],
            },
          },
        },
        {
          runId: 'parent',
          subagentRunId: 'child',
          subagentType: 'researcher',
          subagentAgentId: 'agent',
          timestamp: '2026-09-28T00:00:00Z',
          phase: 'tool_calls_dispatched',
          data: {
            dispatched_at: 500,
            toolCalls: [{ id: 'call-child', stepId: 'step-child' }],
          },
        },
      ]),
      aggregatorState: initSubagentAggregatorState(),
      tickerState: initSubagentTickerState(),
      coverage: 'complete' as const,
    };
    expect(
      adaptLivePersistedActivity({
        title: 'researcher',
        progress,
        persistedContent: undefined,
        initialProgress: 0.1,
        isSubmitting: true,
      }).items[0],
    ).toMatchObject({
      type: 'tool',
      toolCallId: 'call-child',
      toolDispatchedAt: 500,
      status: 'running',
    });
    const persisted = adaptLivePersistedActivity({
      title: 'researcher',
      progress: null,
      persistedContent: [
        {
          type: ContentTypes.TOOL_CALL,
          tool_call: {
            id: 'call-child',
            name: 'query',
            args: '{}',
            output: 'ok',
            progress: 1,
            toolPreparationDurationMs: 400,
            toolExecutionDurationMs: 40,
          },
        },
      ] as TMessageContentParts[],
      initialProgress: 1,
      isSubmitting: false,
    });
    expect(persisted.items[0]).toMatchObject({
      type: 'tool',
      toolCallId: 'call-child',
      toolPreparationDurationMs: 400,
      toolExecutionDurationMs: 40,
      status: 'completed',
    });
  });
  it('prefers authoritative parent persistence over a partial live foreground trace', () => {
    const activity = adaptLivePersistedActivity({
      title: 'researcher',
      progress: {
        subagentRunId: 'run',
        subagentType: 'researcher',
        status: 'message_delta',
        contentParts: [{ type: ContentTypes.TEXT, text: 'Partial live text.' }],
        aggregatorState: initSubagentAggregatorState(),
        tickerState: initSubagentTickerState(),
      },
      persistedContent: [
        { type: 'think', think: 'Visible reasoning.' },
        {
          type: 'tool_call',
          tool_call: {
            id: 'tool-1',
            name: 'search',
            args: '{"query":"release"}',
            output: 'Found it.',
            progress: 1,
          },
        },
        { type: 'text', text: 'Persisted answer.' },
      ] as unknown as TMessageContentParts[],
      initialProgress: 1,
      isSubmitting: false,
    });

    expect(activity.items).toEqual([
      { type: 'reasoning', text: 'Visible reasoning.' },
      expect.objectContaining({
        type: 'tool',
        toolCallId: 'tool-1',
        name: 'search',
        status: 'completed',
      }),
      { type: 'writing', text: 'Persisted answer.' },
    ]);
  });

  it('preserves regular-chat reasoning and parent phase labels at the adapter seam', () => {
    const activity = adaptLivePersistedActivity({
      title: 'researcher',
      progress: null,
      persistedContent: [
        {
          type: ContentTypes.THINK,
          think: 'Visible reasoning.',
          reasoning_label: 'Checked constraints',
        },
        { type: ContentTypes.TEXT, text: 'Prepared the answer.', phase: 'commentary' },
        {
          type: ContentTypes.ACTIVITY_LABEL,
          activity_label: 'Prepared the release',
          activity_label_type: 'phase',
          activity_start_index: 0,
          activity_end_index: 2,
          activity_count: 2,
          status: 'ok',
        },
      ] as TMessageContentParts[],
      initialProgress: 1,
      isSubmitting: false,
    });

    expect(activity.items).toEqual([
      { type: 'reasoning', text: 'Visible reasoning.', label: 'Checked constraints' },
      { type: 'writing', text: 'Prepared the answer.', phase: 'commentary' },
      {
        type: 'activity_label',
        label: 'Prepared the release',
        labelType: 'phase',
        activityStartIndex: 0,
        activityEndIndex: 2,
        activityCount: 2,
        status: 'ok',
      },
    ]);
  });

  it('preserves blank activity labels as regular-chat grouping boundaries', () => {
    const activity = adaptLivePersistedActivity({
      title: 'researcher',
      progress: null,
      persistedContent: [
        {
          type: ContentTypes.TOOL_CALL,
          tool_call: { id: 'tool-1', name: 'search', args: '{}', output: 'first', progress: 1 },
        },
        {
          type: ContentTypes.ACTIVITY_LABEL,
          activity_label: '   ',
        },
        {
          type: ContentTypes.TOOL_CALL,
          tool_call: {
            id: 'tool-2',
            name: 'calculator',
            args: '{}',
            output: 'second',
            progress: 1,
          },
        },
        {
          type: ContentTypes.ACTIVITY_LABEL,
          activity_label: 'Calculated the answer',
        },
      ] as TMessageContentParts[],
      initialProgress: 1,
      isSubmitting: false,
    });

    expect(activity.items).toEqual([
      expect.objectContaining({ type: 'tool', toolCallId: 'tool-1' }),
      { type: 'activity_label', label: '' },
      expect.objectContaining({ type: 'tool', toolCallId: 'tool-2' }),
      { type: 'activity_label', label: 'Calculated the answer' },
    ]);
  });

  it('merges a forward-only detached suffix with the partial parent snapshot', () => {
    const activity = adaptLivePersistedActivity({
      title: 'researcher',
      progress: {
        subagentRunId: 'run',
        subagentType: 'researcher',
        status: 'message_delta',
        contentParts: [{ type: ContentTypes.TEXT, text: 'latest detached text.' }],
        aggregatorState: initSubagentAggregatorState(),
        tickerState: initSubagentTickerState(),
        coverage: 'suffix',
      },
      persistedContent: [
        { type: ContentTypes.TEXT, text: 'Dispatch-time snapshot; ' },
      ] as TMessageContentParts[],
      initialProgress: 1,
      isSubmitting: true,
      isDetached: true,
    });

    expect(activity.items).toEqual([
      { type: 'writing', text: 'Dispatch-time snapshot; latest detached text.' },
    ]);
  });

  it('retains the persisted phase when an unphased detached suffix continues it', () => {
    const activity = adaptLivePersistedActivity({
      title: 'researcher',
      progress: {
        subagentRunId: 'run',
        subagentType: 'researcher',
        status: 'message_delta',
        contentParts: [{ type: ContentTypes.TEXT, text: 'continued.' }],
        aggregatorState: initSubagentAggregatorState(),
        tickerState: initSubagentTickerState(),
        coverage: 'suffix',
      },
      persistedContent: [
        { type: ContentTypes.TEXT, text: 'Commentary ', phase: 'commentary' },
      ] as TMessageContentParts[],
      initialProgress: 1,
      isSubmitting: true,
      isDetached: true,
    });

    expect(activity.items).toEqual([
      { type: 'writing', text: 'Commentary continued.', phase: 'commentary' },
    ]);
  });

  it('does not merge detached writing across explicit phase boundaries', () => {
    const liveParts = aggregateSubagentContent([
      {
        runId: 'parent-run',
        subagentRunId: 'run',
        subagentType: 'researcher',
        subagentAgentId: 'child',
        phase: 'run_step',
        timestamp: '2026-08-23T00:00:00Z',
        data: {
          id: 'final-step',
          stepDetails: {
            type: 'message_creation',
            message_creation: { phase: 'final_answer' },
          },
        },
      },
      {
        runId: 'parent-run',
        subagentRunId: 'run',
        subagentType: 'researcher',
        subagentAgentId: 'child',
        phase: 'message_delta',
        timestamp: '2026-08-23T00:00:01Z',
        data: {
          id: 'final-step',
          delta: { content: [{ type: ContentTypes.TEXT, text: 'Final answer.' }] },
        },
      },
    ] satisfies SubagentUpdateEvent[]);
    const activity = adaptLivePersistedActivity({
      title: 'researcher',
      progress: {
        subagentRunId: 'run',
        subagentType: 'researcher',
        status: 'message_delta',
        contentParts: liveParts,
        aggregatorState: initSubagentAggregatorState(),
        tickerState: initSubagentTickerState(),
        coverage: 'suffix',
      },
      persistedContent: [
        { type: ContentTypes.TEXT, text: 'Commentary.', phase: 'commentary' },
      ] as TMessageContentParts[],
      initialProgress: 1,
      isSubmitting: true,
      isDetached: true,
    });

    expect(activity.items).toEqual([
      { type: 'writing', text: 'Commentary.', phase: 'commentary' },
      { type: 'writing', text: 'Final answer.', phase: 'final_answer' },
    ]);
  });

  it('preserves schema-validation failures on reconstructed question tools', () => {
    const liveParts = aggregateSubagentContent([
      {
        runId: 'parent-run',
        subagentRunId: 'run',
        subagentType: 'researcher',
        subagentAgentId: 'child',
        phase: 'run_step_completed',
        timestamp: '2026-08-23T00:00:00Z',
        data: {
          result: {
            type: 'tool_call',
            tool_call: {
              id: 'question-1',
              name: 'ask_user_question',
              args: '{}',
              output: 'Invalid question schema',
              progress: 1,
              inputValidationError: true,
            },
          },
        },
      },
    ] satisfies SubagentUpdateEvent[]);
    const activity = adaptLivePersistedActivity({
      title: 'researcher',
      progress: {
        subagentRunId: 'run',
        subagentType: 'researcher',
        status: 'run_step_completed',
        contentParts: liveParts,
        aggregatorState: initSubagentAggregatorState(),
        tickerState: initSubagentTickerState(),
      },
      initialProgress: 1,
      isSubmitting: false,
    });

    expect(activity.items).toEqual([
      expect.objectContaining({
        type: 'tool',
        toolCallId: 'question-1',
        status: 'completed',
        inputValidationError: true,
      }),
    ]);
  });

  it('uses a complete parent-stream projection without duplicating persistence', () => {
    const activity = adaptLivePersistedActivity({
      title: 'researcher',
      progress: {
        subagentRunId: 'run',
        subagentType: 'researcher',
        status: 'message_delta',
        contentParts: [{ type: ContentTypes.TEXT, text: 'Complete live text.' }],
        aggregatorState: initSubagentAggregatorState(),
        tickerState: initSubagentTickerState(),
        coverage: 'complete',
      },
      persistedContent: [{ type: ContentTypes.TEXT, text: 'Complete ' }] as TMessageContentParts[],
      initialProgress: 1,
      isSubmitting: true,
      isDetached: true,
    });

    expect(activity.items).toEqual([{ type: 'writing', text: 'Complete live text.' }]);
  });

  it('appends coincident text in a forward-only suffix', () => {
    const activity = adaptLivePersistedActivity({
      title: 'researcher',
      progress: {
        subagentRunId: 'run',
        subagentType: 'researcher',
        status: 'message_delta',
        contentParts: [{ type: ContentTypes.TEXT, text: 'ha' }],
        aggregatorState: initSubagentAggregatorState(),
        tickerState: initSubagentTickerState(),
        coverage: 'suffix',
      },
      persistedContent: [{ type: ContentTypes.TEXT, text: 'ha' }] as TMessageContentParts[],
      initialProgress: 1,
      isSubmitting: true,
      isDetached: true,
    });

    expect(activity.items).toEqual([{ type: 'writing', text: 'haha' }]);
  });

  it('preserves persisted tool fields when a sparse completion is the live suffix', () => {
    const activity = adaptLivePersistedActivity({
      title: 'researcher',
      progress: {
        subagentRunId: 'run',
        subagentType: 'researcher',
        status: 'run_step_completed',
        contentParts: [
          {
            type: ContentTypes.TOOL_CALL,
            tool_call: {
              id: 'tool-1',
              name: '',
              args: '{}',
              output: 'Found it.',
              progress: 1,
            },
          },
        ],
        aggregatorState: initSubagentAggregatorState(),
        tickerState: initSubagentTickerState(),
        coverage: 'suffix',
      },
      persistedContent: [
        {
          type: ContentTypes.TOOL_CALL,
          tool_call: {
            id: 'tool-1',
            name: 'search',
            args: '{"query":"release"}',
            progress: 0.1,
          },
        },
      ] as unknown as TMessageContentParts[],
      initialProgress: 1,
      isSubmitting: true,
      isDetached: true,
    });

    expect(activity.items).toEqual([
      expect.objectContaining({
        type: 'tool',
        name: 'search',
        input: '{"query":"release"}',
        output: 'Found it.',
        status: 'completed',
      }),
    ]);
  });

  it('rehydrates the selected detached task from its sanitized durable activity', () => {
    const view: SubagentThreadView = {
      threadId: 'thread',
      parentConversationId: 'parent',
      parentMessageId: 'parent-message',
      parentToolCallId: 'parent-tool',
      subagentType: 'researcher',
      subagentKind: 'agent',
      title: 'Research child',
      status: 'completed',
      activity: [
        {
          type: 'tool',
          toolCallId: 'tool-1',
          name: 'search',
          input: '{"query":"release"}',
          output: 'Found it.',
          status: 'completed',
          inputValidationError: true,
        },
        { type: 'writing', text: 'Durable answer.' },
      ],
      activityTruncated: false,
      messages: [
        {
          messageId: 'task:user',
          parentMessageId: null,
          role: 'user',
          text: 'Investigate the release.',
        },
        {
          messageId: 'task:assistant',
          parentMessageId: 'task:user',
          role: 'assistant',
          text: 'Durable answer.',
        },
      ],
      historyTruncated: false,
    };

    expect(adaptDurableThreadActivity(view, 'task')).toEqual(
      expect.objectContaining({
        title: 'Research child',
        prompt: 'Investigate the release.',
        status: 'completed',
        items: view.activity,
      }),
    );
    expect(adaptDurableThreadActivity(view, 'task').items[0]).toEqual(
      expect.objectContaining({ inputValidationError: true }),
    );
  });

  it('keeps live reasoning text like the main chat view', () => {
    const activity = adaptLivePersistedActivity({
      title: 'researcher',
      progress: null,
      persistedContent: [
        { type: ContentTypes.THINK, think: 'visible live reasoning' },
        { type: ContentTypes.TEXT, text: 'Visible answer.' },
      ] as TMessageContentParts[],
      initialProgress: 0,
      isSubmitting: true,
    });

    expect(activity.items).toEqual([
      { type: 'reasoning', text: 'visible live reasoning' },
      { type: 'writing', text: 'Visible answer.' },
    ]);
  });

  it('normalizes a pre-retention redaction marker back to a textless reasoning item', () => {
    const activity = adaptLivePersistedActivity({
      title: 'researcher',
      progress: null,
      persistedContent: [
        { type: ContentTypes.THINK, think: '…' },
        { type: ContentTypes.TEXT, text: 'Visible answer.' },
      ] as TMessageContentParts[],
      initialProgress: 0,
      isSubmitting: true,
    });

    expect(activity.items).toEqual([
      { type: 'reasoning' },
      { type: 'writing', text: 'Visible answer.' },
    ]);
  });

  it('keeps an empty-output approval pending', () => {
    const activity = adaptLivePersistedActivity({
      title: 'researcher',
      progress: null,
      persistedContent: [
        {
          type: ContentTypes.TOOL_CALL,
          [ContentTypes.TOOL_CALL]: {
            id: 'tool',
            name: 'protected_tool',
            args: '{}',
            output: '',
            progress: 0.1,
            approval: { expires_at: 123 },
          },
        },
      ] as unknown as TMessageContentParts[],
      initialProgress: 0,
      isSubmitting: true,
    });

    expect(activity.items[0]).toEqual(
      expect.objectContaining({
        type: 'tool',
        status: 'running',
        output: '',
        approval: expect.any(Object),
      }),
    );
  });

  it('keeps shared-message activity read-only by omitting approval controls', () => {
    const activity = adaptLivePersistedActivity({
      title: 'researcher',
      progress: null,
      persistedContent: [
        {
          type: ContentTypes.TOOL_CALL,
          [ContentTypes.TOOL_CALL]: {
            id: 'tool',
            name: 'protected_tool',
            args: '{}',
            output: '',
            progress: 0.1,
            approval: { expires_at: 123 },
          },
        },
      ] as unknown as TMessageContentParts[],
      initialProgress: 1,
      isSubmitting: false,
      approvalVisibility: 'hidden',
    });

    expect(activity.items[0]).toEqual(
      expect.objectContaining({ type: 'tool', name: 'protected_tool' }),
    );
    expect(activity.items[0]).not.toHaveProperty('approval');
  });

  it('uses the exact assistant row as terminal authority for an older API response', () => {
    const oldView = {
      threadId: 'thread',
      parentConversationId: 'parent',
      parentMessageId: 'parent-message',
      parentToolCallId: 'parent-tool',
      subagentType: 'researcher',
      subagentKind: 'agent',
      title: 'Research child',
      status: 'running',
      messages: [
        {
          messageId: 'task:assistant',
          parentMessageId: 'task:user',
          role: 'assistant',
          text: 'Done.',
        },
      ],
      historyTruncated: false,
    } as SubagentThreadView;

    expect(adaptDurableThreadActivity(oldView, 'task')).toEqual(
      expect.objectContaining({ status: 'completed', items: [{ type: 'writing', text: 'Done.' }] }),
    );
  });

  it('merges a page-split task trigger with its newer assistant activity', () => {
    const triggerHalf: ChildConversationTurn = {
      taskId: 'task',
      trigger: {
        kind: 'external_event',
        summary: 'Play the next move.',
        createdAt: '2026-08-27T12:00:00.000Z',
        externalEvent: {
          eventType: 'chess.turn.ready',
          sourceType: 'speed-chess',
          occurredAt: '2026-08-27T12:00:00.000Z',
        },
      },
      activity: { title: 'Player', status: 'running', items: [] },
    };
    const assistantHalf: ChildConversationTurn = {
      taskId: 'task',
      trigger: { kind: 'parent_continuation', summary: '' },
      activity: {
        title: 'Player',
        status: 'completed',
        items: [{ type: 'writing', text: 'Played e4.' }],
      },
    };

    expect(mergeChildConversationTurns([triggerHalf], [assistantHalf])).toEqual([
      {
        taskId: 'task',
        trigger: triggerHalf.trigger,
        activity: expect.objectContaining({
          status: 'completed',
          items: [{ type: 'writing', text: 'Played e4.' }],
        }),
      },
    ]);
  });

  it('bounds automatically retained moving-window turns', () => {
    const turns = Array.from(
      { length: MAX_RETAINED_MOVING_WINDOW_TURNS + 3 },
      (_, index): ChildConversationTurn => ({
        taskId: `task-${index}`,
        trigger: { kind: 'parent_continuation', summary: '' },
        activity: { title: 'Player', status: 'completed', items: [] },
      }),
    );

    expect(retainBoundedMovingWindowTurns([], turns).map((turn) => turn.taskId)).toEqual(
      turns.slice(-MAX_RETAINED_MOVING_WINDOW_TURNS).map((turn) => turn.taskId),
    );
  });
});
