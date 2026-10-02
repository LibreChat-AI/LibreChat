import { waitForMeiliTask } from './tasks';

class TaskTimeoutError extends Error {}

describe('waitForMeiliTask', () => {
  test('retries client timeout windows until the task succeeds', async () => {
    const client = {
      waitForTask: jest
        .fn()
        .mockRejectedValueOnce(new TaskTimeoutError('still processing'))
        .mockResolvedValueOnce({ status: 'succeeded' }),
    };

    await expect(
      waitForMeiliTask(
        client,
        17,
        'messages settings',
        (error) => error instanceof TaskTimeoutError,
      ),
    ).resolves.toBeUndefined();

    expect(client.waitForTask).toHaveBeenCalledTimes(2);
    expect(client.waitForTask).toHaveBeenCalledWith(17, {
      timeOutMs: 10_000,
      intervalMs: 100,
    });
  });

  test('stops at the overall deadline and caps the final client wait', async () => {
    jest.useFakeTimers();
    try {
      const client = {
        waitForTask: jest.fn(
          (_taskUid: number, options: { timeOutMs: number; intervalMs: number }) =>
            new Promise<never>((_resolve, reject) => {
              setTimeout(() => reject(new TaskTimeoutError('still processing')), options.timeOutMs);
            }),
        ),
      };

      const waiting = waitForMeiliTask(
        client,
        19,
        'messages indexing',
        (error) => error instanceof TaskTimeoutError,
        { timeoutMs: 25_000 },
      );
      const result = waiting.then(
        () => undefined,
        (error: unknown) => error,
      );

      await jest.advanceTimersByTimeAsync(25_000);
      await expect(result).resolves.toEqual(
        expect.objectContaining({
          message: 'messages indexing task 19 did not complete within 25000ms',
        }),
      );

      expect(client.waitForTask.mock.calls.map(([, options]) => options.timeOutMs)).toEqual([
        10_000, 10_000, 5_000,
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  test('enforces the overall deadline when waitForTask never settles', async () => {
    jest.useFakeTimers();
    try {
      const client = {
        waitForTask: jest.fn(() => new Promise<never>(() => undefined)),
      };

      const waiting = waitForMeiliTask(client, 21, 'convos indexing', () => false, {
        timeoutMs: 2500,
      });
      const result = waiting.catch((error: unknown) => error);

      await jest.advanceTimersByTimeAsync(2500);

      await expect(result).resolves.toEqual(
        expect.objectContaining({
          message: 'convos indexing task 21 did not complete within 2500ms',
        }),
      );
      expect(client.waitForTask).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('cancels a never-settling task wait', async () => {
    const controller = new AbortController();
    const client = {
      waitForTask: jest.fn(() => new Promise<never>(() => undefined)),
    };
    const waiting = waitForMeiliTask(client, 22, 'messages indexing', () => false, {
      signal: controller.signal,
    });

    controller.abort(new Error('shutdown'));

    await expect(waiting).rejects.toThrow('shutdown');
  });

  test('reports the operation and terminal task status', async () => {
    const client = {
      waitForTask: jest.fn().mockResolvedValue({ status: 'failed' }),
    };

    await expect(waitForMeiliTask(client, 23, 'messages cleanup', () => false)).rejects.toThrow(
      'messages cleanup task 23 ended with failed',
    );
  });

  test('allows callers to accept a provider-confirmed idempotent terminal result', async () => {
    const client = {
      waitForTask: jest.fn().mockResolvedValue({
        status: 'failed',
        error: { code: 'index_already_exists' },
      }),
    };

    await expect(
      waitForMeiliTask(client, 29, 'messages creation', () => false, {
        isTaskSuccessful: (task) => task.error?.code === 'index_already_exists',
      }),
    ).resolves.toBeUndefined();
  });

  test('propagates non-timeout client errors', async () => {
    const client = {
      waitForTask: jest.fn().mockRejectedValue(new Error('Meilisearch unavailable')),
    };

    await expect(waitForMeiliTask(client, 31, 'convos settings', () => false)).rejects.toThrow(
      'Meilisearch unavailable',
    );
  });
});
