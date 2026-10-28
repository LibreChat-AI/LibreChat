import { ContentTypes, StepEvents, StepTypes, SteerEvents } from 'librechat-data-provider';
import type {
  SubagentTaskContentSnapshot,
  SubagentTaskContentSuffix,
  SubagentContentEvent,
} from 'librechat-data-provider';
import { reduceRecoveredContent, recoverTaskContent, recoveredToolPart } from './recovery';

const snapshot = (
  overrides: Partial<SubagentTaskContentSnapshot> = {},
): SubagentTaskContentSnapshot => ({
  mode: 'snapshot',
  taskId: 'task',
  threadId: 'thread',
  parentConversationId: 'parent',
  messageId: 'task:assistant',
  parentMessageId: 'task:user',
  sender: 'worker',
  revision: 1,
  throughSequence: 0,
  targetThroughSequence: 0,
  status: 'running',
  recovery: 'partial',
  content: [{ type: ContentTypes.TEXT, text: 'Opening. ', phase: 'commentary', agentId: 'child' }],
  runSteps: [
    {
      id: 'text-step',
      runId: 'provider-run',
      index: 0,
      type: StepTypes.MESSAGE_CREATION,
      stepDetails: {
        type: StepTypes.MESSAGE_CREATION,
        message_creation: { message_id: 'provider' },
      },
      usage: null,
    },
  ],
  ...overrides,
});
const suffix = (
  events: SubagentContentEvent[],
  overrides: Partial<SubagentTaskContentSuffix> = {},
): SubagentTaskContentSuffix => {
  const { content: _content, runSteps: _steps, ...identity } = snapshot();
  return {
    ...identity,
    mode: 'suffix',
    afterSequence: 0,
    revision: 2,
    throughSequence: 1,
    targetThroughSequence: 1,
    events,
    ...overrides,
  };
};
const text = (sequence: number, value: string): SubagentContentEvent => ({
  sequence,
  frame: {
    event: StepEvents.ON_MESSAGE_DELTA,
    data: {
      id: 'text-step',
      delta: {
        content: [{ type: ContentTypes.TEXT, text: value }],
      },
    },
  },
});

it('replays only committed suffix frames through the normal reducer without mutating its snapshot', () => {
  const first = reduceRecoveredContent(null, snapshot())!;
  const next = reduceRecoveredContent(first, suffix([text(1, 'Later.')]))!;
  expect(next.snapshot.content[0]).toMatchObject({
    text: 'Opening. Later.',
    agentId: 'child',
    phase: 'commentary',
  });
  expect(first.snapshot.content[0]).toMatchObject({ text: 'Opening. ' });
  expect(first.stream.messages.get('task:assistant')?.content?.[0]).toMatchObject({
    text: 'Opening. ',
  });
  expect(reduceRecoveredContent(next, suffix([text(1, 'Later.')]))).toBe(next);
});

it('drains opaque cursor pages at one target, including pages from the same revision', async () => {
  const load = jest
    .fn()
    .mockResolvedValueOnce(snapshot({ nextCursor: 'opaque cursor', targetThroughSequence: 2 }))
    .mockResolvedValueOnce(
      suffix([text(1, 'One. ')], { revision: 1, targetThroughSequence: 2, nextCursor: 'second' }),
    )
    .mockResolvedValueOnce(
      suffix([text(2, 'Two.')], {
        revision: 1,
        afterSequence: 1,
        throughSequence: 2,
        targetThroughSequence: 2,
      }),
    );
  const result = await recoverTaskContent(null, load);
  expect(load.mock.calls).toEqual([
    [undefined],
    [undefined, 'opaque cursor'],
    [undefined, 'second'],
  ]);
  expect(result.snapshot.content[0]).toMatchObject({ text: 'Opening. One. Two.' });
  expect(result.snapshot.throughSequence).toBe(2);
});

it('rejects non-advancing pages instead of hiding a missing prefix', async () => {
  const load = jest
    .fn()
    .mockResolvedValueOnce(snapshot({ nextCursor: 'cursor', targetThroughSequence: 2 }))
    .mockResolvedValueOnce(
      suffix([], { throughSequence: 0, targetThroughSequence: 2, nextCursor: 'cursor' }),
    );
  await expect(recoverTaskContent(null, load)).rejects.toThrow('subagent_content_cursor_mismatch');
});

it('keeps more than 112 calls and over-24KiB arguments and outputs intact', async () => {
  const large = 'payload'.repeat(5_000);
  const content = Array.from({ length: 113 }, (_, index) => ({
    type: ContentTypes.TOOL_CALL as const,
    agentId: 'child',
    streamedIndex: index,
    tool_call: {
      id: `call-${index}`,
      name: 'bash',
      args: large,
      output: large,
      progress: 1,
      stepId: `step-${index}`,
      toolExecutionDurationMs: index + 1,
    },
  }));
  const result = await recoverTaskContent(null, jest.fn().mockResolvedValue(snapshot({ content })));
  expect(result.snapshot.content).toBe(content);
  expect(result.snapshot.content).toHaveLength(113);
  expect(
    recoveredToolPart(result.snapshot, { partIndex: 112, toolCallId: 'call-112' })?.tool_call
      .output,
  ).toBe(large);
});

it('requires a snapshot for a mismatched cursor or task identity', () => {
  const first = reduceRecoveredContent(null, snapshot())!;
  expect(
    reduceRecoveredContent(first, suffix([text(2, 'Wrong.')], { afterSequence: 1 })),
  ).toBeNull();
  expect(
    reduceRecoveredContent(first, suffix([text(1, 'Wrong.')], { taskId: 'other-task' })),
  ).toBeNull();
});

it('will not hydrate a repeated provider id from an ambiguous moved occurrence', () => {
  const part = {
    type: ContentTypes.TOOL_CALL as const,
    tool_call: { id: 'reused', name: 'bash', args: '{}' },
  };
  const source = snapshot({ content: [part, { ...part }] });
  expect(recoveredToolPart(source, { partIndex: 9, toolCallId: 'reused' })).toBeNull();
  expect(recoveredToolPart(source, { partIndex: 1, toolCallId: 'reused' })?.partIndex).toBe(1);
});

it('catches up beyond a pinned target when completion arrives during pagination', async () => {
  const load = jest
    .fn()
    .mockResolvedValueOnce(snapshot({ targetThroughSequence: 1, nextCursor: 'pinned' }))
    .mockResolvedValueOnce(
      suffix([text(1, 'Earlier. ')], {
        revision: 1,
        throughSequence: 1,
        targetThroughSequence: 1,
        status: 'completed',
        recovery: 'partial',
      }),
    )
    .mockResolvedValueOnce(
      suffix([text(2, 'Final.')], {
        afterSequence: 1,
        revision: 2,
        throughSequence: 2,
        targetThroughSequence: 2,
        status: 'completed',
        recovery: 'complete',
      }),
    );
  const recovered = await recoverTaskContent(null, load);
  expect(load.mock.calls).toEqual([[undefined], [undefined, 'pinned'], [1]]);
  expect(recovered.snapshot).toMatchObject({
    throughSequence: 2,
    status: 'completed',
    recovery: 'complete',
  });
  expect(recovered.snapshot.content[0]).toMatchObject({ text: 'Opening. Earlier. Final.' });
});

it('keeps a genuinely partial terminal capture honest without an endless catch-up loop', async () => {
  const load = jest
    .fn()
    .mockResolvedValueOnce(snapshot({ status: 'failed', recovery: 'partial' }))
    .mockResolvedValueOnce(
      suffix([], {
        revision: 1,
        throughSequence: 0,
        targetThroughSequence: 0,
        status: 'failed',
        recovery: 'partial',
      }),
    );
  const recovered = await recoverTaskContent(null, load);
  expect(load.mock.calls).toEqual([[undefined], [0]]);
  expect(recovered.snapshot).toMatchObject({ throughSequence: 0, recovery: 'partial' });
});

it('keeps preparation timing from a snapshot when later arguments and completion arrive', () => {
  const initial = snapshot({
    content: [
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'call',
          name: 'lookup',
          args: '{',
          stepId: 'tool',
          toolPreparationStartedAt: 100,
        },
      },
    ],
    runSteps: [
      {
        id: 'tool',
        index: 0,
        type: StepTypes.TOOL_CALLS,
        stepDetails: {
          type: StepTypes.TOOL_CALLS,
          tool_calls: [{ id: 'call', name: 'lookup', args: '{' }],
        },
        usage: null,
      },
    ],
  });
  const seeded = reduceRecoveredContent(null, initial)!;
  const continued = reduceRecoveredContent(
    seeded,
    suffix(
      [
        {
          sequence: 1,
          frame: {
            event: StepEvents.ON_RUN_STEP_DELTA,
            data: {
              id: 'tool',
              observed_at: 150,
              delta: {
                type: StepTypes.TOOL_CALLS,
                tool_calls: [{ id: 'call', index: 0, name: 'lookup', args: '}' }],
              },
            },
          },
        },
        {
          sequence: 2,
          frame: {
            event: StepEvents.ON_TOOL_CALLS_DISPATCHED,
            data: {
              dispatched_at: 1000,
              toolCalls: [{ id: 'call', stepId: 'tool', name: 'lookup' }],
            },
          },
        },
        {
          sequence: 3,
          frame: {
            event: StepEvents.ON_RUN_STEP_COMPLETED,
            data: {
              result: {
                id: 'tool',
                index: 0,
                completed_at: 1340,
                tool_call: { id: 'call', name: 'lookup', args: '{}', output: 'Done' },
              },
            },
          },
        },
        {
          sequence: 4,
          frame: {
            event: StepEvents.ON_RUN_STEP_CLOSED,
            data: {
              id: 'tool',
              index: 0,
              type: StepTypes.TOOL_CALLS,
              status: 'completed',
              created_at: 100,
              closed_at: 1340,
            },
          },
        },
      ],
      { throughSequence: 4, targetThroughSequence: 4 },
    ),
  )!;
  expect(continued.snapshot.content[0]).toMatchObject({
    tool_call: {
      toolPreparationStartedAt: 100,
      toolPreparationDurationMs: 900,
      toolDispatchedAt: 1000,
      toolExecutionDurationMs: 340,
    },
  });
  expect(seeded.snapshot.content[0]).toMatchObject({
    tool_call: { toolPreparationStartedAt: 100 },
  });
});

it('carries an idless first fragment forward when its provider call identity arrives', () => {
  const initial = snapshot({
    content: [
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: '',
          name: 'lookup',
          args: '{',
          toolPreparationStartedAt: 100,
        },
      },
    ],
    runSteps: [
      {
        id: 'tool',
        index: 0,
        type: StepTypes.TOOL_CALLS,
        stepDetails: { type: StepTypes.TOOL_CALLS, tool_calls: [{ name: 'lookup', args: '{' }] },
        usage: null,
      },
    ],
  });
  const seeded = reduceRecoveredContent(null, initial)!;
  const continued = reduceRecoveredContent(
    seeded,
    suffix([
      {
        sequence: 1,
        frame: {
          event: StepEvents.ON_RUN_STEP_DELTA,
          data: {
            id: 'tool',
            observed_at: 150,
            delta: {
              type: StepTypes.TOOL_CALLS,
              tool_calls: [{ id: 'assigned', index: 0, name: 'lookup', args: '}' }],
            },
          },
        },
      },
    ]),
  )!;
  expect(continued.snapshot.content[0]).toMatchObject({
    tool_call: {
      id: 'assigned',
      toolPreparationStartedAt: 100,
    },
  });
});

it('seeds an already dispatched timestamp before a later committed argument delta', () => {
  const initial = snapshot({
    content: [
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'call',
          name: 'lookup',
          args: '{',
          toolPreparationStartedAt: 100,
          toolDispatchedAt: 1000,
        },
      },
    ],
    runSteps: [
      {
        id: 'tool',
        index: 0,
        type: StepTypes.TOOL_CALLS,
        stepDetails: {
          type: StepTypes.TOOL_CALLS,
          tool_calls: [{ id: 'call', name: 'lookup', args: '{' }],
        },
        usage: null,
      },
    ],
  });
  const continued = reduceRecoveredContent(
    reduceRecoveredContent(null, initial),
    suffix([
      {
        sequence: 1,
        frame: {
          event: StepEvents.ON_RUN_STEP_DELTA,
          data: {
            id: 'tool',
            observed_at: 150,
            delta: {
              type: StepTypes.TOOL_CALLS,
              tool_calls: [{ id: 'call', index: 0, name: 'lookup', args: '}' }],
            },
          },
        },
      },
    ]),
  )!;
  expect(continued.snapshot.content[0]).toMatchObject({
    tool_call: {
      toolPreparationStartedAt: 100,
      toolDispatchedAt: 1000,
    },
  });
});

it('keeps the published stream immutable across many pages and a later page failure', async () => {
  const before = reduceRecoveredContent(null, snapshot())!;
  const page = (sequence: number, nextCursor?: string) =>
    suffix([text(sequence, `${sequence}.`)], {
      afterSequence: sequence - 1,
      throughSequence: sequence,
      targetThroughSequence: 3,
      nextCursor,
    });
  const load = jest
    .fn()
    .mockResolvedValueOnce(page(1, 'two'))
    .mockResolvedValueOnce(page(2, 'three'))
    .mockResolvedValueOnce(page(3));
  const result = await recoverTaskContent(before, load);
  expect(result.snapshot.content[0]).toMatchObject({ text: 'Opening. 1.2.3.' });
  expect(result.snapshot.runSteps).toEqual(Array.from(result.stream.steps.values()));
  expect(before.snapshot.content[0]).toMatchObject({ text: 'Opening. ' });
  expect(before.stream.messages.get('task:assistant')?.content).toBe(before.snapshot.content);
  expect(result.stream.steps).not.toBe(before.stream.steps);
  const fail = jest
    .fn()
    .mockResolvedValueOnce(page(1, 'two'))
    .mockRejectedValueOnce(new Error('offline'));
  await expect(recoverTaskContent(before, fail)).rejects.toThrow('offline');
  expect(before.snapshot.content[0]).toMatchObject({ text: 'Opening. ' });
});

it('stops before another cursor page after cancellation without mutating the prior reader', async () => {
  const controller = new AbortController();
  const before = reduceRecoveredContent(null, snapshot())!;
  const load = jest.fn().mockImplementation(async () => {
    controller.abort();
    return suffix([text(1, 'Not published.')], { targetThroughSequence: 2, nextCursor: 'two' });
  });
  await expect(recoverTaskContent(before, load, controller.signal)).rejects.toThrow(
    'subagent_content_cancelled',
  );
  expect(load).toHaveBeenCalledTimes(1);
  expect(before.snapshot.content[0]).toMatchObject({ text: 'Opening. ' });
});

it('rejects parent identity changes as well as child identity changes', () => {
  const before = reduceRecoveredContent(null, snapshot())!;
  expect(
    reduceRecoveredContent(before, suffix([], { parentConversationId: 'other-parent' })),
  ).toBeNull();
  expect(reduceRecoveredContent(before, suffix([], { parentMessageId: 'other-user' }))).toBeNull();
});

it('replays applied steering at its reserved slot before subsequent run steps without mutating the snapshot', () => {
  const before = reduceRecoveredContent(null, snapshot())!;
  const part = {
    type: ContentTypes.STEER as const,
    steer: 'Continue with citation',
    steerId: 'control',
    createdAt: 100,
  };
  const next = reduceRecoveredContent(
    before,
    suffix(
      [
        {
          sequence: 1,
          frame: {
            event: SteerEvents.ON_STEER_APPLIED,
            data: {
              index: 1,
              part,
              steerId: 'control',
              responseMessageId: 'task:assistant',
              conversationId: 'thread',
            },
          },
        },
        {
          sequence: 2,
          frame: {
            event: StepEvents.ON_RUN_STEP,
            data: {
              id: 'after',
              runId: 'provider-run',
              index: 2,
              type: StepTypes.MESSAGE_CREATION,
              stepDetails: {
                type: StepTypes.MESSAGE_CREATION,
                message_creation: { message_id: 'answer' },
              },
              usage: null,
            },
          },
        },
        {
          sequence: 3,
          frame: {
            event: StepEvents.ON_MESSAGE_DELTA,
            data: {
              id: 'after',
              delta: { content: [{ type: ContentTypes.TEXT, text: 'After control.' }] },
            },
          },
        },
      ],
      { throughSequence: 3, targetThroughSequence: 3 },
    ),
  )!;
  expect(next.snapshot.content).toMatchObject([
    { text: 'Opening. ' },
    part,
    { text: 'After control.' },
  ]);
  expect(before.snapshot.content).toHaveLength(1);
});
