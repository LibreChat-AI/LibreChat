import type { ChatFinalization } from './chatFinalization';
import { createChatFinalization } from './chatFinalization';
import { REDIS_STREAM_INTERRUPTED } from './redisOutage';

function fixture(redisFinalizationRecoveryTimeoutMs?: number, isRedis = true) {
  const jobs = {
    isRedis,
    beginProviderExecution: jest.fn().mockResolvedValue(true),
    claimTerminalJob: jest.fn().mockResolvedValue({ status: 'aborted' }),
    completeJob: jest.fn().mockImplementation(async (_id, _message, _epoch, options) => {
      await options.beforeErrorPublication();
      await options.beforeTerminalCleanup();
      return true;
    }),
    markProviderExecutionDrained: jest.fn().mockResolvedValue(true),
  };
  const abort = new AbortController();
  const finalization = createChatFinalization({
    jobs,
    config: { redisFinalizationRecoveryTimeoutMs },
    streamId: 'chat',
    createdAt: 1,
    provider: 'provider',
    signal: abort.signal,
  });
  return { abort, jobs, finalization };
}

it.each([
  [undefined, 30_000],
  [1250, 1250],
  [0, 0],
])('uses the injected timeout %s (effective %s)', async (timeout, expected) => {
  const { finalization, jobs } = fixture(timeout);
  await finalization.begin();
  expect(jobs.beginProviderExecution).toHaveBeenCalledWith(
    'chat',
    1,
    'provider',
    undefined,
    expected,
  );
});

it('keeps the non-Redis stop and claim contract', async () => {
  const { finalization, abort, jobs } = fixture(undefined, false);
  await finalization.begin();
  expect(jobs.beginProviderExecution).toHaveBeenCalledWith('chat', 1, 'provider');
  abort.abort();
  expect(finalization.stopped(new Error('cancelled'))).toBe(true);
  await finalization.claim({});
  expect(jobs.claimTerminalJob).toHaveBeenCalledWith('chat', 'aborted', undefined, 1, {
    persistencePending: true,
  });
});

it('marks received content unfinished only after the exact claim wins', async () => {
  const { finalization, abort, jobs } = fixture();
  abort.abort(REDIS_STREAM_INTERRUPTED);
  const response = { content: [{ type: 'text', text: 'Received prefix' }], unfinished: false };
  jobs.claimTerminalJob.mockResolvedValueOnce(null);
  await expect(finalization.claim(response)).resolves.toBeNull();
  expect(response.unfinished).toBe(false);
  await finalization.claim(response);
  expect(response.unfinished).toBe(true);
  expect(jobs.claimTerminalJob).toHaveBeenLastCalledWith('chat', 'aborted', undefined, 1, {
    persistencePending: true,
    expectedProviderExecutionId: 'provider',
  });
});

it('routes an empty interrupted reply to fenced error persistence', async () => {
  const { finalization, abort, jobs } = fixture();
  abort.abort(REDIS_STREAM_INTERRUPTED);
  await expect(finalization.claim({ content: [], text: ' ' })).rejects.toBe(
    REDIS_STREAM_INTERRUPTED,
  );
  expect(jobs.claimTerminalJob).not.toHaveBeenCalled();
  expect(finalization.stopped(REDIS_STREAM_INTERRUPTED)).toBe(false);
  const persist: jest.MockedFunction<Parameters<ChatFinalization['fail']>[2]> = jest
    .fn()
    .mockResolvedValue(undefined);
  const settle = jest.fn().mockResolvedValue(undefined);
  const release = jest.fn();
  await finalization.fail('Generation interrupted', () => [], persist, settle);
  expect(jobs.completeJob).toHaveBeenCalledWith(
    'chat',
    'Generation interrupted',
    1,
    expect.objectContaining({ expectedProviderExecutionId: 'provider' }),
  );
  expect(persist).toHaveBeenCalledWith([]);
  jobs.markProviderExecutionDrained.mockRejectedValueOnce(new Error('drain unavailable'));
  await expect(finalization.drain(release)).rejects.toThrow('drain unavailable');
  expect(persist.mock.invocationCallOrder[0]).toBeLessThan(
    jobs.markProviderExecutionDrained.mock.invocationCallOrder[0],
  );
  expect(release).toHaveBeenCalledTimes(1);
});
