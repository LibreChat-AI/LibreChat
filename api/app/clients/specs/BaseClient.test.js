const { Constants, ContentTypes, EModelEndpoint } = require('librechat-data-provider');
const BaseClientClass = require('../BaseClient');
const {
  ContentFilterError,
  resolveTurnDeliveryRouting,
  buildSteerMedia,
  Tokenizer,
} = require('@librechat/api');
const { FakeClient, initializeFakeClient } = require('./FakeClient');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

jest.mock('~/db/connect');
jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn().mockResolvedValue({
    // Default app config for tests
    paths: { uploads: '/tmp' },
    fileStrategy: 'local',
    memory: { disabled: false },
  }),
}));
jest.mock('~/models', () => ({
  User: jest.fn(),
  Key: jest.fn(),
  Session: jest.fn(),
  Balance: jest.fn(),
  Transaction: jest.fn(),
  getMessages: jest.fn().mockResolvedValue([]),
  saveMessage: jest.fn(),
  updateMessage: jest.fn(),
  deleteMessagesSince: jest.fn(),
  deleteMessages: jest.fn(),
  getConvoTitle: jest.fn(),
  getConvo: jest.fn(),
  saveConvo: jest.fn(),
  deleteConvos: jest.fn(),
  getPreset: jest.fn(),
  getPresets: jest.fn(),
  savePreset: jest.fn(),
  deletePresets: jest.fn(),
  findFileById: jest.fn(),
  createFile: jest.fn(),
  updateFile: jest.fn(),
  deleteFile: jest.fn(),
  deleteFiles: jest.fn(),
  getFiles: jest.fn(),
  updateFileUsage: jest.fn(),
  getMultiplier: jest.fn(),
  reserveBalance: jest.fn(),
  renewBalanceReservation: jest.fn(),
  releaseBalanceReservation: jest.fn(),
}));

const {
  releaseBalanceReservation,
  reserveBalance,
  getMultiplier,
  saveMessage,
  getMessages,
  saveConvo,
  getFiles,
  getConvo,
} = require('~/models');

jest.mock('@librechat/agents', () => {
  const actual = jest.requireActual('@librechat/agents');
  return {
    ...actual,
    ChatOpenAI: jest.fn().mockImplementation(() => {
      return {};
    }),
  };
});

let parentMessageId;
let conversationId;
const fakeMessages = [];
const userMessage = 'Hello, ChatGPT!';
const apiKey = 'fake-api-key';

const messageHistory = [
  { role: 'user', isCreatedByUser: true, text: 'Hello', messageId: '1' },
  { role: 'assistant', isCreatedByUser: false, text: 'Hi', messageId: '2', parentMessageId: '1' },
  {
    role: 'user',
    isCreatedByUser: true,
    text: "What's up",
    messageId: '3',
    parentMessageId: '2',
  },
];

describe('BaseClient', () => {
  let TestClient;
  const options = {
    // debug: true,
    modelOptions: {
      model: 'gpt-4o-mini',
      temperature: 0,
    },
  };

  beforeEach(() => {
    TestClient = initializeFakeClient(apiKey, options, fakeMessages);
    TestClient.summarizeMessages = jest.fn().mockResolvedValue({
      summaryMessage: {
        role: 'system',
        content: 'Refined answer',
      },
      summaryTokenCount: 5,
    });
  });

  test('persists only the host-authored external event display projection on the user turn', () => {
    const projection = {
      version: 1,
      eventType: 'chess.turn.ready',
      sourceType: 'speed-chess',
      occurredAt: new Date('2026-08-21T12:00:00.000Z'),
      expectedActionToolName: 'submit_move',
    };
    TestClient.options.req = { _agentEventTriggerProjection: projection };

    expect(
      TestClient.createUserMessage({
        messageId: 'event:user',
        parentMessageId: 'parent',
        conversationId: 'event-thread',
        text: 'Private event payload',
      }),
    ).toEqual(expect.objectContaining({ subagentTriggerProjection: projection }));
  });

  test('returns the input messages without instructions when addInstructions() is called with empty instructions', () => {
    const messages = [{ content: 'Hello' }, { content: 'How are you?' }, { content: 'Goodbye' }];
    const instructions = '';
    const result = TestClient.addInstructions(messages, instructions);
    expect(result).toEqual(messages);
  });

  test('returns the input messages with instructions properly added when addInstructions() is called with non-empty instructions', () => {
    const messages = [{ content: 'Hello' }, { content: 'How are you?' }, { content: 'Goodbye' }];
    const instructions = { content: 'Please respond to the question.' };
    const result = TestClient.addInstructions(messages, instructions);
    const expected = [
      { content: 'Please respond to the question.' },
      { content: 'Hello' },
      { content: 'How are you?' },
      { content: 'Goodbye' },
    ];
    expect(result).toEqual(expected);
  });

  test('returns the input messages with instructions properly added when addInstructions() with legacy flag', () => {
    const messages = [{ content: 'Hello' }, { content: 'How are you?' }, { content: 'Goodbye' }];
    const instructions = { content: 'Please respond to the question.' };
    const result = TestClient.addInstructions(messages, instructions, true);
    const expected = [
      { content: 'Hello' },
      { content: 'How are you?' },
      { content: 'Please respond to the question.' },
      { content: 'Goodbye' },
    ];
    expect(result).toEqual(expected);
  });

  test('concats messages correctly in concatenateMessages()', () => {
    const messages = [
      { name: 'User', content: 'Hello' },
      { name: 'Assistant', content: 'How can I help you?' },
      { name: 'User', content: 'I have a question.' },
    ];
    const result = TestClient.concatenateMessages(messages);
    const expected =
      'User:\nHello\n\nAssistant:\nHow can I help you?\n\nUser:\nI have a question.\n\n';
    expect(result).toBe(expected);
  });

  test('refines messages correctly in summarizeMessages()', async () => {
    const messagesToRefine = [
      { role: 'user', content: 'Hello', tokenCount: 10 },
      { role: 'assistant', content: 'How can I help you?', tokenCount: 20 },
    ];
    const remainingContextTokens = 100;
    const expectedRefinedMessage = {
      role: 'system',
      content: 'Refined answer',
    };

    const result = await TestClient.summarizeMessages({ messagesToRefine, remainingContextTokens });
    expect(result.summaryMessage).toEqual(expectedRefinedMessage);
  });

  test('gets messages within token limit (under limit) correctly in getMessagesWithinTokenLimit()', async () => {
    TestClient.maxContextTokens = 100;
    TestClient.shouldSummarize = true;

    const messages = [
      { role: 'user', content: 'Hello', tokenCount: 5 },
      { role: 'assistant', content: 'How can I help you?', tokenCount: 19 },
      { role: 'user', content: 'I have a question.', tokenCount: 18 },
    ];
    const expectedContext = [
      { role: 'user', content: 'Hello', tokenCount: 5 }, // 'Hello'.length
      { role: 'assistant', content: 'How can I help you?', tokenCount: 19 },
      { role: 'user', content: 'I have a question.', tokenCount: 18 },
    ];
    // Subtract 3 tokens for Assistant Label priming after all messages have been counted.
    const expectedRemainingContextTokens = 58 - 3; // (100 - 5 - 19 - 18) - 3
    const expectedMessagesToRefine = [];

    const lastExpectedMessage =
      expectedMessagesToRefine?.[expectedMessagesToRefine.length - 1] ?? {};
    const expectedIndex = messages.findIndex((msg) => msg.content === lastExpectedMessage?.content);

    const result = await TestClient.getMessagesWithinTokenLimit({ messages });

    expect(result.context).toEqual(expectedContext);
    expect(result.messagesToRefine.length - 1).toEqual(expectedIndex);
    expect(result.remainingContextTokens).toBe(expectedRemainingContextTokens);
    expect(result.messagesToRefine).toEqual(expectedMessagesToRefine);
  });

  test('gets result over token limit correctly in getMessagesWithinTokenLimit()', async () => {
    TestClient.maxContextTokens = 50; // Set a lower limit
    TestClient.shouldSummarize = true;

    const messages = [
      { role: 'user', content: 'Hello', tokenCount: 30 },
      { role: 'assistant', content: 'How can I help you?', tokenCount: 30 },
      { role: 'user', content: 'I have a question.', tokenCount: 5 },
      { role: 'user', content: 'I need a coffee, stat!', tokenCount: 19 },
      { role: 'assistant', content: 'Sure, I can help with that.', tokenCount: 18 },
    ];

    // Subtract 3 tokens for Assistant Label priming after all messages have been counted.
    const expectedRemainingContextTokens = 5; // (50 - 18 - 19 - 5) - 3
    const expectedMessagesToRefine = [
      { role: 'user', content: 'Hello', tokenCount: 30 },
      { role: 'assistant', content: 'How can I help you?', tokenCount: 30 },
    ];
    const expectedContext = [
      { role: 'user', content: 'I have a question.', tokenCount: 5 },
      { role: 'user', content: 'I need a coffee, stat!', tokenCount: 19 },
      { role: 'assistant', content: 'Sure, I can help with that.', tokenCount: 18 },
    ];

    const lastExpectedMessage =
      expectedMessagesToRefine?.[expectedMessagesToRefine.length - 1] ?? {};
    const expectedIndex = messages.findIndex((msg) => msg.content === lastExpectedMessage?.content);

    const result = await TestClient.getMessagesWithinTokenLimit({ messages });

    expect(result.context).toEqual(expectedContext);
    expect(result.messagesToRefine.length - 1).toEqual(expectedIndex);
    expect(result.remainingContextTokens).toBe(expectedRemainingContextTokens);
    expect(result.messagesToRefine).toEqual(expectedMessagesToRefine);
  });

  describe('loadHistory', () => {
    const receiver = Object.assign(Object.create(BaseClientClass.prototype), {
      user: 'user-1',
      getMessageMapMethod: null,
      shouldSummarize: false,
      addPreviousAttachments: async (messages) => messages,
    });
    const loadHistory = (parentMessageId) => receiver.loadHistory('convo-1', parentMessageId);

    beforeEach(() => {
      getMessages.mockClear();
    });

    test('skips the database when the parent is the root sentinel: no message can match it', async () => {
      const result = await loadHistory(Constants.NO_PARENT);

      expect(result).toEqual([]);
      expect(getMessages).not.toHaveBeenCalled();
    });

    test('still loads and walks the chain for a real parent', async () => {
      getMessages.mockResolvedValueOnce([
        { messageId: 'root', parentMessageId: Constants.NO_PARENT, text: 'a' },
        { messageId: 'reply', parentMessageId: 'root', text: 'b' },
      ]);

      const result = await loadHistory('reply');

      expect(getMessages).toHaveBeenCalledTimes(1);
      expect(result.map((m) => m.messageId)).toEqual(['root', 'reply']);
    });

    test('prunes pre-summary history before hydrating attachments', async () => {
      const addPreviousAttachments = jest.fn(async (messages) => messages);
      receiver.shouldSummarize = true;
      receiver.addPreviousAttachments = addPreviousAttachments;
      getMessages.mockResolvedValueOnce([
        {
          messageId: 'pre-summary',
          parentMessageId: Constants.NO_PARENT,
          files: [{ file_id: 'old-file' }],
        },
        {
          messageId: 'summary',
          parentMessageId: 'pre-summary',
          summary: 'Earlier context',
          summaryTokenCount: 10,
        },
        { messageId: 'latest', parentMessageId: 'summary', text: 'Continue' },
      ]);

      const result = await loadHistory('latest');

      expect(result.map((message) => message.messageId)).toEqual(['summary', 'latest']);
      expect(addPreviousAttachments).toHaveBeenCalledWith(
        expect.not.arrayContaining([expect.objectContaining({ messageId: 'pre-summary' })]),
      );
      receiver.shouldSummarize = false;
      receiver.addPreviousAttachments = async (messages) => messages;
      receiver.previous_summary = undefined;
    });
  });

  describe('getMessagesForConversation', () => {
    it('should return an empty array if the parentMessageId does not exist', () => {
      const result = TestClient.constructor.getMessagesForConversation({
        messages: unorderedMessages,
        parentMessageId: '999',
      });
      expect(result).toEqual([]);
    });

    it('should handle messages with messageId property', () => {
      const messagesWithMessageId = [
        { messageId: '1', parentMessageId: null, text: 'Message 1' },
        { messageId: '2', parentMessageId: '1', text: 'Message 2' },
      ];
      const result = TestClient.constructor.getMessagesForConversation({
        messages: messagesWithMessageId,
        parentMessageId: '2',
      });
      expect(result).toEqual([
        { messageId: '1', parentMessageId: null, text: 'Message 1' },
        { messageId: '2', parentMessageId: '1', text: 'Message 2' },
      ]);
    });

    const messagesWithNullParent = [
      { id: '1', parentMessageId: null, text: 'Message 1' },
      { id: '2', parentMessageId: null, text: 'Message 2' },
    ];

    it('should handle messages with null parentMessageId that are not root', () => {
      const result = TestClient.constructor.getMessagesForConversation({
        messages: messagesWithNullParent,
        parentMessageId: '2',
      });
      expect(result).toEqual([{ id: '2', parentMessageId: null, text: 'Message 2' }]);
    });

    const cyclicMessages = [
      { id: '3', parentMessageId: '2', text: 'Message 3' },
      { id: '1', parentMessageId: '3', text: 'Message 1' },
      { id: '2', parentMessageId: '1', text: 'Message 2' },
    ];

    it('should handle cyclic references without going into an infinite loop', () => {
      const result = TestClient.constructor.getMessagesForConversation({
        messages: cyclicMessages,
        parentMessageId: '3',
      });
      expect(result).toEqual([
        { id: '1', parentMessageId: '3', text: 'Message 1' },
        { id: '2', parentMessageId: '1', text: 'Message 2' },
        { id: '3', parentMessageId: '2', text: 'Message 3' },
      ]);
    });

    const unorderedMessages = [
      { id: '3', parentMessageId: '2', text: 'Message 3' },
      { id: '2', parentMessageId: '1', text: 'Message 2' },
      { id: '1', parentMessageId: Constants.NO_PARENT, text: 'Message 1' },
    ];

    it('should return ordered messages based on parentMessageId', () => {
      const result = TestClient.constructor.getMessagesForConversation({
        messages: unorderedMessages,
        parentMessageId: '3',
      });
      expect(result).toEqual([
        { id: '1', parentMessageId: Constants.NO_PARENT, text: 'Message 1' },
        { id: '2', parentMessageId: '1', text: 'Message 2' },
        { id: '3', parentMessageId: '2', text: 'Message 3' },
      ]);
    });

    const unorderedBranchedMessages = [
      { id: '4', parentMessageId: '2', text: 'Message 4', summary: 'Summary for Message 4' },
      { id: '10', parentMessageId: '7', text: 'Message 10' },
      { id: '1', parentMessageId: null, text: 'Message 1' },
      { id: '6', parentMessageId: '5', text: 'Message 7' },
      { id: '7', parentMessageId: '5', text: 'Message 7' },
      { id: '2', parentMessageId: '1', text: 'Message 2' },
      { id: '8', parentMessageId: '6', text: 'Message 8' },
      { id: '5', parentMessageId: '3', text: 'Message 5' },
      { id: '3', parentMessageId: '1', text: 'Message 3' },
      { id: '6', parentMessageId: '4', text: 'Message 6' },
      { id: '8', parentMessageId: '7', text: 'Message 9' },
      { id: '9', parentMessageId: '7', text: 'Message 9' },
      { id: '11', parentMessageId: '2', text: 'Message 11', summary: 'Summary for Message 11' },
    ];

    it('should return ordered messages from a branched array based on parentMessageId', () => {
      const result = TestClient.constructor.getMessagesForConversation({
        messages: unorderedBranchedMessages,
        parentMessageId: '10',
        summary: true,
      });
      expect(result).toEqual([
        { id: '1', parentMessageId: null, text: 'Message 1' },
        { id: '3', parentMessageId: '1', text: 'Message 3' },
        { id: '5', parentMessageId: '3', text: 'Message 5' },
        { id: '7', parentMessageId: '5', text: 'Message 7' },
        { id: '10', parentMessageId: '7', text: 'Message 10' },
      ]);
    });

    it('should return an empty array if no messages are provided', () => {
      const result = TestClient.constructor.getMessagesForConversation({
        messages: [],
        parentMessageId: '3',
      });
      expect(result).toEqual([]);
    });

    it('should map over the ordered messages if mapMethod is provided', () => {
      const mapMethod = (msg) => msg.text;
      const result = TestClient.constructor.getMessagesForConversation({
        messages: unorderedMessages,
        parentMessageId: '3',
        mapMethod,
      });
      expect(result).toEqual(['Message 1', 'Message 2', 'Message 3']);
    });

    let unorderedMessagesWithSummary = [
      { id: '4', parentMessageId: '3', text: 'Message 4' },
      { id: '2', parentMessageId: '1', text: 'Message 2', summary: 'Summary for Message 2' },
      { id: '3', parentMessageId: '2', text: 'Message 3', summary: 'Summary for Message 3' },
      { id: '1', parentMessageId: null, text: 'Message 1' },
    ];

    it('should start with the message that has a summary property and continue until the specified parentMessageId', () => {
      const result = TestClient.constructor.getMessagesForConversation({
        messages: unorderedMessagesWithSummary,
        parentMessageId: '4',
        summary: true,
      });
      expect(result).toEqual([
        {
          id: '3',
          parentMessageId: '2',
          role: 'system',
          text: 'Message 3',
          content: [{ type: 'text', text: 'Summary for Message 3' }],
          summary: 'Summary for Message 3',
        },
        { id: '4', parentMessageId: '3', text: 'Message 4' },
      ]);
    });

    it('should handle multiple summaries and return the branch from the latest to the parentMessageId', () => {
      unorderedMessagesWithSummary = [
        { id: '5', parentMessageId: '4', text: 'Message 5' },
        { id: '2', parentMessageId: '1', text: 'Message 2', summary: 'Summary for Message 2' },
        { id: '3', parentMessageId: '2', text: 'Message 3', summary: 'Summary for Message 3' },
        { id: '4', parentMessageId: '3', text: 'Message 4', summary: 'Summary for Message 4' },
        { id: '1', parentMessageId: null, text: 'Message 1' },
      ];
      const result = TestClient.constructor.getMessagesForConversation({
        messages: unorderedMessagesWithSummary,
        parentMessageId: '5',
        summary: true,
      });
      expect(result).toEqual([
        {
          id: '4',
          parentMessageId: '3',
          role: 'system',
          text: 'Message 4',
          content: [{ type: 'text', text: 'Summary for Message 4' }],
          summary: 'Summary for Message 4',
        },
        { id: '5', parentMessageId: '4', text: 'Message 5' },
      ]);
    });

    it('should handle summary at root edge case and continue until the parentMessageId', () => {
      unorderedMessagesWithSummary = [
        { id: '5', parentMessageId: '4', text: 'Message 5' },
        { id: '1', parentMessageId: null, text: 'Message 1', summary: 'Summary for Message 1' },
        { id: '4', parentMessageId: '3', text: 'Message 4', summary: 'Summary for Message 4' },
        { id: '2', parentMessageId: '1', text: 'Message 2', summary: 'Summary for Message 2' },
        { id: '3', parentMessageId: '2', text: 'Message 3', summary: 'Summary for Message 3' },
      ];
      const result = TestClient.constructor.getMessagesForConversation({
        messages: unorderedMessagesWithSummary,
        parentMessageId: '5',
        summary: true,
      });
      expect(result).toEqual([
        {
          id: '4',
          parentMessageId: '3',
          role: 'system',
          text: 'Message 4',
          content: [{ type: 'text', text: 'Summary for Message 4' }],
          summary: 'Summary for Message 4',
        },
        { id: '5', parentMessageId: '4', text: 'Message 5' },
      ]);
    });

    it('should detect summary content block and use it over legacy fields (summary mode)', () => {
      const messagesWithContentBlock = [
        { id: '3', parentMessageId: '2', text: 'Message 3' },
        {
          id: '2',
          parentMessageId: '1',
          text: 'Message 2',
          content: [
            { type: 'text', text: 'Original text' },
            { type: 'summary', text: 'Content block summary', tokenCount: 42 },
          ],
        },
        { id: '1', parentMessageId: null, text: 'Message 1' },
      ];
      const result = TestClient.constructor.getMessagesForConversation({
        messages: messagesWithContentBlock,
        parentMessageId: '3',
        summary: true,
      });
      expect(result).toHaveLength(2);
      expect(result[0].role).toBe('system');
      expect(result[0].content).toEqual([{ type: 'text', text: 'Content block summary' }]);
      expect(result[0].tokenCount).toBe(42);
    });

    it('should prefer content block summary over legacy summary field', () => {
      const messagesWithBoth = [
        { id: '2', parentMessageId: '1', text: 'Message 2' },
        {
          id: '1',
          parentMessageId: null,
          text: 'Message 1',
          summary: 'Legacy summary',
          summaryTokenCount: 10,
          content: [{ type: 'summary', text: 'Content block summary', tokenCount: 20 }],
        },
      ];
      const result = TestClient.constructor.getMessagesForConversation({
        messages: messagesWithBoth,
        parentMessageId: '2',
        summary: true,
      });
      expect(result).toHaveLength(2);
      expect(result[0].content).toEqual([{ type: 'text', text: 'Content block summary' }]);
      expect(result[0].tokenCount).toBe(20);
    });

    it('should fallback to legacy summary when no content block exists', () => {
      const messagesWithLegacy = [
        { id: '2', parentMessageId: '1', text: 'Message 2' },
        {
          id: '1',
          parentMessageId: null,
          text: 'Message 1',
          summary: 'Legacy summary only',
          summaryTokenCount: 15,
        },
      ];
      const result = TestClient.constructor.getMessagesForConversation({
        messages: messagesWithLegacy,
        parentMessageId: '2',
        summary: true,
      });
      expect(result).toHaveLength(2);
      expect(result[0].content).toEqual([{ type: 'text', text: 'Legacy summary only' }]);
      expect(result[0].tokenCount).toBe(15);
    });

    it('should not stop traversal at a failed summary, keeping the prior history', () => {
      /** A summarize round that errored keeps the deltas it streamed, so its
       *  text is a truncated prefix; treating it as the checkpoint would send
       *  it in place of the history it never finished summarizing. */
      const messagesWithFailedSummary = [
        { id: '1', parentMessageId: null, text: 'Message 1' },
        { id: '2', parentMessageId: '1', text: 'Message 2' },
        {
          id: '3',
          parentMessageId: '2',
          text: '',
          content: [{ type: 'summary', text: 'Partial sum', tokenCount: 5, failed: true }],
        },
        { id: '4', parentMessageId: '3', text: 'Message 4' },
      ];
      const result = TestClient.constructor.getMessagesForConversation({
        messages: messagesWithFailedSummary,
        parentMessageId: '4',
        summary: true,
      });
      expect(result.map((message) => message.id)).toEqual(['1', '2', '3', '4']);
      expect(result.every((message) => message.role !== 'system')).toBe(true);
    });
  });

  describe('sendMessage', () => {
    test('sendMessage should return a response message', async () => {
      const expectedResult = expect.objectContaining({
        sender: TestClient.sender,
        text: expect.any(String),
        isCreatedByUser: false,
        messageId: expect.any(String),
        parentMessageId: expect.any(String),
        conversationId: expect.any(String),
      });

      const response = await TestClient.sendMessage(userMessage);
      parentMessageId = response.messageId;
      conversationId = response.conversationId;
      expect(response).toEqual(expectedResult);
    });

    test('persists exact provenance paths for edited and steered assistant content', async () => {
      const history = [
        {
          role: 'user',
          isCreatedByUser: true,
          text: 'Original question',
          messageId: 'user-message',
          parentMessageId: Constants.NO_PARENT,
        },
        {
          role: 'assistant',
          isCreatedByUser: false,
          messageId: 'assistant-message',
          parentMessageId: 'user-message',
          userSubmittedPaths: ['/content/1/think'],
          userSubmittedMessageFieldPaths: [
            { path: '/content/0/tool_call/output', field: 'answer' },
          ],
          content: [
            {
              type: ContentTypes.TOOL_CALL,
              tool_call: { name: 'ask_user_question', output: 'Prior answer' },
            },
            { type: ContentTypes.THINK, [ContentTypes.THINK]: 'Prior user-edited reasoning' },
            { type: ContentTypes.TEXT, [ContentTypes.TEXT]: 'Original model response' },
          ],
        },
      ];
      TestClient = initializeFakeClient(apiKey, options, history);
      TestClient.clientName = 'agents';
      TestClient.sendCompletion.mockResolvedValue({
        completion: [
          { type: ContentTypes.TEXT, [ContentTypes.TEXT]: ' model continuation' },
          { type: ContentTypes.STEER, [ContentTypes.STEER]: 'User steer' },
        ],
        metadata: undefined,
      });

      const response = await TestClient.sendMessage('ignored during edit', {
        conversationId: 'conversation-1',
        parentMessageId: 'assistant-message',
        responseMessageId: 'assistant-message',
        isEdited: true,
        isContinued: true,
        editedContent: {
          index: 2,
          text: 'User replacement',
          type: ContentTypes.TEXT,
        },
      });

      const modelBoundEditedMessage = TestClient.buildMessages.mock.calls[0][0].at(-1);
      expect(modelBoundEditedMessage.userSubmittedPaths).toEqual([
        '/content/1/think',
        '/content/2/text',
      ]);

      expect(response.content).toEqual([
        {
          type: ContentTypes.TOOL_CALL,
          tool_call: { name: 'ask_user_question', output: 'Prior answer' },
        },
        { type: ContentTypes.THINK, [ContentTypes.THINK]: 'Prior user-edited reasoning' },
        {
          type: ContentTypes.TEXT,
          [ContentTypes.TEXT]: 'User replacement model continuation',
        },
        { type: ContentTypes.STEER, [ContentTypes.STEER]: 'User steer' },
      ]);
      expect(response.userSubmittedPaths).toEqual([
        '/content/3',
        '/content/1/think',
        '/content/2/text',
      ]);
      expect(response.userSubmittedMessageFieldPaths).toEqual([
        { path: '/content/0/tool_call/output', field: 'answer' },
      ]);
      expect(response).not.toHaveProperty('isUserSubmitted');
    });

    test('should replace responseMessageId with new UUID when isRegenerate is true and messageId ends with underscore', async () => {
      const mockCrypto = require('crypto');
      const newUUID = 'new-uuid-1234';
      jest.spyOn(mockCrypto, 'randomUUID').mockReturnValue(newUUID);

      const opts = {
        isRegenerate: true,
        responseMessageId: 'existing-message-id_',
      };

      await TestClient.setMessageOptions(opts);

      expect(TestClient.responseMessageId).toBe(newUUID);
      expect(TestClient.responseMessageId).not.toBe('existing-message-id_');

      mockCrypto.randomUUID.mockRestore();
    });

    test('should not replace responseMessageId when isRegenerate is false', async () => {
      const opts = {
        isRegenerate: false,
        responseMessageId: 'existing-message-id_',
      };

      await TestClient.setMessageOptions(opts);

      expect(TestClient.responseMessageId).toBe('existing-message-id_');
    });

    test('should not replace responseMessageId when it does not end with underscore', async () => {
      const opts = {
        isRegenerate: true,
        responseMessageId: 'existing-message-id',
      };

      await TestClient.setMessageOptions(opts);

      expect(TestClient.responseMessageId).toBe('existing-message-id');
    });

    test('sendMessage should work with provided conversationId and parentMessageId', async () => {
      const userMessage = 'Second message in the conversation';
      const opts = {
        conversationId,
        parentMessageId,
        getReqData: jest.fn(),
        onStart: jest.fn(),
      };

      const expectedResult = expect.objectContaining({
        sender: TestClient.sender,
        text: expect.any(String),
        isCreatedByUser: false,
        messageId: expect.any(String),
        parentMessageId: expect.any(String),
        conversationId: opts.conversationId,
      });

      const response = await TestClient.sendMessage(userMessage, opts);
      parentMessageId = response.messageId;
      expect(response.conversationId).toEqual(conversationId);
      expect(response).toEqual(expectedResult);
      expect(opts.getReqData).toHaveBeenCalled();
      expect(opts.onStart).toHaveBeenCalled();
      expect(TestClient.getBuildMessagesOptions).toHaveBeenCalled();
      expect(TestClient.getSaveOptions).toHaveBeenCalled();
    });

    test('runs the restored-history guard before building model input', async () => {
      const policyError = Object.assign(new Error('Blocked restored history'), {
        code: 'content_filter_block',
      });
      TestClient.assertStoredModelBoundContent = jest.fn(() => {
        throw policyError;
      });

      await expect(TestClient.sendMessage('Safe new message')).rejects.toBe(policyError);

      expect(TestClient.assertStoredModelBoundContent).toHaveBeenCalledTimes(1);
      expect(TestClient.buildMessages).not.toHaveBeenCalled();
      expect(TestClient.sendCompletion).not.toHaveBeenCalled();
    });

    test('cancels a deferred user-message write when the model boundary rejects content', async () => {
      saveMessage.mockClear();
      saveConvo.mockClear();
      const policyError = new ContentFilterError({ source: 'message', field: 'text' });
      const getReqData = jest.fn();
      const abortController = new AbortController();
      TestClient.shouldDeferUserMessagePersistence = jest.fn(() => true);
      TestClient.sendCompletion.mockRejectedValue(policyError);

      await expect(
        TestClient.sendMessage('Safe new message', { abortController, getReqData }),
      ).rejects.toBe(policyError);

      /** Policy cancellation removes the Stop listener and remains final. */
      abortController.abort();

      expect(saveMessage).not.toHaveBeenCalled();
      expect(saveConvo).not.toHaveBeenCalled();
      const persistenceCall = getReqData.mock.calls.find(([data]) => data.userMessagePromise);
      await expect(persistenceCall[0].userMessagePromise).resolves.toEqual({});
    });

    test('starts a deferred user-message write after a safe no-model completion', async () => {
      saveMessage.mockClear();
      saveConvo.mockClear();
      TestClient.shouldDeferUserMessagePersistence = jest.fn(() => true);
      TestClient.sendCompletion.mockImplementation(async () => {
        expect(saveMessage).not.toHaveBeenCalled();
        return { completion: 'Safe response', metadata: undefined };
      });

      await TestClient.sendMessage('Safe new message');

      expect(saveMessage.mock.calls.some(([, message]) => message.isCreatedByUser === true)).toBe(
        true,
      );
    });

    describe('seeding the conversation for a deferred user message', () => {
      const seedContext = 'api/app/clients/BaseClient.js - sendMessage #seedConversation';
      const flush = () => new Promise((resolve) => setImmediate(resolve));
      const savedUserMessage = () =>
        saveMessage.mock.calls.some(([, message]) => message.isCreatedByUser === true);

      beforeEach(() => {
        saveMessage.mockReset();
        saveConvo.mockReset().mockImplementation(async (_ctx, fields) => ({ ...fields }));
        getConvo.mockReset().mockResolvedValue(null);
        /** A fresh options object: the suite-level one is shared by reference across clients. */
        TestClient.options = {
          ...TestClient.options,
          req: { user: { id: 'seed-user' }, body: {} },
        };
        TestClient.shouldDeferUserMessagePersistence = jest.fn(() => true);
        TestClient.shouldSeedDeferredConversation = jest.fn(() => true);
      });

      afterEach(() => {
        saveMessage.mockReset();
        saveConvo.mockReset();
        getConvo.mockReset();
      });

      test('creates a new conversation row while the message itself waits for admission', async () => {
        TestClient.sendCompletion.mockImplementation(async () => {
          await flush();
          expect(savedUserMessage()).toBe(false);
          expect(saveConvo).toHaveBeenCalledTimes(1);
          const [, fields, seedOptions] = saveConvo.mock.calls[0];
          expect(fields).toEqual(expect.objectContaining({ conversationId: expect.any(String) }));
          expect(seedOptions).toEqual(expect.objectContaining({ context: seedContext }));
          /** An empty append set spares `saveConvo` the read of a message list the seed lacks. */
          expect(seedOptions).toEqual(expect.objectContaining({ appendMessageIds: [] }));
          return { completion: 'Safe response', metadata: undefined };
        });

        await TestClient.sendMessage('Message with an attachment');

        expect(savedUserMessage()).toBe(true);
        /** The message save reuses the seeded row instead of looking the conversation up again. */
        expect(getConvo).toHaveBeenCalledTimes(1);
      });

      test('leaves an existing conversation to the deferred message write', async () => {
        getConvo.mockResolvedValue({ conversationId: 'existing-convo', endpoint: 'openAI' });
        TestClient.sendCompletion.mockImplementation(async () => {
          await flush();
          expect(saveConvo).not.toHaveBeenCalled();
          return { completion: 'Safe response', metadata: undefined };
        });

        await TestClient.sendMessage('Message with an attachment');

        expect(savedUserMessage()).toBe(true);
        expect(saveConvo.mock.calls.every(([, , opts]) => opts.context !== seedContext)).toBe(true);
      });

      test('holds the deferred message write until an in-flight seed lands', async () => {
        const seedWrite = deferred();
        saveConvo.mockImplementationOnce(() => seedWrite.promise);
        const completionStarted = deferred();
        const completionResult = deferred();
        const abortController = new AbortController();
        TestClient.sendCompletion.mockImplementation(() => {
          completionStarted.resolve();
          return completionResult.promise;
        });

        const sendPromise = TestClient.sendMessage('Message with an attachment', {
          abortController,
        });
        await completionStarted.promise;
        await flush();
        expect(saveConvo).toHaveBeenCalledTimes(1);

        abortController.abort();
        await flush();
        expect(savedUserMessage()).toBe(false);

        seedWrite.resolve({ conversationId: 'seeded-convo' });
        await flush();
        expect(savedUserMessage()).toBe(true);

        completionResult.resolve({ completion: 'Partial response', metadata: undefined });
        await sendPromise;
      });

      test('keeps the deferral cancellable after seeding when the model boundary rejects content', async () => {
        const policyError = new ContentFilterError({ source: 'message', field: 'text' });
        TestClient.sendCompletion.mockImplementation(async () => {
          await flush();
          throw policyError;
        });

        await expect(TestClient.sendMessage('Message with an attachment')).rejects.toBe(
          policyError,
        );

        expect(savedUserMessage()).toBe(false);
        expect(saveConvo).toHaveBeenCalledTimes(1);
      });

      test('does not seed when the client holds back every write', async () => {
        TestClient.shouldSeedDeferredConversation = jest.fn(() => false);
        TestClient.sendCompletion.mockImplementation(async () => {
          await flush();
          expect(saveConvo).not.toHaveBeenCalled();
          return { completion: 'Safe response', metadata: undefined };
        });

        await TestClient.sendMessage('Message with an attachment');

        expect(savedUserMessage()).toBe(true);
      });
    });

    test('preserves eager user-message persistence for non-policy provider failures', async () => {
      saveMessage.mockClear();
      saveConvo.mockClear();
      const providerError = new Error('Provider unavailable');
      TestClient.shouldDeferUserMessagePersistence = jest.fn(() => true);
      TestClient.sendCompletion.mockRejectedValue(providerError);

      await expect(TestClient.sendMessage('Safe new message')).rejects.toBe(providerError);

      expect(saveMessage.mock.calls.some(([, message]) => message.isCreatedByUser === true)).toBe(
        true,
      );
    });

    test('starts a deferred user-message write when Stop aborts an in-flight completion', async () => {
      saveMessage.mockClear();
      saveConvo.mockClear();
      const completionStarted = deferred();
      const completionResult = deferred();
      const abortController = new AbortController();
      TestClient.shouldDeferUserMessagePersistence = jest.fn(() => true);
      TestClient.sendCompletion.mockImplementation(() => {
        completionStarted.resolve();
        return completionResult.promise;
      });

      const sendPromise = TestClient.sendMessage('Safe new message', { abortController });
      await completionStarted.promise;
      expect(saveMessage).not.toHaveBeenCalled();

      abortController.abort();
      expect(saveMessage.mock.calls.some(([, message]) => message.isCreatedByUser === true)).toBe(
        true,
      );

      completionResult.resolve({ completion: 'Partial response', metadata: undefined });
      await sendPromise;
    });

    test('keeps an abort-started write when a late policy error loses the settlement race', async () => {
      saveMessage.mockClear();
      saveConvo.mockClear();
      const completionStarted = deferred();
      const completionResult = deferred();
      const policyError = new ContentFilterError({ source: 'message', field: 'text' });
      const abortController = new AbortController();
      TestClient.shouldDeferUserMessagePersistence = jest.fn(() => true);
      TestClient.sendCompletion.mockImplementation(() => {
        completionStarted.resolve();
        return completionResult.promise;
      });

      const sendPromise = TestClient.sendMessage('Safe new message', { abortController });
      await completionStarted.promise;
      abortController.abort();
      completionResult.reject(policyError);

      await expect(sendPromise).rejects.toBe(policyError);
      expect(saveMessage.mock.calls.some(([, message]) => message.isCreatedByUser === true)).toBe(
        true,
      );
    });

    test('blocks persisted user text selected by the built model payload', async () => {
      const secret = 'PRIVATE-HISTORICAL-VALUE';
      const history = [
        {
          role: 'user',
          isCreatedByUser: true,
          text: `Previously stored ${secret}`,
          messageId: 'persisted-user',
          parentMessageId: Constants.NO_PARENT,
        },
        {
          role: 'assistant',
          isCreatedByUser: false,
          text: 'Safe model response',
          messageId: 'persisted-assistant',
          parentMessageId: 'persisted-user',
        },
      ];
      TestClient = initializeFakeClient(
        apiKey,
        {
          ...options,
          req: {
            config: {
              filters: {
                messages: {
                  pii: {
                    fields: ['text'],
                    starterPatterns: [],
                    customPatterns: [
                      {
                        id: 'historical-private',
                        label: 'historical private value',
                        regex: 'PRIVATE-HISTORICAL-[A-Z]+',
                      },
                    ],
                  },
                },
              },
            },
          },
        },
        history,
      );

      let error;
      try {
        await TestClient.sendMessage('Safe new message', {
          conversationId: 'persisted-conversation',
          parentMessageId: 'persisted-assistant',
        });
      } catch (caughtError) {
        error = caughtError;
      }

      expect(error).toMatchObject({
        code: 'content_filter_block',
        body: {
          error: 'content_filter_block',
          source: 'message',
          field: 'text',
        },
      });
      expect(JSON.stringify({ message: error.message, body: error.body })).not.toContain(secret);
      expect(TestClient.buildMessages).toHaveBeenCalledTimes(1);
      expect(TestClient.sendCompletion).not.toHaveBeenCalled();
    });

    test('allows persisted user text that the built model payload prunes out', async () => {
      const secret = 'PRIVATE-PRUNED-HISTORICAL-VALUE';
      TestClient = initializeFakeClient(
        apiKey,
        {
          ...options,
          req: {
            config: {
              filters: {
                messages: {
                  pii: {
                    fields: ['text'],
                    starterPatterns: [],
                    customPatterns: [
                      {
                        id: 'pruned-private',
                        label: 'pruned private value',
                        regex: 'PRIVATE-PRUNED-HISTORICAL-[A-Z]+',
                      },
                    ],
                  },
                },
              },
            },
          },
        },
        [
          {
            role: 'user',
            isCreatedByUser: true,
            text: `Old ${secret}`,
            messageId: 'pruned-user',
            parentMessageId: Constants.NO_PARENT,
          },
          {
            role: 'assistant',
            isCreatedByUser: false,
            text: 'Safe response',
            messageId: 'safe-assistant',
            parentMessageId: 'pruned-user',
          },
        ],
      );
      TestClient.buildMessages.mockResolvedValue({
        prompt: [{ role: 'user', content: 'Safe new message' }],
        tokenCountMap: null,
      });

      await expect(
        TestClient.sendMessage('Safe new message', {
          conversationId: 'pruned-conversation',
          parentMessageId: 'safe-assistant',
        }),
      ).resolves.toEqual(expect.objectContaining({ isCreatedByUser: false }));

      expect(TestClient.buildMessages).toHaveBeenCalledTimes(1);
      expect(TestClient.sendCompletion).toHaveBeenCalledTimes(1);
    });

    test('blocks historical tool arguments without classifying assistant prose as user input', async () => {
      const filters = {
        messages: {
          pii: {
            fields: ['text'],
            starterPatterns: [],
            customPatterns: [
              {
                id: 'assistant-prose',
                label: 'assistant prose value',
                regex: 'PRIVATE-PROSE',
              },
            ],
          },
        },
        toolArguments: {
          pii: {
            fields: ['arguments'],
            starterPatterns: [],
            customPatterns: [
              {
                id: 'historical-tool',
                label: 'historical tool value',
                regex: 'PRIVATE-TOOL',
              },
            ],
          },
        },
      };
      const safeUserMessage = {
        role: 'user',
        isCreatedByUser: true,
        text: 'Safe historical question',
        messageId: 'safe-user',
        parentMessageId: Constants.NO_PARENT,
      };
      const assistantMessage = {
        role: 'assistant',
        isCreatedByUser: false,
        text: 'Model generated PRIVATE-PROSE',
        content: [
          {
            type: 'tool_call',
            tool_call: {
              name: 'lookup',
              args: { query: 'PRIVATE-TOOL' },
            },
          },
        ],
        messageId: 'assistant-with-tool',
        parentMessageId: 'safe-user',
      };
      const clientOptions = {
        ...options,
        req: { config: { filters } },
      };
      TestClient = initializeFakeClient(apiKey, clientOptions, [safeUserMessage, assistantMessage]);

      await expect(
        TestClient.sendMessage('Safe new message', {
          conversationId: 'tool-conversation',
          parentMessageId: 'assistant-with-tool',
        }),
      ).rejects.toMatchObject({
        code: 'content_filter_block',
        body: {
          source: 'tool_argument',
          field: 'arguments',
        },
      });
      expect(TestClient.buildMessages).toHaveBeenCalledTimes(1);
      expect(TestClient.sendCompletion).not.toHaveBeenCalled();

      const proseOnlyClient = initializeFakeClient(apiKey, clientOptions, [
        safeUserMessage,
        {
          ...assistantMessage,
          content: undefined,
        },
      ]);
      await expect(
        proseOnlyClient.sendMessage('Safe new message', {
          conversationId: 'prose-conversation',
          parentMessageId: 'assistant-with-tool',
        }),
      ).resolves.toEqual(expect.objectContaining({ isCreatedByUser: false }));
      expect(proseOnlyClient.buildMessages).toHaveBeenCalledTimes(1);
      expect(proseOnlyClient.sendCompletion).toHaveBeenCalledTimes(1);
    });

    test('resolves and inspects owner-scoped historical files before building messages', async () => {
      const historicalMessage = {
        role: 'user',
        isCreatedByUser: true,
        text: 'Use my file',
        files: [{ file_id: 'owned-file' }],
        messageId: 'historical-file-message',
        parentMessageId: Constants.NO_PARENT,
      };
      getFiles.mockReset();
      getFiles.mockResolvedValueOnce([
        {
          file_id: 'owned-file',
          filename: 'owned.txt',
          filepath: '/uploads/owned.txt',
          text: 'safe canonical file content',
          user: 'user-1',
        },
      ]);
      TestClient = initializeFakeClient(
        apiKey,
        {
          ...options,
          req: {
            user: { id: 'user-1', tenantId: 'tenant-a' },
            config: {
              filters: {
                files: {
                  pii: {
                    fields: ['extracted_text'],
                    starterPatterns: [],
                    uninspectable: 'block',
                  },
                },
              },
            },
          },
        },
        [historicalMessage],
      );

      await expect(
        TestClient.sendMessage('Safe new message', {
          conversationId: 'historical-file-conversation',
          parentMessageId: 'historical-file-message',
        }),
      ).resolves.toBeDefined();

      expect(getFiles).toHaveBeenCalledWith(
        {
          file_id: { $in: ['owned-file'] },
          user: 'user-1',
          tenantId: 'tenant-a',
        },
        {},
        {},
      );
      expect(TestClient.buildMessages).toHaveBeenCalled();
    });

    test('keeps the turn view of historical files that projection and steer replay read', async () => {
      const routedCsv = {
        file_id: 'csv-file',
        filename: 'sales.csv',
        filepath: '/uploads/sales.csv',
        type: 'text/csv',
        text: 'region,total',
        llmDeliveryPath: 'none',
        metadata: { destinationChosen: false },
        user: 'user-1',
      };
      getFiles.mockReset();
      getFiles.mockResolvedValueOnce([routedCsv]);
      TestClient = initializeFakeClient(
        apiKey,
        {
          ...options,
          agent: {
            provider: EModelEndpoint.openAI,
            fileConsumers: { executeCode: false, fileSearch: false },
          },
          req: {
            user: { id: 'user-1', tenantId: 'tenant-a' },
            config: {
              fileConfig: {
                endpoints: {
                  [EModelEndpoint.openAI]: {
                    defaultLLMDeliveryPath: { overrides: { 'text/csv': 'none' } },
                    textFallbackWithoutTools: true,
                  },
                },
              },
            },
          },
        },
        [
          {
            role: 'user',
            isCreatedByUser: true,
            text: 'Summarize my sheet',
            files: [{ file_id: 'csv-file' }],
            messageId: 'historical-csv-message',
            parentMessageId: Constants.NO_PARENT,
          },
        ],
      );

      TestClient.options.agent.deliveryRouting = resolveTurnDeliveryRouting({
        agent: TestClient.options.agent,
        config: TestClient.options.req.config,
      });
      await TestClient.sendMessage('And the totals?', {
        conversationId: 'historical-csv-conversation',
        parentMessageId: 'historical-csv-message',
      });

      expect(TestClient.authorizedHistoricalFiles.get('csv-file')).toEqual({
        ...routedCsv,
        llmDeliveryPath: 'text',
      });
      expect(routedCsv.llmDeliveryPath).toBe('none');
    });

    test('does not block a missing historical file omitted from the final payload', async () => {
      getFiles.mockReset();
      getFiles.mockResolvedValueOnce([]);
      TestClient = initializeFakeClient(
        apiKey,
        {
          ...options,
          req: {
            user: { id: 'user-1', tenantId: 'tenant-a' },
            config: {
              filters: {
                files: {
                  pii: {
                    fields: ['extracted_text'],
                    starterPatterns: [],
                    uninspectable: 'block',
                  },
                },
              },
            },
          },
        },
        [
          {
            role: 'user',
            isCreatedByUser: true,
            text: 'Use a foreign file',
            files: [{ file_id: 'foreign-file' }],
            messageId: 'foreign-file-message',
            parentMessageId: Constants.NO_PARENT,
          },
        ],
      );

      await expect(
        TestClient.sendMessage('Safe new message', {
          conversationId: 'foreign-file-conversation',
          parentMessageId: 'foreign-file-message',
        }),
      ).resolves.toEqual(expect.objectContaining({ isCreatedByUser: false }));
      expect(TestClient.buildMessages).toHaveBeenCalledTimes(1);
      expect(TestClient.sendCompletion).toHaveBeenCalledTimes(1);
    });

    test('surfaces historical file lookup failures instead of silently dropping context', async () => {
      getFiles.mockReset();
      getFiles.mockRejectedValueOnce(new Error('historical file lookup unavailable'));
      TestClient = initializeFakeClient(
        apiKey,
        {
          ...options,
          req: { user: { id: 'user-1', tenantId: 'tenant-a' }, config: {} },
        },
        [
          {
            role: 'user',
            isCreatedByUser: true,
            text: 'Use my historical file',
            files: [{ file_id: 'historical-file' }],
            messageId: 'historical-file-message',
            parentMessageId: Constants.NO_PARENT,
          },
        ],
      );

      await expect(
        TestClient.sendMessage('Safe new message', {
          conversationId: 'historical-file-error-conversation',
          parentMessageId: 'historical-file-message',
        }),
      ).rejects.toThrow('historical file lookup unavailable');
      expect(TestClient.buildMessages).not.toHaveBeenCalled();
      expect(TestClient.sendCompletion).not.toHaveBeenCalled();
    });

    test('ignores historical file refs when the endpoint does not resend files', async () => {
      getFiles.mockReset();
      TestClient = initializeFakeClient(
        apiKey,
        {
          ...options,
          resendFiles: false,
          req: {
            user: { id: 'user-1', tenantId: 'tenant-a' },
            config: {
              filters: {
                files: {
                  pii: {
                    fields: ['extracted_text'],
                    starterPatterns: [],
                    uninspectable: 'block',
                  },
                },
              },
            },
          },
        },
        [
          {
            role: 'user',
            isCreatedByUser: true,
            text: 'A prior turn referenced a file.',
            files: [{ file_id: 'deleted-historical-file' }],
            content: [
              {
                type: 'input_file',
                files: [{ file_id: 'part-file' }],
                image_file: { file_id: 'image-file' },
                file_id: 'direct-file',
                file: { file_id: 'nested-file' },
              },
            ],
            messageId: 'historical-file-message',
            parentMessageId: Constants.NO_PARENT,
          },
        ],
      );

      await expect(
        TestClient.sendMessage('Safe text-only continuation', {
          conversationId: 'no-file-replay-conversation',
          parentMessageId: 'historical-file-message',
        }),
      ).resolves.toBeDefined();

      expect(getFiles).not.toHaveBeenCalled();
      expect(TestClient.buildMessages).toHaveBeenCalled();
      const [modelMessages] = TestClient.buildMessages.mock.calls[0];
      expect(modelMessages[0]).not.toHaveProperty('files');
      expect(modelMessages[0].content[0]).toEqual({ type: 'input_file' });
      expect(TestClient.sendCompletion).toHaveBeenCalled();
    });

    test('keeps a materialized current attachment inspectable when historical replay is disabled', () => {
      const currentFile = {
        file_id: 'current-file',
        filename: 'safe.txt',
        text: 'Safe current attachment content',
      };
      TestClient = initializeFakeClient(apiKey, {
        ...options,
        resendFiles: false,
        attachments: [currentFile],
        req: {
          config: {
            filters: {
              files: {
                pii: {
                  fields: ['extracted_text'],
                  starterPatterns: [],
                  uninspectable: 'block',
                },
              },
            },
          },
        },
      });
      TestClient.message_file_map = { 'current-source': [currentFile] };
      TestClient.setModelBoundStoredMessages([
        {
          messageId: 'current-source',
          role: 'user',
          isCreatedByUser: true,
          text: 'Use the current file',
        },
      ]);

      expect(() =>
        TestClient.assertBuiltModelBoundContent([
          {
            role: 'user',
            content: 'Use the current file',
            additional_kwargs: { sourceMessageId: 'current-source' },
          },
        ]),
      ).not.toThrow();
    });

    test('should return chat history', async () => {
      TestClient = initializeFakeClient(apiKey, options, messageHistory);
      const chatMessages = await TestClient.loadHistory(conversationId, '2');
      expect(TestClient.currentMessages).toHaveLength(2);
      expect(chatMessages[0].text).toEqual('Hello');

      const chatMessages2 = await TestClient.loadHistory(conversationId, '3');
      expect(TestClient.currentMessages).toHaveLength(3);
      expect(chatMessages2[chatMessages2.length - 1].text).toEqual("What's up");
    });

    test('loadHistory should scope database reads to the current user', async () => {
      const user = 'user-123';
      TestClient = new FakeClient(apiKey, options);
      TestClient.user = user;
      getMessages.mockResolvedValueOnce([
        {
          role: 'user',
          isCreatedByUser: true,
          text: 'Hello',
          messageId: '1',
          conversationId,
        },
      ]);

      const chatMessages = await TestClient.loadHistory(conversationId, '1');

      expect(getMessages).toHaveBeenCalledWith({ conversationId, user });
      expect(chatMessages).toHaveLength(1);
      expect(chatMessages[0].text).toBe('Hello');
    });

    /* Most of the new sendMessage logic revolving around edited/continued AI messages
     *  can be summarized by the following test. The condition will load the entire history up to
     *  the message that is being edited, which will trigger the AI API to 'continue' the response.
     *  The 'userMessage' is only passed by convention and is not necessary for the generation.
     */
    it('should not push userMessage to currentMessages when isEdited is true and vice versa', async () => {
      const overrideParentMessageId = 'user-message-id';
      const responseMessageId = 'response-message-id';
      const newHistory = messageHistory.slice();
      newHistory.push({
        role: 'assistant',
        isCreatedByUser: false,
        text: 'test message',
        messageId: responseMessageId,
        parentMessageId: '3',
      });

      TestClient = initializeFakeClient(apiKey, options, newHistory);
      const sendMessageOptions = {
        isEdited: true,
        overrideParentMessageId,
        parentMessageId: '3',
        responseMessageId,
      };

      await TestClient.sendMessage('test message', sendMessageOptions);
      const currentMessages = TestClient.currentMessages;
      expect(currentMessages[currentMessages.length - 1].messageId).not.toEqual(
        overrideParentMessageId,
      );

      // Test the opposite case
      sendMessageOptions.isEdited = false;
      await TestClient.sendMessage('test message', sendMessageOptions);
      const currentMessages2 = TestClient.currentMessages;
      expect(currentMessages2[currentMessages2.length - 1].messageId).toEqual(
        overrideParentMessageId,
      );
    });

    it('honors response and user message IDs preallocated before initialization', async () => {
      TestClient = initializeFakeClient(apiKey, options, messageHistory);

      const result = await TestClient.handleStartMethods('request-scoped MCP', {
        conversationId,
        parentMessageId: '3',
        preallocatedUserMessageId: 'preallocated-user',
        preallocatedResponseMessageId: 'preallocated-response',
      });

      expect(result.userMessage.messageId).toBe('preallocated-user');
      expect(result.responseMessageId).toBe('preallocated-response');
      expect(TestClient.responseMessageId).toBe('preallocated-response');
    });

    it('applies edited reasoning content from its typed payload before regeneration', async () => {
      const responseMessageId = 'response-with-reasoning';
      const newHistory = [
        ...messageHistory,
        {
          role: 'assistant',
          isCreatedByUser: false,
          messageId: responseMessageId,
          parentMessageId: '3',
          content: [
            {
              type: ContentTypes.THINK,
              think: 'Original reasoning',
              phase: 'analysis',
              reasoning_label: 'Inspecting the original path',
              reasoning_label_step_id: 'old-step',
              reasoning_label_attempts: 2,
              reasoning_label_submitted_chars: 18,
              reasoning_label_revision: 2,
              reasoning_label_status: 'complete',
            },
            { type: ContentTypes.TEXT, text: 'Original response' },
          ],
        },
      ];

      TestClient = initializeFakeClient(apiKey, options, newHistory);
      await TestClient.sendMessage('test message', {
        isEdited: true,
        overrideParentMessageId: 'user-message-id',
        parentMessageId: '3',
        responseMessageId,
        editedContent: {
          index: 0,
          type: ContentTypes.THINK,
          [ContentTypes.THINK]: 'Updated reasoning',
        },
      });

      const editedResponse = TestClient.currentMessages[TestClient.currentMessages.length - 1];
      expect(editedResponse.content[0]).toEqual({
        type: ContentTypes.THINK,
        think: 'Updated reasoning',
        phase: 'analysis',
      });
    });

    test('setOptions is called with the correct arguments only when replaceOptions is set to true', async () => {
      TestClient.setOptions = jest.fn();
      const opts = { conversationId: '123', parentMessageId: '456', replaceOptions: true };
      await TestClient.sendMessage('Hello, world!', opts);
      expect(TestClient.setOptions).toHaveBeenCalledWith(opts);
      TestClient.setOptions.mockClear();
    });

    test('loadHistory is called with the correct arguments', async () => {
      const opts = { conversationId: '123', parentMessageId: '456' };
      await TestClient.sendMessage('Hello, world!', opts);
      expect(TestClient.loadHistory).toHaveBeenCalledWith(
        opts.conversationId,
        opts.parentMessageId,
      );
    });

    test('getReqData is called with the correct arguments', async () => {
      const getReqData = jest.fn();
      const opts = { getReqData };
      const response = await TestClient.sendMessage('Hello, world!', opts);
      expect(getReqData).toHaveBeenCalledWith(
        expect.objectContaining({
          userMessage: expect.objectContaining({ text: 'Hello, world!' }),
          conversationId: response.conversationId,
          responseMessageId: response.messageId,
        }),
      );
    });

    test('onStart is called with the correct arguments', async () => {
      const onStart = jest.fn();
      const opts = { onStart };
      await TestClient.sendMessage('Hello, world!', opts);

      expect(onStart).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Hello, world!' }),
        expect.any(String),
        /** `isNewConvo` */
        true,
      );
    });

    test('saveMessageToDatabase is called with the correct arguments', async () => {
      const saveOptions = TestClient.getSaveOptions();
      const user = {};
      const opts = { user };
      const saveSpy = jest.spyOn(TestClient, 'saveMessageToDatabase');
      await TestClient.sendMessage('Hello, world!', opts);
      expect(saveSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sender: expect.any(String),
          text: expect.any(String),
          isCreatedByUser: expect.any(Boolean),
          messageId: expect.any(String),
          parentMessageId: expect.any(String),
          conversationId: expect.any(String),
        }),
        saveOptions,
        user,
      );
    });

    test('does not start the completed response write when terminal ownership is denied', async () => {
      const hookStarted = deferred();
      const terminalDecision = deferred();
      const beforeResponsePersistence = jest.fn(() => {
        hookStarted.resolve();
        return terminalDecision.promise;
      });
      const saveSpy = jest.spyOn(TestClient, 'saveMessageToDatabase');

      const responsePromise = TestClient.sendMessage('Race Stop against completion.', {
        user: {},
        beforeResponsePersistence,
      });
      await hookStarted.promise;

      expect(beforeResponsePersistence).toHaveBeenCalledTimes(1);
      expect(
        saveSpy.mock.calls.filter(([message]) => message?.isCreatedByUser === false),
      ).toHaveLength(0);

      terminalDecision.resolve(false);
      const response = await responsePromise;

      expect(beforeResponsePersistence).toHaveBeenCalledWith(response);
      expect(
        saveSpy.mock.calls.filter(([message]) => message?.isCreatedByUser === false),
      ).toHaveLength(0);
      expect(TestClient.savedMessageIds.has(response.messageId)).toBe(false);
      await expect(response.databasePromise).resolves.toEqual({ persistenceSkipped: true });
    });

    test('starts the completed response write only after terminal ownership is granted', async () => {
      const hookStarted = deferred();
      const terminalDecision = deferred();
      const beforeResponsePersistence = jest.fn(() => {
        hookStarted.resolve();
        return terminalDecision.promise;
      });
      const saveSpy = jest.spyOn(TestClient, 'saveMessageToDatabase');

      const responsePromise = TestClient.sendMessage('Complete after winning ownership.', {
        user: {},
        beforeResponsePersistence,
      });
      await hookStarted.promise;
      expect(
        saveSpy.mock.calls.filter(([message]) => message?.isCreatedByUser === false),
      ).toHaveLength(0);

      terminalDecision.resolve(true);
      const response = await responsePromise;

      expect(
        saveSpy.mock.calls.filter(([message]) => message?.isCreatedByUser === false),
      ).toHaveLength(1);
      await expect(response.databasePromise).resolves.toEqual(expect.any(Object));
    });

    test('persists the generation-time Langfuse sampling decision for agent responses', async () => {
      const previousSampleRate = process.env.LANGFUSE_SAMPLE_RATE;
      process.env.LANGFUSE_SAMPLE_RATE = '0';
      TestClient.options.endpoint = 'agents';
      const saveSpy = jest.spyOn(TestClient, 'saveMessageToDatabase');

      try {
        const response = await TestClient.sendMessage('Hello, world!', { user: {} });

        expect(response.langfuseSampled).toBe(false);
        expect(response.langfuseDestinationIds).toEqual([]);
        expect(saveSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            langfuseSampled: false,
            langfuseDestinationIds: [],
          }),
          expect.any(Object),
          expect.any(Object),
        );
      } finally {
        if (previousSampleRate == null) {
          delete process.env.LANGFUSE_SAMPLE_RATE;
        } else {
          process.env.LANGFUSE_SAMPLE_RATE = previousSampleRate;
        }
      }
    });

    test('persists the Langfuse sampling decision for agent clients using a provider endpoint', async () => {
      const previousSampleRate = process.env.LANGFUSE_SAMPLE_RATE;
      const previousClientName = TestClient.clientName;
      const previousEndpoint = TestClient.options.endpoint;
      process.env.LANGFUSE_SAMPLE_RATE = '0';
      TestClient.clientName = 'agents';
      TestClient.options.endpoint = 'bedrock';
      const saveSpy = jest.spyOn(TestClient, 'saveMessageToDatabase');

      try {
        const response = await TestClient.sendMessage('Hello, world!', { user: {} });

        expect(response.langfuseSampled).toBe(false);
        expect(response.langfuseDestinationIds).toEqual([]);
        expect(saveSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            endpoint: 'bedrock',
            langfuseSampled: false,
            langfuseDestinationIds: [],
          }),
          expect.any(Object),
          expect.any(Object),
        );
      } finally {
        if (previousSampleRate == null) {
          delete process.env.LANGFUSE_SAMPLE_RATE;
        } else {
          process.env.LANGFUSE_SAMPLE_RATE = previousSampleRate;
        }
        TestClient.clientName = previousClientName;
        TestClient.options.endpoint = previousEndpoint;
      }
    });

    test('persists no Langfuse destination when a sampled trace has no configured export', async () => {
      const envKeys = [
        'LANGFUSE_PUBLIC_KEY',
        'LANGFUSE_SECRET_KEY',
        'LANGFUSE_FANOUT_ENABLED',
        'LANGFUSE_FANOUT_COLLECTOR_URL',
        'TENANT_ISOLATION_STRICT',
      ];
      const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
      const previousSampleRate = process.env.LANGFUSE_SAMPLE_RATE;
      envKeys.forEach((key) => delete process.env[key]);
      process.env.LANGFUSE_SAMPLE_RATE = '1';
      TestClient.options.endpoint = 'agents';
      const saveSpy = jest.spyOn(TestClient, 'saveMessageToDatabase');

      try {
        const response = await TestClient.sendMessage('Hello, world!', { user: {} });

        expect(response.langfuseSampled).toBe(true);
        expect(response.langfuseDestinationIds).toEqual([]);
        expect(saveSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            langfuseSampled: true,
            langfuseDestinationIds: [],
          }),
          expect.any(Object),
          expect.any(Object),
        );
      } finally {
        for (const [key, value] of Object.entries(previousEnv)) {
          if (value == null) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
        if (previousSampleRate == null) {
          delete process.env.LANGFUSE_SAMPLE_RATE;
        } else {
          process.env.LANGFUSE_SAMPLE_RATE = previousSampleRate;
        }
      }
    });

    test('should handle existing conversation when getConvo retrieves one', async () => {
      const existingConvo = {
        conversationId: 'existing-convo-id',
        endpoint: 'openai',
        endpointType: 'openai',
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'user', content: 'Existing message 1' },
          { role: 'assistant', content: 'Existing response 1' },
        ],
        temperature: 1,
      };

      const { temperature: _temp, ...newConvo } = existingConvo;

      const user = {
        id: 'user-id',
      };

      getConvo.mockResolvedValue(existingConvo);
      saveConvo.mockResolvedValue(newConvo);

      TestClient = initializeFakeClient(
        apiKey,
        {
          ...options,
          req: {
            user,
          },
        },
        [],
      );

      const saveSpy = jest.spyOn(TestClient, 'saveMessageToDatabase');

      const newMessage = 'New message in existing conversation';
      const response = await TestClient.sendMessage(newMessage, {
        user,
        conversationId: existingConvo.conversationId,
      });

      expect(getConvo).toHaveBeenCalledWith(user.id, existingConvo.conversationId);
      expect(TestClient.conversationId).toBe(existingConvo.conversationId);
      expect(response.conversationId).toBe(existingConvo.conversationId);
      expect(TestClient.fetchedConvo).toBe(true);

      expect(saveSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: existingConvo.conversationId,
          text: newMessage,
        }),
        expect.any(Object),
        expect.any(Object),
      );

      expect(saveConvo).toHaveBeenCalledTimes(2);
      expect(saveConvo).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          conversationId: existingConvo.conversationId,
        }),
        expect.objectContaining({
          context: 'api/app/clients/BaseClient.js - saveMessageToDatabase #saveConvo',
          unsetFields: {
            temperature: 1,
          },
        }),
      );

      await TestClient.sendMessage('Another message', {
        conversationId: existingConvo.conversationId,
      });
      expect(getConvo).toHaveBeenCalledTimes(1);
    });

    test('should correctly handle existing conversation and unset fields appropriately', async () => {
      const existingConvo = {
        conversationId: 'existing-convo-id',
        endpoint: 'openai',
        endpointType: 'openai',
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'user', content: 'Existing message 1' },
          { role: 'assistant', content: 'Existing response 1' },
        ],
        title: 'Existing Conversation',
        someExistingField: 'existingValue',
        anotherExistingField: 'anotherValue',
        temperature: 0.7,
        modelLabel: 'GPT-3.5',
        pinned: true,
        subagentThread: {
          rootConversationId: 'root-conversation',
          parentConversationId: 'parent-conversation',
          parentMessageId: 'parent-message',
          parentToolCallId: 'parent-tool-call',
          subagentType: 'researcher',
          subagentKind: 'agent',
          depth: 1,
        },
      };

      getConvo.mockResolvedValue(existingConvo);
      saveConvo.mockResolvedValue(existingConvo);

      TestClient = initializeFakeClient(
        apiKey,
        {
          ...options,
          modelOptions: {
            model: 'gpt-4',
            temperature: 0.5,
          },
        },
        [],
      );

      const newMessage = 'New message in existing conversation';
      await TestClient.sendMessage(newMessage, {
        conversationId: existingConvo.conversationId,
      });

      expect(saveConvo).toHaveBeenCalledTimes(2);

      const saveConvoCall = saveConvo.mock.calls[0];
      const [, savedFields, saveOptions] = saveConvoCall;

      // Instead of checking all excludedKeys, we'll just check specific fields
      // that we know should be excluded
      expect(savedFields).not.toHaveProperty('messages');
      expect(savedFields).not.toHaveProperty('title');

      // Only check that someExistingField is in unsetFields
      expect(saveOptions.unsetFields).toHaveProperty('someExistingField', 1);
      expect(saveOptions.unsetFields).not.toHaveProperty('subagentThread');
      // Sidebar metadata is never part of endpointOptions, so sweeping it would
      // unpin a chat every time it received a message.
      expect(saveOptions.unsetFields).not.toHaveProperty('pinned');

      // Mock saveConvo to return the expected fields
      saveConvo.mockImplementation((req, fields) => {
        return Promise.resolve({
          ...fields,
          endpoint: 'openai',
          endpointType: 'openai',
          model: 'gpt-4',
          temperature: 0.5,
        });
      });

      // Only check the conversationId since that's the only field we can be sure about
      expect(savedFields).toHaveProperty('conversationId', 'existing-convo-id');

      expect(TestClient.fetchedConvo).toBe(true);

      await TestClient.sendMessage('Another message', {
        conversationId: existingConvo.conversationId,
      });

      expect(getConvo).toHaveBeenCalledTimes(1);

      const secondSaveConvoCall = saveConvo.mock.calls[1];
      expect(secondSaveConvoCall[2]).toHaveProperty('unsetFields', {});
    });

    test('sendCompletion is called with the correct arguments', async () => {
      const payload = {}; // Mock payload
      TestClient.buildMessages.mockReturnValue({ prompt: payload, tokenCountMap: null });
      const opts = {};
      await TestClient.sendMessage('Hello, world!', opts);
      expect(TestClient.sendCompletion).toHaveBeenCalledWith(payload, opts);
    });

    test('records history and message-build startup milestones', async () => {
      const startupTelemetry = { mark: jest.fn() };
      TestClient.options.startupTelemetry = startupTelemetry;

      await TestClient.sendMessage('Hello, world!', {});

      expect(startupTelemetry.mark.mock.calls.map(([milestone]) => milestone)).toEqual([
        'history_loaded',
        'messages_built',
      ]);
    });

    test('getTokenCount for response is called with the correct arguments', async () => {
      const tokenCountMap = {}; // Mock tokenCountMap
      TestClient.buildMessages.mockReturnValue({ prompt: [], tokenCountMap });
      TestClient.getTokenCountForResponse = jest.fn();
      const response = await TestClient.sendMessage('Hello, world!', {});
      expect(TestClient.getTokenCountForResponse).toHaveBeenCalledWith(response);
    });

    test('returns an object with the correct shape', async () => {
      const response = await TestClient.sendMessage('Hello, world!', {});
      expect(response).toEqual(
        expect.objectContaining({
          sender: expect.any(String),
          text: expect.any(String),
          isCreatedByUser: expect.any(Boolean),
          messageId: expect.any(String),
          parentMessageId: expect.any(String),
          conversationId: expect.any(String),
        }),
      );
    });

    test('saveMessageToDatabase appends the saved message id instead of rebuilding the array', async () => {
      const savedId = new (require('mongoose').Types.ObjectId)();
      saveMessage.mockResolvedValueOnce({ _id: savedId, messageId: 'saved-1' });
      saveConvo.mockResolvedValueOnce({ conversationId });

      await TestClient.saveMessageToDatabase(
        { messageId: 'saved-1', conversationId, text: 'hi' },
        TestClient.getSaveOptions(),
      );

      expect(saveConvo).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ appendMessageIds: [savedId] }),
      );
    });

    test('saveMessageToDatabase rebuilds the array when the saved message has no _id', async () => {
      saveMessage.mockResolvedValueOnce({ messageId: 'saved-2' });
      saveConvo.mockResolvedValueOnce({ conversationId });

      await TestClient.saveMessageToDatabase(
        { messageId: 'saved-2', conversationId, text: 'hi' },
        TestClient.getSaveOptions(),
      );

      const metadata = saveConvo.mock.calls[saveConvo.mock.calls.length - 1][2];
      expect(metadata).not.toHaveProperty('appendMessageIds');
    });

    test('saveMessageToDatabase returns early when this.options is null (client disposed)', async () => {
      const savedOptions = TestClient.options;
      TestClient.options = null;
      saveMessage.mockClear();

      const result = await TestClient.saveMessageToDatabase(
        { messageId: 'msg-1', conversationId: 'conv-1', isCreatedByUser: true, text: 'hi' },
        {},
        null,
      );

      expect(result).toEqual({});
      expect(saveMessage).not.toHaveBeenCalled();

      TestClient.options = savedOptions;
    });

    test('saveMessageToDatabase uses snapshot of options, immune to mid-await disposal', async () => {
      const savedOptions = TestClient.options;
      TestClient.options = {
        ...savedOptions,
        endpoint: 'agents',
        agent: { id: 'agent_persisted' },
      };
      saveMessage.mockClear();
      saveConvo.mockClear();

      // Make db.saveMessage yield, simulating I/O suspension during which disposal occurs
      saveMessage.mockImplementation(async (_reqCtx, msgData) => {
        // Simulate disposeClient nullifying client.options while awaiting
        TestClient.options = null;
        return msgData;
      });
      saveConvo.mockResolvedValue({ conversationId: 'conv-1' });

      const result = await TestClient.saveMessageToDatabase(
        { messageId: 'msg-1', conversationId: 'conv-1', isCreatedByUser: true, text: 'hi' },
        { endpoint: 'agents', agent_id: 'agent_persisted' },
        null,
      );

      // Should complete without TypeError, using the snapshotted options
      expect(result).toHaveProperty('message');
      expect(result).toHaveProperty('conversation');
      expect(saveMessage).toHaveBeenCalled();
      expect(saveConvo).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ initialAgentId: 'agent_persisted' }),
      );

      TestClient.options = savedOptions;
      saveMessage.mockReset();
      saveConvo.mockReset();
    });

    test('saveMessageToDatabase reuses conversation resolved on the request', async () => {
      const existingConvo = {
        conversationId: 'cached-convo-id',
        endpoint: 'openai',
        endpointType: 'openai',
        temperature: 0.7,
        isTemporary: true,
        expiredAt: new Date('2030-01-01T00:00:00.000Z'),
      };
      const user = { id: 'user-id' };
      const req = { user, body: { isTemporary: false }, resolvedConversation: existingConvo };

      getConvo.mockClear();
      saveMessage.mockResolvedValue({ messageId: 'msg-1' });
      saveConvo.mockResolvedValue(existingConvo);

      TestClient = initializeFakeClient(apiKey, { ...options, endpoint: 'openai', req }, []);

      await TestClient.saveMessageToDatabase(
        {
          messageId: 'msg-1',
          conversationId: existingConvo.conversationId,
          isCreatedByUser: true,
          text: 'hi',
        },
        { endpoint: 'openai' },
        user,
      );

      expect(getConvo).not.toHaveBeenCalled();
      expect(saveMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          isTemporary: true,
          expiredAt: existingConvo.expiredAt,
        }),
        expect.any(Object),
        expect.any(Object),
      );
      expect(req.resolvedConversation).toBe(existingConvo);
      expect(TestClient.fetchedConvo).toBe(true);
      expect(saveConvo).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ conversationId: existingConvo.conversationId }),
        expect.objectContaining({
          unsetFields: expect.objectContaining({ temperature: 1 }),
        }),
      );
      await TestClient.saveMessageToDatabase(
        { messageId: 'response-1', conversationId: existingConvo.conversationId, text: 'reply' },
        { endpoint: 'openai' },
        user,
      );
      for (const save of [saveMessage, saveConvo]) {
        expect(save).toHaveBeenLastCalledWith(
          expect.objectContaining({ isTemporary: true, expiredAt: existingConvo.expiredAt }),
          expect.any(Object),
          expect.any(Object),
        );
      }
      expect(getConvo).not.toHaveBeenCalled();
    });

    test('userMessagePromise is awaited before saving response message', async () => {
      // Mock the saveMessageToDatabase method
      TestClient.saveMessageToDatabase = jest.fn().mockImplementation(() => {
        return new Promise((resolve) => setTimeout(resolve, 100)); // Simulate a delay
      });

      // Send a message
      const messagePromise = TestClient.sendMessage('Hello, world!');

      // Wait a short time to ensure the user message save has started
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Check that saveMessageToDatabase has been called once (for the user message)
      expect(TestClient.saveMessageToDatabase).toHaveBeenCalledTimes(1);

      // Wait for the message to be fully processed
      await messagePromise;

      // Check that saveMessageToDatabase has been called twice (once for user message, once for response)
      expect(TestClient.saveMessageToDatabase).toHaveBeenCalledTimes(2);

      // Check the order of calls
      const calls = TestClient.saveMessageToDatabase.mock.calls;
      expect(calls[0][0].isCreatedByUser).toBe(true); // First call should be for user message
      expect(calls[1][0].isCreatedByUser).toBe(false); // Second call should be for response message
    });
  });

  describe('recordTokenUsage model assignment', () => {
    test('should pass this.model to recordTokenUsage, not the agent ID from responseMessage.model', async () => {
      const actualModel = 'claude-opus-4-5';
      const agentId = 'agent_p5Z_IU6EIxBoqn1BoqLBp';

      TestClient.model = actualModel;
      TestClient.options.endpoint = 'agents';
      TestClient.options.agent = { id: agentId };

      TestClient.getTokenCountForResponse = jest.fn().mockReturnValue(50);
      TestClient.recordTokenUsage = jest.fn().mockResolvedValue(undefined);
      TestClient.buildMessages.mockReturnValue({
        prompt: [],
        tokenCountMap: { res: 50 },
      });

      await TestClient.sendMessage('Hello', {});

      expect(TestClient.recordTokenUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          model: actualModel,
        }),
      );

      const callArgs = TestClient.recordTokenUsage.mock.calls[0][0];
      expect(callArgs.model).not.toBe(agentId);
    });

    test('should pass this.model even when this.model differs from modelOptions.model', async () => {
      const instanceModel = 'gpt-4o';
      TestClient.model = instanceModel;
      TestClient.modelOptions = { model: 'gpt-4o-mini' };

      TestClient.getTokenCountForResponse = jest.fn().mockReturnValue(50);
      TestClient.recordTokenUsage = jest.fn().mockResolvedValue(undefined);
      TestClient.buildMessages.mockReturnValue({
        prompt: [],
        tokenCountMap: { res: 50 },
      });

      await TestClient.sendMessage('Hello', {});

      expect(TestClient.recordTokenUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          model: instanceModel,
        }),
      );
    });
  });

  /**
   * The `transactions.enabled` guard lives in `createTransaction`, which reads it off
   * the object it is handed. Dropping the config anywhere between here and there
   * silently re-enables the writes rather than failing, so pin the wiring itself.
   */
  describe('recordTokenUsage transactions config', () => {
    let priorEndpoint;
    let priorEndpointType;

    const arrangeFallbackPath = () => {
      TestClient.getTokenCountForResponse = jest.fn().mockReturnValue(50);
      TestClient.recordTokenUsage = jest.fn().mockResolvedValue(undefined);
      TestClient.buildMessages.mockReturnValue({
        prompt: [],
        tokenCountMap: { res: 50 },
      });
    };

    /** `options` is shared across this file's tests, so an endpoint left behind by an earlier
     * case would route the balance-enabled arrangement into `checkBalance`. */
    beforeEach(() => {
      priorEndpoint = TestClient.options.endpoint;
      priorEndpointType = TestClient.options.endpointType;
      delete TestClient.options.endpoint;
      delete TestClient.options.endpointType;
    });

    afterEach(() => {
      delete TestClient.options.req;
      TestClient.options.endpoint = priorEndpoint;
      TestClient.options.endpointType = priorEndpointType;
    });

    test('should forward the resolved transactions config to recordTokenUsage', async () => {
      TestClient.options.req = { config: { transactions: { enabled: false } } };
      arrangeFallbackPath();

      await TestClient.sendMessage('Hello', {});

      expect(TestClient.recordTokenUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          transactions: { enabled: false },
        }),
      );
    });

    test('should default to enabled transactions when no app config is present', async () => {
      arrangeFallbackPath();

      await TestClient.sendMessage('Hello', {});

      expect(TestClient.recordTokenUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          transactions: { enabled: true },
        }),
      );
    });

    test('should forward transactions as enabled when balance tracking overrides the setting', async () => {
      TestClient.options.req = {
        config: { transactions: { enabled: false }, balance: { enabled: true } },
      };
      arrangeFallbackPath();

      await TestClient.sendMessage('Hello', {});

      expect(TestClient.recordTokenUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          transactions: { enabled: true },
        }),
      );
    });
  });

  describe('balance reservation lifecycle', () => {
    let priorEndpoint;
    let priorEndpointType;
    let events;

    beforeEach(() => {
      priorEndpoint = TestClient.options.endpoint;
      priorEndpointType = TestClient.options.endpointType;
      TestClient.options.endpoint = EModelEndpoint.openAI;
      delete TestClient.options.endpointType;
      TestClient.options.req = { config: { balance: { enabled: true } } };

      events = [];
      getMultiplier.mockReturnValue(1);
      reserveBalance.mockImplementation(async () => {
        events.push('reserve');
        return { reserved: true, balance: 1000 };
      });
      releaseBalanceReservation.mockImplementation(async () => {
        events.push('release');
      });
      TestClient.sendCompletion.mockImplementation(async () => {
        events.push('completion');
        return { completion: 'Mock response text', metadata: undefined };
      });
      TestClient.getTokenCountForResponse = jest.fn().mockReturnValue(50);
      TestClient.recordTokenUsage = jest.fn(async () => {
        events.push('usage');
      });
      TestClient.buildMessages.mockReturnValue({
        prompt: [],
        tokenCountMap: { res: 50 },
      });
    });

    afterEach(() => {
      delete TestClient.options.req;
      TestClient.options.endpoint = priorEndpoint;
      TestClient.options.endpointType = priorEndpointType;
    });

    test('releases the reservation once the response usage is recorded, before persistence', async () => {
      const beforeResponsePersistence = jest.fn(async () => {
        events.push('persist');
        return true;
      });

      await TestClient.sendMessage('Hello', { beforeResponsePersistence });

      expect(events).toEqual(['reserve', 'completion', 'usage', 'release', 'persist']);
      const [{ reservationId, amount }] = reserveBalance.mock.calls[0];
      expect(releaseBalanceReservation).toHaveBeenCalledTimes(1);
      expect(releaseBalanceReservation).toHaveBeenCalledWith({
        user: TestClient.user,
        reservationId,
        amount,
      });
    });

    test('releases the reservation when the completion fails', async () => {
      TestClient.sendCompletion.mockRejectedValue(new Error('provider unavailable'));

      await expect(TestClient.sendMessage('Hello', {})).rejects.toThrow('provider unavailable');

      expect(events).toEqual(['reserve', 'release']);
    });

    test('releases the reservation when work after the completion fails', async () => {
      TestClient.recordTokenUsage.mockRejectedValue(new Error('usage write failed'));

      await expect(TestClient.sendMessage('Hello', {})).rejects.toThrow('usage write failed');

      expect(events).toEqual(['reserve', 'completion', 'release']);
    });

    test('takes no reservation when the balance check refuses the request', async () => {
      reserveBalance.mockResolvedValue({ reserved: false, balance: 0 });

      await expect(TestClient.sendMessage('Hello', {})).rejects.toThrow();

      expect(TestClient.sendCompletion).not.toHaveBeenCalled();
      expect(releaseBalanceReservation).not.toHaveBeenCalled();
    });
  });

  describe('getMessagesWithinTokenLimit with instructions', () => {
    test('should always include instructions when present', async () => {
      TestClient.maxContextTokens = 50;
      const instructions = {
        role: 'system',
        content: 'System instructions',
        tokenCount: 20,
      };

      const messages = [
        instructions,
        { role: 'user', content: 'Hello', tokenCount: 10 },
        { role: 'assistant', content: 'Hi there', tokenCount: 15 },
      ];

      const result = await TestClient.getMessagesWithinTokenLimit({
        messages,
        instructions,
      });

      expect(result.context[0]).toBe(instructions);
      expect(result.remainingContextTokens).toBe(2);
    });

    test('should handle case when messages exceed limit but instructions must be preserved', async () => {
      TestClient.maxContextTokens = 30;
      const instructions = {
        role: 'system',
        content: 'System instructions',
        tokenCount: 20,
      };

      const messages = [
        instructions,
        { role: 'user', content: 'Hello', tokenCount: 10 },
        { role: 'assistant', content: 'Hi there', tokenCount: 15 },
      ];

      const result = await TestClient.getMessagesWithinTokenLimit({
        messages,
        instructions,
      });

      // Should only include instructions and the last message that fits
      expect(result.context).toHaveLength(1);
      expect(result.context[0].content).toBe(instructions.content);
      expect(result.messagesToRefine).toHaveLength(2);
      expect(result.remainingContextTokens).toBe(7); // 30 - 20 - 3 (assistant label)
    });

    test('should work correctly without instructions (1/2)', async () => {
      TestClient.maxContextTokens = 50;
      const messages = [
        { role: 'user', content: 'Hello', tokenCount: 10 },
        { role: 'assistant', content: 'Hi there', tokenCount: 15 },
      ];

      const result = await TestClient.getMessagesWithinTokenLimit({
        messages,
      });

      expect(result.context).toHaveLength(2);
      expect(result.remainingContextTokens).toBe(22); // 50 - 10 - 15 - 3(assistant label)
      expect(result.messagesToRefine).toHaveLength(0);
    });

    test('should work correctly without instructions (2/2)', async () => {
      TestClient.maxContextTokens = 30;
      const messages = [
        { role: 'user', content: 'Hello', tokenCount: 10 },
        { role: 'assistant', content: 'Hi there', tokenCount: 20 },
      ];

      const result = await TestClient.getMessagesWithinTokenLimit({
        messages,
      });

      expect(result.context).toHaveLength(1);
      expect(result.remainingContextTokens).toBe(7);
      expect(result.messagesToRefine).toHaveLength(1);
    });

    test('should handle case when only instructions fit within limit', async () => {
      TestClient.maxContextTokens = 25;
      const instructions = {
        role: 'system',
        content: 'System instructions',
        tokenCount: 20,
      };

      const messages = [
        instructions,
        { role: 'user', content: 'Hello', tokenCount: 10 },
        { role: 'assistant', content: 'Hi there', tokenCount: 15 },
      ];

      const result = await TestClient.getMessagesWithinTokenLimit({
        messages,
        instructions,
      });

      expect(result.context).toHaveLength(1);
      expect(result.context[0]).toBe(instructions);
      expect(result.messagesToRefine).toHaveLength(2);
      expect(result.remainingContextTokens).toBe(2); // 25 - 20 - 3(assistant label)
    });
  });

  describe('sendMessage file population', () => {
    const attachment = {
      file_id: 'file-abc',
      filename: 'image.png',
      filepath: '/uploads/image.png',
      type: 'image/png',
      bytes: 1024,
      object: 'file',
      user: 'user-1',
      embedded: false,
      usage: 0,
      text: 'large ocr blob that should be stripped',
      _id: 'mongo-id-1',
    };

    beforeEach(() => {
      TestClient.options.req = { body: { files: [{ file_id: 'file-abc' }] } };
      TestClient.options.attachments = [attachment];
    });

    test('populates userMessage.files before saveMessageToDatabase is called', async () => {
      TestClient.saveMessageToDatabase = jest.fn().mockImplementation((msg) => {
        return Promise.resolve({ message: msg });
      });

      await TestClient.sendMessage('Hello');

      const userSave = TestClient.saveMessageToDatabase.mock.calls.find(
        ([msg]) => msg.isCreatedByUser,
      );
      expect(userSave).toBeDefined();
      expect(userSave[0].files).toBeDefined();
      expect(userSave[0].files).toHaveLength(1);
      expect(userSave[0].files[0].file_id).toBe('file-abc');
    });

    test('strips text and _id from files before saving', async () => {
      TestClient.saveMessageToDatabase = jest.fn().mockResolvedValue({ message: {} });

      await TestClient.sendMessage('Hello');

      const userSave = TestClient.saveMessageToDatabase.mock.calls.find(
        ([msg]) => msg.isCreatedByUser,
      );
      expect(userSave[0].files[0].text).toBeUndefined();
      expect(userSave[0].files[0]._id).toBeUndefined();
      expect(userSave[0].files[0].filename).toBe('image.png');
    });

    test('deletes image_urls from userMessage when files are present', async () => {
      TestClient.saveMessageToDatabase = jest.fn().mockResolvedValue({ message: {} });
      TestClient.options.attachments = [
        { ...attachment, image_urls: ['data:image/png;base64,...'] },
      ];

      await TestClient.sendMessage('Hello');

      const userSave = TestClient.saveMessageToDatabase.mock.calls.find(
        ([msg]) => msg.isCreatedByUser,
      );
      expect(userSave[0].image_urls).toBeUndefined();
    });

    test('does not set files when no attachments match request file IDs', async () => {
      TestClient.options.req = { body: { files: [{ file_id: 'file-nomatch' }] } };
      TestClient.saveMessageToDatabase = jest.fn().mockResolvedValue({ message: {} });

      await TestClient.sendMessage('Hello');

      const userSave = TestClient.saveMessageToDatabase.mock.calls.find(
        ([msg]) => msg.isCreatedByUser,
      );
      expect(userSave[0].files).toBeUndefined();
    });

    test('skips file population when attachments is not an array (Promise case)', async () => {
      TestClient.options.attachments = Promise.resolve([attachment]);
      TestClient.saveMessageToDatabase = jest.fn().mockResolvedValue({ message: {} });

      await TestClient.sendMessage('Hello');

      const userSave = TestClient.saveMessageToDatabase.mock.calls.find(
        ([msg]) => msg.isCreatedByUser,
      );
      expect(userSave[0].files).toBeUndefined();
    });

    test('skips file population when skipSaveUserMessage is true', async () => {
      TestClient.skipSaveUserMessage = true;
      TestClient.saveMessageToDatabase = jest.fn().mockResolvedValue({ message: {} });

      await TestClient.sendMessage('Hello');

      const userSave = TestClient.saveMessageToDatabase.mock.calls.find(
        ([msg]) => msg?.isCreatedByUser,
      );
      expect(userSave).toBeUndefined();
    });

    test('ignores file_id: undefined entries in req.body.files (no set poisoning)', async () => {
      TestClient.options.req = {
        body: { files: [{ file_id: undefined }, { file_id: 'file-abc' }] },
      };
      TestClient.options.attachments = [
        { ...attachment, file_id: undefined },
        { ...attachment, file_id: 'file-abc' },
      ];
      TestClient.saveMessageToDatabase = jest.fn().mockResolvedValue({ message: {} });

      await TestClient.sendMessage('Hello');

      const userSave = TestClient.saveMessageToDatabase.mock.calls.find(
        ([msg]) => msg.isCreatedByUser,
      );
      expect(userSave[0].files).toHaveLength(1);
      expect(userSave[0].files[0].file_id).toBe('file-abc');
    });
  });

  describe('addPreviousAttachments authorization', () => {
    const ownerFile = {
      file_id: 'owner-file',
      filename: 'owner.txt',
      filepath: '/uploads/owner.txt',
      source: 'local',
      type: 'text/plain',
      bytes: 100,
      object: 'file',
      user: 'user-1',
      embedded: false,
      usage: 0,
      text: 'authorized owner text',
      _id: 'owner-mongo-id',
      metadata: {
        codeEnvRef: {
          kind: 'user',
          id: 'user-1',
          storage_session_id: 'owner-session',
          file_id: 'owner-code-file',
        },
      },
    };

    beforeEach(() => {
      getFiles.mockReset();
      TestClient.options.resendFiles = true;
      TestClient.options.attachments = undefined;
      TestClient.options.req = {
        user: {
          id: 'user-1',
          tenantId: 'tenant-a',
        },
      };
      TestClient.addFileContextToMessage = jest.fn(async (message, files) => {
        const text = files
          .map((file) => file.text)
          .filter(Boolean)
          .join('\n');
        if (text) {
          message.fileContext = text;
        }
      });
      TestClient.processAttachments = jest.fn(async (_message, files) => files);
      TestClient.assertHistoricalAttachmentLimits = undefined;
      TestClient.checkVisionRequest = jest.fn();
    });

    describe('tool-routed files on a later turn', () => {
      const routedCsv = {
        file_id: 'csv-file',
        filename: 'sales.csv',
        filepath: '/uploads/sales.csv',
        source: 'local',
        type: 'text/csv',
        user: 'user-1',
        text: 'region,total',
        llmDeliveryPath: 'none',
        metadata: { destinationChosen: false },
      };

      /** A tool serves a file only once it holds it, so a record left to the sandbox needs the
       *  reference provisioning writes for that tool to count as its reader. */
      const sandboxCsv = {
        ...routedCsv,
        metadata: {
          destinationChosen: false,
          codeEnvRef: {
            kind: 'user',
            id: 'user-1',
            storage_session_id: 'session-1',
            file_id: 'sandbox-csv-file',
          },
        },
      };

      const replayCsv = async (
        fileConsumers,
        endpointConfig = {
          defaultLLMDeliveryPath: { overrides: { 'text/csv': 'none' } },
          textFallbackWithoutTools: true,
        },
        file = routedCsv,
      ) => {
        getFiles.mockResolvedValueOnce([file]);
        TestClient.options.req.config = {
          fileConfig: { endpoints: { [EModelEndpoint.openAI]: endpointConfig } },
        };
        TestClient.options.agent = { provider: EModelEndpoint.openAI, fileConsumers };
        TestClient.options.agent.deliveryRouting = resolveTurnDeliveryRouting({
          agent: TestClient.options.agent,
          config: TestClient.options.req?.config,
        });
        TestClient.assertHistoricalAttachmentLimits = jest.fn(async (files) => files);
        const [message] = await TestClient.addPreviousAttachments([
          { messageId: 'msg-csv', text: 'Summarize it', files: [{ file_id: 'csv-file' }] },
        ]);
        return message;
      };

      test('replays the stored text when this turn runs no tool that can read the file', async () => {
        const message = await replayCsv({ executeCode: false, fileSearch: false });
        const replayed = { ...routedCsv, llmDeliveryPath: 'text' };

        expect(TestClient.assertHistoricalAttachmentLimits).toHaveBeenCalledWith([replayed]);
        expect(TestClient.addFileContextToMessage).toHaveBeenCalledWith(message, [replayed]);
        expect(TestClient.authorizedHistoricalFiles.get('csv-file')).toEqual(replayed);
        expect(message.fileContext).toBe('region,total');
        expect(routedCsv.llmDeliveryPath).toBe('none');
      });

      test('replays the stored text once the endpoint routes the type to text', async () => {
        const message = await replayCsv(
          { executeCode: true, fileSearch: false },
          { defaultLLMDeliveryPath: { overrides: { 'text/csv': 'text' } } },
        );
        const replayed = { ...routedCsv, llmDeliveryPath: 'text' };

        expect(TestClient.assertHistoricalAttachmentLimits).toHaveBeenCalledWith([replayed]);
        expect(TestClient.addFileContextToMessage).toHaveBeenCalledWith(message, [replayed]);
        expect(message.fileContext).toBe('region,total');
      });

      test('admits a historical tool-routed file this turn sends to the provider', async () => {
        const routedImage = {
          file_id: 'image-file',
          filename: 'chart.png',
          filepath: '/uploads/chart.png',
          source: 'local',
          type: 'image/png',
          user: 'user-1',
          llmDeliveryPath: 'none',
          metadata: { destinationChosen: false },
        };
        getFiles.mockResolvedValueOnce([routedImage]);
        TestClient.options.req.config = { fileConfig: { endpoints: {} } };
        TestClient.options.agent = {
          provider: EModelEndpoint.openAI,
          fileConsumers: { executeCode: false, fileSearch: false },
        };
        TestClient.options.agent.deliveryRouting = resolveTurnDeliveryRouting({
          agent: TestClient.options.agent,
          config: TestClient.options.req?.config,
        });
        TestClient.assertHistoricalAttachmentLimits = jest.fn(async (files) => files);

        await TestClient.addPreviousAttachments([
          {
            messageId: 'msg-image',
            text: 'What does it show?',
            files: [{ file_id: 'image-file' }],
          },
        ]);

        expect(TestClient.assertHistoricalAttachmentLimits).toHaveBeenCalledWith([
          { ...routedImage, llmDeliveryPath: 'provider' },
        ]);
      });

      test('keeps the file off the prompt when the sandbox running it holds the file', async () => {
        const message = await replayCsv(
          { executeCode: true, fileSearch: false },
          undefined,
          sandboxCsv,
        );

        expect(TestClient.assertHistoricalAttachmentLimits).toHaveBeenCalledWith([]);
        expect(TestClient.addFileContextToMessage).not.toHaveBeenCalled();
        expect(message.fileContext).toBeUndefined();
      });

      test('replays the stored text when file search never received the file', async () => {
        /* An earlier turn's upload that named no destination was filed under no tool, so the
         * vector store holds nothing to search. Withholding the text for the enabled tool left
         * the file unreadable on every later turn as well as the one it arrived on. */
        const message = await replayCsv({ executeCode: false, fileSearch: true });
        const replayed = { ...routedCsv, llmDeliveryPath: 'text' };

        expect(TestClient.assertHistoricalAttachmentLimits).toHaveBeenCalledWith([replayed]);
        expect(TestClient.addFileContextToMessage).toHaveBeenCalledWith(message, [replayed]);
        expect(message.fileContext).toBe('region,total');
        expect(routedCsv.llmDeliveryPath).toBe('none');
      });
    });

    test('rehydrates historical file refs from owner-scoped DB rows only', async () => {
      getFiles.mockResolvedValueOnce([ownerFile]);

      const [message] = await TestClient.addPreviousAttachments([
        {
          messageId: 'msg-1',
          text: 'Use the attachment',
          files: [
            {
              file_id: 'owner-file',
              filename: 'attacker-controlled-owner-name.txt',
              filepath: '/forged/owner.txt',
              text: 'forged owner text',
            },
            {
              file_id: 'victim-file',
              filename: 'victim.txt',
              filepath: '/victim/private.txt',
              text: 'victim private text',
            },
          ],
          attachments: [
            {
              file_id: 'victim-file',
              filename: 'victim-output.csv',
              text: 'victim output text',
            },
          ],
          fileContext: 'stale victim private text',
        },
      ]);

      expect(getFiles).toHaveBeenCalledWith(
        {
          file_id: { $in: ['owner-file', 'victim-file'] },
          user: 'user-1',
          tenantId: 'tenant-a',
        },
        {},
        {},
      );
      expect(TestClient.addFileContextToMessage).toHaveBeenCalledWith(message, [ownerFile]);
      expect(TestClient.processAttachments).toHaveBeenCalledWith(message, [ownerFile]);
      expect(message.fileContext).toBe('authorized owner text');
      expect(message.files).toEqual([
        expect.objectContaining({
          file_id: 'owner-file',
          filename: 'owner.txt',
          filepath: '/uploads/owner.txt',
          source: 'local',
          metadata: ownerFile.metadata,
        }),
      ]);
      expect(message.files[0].text).toBeUndefined();
      expect(message.files[0]._id).toBeUndefined();
      expect(message.attachments).toBeUndefined();
      expect(JSON.stringify(message)).not.toContain('victim');
      expect(JSON.stringify(message)).not.toContain('forged owner text');
    });

    test('hydrates files referenced by non-steer provider content parts', async () => {
      getFiles.mockResolvedValueOnce([ownerFile]);

      const [message] = await TestClient.addPreviousAttachments([
        {
          messageId: 'msg-content-file',
          isCreatedByUser: true,
          content: [
            {
              type: 'input_file',
              files: [{ file_id: 'owner-file' }],
            },
          ],
        },
      ]);

      expect(getFiles).toHaveBeenCalledWith(
        {
          file_id: { $in: ['owner-file'] },
          user: 'user-1',
          tenantId: 'tenant-a',
        },
        {},
        {},
      );
      expect(TestClient.authorizedHistoricalFiles.get('owner-file')).toEqual(ownerFile);
      expect(message.content[0].files).toEqual([{ file_id: 'owner-file' }]);
    });

    test('hydrates nested provider file references', async () => {
      getFiles.mockResolvedValueOnce([ownerFile]);

      const [message] = await TestClient.addPreviousAttachments([
        {
          messageId: 'msg-nested-content-file',
          isCreatedByUser: true,
          content: [
            {
              type: 'input_file',
              file: { file_id: 'owner-file' },
            },
          ],
        },
      ]);

      expect(getFiles).toHaveBeenCalledWith(
        {
          file_id: { $in: ['owner-file'] },
          user: 'user-1',
          tenantId: 'tenant-a',
        },
        {},
        {},
      );
      expect(TestClient.authorizedHistoricalFiles.get('owner-file')).toEqual(ownerFile);
      expect(message.content[0].file).toEqual({ file_id: 'owner-file' });
    });

    test('preserves owner-scoped historical attachments when file patterns are inactive', async () => {
      TestClient.options.req.config = {
        filters: {
          files: {
            pii: {
              starterPatterns: [],
              customPatterns: [],
            },
          },
        },
      };
      getFiles.mockResolvedValueOnce([ownerFile]);

      const [message] = await TestClient.addPreviousAttachments([
        {
          messageId: 'msg-inactive-file-policy',
          files: [{ file_id: 'owner-file', filename: 'forged-input.txt' }],
          attachments: [{ file_id: 'owner-file', filename: 'forged-output.txt' }],
        },
      ]);

      expect(getFiles).toHaveBeenCalledWith(
        {
          file_id: { $in: ['owner-file'] },
          user: 'user-1',
          tenantId: 'tenant-a',
        },
        {},
        {},
      );
      expect(message.files).toEqual([
        expect.objectContaining({ file_id: 'owner-file', filename: 'owner.txt' }),
      ]);
      expect(message.attachments).toEqual([
        expect.objectContaining({ file_id: 'owner-file', filename: 'owner.txt' }),
      ]);
    });

    test('strips an unresolved historical file reference without pre-pruning enforcement', async () => {
      TestClient.options.req.config = {
        filters: {
          files: {
            pii: {
              fields: ['extracted_text'],
              starterPatterns: [],
              uninspectable: 'block',
            },
          },
        },
      };
      getFiles.mockResolvedValueOnce([]);

      const [message] = await TestClient.addPreviousAttachments([
        {
          messageId: 'msg-unresolved',
          isCreatedByUser: true,
          files: [{ file_id: 'foreign-file' }],
        },
      ]);
      expect(message).toEqual(expect.objectContaining({ messageId: 'msg-unresolved' }));
      expect(message).not.toHaveProperty('files');
      expect(TestClient.addFileContextToMessage).not.toHaveBeenCalled();
      expect(TestClient.processAttachments).not.toHaveBeenCalled();
    });

    test('strips historical file context when no authenticated owner scope is available', async () => {
      TestClient.options.req = {};

      const [message] = await TestClient.addPreviousAttachments([
        {
          messageId: 'msg-2',
          files: [{ file_id: 'victim-file', filename: 'victim.txt' }],
          fileContext: 'stale victim private text',
        },
      ]);

      expect(getFiles).not.toHaveBeenCalled();
      expect(message.files).toBeUndefined();
      expect(message.fileContext).toBeUndefined();
    });

    test('preserves repeated owner-authorized historical file refs after the first context use', async () => {
      getFiles.mockResolvedValueOnce([ownerFile]);

      const [firstMessage, secondMessage] = await TestClient.addPreviousAttachments([
        {
          messageId: 'msg-repeat-1',
          files: [{ file_id: 'owner-file', filename: 'first-forged.txt' }],
        },
        {
          messageId: 'msg-repeat-2',
          files: [{ file_id: 'owner-file', filename: 'second-forged.txt' }],
        },
      ]);

      expect(getFiles).toHaveBeenCalledTimes(1);
      expect(getFiles).toHaveBeenCalledWith(
        {
          file_id: { $in: ['owner-file'] },
          user: 'user-1',
          tenantId: 'tenant-a',
        },
        {},
        {},
      );
      expect(TestClient.addFileContextToMessage).toHaveBeenCalledTimes(1);
      expect(TestClient.addFileContextToMessage).toHaveBeenCalledWith(firstMessage, [ownerFile]);
      expect(secondMessage.fileContext).toBeUndefined();
      expect(firstMessage.files).toEqual([
        expect.objectContaining({ file_id: 'owner-file', filename: 'owner.txt' }),
      ]);
      expect(secondMessage.files).toEqual([
        expect.objectContaining({ file_id: 'owner-file', filename: 'owner.txt' }),
      ]);
      expect(JSON.stringify(secondMessage)).not.toContain('second-forged');
    });

    test('extracts historical file context while encoding provider attachments', async () => {
      getFiles.mockResolvedValueOnce([ownerFile]);
      const fileContext = deferred();
      const providerAttachments = deferred();
      let completed = false;

      TestClient.addFileContextToMessage.mockImplementation(async (message) => {
        await fileContext.promise;
        message.fileContext = 'authorized owner text';
      });
      TestClient.processAttachments.mockImplementation(() => providerAttachments.promise);

      const messagesPromise = TestClient.addPreviousAttachments([
        {
          messageId: 'msg-concurrent-file-work',
          files: [{ file_id: 'owner-file', filename: 'owner.txt' }],
        },
      ]).then((messages) => {
        completed = true;
        return messages;
      });

      await Promise.resolve();
      await Promise.resolve();

      expect(TestClient.addFileContextToMessage).toHaveBeenCalledTimes(1);
      expect(TestClient.processAttachments).toHaveBeenCalledTimes(1);

      providerAttachments.resolve([ownerFile]);
      await Promise.resolve();
      expect(completed).toBe(false);

      fileContext.resolve();
      const [message] = await messagesPromise;

      expect(message.fileContext).toBe('authorized owner text');
      expect(TestClient.message_file_map['msg-concurrent-file-work']).toEqual([]);
    });

    test('preserves download-only historical attachments without trusting file fields', async () => {
      const [message] = await TestClient.addPreviousAttachments([
        {
          messageId: 'msg-download-only',
          attachments: [
            {
              filename: 'report.csv',
              filepath: '/api/files/code/download/session/file',
              expiresAt: 123456,
              conversationId: 'conversation-1',
              messageId: 'assistant-message',
              toolCallId: 'tool-call-1',
              text: 'untrusted text should not survive',
              source: 'forged-source',
              metadata: { codeEnvRef: { id: 'victim' } },
            },
          ],
          fileContext: 'stale context',
        },
      ]);

      expect(getFiles).not.toHaveBeenCalled();
      expect(message.fileContext).toBeUndefined();
      expect(message.attachments).toEqual([
        {
          filename: 'report.csv',
          filepath: '/api/files/code/download/session/file',
          expiresAt: 123456,
          conversationId: 'conversation-1',
          messageId: 'assistant-message',
          toolCallId: 'tool-call-1',
        },
      ]);
      expect(JSON.stringify(message)).not.toContain('untrusted text');
      expect(JSON.stringify(message)).not.toContain('forged-source');
      expect(JSON.stringify(message)).not.toContain('victim');
    });

    test('processes only historical files admitted by the runtime endpoint policy', async () => {
      const modelFile = { ...ownerFile, metadata: undefined };
      getFiles.mockResolvedValueOnce([modelFile]);
      TestClient.assertHistoricalAttachmentLimits = jest.fn(async () => []);

      const [message] = await TestClient.addPreviousAttachments([
        {
          messageId: 'msg-1',
          text: 'Use the attachment',
          files: [{ file_id: modelFile.file_id }],
        },
      ]);

      expect(TestClient.assertHistoricalAttachmentLimits).toHaveBeenCalledWith([modelFile]);
      expect(TestClient.addFileContextToMessage).not.toHaveBeenCalled();
      expect(TestClient.processAttachments).not.toHaveBeenCalled();
      expect(message.files).toEqual([expect.objectContaining({ file_id: modelFile.file_id })]);
    });

    test('includes nested steer file references in historical admission', async () => {
      const modelFile = { ...ownerFile, metadata: undefined };
      getFiles.mockResolvedValueOnce([modelFile]);
      TestClient.assertHistoricalAttachmentLimits = jest.fn(async (files) => files);

      await TestClient.addPreviousAttachments([
        {
          messageId: 'msg-steer',
          content: [
            {
              type: 'steer',
              steer: 'Use the attachment',
              files: [{ file_id: modelFile.file_id }],
            },
          ],
        },
      ]);

      expect(TestClient.assertHistoricalAttachmentLimits).toHaveBeenCalledWith([modelFile]);
      expect(TestClient.authorizedHistoricalReplayFiles.get(modelFile.file_id)).toEqual(modelFile);
    });

    test('preserves repeated steer file injections in historical admission', async () => {
      const modelFile = { ...ownerFile, metadata: undefined };
      getFiles.mockResolvedValueOnce([modelFile]);
      TestClient.assertHistoricalAttachmentLimits = jest.fn(async (files) => files);

      await TestClient.addPreviousAttachments([
        {
          messageId: 'msg-steer-repeat',
          content: [
            {
              type: 'steer',
              steer: 'Use the attachment once.',
              files: [{ file_id: modelFile.file_id }],
            },
            {
              type: 'steer',
              steer: 'Use the attachment again.',
              files: [{ file_id: modelFile.file_id }],
            },
          ],
        },
      ]);

      expect(TestClient.assertHistoricalAttachmentLimits).toHaveBeenCalledWith([
        modelFile,
        modelFile,
      ]);
      expect(TestClient.modelBoundHistoricalSteerFiles).toEqual([modelFile, modelFile]);
    });

    test('keeps canonical byte metadata for processed historical survivors', async () => {
      const modelFile = { ...ownerFile, metadata: undefined, bytes: 120 * 1024 * 1024 };
      getFiles.mockResolvedValueOnce([modelFile]);
      TestClient.processAttachments.mockResolvedValue([{ file_id: modelFile.file_id }]);

      await TestClient.addPreviousAttachments([
        {
          messageId: 'msg-canonical-bytes',
          files: [{ file_id: modelFile.file_id }],
        },
      ]);

      expect(TestClient.message_file_map['msg-canonical-bytes']).toEqual([modelFile]);
    });

    test('merges safe per-message metadata onto authorized DB-backed attachments', async () => {
      getFiles.mockResolvedValueOnce([ownerFile]);

      const [message] = await TestClient.addPreviousAttachments([
        {
          messageId: 'msg-artifact',
          attachments: [
            {
              file_id: 'owner-file',
              filename: 'forged-artifact.csv',
              filepath: '/forged/artifact.csv',
              source: 'forged-source',
              metadata: { codeEnvRef: { id: 'victim' } },
              text: 'forged artifact text',
              messageId: 'assistant-message',
              toolCallId: 'tool-call-2',
            },
          ],
        },
      ]);

      expect(message.attachments).toEqual([
        expect.objectContaining({
          file_id: 'owner-file',
          filename: 'owner.txt',
          filepath: '/uploads/owner.txt',
          source: 'local',
          metadata: ownerFile.metadata,
          messageId: 'assistant-message',
          toolCallId: 'tool-call-2',
        }),
      ]);
      expect(message.attachments[0].text).toBeUndefined();
      expect(message.attachments[0]._id).toBeUndefined();
      expect(JSON.stringify(message)).not.toContain('forged-artifact');
      expect(JSON.stringify(message)).not.toContain('forged artifact text');
    });
  });

  describe('sendMessage quote references', () => {
    // The blockquote merge itself lives in AgentClient.buildMessages / prependQuotes
    // (covered by packages/api specs). BaseClient's job is to attach the normalized
    // quotes onto the user message early and keep the stored text clean.
    test('attaches normalized quotes before getReqData fires and keeps stored text clean', async () => {
      TestClient.options.req = { body: { quotes: ['  the selected text  ', '', 42] } };
      TestClient.saveMessageToDatabase = jest.fn().mockResolvedValue({ message: {} });
      let captured;
      await TestClient.sendMessage('What does this mean?', {
        getReqData: (data) => {
          if (data.userMessage) {
            captured = { text: data.userMessage.text, quotes: data.userMessage.quotes };
          }
        },
      });

      // Quotes are present (trimmed, non-strings dropped) at getReqData time, and
      // the user text is never mutated by the merge.
      expect(captured).toBeDefined();
      expect(captured.quotes).toEqual(['the selected text']);
      expect(captured.text).toBe('What does this mean?');

      const userSave = TestClient.saveMessageToDatabase.mock.calls.find(
        ([msg]) => msg.isCreatedByUser,
      );
      expect(userSave[0].text).toBe('What does this mean?');
      expect(userSave[0].quotes).toEqual(['the selected text']);
    });

    test('persists multiple quotes in order on the saved message', async () => {
      TestClient.options.req = { body: { quotes: ['first excerpt', 'second excerpt'] } };
      TestClient.saveMessageToDatabase = jest.fn().mockResolvedValue({ message: {} });

      await TestClient.sendMessage('Compare these');

      const userSave = TestClient.saveMessageToDatabase.mock.calls.find(
        ([msg]) => msg.isCreatedByUser,
      );
      expect(userSave[0].text).toBe('Compare these');
      expect(userSave[0].quotes).toEqual(['first excerpt', 'second excerpt']);
    });

    test('leaves the message untouched when no quotes are provided', async () => {
      TestClient.options.req = { body: {} };
      TestClient.saveMessageToDatabase = jest.fn().mockResolvedValue({ message: {} });

      await TestClient.sendMessage('Just a question');

      const userSave = TestClient.saveMessageToDatabase.mock.calls.find(
        ([msg]) => msg.isCreatedByUser,
      );
      expect(userSave[0].text).toBe('Just a question');
      expect(userSave[0].quotes).toBeUndefined();
    });
  });

  describe('mergeEditedContent phase boundaries', () => {
    test('carries the new reasoning label when adjacent THINK parts merge', () => {
      const existing = [
        {
          type: ContentTypes.THINK,
          think: 'Retained reasoning. ',
          reasoning_label: 'Inspecting the old path',
          reasoning_label_step_id: 'old-step',
          reasoning_label_attempts: 1,
          reasoning_label_submitted_chars: 18,
          reasoning_label_revision: 1,
          reasoning_label_status: 'complete',
        },
      ];
      const completion = [
        {
          type: ContentTypes.THINK,
          think: 'Continued reasoning.',
          reasoning_label: 'Tracing the regenerated path',
          reasoning_label_step_id: 'new-step',
          reasoning_label_attempts: 3,
          reasoning_label_submitted_chars: 20,
          reasoning_label_revision: 2,
          reasoning_label_status: 'streaming',
        },
      ];

      expect(TestClient.mergeEditedContent(existing, completion, ContentTypes.THINK)).toEqual([
        {
          ...completion[0],
          think: 'Retained reasoning. Continued reasoning.',
        },
      ]);
    });

    test('clears a retained reasoning label when the merged THINK has no label', () => {
      const existing = [
        {
          type: ContentTypes.THINK,
          think: 'Retained reasoning. ',
          agentId: 'agent-1',
          reasoning_label: 'Inspecting the old path',
          reasoning_label_step_id: 'old-step',
          reasoning_label_attempts: 3,
          reasoning_label_submitted_chars: 18,
          reasoning_label_revision: 2,
          reasoning_label_status: 'complete',
        },
      ];
      const completion = [
        {
          type: ContentTypes.THINK,
          think: 'Continued without a generated title.',
          agentId: 'agent-1',
        },
      ];

      expect(TestClient.mergeEditedContent(existing, completion, ContentTypes.THINK)).toEqual([
        {
          type: ContentTypes.THINK,
          think: 'Retained reasoning. Continued without a generated title.',
          agentId: 'agent-1',
        },
      ]);
    });

    test('does not merge commentary into a final answer', () => {
      const existing = [
        { type: ContentTypes.TEXT, text: 'Checked the deployment. ', phase: 'commentary' },
      ];
      const completion = [
        { type: ContentTypes.TEXT, text: 'Everything is healthy.', phase: 'final_answer' },
        {
          type: ContentTypes.ACTIVITY_LABEL,
          activity_label_type: 'phase',
          activity_start_index: 0,
          activity_end_index: 1,
          activity_label: 'Verified deployment health',
        },
      ];

      expect(TestClient.mergeEditedContent(existing, completion, ContentTypes.TEXT)).toEqual([
        existing[0],
        completion[0],
        { ...completion[1], activity_start_index: 1, activity_end_index: 2 },
      ]);
    });

    test.each([
      [undefined, 'commentary'],
      ['commentary', undefined],
    ])('does not merge phased and unphased text (%s → %s)', (existingPhase, completionPhase) => {
      const existing = [
        {
          type: ContentTypes.TEXT,
          text: 'Retained text. ',
          ...(existingPhase != null && { phase: existingPhase }),
        },
      ];
      const completion = [
        {
          type: ContentTypes.TEXT,
          text: 'New text.',
          ...(completionPhase != null && { phase: completionPhase }),
        },
      ];

      expect(TestClient.mergeEditedContent(existing, completion, ContentTypes.TEXT)).toEqual([
        existing[0],
        completion[0],
      ]);
    });
  });

  describe('processAttachments llmDeliveryPath handling', () => {
    beforeEach(() => {
      TestClient.options = {
        endpoint: EModelEndpoint.openAI,
      };
      TestClient.addImageURLs = jest.fn(async (message, files) => {
        message.image_urls = ['encoded-image'];
        return files;
      });
      TestClient.addDocuments = jest.fn(async (message, files) => {
        message.documents = [{ type: 'file' }];
        return files;
      });
      TestClient.addVideos = jest.fn(async (_message, files) => files);
      TestClient.modelOptions = undefined;
      TestClient.addAudios = jest.fn(async (_message, files) => files);
    });

    /** The routing initialization settles for an agent, from the request config it reads. */
    const routedAgent = (agent) => ({
      ...agent,
      deliveryRouting: resolveTurnDeliveryRouting({
        agent,
        config: TestClient.options.req?.config,
      }),
    });

    /* The stored path is an upload-time inference, so delivery resolves it again by the
     * routing settled for the agent running the turn. A test asserting a route has to
     * configure that route rather than rely on the stored value alone. */
    const routeTo = (path, ...mimeTypes) => {
      TestClient.options.req = {
        config: {
          fileConfig: {
            endpoints: {
              [EModelEndpoint.openAI]: {
                defaultLLMDeliveryPath: {
                  overrides: Object.fromEntries(mimeTypes.map((mime) => [mime, path])),
                },
              },
            },
          },
        },
      };
      TestClient.options.agent = routedAgent({
        provider: EModelEndpoint.openAI,
        endpoint: EModelEndpoint.openAI,
      });
    };

    test('keeps a none image in returned files without adding image URLs', async () => {
      routeTo('none', 'image/*');
      const message = {};
      const file = {
        user: 'user1',
        file_id: 'none-image',
        filename: 'image.png',
        filepath: '/uploads/image.png',
        type: 'image/png',
        bytes: 100,
        source: 'local',
        llmDeliveryPath: 'none',
      };

      const result = await TestClient.processAttachments(message, [file]);

      expect(result).toEqual([file]);
      expect(message.image_urls).toBeUndefined();
      expect(TestClient.addImageURLs).not.toHaveBeenCalled();
    });

    test('does not inject extracted text after the current provider resolves none', () => {
      routeTo('none', 'application/pdf');
      const file = {
        file_id: 'none-pdf',
        filename: 'report.pdf',
        type: 'application/pdf',
        llmDeliveryPath: 'text',
        metadata: { destinationChosen: false },
      };

      expect(TestClient.getTextContextAttachments([file])).toEqual([]);
    });

    const routeCsvToTools = ({ textFallbackWithoutTools = true } = {}) => {
      routeTo('none', 'text/csv');
      TestClient.options.req.config.fileConfig.endpoints[
        EModelEndpoint.openAI
      ].textFallbackWithoutTools = textFallbackWithoutTools;
    };

    test('injects the text stored for a tool-routed file when this turn runs no reader', () => {
      routeCsvToTools();
      TestClient.options.agent = {
        provider: EModelEndpoint.openAI,
        fileConsumers: { executeCode: false, fileSearch: false },
      };
      TestClient.options.agent.deliveryRouting = resolveTurnDeliveryRouting({
        agent: TestClient.options.agent,
        config: TestClient.options.req?.config,
      });
      /* Agent initialization marks the copy it hands this client, so the stored route reads
       * `text` while the configured route stays `none`. */
      const file = {
        file_id: 'fallback-csv',
        filename: 'sales.csv',
        type: 'text/csv',
        text: 'region,total',
        llmDeliveryPath: 'text',
        metadata: { destinationChosen: false },
      };

      expect(TestClient.getAttachmentDeliveryPath(file)).toBe('text');
      expect(TestClient.getTextContextAttachments([file])).toEqual([file]);
    });

    test('delivers a late steer through fallback even when the initialized agent has file tools', async () => {
      routeCsvToTools();
      TestClient.options.agent = routedAgent({
        provider: EModelEndpoint.openAI,
        fileConsumers: { executeCode: true, fileSearch: true },
      });
      const file = {
        file_id: 'late-csv',
        filename: 'late.csv',
        type: 'text/csv',
        source: 'local',
        text: 'region,total',
        llmDeliveryPath: 'none',
        metadata: { destinationChosen: false },
      };
      const assertFilesAllowed = jest.fn();
      const initEncoding = jest.spyOn(Tokenizer, 'initEncoding').mockResolvedValue(undefined);
      const getTokenCount = jest.spyOn(Tokenizer, 'getTokenCount').mockReturnValue(4);
      let result;
      try {
        result = await buildSteerMedia({
          client: {
            resolveTurnAttachments: TestClient.resolveTurnAttachments.bind(TestClient),
            addFileContextToMessage:
              BaseClientClass.prototype.addFileContextToMessage.bind(TestClient),
            processAttachments: BaseClientClass.prototype.processAttachments.bind(TestClient),
          },
          user: { id: 'user-1' },
          item: { steerId: 'late', text: 'Read this file', files: [{ file_id: file.file_id }] },
          getFiles: jest.fn().mockResolvedValue([file]),
          assertFilesAllowed,
        });
      } finally {
        initEncoding.mockRestore();
        getTokenCount.mockRestore();
      }
      expect(assertFilesAllowed).toHaveBeenCalledWith([{ ...file, llmDeliveryPath: 'text' }]);
      expect(JSON.stringify(result.content)).toContain('region,total');
      expect(file.llmDeliveryPath).toBe('none');
      expect(TestClient.options.agent.fileConsumers).toEqual({
        executeCode: true,
        fileSearch: true,
      });
    });

    test('keeps a tool-routed file off the prompt when the sandbox running it holds the file', () => {
      routeCsvToTools();
      TestClient.options.agent = {
        provider: EModelEndpoint.openAI,
        fileConsumers: { executeCode: true, fileSearch: false },
      };
      TestClient.options.agent.deliveryRouting = resolveTurnDeliveryRouting({
        agent: TestClient.options.agent,
        config: TestClient.options.req?.config,
      });
      const file = {
        file_id: 'code-csv',
        filename: 'sales.csv',
        type: 'text/csv',
        text: 'region,total',
        llmDeliveryPath: 'none',
        metadata: {
          destinationChosen: false,
          codeEnvRef: {
            kind: 'user',
            id: 'user-1',
            storage_session_id: 'session-1',
            file_id: 'sandbox-code-csv',
          },
        },
      };

      expect(TestClient.getAttachmentDeliveryPath(file)).toBe('none');
      expect(TestClient.getTextContextAttachments([file])).toEqual([]);
    });

    test('delivers the text when File Search has yet to receive the file', () => {
      /* An upload that named no destination is filed under no tool, so an enabled search tool
       * alone cannot serve it and withholding the text left it readable by nothing. */
      routeCsvToTools();
      TestClient.options.agent = {
        provider: EModelEndpoint.openAI,
        fileConsumers: { executeCode: false, fileSearch: true },
      };
      TestClient.options.agent.deliveryRouting = resolveTurnDeliveryRouting({
        agent: TestClient.options.agent,
        config: TestClient.options.req?.config,
      });
      const file = {
        file_id: 'unprovisioned-csv',
        filename: 'sales.csv',
        type: 'text/csv',
        text: 'region,total',
        llmDeliveryPath: 'none',
        metadata: { destinationChosen: false },
      };

      expect(TestClient.getAttachmentDeliveryPath(file)).toBe('text');
      /* The filter selects records by the route this turn resolves, so it returns the record as
       * stored; marking the copy admission reads is `resolveTurnAttachments`. */
      expect(TestClient.getTextContextAttachments([file])).toEqual([file]);
      expect(TestClient.resolveTurnAttachments([file])).toEqual([
        { ...file, llmDeliveryPath: 'text' },
      ]);
    });

    test('leaves a file Run Code can read with Run Code before the sandbox holds it', () => {
      /* Run Code uploads the file on its first call, so the text stays off the prompt, where it
       * would otherwise count toward the history limits until that call. */
      routeCsvToTools();
      TestClient.options.agent = {
        provider: EModelEndpoint.openAI,
        fileConsumers: { executeCode: true, fileSearch: true },
      };
      TestClient.options.agent.deliveryRouting = resolveTurnDeliveryRouting({
        agent: TestClient.options.agent,
        config: TestClient.options.req?.config,
      });
      const file = {
        file_id: 'unprovisioned-csv',
        filename: 'sales.csv',
        type: 'text/csv',
        text: 'region,total',
        llmDeliveryPath: 'none',
        metadata: { destinationChosen: false },
      };

      expect(TestClient.getAttachmentDeliveryPath(file)).toBe('none');
      expect(TestClient.getTextContextAttachments([file])).toEqual([]);
      expect(TestClient.resolveTurnAttachments([file])).toEqual([file]);
    });

    test('does not fall back on an endpoint that has not enabled it', () => {
      routeCsvToTools({ textFallbackWithoutTools: false });
      TestClient.options.agent = {
        provider: EModelEndpoint.openAI,
        fileConsumers: { executeCode: false, fileSearch: false },
      };
      TestClient.options.agent.deliveryRouting = resolveTurnDeliveryRouting({
        agent: TestClient.options.agent,
        config: TestClient.options.req?.config,
      });
      const file = {
        file_id: 'disabled-csv',
        filename: 'sales.csv',
        type: 'text/csv',
        text: 'region,total',
        llmDeliveryPath: 'text',
        metadata: { destinationChosen: false },
      };

      expect(TestClient.getAttachmentDeliveryPath(file)).toBe('none');
      expect(TestClient.getTextContextAttachments([file])).toEqual([]);
    });

    test('does not fall back when the turn tools are unknown', () => {
      routeCsvToTools();
      TestClient.options.agent = { provider: EModelEndpoint.openAI };
      const file = {
        file_id: 'unknown-csv',
        filename: 'sales.csv',
        type: 'text/csv',
        text: 'region,total',
        llmDeliveryPath: 'none',
        metadata: { destinationChosen: false },
      };

      expect(TestClient.getTextContextAttachments([file])).toEqual([]);
    });

    test('does not inject extracted text when the current provider resolves native delivery', () => {
      routeTo('provider', 'application/pdf');
      const file = {
        file_id: 'provider-pdf',
        filename: 'report.pdf',
        type: 'application/pdf',
        llmDeliveryPath: 'text',
        metadata: { destinationChosen: false },
      };

      expect(TestClient.getTextContextAttachments([file])).toEqual([]);
    });

    test('re-resolves a path stored under a different provider', async () => {
      /* Audio uploaded under Google stores `provider`, and the OpenAI encoder emits no
       * audio payload for it, so the inference is not this endpoint's to honor.
       *
       * What this does not do is produce a transcript: the record holds raw media and no
       * extracted text, and extraction at delivery is Phase 2 work. So the model receives
       * nothing here either way, which the assertions state rather than imply, and the
       * change is limited to not downloading and encoding a file to no purpose. */
      routeTo('text', 'audio/*');
      const message = {};
      const file = {
        user: 'user1',
        file_id: 'foreign-audio',
        filename: 'note.mp3',
        filepath: '/uploads/note.mp3',
        type: 'audio/mpeg',
        bytes: 100,
        source: 'local',
        llmDeliveryPath: 'provider',
      };

      const result = await TestClient.processAttachments(message, [file]);

      expect(result).toEqual([file]);
      expect(TestClient.addAudios).not.toHaveBeenCalled();
      expect(message.audios).toBeUndefined();
      expect(file.text).toBeUndefined();
    });

    test('re-resolves a converted image against the type it was routed on', async () => {
      /* Conversion rewrote the stored type, so resolving against that asks about a format
       * the administrator never configured a route for and delivers what they excluded. */
      routeTo('none', 'image/png');
      const message = {};
      const file = {
        user: 'user1',
        file_id: 'converted-image',
        filename: 'photo.png',
        filepath: '/uploads/photo.webp',
        type: 'image/webp',
        bytes: 100,
        source: 'local',
        llmDeliveryPath: 'none',
        metadata: { routingMimeType: 'image/png' },
      };

      const result = await TestClient.processAttachments(message, [file]);

      expect(result).toEqual([file]);
      expect(TestClient.addImageURLs).not.toHaveBeenCalled();
    });

    test('reads the Responses setting the turn runs on from the settled routing', async () => {
      /* Azure sends a PDF natively only under the Responses API. The routing carries the
       * decision initialization made, so a record stored as `provider` is not resolved
       * again to text it has none of, which would leave the model with nothing. */
      TestClient.options = {
        endpoint: EModelEndpoint.agents,
        req: { config: { fileConfig: undefined } },
      };
      TestClient.options.agent = routedAgent({
        provider: EModelEndpoint.azureOpenAI,
        endpoint: EModelEndpoint.azureOpenAI,
        model_parameters: { useResponsesApi: true },
      });
      const message = {};
      const file = {
        user: 'user1',
        file_id: 'azure-pdf',
        filename: 'doc.pdf',
        filepath: '/uploads/doc.pdf',
        type: 'application/pdf',
        bytes: 100,
        source: 'local',
        llmDeliveryPath: 'provider',
      };

      await TestClient.processAttachments(message, [file]);

      expect(TestClient.addDocuments).toHaveBeenCalled();
    });

    test('resolves a custom endpoint policy by the name the admin configured', async () => {
      /* `initializeAgent` rewrites `agent.provider` to the client family a custom endpoint
       * runs on, so resolving by it looks up `openAI` and silently loses every override
       * written against the endpoint's own name. Upload routed under that name, and
       * delivery has to agree or the file is stored and never sent. */
      TestClient.options = {
        endpoint: EModelEndpoint.agents,
        endpointType: EModelEndpoint.agents,
        agent: { provider: EModelEndpoint.openAI, endpoint: 'Mock Provider B' },
        req: {
          config: {
            fileConfig: {
              endpoints: {
                'Mock Provider B': {
                  defaultLLMDeliveryPath: { overrides: { 'image/*': 'none' } },
                },
              },
            },
          },
        },
      };
      TestClient.options.agent = routedAgent(TestClient.options.agent);
      const message = {};
      const file = {
        user: 'user1',
        file_id: 'custom-image',
        filename: 'photo.png',
        filepath: '/uploads/photo.png',
        type: 'image/png',
        bytes: 100,
        source: 'local',
        llmDeliveryPath: 'provider',
      };

      const result = await TestClient.processAttachments(message, [file]);

      expect(result).toEqual([file]);
      expect(TestClient.addImageURLs).not.toHaveBeenCalled();
    });

    test('resolves an agent policy by its own endpoint, not the agents container', async () => {
      /* getEndpointFileConfig prefers endpointType, and an agents chat carries `agents`,
       * so supplying it answers with the generic entry rather than the agent's.
       * `initializeAgent` sets `agent.endpoint` from the agent's provider, so it names a
       * configurable entry and never the container. */
      TestClient.options = {
        endpoint: EModelEndpoint.agents,
        endpointType: EModelEndpoint.agents,
        agent: { provider: EModelEndpoint.openAI, endpoint: EModelEndpoint.openAI },
        req: {
          config: {
            fileConfig: {
              endpoints: {
                [EModelEndpoint.openAI]: {
                  defaultLLMDeliveryPath: { overrides: { 'image/*': 'none' } },
                },
              },
            },
          },
        },
      };
      TestClient.options.agent = routedAgent(TestClient.options.agent);
      const message = {};
      const file = {
        user: 'user1',
        file_id: 'agent-image',
        filename: 'photo.png',
        filepath: '/uploads/photo.png',
        type: 'image/png',
        bytes: 100,
        source: 'local',
        llmDeliveryPath: 'provider',
      };

      const result = await TestClient.processAttachments(message, [file]);

      expect(result).toEqual([file]);
      expect(TestClient.addImageURLs).not.toHaveBeenCalled();
    });

    test('keeps an explicitly named destination even under a different provider', async () => {
      /* The user named this one, through the chooser or by requesting a tool resource,
       * and that decision is not this endpoint's to re-derive. */
      routeTo('text', 'audio/*');
      const message = {};
      const file = {
        user: 'user1',
        file_id: 'chosen-audio',
        filename: 'note.mp3',
        filepath: '/uploads/note.mp3',
        type: 'audio/mpeg',
        bytes: 100,
        source: 'local',
        llmDeliveryPath: 'provider',
        metadata: { destinationChosen: true },
      };

      await TestClient.processAttachments(message, [file]);

      expect(TestClient.addAudios).toHaveBeenCalled();
    });

    test('keeps a none PDF in returned files without adding documents', async () => {
      routeTo('none', 'application/pdf');
      const message = {};
      const file = {
        user: 'user1',
        file_id: 'none-pdf',
        filename: 'document.pdf',
        filepath: '/uploads/document.pdf',
        type: 'application/pdf',
        bytes: 100,
        source: 'local',
        llmDeliveryPath: 'none',
      };

      const result = await TestClient.processAttachments(message, [file]);

      expect(result).toEqual([file]);
      expect(message.documents).toBeUndefined();
      expect(TestClient.addDocuments).not.toHaveBeenCalled();
    });

    test('keeps a text-delivery markdown file in returned files without adding documents', async () => {
      const message = {};
      const file = {
        user: 'user1',
        file_id: 'text-markdown',
        filename: 'notes.md',
        filepath: '/uploads/notes.md',
        type: 'text/markdown',
        bytes: 100,
        source: 'local',
        text: 'extracted markdown',
        llmDeliveryPath: 'text',
      };

      const result = await TestClient.processAttachments(message, [file]);

      expect(result).toEqual([file]);
      expect(message.documents).toBeUndefined();
      expect(TestClient.addDocuments).not.toHaveBeenCalled();
    });

    test('still delivers a provider PDF that lazy provisioning marked embedded', async () => {
      const message = {};
      const file = {
        user: 'user1',
        file_id: 'provisioned-pdf',
        filename: 'report.pdf',
        filepath: '/uploads/report.pdf',
        type: 'application/pdf',
        bytes: 100,
        source: 'local',
        embedded: true,
        llmDeliveryPath: 'provider',
      };

      await TestClient.processAttachments(message, [file]);

      expect(TestClient.addDocuments).toHaveBeenCalled();
      expect(message.documents).toEqual([{ type: 'file' }]);
    });

    test('still delivers a provider image that carries a codeEnvRef', async () => {
      const message = {};
      const file = {
        user: 'user1',
        file_id: 'provisioned-image',
        filename: 'chart.png',
        filepath: '/uploads/chart.png',
        type: 'image/png',
        bytes: 100,
        source: 'local',
        llmDeliveryPath: 'provider',
        metadata: { codeEnvRef: { kind: 'user', id: 'u1' } },
      };

      await TestClient.processAttachments(message, [file]);

      expect(TestClient.addImageURLs).toHaveBeenCalled();
      expect(message.image_urls).toEqual(['encoded-image']);
    });

    test('keeps a code output out of the prompt once its expired sandbox reference is cleared', async () => {
      /* Priming clears a dead sandbox reference on the turn's copy of the record so the file
       * is re-provisioned. The output still belongs to the sandbox that wrote it. */
      const message = {};
      const file = {
        user: 'user1',
        file_id: 'code-output-chart',
        filename: 'chart.png',
        filepath: '/uploads/chart.png',
        type: 'image/png',
        bytes: 100,
        source: 'local',
        context: 'execute_code',
        metadata: {},
      };

      const result = await TestClient.processAttachments(message, [file]);

      expect(result).toEqual([file]);
      expect(TestClient.addImageURLs).not.toHaveBeenCalled();
      expect(message.image_urls).toBeUndefined();
    });

    test('keeps excluding embedded legacy files that have no delivery path', async () => {
      const message = {};
      const file = {
        user: 'user1',
        file_id: 'legacy-embedded',
        filename: 'legacy.pdf',
        filepath: '/uploads/legacy.pdf',
        type: 'application/pdf',
        bytes: 100,
        source: 'local',
        embedded: true,
      };

      const result = await TestClient.processAttachments(message, [file]);

      expect(result).toEqual([file]);
      expect(TestClient.addDocuments).not.toHaveBeenCalled();
    });

    test('routes legacy files without llmDeliveryPath normally', async () => {
      const message = {};
      const file = {
        user: 'user1',
        file_id: 'legacy-pdf',
        filename: 'document.pdf',
        filepath: '/uploads/document.pdf',
        type: 'application/pdf',
        bytes: 100,
        source: 'local',
      };

      const result = await TestClient.processAttachments(message, [file]);

      expect(result).toEqual([file]);
      expect(message.documents).toEqual([{ type: 'file' }]);
      expect(TestClient.addDocuments).toHaveBeenCalledWith(message, [file]);
    });
  });
});

describe('BaseClient compaction turns', () => {
  const compactionOptions = { modelOptions: { model: 'gpt-4o-mini', temperature: 0 } };
  const compactionHistory = [
    { role: 'user', isCreatedByUser: true, text: 'Hello', messageId: 'u1' },
    {
      role: 'assistant',
      isCreatedByUser: false,
      text: 'Hi',
      messageId: 'a1',
      parentMessageId: 'u1',
      tokenCount: 7,
    },
  ];
  let CompactClient;

  beforeEach(() => {
    jest.clearAllMocks();
    CompactClient = initializeFakeClient(apiKey, compactionOptions, compactionHistory);
  });

  test('presents the leaf as the user message and never re-saves it', async () => {
    const result = await CompactClient.handleStartMethods('', {
      conversationId: 'convo-compact',
      parentMessageId: 'a1',
      preallocatedUserMessageId: 'a1',
      isCompaction: true,
    });

    expect(result.userMessage).toEqual({
      messageId: 'a1',
      parentMessageId: 'u1',
      conversationId: undefined,
      isCreatedByUser: false,
      text: '',
    });
    expect(CompactClient.skipSaveUserMessage).toBe(true);
    /** History is loaded through the leaf, and nothing is appended to it. */
    expect(CompactClient.currentMessages.map((message) => message.messageId)).toEqual(['u1', 'a1']);
  });

  test('refuses a compaction whose anchor is not the loaded leaf', async () => {
    await expect(
      CompactClient.handleStartMethods('', {
        conversationId: 'convo-compact',
        parentMessageId: 'missing',
        preallocatedUserMessageId: 'missing',
        isCompaction: true,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'COMPACTION_ANCHOR_NOT_FOUND' });
  });

  test('refuses to compact a branch whose leaf is already a finished compaction', async () => {
    const compacted = [
      ...compactionHistory,
      {
        role: 'assistant',
        isCreatedByUser: false,
        text: '',
        messageId: 's1',
        parentMessageId: 'a1',
        content: [
          {
            type: ContentTypes.SUMMARY,
            content: [{ type: ContentTypes.TEXT, text: 'checkpoint' }],
            boundary: { messageId: 'step_summary', contentIndex: 0 },
          },
        ],
      },
    ];
    CompactClient = initializeFakeClient(apiKey, compactionOptions, compacted);

    await expect(
      CompactClient.handleStartMethods('', {
        conversationId: 'convo-compact',
        parentMessageId: 's1',
        preallocatedUserMessageId: 's1',
        isCompaction: true,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'NOTHING_TO_COMPACT',
      message: JSON.stringify({ type: 'compaction_skipped', reason: 'nothing_to_summarize' }),
    });
  });

  test('lets an interrupted compaction be retried', async () => {
    const interrupted = [
      ...compactionHistory,
      {
        role: 'assistant',
        isCreatedByUser: false,
        text: '',
        messageId: 's1',
        parentMessageId: 'a1',
        content: [{ type: ContentTypes.SUMMARY, content: [], summarizing: true }],
      },
    ];
    CompactClient = initializeFakeClient(apiKey, compactionOptions, interrupted);

    const result = await CompactClient.handleStartMethods('', {
      conversationId: 'convo-compact',
      parentMessageId: 's1',
      preallocatedUserMessageId: 's1',
      isCompaction: true,
    });

    expect(result.userMessage.messageId).toBe('s1');
  });

  test('parents the response onto the leaf and persists only the response', async () => {
    const saveSpy = jest.spyOn(CompactClient, 'saveMessageToDatabase').mockResolvedValue({});
    const updateSpy = jest.spyOn(CompactClient, 'updateMessageInDatabase').mockResolvedValue({});
    /** A calibration ratio and a counted anchor would, on an ordinary turn,
     *  rewrite the user message's persisted count; the leaf's must survive. */
    CompactClient.contextMeta = { calibrationRatio: 0.5 };
    CompactClient.buildMessages = jest.fn(async () => ({
      prompt: [],
      tokenCountMap: { a1: 7 },
      promptTokens: 7,
    }));

    const response = await CompactClient.sendMessage('', {
      conversationId: 'convo-compact',
      parentMessageId: 'a1',
      preallocatedUserMessageId: 'a1',
      isCompaction: true,
    });

    expect(response.parentMessageId).toBe('a1');
    expect(response.isCreatedByUser).toBe(false);
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy.mock.calls[0][0].messageId).toBe(response.messageId);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(CompactClient.currentMessages.map((message) => message.messageId)).toEqual(['u1', 'a1']);
    expect(compactionHistory[1].tokenCount).toBe(7);
  });
});
