import { GraphEvents } from '@librechat/agents';
import { ContentTypes, StepTypes } from 'librechat-data-provider';
import type { PostToolBatchHookInput } from '@librechat/agents';
import type { ActivityPhaseSnapshot, GenerateActivityPhasePayload } from './runtime';
import type { LooseContentPart } from '~/agents/activityLabels/wiring';
import {
  ACTIVITY_PHASE_INSTRUCTION,
  createActivityPhaseWiring,
  createAssistantPhaseStampingHandlers,
} from './runtime';

const batch = (id: string): PostToolBatchHookInput =>
  ({
    hook_event_name: 'PostToolBatch',
    runId: 'run-1',
    entries: [
      {
        toolName: 'web_search',
        toolInput: { query: id },
        toolUseId: id,
        status: 'success',
        toolOutput: `${id}-result`,
      },
    ],
  }) as PostToolBatchHookInput;

const SUBSTANTIAL_TEXT_CHARS = 200;
const substantialText = (prefix: string): string =>
  `${prefix} ${'x'.repeat(SUBSTANTIAL_TEXT_CHARS + 1)}`;

const RETAINED_EVIDENCE_ACTIVITIES = 13;
const OVERFLOW_ACTIVITY_ANCHORS = 64;

const totalTrackedCount = (activities: ActivityPhaseSnapshot['activities']): number =>
  activities.reduce((total, activity) => total + (activity.mergedCount ?? 1), 0);

const numericField = (part: LooseContentPart | null | undefined, field: string): number => {
  const value = part?.[field];
  return typeof value === 'number' ? value : Number.NaN;
};

async function flushDetached(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('createActivityPhaseWiring', () => {
  it('claims one parent phase when text becomes substantial', async () => {
    const parts: LooseContentPart[] = [];
    const forwarded: unknown[] = [];
    const emitLabelEvent = jest.fn(async () => undefined);
    const generatePhase = jest.fn(async () => ({ label: 'Resolved the release compatibility' }));
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      getStepIndex: (stepId) => (stepId === 'final-step' ? 1 : undefined),
      bumpIndexOffset: jest.fn(),
      emitLabelEvent,
      trackPendingFill: jest.fn(),
      generatePhase,
    });

    parts.push({
      type: ContentTypes.TOOL_CALL,
      tool_call: { id: 'tool-1' },
    });
    await wiring.hook(batch('tool-1'), new AbortController().signal);
    parts.push({
      type: ContentTypes.TOOL_CALL,
      tool_call: { id: 'tool-2' },
    });
    await wiring.hook(batch('tool-2'), new AbortController().signal);

    const handlers = wiring.handlers({
      [GraphEvents.ON_RUN_STEP]: {
        handle: (_event, data) => {
          forwarded.push(data);
        },
      },
      [GraphEvents.ON_MESSAGE_DELTA]: {
        handle: (_event, data) => {
          const delta = data as { delta?: { content?: { text?: string } } };
          parts[2] = {
            type: ContentTypes.TEXT,
            text: `${parts[2]?.text ?? ''}${delta.delta?.content?.text ?? ''}`,
          };
        },
      },
    });
    handlers?.[GraphEvents.ON_RUN_STEP]?.handle(
      GraphEvents.ON_RUN_STEP,
      {
        id: 'final-step',
        index: 2,
        stepDetails: {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: {
            message_id: 'message-1',
            content_type: 'text',
            phase: 'final_answer',
          },
        },
      } as never,
      undefined,
      undefined,
    );
    expect(parts).toHaveLength(2);
    handlers?.[GraphEvents.ON_MESSAGE_DELTA]?.handle(
      GraphEvents.ON_MESSAGE_DELTA,
      {
        id: 'final-step',
        delta: {
          content: { type: ContentTypes.TEXT, text: 'A'.repeat(SUBSTANTIAL_TEXT_CHARS + 1) },
        },
      } as never,
      undefined,
      undefined,
    );

    expect(forwarded).toHaveLength(1);
    expect(parts[3]).toMatchObject({
      type: ContentTypes.ACTIVITY_LABEL,
      activity_label_type: 'phase',
      activity_start_index: 0,
      activity_end_index: 2,
      activity_count: 2,
      pending: true,
    });
    await flushDetached();
    expect(generatePhase).toHaveBeenCalledWith(
      expect.objectContaining({
        closingTextPhase: 'final_answer',
        phaseIndex: 0,
        totalActivityCount: 2,
        activities: expect.any(Array),
        prompt: ACTIVITY_PHASE_INSTRUCTION,
      }),
    );
    expect(parts[3]).toMatchObject({
      activity_label: 'Resolved the release compatibility',
      pending: false,
    });
    expect(emitLabelEvent).toHaveBeenCalledTimes(2);
  });

  it('creates multiple phases around substantial root text in one run', async () => {
    const parts: LooseContentPart[] = [];
    const stepIndexes = new Map<string, number>();
    const generatedPayloads: GenerateActivityPhasePayload[] = [];
    const generatePhase = jest.fn(async (payload: GenerateActivityPhasePayload) => {
      generatedPayloads.push(payload);
      return { label: 'Completed the activity phase' };
    });
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      getStepIndex: (stepId) => stepIndexes.get(stepId),
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase,
    });
    const handlers = wiring.handlers({
      [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() },
      [GraphEvents.ON_MESSAGE_DELTA]: {
        handle: (_event, data) => {
          const delta = data as { id?: string; delta?: { content?: { text?: string } } };
          const index = delta.id ? stepIndexes.get(delta.id) : undefined;
          if (index != null) {
            parts[index] = {
              type: ContentTypes.TEXT,
              text: `${parts[index]?.text ?? ''}${delta.delta?.content?.text ?? ''}`,
            };
          }
        },
      },
    });
    const emitText = (id: string, text: string, phase?: 'final_answer') => {
      const index = parts.length;
      stepIndexes.set(id, index);
      handlers?.[GraphEvents.ON_RUN_STEP]?.handle(
        GraphEvents.ON_RUN_STEP,
        {
          id,
          stepDetails: {
            type: StepTypes.MESSAGE_CREATION,
            message_creation: { message_id: id, content_type: 'text', ...(phase && { phase }) },
          },
        } as never,
        undefined,
        undefined,
      );
      handlers?.[GraphEvents.ON_MESSAGE_DELTA]?.handle(
        GraphEvents.ON_MESSAGE_DELTA,
        { id, delta: { content: { type: ContentTypes.TEXT, text } } } as never,
        undefined,
        undefined,
      );
    };

    parts.push({ type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } });
    await wiring.hook(batch('tool-1'), new AbortController().signal);
    emitText('short-1', 'I pulled the repository history and will analyze it now.');
    parts.push({ type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } });
    await wiring.hook(batch('tool-2'), new AbortController().signal);
    emitText('long-1', `Here is the first substantial result. ${'A'.repeat(241)}`);

    parts.push({ type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-3' } });
    await wiring.hook(batch('tool-3'), new AbortController().signal);
    emitText('short-2', 'I found another angle worth checking.');
    parts.push({ type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-4' } });
    await wiring.hook(batch('tool-4'), new AbortController().signal);
    emitText('long-2', `Here is the second substantial result. ${'B'.repeat(241)}`, 'final_answer');

    await flushDetached();

    expect(generatePhase).toHaveBeenCalledTimes(2);
    expect(generatedPayloads[0]).toMatchObject({
      assistantContext: ['I pulled the repository history and will analyze it now.'],
      totalActivityCount: 2,
    });
    expect(generatedPayloads[1]).toMatchObject({
      assistantContext: ['I found another angle worth checking.'],
      closingTextPhase: 'final_answer',
      totalActivityCount: 2,
    });
    expect(parts[4]).toMatchObject({
      activity_label_type: 'phase',
      activity_start_index: 0,
      activity_end_index: 3,
    });
    expect(parts[9]).toMatchObject({
      activity_label_type: 'phase',
      activity_start_index: 5,
      activity_end_index: 8,
    });
  });

  it('retains a later-indexed activity when an interleaved text step crosses a boundary', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } },
    ];
    const generatedPayloads: GenerateActivityPhasePayload[] = [];
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      getStepIndex: (stepId) => (stepId === 'interleaved-text' ? 2 : undefined),
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase: jest.fn(async (payload: GenerateActivityPhasePayload) => {
        generatedPayloads.push(payload);
        return { label: 'Completed one activity phase' };
      }),
    });
    await wiring.hook(batch('tool-1'), new AbortController().signal);
    await wiring.hook(batch('tool-2'), new AbortController().signal);
    const handlers = wiring.handlers({
      [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() },
      [GraphEvents.ON_MESSAGE_DELTA]: {
        handle: (_event, data) => {
          const delta = data as { delta?: { content?: { text?: string } } };
          parts[2] = {
            type: ContentTypes.TEXT,
            text: `${parts[2]?.text ?? ''}${delta.delta?.content?.text ?? ''}`,
          };
        },
      },
    });
    handlers?.[GraphEvents.ON_RUN_STEP]?.handle(
      GraphEvents.ON_RUN_STEP,
      {
        id: 'interleaved-text',
        stepDetails: {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: { message_id: 'm', content_type: 'text' },
        },
      } as never,
      undefined,
      undefined,
    );
    handlers?.[GraphEvents.ON_MESSAGE_DELTA]?.handle(
      GraphEvents.ON_MESSAGE_DELTA,
      {
        id: 'interleaved-text',
        delta: { content: { type: ContentTypes.TEXT, text: 'prefix' } },
      } as never,
      undefined,
      undefined,
    );
    parts[3] = { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-3' } };
    await wiring.hook(batch('tool-3'), new AbortController().signal);
    handlers?.[GraphEvents.ON_MESSAGE_DELTA]?.handle(
      GraphEvents.ON_MESSAGE_DELTA,
      {
        id: 'interleaved-text',
        delta: { content: { type: ContentTypes.TEXT, text: 'x'.repeat(SUBSTANTIAL_TEXT_CHARS) } },
      } as never,
      undefined,
      undefined,
    );
    parts[5] = { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-4' } };
    await wiring.hook(batch('tool-4'), new AbortController().signal);

    wiring.complete();
    await flushDetached();

    expect(generatedPayloads).toHaveLength(2);
    expect(generatedPayloads.map(({ totalActivityCount }) => totalActivityCount)).toEqual([2, 2]);
    expect(parts[4]).toMatchObject({ activity_end_index: 2, activity_count: 2 });
    expect(parts[6]).toMatchObject({ activity_start_index: 3, activity_count: 2 });
  });

  it('preserves a live later reasoning lane across an interleaved text boundary', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } },
    ];
    const stepIndexes = new Map([
      ['boundary-text', 2],
      ['later-reasoning', 3],
    ]);
    const generatePhase = jest.fn(async () => ({ label: 'Completed the earlier phase' }));
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      getStepIndex: (stepId) => stepIndexes.get(stepId),
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase,
    });
    await wiring.hook(batch('tool-1'), new AbortController().signal);
    await wiring.hook(batch('tool-2'), new AbortController().signal);
    const handlers = wiring.handlers({
      [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() },
      [GraphEvents.ON_REASONING_DELTA]: { handle: jest.fn() },
      [GraphEvents.ON_MESSAGE_DELTA]: {
        handle: (_event, data) => {
          const delta = data as { delta?: { content?: { text?: string } } };
          parts[2] = {
            type: ContentTypes.TEXT,
            text: `${parts[2]?.text ?? ''}${delta.delta?.content?.text ?? ''}`,
          };
        },
      },
    });
    handlers?.[GraphEvents.ON_RUN_STEP]?.handle(
      GraphEvents.ON_RUN_STEP,
      {
        id: 'boundary-text',
        stepDetails: {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: { message_id: 'm', content_type: 'text' },
        },
      } as never,
      undefined,
      undefined,
    );
    handlers?.[GraphEvents.ON_RUN_STEP]?.handle(
      GraphEvents.ON_RUN_STEP,
      {
        id: 'later-reasoning',
        stepDetails: {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: { message_id: 'm', content_type: 'think' },
        },
      } as never,
      undefined,
      undefined,
    );
    parts[3] = { type: ContentTypes.THINK, think: 'Investigating the later tool.' };
    handlers?.[GraphEvents.ON_REASONING_DELTA]?.handle(
      GraphEvents.ON_REASONING_DELTA,
      {
        id: 'later-reasoning',
        delta: { content: { type: ContentTypes.THINK, think: 'Investigating the later tool.' } },
      } as never,
      undefined,
      undefined,
    );
    handlers?.[GraphEvents.ON_MESSAGE_DELTA]?.handle(
      GraphEvents.ON_MESSAGE_DELTA,
      {
        id: 'boundary-text',
        delta: { content: { type: ContentTypes.TEXT, text: substantialText('Boundary result.') } },
      } as never,
      undefined,
      undefined,
    );
    parts[5] = { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-3' } };
    await wiring.hook(batch('tool-3'), new AbortController().signal);

    wiring.complete();
    await flushDetached();

    expect(generatePhase).toHaveBeenCalledTimes(1);
    expect(wiring.snapshot().activityCount).toBe(0);
  });

  it('splits resumed activities around every persisted substantial text boundary', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } },
      { type: ContentTypes.TEXT, text: substantialText('First persisted result.') },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-3' } },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-4' } },
      { type: ContentTypes.TEXT, text: substantialText('Second persisted result.') },
    ];
    const generatePhase = jest.fn(async () => ({ label: 'Completed one persisted phase' }));
    const wiring = createActivityPhaseWiring({
      initialSnapshot: {
        version: 1,
        generated: 0,
        activityCount: 4,
        failedActivityCount: 0,
        partialActivityCount: 0,
        agentIds: [],
        activities: [
          { startIndex: 0, status: 'success', toolCallIds: ['tool-1'] },
          { startIndex: 1, status: 'success', toolCallIds: ['tool-2'] },
          { startIndex: 3, status: 'success', toolCallIds: ['tool-3'] },
          { startIndex: 4, status: 'success', toolCallIds: ['tool-4'] },
        ],
        assistantContext: [],
        pendingReasoning: [],
      },
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase,
    });

    wiring.complete();
    await flushDetached();

    expect(generatePhase).toHaveBeenCalledTimes(2);
    expect(parts[6]).toMatchObject({ activity_start_index: 0, activity_end_index: 2 });
    expect(parts[7]).toMatchObject({ activity_start_index: 3, activity_end_index: 5 });
  });

  it('partitions persisted context by activity position across HITL boundaries', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } },
      {
        type: ContentTypes.TEXT,
        text: substantialText('Persisted commentary boundary.'),
        phase: 'commentary',
      },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-3' } },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-4' } },
    ];
    const payloads: GenerateActivityPhasePayload[] = [];
    const wiring = createActivityPhaseWiring({
      initialSnapshot: {
        version: 1,
        generated: 0,
        activityCount: 4,
        failedActivityCount: 0,
        partialActivityCount: 0,
        agentIds: [],
        activities: [
          { startIndex: 0, status: 'success', toolCallIds: ['tool-1'] },
          { startIndex: 1, status: 'success', toolCallIds: ['tool-2'] },
          { startIndex: 3, status: 'success', toolCallIds: ['tool-3'] },
          { startIndex: 4, status: 'success', toolCallIds: ['tool-4'] },
        ],
        assistantContext: [
          { text: 'Context for the earlier work.', activityPosition: 2 },
          { text: 'Context for the later work.', activityPosition: 4 },
        ],
        pendingReasoning: [],
      },
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase: jest.fn(async (payload: GenerateActivityPhasePayload) => {
        payloads.push(payload);
        return { label: 'Completed one phase' };
      }),
    });

    wiring.complete();
    await flushDetached();

    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({
      assistantContext: ['Context for the earlier work.'],
      closingTextPhase: 'commentary',
    });
    expect(payloads[1]).toMatchObject({ assistantContext: ['Context for the later work.'] });
  });

  it('keeps a substantial boundary hard when too little preceding work earns a phase', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } },
      { type: ContentTypes.TEXT, text: substantialText('Standalone result.') },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-3' } },
    ];
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase: jest.fn(async () => ({ label: 'Completed the later phase' })),
    });
    await wiring.hook(batch('tool-1'), new AbortController().signal);
    await wiring.hook(batch('tool-2'), new AbortController().signal);
    await wiring.hook(batch('tool-3'), new AbortController().signal);

    wiring.complete();
    await flushDetached();

    expect(parts[4]).toMatchObject({
      activity_start_index: 2,
      activity_end_index: 4,
      activity_count: 2,
    });
  });

  it('keeps interleaved parallel text context keyed to its run step', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } },
    ];
    const generatePhase = jest.fn(async () => ({ label: 'Compared both parallel findings' }));
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase,
    });
    await wiring.hook(batch('tool-1'), new AbortController().signal);
    await wiring.hook(batch('tool-2'), new AbortController().signal);
    const handlers = wiring.handlers({
      [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() },
      [GraphEvents.ON_MESSAGE_DELTA]: { handle: jest.fn() },
    });
    const emitTextStep = (id: string, agentId: string) =>
      handlers?.[GraphEvents.ON_RUN_STEP]?.handle(
        GraphEvents.ON_RUN_STEP,
        {
          id,
          agentId,
          groupId: agentId,
          stepDetails: {
            type: StepTypes.MESSAGE_CREATION,
            message_creation: { message_id: 'm', content_type: 'text' },
          },
        } as never,
        undefined,
        undefined,
      );
    const emitTextDelta = (id: string, text: string) =>
      handlers?.[GraphEvents.ON_MESSAGE_DELTA]?.handle(
        GraphEvents.ON_MESSAGE_DELTA,
        { id, delta: { content: { type: ContentTypes.TEXT, text } } } as never,
        undefined,
        undefined,
      );

    emitTextStep('lane-a', 'agent-a');
    emitTextStep('lane-b', 'agent-b');
    emitTextDelta('lane-a', 'First lane ');
    emitTextDelta('lane-b', 'Second lane');
    emitTextDelta('lane-a', 'completed');
    handlers?.[GraphEvents.ON_RUN_STEP]?.handle(
      GraphEvents.ON_RUN_STEP,
      {
        id: 'root-final',
        stepDetails: {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: { message_id: 'm', content_type: 'text', phase: 'final_answer' },
        },
      } as never,
      undefined,
      undefined,
    );

    wiring.complete();
    await flushDetached();
    expect(generatePhase).toHaveBeenCalledWith(
      expect.objectContaining({ assistantContext: ['First lane completed', 'Second lane'] }),
    );
  });

  it('reanchors a tool that lands after the phase hook observes its child label', async () => {
    const parts: LooseContentPart[] = [];
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase: jest.fn(async () => ({ label: 'Verified both delayed tool results' })),
    });

    /** The child-label hook can synchronously reserve its slot before the
     *  tool event reaches the shared content array. A tool-only provider turn
     *  can also leave an empty final-answer part between the tool and label;
     *  that invisible boundary must not strand the tool outside the phase. */
    parts[1] = { type: ContentTypes.TEXT, text: '', phase: 'final_answer' };
    parts[2] = {
      type: ContentTypes.ACTIVITY_LABEL,
      activity_label: 'Recorded the first delayed result',
      tool_call_ids: ['tool-1'],
      pending: false,
    };
    await wiring.hook(batch('tool-1'), new AbortController().signal);

    parts[3] = { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } };
    parts[4] = {
      type: ContentTypes.ACTIVITY_LABEL,
      activity_label: 'Recorded the second delayed result',
      tool_call_ids: ['tool-2'],
      pending: false,
    };
    await wiring.hook(batch('tool-2'), new AbortController().signal);

    wiring
      .handlers({ [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() } })
      ?.[GraphEvents.ON_RUN_STEP]?.handle(
        GraphEvents.ON_RUN_STEP,
        {
          id: 'final-step',
          stepDetails: {
            type: StepTypes.MESSAGE_CREATION,
            message_creation: { message_id: 'm', content_type: 'text', phase: 'final_answer' },
          },
        } as never,
        undefined,
        undefined,
      );

    wiring.complete();
    expect(parts[5]).toMatchObject({
      activity_label_type: 'phase',
      activity_start_index: 0,
      activity_count: 2,
    });
    parts[0] = { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } };
    expect(parts.slice(0, 5)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool_call: { id: 'tool-1' } }),
        expect.objectContaining({ tool_call: { id: 'tool-2' } }),
      ]),
    );
  });

  it('does not claim a visible final answer for a later parent phase', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TEXT, text: 'Earlier final answer', phase: 'final_answer' },
    ];
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase: jest.fn(async () => ({ label: 'Verified the later tool results' })),
    });

    parts[2] = {
      type: ContentTypes.ACTIVITY_LABEL,
      activity_label: 'Recorded the first later result',
      tool_call_ids: ['tool-1'],
      pending: false,
    };
    await wiring.hook(batch('tool-1'), new AbortController().signal);
    parts[3] = { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } };
    await wiring.hook(batch('tool-2'), new AbortController().signal);

    wiring
      .handlers({ [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() } })
      ?.[GraphEvents.ON_RUN_STEP]?.handle(
        GraphEvents.ON_RUN_STEP,
        {
          id: 'final-step',
          stepDetails: {
            type: StepTypes.MESSAGE_CREATION,
            message_creation: { message_id: 'm', content_type: 'text', phase: 'final_answer' },
          },
        } as never,
        undefined,
        undefined,
      );

    wiring.complete();
    expect(parts[4]).toMatchObject({
      activity_label_type: 'phase',
      activity_start_index: 1,
      activity_count: 2,
    });
    parts[1] = { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } };
    expect(parts.slice(1, 4)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool_call: { id: 'tool-1' } }),
        expect.objectContaining({ tool_call: { id: 'tool-2' } }),
      ]),
    );
  });

  it('does not use repeated reasoning to reanchor a missing tool across a phase', async () => {
    const repeatedReasoning = 'Compared the same deployment paths.';
    const parts: LooseContentPart[] = [
      { type: ContentTypes.THINK, think: repeatedReasoning },
      {
        type: ContentTypes.ACTIVITY_LABEL,
        activity_label: '',
        activity_label_type: 'phase',
        activity_start_index: 0,
        activity_count: 2,
        pending: false,
      },
    ];
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      getStepIndex: (stepId) => {
        if (stepId === 'missing-tool-reasoning') return 2;
        if (stepId === 'current-reasoning') return 4;
        return undefined;
      },
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase: jest.fn(async () => ({ label: 'Verified the current deployment path' })),
    });
    const handlers = wiring.handlers({
      [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() },
      [GraphEvents.ON_REASONING_DELTA]: { handle: jest.fn() },
    });

    handlers?.[GraphEvents.ON_RUN_STEP]?.handle(
      GraphEvents.ON_RUN_STEP,
      {
        id: 'missing-tool-reasoning',
        stepDetails: {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: { message_id: 'm', content_type: 'think' },
        },
      } as never,
      undefined,
      undefined,
    );
    parts[2] = { type: ContentTypes.THINK, think: repeatedReasoning };
    handlers?.[GraphEvents.ON_REASONING_DELTA]?.handle(
      GraphEvents.ON_REASONING_DELTA,
      {
        id: 'missing-tool-reasoning',
        delta: { content: { type: ContentTypes.THINK, think: repeatedReasoning } },
      } as never,
      undefined,
      undefined,
    );
    parts[3] = {
      type: ContentTypes.ACTIVITY_LABEL,
      activity_label: 'Recorded a result before its tool arrived',
      tool_call_ids: ['missing-tool'],
      pending: false,
    };
    await wiring.hook(batch('missing-tool'), new AbortController().signal);

    handlers?.[GraphEvents.ON_RUN_STEP]?.handle(
      GraphEvents.ON_RUN_STEP,
      {
        id: 'current-reasoning',
        stepDetails: {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: { message_id: 'm', content_type: 'think' },
        },
      } as never,
      undefined,
      undefined,
    );
    parts[4] = { type: ContentTypes.THINK, think: repeatedReasoning };
    handlers?.[GraphEvents.ON_REASONING_DELTA]?.handle(
      GraphEvents.ON_REASONING_DELTA,
      {
        id: 'current-reasoning',
        delta: { content: { type: ContentTypes.THINK, think: repeatedReasoning } },
      } as never,
      undefined,
      undefined,
    );

    handlers?.[GraphEvents.ON_RUN_STEP]?.handle(
      GraphEvents.ON_RUN_STEP,
      {
        id: 'final-step',
        stepDetails: {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: { message_id: 'm', content_type: 'text', phase: 'final_answer' },
        },
      } as never,
      undefined,
      undefined,
    );

    wiring.complete();
    expect(parts[5]).toMatchObject({
      activity_label_type: 'phase',
      activity_start_index: 2,
      activity_count: 2,
    });
  });

  it('does not spend a phase call on one logical activity', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } },
    ];
    const generatePhase = jest.fn(async () => ({ label: 'unused' }));
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase,
    });
    await wiring.hook(batch('tool-1'), new AbortController().signal);
    const handler = wiring.handlers({
      [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() },
    })?.[GraphEvents.ON_RUN_STEP];
    handler?.handle(
      GraphEvents.ON_RUN_STEP,
      {
        id: 'final-step',
        stepDetails: {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: { message_id: 'm', content_type: 'text', phase: 'final_answer' },
        },
      } as never,
      undefined,
      undefined,
    );
    await flushDetached();
    expect(generatePhase).not.toHaveBeenCalled();
    expect(parts).toHaveLength(1);
  });

  it('keeps reasoning attached to a tool batch across commentary', async () => {
    const parts: LooseContentPart[] = [];
    const generatePhase = jest.fn(async () => ({ label: 'unused' }));
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase,
    });
    const handlers = wiring.handlers({
      [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() },
      [GraphEvents.ON_REASONING_DELTA]: { handle: jest.fn() },
    });

    handlers?.[GraphEvents.ON_RUN_STEP]?.handle(
      GraphEvents.ON_RUN_STEP,
      {
        id: 'reasoning-step',
        stepDetails: {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: { message_id: 'm', content_type: 'think' },
        },
      } as never,
      undefined,
      undefined,
    );
    handlers?.[GraphEvents.ON_REASONING_DELTA]?.handle(
      GraphEvents.ON_REASONING_DELTA,
      {
        id: 'reasoning-step',
        delta: { content: { type: ContentTypes.THINK, think: 'Compared both auth paths.' } },
      } as never,
      undefined,
      undefined,
    );
    parts.push({ type: ContentTypes.THINK, think: 'Compared both auth paths.' });
    handlers?.[GraphEvents.ON_RUN_STEP]?.handle(
      GraphEvents.ON_RUN_STEP,
      {
        id: 'commentary-step',
        stepDetails: {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: { message_id: 'm', content_type: 'text', phase: 'commentary' },
        },
      } as never,
      undefined,
      undefined,
    );

    expect(wiring.snapshot()).toMatchObject({
      activityCount: 0,
      pendingReasoning: [{ key: 'root', text: 'Compared both auth paths.' }],
    });

    parts.push({ type: ContentTypes.TEXT, text: 'I will verify the middleware.' });
    parts.push({ type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } });
    await wiring.hook(batch('tool-1'), new AbortController().signal);
    expect(wiring.snapshot()).toMatchObject({
      activityCount: 1,
      activities: [expect.objectContaining({ thinkingExcerpts: ['Compared both auth paths.'] })],
      pendingReasoning: [],
    });

    handlers?.[GraphEvents.ON_RUN_STEP]?.handle(
      GraphEvents.ON_RUN_STEP,
      {
        id: 'final-step',
        stepDetails: {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: { message_id: 'm', content_type: 'text', phase: 'final_answer' },
        },
      } as never,
      undefined,
      undefined,
    );
    await flushDetached();
    expect(generatePhase).not.toHaveBeenCalled();
    expect(parts.some((part) => part.activity_label_type === 'phase')).toBe(false);
  });

  it('counts a top-level handoff as a logical phase activity', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'handoff-1' } },
    ];
    let generatedActivities: GenerateActivityPhasePayload['activities'] | undefined;
    const generatePhase = jest.fn(async (payload: GenerateActivityPhasePayload) => {
      generatedActivities = payload.activities;
      return { label: 'Transferred ownership and verified the account state' };
    });
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase,
    });
    const handoff = batch('handoff-1');
    handoff.entries[0].toolName = 'lc_transfer_to_billing_agent';
    await wiring.hook(handoff, new AbortController().signal);
    parts.push({ type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } });
    await wiring.hook(batch('tool-1'), new AbortController().signal);

    wiring
      .handlers({ [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() } })
      ?.[GraphEvents.ON_RUN_STEP]?.handle(
        GraphEvents.ON_RUN_STEP,
        {
          id: 'final-step',
          stepDetails: {
            type: StepTypes.MESSAGE_CREATION,
            message_creation: { message_id: 'm', content_type: 'text', phase: 'final_answer' },
          },
        } as never,
        undefined,
        undefined,
      );

    wiring.complete();
    await flushDetached();
    expect(generatePhase).toHaveBeenCalledTimes(1);
    expect(generatedActivities).toHaveLength(2);
    expect(generatedActivities?.[0]?.entries?.[0]?.toolName).toBe('lc_transfer_to_billing_agent');
  });

  it('keeps reasoning attached to an unphased parallel tool batch', async () => {
    const parts: LooseContentPart[] = [];
    const generatePhase = jest.fn(async () => ({ label: 'unused' }));
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase,
    });
    const handlers = wiring.handlers({
      [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() },
      [GraphEvents.ON_REASONING_DELTA]: { handle: jest.fn() },
    });

    handlers?.[GraphEvents.ON_RUN_STEP]?.handle(
      GraphEvents.ON_RUN_STEP,
      {
        id: 'lane-reasoning',
        agentId: 'agent-a',
        groupId: 'lane-a',
        stepDetails: {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: { message_id: 'm', content_type: 'think' },
        },
      } as never,
      undefined,
      undefined,
    );
    handlers?.[GraphEvents.ON_REASONING_DELTA]?.handle(
      GraphEvents.ON_REASONING_DELTA,
      {
        id: 'lane-reasoning',
        delta: { content: { type: ContentTypes.THINK, think: 'Checked the lane input.' } },
      } as never,
      undefined,
      undefined,
    );
    parts.push({ type: ContentTypes.THINK, think: 'Checked the lane input.' });
    handlers?.[GraphEvents.ON_RUN_STEP]?.handle(
      GraphEvents.ON_RUN_STEP,
      {
        id: 'lane-text',
        agentId: 'agent-a',
        groupId: 'lane-a',
        stepDetails: {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: { message_id: 'm', content_type: 'text' },
        },
      } as never,
      undefined,
      undefined,
    );

    expect(wiring.snapshot()).toMatchObject({
      activityCount: 0,
      pendingReasoning: [{ key: 'agent-a', text: 'Checked the lane input.' }],
    });

    parts.push({ type: ContentTypes.TEXT, text: 'I will inspect the tool result.' });
    parts.push({ type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } });
    await wiring.hook(
      { ...batch('tool-1'), executingAgentId: 'agent-a' },
      new AbortController().signal,
    );
    expect(wiring.snapshot()).toMatchObject({
      activityCount: 1,
      activities: [expect.objectContaining({ thinkingExcerpts: ['Checked the lane input.'] })],
      pendingReasoning: [],
    });

    handlers?.[GraphEvents.ON_RUN_STEP]?.handle(
      GraphEvents.ON_RUN_STEP,
      {
        id: 'root-text',
        stepDetails: {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: { message_id: 'm', content_type: 'text' },
        },
      } as never,
      undefined,
      undefined,
    );
    await flushDetached();
    expect(generatePhase).not.toHaveBeenCalled();
    expect(parts.some((part) => part.activity_label_type === 'phase')).toBe(false);
  });

  it('anchors parallel standalone reasoning to each lane content part', async () => {
    const parts: LooseContentPart[] = [];
    const stepIndexes = new Map([
      ['reasoning-a', 0],
      ['reasoning-b', 1],
    ]);
    let generatedActivities: GenerateActivityPhasePayload['activities'] | undefined;
    const generatePhase = jest.fn(async (payload: GenerateActivityPhasePayload) => {
      generatedActivities = payload.activities;
      return { label: 'Reconciled both agent analyses' };
    });
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      getStepIndex: (stepId) => stepIndexes.get(stepId),
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase,
    });
    const handlers = wiring.handlers({
      [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() },
      [GraphEvents.ON_REASONING_DELTA]: { handle: jest.fn() },
    });
    const emitReasoning = (id: string, agentId: string, index: number, text: string) => {
      handlers?.[GraphEvents.ON_RUN_STEP]?.handle(
        GraphEvents.ON_RUN_STEP,
        {
          id,
          index,
          agentId,
          groupId: agentId,
          stepDetails: {
            type: StepTypes.MESSAGE_CREATION,
            message_creation: { message_id: 'm', content_type: 'think' },
          },
        } as never,
        undefined,
        undefined,
      );
      parts[index] = { type: ContentTypes.THINK, think: text, agentId, groupId: index + 1 };
      handlers?.[GraphEvents.ON_REASONING_DELTA]?.handle(
        GraphEvents.ON_REASONING_DELTA,
        {
          id,
          delta: { content: { type: ContentTypes.THINK, think: text } },
        } as never,
        undefined,
        undefined,
      );
    };
    emitReasoning('reasoning-a', 'agent-a', 0, 'Checked the first path.');
    emitReasoning('reasoning-b', 'agent-b', 1, 'Checked the second path.');

    expect(wiring.snapshot().pendingReasoning).toEqual([
      expect.objectContaining({ key: 'agent-a', startIndex: 0 }),
      expect.objectContaining({ key: 'agent-b', startIndex: 1 }),
    ]);

    handlers?.[GraphEvents.ON_RUN_STEP]?.handle(
      GraphEvents.ON_RUN_STEP,
      {
        id: 'root-final',
        index: 2,
        stepDetails: {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: { message_id: 'm', content_type: 'text', phase: 'final_answer' },
        },
      } as never,
      undefined,
      undefined,
    );

    wiring.complete();
    await flushDetached();
    expect(generatePhase).toHaveBeenCalledWith(
      expect.objectContaining({ activities: expect.arrayContaining([expect.any(Object)]) }),
    );
    expect(generatedActivities).toHaveLength(2);
    expect(parts[2]).toMatchObject({ activity_start_index: 0, activity_count: 2 });
  });

  it('restores bounded activity state after a HITL pause', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TEXT, text: 'Hidden intermediate output' },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } },
    ];
    const first = createActivityPhaseWiring({
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase: jest.fn(async () => ({})),
    });
    await first.hook(batch('tool-1'), new AbortController().signal);
    /** `hide_sequential_outputs` reshapes the persisted prefix after the pause
     *  snapshot, so restoration must re-anchor by tool id rather than index. */
    parts.shift();

    let generatedActivities: GenerateActivityPhasePayload['activities'] | undefined;
    const generatePhase = jest.fn(async (payload: GenerateActivityPhasePayload) => {
      generatedActivities = payload.activities;
      return { label: 'Completed the resumed investigation' };
    });
    const resumed = createActivityPhaseWiring({
      initialSnapshot: first.snapshot(),
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase,
    });
    parts.push({ type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } });
    await resumed.hook(batch('tool-2'), new AbortController().signal);
    resumed
      .handlers({
        [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() },
      })
      ?.[GraphEvents.ON_RUN_STEP]?.handle(
        GraphEvents.ON_RUN_STEP,
        {
          id: 'final-step',
          stepDetails: {
            type: StepTypes.MESSAGE_CREATION,
            message_creation: { message_id: 'm', content_type: 'text', phase: 'final_answer' },
          },
        } as never,
        undefined,
        undefined,
      );

    resumed.complete();
    await flushDetached();
    expect(generatePhase).toHaveBeenCalledWith(
      expect.objectContaining({ activities: expect.arrayContaining([expect.any(Object)]) }),
    );
    expect(generatedActivities).toHaveLength(2);
    expect(parts[parts.length - 1]).toMatchObject({ activity_start_index: 0 });
  });

  it('drops a stale pending-reasoning index after HITL content compaction', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } },
      { type: ContentTypes.TEXT, text: substantialText('The resumed answer is complete.') },
    ];
    const wiring = createActivityPhaseWiring({
      initialSnapshot: {
        version: 1,
        generated: 0,
        activityCount: 2,
        failedActivityCount: 0,
        partialActivityCount: 0,
        agentIds: [],
        activities: [
          { startIndex: 0, status: 'success', toolCallIds: ['tool-1'] },
          { startIndex: 1, status: 'success', toolCallIds: ['tool-2'] },
        ],
        assistantContext: [],
        pendingReasoning: [
          {
            key: 'root',
            text: 'Reasoning removed by hide_sequential_outputs.',
            startIndex: 20,
          },
        ],
      },
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase: jest.fn(async () => ({ label: 'Completed the resumed workflow' })),
    });

    wiring.complete();
    await flushDetached();

    expect(parts[3]).toMatchObject({ activity_end_index: 2, activity_count: 2 });
  });

  it('keeps index-less reasoning after a preceding substantial-text boundary', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } },
      { type: ContentTypes.TEXT, text: substantialText('This answer preceded more reasoning.') },
    ];
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase: jest.fn(async () => ({ label: 'Completed the extended investigation' })),
    });
    await wiring.hook(batch('tool-1'), new AbortController().signal);
    await wiring.hook(batch('tool-2'), new AbortController().signal);
    const handlers = wiring.handlers({
      [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() },
      [GraphEvents.ON_REASONING_DELTA]: { handle: jest.fn() },
    });
    handlers?.[GraphEvents.ON_RUN_STEP]?.handle(
      GraphEvents.ON_RUN_STEP,
      {
        id: 'late-reasoning',
        stepDetails: {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: { message_id: 'm', content_type: 'think' },
        },
      } as never,
      undefined,
      undefined,
    );
    parts[3] = { type: ContentTypes.THINK, think: 'Verified one more edge case.' };
    handlers?.[GraphEvents.ON_REASONING_DELTA]?.handle(
      GraphEvents.ON_REASONING_DELTA,
      {
        id: 'late-reasoning',
        delta: {
          content: { type: ContentTypes.THINK, think: 'Verified one more edge case.' },
        },
      } as never,
      undefined,
      undefined,
    );

    wiring.complete();
    await flushDetached();

    expect(parts[4]).toMatchObject({ activity_end_index: 2, activity_count: 2 });
  });

  it('does not force a partially materialized batch across a substantial boundary', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'batch-a' } },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } },
      {
        type: ContentTypes.TEXT,
        text: substantialText('This answer preceded the delayed batch tool.'),
      },
    ];
    const wiring = createActivityPhaseWiring({
      initialSnapshot: {
        version: 1,
        generated: 0,
        activityCount: 2,
        failedActivityCount: 0,
        partialActivityCount: 0,
        agentIds: [],
        activities: [
          {
            startIndex: 20,
            status: 'success',
            toolCallIds: ['batch-a', 'batch-b'],
          },
          { startIndex: 1, status: 'success', toolCallIds: ['tool-2'] },
        ],
        assistantContext: [],
        pendingReasoning: [],
      },
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase: jest.fn(async () => ({ label: 'Completed the delayed batch workflow' })),
    });

    wiring.complete();
    await flushDetached();

    expect(parts[3]).toBeUndefined();
  });

  it('bounds persisted evidence and the tracked activity window', async () => {
    const parts: LooseContentPart[] = [];
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase: jest.fn(async () => ({})),
    });
    for (let index = 0; index < 100; index += 1) {
      const id = `tool-${index}`;
      parts.push({ type: ContentTypes.TOOL_CALL, tool_call: { id } });
      await wiring.hook(batch(id), new AbortController().signal);
    }

    const snapshot = wiring.snapshot();
    expect(snapshot.version).toBe(3);
    /** Bounding drops evidence and folds anchors, never the count: a run that
     *  outgrows the anchor budget still reports every activity it performed. */
    expect(snapshot.activityCount).toBe(100);
    expect(snapshot.activities.length).toBeLessThanOrEqual(
      RETAINED_EVIDENCE_ACTIVITIES + OVERFLOW_ACTIVITY_ANCHORS,
    );
    const withEvidence = snapshot.activities.filter((activity) => activity.entries != null);
    expect(withEvidence).toHaveLength(RETAINED_EVIDENCE_ACTIVITIES);
    expect(totalTrackedCount(snapshot.activities)).toBe(100);
    expect(snapshot.activities.every((activity) => activity.startIndex >= 0)).toBe(true);
    /** Folding past the cap must not reorder positions or carry a count
     *  forward past a position it started before, or a later boundary would
     *  claim work that happened before it. */
    const positions = snapshot.activities.map((activity) => activity.startIndex);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(
      snapshot.activities.filter((activity) => (activity.mergedCount ?? 1) > 1).length,
    ).toBeGreaterThan(0);
  });

  /** The partition is the one place a phase decides what it owns, so its
   *  contract is checkable directly: wherever the boundary falls, every
   *  activity lands on exactly one side and the counts still sum to the run. */
  it('conserves and orders every activity across any substantial-text boundary', async () => {
    const TOTAL_ACTIVITIES = 8;
    for (let boundary = 2; boundary <= TOTAL_ACTIVITIES - 2; boundary += 1) {
      const parts: LooseContentPart[] = [];
      const wiring = createActivityPhaseWiring({
        getContentParts: () => parts,
        bumpIndexOffset: jest.fn(),
        emitLabelEvent: jest.fn(async () => undefined),
        trackPendingFill: jest.fn(),
        generatePhase: jest.fn(async () => ({ label: 'Phase' })),
      });
      for (let index = 0; index < TOTAL_ACTIVITIES; index += 1) {
        if (index === boundary) {
          parts.push({ type: ContentTypes.TEXT, text: substantialText('Interim result') });
        }
        const id = `tool-${boundary}-${index}`;
        parts.push({ type: ContentTypes.TOOL_CALL, tool_call: { id } });
        await wiring.hook(batch(id), new AbortController().signal);
      }

      wiring.complete();
      await flushDetached();

      const markers = parts.filter(
        (part) =>
          part?.type === ContentTypes.ACTIVITY_LABEL && part.activity_label_type === 'phase',
      );
      expect(markers.length).toBeGreaterThan(1);
      const counted = markers.reduce(
        (total, marker) => total + numericField(marker, 'activity_count'),
        0,
      );
      expect({ boundary, counted }).toEqual({ boundary, counted: TOTAL_ACTIVITIES });
      const ranges = markers
        .map((marker) => ({
          start: numericField(marker, 'activity_start_index'),
          end: numericField(marker, 'activity_end_index'),
        }))
        .sort((left, right) => left.start - right.start);
      for (const range of ranges) {
        expect(Number.isFinite(range.start) && Number.isFinite(range.end)).toBe(true);
        expect(range.end).toBeGreaterThan(range.start);
      }
      for (let position = 1; position < ranges.length; position += 1) {
        expect(ranges[position].start).toBeGreaterThanOrEqual(ranges[position - 1].end);
      }
    }
  });

  it('keeps a live unmaterialized batch after a substantial boundary', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'early-1' } },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'early-2' } },
    ];
    const generatePhase = jest.fn(async () => ({ label: 'Completed the early work' }));
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase,
    });
    await wiring.hook(batch('early-1'), new AbortController().signal);
    await wiring.hook(batch('early-2'), new AbortController().signal);
    parts.push({ type: ContentTypes.TEXT, text: substantialText('The interim answer.') });
    /** The child-label slot is reserved before the tool call lands, so this
     *  batch is tracked with nothing materialized while its real position is
     *  already past the boundary. */
    parts.push({
      type: ContentTypes.ACTIVITY_LABEL,
      [ContentTypes.ACTIVITY_LABEL]: 'Recorded the delayed result',
      tool_call_ids: ['delayed'],
      pending: false,
    });
    await wiring.hook(batch('delayed'), new AbortController().signal);

    wiring.complete();
    await flushDetached();

    const marker = parts.find(
      (part) => part?.type === ContentTypes.ACTIVITY_LABEL && part.activity_label_type === 'phase',
    );
    expect(marker).toMatchObject({ activity_end_index: 2, activity_count: 2 });
  });

  it('reanchors a delayed batch after dropping its already-covered call', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'covered' } },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'early-2' } },
      {
        type: ContentTypes.ACTIVITY_LABEL,
        [ContentTypes.ACTIVITY_LABEL]: 'Completed the first phase',
        activity_label_type: 'phase',
        activity_start_index: 0,
        activity_end_index: 2,
        activity_count: 2,
        pending: false,
      },
    ];
    const generatePhase = jest.fn(async () => ({ label: 'Completed the later phase' }));
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase,
    });
    parts.push({ type: ContentTypes.TEXT, text: substantialText('The interim answer.') });
    /** The delayed batch keeps one call already inside the emitted phase and
     *  one that has not materialized. The surviving activity is the uncovered
     *  call, so the covered call's index must not stand in for its position. */
    await wiring.hook(
      {
        hook_event_name: 'PostToolBatch',
        runId: 'run-1',
        entries: [
          {
            toolName: 'web_search',
            toolInput: { query: 'covered' },
            toolUseId: 'covered',
            status: 'success',
            toolOutput: 'covered-result',
          },
          {
            toolName: 'web_search',
            toolInput: { query: 'uncovered' },
            toolUseId: 'uncovered',
            status: 'success',
            toolOutput: 'uncovered-result',
          },
        ],
      } as PostToolBatchHookInput,
      new AbortController().signal,
    );
    parts.push({ type: ContentTypes.TOOL_CALL, tool_call: { id: 'later-2' } });
    await wiring.hook(batch('later-2'), new AbortController().signal);

    wiring.complete();
    await flushDetached();

    /** The uncovered call never materialized, so the delayed activity must be
     *  held past the boundary rather than inheriting the covered call's index
     *  and being counted in the phase that already closed. */
    const markers = parts.filter(
      (part) => part?.type === ContentTypes.ACTIVITY_LABEL && part.activity_label_type === 'phase',
    );
    expect(markers).toHaveLength(2);
    expect(markers[1]).toMatchObject({ activity_start_index: 3, activity_count: 2 });
  });

  it('clears a resolved missing-tool anchor before partitioning', async () => {
    const parts: LooseContentPart[] = [];
    const generatePhase = jest.fn(async () => ({ label: 'Completed the resumed work' }));
    const wiring = createActivityPhaseWiring({
      initialSnapshot: {
        version: 3,
        generated: 0,
        activityCount: 1,
        failedActivityCount: 0,
        partialActivityCount: 0,
        agentIds: [],
        activities: [{ startIndex: 9, status: 'success' as const, toolCallIds: ['delayed'] }],
        assistantContext: [],
        pendingReasoning: [],
      },
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase,
    });
    /** The saved tool was absent at construction, so the activity kept a high
     *  fallback anchor. It then materializes at index 0, well before the
     *  boundary, and must close with the earlier phase. */
    parts.push({ type: ContentTypes.TOOL_CALL, tool_call: { id: 'delayed' } });
    parts.push({ type: ContentTypes.TOOL_CALL, tool_call: { id: 'second' } });
    await wiring.hook(batch('second'), new AbortController().signal);
    parts.push({ type: ContentTypes.TEXT, text: substantialText('The resumed answer.') });

    wiring.complete();
    await flushDetached();

    expect(parts[3]).toMatchObject({
      activity_start_index: 0,
      activity_end_index: 2,
      activity_count: 2,
    });
  });

  /** Folding is a memory bound, not a data loss: whatever an anchor pair
   *  represented before the merge it must still represent after. Runs are
   *  sized to force many merges past the 77-activity tracked window. */
  it.each([
    { total: 100, failEvery: 0, agents: 1 },
    { total: 150, failEvery: 3, agents: 4 },
    { total: 220, failEvery: 7, agents: 220 },
  ])('conserves counts and agents while folding %o', async ({ total, failEvery, agents }) => {
    const parts: LooseContentPart[] = [];
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase: jest.fn(async () => ({})),
    });
    let expectedFailed = 0;
    for (let index = 0; index < total; index += 1) {
      const id = `tool-${index}`;
      const failed = failEvery > 0 && index % failEvery === 0;
      expectedFailed += failed ? 1 : 0;
      parts.push({ type: ContentTypes.TOOL_CALL, tool_call: { id } });
      const entry = {
        toolName: 'web_search',
        toolInput: { query: id },
        toolUseId: id,
        status: failed ? ('error' as const) : ('success' as const),
        ...(failed ? { error: 'boom' } : { toolOutput: `${id}-result` }),
      };
      await wiring.hook(
        {
          hook_event_name: 'PostToolBatch',
          runId: 'run-1',
          executingAgentId: `agent-${index % agents}`,
          entries: [entry],
        } as PostToolBatchHookInput,
        new AbortController().signal,
      );
    }

    const snapshot = wiring.snapshot();
    expect(snapshot.activityCount).toBe(total);
    expect(snapshot.failedActivityCount).toBe(expectedFailed);
    expect(totalTrackedCount(snapshot.activities)).toBe(total);
    const attributed = new Set(
      snapshot.activities.flatMap((activity) => [
        ...(activity.agentId != null ? [activity.agentId] : []),
        ...(activity.mergedAgentIds ?? []),
      ]),
    );
    expect(attributed.size).toBe(agents);
    /** Folding must not reorder: a later boundary would otherwise claim work
     *  that happened before it. */
    const positions = snapshot.activities.map((activity) => activity.startIndex);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it('carries an unresolved position through a folded anchor', async () => {
    const parts: LooseContentPart[] = [];
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase: jest.fn(async () => ({})),
    });
    for (let index = 0; index < 90; index += 1) {
      const id = `tool-${index}`;
      parts.push({ type: ContentTypes.TOOL_CALL, tool_call: { id } });
      await wiring.hook(batch(id), new AbortController().signal);
    }
    /** This batch's call never reaches the content array, so it is tracked
     *  with only a fallback position and must keep it through folding. */
    await wiring.hook(batch('never-materialized'), new AbortController().signal);
    for (let index = 0; index < 20; index += 1) {
      const id = `late-${index}`;
      parts.push({ type: ContentTypes.TOOL_CALL, tool_call: { id } });
      await wiring.hook(batch(id), new AbortController().signal);
    }

    const tracked = wiring.snapshot().activities;
    const holding = tracked.filter((activity) => activity.unresolvedToolStartIndex != null);
    expect(holding.length).toBeGreaterThan(0);
    expect(totalTrackedCount(tracked)).toBe(111);
  });

  it('keeps every contributing agent when folding anchors past the cap', async () => {
    const parts: LooseContentPart[] = [];
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase: jest.fn(async () => ({})),
    });
    for (let index = 0; index < 100; index += 1) {
      const id = `tool-${index}`;
      parts.push({ type: ContentTypes.TOOL_CALL, tool_call: { id } });
      await wiring.hook(
        { ...batch(id), executingAgentId: `agent-${index}` },
        new AbortController().signal,
      );
    }

    const tracked = wiring.snapshot().activities;
    const attributed = new Set(
      tracked.flatMap((activity) => [
        ...(activity.agentId != null ? [activity.agentId] : []),
        ...(activity.mergedAgentIds ?? []),
      ]),
    );
    /** Folding bounds memory, not attribution: an agent whose activity is
     *  still counted must still be creditable for it. */
    expect(attributed.size).toBe(totalTrackedCount(tracked));
  });

  it('retains every overflow tool ID tied at the latest boundary', async () => {
    const parts: LooseContentPart[] = [];
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase: jest.fn(async () => ({})),
    });
    for (let index = 0; index < 13; index += 1) {
      await wiring.hook(batch(`retained-${index}`), new AbortController().signal);
    }
    await wiring.hook(batch('overflow-a'), new AbortController().signal);
    await wiring.hook(batch('overflow-b'), new AbortController().signal);

    const anchors = wiring.snapshot().activities.filter((activity) => activity.bounded === true);
    expect(anchors.flatMap((activity) => activity.toolCallIds ?? [])).toEqual([
      'overflow-a',
      'overflow-b',
    ]);
  });

  it('anchors a phase represented entirely by retained overflow bookkeeping', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.THINK, think: 'Earlier retained work' },
      { type: ContentTypes.TEXT, text: substantialText('Persisted intermediate result.') },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'overflow-a' } },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'overflow-b' } },
    ];
    const wiring = createActivityPhaseWiring({
      initialSnapshot: {
        version: 1,
        generated: 0,
        activityCount: 15,
        failedActivityCount: 0,
        partialActivityCount: 0,
        agentIds: [],
        activities: Array.from({ length: 13 }, () => ({
          startIndex: 0,
          status: 'success' as const,
        })),
        overflowActivityStartIndex: 30,
        overflowToolCallIds: ['overflow-a', 'overflow-b'],
        overflowBoundaryToolCallIds: ['overflow-a', 'overflow-b'],
        assistantContext: [],
        pendingReasoning: [],
      },
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase: jest.fn(async () => ({ label: 'Completed the overflow phase' })),
    });

    wiring.complete();
    await flushDetached();

    expect(parts[5]).toMatchObject({
      activity_start_index: 2,
      activity_end_index: 5,
      activity_count: 2,
    });
    expect(Number.isFinite(parts[5]?.activity_start_index)).toBe(true);
    expect(Number.isFinite(parts[5]?.activity_end_index)).toBe(true);
  });

  it('partitions overflow activities on both sides of a substantial boundary', async () => {
    const parts: LooseContentPart[] = Array.from({ length: 13 }, (_, index) => ({
      type: ContentTypes.TOOL_CALL,
      tool_call: { id: `retained-${index}` },
    }));
    parts.push(
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'overflow-before' } },
      { type: ContentTypes.TEXT, text: substantialText('Persisted boundary.') },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'overflow-after' } },
    );
    const generatePhase = jest.fn(async () => ({ label: 'Completed the earlier overflow phase' }));
    const wiring = createActivityPhaseWiring({
      initialSnapshot: {
        version: 1,
        generated: 0,
        activityCount: 15,
        failedActivityCount: 0,
        partialActivityCount: 0,
        agentIds: [],
        activities: Array.from({ length: 13 }, (_, index) => ({
          startIndex: index,
          status: 'success' as const,
          toolCallIds: [`retained-${index}`],
        })),
        overflowActivityStartIndex: 15,
        overflowToolCallIds: ['overflow-before', 'overflow-after'],
        overflowBoundaryToolCallIds: ['overflow-after'],
        overflowActivities: [
          { startIndex: 13, status: 'success', toolCallIds: ['overflow-before'] },
          { startIndex: 15, status: 'success', toolCallIds: ['overflow-after'] },
        ],
        assistantContext: [],
        pendingReasoning: [],
      },
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase,
    });

    wiring.complete();
    await flushDetached();

    expect(generatePhase).toHaveBeenCalledTimes(1);
    expect(parts[16]).toMatchObject({ activity_end_index: 14, activity_count: 14 });
    expect(parts[17]).toBeUndefined();
  });

  it('rebases a resumed overflow anchor after content compaction', async () => {
    const parts: LooseContentPart[] = Array.from({ length: 13 }, (_, index) => ({
      type: ContentTypes.TOOL_CALL,
      tool_call: { id: `retained-${index}` },
    }));
    parts.push(
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'overflow-tool' } },
      { type: ContentTypes.TEXT, text: substantialText('The compacted answer is complete.') },
    );
    const generatePhase = jest.fn(async () => ({ label: 'Completed the resumed workflow' }));
    const wiring = createActivityPhaseWiring({
      initialSnapshot: {
        version: 1,
        generated: 0,
        activityCount: 14,
        failedActivityCount: 0,
        partialActivityCount: 0,
        agentIds: [],
        activities: Array.from({ length: 13 }, (_, index) => ({
          startIndex: index,
          status: 'success' as const,
          toolCallIds: [`retained-${index}`],
        })),
        overflowActivityStartIndex: 30,
        overflowToolCallIds: ['overflow-tool'],
        assistantContext: [],
        pendingReasoning: [],
      },
      getContentParts: () => parts,
      getStepIndex: (stepId) => (stepId === 'root-text' ? 14 : undefined),
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase,
    });
    wiring
      .handlers({ [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() } })
      ?.[GraphEvents.ON_RUN_STEP]?.handle(
        GraphEvents.ON_RUN_STEP,
        {
          id: 'root-text',
          stepDetails: {
            type: StepTypes.MESSAGE_CREATION,
            message_creation: { message_id: 'm', content_type: 'text' },
          },
        } as never,
        undefined,
        undefined,
      );

    wiring.complete();
    await flushDetached();

    expect(parts[15]).toMatchObject({ activity_end_index: 14, activity_count: 14 });
  });

  it('drops a stale reasoning-only overflow anchor after HITL compaction', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TEXT, text: substantialText('The compacted answer is complete.') },
    ];
    const generatePhase = jest.fn(async () => ({ label: 'Completed the resumed workflow' }));
    const wiring = createActivityPhaseWiring({
      initialSnapshot: {
        version: 1,
        generated: 0,
        activityCount: 14,
        failedActivityCount: 0,
        partialActivityCount: 0,
        agentIds: [],
        activities: Array.from({ length: 13 }, (_, index) => ({
          startIndex: 0,
          status: 'success' as const,
          thinkingExcerpts: [`Retained reasoning ${index} that was filtered on pause.`],
        })),
        overflowActivityStartIndex: 30,
        overflowReasoningExcerpt: 'Overflow reasoning that was filtered on pause.',
        assistantContext: [],
        pendingReasoning: [],
      },
      getContentParts: () => parts,
      getStepIndex: (stepId) => (stepId === 'root-text' ? 0 : undefined),
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase,
    });
    wiring
      .handlers({ [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() } })
      ?.[GraphEvents.ON_RUN_STEP]?.handle(
        GraphEvents.ON_RUN_STEP,
        {
          id: 'root-text',
          stepDetails: {
            type: StepTypes.MESSAGE_CREATION,
            message_creation: { message_id: 'm', content_type: 'text' },
          },
        } as never,
        undefined,
        undefined,
      );

    wiring.complete();
    await flushDetached();

    expect(parts[1]).toMatchObject({ activity_end_index: 0, activity_count: 13 });
  });

  it('splits duplicate reasoning anchors by their retained materialized positions', async () => {
    const duplicate = 'The same reasoning prefix identifies both retained activities.';
    const parts: LooseContentPart[] = [
      { type: ContentTypes.THINK, think: duplicate },
      { type: ContentTypes.TEXT, text: substantialText('This looked like the final answer.') },
      { type: ContentTypes.THINK, think: `${duplicate} Later activity details.` },
    ];
    const wiring = createActivityPhaseWiring({
      initialSnapshot: {
        version: 1,
        generated: 0,
        activityCount: 2,
        failedActivityCount: 0,
        partialActivityCount: 0,
        agentIds: [],
        activities: [
          { startIndex: 0, status: 'success', thinkingExcerpts: [duplicate] },
          { startIndex: 2, status: 'success', thinkingExcerpts: [duplicate] },
        ],
        assistantContext: [],
        pendingReasoning: [],
      },
      getContentParts: () => parts,
      getStepIndex: (stepId) => (stepId === 'root-text' ? 1 : undefined),
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase: jest.fn(async () => ({ label: 'Completed both reasoning passes' })),
    });
    wiring
      .handlers({ [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() } })
      ?.[GraphEvents.ON_RUN_STEP]?.handle(
        GraphEvents.ON_RUN_STEP,
        {
          id: 'root-text',
          stepDetails: {
            type: StepTypes.MESSAGE_CREATION,
            message_creation: { message_id: 'm', content_type: 'text' },
          },
        } as never,
        undefined,
        undefined,
      );

    wiring.complete();
    await flushDetached();

    expect(parts[3]).toBeUndefined();
  });

  it('keeps duplicate overflow reasoning after a substantial boundary', async () => {
    const duplicate = 'The overflow reasoning prefix is shared by both positions.';
    const parts: LooseContentPart[] = [
      { type: ContentTypes.THINK, think: duplicate },
      {
        type: ContentTypes.TEXT,
        text: substantialText('This looked like the final overflow answer.'),
      },
      { type: ContentTypes.THINK, think: `${duplicate} Later overflow details.` },
    ];
    const wiring = createActivityPhaseWiring({
      initialSnapshot: {
        version: 1,
        generated: 0,
        activityCount: 14,
        failedActivityCount: 0,
        partialActivityCount: 0,
        agentIds: [],
        activities: Array.from({ length: 13 }, () => ({
          startIndex: 0,
          status: 'success' as const,
        })),
        overflowActivityStartIndex: 2,
        overflowReasoningExcerpt: duplicate,
        assistantContext: [],
        pendingReasoning: [],
      },
      getContentParts: () => parts,
      getStepIndex: (stepId) => (stepId === 'root-text' ? 1 : undefined),
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase: jest.fn(async () => ({ label: 'Completed overflow reasoning' })),
    });
    wiring
      .handlers({ [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() } })
      ?.[GraphEvents.ON_RUN_STEP]?.handle(
        GraphEvents.ON_RUN_STEP,
        {
          id: 'root-text',
          stepDetails: {
            type: StepTypes.MESSAGE_CREATION,
            message_creation: { message_id: 'm', content_type: 'text' },
          },
        } as never,
        undefined,
        undefined,
      );

    wiring.complete();
    await flushDetached();

    expect(parts[3]).toMatchObject({ activity_end_index: 1, activity_count: 13 });
  });

  it('checks every overflow reasoning anchor when delayed parts materialize out of order', async () => {
    const earlier = 'The earlier overflow activity finished after the apparent answer.';
    const later = 'The later overflow activity materialized before the apparent answer.';
    const parts: LooseContentPart[] = [
      { type: ContentTypes.THINK, think: later },
      {
        type: ContentTypes.TEXT,
        text: substantialText('This looked like the final overflow answer.'),
      },
      { type: ContentTypes.THINK, think: earlier },
    ];
    const wiring = createActivityPhaseWiring({
      initialSnapshot: {
        version: 1,
        generated: 0,
        activityCount: 15,
        failedActivityCount: 0,
        partialActivityCount: 0,
        agentIds: [],
        activities: Array.from({ length: 13 }, () => ({
          startIndex: 0,
          status: 'success' as const,
        })),
        overflowActivityStartIndex: 2,
        overflowReasoningAnchors: [earlier, later],
        assistantContext: [],
        pendingReasoning: [],
      },
      getContentParts: () => parts,
      getStepIndex: (stepId) => (stepId === 'root-text' ? 1 : undefined),
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase: jest.fn(async () => ({ label: 'Completed overflow reasoning' })),
    });
    wiring
      .handlers({ [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() } })
      ?.[GraphEvents.ON_RUN_STEP]?.handle(
        GraphEvents.ON_RUN_STEP,
        {
          id: 'root-text',
          stepDetails: {
            type: StepTypes.MESSAGE_CREATION,
            message_creation: { message_id: 'm', content_type: 'text' },
          },
        } as never,
        undefined,
        undefined,
      );

    wiring.complete();
    await flushDetached();

    expect(parts[3]).toMatchObject({ activity_end_index: 1, activity_count: 13 });
  });

  it('retains an earlier overflow ID when delayed tools materialize in reverse order', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'overflow-b' } },
      {
        type: ContentTypes.TEXT,
        text: substantialText('This answer arrived between delayed tools.'),
      },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'overflow-a' } },
    ];
    const generatePhase = jest.fn(async () => ({ label: 'Completed the delayed workflow' }));
    const wiring = createActivityPhaseWiring({
      initialSnapshot: {
        version: 1,
        generated: 0,
        activityCount: 15,
        failedActivityCount: 0,
        partialActivityCount: 0,
        agentIds: [],
        activities: Array.from({ length: 13 }, () => ({
          startIndex: 0,
          status: 'success' as const,
        })),
        overflowActivityStartIndex: 20,
        overflowToolCallIds: ['overflow-a', 'overflow-b'],
        assistantContext: [],
        pendingReasoning: [],
      },
      getContentParts: () => parts,
      getStepIndex: (stepId) => (stepId === 'root-text' ? 1 : undefined),
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase,
    });
    wiring
      .handlers({ [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() } })
      ?.[GraphEvents.ON_RUN_STEP]?.handle(
        GraphEvents.ON_RUN_STEP,
        {
          id: 'root-text',
          stepDetails: {
            type: StepTypes.MESSAGE_CREATION,
            message_creation: { message_id: 'm', content_type: 'text' },
          },
        } as never,
        undefined,
        undefined,
      );

    wiring.complete();
    await flushDetached();

    /** One saved overflow tool materialized on each side of the boundary, so
     *  the earlier phase owns the earlier one instead of the later phase
     *  claiming the whole remainder. */
    expect(parts[3]).toMatchObject({ activity_end_index: 1, activity_count: 14 });
  });

  it('keeps the overflow fallback while a boundary tool remains unresolved', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'overflow-a' } },
      {
        type: ContentTypes.TEXT,
        text: substantialText('This answer preceded a delayed overflow tool.'),
      },
    ];
    const wiring = createActivityPhaseWiring({
      initialSnapshot: {
        version: 1,
        generated: 0,
        activityCount: 15,
        failedActivityCount: 0,
        partialActivityCount: 0,
        agentIds: [],
        activities: Array.from({ length: 13 }, () => ({
          startIndex: 0,
          status: 'success' as const,
        })),
        overflowActivityStartIndex: 20,
        overflowToolCallIds: ['overflow-a', 'overflow-b'],
        overflowBoundaryToolCallIds: ['overflow-a', 'overflow-b'],
        assistantContext: [],
        pendingReasoning: [],
      },
      getContentParts: () => parts,
      getStepIndex: (stepId) => (stepId === 'root-text' ? 1 : undefined),
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase: jest.fn(async () => ({ label: 'Completed the delayed workflow' })),
    });
    wiring
      .handlers({ [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() } })
      ?.[GraphEvents.ON_RUN_STEP]?.handle(
        GraphEvents.ON_RUN_STEP,
        {
          id: 'root-text',
          stepDetails: {
            type: StepTypes.MESSAGE_CREATION,
            message_creation: { message_id: 'm', content_type: 'text' },
          },
        } as never,
        undefined,
        undefined,
      );

    wiring.complete();
    await flushDetached();

    expect(parts[2]).toMatchObject({ activity_end_index: 1, activity_count: 13 });
  });

  it('extends a sparse phase start using only defined boundary slots', async () => {
    const parts: LooseContentPart[] = [];
    parts[999_998] = { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-a' } };
    parts[1_000_000] = { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-b' } };
    const wiring = createActivityPhaseWiring({
      initialSnapshot: {
        version: 1,
        generated: 0,
        activityCount: 2,
        failedActivityCount: 0,
        partialActivityCount: 0,
        agentIds: [],
        activities: [
          { startIndex: 999_998, status: 'success', toolCallIds: ['tool-a'] },
          { startIndex: 1_000_000, status: 'success', toolCallIds: ['tool-b'] },
        ],
        assistantContext: [],
        pendingReasoning: [],
      },
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase: jest.fn(async () => ({ label: 'Completed the sparse workflow' })),
    });

    wiring.complete();
    await flushDetached();

    expect(parts[1_000_001]).toMatchObject({ activity_start_index: 0, activity_count: 2 });
  });

  it('keeps post-cap activities outside the phase before substantial text', async () => {
    const parts: LooseContentPart[] = [];
    const generatePhase = jest.fn(async () => ({ label: 'Completed the extended investigation' }));
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      getStepIndex: (stepId) => (stepId === 'root-text' ? 13 : undefined),
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase,
    });
    for (let index = 0; index < 13; index += 1) {
      const id = `tool-${index}`;
      parts.push({ type: ContentTypes.TOOL_CALL, tool_call: { id } });
      await wiring.hook(batch(id), new AbortController().signal);
    }
    wiring
      .handlers({ [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() } })
      ?.[GraphEvents.ON_RUN_STEP]?.handle(
        GraphEvents.ON_RUN_STEP,
        {
          id: 'root-text',
          stepDetails: {
            type: StepTypes.MESSAGE_CREATION,
            message_creation: { message_id: 'm', content_type: 'text' },
          },
        } as never,
        undefined,
        undefined,
      );
    parts[13] = {
      type: ContentTypes.TEXT,
      text: substantialText('This may be the final answer.'),
    };
    parts[14] = { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-overflow' } };
    await wiring.hook(batch('tool-overflow'), new AbortController().signal);

    wiring.complete();
    await flushDetached();

    expect(generatePhase).toHaveBeenCalledTimes(1);
    expect(parts[15]).toMatchObject({
      activity_start_index: 0,
      activity_end_index: 13,
      activity_count: 13,
    });
  });

  it('finds an unphased final content part without a retained run-step boundary', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } },
      { type: ContentTypes.TEXT, text: substantialText('The persisted answer is complete.') },
    ];
    const generatePhase = jest.fn(async () => ({ label: 'Completed the persisted workflow' }));
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase,
    });
    await wiring.hook(batch('tool-1'), new AbortController().signal);
    await wiring.hook(batch('tool-2'), new AbortController().signal);

    wiring.complete();
    await flushDetached();

    expect(parts[3]).toMatchObject({
      activity_start_index: 0,
      activity_end_index: 2,
      activity_count: 2,
    });
  });

  it('excludes the persisted final text from the phase summary context', async () => {
    const finalText = substantialText('The persisted answer is complete.');
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } },
      { type: ContentTypes.TEXT, text: finalText },
    ];
    const generatePhase = jest.fn(async () => ({ label: 'Completed the persisted workflow' }));
    const wiring = createActivityPhaseWiring({
      initialSnapshot: {
        version: 1,
        generated: 0,
        activityCount: 2,
        failedActivityCount: 0,
        partialActivityCount: 0,
        agentIds: [],
        activities: [
          { startIndex: 0, status: 'success', toolCallIds: ['tool-1'] },
          { startIndex: 1, status: 'success', toolCallIds: ['tool-2'] },
        ],
        assistantContext: ['I will inspect both sources.', finalText],
        pendingReasoning: [],
      },
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase,
    });

    wiring.complete();
    await flushDetached();

    expect(generatePhase).toHaveBeenCalledWith(
      expect.objectContaining({ assistantContext: ['I will inspect both sources.'] }),
    );
    expect(parts[3]).toMatchObject({ activity_end_index: 2, activity_count: 2 });
  });

  it('prefers the materialized final text over a stale retained step index', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } },
    ];
    const generatePhase = jest.fn(async () => ({ label: 'Completed the indexed workflow' }));
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      getStepIndex: (stepId) => (stepId === 'root-text' ? 3 : undefined),
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase,
    });
    await wiring.hook(batch('tool-1'), new AbortController().signal);
    await wiring.hook(batch('tool-2'), new AbortController().signal);
    wiring
      .handlers({
        [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() },
      })
      ?.[GraphEvents.ON_RUN_STEP]?.handle(
        GraphEvents.ON_RUN_STEP,
        {
          id: 'root-text',
          stepDetails: {
            type: StepTypes.MESSAGE_CREATION,
            message_creation: { message_id: 'm', content_type: 'text' },
          },
        } as never,
        undefined,
        undefined,
      );
    parts[2] = {
      type: ContentTypes.TEXT,
      text: substantialText('The indexed answer is complete.'),
    };

    wiring.complete();
    await flushDetached();

    expect(parts[3]).toMatchObject({
      activity_start_index: 0,
      activity_end_index: 2,
      activity_count: 2,
    });
  });

  it('leaves the last materialized text outside even when it retains a lane id', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } },
      {
        type: ContentTypes.TEXT,
        text: substantialText('The lane answer is complete.'),
        phase: 'final_answer',
        groupId: 'lane-a',
      },
    ];
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase: jest.fn(async () => ({ label: 'Completed the lane workflow' })),
    });
    await wiring.hook(batch('tool-1'), new AbortController().signal);
    await wiring.hook(batch('tool-2'), new AbortController().signal);

    wiring.complete();
    await flushDetached();

    expect(parts[3]).toMatchObject({ activity_end_index: 2, activity_count: 2 });
  });

  it('skips a trailing empty text reservation when choosing the final boundary', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } },
      {
        type: ContentTypes.TEXT,
        text: substantialText('The materialized answer is complete.'),
      },
      { type: ContentTypes.TEXT, text: '', phase: 'final_answer' },
    ];
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      getStepIndex: (stepId) => (stepId === 'empty-final' ? 3 : undefined),
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase: jest.fn(async () => ({ label: 'Completed the workflow' })),
    });
    await wiring.hook(batch('tool-1'), new AbortController().signal);
    await wiring.hook(batch('tool-2'), new AbortController().signal);
    wiring
      .handlers({ [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() } })
      ?.[GraphEvents.ON_RUN_STEP]?.handle(
        GraphEvents.ON_RUN_STEP,
        {
          id: 'empty-final',
          stepDetails: {
            type: StepTypes.MESSAGE_CREATION,
            message_creation: { message_id: 'm', content_type: 'text' },
          },
        } as never,
        undefined,
        undefined,
      );

    wiring.complete();
    await flushDetached();

    expect(parts[4]).toMatchObject({ activity_end_index: 2, activity_count: 2 });
  });

  it('ignores an empty reasoning reservation after the materialized final text', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } },
      { type: ContentTypes.TEXT, text: substantialText('The answer is complete.') },
      { type: ContentTypes.THINK, think: '' },
    ];
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      getStepIndex: (stepId) => (stepId === 'empty-reasoning' ? 3 : undefined),
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase: jest.fn(async () => ({ label: 'Completed the workflow' })),
    });
    await wiring.hook(batch('tool-1'), new AbortController().signal);
    await wiring.hook(batch('tool-2'), new AbortController().signal);
    wiring
      .handlers({
        [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() },
      })
      ?.[GraphEvents.ON_RUN_STEP]?.handle(
        GraphEvents.ON_RUN_STEP,
        {
          id: 'empty-reasoning',
          stepDetails: {
            type: StepTypes.MESSAGE_CREATION,
            message_creation: { message_id: 'm', content_type: 'think' },
          },
        } as never,
        undefined,
        undefined,
      );

    wiring.complete();
    await flushDetached();

    expect(parts[4]).toMatchObject({ activity_end_index: 2, activity_count: 2 });
  });

  it('keeps a parallel lane final inside the run-wide phase', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } },
    ];
    const generatePhase = jest.fn(async () => ({ label: 'Combined both agent outcomes' }));
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase,
    });
    await wiring.hook(batch('tool-1'), new AbortController().signal);
    parts.push({ type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } });
    await wiring.hook(batch('tool-2'), new AbortController().signal);
    const handler = wiring.handlers({
      [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() },
    })?.[GraphEvents.ON_RUN_STEP];
    const finalStep = {
      id: 'lane-final',
      groupId: 'lane-a',
      stepDetails: {
        type: StepTypes.MESSAGE_CREATION,
        message_creation: { message_id: 'm', content_type: 'text', phase: 'final_answer' },
      },
    };
    handler?.handle(GraphEvents.ON_RUN_STEP, finalStep as never, undefined, undefined);
    await flushDetached();
    expect(generatePhase).not.toHaveBeenCalled();

    handler?.handle(
      GraphEvents.ON_RUN_STEP,
      { ...finalStep, id: 'root-final', groupId: undefined } as never,
      undefined,
      undefined,
    );
    wiring.complete();
    await flushDetached();
    expect(generatePhase).toHaveBeenCalledTimes(1);
  });

  it('keeps unphased parallel text inside the run-wide fallback phase', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } },
    ];
    const generatePhase = jest.fn(async () => ({ label: 'Combined both agent outcomes' }));
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase,
    });
    await wiring.hook(batch('tool-1'), new AbortController().signal);
    parts.push({ type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } });
    await wiring.hook(batch('tool-2'), new AbortController().signal);
    const handler = wiring.handlers({
      [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() },
    })?.[GraphEvents.ON_RUN_STEP];
    const textStep = {
      id: 'lane-text',
      groupId: 'lane-a',
      stepDetails: {
        type: StepTypes.MESSAGE_CREATION,
        message_creation: { message_id: 'm', content_type: 'text' },
      },
    };
    handler?.handle(GraphEvents.ON_RUN_STEP, textStep as never, undefined, undefined);
    await flushDetached();
    expect(generatePhase).not.toHaveBeenCalled();

    handler?.handle(
      GraphEvents.ON_RUN_STEP,
      { ...textStep, id: 'root-text', groupId: undefined } as never,
      undefined,
      undefined,
    );
    await flushDetached();
    expect(generatePhase).not.toHaveBeenCalled();

    parts[2] = { type: ContentTypes.TEXT, text: 'Finished the run' };
    wiring.complete();
    await flushDetached();
    expect(generatePhase).toHaveBeenCalledTimes(1);
    /** The lane text stays inside, but the root's short answer is still the
     *  run's visible reply and must not collapse into the parent card. */
    expect(parts[3]).toMatchObject({
      activity_start_index: 0,
      activity_end_index: 2,
      activity_count: 2,
    });
  });

  it('keeps short final semantic commentary inside a completion-finalized phase', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } },
    ];
    const generatePhase = jest.fn(async () => ({ label: 'Completed the commentary phase' }));
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      getStepIndex: (stepId) => (stepId === 'root-commentary' ? 2 : undefined),
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase,
    });
    await wiring.hook(batch('tool-1'), new AbortController().signal);
    parts[1] = { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } };
    await wiring.hook(batch('tool-2'), new AbortController().signal);
    const handler = wiring.handlers({
      [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() },
    })?.[GraphEvents.ON_RUN_STEP];
    handler?.handle(
      GraphEvents.ON_RUN_STEP,
      {
        id: 'root-commentary',
        stepDetails: {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: { message_id: 'm', content_type: 'text', phase: 'commentary' },
        },
      } as never,
      undefined,
      undefined,
    );
    parts[2] = { type: ContentTypes.TEXT, text: 'Intermediate commentary', phase: 'commentary' };

    wiring.complete();
    await flushDetached();

    expect(parts[3]).toMatchObject({
      activity_start_index: 0,
      activity_end_index: 3,
      activity_count: 2,
    });
  });

  it('keeps short semantic commentary inside after earlier unphased text', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } },
    ];
    const stepIndexes = new Map([
      ['root-text', 1],
      ['commentary', 3],
    ]);
    const generatePhase = jest.fn(async () => ({ label: 'Completed the commentary phase' }));
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      getStepIndex: (stepId) => stepIndexes.get(stepId),
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase,
    });
    await wiring.hook(batch('tool-1'), new AbortController().signal);
    const handler = wiring.handlers({
      [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() },
    })?.[GraphEvents.ON_RUN_STEP];
    handler?.handle(
      GraphEvents.ON_RUN_STEP,
      {
        id: 'root-text',
        stepDetails: {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: { message_id: 'm', content_type: 'text' },
        },
      } as never,
      undefined,
      undefined,
    );
    parts[1] = { type: ContentTypes.TEXT, text: 'I will keep investigating.' };
    parts[2] = { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } };
    await wiring.hook(batch('tool-2'), new AbortController().signal);
    handler?.handle(
      GraphEvents.ON_RUN_STEP,
      {
        id: 'commentary',
        stepDetails: {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: { message_id: 'm', content_type: 'text', phase: 'commentary' },
        },
      } as never,
      undefined,
      undefined,
    );
    parts[3] = {
      type: ContentTypes.TEXT,
      text: 'The second search confirmed it.',
      phase: 'commentary',
    };

    wiring.complete();
    await flushDetached();

    expect(parts[4]).toMatchObject({
      activity_start_index: 0,
      activity_end_index: 4,
      activity_count: 2,
    });
  });

  it('keeps persisted short commentary inside the phase after HITL resume', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } },
      { type: ContentTypes.TEXT, text: 'I will keep investigating.' },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } },
      { type: ContentTypes.TEXT, text: 'The second search confirmed it.', phase: 'commentary' },
    ];
    const generatePhase = jest.fn(async () => ({ label: 'Completed the resumed commentary' }));
    const wiring = createActivityPhaseWiring({
      initialSnapshot: {
        version: 1,
        generated: 0,
        activityCount: 2,
        failedActivityCount: 0,
        partialActivityCount: 0,
        agentIds: [],
        activities: [
          { startIndex: 0, status: 'success', toolCallIds: ['tool-1'] },
          { startIndex: 2, status: 'success', toolCallIds: ['tool-2'] },
        ],
        assistantContext: [],
        pendingReasoning: [],
      },
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase,
    });

    wiring.complete();
    await flushDetached();

    expect(parts[4]).toMatchObject({
      activity_start_index: 0,
      activity_end_index: 4,
      activity_count: 2,
    });
  });

  /** The mock provider in e2e emits no phase metadata, so an unphased short
   *  reply is the common real case, not an edge case. Length decides whether
   *  intermediate text earns a boundary; the run's answer is always outside. */
  it('keeps a short unphased final answer outside the collapsed phase', async () => {
    const parts: LooseContentPart[] = [];
    const generatePhase = jest.fn(async () => ({ label: 'Completed the run' }));
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase,
    });
    parts.push({ type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } });
    await wiring.hook(batch('tool-1'), new AbortController().signal);
    parts.push({ type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } });
    await wiring.hook(batch('tool-2'), new AbortController().signal);
    parts.push({ type: ContentTypes.TEXT, text: 'Done' });

    wiring.complete();
    await flushDetached();

    expect(parts[3]).toMatchObject({
      activity_label_type: 'phase',
      activity_start_index: 0,
      activity_end_index: 2,
      activity_count: 2,
    });
  });

  it('summarizes all activities and short text once at root-run completion', async () => {
    const parts: LooseContentPart[] = [];
    const stepIndexes = new Map([
      ['intermediate-text', 2],
      ['final-text', 5],
    ]);
    const generatePhase = jest.fn(async () => ({ label: 'Completed the full investigation' }));
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      getStepIndex: (stepId) => stepIndexes.get(stepId),
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase,
    });
    const handler = wiring.handlers({
      [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() },
    })?.[GraphEvents.ON_RUN_STEP];

    parts[0] = { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } };
    await wiring.hook(batch('tool-1'), new AbortController().signal);
    parts[1] = { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } };
    await wiring.hook(batch('tool-2'), new AbortController().signal);
    handler?.handle(
      GraphEvents.ON_RUN_STEP,
      {
        id: 'intermediate-text',
        stepDetails: {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: { message_id: 'm', content_type: 'text' },
        },
      } as never,
      undefined,
      undefined,
    );
    parts[2] = { type: ContentTypes.TEXT, text: 'I will try another approach.' };

    parts[3] = { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-3' } };
    await wiring.hook(batch('tool-3'), new AbortController().signal);
    parts[4] = { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-4' } };
    await wiring.hook(batch('tool-4'), new AbortController().signal);
    handler?.handle(
      GraphEvents.ON_RUN_STEP,
      {
        id: 'final-text',
        stepDetails: {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: { message_id: 'm', content_type: 'text' },
        },
      } as never,
      undefined,
      undefined,
    );
    parts[5] = { type: ContentTypes.TEXT, text: 'The investigation is complete.' };
    parts[6] = {
      type: ContentTypes.ACTIVITY_LABEL,
      [ContentTypes.ACTIVITY_LABEL]: 'Recorded the delayed child result',
      tool_call_ids: ['tool-4'],
      pending: false,
    };

    expect(generatePhase).not.toHaveBeenCalled();
    wiring.complete();
    await flushDetached();

    expect(generatePhase).toHaveBeenCalledTimes(1);
    expect(generatePhase).toHaveBeenCalledWith(expect.objectContaining({ totalActivityCount: 4 }));
    expect(parts[7]).toMatchObject({
      activity_label_type: 'phase',
      activity_start_index: 0,
      activity_end_index: 5,
      activity_count: 4,
    });
  });

  it('keeps later activities grouped when the last root text preceded them', async () => {
    const parts: LooseContentPart[] = [{ type: ContentTypes.TEXT, text: 'I will investigate.' }];
    const generatePhase = jest.fn(async () => ({ label: 'Completed the direct-return workflow' }));
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      getStepIndex: (stepId) => (stepId === 'root-text' ? 0 : undefined),
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase,
    });
    const handler = wiring.handlers({
      [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() },
    })?.[GraphEvents.ON_RUN_STEP];
    handler?.handle(
      GraphEvents.ON_RUN_STEP,
      {
        id: 'root-text',
        stepDetails: {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: { message_id: 'm', content_type: 'text' },
        },
      } as never,
      undefined,
      undefined,
    );
    parts[1] = { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } };
    await wiring.hook(batch('tool-1'), new AbortController().signal);
    parts[2] = { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } };
    await wiring.hook(batch('tool-2'), new AbortController().signal);

    wiring.complete();
    await flushDetached();

    expect(generatePhase).toHaveBeenCalledTimes(1);
    expect(parts[3]).toMatchObject({
      activity_start_index: 0,
      activity_end_index: 3,
      activity_count: 2,
    });
  });

  it('keeps a parallel tool batch grouped when it straddles the last root text', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'parallel-1' } },
    ];
    const generatePhase = jest.fn(async () => ({ label: 'Completed the parallel workflow' }));
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      getStepIndex: (stepId) => (stepId === 'root-text' ? 2 : undefined),
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase,
    });
    await wiring.hook(batch('tool-1'), new AbortController().signal);
    const parallelBatch = batch('parallel-1');
    parallelBatch.entries.push({
      ...parallelBatch.entries[0],
      toolUseId: 'parallel-2',
      toolInput: { query: 'parallel-2' },
      toolOutput: 'parallel-2-result',
    });
    await wiring.hook(parallelBatch, new AbortController().signal);
    const handler = wiring.handlers({
      [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() },
    })?.[GraphEvents.ON_RUN_STEP];
    handler?.handle(
      GraphEvents.ON_RUN_STEP,
      {
        id: 'root-text',
        stepDetails: {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: { message_id: 'm', content_type: 'text' },
        },
      } as never,
      undefined,
      undefined,
    );
    parts[2] = { type: ContentTypes.TEXT, text: 'The parallel work may be complete.' };
    parts[3] = { type: ContentTypes.TOOL_CALL, tool_call: { id: 'parallel-2' } };

    wiring.complete();
    await flushDetached();

    expect(generatePhase).toHaveBeenCalledTimes(1);
    expect(parts[4]).toMatchObject({
      activity_start_index: 0,
      activity_end_index: 4,
      activity_count: 2,
    });
  });

  it('preserves mixed batch failures as a partial phase outcome', async () => {
    const mixed = batch('tool-1');
    mixed.entries.push({
      toolName: 'web_search',
      toolInput: { query: 'failed' },
      toolUseId: 'tool-1b',
      status: 'error',
      error: 'unavailable',
    });
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1b' } },
    ];
    const generatePhase = jest.fn(async () => ({ label: 'Recovered part of the search scope' }));
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase,
    });
    await wiring.hook(mixed, new AbortController().signal);
    parts.push({ type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } });
    await wiring.hook(batch('tool-2'), new AbortController().signal);
    wiring
      .handlers({
        [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() },
      })
      ?.[GraphEvents.ON_RUN_STEP]?.handle(
        GraphEvents.ON_RUN_STEP,
        {
          id: 'final-step',
          stepDetails: {
            type: StepTypes.MESSAGE_CREATION,
            message_creation: { message_id: 'm', content_type: 'text', phase: 'final_answer' },
          },
        } as never,
        undefined,
        undefined,
      );

    wiring.complete();
    await flushDetached();
    expect(generatePhase).toHaveBeenCalledWith(expect.objectContaining({ status: 'partial' }));
    expect(parts[parts.length - 1]).toMatchObject({ status: 'partial' });
  });

  it('collects usage after a committed blank phase result', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } },
    ];
    const collectUsage = jest.fn(async () => undefined);
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase: jest.fn(async () => ({ collectUsage })),
    });
    await wiring.hook(batch('tool-1'), new AbortController().signal);
    parts.push({ type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } });
    await wiring.hook(batch('tool-2'), new AbortController().signal);
    wiring
      .handlers({
        [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() },
      })
      ?.[GraphEvents.ON_RUN_STEP]?.handle(
        GraphEvents.ON_RUN_STEP,
        {
          id: 'final-step',
          stepDetails: {
            type: StepTypes.MESSAGE_CREATION,
            message_creation: { message_id: 'm', content_type: 'text', phase: 'final_answer' },
          },
        } as never,
        undefined,
        undefined,
      );

    wiring.complete();
    await flushDetached();
    expect(collectUsage).toHaveBeenCalledWith(undefined);
    expect(parts[parts.length - 1]).toMatchObject({ activity_label: '', pending: false });
  });

  it('ignores late tool hooks already covered by an emitted phase', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'late-tool-1' } },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'late-tool-2' } },
    ];
    const generatePhase = jest.fn(async () => ({ label: 'Completed the covered work' }));
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      getStepIndex: (stepId) => (stepId === 'boundary' ? 4 : undefined),
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase,
    });
    await wiring.hook(batch('tool-1'), new AbortController().signal);
    await wiring.hook(batch('tool-2'), new AbortController().signal);
    const handlers = wiring.handlers({
      [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() },
      [GraphEvents.ON_MESSAGE_DELTA]: {
        handle: (_event, data) => {
          const delta = data as { delta?: { content?: { text?: string } } };
          parts[4] = { type: ContentTypes.TEXT, text: delta.delta?.content?.text ?? '' };
        },
      },
    });
    handlers?.[GraphEvents.ON_RUN_STEP]?.handle(
      GraphEvents.ON_RUN_STEP,
      {
        id: 'boundary',
        stepDetails: {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: { message_id: 'm', content_type: 'text' },
        },
      } as never,
      undefined,
      undefined,
    );
    handlers?.[GraphEvents.ON_MESSAGE_DELTA]?.handle(
      GraphEvents.ON_MESSAGE_DELTA,
      {
        id: 'boundary',
        delta: { content: { type: ContentTypes.TEXT, text: substantialText('Boundary result.') } },
      } as never,
      undefined,
      undefined,
    );

    await wiring.hook(batch('late-tool-1'), new AbortController().signal);
    await wiring.hook(batch('late-tool-2'), new AbortController().signal);
    wiring.complete();
    await flushDetached();

    expect(generatePhase).toHaveBeenCalledTimes(1);
    expect(parts.filter((part) => part.activity_label_type === 'phase')).toHaveLength(1);
    expect(wiring.snapshot().activityCount).toBe(0);
  });

  it('retains uncovered calls from a delayed straddling tool batch', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'covered-call' } },
      { type: ContentTypes.TEXT, text: substantialText('Boundary result.') },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'uncovered-call' } },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-3' } },
    ];
    const payloads: GenerateActivityPhasePayload[] = [];
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase: jest.fn(async (payload: GenerateActivityPhasePayload) => {
        payloads.push(payload);
        return { label: 'Completed one phase' };
      }),
    });
    await wiring.hook(batch('tool-1'), new AbortController().signal);
    await wiring.hook(batch('tool-2'), new AbortController().signal);
    wiring.complete();

    const delayedBatch = batch('covered-call');
    delayedBatch.entries.push({
      ...delayedBatch.entries[0],
      toolUseId: 'uncovered-call',
      toolInput: { query: 'uncovered-call' },
    });
    await wiring.hook(delayedBatch, new AbortController().signal);
    await wiring.hook(batch('tool-3'), new AbortController().signal);
    wiring.complete();
    await flushDetached();

    expect(payloads.map(({ totalActivityCount }) => totalActivityCount)).toEqual([2, 2]);
    expect(payloads[1].activities[0]).toMatchObject({
      entries: [expect.objectContaining({ toolInput: { query: 'uncovered-call' } })],
    });
  });

  it('keeps a short semantic final answer outside the collapsed phase', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } },
    ];
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      getStepIndex: (stepId) => (stepId === 'final-step' ? 2 : undefined),
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase: jest.fn(async () => ({ label: 'Completed the requested work' })),
    });
    await wiring.hook(batch('tool-1'), new AbortController().signal);
    await wiring.hook(batch('tool-2'), new AbortController().signal);
    const handlers = wiring.handlers({
      [GraphEvents.ON_RUN_STEP]: {
        handle: () => {
          parts[2] = { type: ContentTypes.TEXT, text: '', phase: 'final_answer' };
        },
      },
      [GraphEvents.ON_MESSAGE_DELTA]: {
        handle: (_event, data) => {
          const delta = data as { delta?: { content?: { text?: string } } };
          parts[2] = {
            type: ContentTypes.TEXT,
            text: `${parts[2]?.text ?? ''}${delta.delta?.content?.text ?? ''}`,
            phase: 'final_answer',
          };
        },
      },
    });
    handlers?.[GraphEvents.ON_RUN_STEP]?.handle(
      GraphEvents.ON_RUN_STEP,
      {
        id: 'final-step',
        stepDetails: {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: { message_id: 'm', content_type: 'text', phase: 'final_answer' },
        },
      } as never,
      undefined,
      undefined,
    );
    handlers?.[GraphEvents.ON_MESSAGE_DELTA]?.handle(
      GraphEvents.ON_MESSAGE_DELTA,
      {
        id: 'final-step',
        delta: { content: { type: ContentTypes.TEXT, text: 'Done.' } },
      } as never,
      undefined,
      undefined,
    );
    await flushDetached();

    expect(parts[2]).toMatchObject({ type: ContentTypes.TEXT, text: 'Done.' });
    expect(parts[3]).toMatchObject({
      activity_label_type: 'phase',
      activity_start_index: 0,
      activity_end_index: 2,
      activity_count: 2,
    });
  });

  it('closes context rendered before the boundary despite a later activity position', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } },
    ];
    const payloads: GenerateActivityPhasePayload[] = [];
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      getStepIndex: (stepId) => (stepId === 'early-text' ? 2 : undefined),
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase: jest.fn(async (payload: GenerateActivityPhasePayload) => {
        payloads.push(payload);
        return { label: 'Completed one phase' };
      }),
    });
    await wiring.hook(batch('tool-1'), new AbortController().signal);
    await wiring.hook(batch('tool-2'), new AbortController().signal);
    parts[4] = { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-3' } };
    /** This activity renders after the boundary, so it is retained and the
     *  closing count stays at two while the registration counter reaches
     *  three — the text registered next is nonetheless rendered earlier. */
    await wiring.hook(batch('tool-3'), new AbortController().signal);
    const handlers = wiring.handlers({
      [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() },
      [GraphEvents.ON_MESSAGE_DELTA]: {
        handle: (_event, data) => {
          const delta = data as { id?: string; delta?: { content?: { text?: string } } };
          if (delta.id === 'early-text') {
            parts[2] = {
              type: ContentTypes.TEXT,
              text: `${parts[2]?.text ?? ''}${delta.delta?.content?.text ?? ''}`,
            };
          }
        },
      },
    });
    handlers?.[GraphEvents.ON_RUN_STEP]?.handle(
      GraphEvents.ON_RUN_STEP,
      {
        id: 'early-text',
        groupId: 'parallel',
        stepDetails: {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: { message_id: 'm', content_type: 'text' },
        },
      } as never,
      undefined,
      undefined,
    );
    handlers?.[GraphEvents.ON_MESSAGE_DELTA]?.handle(
      GraphEvents.ON_MESSAGE_DELTA,
      {
        id: 'early-text',
        delta: { content: { type: ContentTypes.TEXT, text: 'Context for the earlier work.' } },
      } as never,
      undefined,
      undefined,
    );
    parts[3] = { type: ContentTypes.TEXT, text: substantialText('Boundary result.') };

    wiring.complete();
    await flushDetached();

    expect(payloads[0]?.assistantContext).toEqual(['Context for the earlier work.']);
  });

  it('keeps ambiguously matched restored context on its saved side', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } },
      { type: ContentTypes.TEXT, text: 'Shared excerpt.' },
      { type: ContentTypes.TEXT, text: substantialText('Boundary result.') },
      { type: ContentTypes.TEXT, text: 'Later text repeating Shared excerpt.' },
    ];
    const payloads: GenerateActivityPhasePayload[] = [];
    const wiring = createActivityPhaseWiring({
      initialSnapshot: {
        version: 3,
        generated: 0,
        activityCount: 2,
        failedActivityCount: 0,
        partialActivityCount: 0,
        agentIds: [],
        activities: [
          { startIndex: 0, status: 'success' as const, toolCallIds: ['tool-1'] },
          { startIndex: 1, status: 'success' as const, toolCallIds: ['tool-2'] },
        ],
        /** Restored entries carry no step id, so the excerpt is located by
         *  text alone and its repetition after the boundary is not proof. */
        assistantContext: [{ text: 'Shared excerpt.', activityPosition: 0 }],
        pendingReasoning: [],
      },
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase: jest.fn(async (payload: GenerateActivityPhasePayload) => {
        payloads.push(payload);
        return { label: 'Completed the resumed phase' };
      }),
    });

    wiring.complete();
    await flushDetached();

    expect(payloads[0]?.assistantContext).toEqual(['Shared excerpt.']);
  });

  it('retains earlier-position context rendered after a substantial boundary', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } },
    ];
    const stepIndexes = new Map([
      ['boundary', 2],
      ['parallel-text', 3],
    ]);
    const payloads: GenerateActivityPhasePayload[] = [];
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      getStepIndex: (stepId) => stepIndexes.get(stepId),
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase: jest.fn(async (payload: GenerateActivityPhasePayload) => {
        payloads.push(payload);
        return { label: 'Completed one phase' };
      }),
    });
    await wiring.hook(batch('tool-1'), new AbortController().signal);
    const handlers = wiring.handlers({
      [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() },
      [GraphEvents.ON_MESSAGE_DELTA]: {
        handle: (_event, data) => {
          const delta = data as { id?: string; delta?: { content?: { text?: string } } };
          const index = stepIndexes.get(delta.id ?? '');
          if (index != null) {
            parts[index] = {
              type: ContentTypes.TEXT,
              text: `${parts[index]?.text ?? ''}${delta.delta?.content?.text ?? ''}`,
            };
          }
        },
      },
    });
    /** The parallel lane registers while only one activity has been tracked,
     *  so its activity position is below the closing count even though it
     *  renders after the boundary. */
    handlers?.[GraphEvents.ON_RUN_STEP]?.handle(
      GraphEvents.ON_RUN_STEP,
      {
        id: 'parallel-text',
        groupId: 'parallel',
        stepDetails: {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: { message_id: 'm', content_type: 'text' },
        },
      } as never,
      undefined,
      undefined,
    );
    parts[1] = { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } };
    await wiring.hook(batch('tool-2'), new AbortController().signal);
    handlers?.[GraphEvents.ON_RUN_STEP]?.handle(
      GraphEvents.ON_RUN_STEP,
      {
        id: 'boundary',
        stepDetails: {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: { message_id: 'm', content_type: 'text' },
        },
      } as never,
      undefined,
      undefined,
    );
    handlers?.[GraphEvents.ON_MESSAGE_DELTA]?.handle(
      GraphEvents.ON_MESSAGE_DELTA,
      {
        id: 'parallel-text',
        delta: { content: { type: ContentTypes.TEXT, text: 'Context for the later work.' } },
      } as never,
      undefined,
      undefined,
    );
    handlers?.[GraphEvents.ON_MESSAGE_DELTA]?.handle(
      GraphEvents.ON_MESSAGE_DELTA,
      {
        id: 'boundary',
        delta: { content: { type: ContentTypes.TEXT, text: substantialText('Boundary result.') } },
      } as never,
      undefined,
      undefined,
    );
    parts[5] = { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-3' } };
    parts[6] = { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-4' } };
    await wiring.hook(batch('tool-3'), new AbortController().signal);
    await wiring.hook(batch('tool-4'), new AbortController().signal);

    wiring.complete();
    await flushDetached();

    expect(payloads).toHaveLength(2);
    expect(payloads[0].assistantContext).toBeUndefined();
    expect(payloads[1].assistantContext).toEqual(['Context for the later work.']);
  });

  it('retains equal-position context rendered after a substantial boundary', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } },
    ];
    const stepIndexes = new Map([
      ['boundary', 2],
      ['parallel-text', 3],
    ]);
    const payloads: GenerateActivityPhasePayload[] = [];
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      getStepIndex: (stepId) => stepIndexes.get(stepId),
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase: jest.fn(async (payload: GenerateActivityPhasePayload) => {
        payloads.push(payload);
        return { label: 'Completed one phase' };
      }),
    });
    await wiring.hook(batch('tool-1'), new AbortController().signal);
    await wiring.hook(batch('tool-2'), new AbortController().signal);
    const handlers = wiring.handlers({
      [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() },
      [GraphEvents.ON_MESSAGE_DELTA]: {
        handle: (_event, data) => {
          const delta = data as { id?: string; delta?: { content?: { text?: string } } };
          const index = stepIndexes.get(delta.id ?? '');
          if (index != null) {
            parts[index] = {
              type: ContentTypes.TEXT,
              text: `${parts[index]?.text ?? ''}${delta.delta?.content?.text ?? ''}`,
            };
          }
        },
      },
    });
    for (const id of ['boundary', 'parallel-text']) {
      handlers?.[GraphEvents.ON_RUN_STEP]?.handle(
        GraphEvents.ON_RUN_STEP,
        {
          id,
          groupId: id === 'parallel-text' ? 'parallel' : undefined,
          stepDetails: {
            type: StepTypes.MESSAGE_CREATION,
            message_creation: { message_id: 'm', content_type: 'text' },
          },
        } as never,
        undefined,
        undefined,
      );
    }
    handlers?.[GraphEvents.ON_MESSAGE_DELTA]?.handle(
      GraphEvents.ON_MESSAGE_DELTA,
      {
        id: 'parallel-text',
        delta: { content: { type: ContentTypes.TEXT, text: 'Context for the later work.' } },
      } as never,
      undefined,
      undefined,
    );
    handlers?.[GraphEvents.ON_MESSAGE_DELTA]?.handle(
      GraphEvents.ON_MESSAGE_DELTA,
      {
        id: 'boundary',
        delta: { content: { type: ContentTypes.TEXT, text: substantialText('Boundary result.') } },
      } as never,
      undefined,
      undefined,
    );
    parts[5] = { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-3' } };
    parts[6] = { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-4' } };
    await wiring.hook(batch('tool-3'), new AbortController().signal);
    await wiring.hook(batch('tool-4'), new AbortController().signal);

    wiring.complete();
    await flushDetached();

    expect(payloads).toHaveLength(2);
    expect(payloads[0].assistantContext).toBeUndefined();
    expect(payloads[1].assistantContext).toEqual(['Context for the later work.']);
  });

  it('retains a completed tool batch when any call crosses a substantial boundary', async () => {
    const parts: LooseContentPart[] = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-1' } },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-2' } },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'parallel-1' } },
      { type: ContentTypes.TEXT, text: '' },
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'parallel-2' } },
    ];
    const payloads: GenerateActivityPhasePayload[] = [];
    const wiring = createActivityPhaseWiring({
      getContentParts: () => parts,
      getStepIndex: (stepId) => (stepId === 'boundary' ? 3 : undefined),
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      generatePhase: jest.fn(async (payload: GenerateActivityPhasePayload) => {
        payloads.push(payload);
        return { label: 'Completed one phase' };
      }),
    });
    await wiring.hook(batch('tool-1'), new AbortController().signal);
    await wiring.hook(batch('tool-2'), new AbortController().signal);
    const parallelBatch = batch('parallel-1');
    parallelBatch.entries.push({
      ...parallelBatch.entries[0],
      toolUseId: 'parallel-2',
      toolInput: { query: 'parallel-2' },
    });
    await wiring.hook(parallelBatch, new AbortController().signal);
    const handlers = wiring.handlers({
      [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() },
      [GraphEvents.ON_MESSAGE_DELTA]: {
        handle: (_event, data) => {
          const delta = data as { delta?: { content?: { text?: string } } };
          parts[3] = { type: ContentTypes.TEXT, text: delta.delta?.content?.text ?? '' };
        },
      },
    });
    handlers?.[GraphEvents.ON_RUN_STEP]?.handle(
      GraphEvents.ON_RUN_STEP,
      {
        id: 'boundary',
        stepDetails: {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: { message_id: 'm', content_type: 'text' },
        },
      } as never,
      undefined,
      undefined,
    );
    handlers?.[GraphEvents.ON_MESSAGE_DELTA]?.handle(
      GraphEvents.ON_MESSAGE_DELTA,
      {
        id: 'boundary',
        delta: { content: { type: ContentTypes.TEXT, text: substantialText('Boundary result.') } },
      } as never,
      undefined,
      undefined,
    );
    parts[6] = { type: ContentTypes.TOOL_CALL, tool_call: { id: 'tool-3' } };
    await wiring.hook(batch('tool-3'), new AbortController().signal);

    wiring.complete();
    await flushDetached();

    expect(payloads.map(({ totalActivityCount }) => totalActivityCount)).toEqual([2, 2]);
    expect(parts[5]).toMatchObject({ activity_end_index: 3, activity_count: 2 });
    expect(parts[7]).toMatchObject({ activity_start_index: 4, activity_count: 2 });
  });
});

describe('createAssistantPhaseStampingHandlers', () => {
  it('stamps commentary onto persisted text deltas for child activity-label intent', () => {
    const received: unknown[] = [];
    const handlers = createAssistantPhaseStampingHandlers({
      [GraphEvents.ON_RUN_STEP]: { handle: jest.fn() },
      [GraphEvents.ON_MESSAGE_DELTA]: {
        handle: (_event, data) => {
          received.push(data);
        },
      },
    });
    handlers?.[GraphEvents.ON_RUN_STEP]?.handle(
      GraphEvents.ON_RUN_STEP,
      {
        id: 'commentary-step',
        stepDetails: {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: { message_id: 'm', phase: 'commentary' },
        },
      } as never,
      undefined,
      undefined,
    );
    handlers?.[GraphEvents.ON_MESSAGE_DELTA]?.handle(
      GraphEvents.ON_MESSAGE_DELTA,
      {
        id: 'commentary-step',
        delta: { content: { type: ContentTypes.TEXT, text: 'I will compare both paths.' } },
      } as never,
      undefined,
      undefined,
    );
    expect(received[0]).toMatchObject({
      delta: { content: { type: ContentTypes.TEXT, phase: 'commentary' } },
    });
  });
});
