import { createModelErrorTracker } from './tracker';

describe('createModelErrorTracker', () => {
  it('returns the exact model error that terminates the graph', () => {
    const tracker = createModelErrorTracker();
    const error = new Error('provider failed');

    tracker.callback.handleLLMError(error);

    expect(tracker.getUpstreamModelError(error)).toBe(error);
  });

  it('returns the tracked error through standard cause and aggregate chains', () => {
    const tracker = createModelErrorTracker();
    const providerError = new Error('provider failed');
    tracker.callback.handleLLMError(providerError);

    const terminal = new Error('graph failed', {
      cause: { errors: [new Error('other failure'), providerError] },
    });

    expect(tracker.getUpstreamModelError(terminal)).toBe(providerError);
  });

  it('does not classify a later graph failure after a recovered model attempt', () => {
    const tracker = createModelErrorTracker();
    tracker.callback.handleLLMError(new Error('recovered provider attempt'));

    expect(tracker.getUpstreamModelError(new Error('checkpoint failed'))).toBeNull();
  });

  it('returns the terminal fallback error when multiple attempts were observed', () => {
    const tracker = createModelErrorTracker();
    const primaryError = new Error('primary failed');
    const fallbackError = new Error('fallback failed');
    tracker.callback.handleLLMError(primaryError);
    tracker.callback.handleLLMError(fallbackError);

    expect(tracker.getUpstreamModelError(fallbackError)).toBe(fallbackError);
  });

  it('fails closed for primitive errors and throwing properties', () => {
    const tracker = createModelErrorTracker();
    tracker.callback.handleLLMError('provider failed');
    const hostile = {};
    Object.defineProperties(hostile, {
      cause: {
        get() {
          throw new Error('cause getter failed');
        },
      },
      errors: {
        get() {
          throw new Error('errors getter failed');
        },
      },
    });

    expect(tracker.getUpstreamModelError('provider failed')).toBeNull();
    expect(tracker.getUpstreamModelError(hostile)).toBeNull();
  });

  it('terminates on cyclic error graphs', () => {
    const tracker = createModelErrorTracker();
    const first: Error & { cause?: unknown } = new Error('first');
    const second: Error & { cause?: unknown } = new Error('second');
    first.cause = second;
    second.cause = first;

    expect(tracker.getUpstreamModelError(first)).toBeNull();
  });

  it('caps property reads on an excessively deep cause chain', () => {
    const tracker = createModelErrorTracker();
    let propertyReads = 0;
    let cause: object | undefined;
    for (let depth = 0; depth < 1_000; depth += 1) {
      const nextCause = cause;
      cause = Object.defineProperties(
        {},
        {
          cause: {
            get() {
              propertyReads += 1;
              return nextCause;
            },
          },
          errors: {
            get() {
              propertyReads += 1;
              return undefined;
            },
          },
        },
      );
    }

    expect(tracker.getUpstreamModelError(cause)).toBeNull();
    expect(propertyReads).toBeLessThanOrEqual(64);
  });

  it('caps aggregate entry reads across a hostile wide graph', () => {
    const tracker = createModelErrorTracker();
    let indexReads = 0;
    const errors = new Proxy(
      Array.from({ length: 100_000 }, () => null),
      {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^\d+$/.test(property)) {
            indexReads += 1;
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    expect(tracker.getUpstreamModelError({ errors })).toBeNull();
    expect(indexReads).toBeLessThanOrEqual(32);
  });

  it('prioritizes a deep cause chain over aggregate breadth', () => {
    const tracker = createModelErrorTracker();
    const providerError = new Error('provider failed');
    tracker.callback.handleLLMError(providerError);
    const errors = Array.from({ length: 1_000 }, () => new Error('aggregate failure'));

    let terminal: Error & { cause?: unknown } = new Error('terminal');
    const root = terminal;
    for (let depth = 0; depth < 29; depth += 1) {
      const next: Error & { cause?: unknown } = new Error(`wrapper ${depth}`);
      terminal.cause = next;
      terminal = next;
    }
    terminal.cause = providerError;

    expect(
      tracker.getUpstreamModelError({
        errors,
        cause: root,
      }),
    ).toBe(providerError);
  });
});
