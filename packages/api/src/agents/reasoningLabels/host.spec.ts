import { ContentTypes } from 'librechat-data-provider';
import {
  createReasoningLabelHostWiring,
  getLabelUsageSequenceSeed,
  type CreateReasoningLabelHostWiringOptions,
} from './host';

function createHost(
  overrides: Partial<CreateReasoningLabelHostWiringOptions> = {},
): ReturnType<typeof createReasoningLabelHostWiring> {
  return createReasoningLabelHostWiring({
    config: { enabled: true },
    getContentParts: () => [],
    getStepIndex: () => undefined,
    emitEvent: async () => undefined,
    trackPendingFill: () => undefined,
    generateLabel: async () => ({}),
    ...overrides,
  });
}

describe('reasoning label host', () => {
  it('seeds shared usage from the highest run-global reasoning high-water', () => {
    const parts = [
      { type: ContentTypes.ACTIVITY_LABEL },
      { type: ContentTypes.ACTIVITY_LABEL },
      ...[1, 2, 3, 4].map((reasoning_label_revision) => ({
        type: ContentTypes.THINK,
        reasoning_label_revision,
      })),
    ];

    expect(getLabelUsageSequenceSeed(parts)).toBe(6);
    expect(
      getLabelUsageSequenceSeed([
        ...parts,
        { type: ContentTypes.THINK, reasoning_label_attempts: 7 },
      ]),
    ).toBe(9);
    expect(getLabelUsageSequenceSeed(parts, 12)).toBe(12);
  });

  it('owns the abort scope around the runtime wiring', () => {
    const abort = new AbortController();
    const host = createHost({ abortSignal: abort.signal });

    expect(host.scope.closed).toBe(false);
    expect(host.scope.abort.signal.aborted).toBe(false);

    abort.abort();

    expect(host.scope.closed).toBe(true);
    expect(host.scope.abort.signal.aborted).toBe(true);
  });

  it('retries the resumable marker once without rejecting the run', async () => {
    const markResumable = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new Error('transient marker failure'))
      .mockResolvedValueOnce(undefined);
    const onMarkFailure = jest.fn();

    const host = createHost({ markResumable, onMarkFailure });
    await host.markedPromise;

    expect(markResumable).toHaveBeenCalledTimes(2);
    expect(onMarkFailure).not.toHaveBeenCalled();
  });
});
