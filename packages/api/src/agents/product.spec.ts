import { serverProductFactSchema } from 'librechat-data-provider';
import type { ProductTrackingRequest } from './product';
import { observeProductRun, observeProductRunSetup } from './product';

const trackers: jest.Mock[] = [];
afterEach(() => {
  for (const tracker of trackers.splice(0)) {
    for (const [fact] of tracker.mock.calls) {
      serverProductFactSchema.parse(fact);
    }
  }
});

function request() {
  const productTracker = jest.fn();
  trackers.push(productTracker);
  const req: ProductTrackingRequest = {
    productTracker,
    productTracking: { enabled: true },
    productTrackingContext: { submissionId: 'aef33490-7e1a-4786-9ac6-d45dd28ca281' },
  };
  return { req, track: productTracker };
}

const context = { runId: 'generation', conversationId: 'conversation', agentId: 'agent_root' };

describe('product execution facts', () => {
  it('does not treat a paused run as a response completion; resume finishes once', async () => {
    const { req, track } = request();
    let interrupted = true;
    const run = observeProductRun(
      {
        processStream: async () => 'result',
        getInterrupt: () => (interrupted ? {} : undefined),
        getHaltReason: () => undefined,
      },
      req,
      context,
      new AbortController().signal,
    );
    await run.processStream();
    expect(track).not.toHaveBeenCalled();
    interrupted = false;
    await run.processStream();
    await run.processStream();
    expect(track.mock.calls.map(([fact]) => fact.name)).toEqual([
      'librechat.chat.response.finished',
    ]);
  });

  it('observes a remote resume even when it bypasses processStream', async () => {
    const { req, track } = request();
    const run = observeProductRun(
      {
        processStream: async () => 'start',
        resume: async () => 'resumed',
        getInterrupt: () => undefined,
        getHaltReason: () => undefined,
      },
      req,
      context,
      new AbortController().signal,
    );
    expect(await run.resume()).toBe('resumed');
    expect(track.mock.calls[0][0]).toMatchObject({
      name: 'librechat.chat.response.finished',
      outcome: 'completed',
    });
  });

  it('reports setup failures without inventing an agent or model invocation', async () => {
    const { req, track } = request();
    const error = new Error('secret provider config');
    await expect(
      observeProductRunSetup(req, context, new AbortController().signal, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(track).toHaveBeenCalledTimes(1);
    expect(track.mock.calls[0][0]).toMatchObject({
      name: 'librechat.chat.response.finished',
      outcome: 'failed',
    });
    expect(JSON.stringify(track.mock.calls)).not.toContain('secret');
  });

  it('recognizes owned cancellation during setup and leaves successful setup open', async () => {
    const { req, track } = request();
    const abort = new AbortController();
    const result = {};
    expect(await observeProductRunSetup(req, context, abort.signal, async () => result)).toBe(
      result,
    );
    expect(track).not.toHaveBeenCalled();
    abort.abort();
    await expect(
      observeProductRunSetup(req, context, abort.signal, async () => {
        throw abort.signal.reason;
      }),
    ).rejects.toBe(abort.signal.reason);
    expect(track.mock.calls[0][0]).toMatchObject({ outcome: 'cancelled' });
  });
  it.each([false, true])(
    'waits for the outer resume boundary before reporting completion (cleanup failure: %s)',
    async (cleanupFails) => {
      const { req, track } = request();
      const failure = new Error('cleanup failure');
      const subject = {
        processStream: async () => 'stream result',
        resume: async () => {
          const result = await subject.processStream();
          expect(track).not.toHaveBeenCalled();
          if (cleanupFails) throw failure;
          return result;
        },
        getInterrupt: () => undefined,
        getHaltReason: () => undefined,
      };
      const run = observeProductRun(subject, req, context, new AbortController().signal);
      if (cleanupFails) await expect(run.resume()).rejects.toBe(failure);
      else await expect(run.resume()).resolves.toBe('stream result');
      expect(track).toHaveBeenCalledTimes(1);
      expect(track.mock.calls[0][0]).toMatchObject({
        name: 'librechat.chat.response.finished',
        outcome: cleanupFails ? 'failed' : 'completed',
      });
    },
  );
});

it('records a halted run as incomplete, not failed', async () => {
  const { req, track } = request();
  const run = observeProductRun(
    {
      processStream: async () => 'result',
      getInterrupt: () => undefined,
      getHaltReason: () => 'output_truncated',
    },
    req,
    context,
    new AbortController().signal,
  );
  await run.processStream();
  expect(track.mock.calls.map(([fact]) => [fact.name, fact.outcome])).toEqual([
    ['librechat.chat.response.finished', 'incomplete'],
  ]);
});
