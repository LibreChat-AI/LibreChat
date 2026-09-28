const { Tools, StepEvents } = require('librechat-data-provider');

// Mock all dependencies before requiring the module
jest.mock('nanoid', () => ({
  nanoid: jest.fn(() => 'mock-id'),
}));

jest.mock('@librechat/api', () => ({
  sendEvent: jest.fn(),
  writeAttachmentEvent: jest.fn(),
  createOwnedToolEndHandler: jest.fn((callback) => ({ handle: callback })),
  GenerationJobManager: {
    emitChunk: jest.fn(),
  },
  HOST_FILE_AUTHORING_ARTIFACT_KEY: '__librechat_file_authoring',
  getToolInputValidationDetails: jest.fn((result, validationError) =>
    validationError != null
      ? {
          toolName: result.tool_call.name,
          reason: 'option_label_too_long',
          fieldPath: validationError.fieldPath,
        }
      : null,
  ),
  isCodeArtifactToolOutput: jest.requireActual('@librechat/api').isCodeArtifactToolOutput,
  isCodeSessionToolName: jest.requireActual('@librechat/api').isCodeSessionToolName,
  collectToolCallIds: jest.requireActual('@librechat/api').collectToolCallIds,
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  getMessageId: jest.fn(),
  ToolEndHandler: jest.fn(),
  handleToolCalls: jest.fn(),
}));

jest.mock('~/server/services/Files/Citations', () => ({
  processFileCitations: jest.fn(),
}));

jest.mock('~/server/services/Files/Code/process', () => ({
  processCodeOutput: jest.fn(),
  /* `runPreviewFinalize` is the runtime pairing for `finalize` (defined
   * alongside processCodeOutput in process.js). The callback wires
   * the deferred render through it; reproduce the basic happy-path here so the
   * SSE-emit assertions still work. The catch/defensive-updateFile
   * branch is unit-tested directly against the real helper in
   * process.spec.js — exercising it here would add test coupling
   * without coverage benefit. */
  runPreviewFinalize: ({ finalize, onResolved }) => {
    if (typeof finalize !== 'function') {
      return;
    }
    finalize()
      .then((updated) => {
        if (!updated || !onResolved) {
          return;
        }
        onResolved(updated);
      })
      .catch(() => {
        /* swallowed in the mock — see process.spec.js for catch coverage */
      });
  },
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

jest.mock('~/server/services/Tools/credentials', () => ({
  loadAuthValues: jest.fn(),
}));

jest.mock('~/server/services/Files/process', () => ({
  saveBase64Image: jest.fn(),
}));

describe('resumable event generation fencing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('forwards the originating job epoch with run-step events', async () => {
    const { GenerationJobManager } = require('@librechat/api');
    const { GraphEvents } = jest.requireActual('@librechat/agents');
    const { getDefaultHandlers } = require('../callbacks');
    const data = {
      id: 'step-1',
      index: 0,
      stepDetails: {
        type: 'tool_calls',
        tool_calls: [{ id: 'call-1', name: 'approval_probe', args: '{}' }],
      },
    };
    const handlers = getDefaultHandlers({
      res: { write: jest.fn() },
      aggregateContent: jest.fn(),
      toolEndCallback: jest.fn(),
      collectedUsage: [],
      streamId: 'conversation-1',
      jobCreatedAt: 1234,
    });

    await handlers[GraphEvents.ON_RUN_STEP].handle(GraphEvents.ON_RUN_STEP, data);

    expect(GenerationJobManager.emitChunk).toHaveBeenCalledWith(
      'conversation-1',
      { event: GraphEvents.ON_RUN_STEP, data },
      { expectedCreatedAt: 1234 },
    );
  });

  it('keeps a tool result and its input at full size in the content parts LibreChat persists', async () => {
    const { GraphEvents, createContentAggregator } = jest.requireActual('@librechat/agents');
    const { getDefaultHandlers } = require('../callbacks');
    /** Far beyond any cap the SDK's provider-only projection would apply. */
    const output = 'r'.repeat(600_000);
    const args = { query: 'q'.repeat(120_000) };
    const { contentParts, stepMap, aggregateContent } = createContentAggregator();
    const handlers = getDefaultHandlers({
      res: { write: jest.fn() },
      aggregateContent,
      contentParts,
      stepMap,
      toolEndCallback: jest.fn(),
      collectedUsage: [],
      streamId: 'conversation-1',
      jobCreatedAt: 1234,
    });
    const step = {
      id: 'step-full-size',
      index: 0,
      stepDetails: {
        type: 'tool_calls',
        tool_calls: [{ id: 'call-full-size', name: 'fetch', args: JSON.stringify(args) }],
      },
    };

    await handlers[GraphEvents.ON_RUN_STEP].handle(GraphEvents.ON_RUN_STEP, step);
    await handlers[GraphEvents.ON_RUN_STEP_COMPLETED].handle(GraphEvents.ON_RUN_STEP_COMPLETED, {
      result: {
        id: step.id,
        index: 0,
        tool_call: { id: 'call-full-size', name: 'fetch', args, output },
      },
    });

    expect(contentParts).toHaveLength(1);
    expect(contentParts[0].tool_call.output).toBe(output);
    expect(contentParts[0].tool_call.args).toEqual(args);
    expect(JSON.stringify(contentParts[0])).not.toContain('[truncated:');
  });

  it('publishes a hidden sequential agent snapshot without recording or forwarding it', async () => {
    const { GenerationJobManager } = require('@librechat/api');
    const { GraphEvents } = jest.requireActual('@librechat/agents');
    const { getDefaultHandlers } = require('../callbacks');
    const onSnapshot = jest.fn(async () => undefined);
    const contextUsageSink = { latest: null, count: 0, onSnapshot };
    const handlers = getDefaultHandlers({
      res: { write: jest.fn() },
      aggregateContent: jest.fn(),
      toolEndCallback: jest.fn(),
      collectedUsage: [],
      streamId: 'conversation-1',
      jobCreatedAt: 1234,
      contextUsageSink,
      usageEmitSink: [],
    });

    await handlers[GraphEvents.ON_CONTEXT_USAGE].handle(
      GraphEvents.ON_CONTEXT_USAGE,
      { contextBudget: 1000, remainingContextTokens: 400 },
      {
        hide_sequential_outputs: true,
        last_agent_id: 'agent-final',
        langgraph_node: 'agent-intermediate',
      },
    );

    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(contextUsageSink).toMatchObject({ latest: null, count: 0 });
    expect(GenerationJobManager.emitChunk).not.toHaveBeenCalled();
  });

  it('records a context snapshot and notifies the sink before forwarding it', async () => {
    const { GenerationJobManager } = require('@librechat/api');
    const { GraphEvents } = jest.requireActual('@librechat/agents');
    const { getDefaultHandlers } = require('../callbacks');
    let releaseSnapshot;
    const onSnapshot = jest.fn(
      () =>
        new Promise((resolve) => {
          releaseSnapshot = resolve;
        }),
    );
    const contextUsageSink = { latest: null, count: 0, onSnapshot };
    const usageEmitSink = [{ input_tokens: 10 }];
    /** The call this snapshot already accounts for: a later tool-limit stop counts
     *  the results of the calls missing from this set. */
    const contentParts = [
      { type: 'text', text: 'answering' },
      { type: 'tool_call', tool_call: { id: 'call_1', name: 'grep' } },
    ];
    const data = { contextBudget: 1000, remainingContextTokens: 400 };
    const handlers = getDefaultHandlers({
      res: { write: jest.fn() },
      aggregateContent: jest.fn(),
      contentParts,
      toolEndCallback: jest.fn(),
      collectedUsage: [],
      streamId: 'conversation-1',
      jobCreatedAt: 1234,
      contextUsageSink,
      usageEmitSink,
    });

    let settled = false;
    const handled = handlers[GraphEvents.ON_CONTEXT_USAGE]
      .handle(GraphEvents.ON_CONTEXT_USAGE, data, { hide_sequential_outputs: false })
      .then(() => {
        settled = true;
      });
    await Promise.resolve();

    expect(contextUsageSink).toMatchObject({
      latest: data,
      count: 1,
      latestUsageIndex: 1,
      latestToolCallIds: new Set(['call_1']),
    });
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    releaseSnapshot();
    await handled;
    expect(settled).toBe(true);
    expect(GenerationJobManager.emitChunk).toHaveBeenCalledWith(
      'conversation-1',
      { event: GraphEvents.ON_CONTEXT_USAGE, data },
      { expectedCreatedAt: 1234 },
    );
  });

  it('resolves MCP identity from a function-shaped root tool call', async () => {
    const { GraphEvents } = jest.requireActual('@librechat/agents');
    const { getDefaultHandlers } = require('../callbacks');
    const resolveMcpServerName = jest.fn(() => 'server');
    const data = {
      id: 'step-function-tool',
      index: 0,
      stepDetails: {
        type: 'tool_calls',
        tool_calls: [
          {
            id: 'call-function-tool',
            function: { name: 'lookup_mcp_server', arguments: '{}' },
          },
        ],
      },
    };
    const handlers = getDefaultHandlers({
      res: { write: jest.fn() },
      aggregateContent: jest.fn(),
      toolEndCallback: jest.fn(),
      collectedUsage: [],
      resolveMcpServerName,
    });

    await handlers[GraphEvents.ON_RUN_STEP].handle(GraphEvents.ON_RUN_STEP, data, {
      agent_id: 'lazy-agent',
    });

    expect(resolveMcpServerName).toHaveBeenCalledWith('lookup_mcp_server', 'lazy-agent');
    expect(data.stepDetails.tool_calls[0]).toEqual(
      expect.objectContaining({ name: 'lookup_mcp_server', mcpServerName: 'server' }),
    );
  });

  it('publishes root event-child progress through the child activity transport', async () => {
    const { nanoid } = require('nanoid');
    nanoid.mockReturnValueOnce('invocation-1').mockReturnValueOnce('invocation-2');
    const { GraphEvents } = jest.requireActual('@librechat/agents');
    const { getDefaultHandlers } = require('../callbacks');
    const publish = jest.fn().mockResolvedValue(undefined);
    const data = {
      id: 'step-1',
      index: 0,
      stepDetails: { type: 'message_creation' },
    };
    const handlers = getDefaultHandlers({
      res: { write: jest.fn() },
      aggregateContent: jest.fn(),
      toolEndCallback: jest.fn(),
      collectedUsage: [],
      streamId: 'event-thread',
      jobCreatedAt: 1234,
      eventChildActivity: {
        runId: 'event-thread',
        parentRunId: 'parent-conversation',
        subagentRunId: 'delivery-1',
        subagentType: 'agent-1',
        subagentAgentId: 'agent-1',
        parentAgentId: 'director',
        publish,
      },
    });

    await handlers[GraphEvents.ON_RUN_STEP].handle(GraphEvents.ON_RUN_STEP, data);
    await Promise.resolve();
    await Promise.resolve();

    const firstUpdate = publish.mock.calls[0][0];
    expect(firstUpdate).toEqual(
      expect.objectContaining({
        runId: 'event-thread',
        parentRunId: 'parent-conversation',
        subagentRunId: 'delivery-1',
        phase: 'run_step',
        activityEventId: expect.stringMatching(/^delivery-1:.+:0$/),
        data,
      }),
    );
    expect(firstUpdate).not.toHaveProperty('activitySequence');

    const resumedPublish = jest.fn().mockResolvedValue(undefined);
    const resumedHandlers = getDefaultHandlers({
      res: { write: jest.fn() },
      aggregateContent: jest.fn(),
      toolEndCallback: jest.fn(),
      collectedUsage: [],
      streamId: 'event-thread',
      jobCreatedAt: 1234,
      eventChildActivity: {
        runId: 'event-thread',
        parentRunId: 'parent-conversation',
        subagentRunId: 'delivery-1',
        subagentType: 'agent-1',
        subagentAgentId: 'agent-1',
        parentAgentId: 'director',
        publish: resumedPublish,
      },
    });
    await resumedHandlers[GraphEvents.ON_RUN_STEP].handle(GraphEvents.ON_RUN_STEP, data);
    await Promise.resolve();
    await Promise.resolve();
    expect(resumedPublish.mock.calls[0][0].activityEventId).not.toBe(firstUpdate.activityEventId);
  });

  it('forwards the originating job epoch with deferred attachments', () => {
    const { GenerationJobManager } = require('@librechat/api');
    const { createAttachmentEmitter } = require('../callbacks');
    const attachment = { file_id: 'file-1', status: 'ready' };
    const emitAttachment = createAttachmentEmitter({
      res: { write: jest.fn() },
      streamId: 'conversation-1',
      jobCreatedAt: 1234,
    });

    emitAttachment(attachment);

    expect(GenerationJobManager.emitChunk).toHaveBeenCalledWith(
      'conversation-1',
      { event: 'attachment', data: attachment },
      { expectedCreatedAt: 1234 },
    );
  });
});

describe('createPtcProgressEmitter', () => {
  const ptcEvent = {
    tool_call_id: 'call_ptc',
    call_id: 'call_ptc:0',
    name: 'read_file',
    status: 'running',
    args: 'path=a.ts',
  };

  beforeEach(() => jest.clearAllMocks());

  it('emits the inner tool-call event on the resumable job stream', () => {
    const { GenerationJobManager } = require('@librechat/api');
    const { createPtcProgressEmitter } = require('../callbacks');
    const emit = createPtcProgressEmitter({
      res: { write: jest.fn() },
      streamId: 'conversation-1',
      jobCreatedAt: 1234,
    });

    emit(ptcEvent);

    expect(GenerationJobManager.emitChunk).toHaveBeenCalledWith(
      'conversation-1',
      { event: StepEvents.ON_PTC_TOOL_CALL, data: ptcEvent },
      { expectedCreatedAt: 1234 },
    );
  });

  it('writes to the live response when no stream id is in play', () => {
    const { sendEvent } = require('@librechat/api');
    const { createPtcProgressEmitter } = require('../callbacks');
    const res = { write: jest.fn(), headersSent: true, writableEnded: false };
    const emit = createPtcProgressEmitter({ res });

    emit(ptcEvent);

    expect(sendEvent).toHaveBeenCalledWith(res, {
      event: StepEvents.ON_PTC_TOOL_CALL,
      data: ptcEvent,
    });
  });

  it('absorbs a rejected resumable emit instead of leaving an unhandled rejection', async () => {
    const { GenerationJobManager } = require('@librechat/api');
    const { createPtcProgressEmitter } = require('../callbacks');
    GenerationJobManager.emitChunk.mockRejectedValueOnce(new Error('transport down'));
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);

    const emit = createPtcProgressEmitter({
      res: { write: jest.fn() },
      streamId: 'conversation-1',
      jobCreatedAt: 1234,
    });

    expect(() => emit(ptcEvent)).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    process.off('unhandledRejection', unhandled);

    expect(unhandled).not.toHaveBeenCalled();
  });

  it('drops the event once the response has closed', () => {
    const { sendEvent } = require('@librechat/api');
    const { createPtcProgressEmitter } = require('../callbacks');
    const emit = createPtcProgressEmitter({
      res: { write: jest.fn(), headersSent: true, writableEnded: true },
    });

    emit(ptcEvent);

    expect(sendEvent).not.toHaveBeenCalled();
  });
});

describe('createToolEndCallback', () => {
  let req, res, artifactPromises, createToolEndCallback;
  let logger;

  beforeEach(() => {
    jest.clearAllMocks();

    // Get the mocked logger
    logger = require('@librechat/data-schemas').logger;

    // Now require the module after all mocks are set up
    const callbacks = require('../callbacks');
    createToolEndCallback = callbacks.createToolEndCallback;

    req = {
      user: { id: 'user123' },
    };
    res = {
      headersSent: false,
      write: jest.fn(),
    };
    artifactPromises = [];
  });

  it('preserves separate owners for final search artifacts with repeated tool-call IDs', async () => {
    const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });
    for (const agentId of ['agent-a', 'agent-b']) {
      await toolEndCallback(
        {
          output: {
            tool_call_id: 'call_0',
            artifact: {
              [Tools.web_search]: {
                turn: 0,
                organic: [{ link: `https://example.com/${agentId}` }],
              },
            },
          },
        },
        { run_id: 'run456', thread_id: 'thread789', agent_id: agentId },
      );
    }
    const results = await Promise.all(artifactPromises);
    expect(
      results.map((attachment) => ({
        owner: attachment.agentId,
        link: attachment[Tools.web_search].organic[0].link,
      })),
    ).toEqual([
      { owner: 'agent-a', link: 'https://example.com/agent-a' },
      { owner: 'agent-b', link: 'https://example.com/agent-b' },
    ]);
  });

  it.each(['createToolEndCallback', 'createResponsesToolEndCallback'])(
    '%s preserves memory payloads and their execution owner',
    async (factoryName) => {
      const toolEndCallback = require('../callbacks')[factoryName]({ req, res, artifactPromises });
      await toolEndCallback(
        {
          output: {
            tool_call_id: 'call_0',
            artifact: {
              [Tools.memory]: {
                key: 'project',
                type: 'update',
                value: 'owned',
              },
            },
          },
        },
        {
          run_id: 'run456',
          thread_id: 'thread789',
          agent_id: 'outer-agent',
          executingAgentId: 'agent-a',
          stepId: 'step-memory-1',
        },
      );

      const [attachment] = await Promise.all(artifactPromises);
      expect(attachment).toMatchObject({
        type: Tools.memory,
        toolCallId: 'call_0',
        agentId: 'agent-a',
        stepId: 'step-memory-1',
        [Tools.memory]: { key: 'project', type: 'update', value: 'owned' },
      });
    },
  );

  describe('ui_resources artifact handling', () => {
    it('should process ui_resources artifact and return attachment when headers not sent', async () => {
      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });

      const output = {
        tool_call_id: 'tool123',
        artifact: {
          [Tools.ui_resources]: {
            data: [
              { type: 'button', label: 'Click me' },
              { type: 'input', placeholder: 'Enter text' },
            ],
          },
        },
      };

      const metadata = {
        run_id: 'run456',
        thread_id: 'thread789',
      };

      await toolEndCallback({ output }, metadata);

      // Wait for all promises to resolve
      const results = await Promise.all(artifactPromises);

      // When headers are not sent, it returns attachment without writing
      expect(res.write).not.toHaveBeenCalled();

      const attachment = results[0];
      expect(attachment).toEqual({
        type: Tools.ui_resources,
        messageId: 'run456',
        toolCallId: 'tool123',
        conversationId: 'thread789',
        [Tools.ui_resources]: [
          { type: 'button', label: 'Click me' },
          { type: 'input', placeholder: 'Enter text' },
        ],
      });
    });

    it('should write to response when headers are already sent', async () => {
      res.headersSent = true;
      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });

      const output = {
        tool_call_id: 'tool123',
        artifact: {
          [Tools.ui_resources]: {
            data: [{ type: 'carousel', items: [] }],
          },
        },
      };

      const metadata = {
        run_id: 'run456',
        thread_id: 'thread789',
      };

      await toolEndCallback({ output }, metadata);
      const results = await Promise.all(artifactPromises);

      expect(res.write).toHaveBeenCalled();
      expect(results[0]).toEqual({
        type: Tools.ui_resources,
        messageId: 'run456',
        toolCallId: 'tool123',
        conversationId: 'thread789',
        [Tools.ui_resources]: [{ type: 'carousel', items: [] }],
      });
    });

    it('should handle errors when processing ui_resources', async () => {
      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });

      // Mock res.write to throw an error
      res.headersSent = true;
      res.write.mockImplementation(() => {
        throw new Error('Write failed');
      });

      const output = {
        tool_call_id: 'tool123',
        artifact: {
          [Tools.ui_resources]: {
            data: [{ type: 'test' }],
          },
        },
      };

      const metadata = {
        run_id: 'run456',
        thread_id: 'thread789',
      };

      await toolEndCallback({ output }, metadata);
      const results = await Promise.all(artifactPromises);

      expect(logger.error).toHaveBeenCalledWith(
        'Error processing artifact content:',
        expect.any(Error),
      );
      expect(results[0]).toBeNull();
    });

    it('should handle multiple artifacts including ui_resources', async () => {
      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });

      const output = {
        tool_call_id: 'tool123',
        artifact: {
          [Tools.ui_resources]: {
            data: [{ type: 'chart', data: [] }],
          },
          [Tools.web_search]: {
            results: ['result1', 'result2'],
          },
        },
      };

      const metadata = {
        run_id: 'run456',
        thread_id: 'thread789',
      };

      await toolEndCallback({ output }, metadata);
      const results = await Promise.all(artifactPromises);

      // Both ui_resources and web_search should be processed
      expect(artifactPromises).toHaveLength(2);
      expect(results).toHaveLength(2);

      // Check ui_resources attachment
      const uiResourceAttachment = results.find((r) => r?.type === Tools.ui_resources);
      expect(uiResourceAttachment).toBeTruthy();
      expect(uiResourceAttachment[Tools.ui_resources]).toEqual([{ type: 'chart', data: [] }]);

      // Check web_search attachment
      const webSearchAttachment = results.find((r) => r?.type === Tools.web_search);
      expect(webSearchAttachment).toBeTruthy();
      expect(webSearchAttachment[Tools.web_search]).toEqual({
        results: ['result1', 'result2'],
      });
    });

    it('should not process artifacts when output has no artifacts', async () => {
      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });

      const output = {
        tool_call_id: 'tool123',
        content: 'Some regular content',
        // No artifact property
      };

      const metadata = {
        run_id: 'run456',
        thread_id: 'thread789',
      };

      await toolEndCallback({ output }, metadata);

      expect(artifactPromises).toHaveLength(0);
      expect(res.write).not.toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    it('should handle empty ui_resources data object', async () => {
      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });

      const output = {
        tool_call_id: 'tool123',
        artifact: {
          [Tools.ui_resources]: {
            data: [],
          },
        },
      };

      const metadata = {
        run_id: 'run456',
        thread_id: 'thread789',
      };

      await toolEndCallback({ output }, metadata);
      const results = await Promise.all(artifactPromises);

      expect(results[0]).toEqual({
        type: Tools.ui_resources,
        messageId: 'run456',
        toolCallId: 'tool123',
        conversationId: 'thread789',
        [Tools.ui_resources]: [],
      });
    });

    it('should handle ui_resources with complex nested data', async () => {
      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });

      const complexData = {
        0: {
          type: 'form',
          fields: [
            { name: 'field1', type: 'text', required: true },
            { name: 'field2', type: 'select', options: ['a', 'b', 'c'] },
          ],
          nested: {
            deep: {
              value: 123,
              array: [1, 2, 3],
            },
          },
        },
      };

      const output = {
        tool_call_id: 'tool123',
        artifact: {
          [Tools.ui_resources]: {
            data: complexData,
          },
        },
      };

      const metadata = {
        run_id: 'run456',
        thread_id: 'thread789',
      };

      await toolEndCallback({ output }, metadata);
      const results = await Promise.all(artifactPromises);

      expect(results[0][Tools.ui_resources]).toEqual(complexData);
    });

    it('should handle when output is undefined', async () => {
      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });

      const metadata = {
        run_id: 'run456',
        thread_id: 'thread789',
      };

      await toolEndCallback({ output: undefined }, metadata);

      expect(artifactPromises).toHaveLength(0);
      expect(res.write).not.toHaveBeenCalled();
    });

    it('should handle when data parameter is undefined', async () => {
      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });

      const metadata = {
        run_id: 'run456',
        thread_id: 'thread789',
      };

      await toolEndCallback(undefined, metadata);

      expect(artifactPromises).toHaveLength(0);
      expect(res.write).not.toHaveBeenCalled();
    });
  });

  describe('code execution deferred-preview emit', () => {
    /* The deferred-preview code-execution flow emits the attachment twice over
     * SSE: the initial emit with `status: 'pending'` and the current run's
     * messageId, the deferred render with the resolved record. The preview update emit
     * must use the CURRENT run's messageId (not the persisted DB one)
     * because `processCodeOutput` intentionally preserves the original
     * `messageId` on cross-turn filename reuse — `getCodeGeneratedFiles`
     * needs that for prior-turn priming.
     *
     * Codex P1 review on PR #12957: shipping `updated.messageId`
     * straight from the DB record routed preview-update patches to the wrong
     * message slot, leaving the current turn's pending chip stuck. */

    const { processCodeOutput } = require('~/server/services/Files/Code/process');
    const { preflightCodeOutputBatch } = require('~/server/services/Files/Code/preflight');

    function makeCodeExecutionEvent({
      runId,
      threadId,
      toolCallId,
      fileId,
      name,
      toolName = 'execute_code',
      hostFileAuthoring = false,
      created,
      codeExecutionContext,
    }) {
      return {
        output: {
          name: toolName,
          tool_call_id: toolCallId,
          artifact: {
            ...(hostFileAuthoring ? { __librechat_file_authoring: true } : {}),
            ...(created === undefined ? {} : { created }),
            path: name,
            session_id: 'sess-1',
            files: [{ id: fileId, name, session_id: 'sess-1' }],
          },
        },
        metadata: { run_id: runId, thread_id: threadId, codeExecutionContext },
      };
    }

    /** Parse the SSE frame `res.write` produces back to a payload object. */
    function parseSseAttachment(call) {
      const frame = call[0];
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
      return JSON.parse(dataLine.slice('data: '.length));
    }

    it('the preview update emit uses the current run messageId, not the persisted DB messageId (cross-turn filename reuse)', async () => {
      /* Simulate turn-2 reusing `output.csv` from turn-1. The DB record
       * surfaced by `updateFile` carries the original `turn-1-msg`
       * messageId; the runtime emit must rewrite to `turn-2-msg`. */
      res.headersSent = true;
      const finalize = jest.fn().mockResolvedValue({
        file_id: 'fid-shared',
        filename: 'output.csv',
        filepath: '/uploads/output.csv',
        type: 'text/csv',
        conversationId: 'thread789',
        messageId: 'turn-1-original-msg', // persisted DB id (older turn)
        status: 'ready',
        text: '<table></table>',
        textFormat: 'html',
      });
      processCodeOutput.mockResolvedValue({
        file: {
          file_id: 'fid-shared',
          filename: 'output.csv',
          filepath: '/uploads/output.csv',
          type: 'text/csv',
          conversationId: 'thread789',
          messageId: 'turn-2-current-run', // runtime overlay (current turn)
          toolCallId: 'tool-2',
          status: 'pending',
          text: null,
          textFormat: null,
        },
        finalize,
      });

      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });
      const event = makeCodeExecutionEvent({
        runId: 'turn-2-current-run',
        threadId: 'thread789',
        toolCallId: 'tool-2',
        fileId: 'fid-shared',
        name: 'output.csv',
      });
      await toolEndCallback({ output: event.output }, event.metadata);
      await Promise.all(artifactPromises);
      // Wait one more tick so the fire-and-forget finalize() chain settles.
      await new Promise((resolve) => setImmediate(resolve));

      // Two SSE writes: the initial emit (pending) and the deferred render (ready).
      expect(res.write).toHaveBeenCalledTimes(2);
      const phase1 = parseSseAttachment(res.write.mock.calls[0]);
      const phase2 = parseSseAttachment(res.write.mock.calls[1]);

      // Initial emit already used the runtime messageId (sourced from result.file).
      expect(phase1.messageId).toBe('turn-2-current-run');
      expect(phase1.status).toBe('pending');

      /* The preview update MUST also route to the current run's messageId so the
       * frontend's `useAttachmentHandler` upserts under the same
       * messageAttachmentsMap slot as the initial emit. Routing to
       * `turn-1-original-msg` would land the patch on a stale message
       * and leave turn-2's pending chip stuck. */
      expect(phase2.messageId).toBe('turn-2-current-run');
      expect(phase2.file_id).toBe('fid-shared');
      expect(phase2.status).toBe('ready');
      expect(phase2.text).toBe('<table></table>');
      expect(phase2.toolCallId).toBe('tool-2');
      /* Wire-shape parity with the initial emit: preview update emits the full updated
       * record so the client doesn't see one shape on the initial emit and a
       * narrower projection on the deferred render. (Codex audit on PR #12957
       * Finding 1.) */
      expect(phase2.filename).toBe('output.csv');
      expect(phase2.filepath).toBe('/uploads/output.csv');
      expect(phase2.type).toBe('text/csv');
      expect(phase2.conversationId).toBe('thread789');
      expect(phase2.textFormat).toBe('html');
    });

    it('the preview update emit is skipped when finalize resolves to null (no DB update happened)', async () => {
      res.headersSent = true;
      processCodeOutput.mockResolvedValue({
        file: {
          file_id: 'fid-1',
          filename: 'data.xlsx',
          filepath: '/uploads/data.xlsx',
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          messageId: 'run-1',
          toolCallId: 'tool-1',
          status: 'pending',
        },
        finalize: jest.fn().mockResolvedValue(null),
      });

      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });
      const event = makeCodeExecutionEvent({
        runId: 'run-1',
        threadId: 'thread-1',
        toolCallId: 'tool-1',
        fileId: 'fid-1',
        name: 'data.xlsx',
      });
      await toolEndCallback({ output: event.output }, event.metadata);
      await Promise.all(artifactPromises);
      await new Promise((resolve) => setImmediate(resolve));

      // Only the initial emit fired; preview update noop'd because finalize returned null.
      expect(res.write).toHaveBeenCalledTimes(1);
    });

    it('the preview update emit is skipped when the response stream has already closed', async () => {
      res.headersSent = true;
      /* Hand-rolled deferred so we can hold finalize() open until
       * AFTER setting `res.writableEnded = true`. Otherwise the mock
       * resolves synchronously, the .then() runs in the same microtask
       * queue as the artifactPromises await, and writableEnded is set
       * too late. */
      let resolveFinalize;
      const finalizeDeferred = new Promise((resolve) => {
        resolveFinalize = resolve;
      });
      processCodeOutput.mockResolvedValue({
        file: {
          file_id: 'fid-1',
          filename: 'data.xlsx',
          filepath: '/uploads/data.xlsx',
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          messageId: 'run-1',
          toolCallId: 'tool-1',
          status: 'pending',
        },
        finalize: jest.fn().mockReturnValue(finalizeDeferred),
      });

      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });
      const event = makeCodeExecutionEvent({
        runId: 'run-1',
        threadId: 'thread-1',
        toolCallId: 'tool-1',
        fileId: 'fid-1',
        name: 'data.xlsx',
      });
      await toolEndCallback({ output: event.output }, event.metadata);
      await Promise.all(artifactPromises);
      // Simulate the response closing AFTER the initial emit fires but BEFORE
      // the deferred render lands. The frontend's polling path will catch the
      // resolved record on its next tick.
      res.writableEnded = true;
      // Now resolve finalize and let the .then() chain run.
      resolveFinalize({
        file_id: 'fid-1',
        filename: 'data.xlsx',
        messageId: 'run-1',
        status: 'ready',
        text: '<x/>',
        textFormat: 'html',
      });
      await new Promise((resolve) => setImmediate(resolve));

      // Initial emit wrote; preview update noop'd because writableEnded.
      expect(res.write).toHaveBeenCalledTimes(1);
    });

    it('does not call finalize for a non-office file (no preview expected)', async () => {
      res.headersSent = true;
      processCodeOutput.mockResolvedValue({
        file: {
          file_id: 'fid-txt',
          filename: 'note.txt',
          filepath: '/uploads/note.txt',
          type: 'text/plain',
          messageId: 'run-1',
          toolCallId: 'tool-1',
          // No status — non-office files skip the deferred render entirely.
        },
        // No finalize key — caller should not call anything.
      });

      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });
      const event = makeCodeExecutionEvent({
        runId: 'run-1',
        threadId: 'thread-1',
        toolCallId: 'tool-1',
        fileId: 'fid-txt',
        name: 'note.txt',
      });
      await toolEndCallback({ output: event.output }, event.metadata);
      await Promise.all(artifactPromises);
      await new Promise((resolve) => setImmediate(resolve));

      expect(res.write).toHaveBeenCalledTimes(1);
    });

    it('processes create_file sandbox artifacts like code execution outputs', async () => {
      res.headersSent = true;
      processCodeOutput.mockResolvedValue({
        file: {
          file_id: 'fid-created',
          filename: 'created.txt',
          filepath: '/uploads/created.txt',
          type: 'text/plain',
          conversationId: 'thread789',
          messageId: 'run-create',
          toolCallId: 'tool-create',
          status: 'pending',
        },
        finalize: jest.fn().mockResolvedValue({
          file_id: 'fid-created',
          filename: 'created.txt',
          filepath: '/uploads/created.txt',
          type: 'text/plain',
          conversationId: 'thread789',
          messageId: 'run-create',
          status: 'ready',
        }),
      });

      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });
      const event = makeCodeExecutionEvent({
        runId: 'run-create',
        threadId: 'thread789',
        toolCallId: 'tool-create',
        fileId: 'fid-created',
        name: 'created.txt',
        toolName: 'create_file',
        hostFileAuthoring: true,
        created: true,
        codeExecutionContext: {
          baseUrl: 'https://code-stateful.example.com',
          executionProfile: 'stateful',
          executionRouteKey: `stateful:${'a'.repeat(32)}`,
        },
      });
      await toolEndCallback({ output: event.output }, event.metadata);
      await Promise.all(artifactPromises);
      await new Promise((resolve) => setImmediate(resolve));

      expect(processCodeOutput).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'fid-created',
          name: 'created.txt',
          messageId: 'run-create',
          toolCallId: 'tool-create',
          conversationId: 'thread789',
          codeApiBaseUrl: 'https://code-stateful.example.com',
          executionProfile: 'stateful',
          executionRouteKey: `stateful:${'a'.repeat(32)}`,
        }),
      );
      expect(res.write).toHaveBeenCalledTimes(2);
      expect(parseSseAttachment(res.write.mock.calls[0]).workspaceChange).toEqual({
        profile: 'stateful',
        operation: 'created',
        path: 'created.txt',
      });
      expect(parseSseAttachment(res.write.mock.calls[1]).workspaceChange).toEqual({
        profile: 'stateful',
        operation: 'created',
        path: 'created.txt',
      });
      await expect(artifactPromises[0]).resolves.toEqual(
        expect.objectContaining({
          workspaceChange: {
            profile: 'stateful',
            operation: 'created',
            path: 'created.txt',
          },
        }),
      );
    });

    it('does not mark stateless file authoring outputs as stateful workspace changes', async () => {
      res.headersSent = true;
      processCodeOutput.mockResolvedValue({
        file: {
          file_id: 'fid-default',
          filename: 'default.txt',
          filepath: '/uploads/default.txt',
          type: 'text/plain',
          conversationId: 'thread789',
          messageId: 'run-default',
          toolCallId: 'tool-default',
          status: 'ready',
        },
      });

      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });
      const event = makeCodeExecutionEvent({
        runId: 'run-default',
        threadId: 'thread789',
        toolCallId: 'tool-default',
        fileId: 'fid-default',
        name: 'default.txt',
        toolName: 'create_file',
        hostFileAuthoring: true,
        created: true,
        codeExecutionContext: {
          baseUrl: 'https://code-default.example.com',
          executionProfile: 'default',
        },
      });
      await toolEndCallback({ output: event.output }, event.metadata);
      await Promise.all(artifactPromises);

      expect(res.write).toHaveBeenCalledTimes(1);
      expect(parseSseAttachment(res.write.mock.calls[0]).workspaceChange).toBeUndefined();
    });

    it('preserves stateful workspace changes in Open Responses attachment events', async () => {
      const { writeAttachmentEvent } = require('@librechat/api');
      const { createResponsesToolEndCallback } = require('../callbacks');
      res.headersSent = true;
      res.writableEnded = false;
      processCodeOutput.mockResolvedValue({
        file: {
          file_id: 'fid-responses',
          filename: 'summary.csv',
          filepath: '/uploads/summary.csv',
          type: 'text/csv',
          conversationId: 'thread789',
          messageId: 'run-responses',
          toolCallId: 'tool-responses',
          status: 'pending',
        },
        finalize: jest.fn().mockResolvedValue({
          file_id: 'fid-responses',
          filename: 'summary.csv',
          filepath: '/uploads/summary.csv',
          type: 'text/csv',
          conversationId: 'thread789',
          messageId: 'run-responses',
          status: 'ready',
        }),
      });

      const tracker = { nextSequence: jest.fn().mockReturnValueOnce(1).mockReturnValueOnce(2) };
      const toolEndCallback = createResponsesToolEndCallback({
        req,
        res,
        tracker,
        artifactPromises,
      });
      const event = makeCodeExecutionEvent({
        runId: 'run-responses',
        threadId: 'thread789',
        toolCallId: 'tool-responses',
        fileId: 'fid-responses',
        name: 'summary.csv',
        toolName: 'edit_file',
        hostFileAuthoring: true,
        created: false,
        codeExecutionContext: {
          baseUrl: 'https://code-stateful.example.com',
          executionProfile: 'stateful',
        },
      });
      event.output.artifact.path = 'reports/summary.csv';

      await toolEndCallback({ output: event.output }, event.metadata);
      await Promise.all(artifactPromises);
      await new Promise((resolve) => setImmediate(resolve));

      expect(writeAttachmentEvent).toHaveBeenCalledTimes(2);
      expect(writeAttachmentEvent.mock.calls[0][2].workspaceChange).toEqual({
        profile: 'stateful',
        operation: 'updated',
        path: 'reports/summary.csv',
      });
      expect(writeAttachmentEvent.mock.calls[1][2].workspaceChange).toEqual({
        profile: 'stateful',
        operation: 'updated',
        path: 'reports/summary.csv',
      });
      await expect(artifactPromises[0]).resolves.toEqual(
        expect.objectContaining({
          workspaceChange: {
            profile: 'stateful',
            operation: 'updated',
            path: 'reports/summary.csv',
          },
        }),
      );
    });

    it('does not process arbitrary user tool artifacts named create_file as code outputs', async () => {
      res.headersSent = true;
      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });
      const event = makeCodeExecutionEvent({
        runId: 'run-user-create',
        threadId: 'thread789',
        toolCallId: 'tool-user-create',
        fileId: 'fid-user-created',
        name: 'created.txt',
        toolName: 'create_file',
      });

      await toolEndCallback({ output: event.output }, event.metadata);
      await Promise.all(artifactPromises);

      expect(processCodeOutput).not.toHaveBeenCalled();
      expect(res.write).not.toHaveBeenCalled();
    });

    it('rejects blocked generated bytes before queuing any persistence', async () => {
      const blocked = new Error('Generated file content blocked');
      preflightCodeOutputBatch.mockRejectedValueOnce(blocked);
      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });
      const event = makeCodeExecutionEvent({
        runId: 'run-blocked',
        threadId: 'thread-1',
        toolCallId: 'tool-blocked',
        fileId: 'fid-blocked',
        name: 'blocked.txt',
      });

      await expect(toolEndCallback({ output: event.output }, event.metadata)).rejects.toBe(blocked);

      expect(processCodeOutput).not.toHaveBeenCalled();
      expect(artifactPromises).toHaveLength(0);
      expect(res.write).not.toHaveBeenCalled();
    });

    it('rejects blocked generated bytes in the Responses callback before persistence', async () => {
      const blocked = new Error('Generated file content blocked');
      preflightCodeOutputBatch.mockRejectedValueOnce(blocked);
      const { createResponsesToolEndCallback } = require('../callbacks');
      const callback = createResponsesToolEndCallback({
        req,
        res,
        tracker: { nextSequence: jest.fn(() => 1) },
        artifactPromises,
      });
      const event = makeCodeExecutionEvent({
        runId: 'run-responses-blocked',
        threadId: 'thread-1',
        toolCallId: 'tool-responses-blocked',
        fileId: 'fid-responses-blocked',
        name: 'blocked.txt',
      });

      await expect(callback({ output: event.output }, event.metadata)).rejects.toBe(blocked);

      expect(processCodeOutput).not.toHaveBeenCalled();
      expect(artifactPromises).toHaveLength(0);
      expect(res.write).not.toHaveBeenCalled();
    });
  });
});

describe('tool input validation marker', () => {
  it('marks the streamed result and persisted content part out of band', async () => {
    const { GraphEvents, createContentAggregator } = jest.requireActual('@librechat/agents');
    const { getDefaultHandlers } = require('../callbacks');
    const { contentParts, aggregateContent, stepMap } = createContentAggregator();
    const toolInputValidationErrors = new Map([
      ['tool-1', { fieldPath: 'options[0].label', isLengthLimit: true }],
    ]);
    const handlers = getDefaultHandlers({
      res: { write: jest.fn() },
      contentParts,
      stepMap,
      aggregateContent,
      toolInputValidationErrors,
      toolEndCallback: jest.fn(),
      collectedUsage: [],
    });

    aggregateContent({
      event: GraphEvents.ON_RUN_STEP,
      data: {
        id: 'step-1',
        index: 0,
        stepDetails: {
          type: 'tool_calls',
          tool_calls: [{ id: 'tool-1', name: 'ask_user_question', args: '{}' }],
        },
      },
    });

    const data = {
      result: {
        id: 'step-1',
        tool_call: {
          id: 'tool-1',
          name: 'ask_user_question',
          output:
            'Error processing tool: Received tool input did not match expected schema ' +
            '→ at options[0].label',
        },
      },
    };

    await handlers[GraphEvents.ON_RUN_STEP_COMPLETED].handle(
      GraphEvents.ON_RUN_STEP_COMPLETED,
      data,
      { run_id: 'run-1', thread_id: 'conversation-1' },
    );

    expect(data.result.tool_call.inputValidationError).toBe(true);
    expect(contentParts[0].tool_call.inputValidationError).toBe(true);
    expect(contentParts[0].tool_call.stepId).toBe('step-1');
    expect(toolInputValidationErrors.size).toBe(0);
  });

  it('does not mark successful output that resembles a schema error', async () => {
    const { GraphEvents, createContentAggregator } = jest.requireActual('@librechat/agents');
    const { getDefaultHandlers } = require('../callbacks');
    const { contentParts, aggregateContent, stepMap } = createContentAggregator();
    const handlers = getDefaultHandlers({
      res: { write: jest.fn() },
      contentParts,
      stepMap,
      aggregateContent,
      toolInputValidationErrors: new Map(),
      toolEndCallback: jest.fn(),
      collectedUsage: [],
    });

    aggregateContent({
      event: GraphEvents.ON_RUN_STEP,
      data: {
        id: 'step-1',
        index: 0,
        stepDetails: {
          type: 'tool_calls',
          tool_calls: [{ id: 'tool-1', name: 'ask_user_question', args: '{}' }],
        },
      },
    });

    const data = {
      result: {
        id: 'step-1',
        tool_call: {
          id: 'tool-1',
          name: 'ask_user_question',
          output: 'Received tool input did not match expected schema → at options[0].label',
        },
      },
    };

    await handlers[GraphEvents.ON_RUN_STEP_COMPLETED].handle(
      GraphEvents.ON_RUN_STEP_COMPLETED,
      data,
      { run_id: 'run-1', thread_id: 'conversation-1' },
    );

    expect(data.result.tool_call).not.toHaveProperty('inputValidationError');
    expect(contentParts[0].tool_call).not.toHaveProperty('inputValidationError');
    expect(contentParts[0].tool_call.stepId).toBe('step-1');
  });
});

describe('isStreamWritable', () => {
  /* Direct parametric coverage of the predicate that gates SSE writes
   * in both the chat-completions and Open Responses callbacks. The
   * existing deferred-preview tests cover this indirectly via the
   * `writeAttachmentUpdate` writableEnded path; these tests pin down
   * each individual branch so a future modification (e.g. adding a
   * new condition) can't silently regress.
   * (Comprehensive review NIT on PR #12957.) */
  const { isStreamWritable } = require('../callbacks');

  it('returns true when streamId is truthy regardless of res state', () => {
    /* Resumable mode writes go to the job emitter; res state is
     * irrelevant. Even a closed res with no headers should not block. */
    expect(isStreamWritable(null, 'stream-1')).toBe(true);
    expect(isStreamWritable({ headersSent: false, writableEnded: true }, 'stream-1')).toBe(true);
    expect(isStreamWritable(undefined, 'stream-1')).toBe(true);
  });

  it('returns false when streamId is falsy and res is null/undefined', () => {
    expect(isStreamWritable(null, null)).toBe(false);
    expect(isStreamWritable(undefined, null)).toBe(false);
  });

  it('returns false when headers have not been sent yet', () => {
    expect(isStreamWritable({ headersSent: false, writableEnded: false }, null)).toBe(false);
  });

  it('returns false when the stream has already ended', () => {
    expect(isStreamWritable({ headersSent: true, writableEnded: true }, null)).toBe(false);
  });

  it('returns true on the happy path: headers sent, not ended, no streamId', () => {
    expect(isStreamWritable({ headersSent: true, writableEnded: false }, null)).toBe(true);
  });
});
