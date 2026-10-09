/**
 * Every `success: false` abort must name WHY it failed. Callers that settle durable
 * state on an abort (schedule outcomes, checkpoint pruning) previously inferred a
 * confirmed stop from the ABSENCE of a failure reason, which silently swept in the
 * unlabeled not-found and already-terminal paths.
 */
import type { AbortResult } from '../interfaces/IJobStore';
import { isStopConfirmed } from '../interfaces/IJobStore';

/** Suppress winston Console transport output (survives jest.resetModules) */
jest.spyOn(console, 'log').mockImplementation();

async function configureManager() {
  const { GenerationJobManager } = await import('../GenerationJobManager');
  const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
  const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');

  GenerationJobManager.configure({
    jobStore: new InMemoryJobStore(),
    eventTransport: new InMemoryEventTransport(),
    isRedis: false,
    cleanupOnComplete: false,
  });
  GenerationJobManager.initialize();
  return GenerationJobManager;
}

describe('abortJob failure reasons', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('reports job_not_found when nothing occupies the stream', async () => {
    const manager = await configureManager();

    const result = await manager.abortJob('never-created');

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('job_not_found');
    expect(isStopConfirmed(result)).toBe(false);

    await manager.destroy();
  });

  it('reports already_settled for a generation that is terminal before the call', async () => {
    const manager = await configureManager();
    const streamId = 'abort-twice';
    await manager.createJob(streamId, 'user-1');

    const first = await manager.abortJob(streamId);
    expect(first.success).toBe(true);

    const second = await manager.abortJob(streamId);

    expect(second.success).toBe(false);
    expect(second.failureReason).toBe('already_settled');
    // No transition was needed — the generation is already stopped, so a caller may
    // still settle on it. This is the ONE failure reason that confirms a stop.
    expect(isStopConfirmed(second)).toBe(true);

    await manager.destroy();
  });

  it('reports generation_replaced when the epoch fence rejects a stale abort', async () => {
    const manager = await configureManager();
    const streamId = 'epoch-fenced';
    const job = await manager.createJob(streamId, 'user-1');

    const result = await manager.abortJob(streamId, {
      expectedCreatedAt: job.createdAt - 1,
    });

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('generation_replaced');
    expect(isStopConfirmed(result)).toBe(false);

    await manager.destroy();
  });

  it('leaves no unlabeled failure across the reachable abort outcomes', async () => {
    const manager = await configureManager();
    const streamId = 'labeled';
    const job = await manager.createJob(streamId, 'user-1');

    const results = [
      await manager.abortJob('missing'),
      await manager.abortJob(streamId, { expectedCreatedAt: job.createdAt - 1 }),
      await manager.abortJob(streamId),
      await manager.abortJob(streamId),
    ];

    for (const result of results) {
      expect(result.success === true || result.failureReason != null).toBe(true);
    }

    await manager.destroy();
  });
});

describe('isStopConfirmed', () => {
  const base: AbortResult = {
    success: false,
    jobData: null,
    content: [],
    finalEvent: null,
    text: '',
    collectedUsage: [],
  };

  it('confirms a landed abort', () => {
    expect(isStopConfirmed({ ...base, success: true })).toBe(true);
  });

  it('confirms an already-terminal generation', () => {
    expect(isStopConfirmed({ ...base, failureReason: 'already_settled' })).toBe(true);
  });

  it.each(['generation_replaced', 'job_still_active', 'job_not_found'] as const)(
    'refuses to confirm %s',
    (failureReason) => {
      expect(isStopConfirmed({ ...base, failureReason })).toBe(false);
    },
  );

  it('refuses to confirm a bare failure with no reason', () => {
    expect(isStopConfirmed(base)).toBe(false);
  });

  it.each([null, undefined])('refuses to confirm %p', (result) => {
    expect(isStopConfirmed(result)).toBe(false);
  });
});
