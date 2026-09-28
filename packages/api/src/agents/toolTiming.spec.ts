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
    timing.dispatched({ dispatched_at: 400, toolCalls: [{ id: 'sole' }, { id: 'sibling' }] });
    timing.completed('sole', 405);
    timing.completed('sibling', 420);
    expect(timing.take('sole', 'sole_step')).toEqual({
      toolPreparationDurationMs: 300,
      toolExecutionDurationMs: 5,
    });
    expect(timing.take('sibling', 'multi_step')).toEqual({ toolExecutionDurationMs: 20 });
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
