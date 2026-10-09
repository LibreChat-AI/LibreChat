import { DEFAULT_QUEUED_SEND_LOCK_TIMEOUT_MS } from 'librechat-data-provider';
import { acquireQueueSendLock, releaseQueueSendLock } from '../queueIntent';

describe('acquireQueueSendLock', () => {
  let now = 1_000_000;

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('refuses a second claim on a pane while the first is held', () => {
    const lock = acquireQueueSendLock('pane-held');
    expect(lock).not.toBeNull();
    expect(acquireQueueSendLock('pane-held')).toBeNull();
    releaseQueueSendLock(lock);
    expect(acquireQueueSendLock('pane-held')).not.toBeNull();
  });

  it('treats a claim older than the default expiry as broken', () => {
    acquireQueueSendLock('pane-default');
    now += DEFAULT_QUEUED_SEND_LOCK_TIMEOUT_MS - 1;
    expect(acquireQueueSendLock('pane-default')).toBeNull();
    now += 1;
    expect(acquireQueueSendLock('pane-default')).not.toBeNull();
  });

  /* `interface.queuedSendLockTimeoutMs` reaches here as the second argument. */
  it('honours an operator-configured expiry', () => {
    acquireQueueSendLock('pane-configured', 5_000);
    now += 4_999;
    expect(acquireQueueSendLock('pane-configured', 5_000)).toBeNull();
    now += 1;
    expect(acquireQueueSendLock('pane-configured', 5_000)).not.toBeNull();
  });
});
