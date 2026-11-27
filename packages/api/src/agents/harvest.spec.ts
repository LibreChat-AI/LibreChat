import type { ServerRequest } from '~/types';
import { createBackgroundCodeResultHandler, createBackgroundToolResultHandler } from './harvest';

const req = {
  user: { id: 'user-1' },
} as ServerRequest;

const params = {
  toolName: 'execute_code',
  toolCallId: 'tool-call-1',
  stepId: 'step-1',
  messageId: 'message-1',
  conversationId: 'conversation-1',
  output: 'safe output',
  artifact: {
    session_id: 'artifact-session',
    files: [{ id: 'file-1', name: 'output.txt', storage_session_id: 'storage-session' }],
  },
  codeExecutionContext: {
    baseUrl: 'https://code-stateful.example.com',
    codeSessionKey: 'execute_code:stateful:test',
    executionProfile: 'stateful' as const,
    executionRouteKey: `stateful:${'a'.repeat(32)}`,
    statefulSessions: true,
  },
};

describe('createBackgroundCodeResultHandler generated-file preflight', () => {
  it('persists prepared entries only after the complete batch preflight passes', async () => {
    const preparedBuffer = Buffer.from('safe');
    const preflightCodeOutputBatch = jest.fn().mockResolvedValue([
      {
        file: params.artifact.files[0],
        sessionId: 'storage-session',
        preparedBuffer,
      },
    ]);
    const processCodeOutput = jest.fn().mockResolvedValue({
      file: { file_id: 'persisted-file' },
    });
    const updateToolCallResult = jest.fn().mockResolvedValue({ matched: true, unfinished: false });
    const runPreviewFinalize = jest.fn();
    const handler = createBackgroundCodeResultHandler({
      req,
      preflightCodeOutputBatch,
      processCodeOutput,
      updateToolCallResult,
      runPreviewFinalize,
    });

    await expect(handler(params)).resolves.toEqual({
      attachments: [{ file_id: 'persisted-file', stepId: 'step-1' }],
    });

    expect(preflightCodeOutputBatch).toHaveBeenCalledWith({
      req,
      artifact: params.artifact,
      codeExecutionContext: params.codeExecutionContext,
    });
    expect(processCodeOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        req,
        id: 'file-1',
        name: 'output.txt',
        session_id: 'storage-session',
        codeApiBaseUrl: 'https://code-stateful.example.com',
        executionProfile: 'stateful',
        executionRouteKey: `stateful:${'a'.repeat(32)}`,
        preparedBuffer,
      }),
    );
    expect(preflightCodeOutputBatch.mock.invocationCallOrder[0]).toBeLessThan(
      processCodeOutput.mock.invocationCallOrder[0],
    );
    expect(updateToolCallResult).toHaveBeenCalledWith(
      expect.objectContaining({
        output: 'safe output',
        stepId: 'step-1',
        attachments: [{ file_id: 'persisted-file', stepId: 'step-1' }],
      }),
    );
  });

  it('propagates a blocked batch before persistence or tool-result update', async () => {
    const blocked = new Error('generated content blocked');
    const preflightCodeOutputBatch = jest.fn().mockRejectedValue(blocked);
    const processCodeOutput = jest.fn();
    const updateToolCallResult = jest.fn();
    const handler = createBackgroundCodeResultHandler({
      req,
      preflightCodeOutputBatch,
      processCodeOutput,
      updateToolCallResult,
      runPreviewFinalize: jest.fn(),
    });

    await expect(handler(params)).rejects.toBe(blocked);

    expect(processCodeOutput).not.toHaveBeenCalled();
    expect(updateToolCallResult).not.toHaveBeenCalled();
  });
});

describe('createBackgroundToolResultHandler claim ownership', () => {
  it('re-reads a same-generation manual claim before each persistence retry', async () => {
    let claimed = false;
    const updateToolCallResult = jest
      .fn()
      .mockImplementationOnce(async () => {
        claimed = true;
        return { matched: false, unfinished: false };
      })
      .mockResolvedValueOnce({ matched: true, unfinished: false });
    const handler = createBackgroundToolResultHandler({ req, updateToolCallResult });
    const baseState = {
      taskId: 'task-1',
      toolName: 'slow_tool',
      status: 'completed' as const,
      settledAt: new Date('2026-08-30T00:00:00Z'),
    };

    await expect(
      handler({
        toolName: 'slow_tool',
        toolCallId: 'call-1',
        stepId: 'step-1',
        messageId: 'message-1',
        conversationId: 'conversation-1',
        output: 'done',
        backgroundTask: baseState,
        resolveBackgroundTask: () => ({
          ...baseState,
          ...(claimed
            ? {
                resultClaim: {
                  kind: 'manual' as const,
                  claimId: 'poll-1',
                  claimedAt: new Date('2026-08-30T00:00:01Z'),
                },
              }
            : {}),
        }),
      }),
    ).resolves.toBe(true);

    expect(updateToolCallResult).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        backgroundTask: expect.objectContaining({
          resultClaim: expect.objectContaining({ kind: 'manual', claimId: 'poll-1' }),
        }),
      }),
    );
  });
});

describe('createBackgroundCodeResultHandler long dispatch turns', () => {
  const RETRY_SCHEDULE_MS = 1_000_000;
  const backgroundTask = {
    taskId: 'task-1',
    toolName: 'execute_code',
    status: 'completed' as const,
    settledAt: new Date('2026-09-24T00:00:00Z'),
    completionWakeup: true as const,
  };

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function createHandler(
    updateToolCallResult: jest.Mock,
    waitForGenerationSettled?: (conversationId: string) => Promise<boolean>,
  ) {
    return createBackgroundCodeResultHandler({
      req,
      preflightCodeOutputBatch: jest
        .fn()
        .mockResolvedValue([{ file: params.artifact.files[0], sessionId: 'storage-session' }]),
      processCodeOutput: jest.fn().mockResolvedValue({ file: { file_id: 'persisted-file' } }),
      updateToolCallResult,
      runPreviewFinalize: jest.fn(),
      ...(waitForGenerationSettled != null && { waitForGenerationSettled }),
    });
  }

  it('waits for a dispatch turn that outlives the retry schedule, then anchors', async () => {
    let turnRunning = true;
    const updateToolCallResult = jest.fn(async () => ({
      matched: true,
      unfinished: turnRunning,
    }));
    let settle: (settled: boolean) => void = () => undefined;
    const waitForGenerationSettled = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve;
        }),
    );
    const onFilesPersisted = jest.fn();
    const handler = createHandler(updateToolCallResult, waitForGenerationSettled);

    const result = handler({ ...params, backgroundTask, onFilesPersisted });
    await jest.advanceTimersByTimeAsync(RETRY_SCHEDULE_MS);

    expect(onFilesPersisted).toHaveBeenCalledWith([
      { file_id: 'persisted-file', stepId: 'step-1' },
    ]);
    expect(onFilesPersisted.mock.invocationCallOrder[0]).toBeLessThan(
      updateToolCallResult.mock.invocationCallOrder[0],
    );
    expect(waitForGenerationSettled).toHaveBeenCalledWith('conversation-1', {
      signal: expect.any(AbortSignal),
    });
    const attemptsWhileRunning = updateToolCallResult.mock.calls.length;
    await jest.advanceTimersByTimeAsync(60 * 60 * 1_000);
    expect(updateToolCallResult).toHaveBeenCalledTimes(attemptsWhileRunning);

    turnRunning = false;
    settle(true);
    await jest.advanceTimersByTimeAsync(0);

    await expect(result).resolves.toEqual({
      attachments: [{ file_id: 'persisted-file', stepId: 'step-1' }],
      deliveryReady: true,
    });
    expect(updateToolCallResult).toHaveBeenCalledTimes(attemptsWhileRunning + 1);
  });

  it('waits for a running turn that has not saved its row yet', async () => {
    let rowSaved = false;
    const updateToolCallResult = jest.fn(async () => ({ matched: rowSaved, unfinished: false }));
    const waitForGenerationSettled = jest.fn(async () => {
      rowSaved = true;
      return true;
    });
    const handler = createHandler(updateToolCallResult, waitForGenerationSettled);

    const result = handler({ ...params, backgroundTask });
    await jest.advanceTimersByTimeAsync(RETRY_SCHEDULE_MS);

    await expect(result).resolves.toEqual(expect.objectContaining({ deliveryReady: true }));
    expect(waitForGenerationSettled).toHaveBeenCalledTimes(1);
  });

  it('gives the result up when no generation is running and the row never appears', async () => {
    const updateToolCallResult = jest.fn(async () => ({ matched: false, unfinished: false }));
    const waitForGenerationSettled = jest.fn(async () => false);
    const handler = createHandler(updateToolCallResult, waitForGenerationSettled);

    const result = handler({ ...params, backgroundTask });
    await jest.advanceTimersByTimeAsync(RETRY_SCHEDULE_MS + 60_000);

    await expect(result).resolves.toEqual(expect.objectContaining({ deliveryReady: false }));
    expect(updateToolCallResult).toHaveBeenCalledTimes(14 + 5);
  });

  it('anchors a final save that lands well after the generation reads as settled', async () => {
    let settledAt: number | undefined;
    const updateToolCallResult = jest.fn(async () => ({
      matched: true,
      unfinished: settledAt == null || Date.now() - settledAt < 40_000,
    }));
    const waitForGenerationSettled = jest.fn(async () => {
      settledAt = Date.now();
      return true;
    });
    const handler = createHandler(updateToolCallResult, waitForGenerationSettled);

    const result = handler({ ...params, backgroundTask });
    await jest.advanceTimersByTimeAsync(RETRY_SCHEDULE_MS + 60_000);

    await expect(result).resolves.toEqual(expect.objectContaining({ deliveryReady: true }));
  });

  it('gives the result up when the turn ends without saving the tool call', async () => {
    const updateToolCallResult = jest.fn(async () => ({ matched: true, unfinished: true }));
    const waitForGenerationSettled = jest.fn(async () => true);
    const handler = createHandler(updateToolCallResult, waitForGenerationSettled);

    const result = handler({ ...params, backgroundTask });
    await jest.advanceTimersByTimeAsync(RETRY_SCHEDULE_MS + 60_000);

    await expect(result).resolves.toEqual(expect.objectContaining({ deliveryReady: false }));
    expect(waitForGenerationSettled).toHaveBeenCalledTimes(1);
  });

  it('anchors as soon as the dispatch turn settles instead of at the next scheduled retry', async () => {
    let turnRunning = true;
    const updateToolCallResult = jest.fn(async () => ({ matched: true, unfinished: turnRunning }));
    let settle: (settled: boolean) => void = () => undefined;
    const waitForGenerationSettled = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve;
        }),
    );
    const handler = createHandler(updateToolCallResult, waitForGenerationSettled);
    let finished = false;

    const result = handler({ ...params, backgroundTask }).then((value) => {
      finished = true;
      return value;
    });
    /** 45 s in, the schedule is inside a 30 s gap (next step near 69 s). */
    await jest.advanceTimersByTimeAsync(45_000);
    const attemptsBeforeSettle = updateToolCallResult.mock.calls.length;
    turnRunning = false;
    settle(true);
    await jest.advanceTimersByTimeAsync(0);

    expect(finished).toBe(true);
    await expect(result).resolves.toEqual(expect.objectContaining({ deliveryReady: true }));
    expect(updateToolCallResult).toHaveBeenCalledTimes(attemptsBeforeSettle + 1);
  });

  it.each([params.conversationId, 'another-conversation'])(
    'pins only the epoch owned by the host stream %s',
    async (generationStreamId) => {
      const wait = jest.fn(async () => true);
      const handler = createBackgroundCodeResultHandler({
        req,
        preflightCodeOutputBatch: async () => [],
        processCodeOutput: jest.fn(),
        runPreviewFinalize: jest.fn(),
        updateToolCallResult: async () => ({ matched: true, unfinished: false }),
        generationCreatedAt: 1234,
        generationStreamId,
        waitForGenerationSettled: wait,
      });
      await handler({ ...params, backgroundTask });
      expect(wait).toHaveBeenCalledWith(params.conversationId, {
        ...(generationStreamId === params.conversationId && { generationCreatedAt: 1234 }),
        signal: expect.any(AbortSignal),
      });
    },
  );

  it('stops listening for the turn once the result is anchored', async () => {
    const updateToolCallResult = jest.fn(async () => ({ matched: true, unfinished: false }));
    let signal: AbortSignal | undefined;
    const waitForGenerationSettled = jest.fn(
      (_conversationId: string, options?: { signal?: AbortSignal }) => {
        signal = options?.signal;
        return new Promise<boolean>(() => undefined);
      },
    );
    const handler = createHandler(updateToolCallResult, waitForGenerationSettled);

    await expect(handler({ ...params, backgroundTask })).resolves.toEqual(
      expect.objectContaining({ deliveryReady: true }),
    );
    expect(signal?.aborted).toBe(true);
  });

  it('keeps the bounded schedule when no settlement signal is wired', async () => {
    const updateToolCallResult = jest.fn(async () => ({ matched: true, unfinished: true }));
    const handler = createHandler(updateToolCallResult);

    const result = handler({ ...params, backgroundTask });
    await jest.advanceTimersByTimeAsync(RETRY_SCHEDULE_MS);

    await expect(result).resolves.toEqual(expect.objectContaining({ deliveryReady: false }));
    expect(updateToolCallResult).toHaveBeenCalledTimes(14);
  });
});
