jest.mock('~/server/services/Files/Code/process', () => ({
  processCodeOutput: jest.fn(),
  runPreviewFinalize: jest.fn(),
}));
jest.mock('~/server/services/Files/Code/preflight', () => ({
  preflightCodeOutputBatch: jest.fn(async ({ artifact }) =>
    (artifact.files ?? [])
      .filter((file) => file.inherited !== true)
      .map((file) => ({
        file,
        sessionId: file.storage_session_id ?? artifact.session_id,
      })),
  ),
}));
jest.mock('~/server/services/Files/Citations', () => ({ processFileCitations: jest.fn() }));
jest.mock('~/server/services/Files/process', () => ({ saveBase64Image: jest.fn() }));

const { processCodeOutput, runPreviewFinalize } = require('~/server/services/Files/Code/process');
const { preflightCodeOutputBatch } = require('~/server/services/Files/Code/preflight');
const { createBackgroundCodeResultHandler } = require('./callbacks');

const req = { user: { id: 'user-1' } };

const baseParams = {
  toolName: 'execute_code',
  toolCallId: 'call_code',
  messageId: 'msg-dispatch',
  conversationId: 'convo-1',
  agentId: 'agent_a',
  output: 'stdout:\nhello',
  artifact: {
    session_id: 'exec-sess',
    files: [
      { id: 'f1', name: 'plot.png', storage_session_id: 'store-1' },
      { id: 'f2', name: 'input.csv', inherited: true },
    ],
  },
};

describe('createBackgroundCodeResultHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('persists non-inherited files with the original identity and patches the message row', async () => {
    processCodeOutput.mockResolvedValue({
      file: { file_id: 'f1', filename: 'plot.png', toolCallId: 'call_code' },
      finalize: undefined,
    });
    const updateToolCallResult = jest.fn().mockResolvedValue({ matched: true, unfinished: false });
    const handler = createBackgroundCodeResultHandler({ req, updateToolCallResult });

    const result = await handler(baseParams);

    expect(processCodeOutput).toHaveBeenCalledTimes(1);
    expect(processCodeOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        req,
        id: 'f1',
        name: 'plot.png',
        messageId: 'msg-dispatch',
        toolCallId: 'call_code',
        conversationId: 'convo-1',
        agentId: 'agent_a',
        session_id: 'store-1',
        freshClaimAfter: expect.any(Number),
      }),
    );
    expect(updateToolCallResult).toHaveBeenCalledTimes(1);
    expect(updateToolCallResult).toHaveBeenCalledWith({
      userId: 'user-1',
      messageId: 'msg-dispatch',
      conversationId: 'convo-1',
      toolCallId: 'call_code',
      agentId: 'agent_a',
      output: 'stdout:\nhello',
      attachments: [{ file_id: 'f1', filename: 'plot.png', toolCallId: 'call_code' }],
      markBackgrounded: true,
    });
    expect(result).toEqual({
      attachments: [{ file_id: 'f1', filename: 'plot.png', toolCallId: 'call_code' }],
    });
  });

  it('anchors the stale-output guard to dispatch time when provided', async () => {
    processCodeOutput.mockResolvedValue({ file: { file_id: 'f1' } });
    const handler = createBackgroundCodeResultHandler({
      req,
      updateToolCallResult: jest.fn().mockResolvedValue({ matched: true, unfinished: false }),
    });

    await handler({ ...baseParams, dispatchedAt: 12345 });

    expect(processCodeOutput).toHaveBeenCalledWith(
      expect.objectContaining({ freshClaimAfter: 12345 }),
    );
  });

  it('runs deferred preview finalization without a live stream callback', async () => {
    const finalize = jest.fn();
    processCodeOutput.mockResolvedValue({
      file: { file_id: 'f1' },
      finalize,
      previewRevision: 3,
    });
    const handler = createBackgroundCodeResultHandler({
      req,
      updateToolCallResult: jest.fn().mockResolvedValue({ matched: true, unfinished: false }),
    });

    await handler(baseParams);

    expect(runPreviewFinalize).toHaveBeenCalledWith({ finalize, fileId: 'f1', previewRevision: 3 });
  });

  it('retries the row patch until the dispatch turn persists', async () => {
    jest.useFakeTimers();
    try {
      processCodeOutput.mockResolvedValue({ file: { file_id: 'f1' } });
      const updateToolCallResult = jest
        .fn()
        .mockResolvedValueOnce({ matched: false, unfinished: false })
        .mockResolvedValueOnce({ matched: false, unfinished: false })
        .mockResolvedValue({ matched: true, unfinished: false });
      const handler = createBackgroundCodeResultHandler({ req, updateToolCallResult });

      const promise = handler(baseParams);
      await jest.advanceTimersByTimeAsync(250);
      await jest.advanceTimersByTimeAsync(500);
      const result = await promise;

      expect(updateToolCallResult).toHaveBeenCalledTimes(3);
      expect(result?.attachments).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps re-applying past unfinished partial rows until a finalized row is patched', async () => {
    jest.useFakeTimers();
    try {
      processCodeOutput.mockResolvedValue({ file: { file_id: 'f1' } });
      /* A disconnect mid-turn persists an unfinished partial row; the later
       * finalize save overwrites it with the in-memory handle JSON, so a
       * patch that settled on the partial row must not stop the loop. */
      const updateToolCallResult = jest
        .fn()
        .mockResolvedValueOnce({ matched: true, unfinished: true })
        .mockResolvedValue({ matched: true, unfinished: false });
      const handler = createBackgroundCodeResultHandler({ req, updateToolCallResult });

      const promise = handler(baseParams);
      await jest.advanceTimersByTimeAsync(250);
      const result = await promise;

      expect(updateToolCallResult).toHaveBeenCalledTimes(2);
      expect(result?.attachments).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('still patches output when a file download fails (files are best-effort)', async () => {
    processCodeOutput.mockRejectedValue(new Error('download failed'));
    const updateToolCallResult = jest.fn().mockResolvedValue({ matched: true, unfinished: false });
    const handler = createBackgroundCodeResultHandler({ req, updateToolCallResult });

    const result = await handler(baseParams);

    expect(updateToolCallResult).toHaveBeenCalledWith(
      expect.objectContaining({
        output: 'stdout:\nhello',
        attachments: [],
        markBackgrounded: true,
      }),
    );
    expect(result).toEqual({ attachments: [] });
  });

  it('rejects a blocked generated-file batch before persistence or tool-result update', async () => {
    const blocked = new Error('Generated file content blocked');
    preflightCodeOutputBatch.mockRejectedValueOnce(blocked);
    const updateToolCallResult = jest.fn();
    const handler = createBackgroundCodeResultHandler({ req, updateToolCallResult });

    await expect(handler(baseParams)).rejects.toBe(blocked);

    expect(processCodeOutput).not.toHaveBeenCalled();
    expect(updateToolCallResult).not.toHaveBeenCalled();
  });

  it('reapply mode re-applies the row patch without reprocessing files', async () => {
    const updateToolCallResult = jest.fn().mockResolvedValue({ matched: true, unfinished: false });
    const handler = createBackgroundCodeResultHandler({ req, updateToolCallResult });

    const result = await handler({
      ...baseParams,
      artifact: undefined,
      attachments: [{ file_id: 'f1' }],
      reapply: true,
    });

    expect(processCodeOutput).not.toHaveBeenCalled();
    expect(updateToolCallResult).toHaveBeenCalledTimes(1);
    expect(updateToolCallResult).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'msg-dispatch',
        toolCallId: 'call_code',
        output: 'stdout:\nhello',
        attachments: [{ file_id: 'f1' }],
        /** The heal path must re-stamp the marker: the full-row save it
         *  repairs reverted the whole patched part, marker included. */
        markBackgrounded: true,
      }),
    );
    expect(result).toEqual({ attachments: [{ file_id: 'f1' }] });
  });

  it('returns null without identity to anchor to', async () => {
    const updateToolCallResult = jest.fn();
    const handler = createBackgroundCodeResultHandler({ req, updateToolCallResult });
    expect(await handler({ ...baseParams, messageId: undefined })).toBeNull();
    expect(updateToolCallResult).not.toHaveBeenCalled();
  });
});
