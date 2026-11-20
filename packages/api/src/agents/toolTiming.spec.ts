import { StepEvents } from 'librechat-data-provider';
import { createToolTimingAdapter, createToolTimingTracker } from './toolTiming';

describe('createToolTimingTracker', () => {
  it('projects child dispatch and completion only onto its own persisted tool part', () => {
    const part = { type: 'tool_call', tool_call: { id: 'child-call' } };
    const aggregator = { contentParts: [part], stepMap: new Map([['child-step', { index: 0 }]]) };
    const adapter = createToolTimingAdapter({ emit: async () => undefined });
    adapter.child(aggregator, {
      phase: 'tool_preparation',
      data: {
        id: 'child-step',
        toolCallId: 'child-call',
        observed_at: 100,
      },
    });
    adapter.child(aggregator, {
      phase: 'tool_calls_dispatched',
      data: {
        dispatched_at: 1_000,
        toolCalls: [
          { id: 'different-call', stepId: 'child-step' },
          { id: 'child-call', stepId: 'other-step' },
          { id: 'child-call', stepId: 'child-step' },
        ],
      },
    });
    expect(part.tool_call).toMatchObject({ toolDispatchedAt: 1_000 });
    const completedPart = { type: 'tool_call', tool_call: { id: 'child-call', output: 'ok' } };
    aggregator.contentParts[0] = completedPart;
    adapter.child(aggregator, {
      phase: 'run_step_completed',
      data: {
        result: { id: 'child-step', completed_at: 1_340, tool_call: { id: 'child-call' } },
      },
    });
    expect(completedPart.tool_call).toMatchObject({
      toolPreparationStartedAt: 100,
      toolPreparationDurationMs: 900,
      toolDispatchedAt: 1_000,
      toolExecutionDurationMs: 340,
    });
  });

  it('publishes each first fragment once without forwarding tool arguments', async () => {
    const publish = jest.fn(async () => undefined);
    const adapter = createToolTimingAdapter({ emit: publish });
    const fragment = {
      id: 'step-1',
      observed_at: 100,
      delta: {
        type: 'tool_calls' as const,
        tool_calls: [{ id: 'call-1', index: 0, args: 'secret' }],
      },
    };
    await adapter.delta(fragment);
    await adapter.delta({ ...fragment, observed_at: 200 });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({
      event: StepEvents.ON_TOOL_PREPARATION,
      data: { id: 'step-1', index: 0, toolCallId: 'call-1', observed_at: 100 },
    });
  });
  it('records each call separately even when results complete out of order', () => {
    const timing = createToolTimingTracker();
    timing.observe({
      id: 'step_a',
      observed_at: 100,
      delta: {
        type: 'tool_calls',
        tool_calls: [{ id: 'a', index: 0, args: '{' }],
      },
    });
    timing.observe({
      id: 'step_b',
      observed_at: 200,
      delta: {
        type: 'tool_calls',
        tool_calls: [{ id: 'b', index: 1, args: '{' }],
      },
    });
    timing.dispatched({
      dispatched_at: 500,
      toolCalls: [
        { id: 'a', stepId: 'step_a' },
        { id: 'b', stepId: 'step_b' },
      ],
    });
    timing.completed('step_b', 'b', 530);
    timing.completed('step_a', 'a', 700);
    expect(timing.take('b', 'step_b')).toEqual({
      toolPreparationDurationMs: 300,
      toolExecutionDurationMs: 30,
    });
    expect(timing.take('a', 'step_a')).toEqual({
      toolPreparationDurationMs: 400,
      toolExecutionDurationMs: 200,
    });
    expect(timing.take('a', 'step_a')).toEqual({});
  });

  it('keeps an idless initial fragment for the sole first call without assigning sibling fragments', () => {
    const timing = createToolTimingTracker();
    timing.observe({
      id: 'sole_step',
      observed_at: 100,
      delta: {
        type: 'tool_calls',
        tool_calls: [{ index: 0, args: '{' }],
      },
    });
    timing.observe({
      id: 'multi_step',
      observed_at: 90,
      delta: {
        type: 'tool_calls',
        tool_calls: [
          { index: 0, args: '{' },
          { index: 1, args: '{' },
        ],
      },
    });
    timing.dispatched({
      dispatched_at: 400,
      toolCalls: [
        { id: 'sole', stepId: 'sole_step' },
        { id: 'sibling', stepId: 'multi_step' },
      ],
    });
    timing.completed('sole_step', 'sole', 405);
    timing.completed('multi_step', 'sibling', 420);
    expect(timing.take('sole', 'sole_step')).toEqual({
      toolPreparationDurationMs: 300,
      toolExecutionDurationMs: 5,
    });
    expect(timing.take('sibling', 'multi_step')).toEqual({ toolExecutionDurationMs: 20 });
  });

  it('keeps the earliest ID-less fragment when the first call gains an ID later', () => {
    const timing = createToolTimingTracker();
    timing.observe({
      id: 'step',
      observed_at: 100,
      delta: { type: 'tool_calls', tool_calls: [{ index: 0, args: '{' }] },
    });
    timing.observe({
      id: 'step',
      observed_at: 200,
      delta: { type: 'tool_calls', tool_calls: [{ id: 'call', index: 0, args: '"x":1}' }] },
    });
    timing.dispatched({ dispatched_at: 500, toolCalls: [{ id: 'call', stepId: 'step' }] });
    timing.completed('step', 'call', 530);
    expect(timing.take('call', 'step')).toEqual({
      toolPreparationDurationMs: 400,
      toolExecutionDurationMs: 30,
    });
  });

  it('keeps the earliest timestamp when a named fragment is delivered before the ID-less one', () => {
    const timing = createToolTimingTracker();
    timing.observe({
      id: 'step',
      observed_at: 200,
      delta: { type: 'tool_calls', tool_calls: [{ id: 'call', index: 0, args: '"x":1}' }] },
    });
    timing.observe({
      id: 'step',
      observed_at: 100,
      delta: { type: 'tool_calls', tool_calls: [{ index: 0, args: '{' }] },
    });
    timing.dispatched({ dispatched_at: 500, toolCalls: [{ id: 'call', stepId: 'step' }] });
    timing.completed('step', 'call', 530);
    expect(timing.take('call', 'step')).toEqual({
      toolPreparationDurationMs: 400,
      toolExecutionDurationMs: 30,
    });
  });

  it('uses the ID-less start for an indexless named fragment only when it owns the step', () => {
    const timing = createToolTimingTracker();
    timing.observe({
      id: 'step',
      observed_at: 100,
      delta: { type: 'tool_calls', tool_calls: [{ index: 0, args: '{' }] },
    });
    timing.observe({
      id: 'step',
      observed_at: 200,
      delta: { type: 'tool_calls', tool_calls: [{ id: 'call', args: '"x":1}' }] },
    });
    timing.dispatched({ dispatched_at: 500, toolCalls: [{ id: 'call', stepId: 'step' }] });
    timing.completed('step', 'call', 530);
    expect(timing.take('call', 'step')).toEqual({
      toolPreparationDurationMs: 400,
      toolExecutionDurationMs: 30,
    });
  });

  it('does not give an ID-less first call’s preparation to an unobserved sibling', () => {
    const timing = createToolTimingTracker();
    timing.observe({
      id: 'step',
      observed_at: 100,
      delta: { type: 'tool_calls', tool_calls: [{ index: 0, args: '{' }] },
    });
    timing.dispatched({
      dispatched_at: 500,
      toolCalls: [
        { id: 'first', stepId: 'step' },
        { id: 'second', stepId: 'step' },
      ],
    });
    timing.completed('step', 'second', 540);
    expect(timing.take('second', 'step')).toEqual({ toolExecutionDurationMs: 40 });
  });

  it('keeps a first-call ID-less fragment after a faster sibling settles', () => {
    const timing = createToolTimingTracker();
    timing.observe({
      id: 'step',
      observed_at: 100,
      delta: {
        type: 'tool_calls',
        tool_calls: [{ index: 0, args: '{' }],
      },
    });
    timing.observe({
      id: 'step',
      observed_at: 200,
      delta: {
        type: 'tool_calls',
        tool_calls: [{ id: 'first', index: 0, args: '"x":1}' }],
      },
    });
    timing.dispatched({
      dispatched_at: 500,
      toolCalls: [
        { id: 'first', stepId: 'step' },
        { id: 'second', stepId: 'step' },
      ],
    });
    timing.completed('step', 'second', 515);
    expect(timing.take('second', 'step')).toEqual({ toolExecutionDurationMs: 15 });
    timing.completed('step', 'first', 560);
    expect(timing.take('first', 'step')).toEqual({
      toolPreparationDurationMs: 400,
      toolExecutionDurationMs: 60,
    });
  });

  it('isolates simultaneous duplicate provider call IDs by step', () => {
    const timing = createToolTimingTracker();
    for (const [stepId, observedAt, dispatchedAt, completedAt] of [
      ['step_1', 100, 300, 310],
      ['step_2', 150, 500, 550],
    ] as const) {
      timing.observe({
        id: stepId,
        observed_at: observedAt,
        delta: {
          type: 'tool_calls',
          tool_calls: [{ id: 'shared', index: 0, args: '{' }],
        },
      });
      timing.dispatched({ dispatched_at: dispatchedAt, toolCalls: [{ id: 'shared', stepId }] });
      timing.completed(stepId, 'shared', completedAt);
    }
    expect(timing.take('shared', 'step_1')).toEqual({
      toolPreparationDurationMs: 200,
      toolExecutionDurationMs: 10,
    });
    expect(timing.take('shared', 'step_2')).toEqual({
      toolPreparationDurationMs: 350,
      toolExecutionDurationMs: 50,
    });
  });

  it('does not manufacture execution duration on abort or an unobserved dispatch', () => {
    const timing = createToolTimingTracker();
    timing.observe({
      id: 'step',
      observed_at: 100,
      delta: {
        type: 'tool_calls',
        tool_calls: [{ id: 'denied', index: 0, args: '{}' }],
      },
    });
    expect(timing.take('denied', 'step')).toEqual({});
    timing.dispatched({ dispatched_at: 500, toolCalls: [{ id: 'cancelled', stepId: 'step' }] });
    expect(timing.take('cancelled', 'step')).toEqual({});
  });
});
