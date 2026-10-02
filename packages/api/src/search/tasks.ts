interface TaskResult {
  status: string;
  error?: {
    code?: string;
  } | null;
}

interface TaskClient {
  waitForTask(
    taskUid: number,
    options: { timeOutMs: number; intervalMs: number },
  ): Promise<TaskResult>;
}

interface WaitForMeiliTaskOptions {
  timeoutMs?: number;
  isTaskSuccessful?: (task: TaskResult) => boolean;
  signal?: AbortSignal;
}

export const MEILI_INDEX_SYNC_TIMEOUT_MS: number = 10 * 60 * 1000;
export const MEILI_HTTP_REQUEST_TIMEOUT_MS: number = 10_000;
const MEILI_TASK_POLL_TIMEOUT_MS = 10_000;
const MEILI_TASK_POLL_INTERVAL_MS = 100;

const getAbortError = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new Error('Meilisearch task wait was cancelled');

const waitWithinDeadline = <T>(
  promise: Promise<T>,
  remainingMs: number,
  deadlineError: Error,
  signal?: AbortSignal,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const resolveOnce = (value: T) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => rejectOnce(getAbortError(signal!));
    const timer = setTimeout(() => rejectOnce(deadlineError), remainingMs);

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(resolveOnce, (error: unknown) =>
      rejectOnce(error instanceof Error ? error : new Error(String(error))),
    );
  });

/**
 * Waits through Meilisearch client timeout windows until a task reaches a terminal state or the
 * overall deadline expires.
 */
export async function waitForMeiliTask(
  client: TaskClient,
  taskUid: number,
  operation: string,
  isTimeoutError: (error: unknown) => boolean,
  options: WaitForMeiliTaskOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? MEILI_INDEX_SYNC_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Meilisearch task timeout must be a positive finite number');
  }
  const startedAt = Date.now();
  const deadlineError = new Error(
    `${operation} task ${taskUid} did not complete within ${timeoutMs}ms`,
  );

  while (true) {
    if (options.signal?.aborted) {
      throw getAbortError(options.signal);
    }
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      throw deadlineError;
    }

    try {
      const task = await waitWithinDeadline(
        client.waitForTask(taskUid, {
          timeOutMs: Math.min(MEILI_TASK_POLL_TIMEOUT_MS, remainingMs),
          intervalMs: MEILI_TASK_POLL_INTERVAL_MS,
        }),
        remainingMs,
        deadlineError,
        options.signal,
      );
      const isTaskSuccessful = options.isTaskSuccessful?.(task) ?? task.status === 'succeeded';
      if (!isTaskSuccessful) {
        throw new Error(`${operation} task ${taskUid} ended with ${task.status}`);
      }
      return;
    } catch (error) {
      if (isTimeoutError(error)) {
        continue;
      }
      throw error;
    }
  }
}
