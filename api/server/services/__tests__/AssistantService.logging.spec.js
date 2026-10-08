const mockSendEvent = jest.fn();
const mockLogger = {
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
};

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  sendEvent: (...args) => mockSendEvent(...args),
}));

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: mockLogger,
}));

const { createOnTextProgress } = require('../AssistantService');
const StreamRunManager = require('../Runs/StreamRunManager');

describe('Assistant service log hygiene', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('logs only structural metadata for non-text assistant content', async () => {
    const privateArguments = 'PRIVATE-TOOL-ARGUMENTS';
    const openai = { res: {} };
    await createOnTextProgress({
      openai,
      conversationId: 'conversation-1',
      userMessageId: 'user-message-1',
      messageId: 'assistant-message-1',
      thread_id: 'thread-1',
    });

    openai.addContentData({
      type: 'tool_call',
      index: 0,
      tool_call: {
        type: 'function',
        function: { name: 'example', arguments: privateArguments },
      },
    });

    expect(JSON.stringify(mockLogger.debug.mock.calls)).not.toContain(privateArguments);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Assistant content event',
      expect.objectContaining({
        type: 'tool_call',
        index: 0,
        hasContent: true,
      }),
    );
    expect(JSON.stringify(mockSendEvent.mock.calls)).toContain(privateArguments);
  });

  it('does not include raw tool deltas in warning logs', async () => {
    const privateDelta = 'PRIVATE-DELTA';
    const manager = new StreamRunManager({
      req: {},
      res: {},
      openai: { apiKey: 'test-key' },
      parentMessageId: 'parent-1',
      thread_id: 'thread-1',
      runBody: {},
      responseMessage: { content: [], messageId: 'message-1', conversationId: 'conversation-1' },
      attachedFileIds: new Set(),
      handlers: {},
    });
    const handler = manager.createToolCallStream(0, {
      type: 'function',
      function: { name: 'example', arguments: '' },
    });

    await handler({ unexpected: privateDelta });
    await manager.handleRunStepDeltaEvent({
      data: { id: 'step-1', delta: { unknown: privateDelta } },
    });

    expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain(privateDelta);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Unhandled tool call delta key',
      expect.objectContaining({ key: 'unexpected' }),
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Undefined or unhandled run step delta',
      expect.objectContaining({ stepId: 'step-1' }),
    );
  });
});
