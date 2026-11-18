import { createConcurrencyLimiter } from '~/utils/promise';

const ENCODE_CONCURRENCY = 3;
const ENCODE_INFLIGHT_BYTES_MAX = 256 * 1024 * 1024;

export class InFlightBytesSemaphore {
  private inFlight = 0;
  private readonly queue: Array<{ bytes: number; resolve: () => void }> = [];

  constructor(private readonly ceiling: number) {}

  acquire(bytes: number, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    const reserve = Math.max(0, bytes || 0);

    if (this.queue.length === 0 && this.canAdmit(reserve)) {
      return Promise.resolve(this.grant(reserve));
    }

    return new Promise<() => void>((resolve, reject) => {
      const abort = (): void => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        signal?.removeEventListener('abort', abort);
        reject(signal?.reason);
        this.drain();
      };
      const waiter = {
        bytes: reserve,
        resolve: (): void => {
          signal?.removeEventListener('abort', abort);
          resolve(this.grant(reserve));
        },
      };
      this.queue.push(waiter);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  private canAdmit(reserve: number): boolean {
    return this.inFlight === 0 || this.inFlight + reserve <= this.ceiling;
  }

  private grant(reserve: number): () => void {
    this.inFlight += reserve;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.inFlight -= reserve;
      this.drain();
    };
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const head = this.queue[0];
      if (!this.canAdmit(head.bytes)) {
        break;
      }
      this.queue.shift();
      head.resolve();
    }
  }
}

const encodeLimit = createConcurrencyLimiter(ENCODE_CONCURRENCY);
const inFlightBytes = new InFlightBytesSemaphore(ENCODE_INFLIGHT_BYTES_MAX);

export function runGuardedEncode<T>(
  estimatedBytes: number,
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const run = async (): Promise<T> => {
    const release = await inFlightBytes.acquire(estimatedBytes, signal);
    try {
      return await task();
    } finally {
      release();
    }
  };
  return signal ? run() : encodeLimit(run);
}
