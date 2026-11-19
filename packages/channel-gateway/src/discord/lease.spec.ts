import type { DiscordApplicationOwnership } from './lease';
import { withDiscordApplicationLease } from './lease';

const owner = {
  applicationId: '123456789012345678',
  applicationRevision: 'revision',
  ownerId: 'a'.repeat(32),
};
const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
let ownership: jest.Mocked<DiscordApplicationOwnership>;
let controller: AbortController;
const untilAbort = (signal: AbortSignal) =>
  new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(100_000);
  controller = new AbortController();
  ownership = {
    acquire: jest.fn().mockResolvedValue(true),
    renew: jest.fn().mockResolvedValue(true),
    release: jest.fn().mockResolvedValue(true),
  };
});
afterEach(() => {
  controller.abort();
  jest.useRealTimers();
});
const run = (work: (signal: AbortSignal) => Promise<void>) =>
  withDiscordApplicationLease({ owner, leaseMs: 6000, ownership, log }, work, controller.signal);

it('does not start work or release another process ownership when acquisition is refused', async () => {
  ownership.acquire.mockResolvedValue(false);
  const work = jest.fn();
  expect(await run(work)).toBe(false);
  expect(work).not.toHaveBeenCalled();
  expect(ownership.release).not.toHaveBeenCalled();
});

it('releases a successful acquisition received after shutdown without starting work', async () => {
  let complete!: (held: boolean) => void;
  ownership.acquire.mockImplementation(() => new Promise((resolve) => (complete = resolve)));
  const work = jest.fn();
  const pending = run(work);
  controller.abort();
  complete(true);
  expect(await pending).toBe(false);
  expect(work).not.toHaveBeenCalled();
  expect(ownership.release).toHaveBeenCalledWith(owner);
});

it('counts acquisition time against its lease and releases an expired grant', async () => {
  ownership.acquire.mockImplementation(async () => {
    jest.setSystemTime(106_001);
    return true;
  });
  const work = jest.fn();
  expect(await run(work)).toBe(false);
  expect(work).not.toHaveBeenCalled();
  expect(ownership.release).toHaveBeenCalledWith(owner);
});

it('renews the same owner and drains work before releasing on shutdown', async () => {
  const work = jest.fn(untilAbort);
  const pending = run(work);
  await jest.advanceTimersByTimeAsync(4000);
  expect(ownership.renew).toHaveBeenCalledTimes(2);
  expect(ownership.renew).toHaveBeenCalledWith(owner, 6000, expect.any(AbortSignal));
  controller.abort();
  expect(await pending).toBe(true);
  expect(work.mock.calls[0][0].aborted).toBe(true);
  expect(ownership.release).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

it.each(['refused', 'failed', 'expired'])(
  'aborts work when renewal is %s without allowing a late response to extend ownership',
  async (reason) => {
    let complete: ((held: boolean) => void) | undefined;
    if (reason === 'refused') ownership.renew.mockResolvedValue(false);
    if (reason === 'failed') ownership.renew.mockRejectedValue(new Error('private response'));
    if (reason === 'expired')
      ownership.renew.mockImplementation(() => new Promise((resolve) => (complete = resolve)));
    const work = jest.fn(untilAbort);
    const pending = run(work);
    await jest.advanceTimersByTimeAsync(reason === 'expired' ? 6000 : 2000);
    expect(work.mock.calls[0][0].aborted).toBe(true);
    complete?.(true);
    expect(await pending).toBe(true);
    expect(ownership.release).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  },
);

it('releases the lease when work fails without hiding the failure', async () => {
  await expect(run(async () => Promise.reject(new Error('work failed')))).rejects.toThrow(
    'work failed',
  );
  expect(ownership.release).toHaveBeenCalledWith(owner);
  expect(jest.getTimerCount()).toBe(0);
});
