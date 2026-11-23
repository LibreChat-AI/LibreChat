type Job = () => Promise<void> | void;

/**
 * Runs jobs one at a time, in the order they were queued, so a stream frame, a tool update and a
 * stop never interleave their reads and writes of the message list. AI SDK: `SerialJobExecutor`.
 */
export class SerialJobExecutor {
  private queue: Array<() => Promise<void>> = [];
  private running = false;

  /** Queues `job`; resolves once it ran, or rejects with what it threw. Later jobs still run. */
  run(job: Job): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          await job();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      void this.drain();
    });
  }

  /** Whether no job is queued or running. */
  get idle(): boolean {
    return !this.running && this.queue.length === 0;
  }

  private async drain(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      let next = this.queue.shift();
      while (next) {
        await next();
        next = this.queue.shift();
      }
    } finally {
      this.running = false;
    }
  }
}
