import { createToolTimingTracker } from './toolTiming';

describe('createToolTimingTracker', () => {
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
    timing.dispatched({ dispatched_at: 500, toolCalls: [{ id: 'a' }, { id: 'b' }] });
    timing.completed('b', 530);
    timing.completed('a', 700);
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
    timing.completed('sole', 405);
    timing.completed('sibling', 420);
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
    timing.completed('call', 530);
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
    timing.completed('call', 530);
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
    timing.completed('call', 530);
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
    timing.completed('second', 540);
    expect(timing.take('second', 'step')).toEqual({ toolExecutionDurationMs: 40 });
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
    timing.dispatched({ dispatched_at: 500, toolCalls: [{ id: 'cancelled' }] });
    expect(timing.take('cancelled', 'step')).toEqual({});
  });
});
