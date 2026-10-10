import { getToolTimingDurations } from './toolTiming';

describe('getToolTimingDurations', () => {
  it('separates minutes of argument preparation from a fast tool result', () => {
    expect(
      getToolTimingDurations({ observedAt: 1_000, dispatchedAt: 248_000, completedAt: 248_340 }),
    ).toEqual({ toolPreparationDurationMs: 247_000, toolExecutionDurationMs: 340 });
  });

  it('omits unknown phases independently rather than inventing a start', () => {
    expect(getToolTimingDurations({ dispatchedAt: 10_000, completedAt: 11_000 })).toEqual({
      toolExecutionDurationMs: 1_000,
    });
    expect(getToolTimingDurations({ observedAt: 1_000, completedAt: 11_000 })).toEqual({});
    expect(getToolTimingDurations({ observedAt: 1_000, dispatchedAt: 10_000 })).toEqual({
      toolPreparationDurationMs: 9_000,
    });
  });

  it('does not mislabel a reordered or non-finite clock pair', () => {
    expect(
      getToolTimingDurations({ observedAt: 12_000, dispatchedAt: 10_000, completedAt: 11_000 }),
    ).toEqual({ toolExecutionDurationMs: 1_000 });
    expect(
      getToolTimingDurations({ observedAt: 1_000, dispatchedAt: 10_000, completedAt: 9_000 }),
    ).toEqual({ toolPreparationDurationMs: 9_000 });
    expect(
      getToolTimingDurations({ observedAt: NaN, dispatchedAt: Infinity, completedAt: 12_000 }),
    ).toEqual({});
  });
});
