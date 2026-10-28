import {
  getRunStepClosedAt,
  getRunStepCloseMetadata,
  getRunStepDurationMs,
  isReportableRunStepDuration,
  MIN_REPORTABLE_RUN_STEP_DURATION_MS,
} from './runSteps';

describe('getRunStepClosedAt', () => {
  it('accepts a close time even if the emitter did not report when the step opened', () => {
    expect(getRunStepClosedAt({ closed_at: 1_750_000_000_000 })).toBe(1_750_000_000_000);
  });

  it('only stamps validated close times on saved content', () => {
    expect(getRunStepCloseMetadata({ closed_at: 1_750_000_000_000 })).toEqual({
      runStepClosedAt: 1_750_000_000_000,
    });
    expect(getRunStepCloseMetadata({ closed_at: NaN })).toEqual({});
  });

  it('rejects absent, non-date, and clock-skewed stamps', () => {
    expect(getRunStepClosedAt({})).toBeUndefined();
    expect(getRunStepClosedAt({ closed_at: NaN })).toBeUndefined();
    expect(getRunStepClosedAt({ closed_at: Infinity })).toBeUndefined();
    expect(getRunStepClosedAt({ closed_at: 0 })).toBeUndefined();
    expect(getRunStepClosedAt({ closed_at: 1e20 })).toBeUndefined();
    expect(getRunStepClosedAt({ created_at: 2000, closed_at: 1000 })).toBeUndefined();
  });
});

describe('getRunStepDurationMs', () => {
  it('returns the elapsed time between the two stamps', () => {
    expect(getRunStepDurationMs({ created_at: 1000, closed_at: 4500 })).toBe(3500);
  });

  it('returns 0 for a step that opened and closed on the same tick', () => {
    expect(getRunStepDurationMs({ created_at: 1000, closed_at: 1000 })).toBe(0);
  });

  it('returns undefined when the emitter did not report when the step opened', () => {
    expect(getRunStepDurationMs({ closed_at: 4500 })).toBeUndefined();
  });

  it('returns undefined when the closure carries no terminal stamp', () => {
    expect(getRunStepDurationMs({ created_at: 1000 })).toBeUndefined();
  });

  /**
   * Since `@librechat/agents` v3.6.0 a step can be opened in one process and
   * closed in another after a checkpoint resume, so the two stamps can come
   * from clocks that disagree. A negative elapsed time is the observable
   * symptom, and reporting it as a duration would be worse than reporting
   * nothing.
   */
  it('returns undefined when the clocks disagree rather than a negative duration', () => {
    expect(getRunStepDurationMs({ created_at: 4500, closed_at: 1000 })).toBeUndefined();
  });

  it('does not propagate non-finite input', () => {
    expect(getRunStepDurationMs({ created_at: NaN, closed_at: 4500 })).toBeUndefined();
    expect(getRunStepDurationMs({ created_at: 1000, closed_at: Infinity })).toBeUndefined();
  });

  it('ignores values that are not numbers', () => {
    expect(
      getRunStepDurationMs({ created_at: '1000' as unknown as number, closed_at: 4500 }),
    ).toBeUndefined();
  });
});

describe('isReportableRunStepDuration', () => {
  it('accepts a duration at the threshold', () => {
    expect(isReportableRunStepDuration(MIN_REPORTABLE_RUN_STEP_DURATION_MS)).toBe(true);
  });

  it('rejects sub-threshold durations, which are noise rather than information', () => {
    expect(isReportableRunStepDuration(MIN_REPORTABLE_RUN_STEP_DURATION_MS - 1)).toBe(false);
    expect(isReportableRunStepDuration(0)).toBe(false);
  });

  it('rejects an absent duration', () => {
    expect(isReportableRunStepDuration(undefined)).toBe(false);
  });
});

/**
 * The stamp sites persist {@link getRunStepDurationMs} raw — a sub-threshold
 * duration is stored as the fact it is, and only the renderer decides
 * whether to show it. This pins that a fast step still yields a value, so a
 * future "helpful" pre-filter at a stamp site fails a test instead of
 * silently discarding data.
 */
it('derives sub-threshold durations rather than discarding them at the source', () => {
  const durationMs = getRunStepDurationMs({ created_at: 1000, closed_at: 1300 });
  expect(durationMs).toBe(300);
  expect(isReportableRunStepDuration(durationMs)).toBe(false);
});
