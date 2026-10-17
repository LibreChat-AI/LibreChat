import { GraphEvents } from '@librechat/agents';
import { ContentTypes, StepTypes } from 'librechat-data-provider';
import type { EventHandler } from '@librechat/agents';
import type {
  GeneratedReasoningLabel,
  ReasoningLabelAttemptEvent,
  ReasoningLabelResetEvent,
  ReasoningLabelEvent,
} from './runtime';
import type { LooseContentPart } from '~/agents/activityLabels/wiring';
import { createReasoningLabelWiring, synthesizeReasoningLabelGapEvents } from './runtime';

/** Test deltas end on a separator: the payload filter holds an unfinished
 *  word until the next non-payload character settles it. */
function reasoningDelta(id: string, think: string) {
  return { id, delta: { content: { type: ContentTypes.THINK, think } } };
}

function createHarness(
  generateLabel: (payload: {
    visibleReasoning: string;
    revision: number;
    status: 'streaming' | 'complete';
    previousLabel?: string;
  }) => Promise<GeneratedReasoningLabel>,
  config: {
    minChars?: number;
    updateChars?: number;
    updateIntervalMs?: number;
    maxPerRun?: number;
    initialAttempts?: number;
    initialParts?: LooseContentPart[];
    preservePartOnStart?: boolean;
    emitAttemptEvent?: (event: ReasoningLabelAttemptEvent) => Promise<void>;
    emitLabelEvent?: (event: ReasoningLabelEvent) => Promise<void>;
    emitResetEvent?: (event: ReasoningLabelResetEvent) => Promise<void>;
  } = {},
) {
  const { initialParts, preservePartOnStart, emitAttemptEvent, emitLabelEvent, ...wiringConfig } =
    config;
  const parts: LooseContentPart[] = [...(initialParts ?? [])];
  const stepIndices = new Map<string, number>();
  const attemptEvents: ReasoningLabelAttemptEvent[] = [];
  const events: ReasoningLabelEvent[] = [];
  const pending: Promise<void>[] = [];
  const handlers: Record<string, EventHandler> = {
    [GraphEvents.ON_RUN_STEP]: {
      handle: (_event, data) => {
        const step = data as { id: string; index: number };
        stepIndices.set(step.id, step.index);
        if (!(preservePartOnStart && parts[step.index]?.type === ContentTypes.THINK)) {
          parts[step.index] = { type: ContentTypes.THINK, think: '' };
        }
      },
    },
    [GraphEvents.ON_REASONING_DELTA]: {
      handle: (_event, data) => {
        const delta = data as ReturnType<typeof reasoningDelta>;
        const index = stepIndices.get(delta.id);
        const part = index != null ? parts[index] : undefined;
        if (index != null && part?.type === ContentTypes.THINK) {
          parts[index] = {
            type: ContentTypes.THINK,
            think: `${typeof part.think === 'string' ? part.think : ''}${delta.delta.content.think}`,
          };
        }
      },
    },
    [GraphEvents.ON_MESSAGE_DELTA]: { handle: () => undefined },
    [GraphEvents.ON_RUN_STEP_CLOSED]: { handle: () => undefined },
  };
  const wiring = createReasoningLabelWiring({
    ...wiringConfig,
    getContentParts: () => parts,
    getStepIndex: (stepId) => stepIndices.get(stepId),
    emitAttemptEvent: async (event) => {
      await emitAttemptEvent?.(event);
      attemptEvents.push(event);
    },
    emitLabelEvent: async (event) => {
      await emitLabelEvent?.(event);
      events.push(event);
    },
    trackPendingFill: (task) => pending.push(task),
    generateLabel,
  });
  const wrapped = wiring.handlers(handlers)!;
  const start = async (id = 'reasoning-1', index = 0, metadata?: Record<string, unknown>) => {
    await wrapped[GraphEvents.ON_RUN_STEP].handle(
      GraphEvents.ON_RUN_STEP,
      {
        id,
        index,
        stepDetails: {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: { content_type: ContentTypes.THINK },
        },
      } as never,
      metadata,
    );
  };
  const append = async (text: string, id = 'reasoning-1') => {
    await wrapped[GraphEvents.ON_REASONING_DELTA].handle(
      GraphEvents.ON_REASONING_DELTA,
      reasoningDelta(id, text) as never,
    );
  };
  const close = async (id = 'reasoning-1') => {
    await wrapped[GraphEvents.ON_RUN_STEP_CLOSED].handle(GraphEvents.ON_RUN_STEP_CLOSED, {
      id,
      status: 'completed',
    } as never);
  };
  const settle = async () => {
    for (let i = 0; i < 5; i += 1) {
      const tasks = pending.splice(0);
      if (tasks.length === 0) {
        await Promise.resolve();
        if (pending.length === 0) {
          return;
        }
      }
      await Promise.allSettled(tasks);
    }
  };
  return { append, attemptEvents, close, events, parts, settle, start, wiring };
}

describe('reasoning labels', () => {
  it('generates the first label only after the minimum visible length', async () => {
    const generate = jest.fn(async () => ({ label: 'Tracing resume ownership' }));
    const harness = createHarness(generate, { minChars: 10, updateChars: 8, updateIntervalMs: 0 });
    await harness.start();
    await harness.append('12345678 ');
    expect(generate).not.toHaveBeenCalled();

    await harness.append('.');
    await harness.settle();

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 1, status: 'streaming', visibleReasoning: '12345678 .' }),
    );
    expect(harness.parts).toHaveLength(1);
    expect(harness.parts[0]).toMatchObject({
      reasoning_label: 'Tracing resume ownership',
      reasoning_label_revision: 1,
      reasoning_label_status: 'streaming',
    });
  });

  it('waits for new reasoning when a new step reuses a THINK slot', async () => {
    const generate = jest.fn(async () => ({ label: 'Inspecting the new reasoning' }));
    const harness = createHarness(generate, {
      minChars: 5,
      updateChars: 4,
      updateIntervalMs: 0,
      preservePartOnStart: true,
      initialParts: [
        {
          type: ContentTypes.THINK,
          think: 'stale reasoning from the prior step',
          reasoning_label: 'Inspecting the prior reasoning',
          reasoning_label_step_id: 'reasoning-old',
          reasoning_label_revision: 1,
          reasoning_label_status: 'complete',
        },
      ],
    });

    await harness.start('reasoning-new', 0);
    await harness.settle();
    expect(generate).not.toHaveBeenCalled();

    await harness.append('123 ', 'reasoning-new');
    await harness.settle();
    expect(generate).not.toHaveBeenCalled();

    await harness.append('.', 'reasoning-new');
    await harness.settle();

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ visibleReasoning: '123 .', revision: 2 }),
    );
  });

  it('requires both changed characters and the minimum interval for revisions', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(1_000);
      const generate = jest
        .fn()
        .mockResolvedValueOnce({ label: 'Inspecting the stream' })
        .mockResolvedValueOnce({ label: 'Tracing the stream race' });
      const harness = createHarness(generate, {
        minChars: 5,
        updateChars: 4,
        updateIntervalMs: 3_000,
      });
      await harness.start();
      await harness.append('1234 ');
      await harness.settle();
      await harness.append('678 ');
      expect(generate).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(3_000);
      await harness.settle();
      expect(generate).toHaveBeenCalledTimes(2);
      expect(generate.mock.calls[1][0]).toMatchObject({ revision: 2 });
      expect(harness.events[harness.events.length - 1]).toMatchObject({
        revision: 2,
        label: 'Tracing the stream race',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('enforces the update interval after an empty first attempt', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(1_000);
      const generate = jest.fn(async () => ({}));
      const harness = createHarness(generate, {
        minChars: 5,
        updateChars: 4,
        updateIntervalMs: 3_000,
      });
      await harness.start();
      await harness.append('1234 ');
      await harness.settle();
      await harness.append('678 ');

      expect(generate).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(3_000);
      await harness.settle();
      expect(generate).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('collects provider usage even when an attempt produces no visible label', async () => {
    const collectUsage = jest.fn(async () => undefined);
    const harness = createHarness(async () => ({ collectUsage }), {
      minChars: 5,
      updateChars: 100,
      updateIntervalMs: 0,
    });
    await harness.start();
    await harness.append('1234 ');
    await harness.settle();

    expect(collectUsage).toHaveBeenCalledTimes(1);
    expect(collectUsage).toHaveBeenCalledWith(undefined);
    expect(harness.events).toHaveLength(0);
  });

  it('collects provider usage before a durable label patch fails', async () => {
    const collectUsage = jest.fn(async () => undefined);
    const harness = createHarness(async () => ({ label: 'Inspecting the stream', collectUsage }), {
      minChars: 5,
      updateChars: 100,
      updateIntervalMs: 0,
      emitLabelEvent: async () => {
        throw new Error('durable emit failed');
      },
    });
    await harness.start();
    await harness.append('1234 ');
    await harness.settle();

    expect(collectUsage).toHaveBeenCalledTimes(1);
    expect(harness.parts[0]).not.toHaveProperty('reasoning_label');
  });

  it('does not delay a durable visible label while usage persistence is pending', async () => {
    let releaseUsage: (() => void) | undefined;
    let markUsageStarted: (() => void) | undefined;
    let markEmitStarted: (() => void) | undefined;
    const usageStarted = new Promise<void>((resolve) => {
      markUsageStarted = resolve;
    });
    const emitStarted = new Promise<void>((resolve) => {
      markEmitStarted = resolve;
    });
    const usageGate = new Promise<void>((resolve) => {
      releaseUsage = resolve;
    });
    const harness = createHarness(
      async () => ({
        label: 'Inspecting the stream',
        collectUsage: async () => {
          markUsageStarted?.();
          await usageGate;
        },
      }),
      {
        minChars: 5,
        updateChars: 100,
        updateIntervalMs: 0,
        emitLabelEvent: async () => {
          markEmitStarted?.();
        },
      },
    );
    await harness.start();
    await harness.append('1234 ');
    await usageStarted;
    await emitStarted;
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.events).toHaveLength(1);
    expect(harness.parts[0]).toMatchObject({
      reasoning_label: 'Inspecting the stream',
      reasoning_label_revision: 1,
    });

    releaseUsage?.();
    await harness.settle();
  });

  it('does not block a terminal revision on usage persistence from the streaming revision', async () => {
    let releaseUsage: (() => void) | undefined;
    let markStreamingEmit: (() => void) | undefined;
    let markTerminalEmit: (() => void) | undefined;
    const usageGate = new Promise<void>((resolve) => {
      releaseUsage = resolve;
    });
    const streamingEmit = new Promise<void>((resolve) => {
      markStreamingEmit = resolve;
    });
    const terminalEmit = new Promise<void>((resolve) => {
      markTerminalEmit = resolve;
    });
    const generate = jest
      .fn()
      .mockResolvedValueOnce({
        label: 'Inspecting the stream',
        collectUsage: async () => usageGate,
      })
      .mockResolvedValueOnce({
        label: 'Validated the terminal result',
        collectUsage: async () => undefined,
      });
    const harness = createHarness(generate, {
      minChars: 5,
      updateChars: 400,
      updateIntervalMs: 3_000,
      emitLabelEvent: async ({ status }) => {
        if (status === 'complete') {
          markTerminalEmit?.();
        } else {
          markStreamingEmit?.();
        }
      },
    });
    await harness.start();
    await harness.append('1234 ');
    await streamingEmit;
    await harness.append(' word'.repeat(24));
    await harness.close();
    await terminalEmit;
    await new Promise((resolve) => setImmediate(resolve));

    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1][0]).toMatchObject({ revision: 2, status: 'complete' });
    expect(harness.events[harness.events.length - 1]).toMatchObject({
      revision: 2,
      label: 'Validated the terminal result',
      status: 'complete',
    });

    releaseUsage?.();
    await harness.settle();
  });

  it('restamps a committed label after later reasoning deltas rebuild the THINK part', async () => {
    const generate = jest.fn(async () => ({ label: 'Tracing the streaming path' }));
    const harness = createHarness(generate, { minChars: 5, updateChars: 100, updateIntervalMs: 0 });
    await harness.start();
    await harness.append('1234 ');
    await harness.settle();

    await harness.append(' later.');

    expect(harness.parts[0]).toMatchObject({
      think: '1234  later.',
      reasoning_label: 'Tracing the streaming path',
      reasoning_label_step_id: 'reasoning-1',
      reasoning_label_revision: 1,
      reasoning_label_status: 'streaming',
    });
  });

  it('patches the authoritative THINK part when a delta replaces it during durable emit', async () => {
    let releaseEmit: (() => void) | undefined;
    let markEmitStarted: (() => void) | undefined;
    const emitStarted = new Promise<void>((resolve) => {
      markEmitStarted = resolve;
    });
    const emitGate = new Promise<void>((resolve) => {
      releaseEmit = resolve;
    });
    const harness = createHarness(async () => ({ label: 'Tracing the concurrent stream' }), {
      minChars: 5,
      updateChars: 100,
      updateIntervalMs: 0,
      emitLabelEvent: async () => {
        markEmitStarted?.();
        await emitGate;
      },
    });
    await harness.start();
    await harness.append('1234 ');
    await emitStarted;

    await harness.append(' later.');
    releaseEmit?.();
    await harness.settle();

    expect(harness.parts[0]).toMatchObject({
      think: '1234  later.',
      reasoning_label: 'Tracing the concurrent stream',
      reasoning_label_revision: 1,
    });
  });

  it('does not patch a label after another reasoning step reuses its THINK slot', async () => {
    let releaseEmit: (() => void) | undefined;
    let markEmitStarted: (() => void) | undefined;
    const emitStarted = new Promise<void>((resolve) => {
      markEmitStarted = resolve;
    });
    const emitGate = new Promise<void>((resolve) => {
      releaseEmit = resolve;
    });
    const harness = createHarness(async () => ({ label: 'Inspecting the old step' }), {
      minChars: 5,
      updateChars: 100,
      updateIntervalMs: 0,
      emitLabelEvent: async () => {
        markEmitStarted?.();
        await emitGate;
      },
    });
    await harness.start('reasoning-1', 0);
    await harness.append('1234 ', 'reasoning-1');
    await emitStarted;

    await harness.start('reasoning-2', 0);
    releaseEmit?.();
    await harness.settle();

    expect(harness.parts[0]).toMatchObject({
      type: ContentTypes.THINK,
      reasoning_label_step_id: 'reasoning-2',
    });
    expect(harness.parts[0]).not.toHaveProperty('reasoning_label');
  });

  it('does not invoke the model after an attempt reservation loses step ownership', async () => {
    let releaseEmit: (() => void) | undefined;
    let markEmitStarted: (() => void) | undefined;
    const emitStarted = new Promise<void>((resolve) => {
      markEmitStarted = resolve;
    });
    const emitGate = new Promise<void>((resolve) => {
      releaseEmit = resolve;
    });
    const generate = jest.fn(async () => ({ label: 'Inspecting the old step' }));
    const harness = createHarness(generate, {
      minChars: 5,
      updateChars: 100,
      updateIntervalMs: 0,
      emitAttemptEvent: async () => {
        markEmitStarted?.();
        await emitGate;
      },
    });
    await harness.start('reasoning-1', 0);
    await harness.append('1234 ', 'reasoning-1');
    await emitStarted;

    await harness.start('reasoning-2', 0);
    releaseEmit?.();
    await harness.settle();

    expect(generate).not.toHaveBeenCalled();
    expect(harness.parts[0]).toMatchObject({
      type: ContentTypes.THINK,
      reasoning_label_step_id: 'reasoning-2',
    });
  });

  it('queues one trailing final revision while a generation is in flight', async () => {
    let resolveFirst: ((value: GeneratedReasoningLabel) => void) | undefined;
    const generate = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<GeneratedReasoningLabel>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ label: 'Resolved the final direction' });
    const harness = createHarness(generate, { minChars: 5, updateChars: 4, updateIntervalMs: 0 });
    await harness.start();
    await harness.append('1234 ');
    await harness.append('678 ');
    await harness.close();
    expect(generate).toHaveBeenCalledTimes(1);

    resolveFirst?.({ label: 'Investigating the direction' });
    await harness.settle();

    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1][0]).toMatchObject({
      revision: 2,
      status: 'complete',
      previousLabel: 'Investigating the direction',
      visibleReasoning: '1234 678',
    });
    expect(harness.events[harness.events.length - 1]).toMatchObject({
      revision: 2,
      status: 'complete',
      label: 'Resolved the final direction',
    });
  });

  it('marks the last committed label complete without paying for a trivial tail', async () => {
    const generate = jest.fn(async () => ({ label: 'Inspecting the stream' }));
    const harness = createHarness(generate, { minChars: 5, updateChars: 400, updateIntervalMs: 0 });
    await harness.start();
    await harness.append('1234 ');
    await harness.settle();
    await harness.append('small tail.');
    await harness.close();
    await harness.settle();

    expect(generate).toHaveBeenCalledTimes(1);
    expect(harness.events[harness.events.length - 1]).toMatchObject({
      revision: 1,
      status: 'complete',
    });
  });

  it('rewrites a meaningful 120-character final tail inside the streaming revision gates', async () => {
    const generate = jest
      .fn()
      .mockResolvedValueOnce({ label: 'Inspecting the stream' })
      .mockResolvedValueOnce({ label: 'Resolved the stream direction' });
    const harness = createHarness(generate, {
      minChars: 5,
      updateChars: 400,
      updateIntervalMs: 3_000,
    });
    await harness.start();
    await harness.append('1234 ');
    await harness.settle();
    await harness.append(' word'.repeat(24));
    await harness.close();
    await harness.settle();

    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1][0]).toMatchObject({ revision: 2, status: 'complete' });
    expect(harness.events[harness.events.length - 1]).toMatchObject({
      revision: 2,
      status: 'complete',
      label: 'Resolved the stream direction',
    });
  });

  it('does not label reasoning hidden by sequential-output visibility', async () => {
    const generate = jest.fn(async () => ({ label: 'Inspecting a hidden step' }));
    const harness = createHarness(generate, { minChars: 5, updateChars: 4, updateIntervalMs: 0 });
    await harness.start('reasoning-1', 0, {
      hide_sequential_outputs: true,
      last_agent_id: 'final-agent',
      langgraph_node: 'intermediate-agent',
    });
    await harness.append('1234 ');
    await harness.close();
    await harness.settle();

    expect(generate).not.toHaveBeenCalled();
    expect(harness.events).toHaveLength(0);
  });

  it('seeds the call cap from durable attempts across a resumed segment', async () => {
    const generate = jest.fn(async () => ({}));
    const firstSegment = createHarness(generate, {
      minChars: 5,
      updateChars: 4,
      updateIntervalMs: 0,
      maxPerRun: 2,
    });
    await firstSegment.start('reasoning-1', 0);
    await firstSegment.append('1234 ');
    await firstSegment.settle();
    await firstSegment.append('678 ');
    await firstSegment.settle();

    expect(generate).toHaveBeenCalledTimes(2);
    expect(firstSegment.parts[0]).toMatchObject({
      reasoning_label_step_id: 'reasoning-1',
      reasoning_label_attempts: 2,
      reasoning_label_submitted_chars: 9,
    });

    const resumedGenerate = jest.fn(async () => ({ label: 'Should not run' }));
    const resumed = createHarness(resumedGenerate, {
      minChars: 5,
      updateChars: 4,
      updateIntervalMs: 0,
      maxPerRun: 2,
      initialParts: firstSegment.parts,
    });
    await resumed.start('reasoning-2', 1);
    await resumed.append('abcd ', 'reasoning-2');
    await resumed.close('reasoning-2');
    await resumed.settle();

    expect(resumedGenerate).not.toHaveBeenCalled();
  });

  it('uses the highest committed revision as the legacy resume fallback', async () => {
    const generate = jest.fn(async () => ({ label: 'Continued the resumed investigation' }));
    const initialParts: LooseContentPart[] = [1, 2, 3, 4].map((revision) => ({
      type: ContentTypes.THINK,
      think: `prior reasoning ${revision}`,
      reasoning_label: `Prior label ${revision}`,
      reasoning_label_step_id: `prior-step-${revision}`,
      reasoning_label_revision: revision,
      reasoning_label_status: 'complete',
    }));
    const resumed = createHarness(generate, {
      minChars: 5,
      updateChars: 4,
      updateIntervalMs: 0,
      maxPerRun: 8,
      initialParts,
    });

    await resumed.start('reasoning-after-resume', initialParts.length);
    await resumed.append('abcd ', 'reasoning-after-resume');
    await resumed.settle();

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ revision: 5 }));
  });

  it('starts a fresh call budget when retained edit content is historical', async () => {
    const generate = jest.fn(async () => ({ label: 'Tracing the edited direction' }));
    const harness = createHarness(generate, {
      minChars: 5,
      updateChars: 4,
      updateIntervalMs: 0,
      maxPerRun: 1,
      initialAttempts: 0,
      initialParts: [
        {
          type: ContentTypes.THINK,
          think: 'historical reasoning',
          reasoning_label_step_id: 'old-step',
          reasoning_label_attempts: 8,
          reasoning_label_submitted_chars: 20,
        },
      ],
    });
    await harness.start('reasoning-new', 1);
    await harness.append('abcd ', 'reasoning-new');
    await harness.settle();

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ revision: 1 }));
  });

  it('keeps the run-cumulative cap when a new step reuses a THINK slot before resume', async () => {
    const generate = jest.fn(async () => ({}));
    const firstSegment = createHarness(generate, {
      minChars: 5,
      updateChars: 4,
      updateIntervalMs: 0,
      maxPerRun: 2,
    });
    await firstSegment.start('reasoning-1', 0);
    await firstSegment.append('1234 ', 'reasoning-1');
    await firstSegment.settle();
    await firstSegment.append('678 ', 'reasoning-1');
    await firstSegment.settle();

    await firstSegment.start('reasoning-2', 0);
    expect(firstSegment.parts[0]).toMatchObject({
      reasoning_label_step_id: 'reasoning-2',
      reasoning_label_attempts: 2,
    });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(firstSegment.attemptEvents.map((event) => event.attempts)).toEqual([1, 2]);

    const resumedGenerate = jest.fn(async () => ({ label: 'Should not run' }));
    const resumed = createHarness(resumedGenerate, {
      minChars: 5,
      updateChars: 4,
      updateIntervalMs: 0,
      maxPerRun: 2,
      initialParts: firstSegment.parts.map((part) => ({ ...part })),
    });
    await resumed.start('reasoning-3', 1);
    await resumed.append('vwxy ', 'reasoning-3');
    await resumed.close('reasoning-3');
    await resumed.settle();

    expect(resumedGenerate).not.toHaveBeenCalled();
  });

  it('resumes the character diff from the last attempted evidence length', async () => {
    const generate = jest.fn(async () => ({ label: 'Tracing the resumed direction' }));
    const harness = createHarness(generate, {
      minChars: 5,
      updateChars: 4,
      updateIntervalMs: 0,
      preservePartOnStart: true,
      initialParts: [
        {
          type: ContentTypes.THINK,
          think: '1234567',
          reasoning_label_step_id: 'reasoning-1',
          reasoning_label_attempts: 1,
          reasoning_label_submitted_chars: 5,
        },
      ],
    });
    await harness.start('reasoning-1', 0);
    expect(generate).not.toHaveBeenCalled();

    await harness.append('8 ', 'reasoning-1');
    await harness.settle();

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ visibleReasoning: '12345678', revision: 2 }),
    );
  });

  it('synthesizes only reasoning revisions that changed during a resume gap', () => {
    const snapshot = [
      {
        type: ContentTypes.THINK,
        think: 'reasoning',
        reasoning_label: 'Inspecting the stream',
        reasoning_label_step_id: 'step-1',
        reasoning_label_revision: 1,
        reasoning_label_status: 'streaming',
      },
    ];
    const fresh = [
      {
        ...snapshot[0],
        reasoning_label: 'Resolved the stream race',
        reasoning_label_revision: 2,
        reasoning_label_status: 'complete',
      },
    ];
    expect(
      synthesizeReasoningLabelGapEvents(snapshot, fresh, {
        conversationId: 'conversation-1',
        responseMessageId: 'response-1',
      }),
    ).toEqual([
      {
        event: 'on_reasoning_label',
        data: {
          index: 0,
          stepId: 'step-1',
          revision: 2,
          label: 'Resolved the stream race',
          status: 'complete',
          conversationId: 'conversation-1',
          responseMessageId: 'response-1',
        },
      },
    ]);
  });

  it('resets step ownership before synthesizing a reused slot revision', () => {
    const snapshot = [
      {
        type: ContentTypes.THINK,
        think: 'old reasoning',
        reasoning_label: 'Inspecting the stream',
        reasoning_label_step_id: 'step-old',
        reasoning_label_revision: 1,
        reasoning_label_status: 'streaming',
      },
    ];
    const fresh = [
      {
        ...snapshot[0],
        think: 'new reasoning',
        reasoning_label_step_id: 'step-new',
      },
    ];

    expect(
      synthesizeReasoningLabelGapEvents(snapshot, fresh, {
        conversationId: 'conversation-1',
        responseMessageId: 'response-1',
      }),
    ).toEqual([
      {
        event: 'on_reasoning_label',
        data: {
          index: 0,
          stepId: 'step-new',
          reset: true,
          previousStepId: 'step-old',
          conversationId: 'conversation-1',
          responseMessageId: 'response-1',
        },
      },
      {
        event: 'on_reasoning_label',
        data: {
          index: 0,
          stepId: 'step-new',
          revision: 1,
          label: 'Inspecting the stream',
          status: 'streaming',
          conversationId: 'conversation-1',
          responseMessageId: 'response-1',
        },
      },
    ]);
  });

  it('synthesizes a reset when a reused gap slot loses its prior label', () => {
    const snapshot = [
      {
        type: ContentTypes.THINK,
        think: 'old reasoning',
        reasoning_label: 'Inspecting the stream',
        reasoning_label_step_id: 'step-old',
        reasoning_label_revision: 1,
        reasoning_label_status: 'streaming',
      },
    ];
    const fresh = [
      {
        type: ContentTypes.THINK,
        think: 'old reasoning plus a short new step',
        reasoning_label_step_id: 'step-new',
        reasoning_label_attempts: 1,
      },
    ];

    expect(
      synthesizeReasoningLabelGapEvents(snapshot, fresh, {
        conversationId: 'conversation-1',
        responseMessageId: 'response-1',
      }),
    ).toEqual([
      {
        event: 'on_reasoning_label',
        data: {
          index: 0,
          stepId: 'step-new',
          reset: true,
          previousStepId: 'step-old',
          attempts: 1,
          conversationId: 'conversation-1',
          responseMessageId: 'response-1',
        },
      },
    ]);
  });
});

/** Bedrock's Converse stream returns OpenAI (and redacted Anthropic) reasoning
 *  as `reasoningContent.redactedContent` bytes; the SDK base64-encodes them and
 *  surfaces the result as THINK text. */
const encodedReasoning = (bytes = 1_050, seed = 7): string =>
  Buffer.from(Array.from({ length: bytes }, (_, i) => (i * 37 + seed) % 256)).toString('base64');

describe('reasoning labels for encoded reasoning', () => {
  const config = { minChars: 10, updateChars: 8, updateIntervalMs: 0 };

  it('never labels a step whose reasoning is an encoded payload', async () => {
    const generate = jest.fn(async () => ({ label: 'Inspecting an encoded data snapshot' }));
    const harness = createHarness(generate, config);
    await harness.start();
    await harness.append(encodedReasoning());
    await harness.append(encodedReasoning(300, 11));
    await harness.close();
    await harness.settle();

    expect(generate).not.toHaveBeenCalled();
    expect(harness.attemptEvents).toEqual([]);
    expect(harness.events).toEqual([]);
    expect(harness.parts[0]?.reasoning_label).toBeUndefined();
  });

  it('skips an encoded payload that arrives split across small deltas', async () => {
    const generate = jest.fn(async () => ({ label: 'Inspecting an encoded data snapshot' }));
    const harness = createHarness(generate, { updateChars: 400, updateIntervalMs: 0 });
    const payload = encodedReasoning();
    await harness.start();
    for (let offset = 0; offset < payload.length; offset += 100) {
      await harness.append(payload.slice(offset, offset + 100));
    }
    await harness.close();
    await harness.settle();

    expect(generate).not.toHaveBeenCalled();
    expect(harness.attemptEvents).toEqual([]);
  });

  it('never spends label revisions on a payload split across small deltas', async () => {
    const generate = jest.fn(async () => ({ label: 'Checking the retry policy' }));
    const harness = createHarness(generate, { minChars: 10, updateChars: 50, updateIntervalMs: 0 });
    const payload = encodedReasoning();
    await harness.start();
    await harness.append('Checking the retry policy against the queue backoff. ');
    await harness.settle();
    expect(generate).toHaveBeenCalledTimes(1);

    for (let offset = 0; offset < payload.length; offset += 100) {
      await harness.append(payload.slice(offset, offset + 100));
      await harness.settle();
    }
    await harness.close();
    await harness.settle();

    expect(generate).toHaveBeenCalledTimes(1);
    expect(harness.parts[0]).toMatchObject({
      reasoning_label: 'Checking the retry policy',
      reasoning_label_status: 'complete',
    });
  });

  it('never labels the undecided start of a payload under low thresholds', async () => {
    const generate = jest.fn(async () => ({ label: 'Inspecting an encoded data snapshot' }));
    const harness = createHarness(generate, { minChars: 5, updateChars: 4, updateIntervalMs: 0 });
    const payload = encodedReasoning();
    await harness.start();
    for (let offset = 0; offset < payload.length; offset += 10) {
      await harness.append(payload.slice(offset, offset + 10));
      await harness.settle();
    }
    await harness.close();
    await harness.settle();

    expect(generate).not.toHaveBeenCalled();
    expect(harness.attemptEvents).toEqual([]);
  });

  it('settles a final unpunctuated word when the step closes', async () => {
    const generate = jest.fn(async () => ({ label: 'Checking the result' }));
    const harness = createHarness(generate, { minChars: 5, updateChars: 4, updateIntervalMs: 0 });
    await harness.start();
    await harness.append('Checking');
    await harness.settle();
    expect(generate).not.toHaveBeenCalled();

    await harness.close();
    await harness.settle();

    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'complete', visibleReasoning: 'Checking' }),
    );
  });

  it('labels mixed reasoning from its readable text only', async () => {
    const generate = jest.fn(async () => ({ label: 'Comparing retry backoff strategies' }));
    const harness = createHarness(generate, { ...config, updateChars: 1_000 });
    const payload = encodedReasoning();
    await harness.start();
    await harness.append('Comparing the retry policy against the queue backoff. ');
    await harness.settle();
    await harness.append(payload);
    await harness.append(' Exponential backoff fits the burst pattern, so the queue keeps it. ');
    await harness.append(
      'Jitter spreads the retries across the window to avoid a thundering herd.',
    );
    await harness.close();
    await harness.settle();

    expect(generate).toHaveBeenCalledTimes(2);
    for (const [payloadArg] of generate.mock.calls as unknown as Array<
      [{ visibleReasoning: string }]
    >) {
      expect(payloadArg.visibleReasoning).not.toContain(payload.slice(0, 64));
    }
    expect(generate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'complete',
        visibleReasoning: expect.stringContaining('backoff.  Exponential backoff fits'),
      }),
    );
    expect(harness.parts[0]?.reasoning_label).toBe('Comparing retry backoff strategies');
  });

  it('still labels readable reasoning of the same length', async () => {
    const generate = jest.fn(async () => ({ label: 'Planning the cache migration' }));
    const harness = createHarness(generate, config);
    const readable =
      'Planning the cache migration: move session keys first, then rebuild the index. ';
    await harness.start();
    await harness.append(readable.repeat(18));
    await harness.close();
    await harness.settle();

    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ visibleReasoning: expect.stringContaining('Planning the cache') }),
    );
    expect(harness.parts[0]?.reasoning_label).toBe('Planning the cache migration');
  });

  it('ignores a persisted encoded payload when a resumed step continues', async () => {
    const generate = jest.fn(async () => ({ label: 'Checking the resumed tool result' }));
    const harness = createHarness(generate, {
      ...config,
      preservePartOnStart: true,
      initialParts: [
        {
          type: ContentTypes.THINK,
          think: encodedReasoning(),
          reasoning_label_step_id: 'reasoning-1',
          reasoning_label_attempts: 0,
        },
      ],
    });
    await harness.start();
    await harness.settle();
    expect(generate).not.toHaveBeenCalled();

    await harness.append(' Checking the tool result.');
    await harness.close();
    await harness.settle();

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ visibleReasoning: 'Checking the tool result.' }),
    );
  });
  it('drops a payload prefix that was still undecided when a resumed step continues', async () => {
    const generate = jest.fn(async () => ({ label: 'Rolling back the deploy' }));
    const payload = encodedReasoning();
    const harness = createHarness(generate, {
      minChars: 30,
      updateChars: 8,
      updateIntervalMs: 0,
      preservePartOnStart: true,
      initialParts: [
        {
          type: ContentTypes.THINK,
          think: `Checking. ${payload.slice(0, 100)}`,
          reasoning_label_step_id: 'reasoning-1',
          reasoning_label_attempts: 0,
        },
      ],
    });
    await harness.start();
    await harness.append(payload.slice(100));
    await harness.append(' Rolling back the deploy now.');
    await harness.close();
    await harness.settle();

    expect(generate).toHaveBeenCalled();
    for (const [payloadArg] of generate.mock.calls as unknown as Array<
      [{ visibleReasoning: string }]
    >) {
      expect(payloadArg.visibleReasoning).not.toContain(payload.slice(0, 32));
      expect(payloadArg.visibleReasoning).toContain('Rolling back the deploy now.');
    }
  });
  it('does not revive a payload-derived title when a resumed step continues briefly', async () => {
    const generate = jest.fn(async () => ({ label: 'unused' }));
    const emitResetEvent = jest.fn(async () => undefined);
    const harness = createHarness(generate, {
      updateIntervalMs: 0,
      emitResetEvent,
      preservePartOnStart: true,
      initialParts: [
        {
          type: ContentTypes.THINK,
          think: encodedReasoning(),
          reasoning_label: 'Inspecting an encoded data snapshot',
          reasoning_label_step_id: 'reasoning-1',
          reasoning_label_revision: 1,
          reasoning_label_status: 'complete',
          reasoning_label_attempts: 1,
        },
      ],
    });
    await harness.start();
    await harness.append(' Checking the tool result.');
    await harness.close();
    await harness.settle();

    expect(generate).not.toHaveBeenCalled();
    expect(harness.parts[0]?.reasoning_label).toBeUndefined();
    expect(harness.events).toEqual([]);
    /** The resumed client still holds the snapshot title for this same step. */
    expect(emitResetEvent).toHaveBeenCalledWith({
      index: 0,
      stepId: 'reasoning-1',
      previousStepId: 'reasoning-1',
      attempts: 1,
    });
  });

  it('keeps the title of a resumed step whose reasoning is a short readable token', async () => {
    const generate = jest.fn(async () => ({ label: 'unused' }));
    const emitResetEvent = jest.fn(async () => undefined);
    const harness = createHarness(generate, {
      minChars: 5,
      updateIntervalMs: 0,
      emitResetEvent,
      preservePartOnStart: true,
      initialParts: [
        {
          type: ContentTypes.THINK,
          think: 'Investigating',
          reasoning_label: 'Investigating the failure',
          reasoning_label_step_id: 'reasoning-1',
          reasoning_label_revision: 1,
          reasoning_label_status: 'streaming',
          reasoning_label_attempts: 1,
          reasoning_label_submitted_chars: 13,
        },
      ],
    });
    await harness.start();
    await harness.close();
    await harness.settle();

    expect(emitResetEvent).not.toHaveBeenCalled();
    expect(harness.parts[0]?.reasoning_label).toBe('Investigating the failure');
  });
});
