import { Keyv } from 'keyv';
import { randomUUID } from 'crypto';
import { RunStatus } from 'librechat-data-provider';
import type { Response } from 'express';
import type { DistributedLock } from '~/cache/lock';
import type { ServerRequest } from '~/types';
import type { StopRunDeps } from './stop';
import { claimRunRecovery, createRecoveryClaim } from './recovery';
import { createDistributedLock } from '~/cache/lock';
import { stopRun } from './stop';

class FakeResponse {
  headersSent = false;
  statusCode = 200;
  body: unknown;
  ended = false;

  setHeader() {
    return this;
  }

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  send(body: unknown) {
    this.body = body;
    return this;
  }

  json(body: unknown) {
    this.body = body;
    return this;
  }

  end() {
    this.ended = true;
    return this;
  }
}

describe('stopRun', () => {
  const conversationId = randomUUID();
  const key = `user-1:${conversationId}`;
  let cache: Keyv;
  let lock: DistributedLock;
  let cancel: jest.Mock;
  let recordUsage: jest.Mock;
  let checkMessageGaps: jest.Mock;
  let initializeClient: jest.Mock;

  const stop = async () => {
    const req = {
      user: { id: 'user-1' },
      body: { abortKey: `${conversationId}:latest-1`, endpoint: 'assistants' },
      config: {},
    } as unknown as ServerRequest;
    const res = new FakeResponse();
    const deps: StopRunDeps = {
      cache,
      lock,
      getConvo: async () => ({ conversationId, model: 'gpt-4o-mini' }),
      initializeClient,
      recordUsage,
      checkMessageGaps,
    };
    await stopRun(req, res as unknown as Response, deps);
    return res;
  };

  beforeEach(() => {
    cache = new Keyv();
    lock = createDistributedLock();
    cancel = jest.fn().mockResolvedValue({ status: RunStatus.CANCELLING });
    const retrieve = jest.fn().mockResolvedValue({
      model: 'gpt-4o-mini',
      usage: { prompt_tokens: 8, completion_tokens: 4 },
    });
    initializeClient = jest
      .fn()
      .mockResolvedValue({ openai: { beta: { threads: { runs: { cancel, retrieve } } } } });
    recordUsage = jest.fn().mockResolvedValue(undefined);
    checkMessageGaps = jest.fn().mockResolvedValue([{ messageId: 'reply-1' }]);
  });

  it('stops, bills and reads back the run, which its request then cannot recover', async () => {
    await cache.set(key, 'thread_1:run_1');

    const res = await stop();

    expect(cancel).toHaveBeenCalledWith('run_1', { thread_id: 'thread_1' });
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt_tokens: 8, completion_tokens: 4, user: 'user-1' }),
    );
    expect(res.body).toEqual({
      final: true,
      conversation: { conversationId, model: 'gpt-4o-mini' },
      runMessages: [{ messageId: 'reply-1' }],
    });
    expect(await cache.get(key)).toBe(RunStatus.CANCELLED);
    const claim = createRecoveryClaim({ cache, lock, completedRun: () => undefined });
    await cache.set(key, 'thread_1:run_2');
    expect(await claim({ key, run_id: 'run_1', error: new Error('Request closed') })).toBe(false);
  });

  it('answers 204 and leaves the run alone when its request already recovered it', async () => {
    await cache.set(key, 'thread_1:run_1');
    expect(await claimRunRecovery(lock, 'run_1')).toBe(true);

    const res = await stop();

    expect(res.statusCode).toBe(204);
    expect(cancel).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
    expect(checkMessageGaps).not.toHaveBeenCalled();
    expect(await cache.get(key)).toBe('thread_1:run_1');
  });

  it('leaves the run to its request when the provider client cannot start', async () => {
    await cache.set(key, 'thread_1:run_1');
    initializeClient.mockRejectedValueOnce(new Error('No API key'));

    await expect(stop()).rejects.toThrow('No API key');
    expect(await claimRunRecovery(lock, 'run_1')).toBe(true);
  });

  it('ends the response when the provider already cancelled the run', async () => {
    await cache.set(key, 'thread_1:run_1');
    cancel.mockRejectedValueOnce(new Error("Cannot cancel run with status 'cancelled'."));

    const res = await stop();

    expect(res.ended).toBe(true);
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('answers 204 when the entry is gone or already marked', async () => {
    expect((await stop()).statusCode).toBe(204);

    await cache.set(key, RunStatus.CANCELLED);
    expect((await stop()).statusCode).toBe(204);
    expect(cancel).not.toHaveBeenCalled();
  });
});
