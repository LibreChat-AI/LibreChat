import * as agentsSdk from '@librechat/agents';
import type {
  PostToolBatchHookInput,
  PostToolBatchHookOutput,
  PreemptBoundaryHookInput,
} from '@librechat/agents';
import type { SteerQueueItem } from '~/stream/interfaces/IJobStore';
import { STEER_ENQUEUE_NOT_RUNNING } from '~/stream/interfaces/IJobStore';

/** The pinned SDK's hook output declares `injectedMessages` natively; a
 *  narrower local re-declaration would no longer be assignable from it. */
type SteerDrainOutput = PostToolBatchHookOutput;
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManager } from '~/stream/GenerationJobManager';
import {
  createSteerDrainHook,
  createSteerPreemptBoundaryHook,
  createSteerTerminalContinuationHook,
  createSteerPreemptPoll,
  isSteeringSupported,
  isSteerPreemptSupported,
  isSteerPreemptRestartSupported,
  isSteerTerminalContinuationSupported,
} from '../runtime';
import type { TerminalSteerHookInput } from '../runtime';

jest.spyOn(console, 'log').mockImplementation();

const abortSignal = new AbortController().signal;

function batchInput(overrides: Partial<PostToolBatchHookInput> = {}): PostToolBatchHookInput {
  return {
    hook_event_name: 'PostToolBatch',
    runId: 'run-1',
    entries: [],
    ...overrides,
  };
}

function buildSteer(steerId: string, text: string): SteerQueueItem {
  return { steerId, text, userId: 'user-1', createdAt: Date.now() };
}

function boundaryInput(
  overrides: Partial<PreemptBoundaryHookInput> = {},
): PreemptBoundaryHookInput {
  return {
    hook_event_name: 'PreemptBoundary',
    runId: 'run-1',
    sealCount: 1,
    ...overrides,
  };
}

function stopInput(
  continuationBudgetRemaining: number,
  stopReason?: string,
  overrides: Partial<TerminalSteerHookInput> = {},
): TerminalSteerHookInput {
  return {
    hook_event_name: 'StopFinalize',
    runId: 'run-1',
    continuationBudgetRemaining,
    continuationPlanned: false,
    continuationPrevented: stopReason != null,
    ...(stopReason != null && { stopReason }),
    ...overrides,
  } as unknown as TerminalSteerHookInput;
}

describe('isSteeringSupported', () => {
  it('mirrors the installed SDK capability flag AND replay support', () => {
    // CI runs against the published SDK pin (possibly pre-injectedMessages);
    // local dev may run against a capability-bearing build. The probe must
    // track BOTH halves of the contract exactly in every world — false means
    // the steer route 501s and createRun skips the drain wiring. Requiring
    // ContentTypes.STEER guards the release window where injection shipped
    // without the formatAgentMessages replay branch: creating steer parts
    // there would leak them into provider-facing assistant content.
    const sdk = agentsSdk as {
      HOOK_INJECTED_MESSAGES_CAPABLE?: boolean;
      ContentTypes?: { STEER?: string };
    };
    const capable =
      sdk.HOOK_INJECTED_MESSAGES_CAPABLE === true && sdk.ContentTypes?.STEER === 'steer';
    expect(isSteeringSupported()).toBe(capable);
  });

  it('gates terminal continuation on its separate SDK capability', () => {
    const sdk = agentsSdk as { HOOK_STOP_CONTINUATION_CAPABLE?: boolean };
    expect(isSteerTerminalContinuationSupported()).toBe(
      isSteeringSupported() && sdk.HOOK_STOP_CONTINUATION_CAPABLE === true,
    );
  });
});

describe('createSteerTerminalContinuationHook', () => {
  beforeEach(() => {
    GenerationJobManager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });
    GenerationJobManager.initialize();
  });

  afterEach(async () => {
    await GenerationJobManager.destroy();
  });

  it('claims queued steers and blocks Stop into the same warm Run', async () => {
    const streamId = `terminal-claim-${Date.now()}`;
    const job = await GenerationJobManager.createJob(streamId, 'user-1');
    await GenerationJobManager.steering.enqueue(streamId, buildSteer('s1', 'keep going'));
    const applied = jest.fn();
    const hook = createSteerTerminalContinuationHook({
      streamId,
      jobCreatedAt: job.createdAt,
      applySteer: applied,
    });

    await expect(hook(stopInput(1), abortSignal)).resolves.toEqual({
      decision: 'block',
      injectedMessages: [{ role: 'user', content: 'keep going', source: 'steer' }],
    });
    expect(applied).toHaveBeenCalledWith(expect.objectContaining({ steerId: 's1' }));
    await expect(GenerationJobManager.steering.peek(streamId, job.createdAt)).resolves.toEqual([]);
    await expect(
      GenerationJobManager.steering.enqueue(
        streamId,
        buildSteer('s2', 'next continuation'),
        job.createdAt,
      ),
    ).resolves.toBe(1);
  });

  it('never admits terminal steers inside a subagent scope', async () => {
    const streamId = `terminal-subagent-${Date.now()}`;
    const job = await GenerationJobManager.createJob(streamId, 'user-1');
    const queued = buildSteer('s1', 'keep for the parent');
    await GenerationJobManager.steering.enqueue(streamId, queued);
    const applySteer = jest.fn();
    const hook = createSteerTerminalContinuationHook({
      streamId,
      jobCreatedAt: job.createdAt,
      applySteer,
    });

    await expect(
      hook(stopInput(1, undefined, { agentId: 'child-agent' }), abortSignal),
    ).resolves.toEqual({ decision: 'continue' });
    expect(applySteer).not.toHaveBeenCalled();
    await expect(GenerationJobManager.steering.peek(streamId, job.createdAt)).resolves.toEqual([
      queued,
    ]);
  });

  it('seals admission when the continuation budget is exhausted without losing the queue', async () => {
    const streamId = `terminal-budget-${Date.now()}`;
    const job = await GenerationJobManager.createJob(streamId, 'user-1');
    const queued = buildSteer('s1', 'ordinary follow-up');
    await GenerationJobManager.steering.enqueue(streamId, queued);
    const hook = createSteerTerminalContinuationHook({
      streamId,
      jobCreatedAt: job.createdAt,
      applySteer: jest.fn(),
    });

    await expect(hook(stopInput(0), abortSignal)).resolves.toEqual({ decision: 'continue' });
    await expect(
      GenerationJobManager.steering.enqueue(streamId, buildSteer('s2', 'too late'), job.createdAt),
    ).resolves.toBe(STEER_ENQUEUE_NOT_RUNNING);
    await expect(
      GenerationJobManager.steering.closeAndDrain(streamId, job.createdAt),
    ).resolves.toEqual([queued]);
  });

  it('seals an empty terminal boundary so a later steer becomes a new turn', async () => {
    const streamId = `terminal-empty-${Date.now()}`;
    const job = await GenerationJobManager.createJob(streamId, 'user-1');
    const hook = createSteerTerminalContinuationHook({
      streamId,
      jobCreatedAt: job.createdAt,
      applySteer: jest.fn(),
    });

    await expect(hook(stopInput(1), abortSignal)).resolves.toEqual({ decision: 'continue' });
    await expect(
      GenerationJobManager.steering.enqueue(streamId, buildSteer('s1', 'new turn'), job.createdAt),
    ).resolves.toBe(STEER_ENQUEUE_NOT_RUNNING);
  });

  it('keeps empty admission open when another Stop hook already planned a continuation', async () => {
    const streamId = `terminal-other-hook-${Date.now()}`;
    const job = await GenerationJobManager.createJob(streamId, 'user-1');
    const hook = createSteerTerminalContinuationHook({
      streamId,
      jobCreatedAt: job.createdAt,
      applySteer: jest.fn(),
    });

    await expect(
      hook(stopInput(1, undefined, { continuationPlanned: true }), abortSignal),
    ).resolves.toEqual({ decision: 'continue' });
    await expect(
      GenerationJobManager.steering.enqueue(
        streamId,
        buildSteer('s1', 'join the planned continuation'),
        job.createdAt,
      ),
    ).resolves.toBe(1);
  });

  it('seals instead of claiming when the graph has a terminal halt reason', async () => {
    const streamId = `terminal-halt-${Date.now()}`;
    const job = await GenerationJobManager.createJob(streamId, 'user-1');
    const queued = buildSteer('s1', 'retry in a fresh turn');
    await GenerationJobManager.steering.enqueue(streamId, queued, job.createdAt);
    const applySteer = jest.fn();
    const hook = createSteerTerminalContinuationHook({
      streamId,
      jobCreatedAt: job.createdAt,
      applySteer,
    });

    await expect(hook(stopInput(1, 'preempt_incomplete'), abortSignal)).resolves.toEqual({
      decision: 'continue',
    });
    expect(applySteer).not.toHaveBeenCalled();
    await expect(
      GenerationJobManager.steering.closeAndDrain(streamId, job.createdAt),
    ).resolves.toEqual([queued]);
  });
});

describe('createSteerDrainHook', () => {
  beforeEach(() => {
    GenerationJobManager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });
    GenerationJobManager.initialize();
  });

  afterEach(async () => {
    await GenerationJobManager.destroy();
  });

  it('drains FIFO, applies each steer, and returns per-message injectedMessages', async () => {
    const streamId = `drain-${Date.now()}`;
    const job = await GenerationJobManager.createJob(streamId, 'user-1');
    await GenerationJobManager.steering.enqueue(streamId, buildSteer('s1', 'first'));
    await GenerationJobManager.steering.enqueue(streamId, buildSteer('s2', 'second'));

    const applied: string[] = [];
    const hook = createSteerDrainHook({
      streamId,
      jobCreatedAt: job.createdAt,
      applySteer: (item) => {
        applied.push(item.text);
      },
    });

    const output = (await hook(batchInput(), abortSignal)) as SteerDrainOutput;
    expect(applied).toEqual(['first', 'second']);
    expect(output.injectedMessages).toEqual([
      { role: 'user', content: 'first', source: 'steer' },
      { role: 'user', content: 'second', source: 'steer' },
    ]);
    expect(await GenerationJobManager.steering.peek(streamId)).toEqual([]);
  });

  it('returns empty output when the queue is empty', async () => {
    const streamId = `drain-empty-${Date.now()}`;
    await GenerationJobManager.createJob(streamId, 'user-1');
    const hook = createSteerDrainHook({ streamId, applySteer: jest.fn() });

    expect(await hook(batchInput(), abortSignal)).toEqual({});
  });

  it('never drains inside a subagent scope', async () => {
    const streamId = `drain-subagent-${Date.now()}`;
    await GenerationJobManager.createJob(streamId, 'user-1');
    await GenerationJobManager.steering.enqueue(streamId, buildSteer('s1', 'kept'));

    const hook = createSteerDrainHook({ streamId, applySteer: jest.fn() });
    expect(await hook(batchInput({ agentId: 'child-agent' }), abortSignal)).toEqual({});
    expect((await GenerationJobManager.steering.peek(streamId)).map((s) => s.text)).toEqual([
      'kept',
    ]);
  });

  it('refuses to drain when the job was replaced', async () => {
    const streamId = `drain-replaced-${Date.now()}`;
    const job = await GenerationJobManager.createJob(streamId, 'user-1');
    const hook = createSteerDrainHook({
      streamId,
      jobCreatedAt: job.createdAt - 1,
      applySteer: jest.fn(),
    });
    await GenerationJobManager.steering.enqueue(streamId, buildSteer('s1', 'new job steer'));

    expect(await hook(batchInput(), abortSignal)).toEqual({});
    expect((await GenerationJobManager.steering.peek(streamId)).map((s) => s.text)).toEqual([
      'new job steer',
    ]);
  });

  it('restores the claimed steer and does not inject when durable apply fails', async () => {
    const streamId = `drain-apply-error-${Date.now()}`;
    const job = await GenerationJobManager.createJob(streamId, 'user-1');
    await GenerationJobManager.steering.enqueue(streamId, buildSteer('s1', 'survives'));

    const hook = createSteerDrainHook({
      streamId,
      jobCreatedAt: job.createdAt,
      applySteer: () => {
        throw new Error('emit failed');
      },
    });

    const output = (await hook(batchInput(), abortSignal)) as SteerDrainOutput;
    expect(output).toEqual({});
    expect((await GenerationJobManager.steering.peek(streamId)).map((item) => item.text)).toEqual([
      'survives',
    ]);
  });

  it('injects encoded media content for steers that carry files', async () => {
    const streamId = `drain-media-${Date.now()}`;
    const job = await GenerationJobManager.createJob(streamId, 'user-1');
    const files = [{ file_id: 'f1', type: 'image/png' }];
    await GenerationJobManager.steering.enqueue(streamId, {
      ...buildSteer('s1', 'see image'),
      files,
    });
    await GenerationJobManager.steering.enqueue(streamId, buildSteer('s2', 'text only'));

    const media = {
      content: [
        { type: 'text', text: 'see image' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,x', detail: 'auto' } },
      ],
      files,
    };
    const calls: string[] = [];
    const buildMedia = jest.fn(async (item: SteerQueueItem) => {
      calls.push(`media:${item.steerId}`);
      return media;
    });
    const hook = createSteerDrainHook({
      streamId,
      jobCreatedAt: job.createdAt,
      applySteer: (item) => {
        calls.push(`apply:${item.steerId}`);
      },
      buildMedia,
    });

    const output = (await hook(batchInput(), abortSignal)) as SteerDrainOutput;
    // buildMedia is consulted only for items that carry files.
    expect(buildMedia).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['apply:s1', 'apply:s2', 'media:s1']);
    expect(output.injectedMessages).toEqual([
      { role: 'user', content: media.content, source: 'steer' },
      { role: 'user', content: 'text only', source: 'steer' },
    ]);
  });

  it('merges quoted excerpts into text-only injections (media path merges its own)', async () => {
    const streamId = `drain-quotes-${Date.now()}`;
    const job = await GenerationJobManager.createJob(streamId, 'user-1', undefined, {
      initialMetadata: { steerQuotesCapable: true },
    });
    await GenerationJobManager.steering.enqueue(streamId, {
      ...buildSteer('s1', 'what does this mean?'),
      quotes: ['selected passage'],
    });

    const hook = createSteerDrainHook({
      streamId,
      jobCreatedAt: job.createdAt,
      applySteer: jest.fn(),
    });

    const output: SteerDrainOutput = await hook(batchInput(), abortSignal);
    expect(output.injectedMessages).toEqual([
      { role: 'user', content: '> selected passage\n\nwhat does this mean?', source: 'steer' },
    ]);
  });

  it('keeps quotes in the injection when media encoding degrades to text', async () => {
    const streamId = `drain-quotes-degrade-${Date.now()}`;
    const job = await GenerationJobManager.createJob(streamId, 'user-1', undefined, {
      initialMetadata: { steerQuotesCapable: true },
    });
    await GenerationJobManager.steering.enqueue(streamId, {
      ...buildSteer('s1', 'and the doc?'),
      files: [{ file_id: 'f1', type: 'image/png' }],
      quotes: ['quoted context'],
    });

    const hook = createSteerDrainHook({
      streamId,
      jobCreatedAt: job.createdAt,
      applySteer: jest.fn(),
      buildMedia: jest.fn(async () => {
        throw new Error('encode failed');
      }),
    });

    const output: SteerDrainOutput = await hook(batchInput(), abortSignal);
    expect(output.injectedMessages).toEqual([
      { role: 'user', content: '> quoted context\n\nand the doc?', source: 'steer' },
    ]);
  });

  it('persists the steer part BEFORE media encoding (abort-safe ordering)', async () => {
    const streamId = `drain-apply-first-${Date.now()}`;
    const job = await GenerationJobManager.createJob(streamId, 'user-1');
    await GenerationJobManager.steering.enqueue(streamId, {
      ...buildSteer('s1', 'must land first'),
      files: [{ file_id: 'f1' }],
    });

    // Simulates an abort mid-encode: the part must already be applied.
    let appliedBeforeEncode = false;
    let partApplied = false;
    const hook = createSteerDrainHook({
      streamId,
      jobCreatedAt: job.createdAt,
      applySteer: () => {
        partApplied = true;
      },
      buildMedia: async () => {
        appliedBeforeEncode = partApplied;
        throw new Error('aborted mid-encode');
      },
    });

    const output = (await hook(batchInput(), abortSignal)) as SteerDrainOutput;
    expect(appliedBeforeEncode).toBe(true);
    expect(output.injectedMessages).toEqual([
      { role: 'user', content: 'must land first', source: 'steer' },
    ]);
  });

  it('degrades to text-only injection when media encoding fails', async () => {
    const streamId = `drain-media-error-${Date.now()}`;
    const job = await GenerationJobManager.createJob(streamId, 'user-1');
    await GenerationJobManager.steering.enqueue(streamId, {
      ...buildSteer('s1', 'words survive'),
      files: [{ file_id: 'f-gone' }],
    });

    const onMediaError = jest.fn();
    const hook = createSteerDrainHook({
      streamId,
      jobCreatedAt: job.createdAt,
      applySteer: jest.fn(),
      onMediaError,
      buildMedia: async () => {
        throw new Error('encode failed');
      },
    });

    const output = (await hook(batchInput(), abortSignal)) as SteerDrainOutput;
    expect(output.injectedMessages).toEqual([
      { role: 'user', content: 'words survive', source: 'steer' },
    ]);
    expect(onMediaError).toHaveBeenCalledWith(
      expect.objectContaining({ steerId: 's1' }),
      expect.objectContaining({ message: 'encode failed' }),
    );
  });
});

describe('isSteerPreemptSupported', () => {
  it('requires the preempt capability ON TOP of full steering support', () => {
    const sdk = agentsSdk as {
      HOOK_INJECTED_MESSAGES_CAPABLE?: boolean;
      HOOK_PREEMPT_BOUNDARY_CAPABLE?: boolean;
      ContentTypes?: { STEER?: string };
    };
    const expected = isSteeringSupported() && sdk.HOOK_PREEMPT_BOUNDARY_CAPABLE === true;
    expect(isSteerPreemptSupported()).toBe(expected);
  });
});

describe('isSteerPreemptRestartSupported', () => {
  /**
   * A THIRD probe on top of the preempt one. An SDK that can seal still cannot
   * act on an interrupt armed while the model is silent or merely thinking —
   * exactly the window users reach for it most — so a host that conflated the
   * two would hand out a wake channel nothing reads.
   */
  it('requires the restart capability ON TOP of preempt support', () => {
    const sdk = agentsSdk as { HOOK_PREEMPT_RESTART_CAPABLE?: boolean };
    const expected = isSteerPreemptSupported() && sdk.HOOK_PREEMPT_RESTART_CAPABLE === true;
    expect(isSteerPreemptRestartSupported()).toBe(expected);
  });
});

describe('createSteerPreemptBoundaryHook', () => {
  beforeEach(() => {
    GenerationJobManager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });
    GenerationJobManager.initialize();
  });

  afterEach(async () => {
    await GenerationJobManager.destroy();
  });

  it('drains the same queue and emits the same shapes as the tool boundary', async () => {
    const streamId = `preempt-drain-${Date.now()}`;
    const job = await GenerationJobManager.createJob(streamId, 'user-1');
    await GenerationJobManager.steering.enqueue(streamId, buildSteer('s1', 'first'));
    await GenerationJobManager.steering.enqueue(streamId, buildSteer('s2', 'second'));

    const applied: string[] = [];
    const hook = createSteerPreemptBoundaryHook({
      streamId,
      jobCreatedAt: job.createdAt,
      applySteer: (item) => {
        applied.push(item.text);
      },
    });

    const output = (await hook(boundaryInput(), abortSignal)) as SteerDrainOutput;
    expect(applied).toEqual(['first', 'second']);
    expect(output.injectedMessages).toEqual([
      { role: 'user', content: 'first', source: 'steer' },
      { role: 'user', content: 'second', source: 'steer' },
    ]);
    expect(await GenerationJobManager.steering.peek(streamId)).toEqual([]);
  });

  it('returns empty output when the queue drained before the seal landed', async () => {
    const streamId = `preempt-empty-${Date.now()}`;
    await GenerationJobManager.createJob(streamId, 'user-1');
    const hook = createSteerPreemptBoundaryHook({ streamId, applySteer: jest.fn() });

    expect(await hook(boundaryInput(), abortSignal)).toEqual({});
  });

  it('never drains inside a subagent scope', async () => {
    const streamId = `preempt-subagent-${Date.now()}`;
    await GenerationJobManager.createJob(streamId, 'user-1');
    await GenerationJobManager.steering.enqueue(streamId, buildSteer('s1', 'kept'));

    const hook = createSteerPreemptBoundaryHook({ streamId, applySteer: jest.fn() });
    expect(await hook(boundaryInput({ agentId: 'child-agent' }), abortSignal)).toEqual({});
    expect((await GenerationJobManager.steering.peek(streamId)).map((s) => s.text)).toEqual([
      'kept',
    ]);
  });

  it('refuses to drain when the job was replaced', async () => {
    const streamId = `preempt-replaced-${Date.now()}`;
    const job = await GenerationJobManager.createJob(streamId, 'user-1');
    const hook = createSteerPreemptBoundaryHook({
      streamId,
      jobCreatedAt: job.createdAt - 1,
      applySteer: jest.fn(),
    });
    await GenerationJobManager.steering.enqueue(streamId, buildSteer('s1', 'new job steer'));

    expect(await hook(boundaryInput(), abortSignal)).toEqual({});
    expect((await GenerationJobManager.steering.peek(streamId)).map((s) => s.text)).toEqual([
      'new job steer',
    ]);
  });

  it('clears the armed preempt request after draining', async () => {
    const streamId = `preempt-clears-${Date.now()}`;
    const job = await GenerationJobManager.createJob(streamId, 'user-1');
    await GenerationJobManager.steering.enqueue(streamId, {
      ...buildSteer('s1', 'interrupt me'),
      preempt: true,
    });
    GenerationJobManager.requestPreempt(streamId, 's1', job.createdAt);
    expect(GenerationJobManager.isPreemptRequested(streamId)).toBe(true);

    const hook = createSteerPreemptBoundaryHook({
      streamId,
      jobCreatedAt: job.createdAt,
      applySteer: jest.fn(),
    });
    await hook(boundaryInput(), abortSignal);

    expect(GenerationJobManager.isPreemptRequested(streamId)).toBe(false);
  });

  /**
   * The shared drain body is what makes this true: a preempt satisfied at an
   * ordinary tool boundary must disarm there, or the request would seal a
   * later, unrelated stretch of generation with nothing left to inject.
   */
  it('a tool-boundary drain also clears a pending preempt request', async () => {
    const streamId = `preempt-tool-clears-${Date.now()}`;
    const job = await GenerationJobManager.createJob(streamId, 'user-1');
    await GenerationJobManager.steering.enqueue(streamId, {
      ...buildSteer('s1', 'interrupt me'),
      preempt: true,
    });
    GenerationJobManager.requestPreempt(streamId, 's1', job.createdAt);

    const hook = createSteerDrainHook({
      streamId,
      jobCreatedAt: job.createdAt,
      applySteer: jest.fn(),
    });
    await hook(batchInput(), abortSignal);

    expect(GenerationJobManager.isPreemptRequested(streamId)).toBe(false);
  });

  /**
   * The empty-boundary self-clear: a seal was spent, so anything still armed
   * points at a steer that already left the queue. Leaving it armed would
   * seal again on the next chunk and truncate an unrelated answer.
   */
  it('disarms the generation when the boundary drains nothing', async () => {
    const streamId = `preempt-empty-clears-${Date.now()}`;
    const job = await GenerationJobManager.createJob(streamId, 'user-1');
    GenerationJobManager.requestPreempt(streamId, 'orphaned', job.createdAt);
    expect(GenerationJobManager.isPreemptRequested(streamId)).toBe(true);

    const hook = createSteerPreemptBoundaryHook({
      streamId,
      jobCreatedAt: job.createdAt,
      applySteer: jest.fn(),
    });
    expect(await hook(boundaryInput(), abortSignal)).toEqual({});

    expect(GenerationJobManager.isPreemptRequested(streamId)).toBe(false);
  });

  /**
   * A cancel whose cross-replica clear was lost leaves a stale arm. If the
   * next boundary drains a DIFFERENT steer, clearing only the drained id
   * would leave the stale one level-triggered — it would immediately seal
   * the continuation meant to answer the steer just injected, landing on an
   * empty boundary as `preempt_incomplete`.
   */
  it('a nonempty drain also clears stale arms held since the snapshot', async () => {
    const streamId = `preempt-stale-snapshot-${Date.now()}`;
    const job = await GenerationJobManager.createJob(streamId, 'user-1');

    /** Stale: armed, but its steer never reaches the queue (cancelled). */
    await GenerationJobManager.requestPreempt(streamId, 'steer-cancelled', job.createdAt);
    /** Live: queued and armed, and this is what the boundary will drain. */
    await GenerationJobManager.steering.enqueue(streamId, {
      ...buildSteer('steer-live', 'interrupt me'),
      preempt: true,
    });
    await GenerationJobManager.requestPreempt(streamId, 'steer-live', job.createdAt);
    expect(GenerationJobManager.isPreemptRequested(streamId)).toBe(true);

    const hook = createSteerPreemptBoundaryHook({
      streamId,
      jobCreatedAt: job.createdAt,
      applySteer: jest.fn(),
    });
    const output = (await hook(boundaryInput(), abortSignal)) as SteerDrainOutput;

    expect(output.injectedMessages).toHaveLength(1);
    /** Both the drained id and the stale snapshot id are spent. */
    expect(GenerationJobManager.isPreemptRequested(streamId)).toBe(false);
  });

  /** An arm that lands AFTER the snapshot is backed by a live queue item. */
  it('a nonempty drain spares an arm that landed after the snapshot', async () => {
    const streamId = `preempt-post-snapshot-${Date.now()}`;
    const job = await GenerationJobManager.createJob(streamId, 'user-1');
    await GenerationJobManager.steering.enqueue(streamId, {
      ...buildSteer('steer-first', 'first'),
      preempt: true,
    });
    await GenerationJobManager.requestPreempt(streamId, 'steer-first', job.createdAt);

    const hook = createSteerPreemptBoundaryHook({
      streamId,
      jobCreatedAt: job.createdAt,
      applySteer: async () => {
        /** Arrives mid-drain, after the snapshot was taken. */
        await GenerationJobManager.requestPreempt(streamId, 'steer-later', job.createdAt);
      },
    });
    await hook(boundaryInput(), abortSignal);

    expect(GenerationJobManager.getArmedPreemptIds(streamId, job.createdAt)).toEqual([
      'steer-later',
    ]);
  });

  it('restores the item and keeps its preempt request armed when durable apply fails', async () => {
    const streamId = `preempt-clears-on-error-${Date.now()}`;
    const job = await GenerationJobManager.createJob(streamId, 'user-1');
    await GenerationJobManager.steering.enqueue(streamId, {
      ...buildSteer('s1', 'still injected'),
      preempt: true,
    });
    GenerationJobManager.requestPreempt(streamId, 's1', job.createdAt);

    const hook = createSteerPreemptBoundaryHook({
      streamId,
      jobCreatedAt: job.createdAt,
      applySteer: () => {
        throw new Error('emit failed');
      },
    });

    const output = (await hook(boundaryInput(), abortSignal)) as SteerDrainOutput;
    expect(output).toEqual({});
    expect((await GenerationJobManager.steering.peek(streamId)).map((item) => item.text)).toEqual([
      'still injected',
    ]);
    expect(GenerationJobManager.isPreemptRequested(streamId)).toBe(true);
  });
});

describe('createSteerPreemptPoll', () => {
  beforeEach(() => {
    GenerationJobManager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });
    GenerationJobManager.initialize();
  });

  afterEach(async () => {
    await GenerationJobManager.destroy();
  });

  /**
   * The SDK contract requires a LEVEL-triggered predicate: it may be polled
   * many times before a chunk is safe to seal, and a self-clearing read would
   * silently lose the request on the first unsafe chunk.
   */
  it('keeps returning true until the request is cleared', async () => {
    const streamId = `preempt-poll-${Date.now()}`;
    const job = await GenerationJobManager.createJob(streamId, 'user-1');
    const { shouldPreempt } = createSteerPreemptPoll(streamId);

    expect(shouldPreempt()).toBe(false);
    GenerationJobManager.requestPreempt(streamId, 's1', job.createdAt);
    expect(shouldPreempt()).toBe(true);
    expect(shouldPreempt()).toBe(true);
    expect(shouldPreempt()).toBe(true);

    GenerationJobManager.noteSteersRemoved(streamId, ['s1'], job.createdAt);
    expect(shouldPreempt()).toBe(false);
  });

  it('is false for a stream with no live generation', () => {
    expect(createSteerPreemptPoll('no-such-stream').shouldPreempt()).toBe(false);
  });
});

/**
 * The wake channel exists because the poll above is only read per streamed
 * chunk. A steer armed while the provider is silent, or while it streams
 * reasoning that will never become sealable, cannot reach the run any other
 * way — it would wait out the whole turn and land as a terminal continuation.
 */
describe('preempt wake channel', () => {
  beforeEach(() => {
    GenerationJobManager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });
    GenerationJobManager.initialize();
  });

  afterEach(async () => {
    await GenerationJobManager.destroy();
  });

  it('wakes a subscribed run when a steer arms', async () => {
    const streamId = `preempt-wake-${Date.now()}`;
    const job = await GenerationJobManager.createJob(streamId, 'user-1');
    const wake = jest.fn();
    GenerationJobManager.subscribePreempt(streamId, wake, job.createdAt);

    expect(wake).not.toHaveBeenCalled();
    await GenerationJobManager.requestPreempt(streamId, 's1', job.createdAt);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(GenerationJobManager.isPreemptRequested(streamId)).toBe(true);
  });

  /**
   * The wake is a hint, not the request. An arm the store REFUSES — a steer
   * already drained at an ordinary boundary, so its id is tombstoned — leaves
   * nothing for the run to act on, and waking would spend a look for nothing.
   */
  it('stays quiet when the arm is refused', async () => {
    const streamId = `preempt-wake-refused-${Date.now()}`;
    const job = await GenerationJobManager.createJob(streamId, 'user-1');
    GenerationJobManager.noteSteersRemoved(streamId, ['s1'], job.createdAt);
    const wake = jest.fn();
    GenerationJobManager.subscribePreempt(streamId, wake, job.createdAt);

    await GenerationJobManager.requestPreempt(streamId, 's1', job.createdAt);

    expect(wake).not.toHaveBeenCalled();
    expect(GenerationJobManager.isPreemptRequested(streamId)).toBe(false);
  });

  /**
   * Requests are level-triggered, so an arm that landed before the run
   * installed its listener has no callback to notify — and on a silent or
   * reasoning-only turn no later chunk poll may ever run, which is the exact
   * stall this channel removes.
   */
  it('replays an arm that landed before the run subscribed', async () => {
    const streamId = `preempt-wake-replay-${Date.now()}`;
    const job = await GenerationJobManager.createJob(streamId, 'user-1');
    await GenerationJobManager.requestPreempt(streamId, 's1', job.createdAt);

    const wake = jest.fn();
    GenerationJobManager.subscribePreempt(streamId, wake, job.createdAt);

    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('does not replay to a run that already looked', async () => {
    const streamId = `preempt-wake-replay-once-${Date.now()}`;
    const job = await GenerationJobManager.createJob(streamId, 'user-1');
    const first = jest.fn();
    GenerationJobManager.subscribePreempt(streamId, first, job.createdAt);
    await GenerationJobManager.requestPreempt(streamId, 's1', job.createdAt);
    expect(first).toHaveBeenCalledTimes(1);

    const second = jest.fn();
    GenerationJobManager.subscribePreempt(streamId, second, job.createdAt);

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('does not replay when nothing is armed', async () => {
    const streamId = `preempt-wake-no-replay-${Date.now()}`;
    const job = await GenerationJobManager.createJob(streamId, 'user-1');
    const wake = jest.fn();

    GenerationJobManager.subscribePreempt(streamId, wake, job.createdAt);

    expect(wake).not.toHaveBeenCalled();
  });

  it('stops waking once the run unsubscribes', async () => {
    const streamId = `preempt-wake-unsub-${Date.now()}`;
    const job = await GenerationJobManager.createJob(streamId, 'user-1');
    const wake = jest.fn();
    const unsubscribe = GenerationJobManager.subscribePreempt(streamId, wake, job.createdAt);

    unsubscribe();
    await GenerationJobManager.requestPreempt(streamId, 's1', job.createdAt);

    expect(wake).not.toHaveBeenCalled();
  });

  /**
   * The same `createdAt` fence every other preempt entry point carries: a run
   * wired to a generation that has since been replaced must not be woken by
   * the replacement's arms.
   */
  it('refuses to subscribe against a replaced generation', async () => {
    const streamId = `preempt-wake-fence-${Date.now()}`;
    const job = await GenerationJobManager.createJob(streamId, 'user-1');
    const wake = jest.fn();
    const unsubscribe = GenerationJobManager.subscribePreempt(streamId, wake, job.createdAt - 1);

    await GenerationJobManager.requestPreempt(streamId, 's1', job.createdAt);

    expect(wake).not.toHaveBeenCalled();
    expect(() => unsubscribe()).not.toThrow();
  });

  /**
   * A wake is an optimization over the per-chunk poll. A listener that throws
   * must not fail the arm a durably queued steer already depends on.
   */
  it('survives a throwing listener without losing the arm', async () => {
    const streamId = `preempt-wake-throws-${Date.now()}`;
    const job = await GenerationJobManager.createJob(streamId, 'user-1');
    const healthy = jest.fn();
    GenerationJobManager.subscribePreempt(
      streamId,
      () => {
        throw new Error('listener exploded');
      },
      job.createdAt,
    );
    GenerationJobManager.subscribePreempt(streamId, healthy, job.createdAt);

    await expect(GenerationJobManager.requestPreempt(streamId, 's1', job.createdAt)).resolves.toBe(
      true,
    );
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(GenerationJobManager.isPreemptRequested(streamId)).toBe(true);
  });

  /**
   * The capability probe is what keeps the promise honest: an SDK that cannot
   * discard an unstarted turn is handed no wake channel at all, so the run
   * falls back to the per-chunk poll rather than subscribing to a signal
   * nothing reads.
   */
  it('supplies the channel only when the SDK can act on it', async () => {
    const streamId = `preempt-wake-probe-${Date.now()}`;
    await GenerationJobManager.createJob(streamId, 'user-1');
    /** Widened locally, the same way this file reads the SDK's capability
     *  constants: an SDK predating the restart contract types
     *  `StreamPreemption` without `subscribe`, and the probe below is exactly
     *  what decides whether the field is there to read. */
    const poll = createSteerPreemptPoll(streamId) as {
      subscribe?: (wake: () => void) => () => void;
    };

    expect(typeof poll.subscribe === 'function').toBe(isSteerPreemptRestartSupported());
  });
});
