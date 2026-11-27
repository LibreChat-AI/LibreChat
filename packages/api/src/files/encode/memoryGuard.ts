import { createConcurrencyLimiter } from '~/utils/promise';

const ENCODE_CONCURRENCY = 3;
const ENCODE_INFLIGHT_BYTES_MAX = 256 * 1024 * 1024;

export class InFlightBytesSemaphore {
  private inFlight = 0;
  private readonly queue: Array<{ bytes: number; resolve: () => void }> = [];

  constructor(private readonly ceiling: number) {}

  acquire(bytes: number): Promise<() => void> {
    const reserve = Math.max(0, bytes || 0);

    if (this.queue.length === 0 && this.canAdmit(reserve)) {
      return Promise.resolve(this.grant(reserve));
    }

    return new Promise<() => void>((resolve) => {
      this.queue.push({ bytes: reserve, resolve: () => resolve(this.grant(reserve)) });
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

export function runGuardedEncode<T>(estimatedBytes: number, task: () => Promise<T>): Promise<T> {
  return encodeLimit(async () => {
    const release = await inFlightBytes.acquire(estimatedBytes);
    try {
      return await task();
    } finally {
      release();
    }
  });
}
