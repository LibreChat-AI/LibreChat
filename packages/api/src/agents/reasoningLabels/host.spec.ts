import { GraphEvents } from '@librechat/agents';
import { ContentTypes, StepTypes, ReasoningLabelEvents } from 'librechat-data-provider';
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

  it('emits a same-step reset for a resumed step titled from an encoded payload', async () => {
    const encoded = Buffer.from(Array.from({ length: 900 }, (_, i) => (i * 37 + 3) % 256)).toString(
      'base64',
    );
    const parts = [
      {
        type: ContentTypes.THINK,
        think: encoded,
        reasoning_label: 'Inspecting an encoded data snapshot',
        reasoning_label_step_id: 'reasoning-1',
        reasoning_label_revision: 1,
        reasoning_label_attempts: 1,
      },
    ];
    const emitEvent = jest.fn(async () => undefined);
    const pending: Promise<void>[] = [];
    const host = createHost({
      seedFromContent: true,
      getContentParts: () => parts,
      getStepIndex: (stepId) => (stepId === 'reasoning-1' ? 0 : undefined),
      emitEvent,
      trackPendingFill: (task) => pending.push(task),
    });
    const handlers = host.wiring.handlers({
      [GraphEvents.ON_RUN_STEP]: { handle: () => undefined },
    });
    await handlers?.[GraphEvents.ON_RUN_STEP]?.handle(GraphEvents.ON_RUN_STEP, {
      id: 'reasoning-1',
      stepDetails: {
        type: StepTypes.MESSAGE_CREATION,
        message_creation: { content_type: ContentTypes.THINK },
      },
    } as never);
    await Promise.all(pending);

    expect(emitEvent).toHaveBeenCalledWith(ReasoningLabelEvents.ON_REASONING_LABEL, {
      index: 0,
      stepId: 'reasoning-1',
      previousStepId: 'reasoning-1',
      attempts: 1,
      reset: true,
    });
  });
});
