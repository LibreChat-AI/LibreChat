import type { TNearAIVerificationReport } from 'librechat-data-provider';
import { createReportCache } from './cache';

const options = { identity: 'user-key-model', ttl: 1000, max: 2, refresh: false };
const report = (
  status: TNearAIVerificationReport['status'] = 'verified',
): TNearAIVerificationReport => ({
  schemaVersion: 1,
  kind: 'model',
  model: 'model',
  scope: 'model',
  status,
  verifiedAt: new Date(Date.now()).toISOString(),
});

afterEach(() => jest.restoreAllMocks());

it('shares an in-flight request and preserves the original successful report and time', async () => {
  const cache = createReportCache();
  const reports = [report()];
  const load = jest.fn(async () => reports);
  const first = cache(options, load);
  const second = cache(options, load);
  expect(first).toBe(second);
  await expect(first).resolves.toBe(reports);
  await expect(cache(options, load)).resolves.toBe(reports);
  expect(load).toHaveBeenCalledTimes(1);
});

it('expires at the earliest evidence time instead of restarting TTL on reads', async () => {
  let now = Date.now();
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  const cache = createReportCache();
  const older = report();
  now += 500;
  const load = jest.fn(async () => [older, report()]);
  await cache(options, load);
  now += 499;
  await cache(options, load);
  expect(load).toHaveBeenCalledTimes(1);
  now += 1;
  await cache(options, load);
  expect(load).toHaveBeenCalledTimes(2);
});

it.each(['failed', 'unverifiable'] as const)(
  'does not cache %s or restore preceding success',
  async (status) => {
    const cache = createReportCache();
    const load = jest.fn(async () => [report()]);
    await cache(options, load);
    load.mockResolvedValueOnce([report(status)]);
    expect((await cache({ ...options, refresh: true }, load))[0].status).toBe(status);
    expect((await cache(options, load))[0].status).toBe('verified');
    expect(load).toHaveBeenCalledTimes(3);
  },
);

it('retries operational errors without returning the preceding cached success', async () => {
  const cache = createReportCache();
  const load = jest.fn(async () => [report()]);
  await cache(options, load);
  load.mockRejectedValueOnce(new Error('offline'));
  await expect(cache({ ...options, refresh: true }, load)).rejects.toThrow('offline');
  await expect(cache(options, load)).resolves.toHaveLength(1);
  expect(load).toHaveBeenCalledTimes(3);
});

it('keeps identities, scopes and changed cache policies separate', async () => {
  const cache = createReportCache();
  const load = jest.fn(async () => [report()]);
  const large = { ...options, max: 10 };
  await cache(large, load);
  await cache({ ...large, identity: 'different-credentials' }, load);
  await cache({ ...large, scope: 'gateway' }, load);
  await cache({ ...large, ttl: 500 }, load);
  expect(load).toHaveBeenCalledTimes(4);
});

it('forces a new request and invalidates both scopes of the same identity', async () => {
  const cache = createReportCache();
  const load = jest.fn(async () => [report()]);
  await cache(options, load);
  await cache({ ...options, scope: 'gateway' }, load);
  await cache({ ...options, refresh: true }, load);
  await cache({ ...options, scope: 'gateway' }, load);
  expect(load).toHaveBeenCalledTimes(4);
});

it('does not let an older in-flight success overwrite a newer refresh failure', async () => {
  const cache = createReportCache();
  let complete: (reports: TNearAIVerificationReport[]) => void = () => undefined;
  const older = cache(
    options,
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await Promise.resolve();
  await cache({ ...options, refresh: true }, async () => [report('failed')]);
  complete([report()]);
  await older;
  const load = jest.fn(async () => [report()]);
  await cache(options, load);
  expect(load).toHaveBeenCalledTimes(1);
});

it('bounds capacity and supports disabling successful-result reuse', async () => {
  const cache = createReportCache();
  const small = { ...options, max: 1 };
  const load = jest.fn(async () => [report()]);
  await cache(small, load);
  await cache({ ...small, identity: 'other' }, load);
  await cache(small, load);
  expect(load).toHaveBeenCalledTimes(3);
  await cache({ ...small, ttl: 0 }, load);
  await cache({ ...small, ttl: 0 }, load);
  expect(load).toHaveBeenCalledTimes(5);
});
