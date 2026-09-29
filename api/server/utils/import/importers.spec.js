const fs = require('fs');
const path = require('path');
const {
  EModelEndpoint,
  Constants,
  ContentTypes,
  Tools,
  RetentionMode,
  openAISettings,
  anthropicSettings,
} = require('librechat-data-provider');
const { getImporter, processAssistantMessage } = require('./importers');
const { ImportBatchBuilder } = require('./importBatchBuilder');
const { bulkSaveMessages, bulkSaveConvos: _bulkSaveConvos } = require('~/models');

const mockGetEndpointsConfig = jest.fn().mockResolvedValue({
  [EModelEndpoint.openAI]: { userProvide: false },
});

const mockGetModelsConfig = jest.fn().mockResolvedValue({});

jest.mock('~/server/services/Config', () => ({
  getEndpointsConfig: (...args) => mockGetEndpointsConfig(...args),
}));

jest.mock('~/server/controllers/ModelController', () => ({
  getModelsConfig: (...args) => mockGetModelsConfig(...args),
}));

// Mock the database methods
jest.mock('~/models', () => ({
  bulkSaveConvos: jest.fn(),
  bulkSaveMessages: jest.fn(),
  bulkIncrementTagCounts: jest.fn(),
}));

afterEach(() => {
  jest.clearAllMocks();
});

describe('importChatGptConvo', () => {
  it('should import conversation correctly', async () => {
    const expectedNumberOfMessages = 19;
    const jsonData = JSON.parse(
      fs.readFileSync(path.join(__dirname, '__data__', 'chatgpt-export.json'), 'utf8'),
    );
    const requestUserId = 'user-123';
    const importBatchBuilder = new ImportBatchBuilder(requestUserId);

    // Spy on instance methods
    jest.spyOn(importBatchBuilder, 'startConversation');
    jest.spyOn(importBatchBuilder, 'saveMessage');
    jest.spyOn(importBatchBuilder, 'finishConversation');
    jest.spyOn(importBatchBuilder, 'saveBatch');

    const importer = getImporter(jsonData);
    await importer(jsonData, requestUserId, () => importBatchBuilder);

    expect(importBatchBuilder.startConversation).toHaveBeenCalledWith(EModelEndpoint.openAI);
    expect(importBatchBuilder.saveMessage).toHaveBeenCalledTimes(expectedNumberOfMessages);
    expect(importBatchBuilder.finishConversation).toHaveBeenCalledTimes(jsonData.length);
    expect(importBatchBuilder.saveBatch).toHaveBeenCalled();
  });

  it('should maintain correct message hierarchy (tree parent/children relationship)', async () => {
    const jsonData = JSON.parse(
      fs.readFileSync(path.join(__dirname, '__data__', 'chatgpt-tree.json'), 'utf8'),
    );
    const requestUserId = 'user-123';
    const importBatchBuilder = new ImportBatchBuilder(requestUserId);

    jest.spyOn(importBatchBuilder, 'saveMessage');
    jest.spyOn(importBatchBuilder, 'saveBatch');

    const importer = getImporter(jsonData);
    await importer(jsonData, requestUserId, () => importBatchBuilder);

    const entries = Object.keys(jsonData[0].mapping);
    const messageEntries = entries.filter(
      (id) =>
        jsonData[0].mapping[id].message &&
        jsonData[0].mapping[id].message.author.role !== 'system' &&
        jsonData[0].mapping[id].message.content,
    );

    expect(importBatchBuilder.saveMessage).toHaveBeenCalledTimes(messageEntries.length);

    const idToUUIDMap = new Map();
    importBatchBuilder.saveMessage.mock.calls.forEach((call, index) => {
      const originalId = messageEntries[index];
      idToUUIDMap.set(originalId, call[0].messageId);
    });

    expect(idToUUIDMap.size).toBe(messageEntries.length);

    messageEntries.forEach((id) => {
      const { parent } = jsonData[0].mapping[id];

      const expectedParentId = parent
        ? (idToUUIDMap.get(parent) ?? Constants.NO_PARENT)
        : Constants.NO_PARENT;

      const actualMessageId = idToUUIDMap.get(id);
      const actualParentId = actualMessageId
        ? importBatchBuilder.saveMessage.mock.calls.find(
            (call) => call[0].messageId === actualMessageId,
          )[0].parentMessageId
        : Constants.NO_PARENT;

      expect(actualParentId).toBe(expectedParentId);
    });

    expect(importBatchBuilder.saveBatch).toHaveBeenCalled();
  });

  it('should handle system messages without breaking parent-child relationships', async () => {
    /**
     * Test data that reproduces message graph "breaking" when it encounters a system message
     */
    const testData = [
      {
        title: 'System Message Parent Test',
        create_time: 1714585031.148505,
        update_time: 1714585060.879308,
        mapping: {
          'root-node': {
            id: 'root-node',
            message: null,
            parent: null,
            children: ['user-msg-1'],
          },
          'user-msg-1': {
            id: 'user-msg-1',
            message: {
              id: 'user-msg-1',
              author: { role: 'user' },
              create_time: 1714585031.150442,
              content: { content_type: 'text', parts: ['First user message'] },
              metadata: { model_slug: 'gpt-4' },
            },
            parent: 'root-node',
            children: ['assistant-msg-1'],
          },
          'assistant-msg-1': {
            id: 'assistant-msg-1',
            message: {
              id: 'assistant-msg-1',
              author: { role: 'assistant' },
              create_time: 1714585032.150442,
              content: { content_type: 'text', parts: ['First assistant response'] },
              metadata: { model_slug: 'gpt-4' },
            },
            parent: 'user-msg-1',
            children: ['system-msg'],
          },
          'system-msg': {
            id: 'system-msg',
            message: {
              id: 'system-msg',
              author: { role: 'system' },
              create_time: 1714585033.150442,
              content: { content_type: 'text', parts: ['System message in middle'] },
              metadata: { model_slug: 'gpt-4' },
            },
            parent: 'assistant-msg-1',
            children: ['user-msg-2'],
          },
          'user-msg-2': {
            id: 'user-msg-2',
            message: {
              id: 'user-msg-2',
              author: { role: 'user' },
              create_time: 1714585034.150442,
              content: { content_type: 'text', parts: ['Second user message'] },
              metadata: { model_slug: 'gpt-4' },
            },
            parent: 'system-msg',
            children: ['assistant-msg-2'],
          },
          'assistant-msg-2': {
            id: 'assistant-msg-2',
            message: {
              id: 'assistant-msg-2',
              author: { role: 'assistant' },
              create_time: 1714585035.150442,
              content: { content_type: 'text', parts: ['Second assistant response'] },
              metadata: { model_slug: 'gpt-4' },
            },
            parent: 'user-msg-2',
            children: [],
          },
        },
      },
    ];

    const requestUserId = 'user-123';
    const importBatchBuilder = new ImportBatchBuilder(requestUserId);
    jest.spyOn(importBatchBuilder, 'saveMessage');

    const importer = getImporter(testData);
    await importer(testData, requestUserId, () => importBatchBuilder);

    /** 2 user messages + 2 assistant messages (system message should be skipped) */
    const expectedMessages = 4;
    expect(importBatchBuilder.saveMessage).toHaveBeenCalledTimes(expectedMessages);

    const savedMessages = importBatchBuilder.saveMessage.mock.calls.map((call) => call[0]);

    const messageMap = new Map();
    savedMessages.forEach((msg) => {
      messageMap.set(msg.text, msg);
    });

    const firstUser = messageMap.get('First user message');
    const firstAssistant = messageMap.get('First assistant response');
    const secondUser = messageMap.get('Second user message');
    const secondAssistant = messageMap.get('Second assistant response');

    expect(firstUser).toBeDefined();
    expect(firstAssistant).toBeDefined();
    expect(secondUser).toBeDefined();
    expect(secondAssistant).toBeDefined();
    expect(firstUser.parentMessageId).toBe(Constants.NO_PARENT);
    expect(firstAssistant.parentMessageId).toBe(firstUser.messageId);

    // This is the key test: second user message should have first assistant as parent
    // (not NO_PARENT which would indicate the system message broke the chain)
    expect(secondUser.parentMessageId).toBe(firstAssistant.messageId);
    expect(secondAssistant.parentMessageId).toBe(secondUser.messageId);
  });

  it('should maintain correct sender for user messages regardless of GPT-4 model', async () => {
    /**
     * Test data with GPT-4 model to ensure user messages keep 'user' sender
     */
    const testData = [
      {
        title: 'GPT-4 Sender Test',
        create_time: 1714585031.148505,
        update_time: 1714585060.879308,
        mapping: {
          'root-node': {
            id: 'root-node',
            message: null,
            parent: null,
            children: ['user-msg-1'],
          },
          'user-msg-1': {
            id: 'user-msg-1',
            message: {
              id: 'user-msg-1',
              author: { role: 'user' },
              create_time: 1714585031.150442,
              content: { content_type: 'text', parts: ['User message with GPT-4'] },
              metadata: { model_slug: 'gpt-4' },
            },
            parent: 'root-node',
            children: ['assistant-msg-1'],
          },
          'assistant-msg-1': {
            id: 'assistant-msg-1',
            message: {
              id: 'assistant-msg-1',
              author: { role: 'assistant' },
              create_time: 1714585032.150442,
              content: { content_type: 'text', parts: ['Assistant response with GPT-4'] },
              metadata: { model_slug: 'gpt-4' },
            },
            parent: 'user-msg-1',
            children: ['user-msg-2'],
          },
          'user-msg-2': {
            id: 'user-msg-2',
            message: {
              id: 'user-msg-2',
              author: { role: 'user' },
              create_time: 1714585033.150442,
              content: { content_type: 'text', parts: ['Another user message with GPT-4o-mini'] },
              metadata: { model_slug: 'gpt-4o-mini' },
            },
            parent: 'assistant-msg-1',
            children: ['assistant-msg-2'],
          },
          'assistant-msg-2': {
            id: 'assistant-msg-2',
            message: {
              id: 'assistant-msg-2',
              author: { role: 'assistant' },
              create_time: 1714585034.150442,
              content: { content_type: 'text', parts: ['Assistant response with GPT-3.5'] },
              metadata: { model_slug: 'gpt-3.5-turbo' },
            },
            parent: 'user-msg-2',
            children: [],
          },
        },
      },
    ];

    const requestUserId = 'user-123';
    const importBatchBuilder = new ImportBatchBuilder(requestUserId);
    jest.spyOn(importBatchBuilder, 'saveMessage');

    const importer = getImporter(testData);
    await importer(testData, requestUserId, () => importBatchBuilder);

    const savedMessages = importBatchBuilder.saveMessage.mock.calls.map((call) => call[0]);

    const userMsg1 = savedMessages.find((msg) => msg.text === 'User message with GPT-4');
    const assistantMsg1 = savedMessages.find((msg) => msg.text === 'Assistant response with GPT-4');
    const userMsg2 = savedMessages.find(
      (msg) => msg.text === 'Another user message with GPT-4o-mini',
    );
    const assistantMsg2 = savedMessages.find(
      (msg) => msg.text === 'Assistant response with GPT-3.5',
    );

    expect(userMsg1.sender).toBe('user');
    expect(userMsg1.isCreatedByUser).toBe(true);
    expect(userMsg1.isUserSubmitted).toBe(true);
    expect(userMsg1.model).toBe('gpt-4');

    expect(userMsg2.sender).toBe('user');
    expect(userMsg2.isCreatedByUser).toBe(true);
    expect(userMsg2.isUserSubmitted).toBe(true);
    expect(userMsg2.model).toBe('gpt-4o-mini');

    expect(assistantMsg1.sender).toBe('GPT-4');
    expect(assistantMsg1.isCreatedByUser).toBe(false);
    expect(assistantMsg1.isUserSubmitted).toBe(true);
    expect(assistantMsg1.model).toBe('gpt-4');

    expect(assistantMsg2.sender).toBe('GPT-3.5-turbo');
    expect(assistantMsg2.isCreatedByUser).toBe(false);
    expect(assistantMsg2.isUserSubmitted).toBe(true);
    expect(assistantMsg2.model).toBe('gpt-3.5-turbo');
  });

  it('should correctly extract and format model names from various model slugs', async () => {
    /**
     * Test data with various model slugs to test dynamic model identifier extraction
     */
    const testData = [
      {
        title: 'Dynamic Model Identifier Test',
        create_time: 1714585031.148505,
        update_time: 1714585060.879308,
        mapping: {
          'root-node': {
            id: 'root-node',
            message: null,
            parent: null,
            children: ['msg-1'],
          },
          'msg-1': {
            id: 'msg-1',
            message: {
              id: 'msg-1',
              author: { role: 'user' },
              create_time: 1714585031.150442,
              content: { content_type: 'text', parts: ['Test message'] },
              metadata: {},
            },
            parent: 'root-node',
            children: ['msg-2', 'msg-3', 'msg-4', 'msg-5', 'msg-6', 'msg-7', 'msg-8', 'msg-9'],
          },
          'msg-2': {
            id: 'msg-2',
            message: {
              id: 'msg-2',
              author: { role: 'assistant' },
              create_time: 1714585032.150442,
              content: { content_type: 'text', parts: ['GPT-4 response'] },
              metadata: { model_slug: 'gpt-4' },
            },
            parent: 'msg-1',
            children: [],
          },
          'msg-3': {
            id: 'msg-3',
            message: {
              id: 'msg-3',
              author: { role: 'assistant' },
              create_time: 1714585033.150442,
              content: { content_type: 'text', parts: ['GPT-4o response'] },
              metadata: { model_slug: 'gpt-4o' },
            },
            parent: 'msg-1',
            children: [],
          },
          'msg-4': {
            id: 'msg-4',
            message: {
              id: 'msg-4',
              author: { role: 'assistant' },
              create_time: 1714585034.150442,
              content: { content_type: 'text', parts: ['GPT-4o-mini response'] },
              metadata: { model_slug: 'gpt-4o-mini' },
            },
            parent: 'msg-1',
            children: [],
          },
          'msg-5': {
            id: 'msg-5',
            message: {
              id: 'msg-5',
              author: { role: 'assistant' },
              create_time: 1714585035.150442,
              content: { content_type: 'text', parts: ['GPT-3.5-turbo response'] },
              metadata: { model_slug: 'gpt-3.5-turbo' },
            },
            parent: 'msg-1',
            children: [],
          },
          'msg-6': {
            id: 'msg-6',
            message: {
              id: 'msg-6',
              author: { role: 'assistant' },
              create_time: 1714585036.150442,
              content: { content_type: 'text', parts: ['GPT-4-turbo response'] },
              metadata: { model_slug: 'gpt-4-turbo' },
            },
            parent: 'msg-1',
            children: [],
          },
          'msg-7': {
            id: 'msg-7',
            message: {
              id: 'msg-7',
              author: { role: 'assistant' },
              create_time: 1714585037.150442,
              content: { content_type: 'text', parts: ['GPT-4-1106-preview response'] },
              metadata: { model_slug: 'gpt-4-1106-preview' },
            },
            parent: 'msg-1',
            children: [],
          },
          'msg-8': {
            id: 'msg-8',
            message: {
              id: 'msg-8',
              author: { role: 'assistant' },
              create_time: 1714585038.150442,
              content: { content_type: 'text', parts: ['Claude response'] },
              metadata: { model_slug: 'claude-3-opus' },
            },
            parent: 'msg-1',
            children: [],
          },
          'msg-9': {
            id: 'msg-9',
            message: {
              id: 'msg-9',
              author: { role: 'assistant' },
              create_time: 1714585039.150442,
              content: { content_type: 'text', parts: ['No model slug response'] },
              metadata: {},
            },
            parent: 'msg-1',
            children: [],
          },
        },
      },
    ];

    const requestUserId = 'user-123';
    const importBatchBuilder = new ImportBatchBuilder(requestUserId);
    jest.spyOn(importBatchBuilder, 'saveMessage');

    const importer = getImporter(testData);
    await importer(testData, requestUserId, () => importBatchBuilder);

    const savedMessages = importBatchBuilder.saveMessage.mock.calls.map((call) => call[0]);

    // Test various GPT model slug formats
    const gpt4 = savedMessages.find((msg) => msg.text === 'GPT-4 response');
    expect(gpt4.sender).toBe('GPT-4');
    expect(gpt4.model).toBe('gpt-4');

    const gpt4o = savedMessages.find((msg) => msg.text === 'GPT-4o response');
    expect(gpt4o.sender).toBe('GPT-4o');
    expect(gpt4o.model).toBe('gpt-4o');

    const gpt4oMini = savedMessages.find((msg) => msg.text === 'GPT-4o-mini response');
    expect(gpt4oMini.sender).toBe('GPT-4o-mini');
    expect(gpt4oMini.model).toBe('gpt-4o-mini');

    const gpt35Turbo = savedMessages.find((msg) => msg.text === 'GPT-3.5-turbo response');
    expect(gpt35Turbo.sender).toBe('GPT-3.5-turbo');
    expect(gpt35Turbo.model).toBe('gpt-3.5-turbo');

    const gpt4Turbo = savedMessages.find((msg) => msg.text === 'GPT-4-turbo response');
    expect(gpt4Turbo.sender).toBe('GPT-4-turbo');
    expect(gpt4Turbo.model).toBe('gpt-4-turbo');

    const gpt4Preview = savedMessages.find((msg) => msg.text === 'GPT-4-1106-preview response');
    expect(gpt4Preview.sender).toBe('GPT-4-1106-preview');
    expect(gpt4Preview.model).toBe('gpt-4-1106-preview');

    // Test non-GPT model (should use the model slug as sender)
    const claude = savedMessages.find((msg) => msg.text === 'Claude response');
    expect(claude.sender).toBe('claude-3-opus');
    expect(claude.model).toBe('claude-3-opus');

    // Test missing model slug (should default to openAISettings.model.default)
    const noModel = savedMessages.find((msg) => msg.text === 'No model slug response');
    // When no model slug is provided, it defaults to gpt-4o-mini which gets formatted to GPT-4o-mini
    expect(noModel.sender).toBe('GPT-4o-mini');
    expect(noModel.model).toBe(openAISettings.model.default);

    // Verify user message is unaffected
    const userMsg = savedMessages.find((msg) => msg.text === 'Test message');
    expect(userMsg.sender).toBe('user');
    expect(userMsg.isCreatedByUser).toBe(true);
  });

  it('should merge thinking content into assistant message', async () => {
    const testData = [
      {
        title: 'Thinking Content Test',
        create_time: 1000,
        update_time: 2000,
        mapping: {
          'root-node': {
            id: 'root-node',
            message: null,
            parent: null,
            children: ['user-msg-1'],
          },
          'user-msg-1': {
            id: 'user-msg-1',
            message: {
              id: 'user-msg-1',
              author: { role: 'user' },
              create_time: 1,
              content: { content_type: 'text', parts: ['What is 2+2?'] },
              metadata: {},
            },
            parent: 'root-node',
            children: ['thoughts-msg'],
          },
          'thoughts-msg': {
            id: 'thoughts-msg',
            message: {
              id: 'thoughts-msg',
              author: { role: 'assistant' },
              create_time: 2,
              content: {
                content_type: 'thoughts',
                thoughts: [
                  { content: 'Let me think about this math problem.' },
                  { content: 'Adding 2 and 2 together gives 4.' },
                ],
              },
              metadata: {},
            },
            parent: 'user-msg-1',
            children: ['reasoning-recap-msg'],
          },
          'reasoning-recap-msg': {
            id: 'reasoning-recap-msg',
            message: {
              id: 'reasoning-recap-msg',
              author: { role: 'assistant' },
              create_time: 3,
              content: {
                content_type: 'reasoning_recap',
                recap_text: 'Thought for 2 seconds',
              },
              metadata: {},
            },
            parent: 'thoughts-msg',
            children: ['assistant-msg-1'],
          },
          'assistant-msg-1': {
            id: 'assistant-msg-1',
            message: {
              id: 'assistant-msg-1',
              author: { role: 'assistant' },
              create_time: 4,
              content: { content_type: 'text', parts: ['The answer is 4.'] },
              metadata: {},
            },
            parent: 'reasoning-recap-msg',
            children: [],
          },
        },
      },
    ];

    const requestUserId = 'user-123';
    const importBatchBuilder = new ImportBatchBuilder(requestUserId);
    jest.spyOn(importBatchBuilder, 'saveMessage');

    const importer = getImporter(testData);
    await importer(testData, requestUserId, () => importBatchBuilder);

    const savedMessages = importBatchBuilder.saveMessage.mock.calls.map((call) => call[0]);

    // Should only have 2 messages: user message and assistant response
    // (thoughts and reasoning_recap should be merged/skipped)
    expect(savedMessages).toHaveLength(2);

    const userMsg = savedMessages.find((msg) => msg.text === 'What is 2+2?');
    const assistantMsg = savedMessages.find((msg) => msg.text === 'The answer is 4.');

    expect(userMsg).toBeDefined();
    expect(assistantMsg).toBeDefined();

    // Assistant message should have content array with thinking block
    expect(assistantMsg.content).toBeDefined();
    expect(assistantMsg.content).toHaveLength(2);
    expect(assistantMsg.content[0].type).toBe('think');
    expect(assistantMsg.content[0].think).toContain('Let me think about this math problem.');
    expect(assistantMsg.content[0].think).toContain('Adding 2 and 2 together gives 4.');
    expect(assistantMsg.content[1].type).toBe('text');
    expect(assistantMsg.content[1].text).toBe('The answer is 4.');

    // Verify parent-child relationship is correct (skips thoughts and reasoning_recap)
    expect(assistantMsg.parentMessageId).toBe(userMsg.messageId);
  });

  it('should skip reasoning_recap and thoughts messages as separate entries', async () => {
    const testData = [
      {
        title: 'Skip Thinking Messages Test',
        create_time: 1000,
        update_time: 2000,
        mapping: {
          'root-node': {
            id: 'root-node',
            message: null,
            parent: null,
            children: ['user-msg-1'],
          },
          'user-msg-1': {
            id: 'user-msg-1',
            message: {
              id: 'user-msg-1',
              author: { role: 'user' },
              create_time: 1,
              content: { content_type: 'text', parts: ['Hello'] },
              metadata: {},
            },
            parent: 'root-node',
            children: ['thoughts-msg'],
          },
          'thoughts-msg': {
            id: 'thoughts-msg',
            message: {
              id: 'thoughts-msg',
              author: { role: 'assistant' },
              create_time: 2,
              content: {
                content_type: 'thoughts',
                thoughts: [{ content: 'Thinking...' }],
              },
              metadata: {},
            },
            parent: 'user-msg-1',
            children: ['reasoning-recap-msg'],
          },
          'reasoning-recap-msg': {
            id: 'reasoning-recap-msg',
            message: {
              id: 'reasoning-recap-msg',
              author: { role: 'assistant' },
              create_time: 3,
              content: {
                content_type: 'reasoning_recap',
                recap_text: 'Thought for 1 second',
              },
              metadata: {},
            },
            parent: 'thoughts-msg',
            children: ['assistant-msg-1'],
          },
          'assistant-msg-1': {
            id: 'assistant-msg-1',
            message: {
              id: 'assistant-msg-1',
              author: { role: 'assistant' },
              create_time: 4,
              content: { content_type: 'text', parts: ['Hi there!'] },
              metadata: {},
            },
            parent: 'reasoning-recap-msg',
            children: [],
          },
        },
      },
    ];

    const requestUserId = 'user-123';
    const importBatchBuilder = new ImportBatchBuilder(requestUserId);
    jest.spyOn(importBatchBuilder, 'saveMessage');

    const importer = getImporter(testData);
    await importer(testData, requestUserId, () => importBatchBuilder);

    const savedMessages = importBatchBuilder.saveMessage.mock.calls.map((call) => call[0]);

    // Verify no messages have thoughts or reasoning_recap content types
    const thoughtsMessages = savedMessages.filter(
      (msg) =>
        msg.text === '' || msg.text?.includes('Thinking...') || msg.text?.includes('Thought for'),
    );
    expect(thoughtsMessages).toHaveLength(0);

    // Only user and assistant text messages should be saved
    expect(savedMessages).toHaveLength(2);
    expect(savedMessages.map((m) => m.text).sort()).toEqual(['Hello', 'Hi there!'].sort());
  });

  it('should set createdAt from ChatGPT create_time', async () => {
    const testData = [
      {
        title: 'Timestamp Test',
        create_time: 1000,
        update_time: 2000,
        mapping: {
          'root-node': {
            id: 'root-node',
            message: null,
            parent: null,
            children: ['user-msg-1'],
          },
          'user-msg-1': {
            id: 'user-msg-1',
            message: {
              id: 'user-msg-1',
              author: { role: 'user' },
              create_time: 1000,
              content: { content_type: 'text', parts: ['Test message'] },
              metadata: {},
            },
            parent: 'root-node',
            children: ['assistant-msg-1'],
          },
          'assistant-msg-1': {
            id: 'assistant-msg-1',
            message: {
              id: 'assistant-msg-1',
              author: { role: 'assistant' },
              create_time: 2000,
              content: { content_type: 'text', parts: ['Response'] },
              metadata: {},
            },
            parent: 'user-msg-1',
            children: [],
          },
        },
      },
    ];

    const requestUserId = 'user-123';
    const importBatchBuilder = new ImportBatchBuilder(requestUserId);
    jest.spyOn(importBatchBuilder, 'saveMessage');

    const importer = getImporter(testData);
    await importer(testData, requestUserId, () => importBatchBuilder);

    const savedMessages = importBatchBuilder.saveMessage.mock.calls.map((call) => call[0]);

    const userMsg = savedMessages.find((msg) => msg.text === 'Test message');
    const assistantMsg = savedMessages.find((msg) => msg.text === 'Response');

    // Verify createdAt is set from create_time (converted from Unix timestamp)
    expect(userMsg.createdAt).toEqual(new Date(1000 * 1000));
    expect(assistantMsg.createdAt).toEqual(new Date(2000 * 1000));
  });

  it('should import messages missing metadata without failing (newer ChatGPT exports)', async () => {
    const testData = [
      {
        title: 'Missing Metadata Test',
        create_time: 1714585031.148505,
        update_time: 1714585060.879308,
        mapping: {
          'root-node': {
            id: 'root-node',
            message: null,
            parent: null,
            children: ['user-msg-1'],
          },
          'user-msg-1': {
            id: 'user-msg-1',
            message: {
              id: 'user-msg-1',
              author: { role: 'user' },
              create_time: 1714585031.150442,
              content: { content_type: 'text', parts: ['User message without metadata'] },
            },
            parent: 'root-node',
            children: ['assistant-msg-1'],
          },
          'assistant-msg-1': {
            id: 'assistant-msg-1',
            message: {
              id: 'assistant-msg-1',
              author: { role: 'assistant' },
              create_time: 1714585032.150442,
              content: { content_type: 'text', parts: ['Assistant response without metadata'] },
            },
            parent: 'user-msg-1',
            children: ['no-content-msg'],
          },
          'no-content-msg': {
            id: 'no-content-msg',
            message: {
              id: 'no-content-msg',
              author: { role: 'tool' },
              create_time: 1714585033.150442,
            },
            parent: 'assistant-msg-1',
            children: [],
          },
        },
      },
    ];

    const requestUserId = 'user-123';
    const importBatchBuilder = new ImportBatchBuilder(requestUserId);
    jest.spyOn(importBatchBuilder, 'saveMessage');

    const importer = getImporter(testData);
    await importer(testData, requestUserId, () => importBatchBuilder);

    const savedMessages = importBatchBuilder.saveMessage.mock.calls.map((call) => call[0]);
    expect(savedMessages).toHaveLength(2);

    const userMessage = savedMessages.find((msg) => msg.isCreatedByUser);
    const assistantMessage = savedMessages.find((msg) => !msg.isCreatedByUser);
    expect(userMessage.model).toBe(openAISettings.model.default);
    expect(assistantMessage.model).toBe(openAISettings.model.default);
    expect(assistantMessage.parentMessageId).toBe(userMessage.messageId);
  });

  it('should rethrow errors so failed imports are not reported as successful', async () => {
    const jsonData = JSON.parse(
      fs.readFileSync(path.join(__dirname, '__data__', 'chatgpt-export.json'), 'utf8'),
    );
    const requestUserId = 'user-123';
    const importBatchBuilder = new ImportBatchBuilder(requestUserId);
    jest.spyOn(importBatchBuilder, 'saveBatch').mockRejectedValue(new Error('db unavailable'));

    const importer = getImporter(jsonData);
    await expect(importer(jsonData, requestUserId, () => importBatchBuilder)).rejects.toThrow(
      'db unavailable',
    );
  });
});

describe('importLibreChatConvo', () => {
  const jsonDataNonRecursiveBranches = JSON.parse(
    fs.readFileSync(path.join(__dirname, '__data__', 'librechat-opts-nonr-branches.json'), 'utf8'),
  );

  it('should import conversation correctly', async () => {
    mockGetEndpointsConfig.mockResolvedValue({
      [EModelEndpoint.openAI]: {},
    });
    const expectedNumberOfMessages = 6;
    const jsonData = JSON.parse(
      fs.readFileSync(path.join(__dirname, '__data__', 'librechat-export.json'), 'utf8'),
    );
    const requestUserId = 'user-123';
    const importBatchBuilder = new ImportBatchBuilder(requestUserId);

    // Spy on instance methods
    jest.spyOn(importBatchBuilder, 'startConversation');
    jest.spyOn(importBatchBuilder, 'saveMessage');
    jest.spyOn(importBatchBuilder, 'finishConversation');
    jest.spyOn(importBatchBuilder, 'saveBatch');

    const importer = getImporter(jsonData);
    await importer(jsonData, requestUserId, () => importBatchBuilder);

    expect(importBatchBuilder.startConversation).toHaveBeenCalledWith(EModelEndpoint.openAI);
    expect(importBatchBuilder.saveMessage).toHaveBeenCalledTimes(expectedNumberOfMessages);
    expect(
      importBatchBuilder.saveMessage.mock.calls.every(
        ([message]) => message.isUserSubmitted === true,
      ),
    ).toBe(true);
    expect(
      importBatchBuilder.saveMessage.mock.calls.some(
        ([message]) => message.isCreatedByUser === false && message.isUserSubmitted === true,
      ),
    ).toBe(true);
    expect(importBatchBuilder.finishConversation).toHaveBeenCalledTimes(1);
    expect(importBatchBuilder.saveBatch).toHaveBeenCalled();
  });

  it.each([
    ['linear', false, false],
    ['recursive', true, false],
    ['numeric-author', false, 0],
    ['omitted-author', false, undefined],
  ])('strips MCP-UI attachments from %s imports', async (_format, recursive, authorFlag) => {
    const message = {
      messageId: 'message-1',
      parentMessageId: Constants.NO_PARENT,
      text: { _id: '\\ui{malicious}' },
      isCreatedByUser: authorFlag,
      content: [
        { type: ContentTypes.TEXT, text: 'Before \\ui{malicious} after' },
        { type: ContentTypes.TEXT, text: '`\\ui{literal}`' },
        {
          type: ContentTypes.TEXT,
          text: {
            value: 'Object \\ui{malicious} value',
            annotations: [{ type: 'citation' }],
          },
        },
        {
          type: ContentTypes.TOOL_CALL,
          tool_call: {
            subagent_content: [{ type: ContentTypes.TEXT, text: 'Nested \\ui{malicious} content' }],
          },
        },
      ],
      attachments: [
        {
          type: Tools.ui_resources,
          [Tools.ui_resources]: [
            {
              resourceId: 'malicious',
              mimeType: 'application/vnd.mcp-ui.remote-dom+javascript',
              text: "root.innerHTML='<img src=x onerror=alert(window.origin)>'",
            },
          ],
        },
        { type: Tools.web_search, [Tools.web_search]: { results: [] } },
      ],
    };
    const jsonData = {
      conversationId: 'malicious-import',
      title: 'Malicious import',
      recursive,
      ...(recursive ? { messagesTree: [message] } : { messages: [message] }),
    };
    const importBatchBuilder = new ImportBatchBuilder('user-123');

    const importer = getImporter(jsonData);
    await importer(jsonData, 'user-123', () => importBatchBuilder);

    expect(importBatchBuilder.messages[0].attachments).toEqual([
      { type: Tools.web_search, [Tools.web_search]: { results: [] } },
    ]);
    expect(importBatchBuilder.messages[0].text).toBe('');
    expect(importBatchBuilder.messages[0].content).toEqual([
      { type: ContentTypes.TEXT, text: 'Before  after' },
      { type: ContentTypes.TEXT, text: '`\\ui{literal}`' },
      {
        type: ContentTypes.TEXT,
        text: { value: 'Object  value', annotations: [{ type: 'citation' }] },
      },
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          subagent_content: [{ type: ContentTypes.TEXT, text: 'Nested  content' }],
        },
      },
    ]);
  });

  it('drops server-private context meta and trace sampling from imported messages', async () => {
    const message = {
      messageId: 'message-1',
      parentMessageId: Constants.NO_PARENT,
      text: 'Imported response',
      isCreatedByUser: false,
      langfuseSampled: true,
      langfuseDestinationIds: ['forged-destination'],
      langfuseRunId: 'someone-elses-run',
      contextMeta: {
        calibrationRatio: 1,
        encoding: 'claude',
        fading: { v: 1, budgetTokens: 1, masked: true },
      },
    };
    const jsonData = {
      conversationId: 'context-meta-import',
      title: 'Context meta import',
      recursive: false,
      messages: [message],
    };
    const importBatchBuilder = new ImportBatchBuilder('user-123');

    const importer = getImporter(jsonData);
    await importer(jsonData, 'user-123', () => importBatchBuilder);

    expect(importBatchBuilder.messages[0]).not.toHaveProperty('contextMeta');
    expect(importBatchBuilder.messages[0].langfuseSampled).toBe(false);
    expect(importBatchBuilder.messages[0]).not.toHaveProperty('langfuseDestinationIds');
    expect(importBatchBuilder.messages[0]).not.toHaveProperty('langfuseRunId');
    expect(importBatchBuilder.messages[0].isUserSubmitted).toBe(true);
  });

  it('sanitizes singleton content and attachment fields before Mongoose array casting', async () => {
    const message = {
      messageId: 'message-1',
      parentMessageId: Constants.NO_PARENT,
      text: '\\ui{malicious}',
      isCreatedByUser: false,
      error: true,
      content: { type: ContentTypes.TEXT, text: 'Before \\ui{malicious} after' },
      attachments: { type: Tools.ui_resources, [Tools.ui_resources]: [] },
    };
    const jsonData = {
      conversationId: 'singleton-import',
      title: 'Singleton fields',
      recursive: false,
      messages: [message],
    };
    const importBatchBuilder = new ImportBatchBuilder('user-123');

    const importer = getImporter(jsonData);
    await importer(jsonData, 'user-123', () => importBatchBuilder);

    expect(importBatchBuilder.messages[0].content).toEqual([
      { type: ContentTypes.TEXT, text: 'Before  after' },
    ]);
    expect(importBatchBuilder.messages[0].attachments).toEqual([]);
    expect(importBatchBuilder.messages[0].text).toBe('');
  });

  it.each([true, null])(
    'matches text and content renderers for author flag %s while stripping attachments',
    async (authorFlag) => {
      const message = {
        messageId: 'message-1',
        parentMessageId: Constants.NO_PARENT,
        text: 'Example: \\ui{literal}',
        isCreatedByUser: authorFlag,
        content: [
          { type: ContentTypes.TEXT, text: 'Part: \\ui{literal}' },
          {
            type: ContentTypes.TOOL_CALL,
            tool_call: {
              name: Constants.SUBAGENT,
              output: 'Legacy \\ui{nested} output',
              subagent_content: [{ type: ContentTypes.TEXT, text: 'Nested \\ui{nested} text' }],
            },
          },
        ],
        attachments: [{ type: Tools.ui_resources, [Tools.ui_resources]: [] }],
      };
      const jsonData = {
        conversationId: 'user-marker-import',
        title: 'User marker import',
        recursive: false,
        messages: [message],
      };
      const importBatchBuilder = new ImportBatchBuilder('user-123');

      const importer = getImporter(jsonData);
      await importer(jsonData, 'user-123', () => importBatchBuilder);

      expect(importBatchBuilder.messages[0].text).toBe('Example: \\ui{literal}');
      expect(importBatchBuilder.messages[0].content).toEqual([
        {
          type: ContentTypes.TEXT,
          text: authorFlag === true ? 'Part: \\ui{literal}' : 'Part: ',
        },
        {
          type: ContentTypes.TOOL_CALL,
          tool_call: {
            name: Constants.SUBAGENT,
            output: 'Legacy  output',
            subagent_content: [{ type: ContentTypes.TEXT, text: 'Nested  text' }],
          },
        },
      ]);
      expect(importBatchBuilder.messages[0].attachments).toEqual([]);
    },
  );

  it('should import linear, non-recursive thread correctly with correct endpoint', async () => {
    mockGetEndpointsConfig.mockResolvedValue({
      [EModelEndpoint.azureOpenAI]: {},
    });

    const jsonData = JSON.parse(
      fs.readFileSync(path.join(__dirname, '__data__', 'librechat-linear.json'), 'utf8'),
    );
    const requestUserId = 'user-123';
    const importBatchBuilder = new ImportBatchBuilder(requestUserId);

    jest.spyOn(importBatchBuilder, 'startConversation');
    jest.spyOn(importBatchBuilder, 'saveMessage');
    jest.spyOn(importBatchBuilder, 'finishConversation');
    jest.spyOn(importBatchBuilder, 'saveBatch');

    const importer = getImporter(jsonData);
    await importer(jsonData, requestUserId, () => importBatchBuilder);

    expect(bulkSaveMessages).toHaveBeenCalledTimes(1);

    const messages = bulkSaveMessages.mock.calls[0][0];
    let lastMessageId = Constants.NO_PARENT;
    for (const message of messages) {
      expect(message.parentMessageId).toBe(lastMessageId);
      lastMessageId = message.messageId;
    }

    expect(importBatchBuilder.startConversation).toHaveBeenCalledWith(EModelEndpoint.azureOpenAI);
    expect(importBatchBuilder.saveMessage).toHaveBeenCalledTimes(jsonData.messages.length);
    expect(importBatchBuilder.finishConversation).toHaveBeenCalled();
    expect(importBatchBuilder.saveBatch).toHaveBeenCalled();
  });

  it('should maintain correct message hierarchy (tree parent/children relationship)', async () => {
    const jsonData = JSON.parse(
      fs.readFileSync(path.join(__dirname, '__data__', 'librechat-tree.json'), 'utf8'),
    );
    const requestUserId = 'user-123';
    const importBatchBuilder = new ImportBatchBuilder(requestUserId);
    jest.spyOn(importBatchBuilder, 'saveMessage');
    jest.spyOn(importBatchBuilder, 'saveBatch');

    const importer = getImporter(jsonData);
    await importer(jsonData, requestUserId, () => importBatchBuilder);

    // Get the imported messages
    const messages = importBatchBuilder.messages;
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.every((message) => message.isUserSubmitted === true)).toBe(true);

    // Build maps for verification
    const textToMessageMap = new Map();
    const messageIdToMessage = new Map();
    messages.forEach((msg) => {
      if (msg.text) {
        // For recursive imports, text might be very long, so just use the first 100 chars as key
        const textKey = msg.text.substring(0, 100);
        textToMessageMap.set(textKey, msg);
      }
      messageIdToMessage.set(msg.messageId, msg);
    });

    // Count expected messages from the tree
    const countMessagesInTree = (nodes) => {
      let count = 0;
      nodes.forEach((node) => {
        if (node.text || node.content) {
          count++;
        }
        if (node.children && node.children.length > 0) {
          count += countMessagesInTree(node.children);
        }
      });
      return count;
    };

    const expectedMessageCount = countMessagesInTree(jsonData.messages);
    expect(messages.length).toBe(expectedMessageCount);

    // Verify all messages have valid parent relationships
    messages.forEach((msg) => {
      if (msg.parentMessageId !== Constants.NO_PARENT) {
        const parent = messageIdToMessage.get(msg.parentMessageId);
        expect(parent).toBeDefined();

        // Verify timestamp ordering
        if (msg.createdAt && parent.createdAt) {
          expect(new Date(msg.createdAt).getTime()).toBeGreaterThanOrEqual(
            new Date(parent.createdAt).getTime(),
          );
        }
      }
    });

    // Verify at least one root message exists
    const rootMessages = messages.filter((msg) => msg.parentMessageId === Constants.NO_PARENT);
    expect(rootMessages.length).toBeGreaterThan(0);

    expect(importBatchBuilder.saveBatch).toHaveBeenCalled();
  });

  it('should maintain correct message hierarchy (non-recursive)', async () => {
    const jsonData = jsonDataNonRecursiveBranches;
    const requestUserId = 'user-123';
    const importBatchBuilder = new ImportBatchBuilder(requestUserId);
    jest.spyOn(importBatchBuilder, 'saveMessage');
    jest.spyOn(importBatchBuilder, 'saveBatch');

    const importer = getImporter(jsonData);
    await importer(jsonData, requestUserId, () => importBatchBuilder);

    const textToMessageMap = new Map();
    importBatchBuilder.saveMessage.mock.calls.forEach((call) => {
      const message = call[0];
      textToMessageMap.set(message.text, message);
    });

    const relationships = {
      'tell me a long story': [
        'Of course! Settle in for a tale of adventure across time and space.\n\n---\n\nOnce upon a time in the small, sleepy village of Eldoria, there was a young woman named Elara who longed for adventure. Eldoria was a place of routine and simplicity, nestled between rolling hills and dense forests, but Elara always felt that there was more to the world than the boundaries',
        'Sure, I can craft a long story for you. Here it goes:\n\n### The Chronicles of Elenor: The Luminary of Anduril\n\nIn an age long forgotten by men, in a world kissed by the glow of dual suns, the Kingdom of Anduril flourished. Verdant valleys graced its land, majestic mountains shielded',
      ],
      'tell me a long long story': [
        'Of course! Here’s a detailed and engaging story:\n\n---\n\n### The Legend of Eldoria\n\nNestled between towering mountains and dense, ancient forests was the enigmatic kingdom of Eldoria. This realm, clo aked in perpetual twilight, was the stuff of legends. It was said that the land was blessed by the gods and guarded by mythical creatures. Eldoria was a place where magic and realism intertwined seamlessly, creating a land of beauty, wonder, and peril.\n\nIn the heart of this kingdom lay the grand city of Lumina, known',
      ],
    };

    Object.keys(relationships).forEach((parentText) => {
      const parentMessage = textToMessageMap.get(parentText);
      const childrenTexts = relationships[parentText];

      childrenTexts.forEach((childText) => {
        const childMessage = textToMessageMap.get(childText);
        expect(childMessage.parentMessageId).toBe(parentMessage.messageId);
      });
    });

    expect(importBatchBuilder.saveBatch).toHaveBeenCalled();
  });

  it('should retain properties from the original conversation as well as new settings', async () => {
    mockGetEndpointsConfig.mockResolvedValue({
      [EModelEndpoint.azureOpenAI]: {},
    });
    const requestUserId = 'user-123';
    const importBatchBuilder = new ImportBatchBuilder(requestUserId);
    jest.spyOn(importBatchBuilder, 'finishConversation');

    const importer = getImporter(jsonDataNonRecursiveBranches);
    await importer(jsonDataNonRecursiveBranches, requestUserId, () => importBatchBuilder);

    expect(importBatchBuilder.finishConversation).toHaveBeenCalledTimes(1);

    const [_title, createdAt, originalConvo] = importBatchBuilder.finishConversation.mock.calls[0];
    const convo = importBatchBuilder.conversations[0];

    expect(convo).toEqual({
      ...jsonDataNonRecursiveBranches.options,
      user: requestUserId,
      conversationId: importBatchBuilder.conversationId,
      title: originalConvo.title || 'Imported Chat',
      createdAt: createdAt,
      updatedAt: createdAt,
      overrideTimestamp: true,
      endpoint: importBatchBuilder.endpoint,
      model: originalConvo.model || openAISettings.model.default,
    });

    expect(convo.title).toBe('Original');
    expect(convo.createdAt).toBeInstanceOf(Date);
    expect(convo.endpoint).toBe(EModelEndpoint.azureOpenAI);
    expect(convo.model).toBe('gpt-4o');
  });

  describe('finishConversation', () => {
    it('should retain properties from the original conversation as well as update with new settings', () => {
      const requestUserId = 'user-123';
      const builder = new ImportBatchBuilder(requestUserId);
      builder.conversationId = 'conv-id-123';
      builder.messages = [{ text: 'Hello, world!' }];

      const originalConvo = {
        _id: 'old-convo-id',
        model: 'custom-model',
      };

      builder.endpoint = 'test-endpoint';

      const title = 'New Chat Title';
      const createdAt = new Date('2023-10-01T00:00:00Z');

      const result = builder.finishConversation(title, createdAt, originalConvo);

      expect(result).toEqual({
        conversation: {
          user: requestUserId,
          conversationId: builder.conversationId,
          title: 'New Chat Title',
          createdAt: createdAt,
          updatedAt: createdAt,
          overrideTimestamp: true,
          endpoint: 'test-endpoint',
          model: 'custom-model',
        },
        messages: builder.messages,
      });

      expect(builder.conversations).toContainEqual({
        user: requestUserId,
        conversationId: builder.conversationId,
        title: 'New Chat Title',
        createdAt: createdAt,
        updatedAt: createdAt,
        overrideTimestamp: true,
        endpoint: 'test-endpoint',
        model: 'custom-model',
      });
    });

    it('should use default values if not provided in the original conversation or as parameters', () => {
      const requestUserId = 'user-123';
      const builder = new ImportBatchBuilder(requestUserId);
      builder.conversationId = 'conv-id-123';
      builder.messages = [{ text: 'Hello, world!' }];
      builder.endpoint = 'test-endpoint';
      const result = builder.finishConversation();
      expect(result.conversation.title).toBe('Imported Chat');
      expect(result.conversation.model).toBe(openAISettings.model.default);
    });

    it('should default to the anthropic model for anthropic-endpoint conversations', () => {
      const requestUserId = 'user-123';
      const builder = new ImportBatchBuilder(requestUserId);
      builder.conversationId = 'conv-id-123';
      builder.messages = [{ text: 'Hello, world!' }];
      builder.endpoint = EModelEndpoint.anthropic;
      const result = builder.finishConversation();
      expect(result.conversation.endpoint).toBe(EModelEndpoint.anthropic);
      expect(result.conversation.model).toBe(anthropicSettings.model.default);
    });

    it('should default to the openAI model for openAI-endpoint conversations', () => {
      const requestUserId = 'user-123';
      const builder = new ImportBatchBuilder(requestUserId);
      builder.conversationId = 'conv-id-123';
      builder.messages = [{ text: 'Hello, world!' }];
      builder.endpoint = EModelEndpoint.openAI;
      const result = builder.finishConversation();
      expect(result.conversation.endpoint).toBe(EModelEndpoint.openAI);
      expect(result.conversation.model).toBe(openAISettings.model.default);
    });

    it.each([undefined, 2160])(
      'applies all-data retention to imports with general retention %s',
      (generalChatRetention) => {
        const requestUserId = 'user-123';
        const builder = new ImportBatchBuilder(requestUserId, {
          retentionMode: RetentionMode.ALL,
          temporaryChatRetention: 24,
          generalChatRetention,
        });
        const now = Date.now();
        builder.startConversation(EModelEndpoint.openAI);
        const message = builder.addUserMessage('Retained import');
        const result = builder.finishConversation('Imported retained chat');

        expect(message.isTemporary).toBe(false);
        expect(message.expiredAt).toBeInstanceOf(Date);
        expect(result.conversation.isTemporary).toBe(false);
        expect(result.conversation.expiredAt).toBeInstanceOf(Date);
        expect(result.conversation.expiredAt).toBe(message.expiredAt);
        const hours = generalChatRetention ?? 24;
        expect(message.expiredAt.getTime()).toBeGreaterThanOrEqual(now + hours * 3600000);
        expect(message.expiredAt.getTime()).toBeLessThan(now + hours * 3600000 + 1000);
      },
    );
  });
});

describe('importChatBotUiConvo', () => {
  it('should import custom conversation correctly', async () => {
    const jsonData = JSON.parse(
      fs.readFileSync(path.join(__dirname, '__data__', 'chatbotui-export.json'), 'utf8'),
    );
    const requestUserId = 'custom-user-456';
    const importBatchBuilder = new ImportBatchBuilder(requestUserId);

    // Spy on instance methods
    jest.spyOn(importBatchBuilder, 'startConversation');
    jest.spyOn(importBatchBuilder, 'saveMessage');
    jest.spyOn(importBatchBuilder, 'addUserMessage');
    jest.spyOn(importBatchBuilder, 'addGptMessage');
    jest.spyOn(importBatchBuilder, 'finishConversation');
    jest.spyOn(importBatchBuilder, 'saveBatch');

    const importer = getImporter(jsonData);
    await importer(jsonData, requestUserId, () => importBatchBuilder);

    expect(importBatchBuilder.startConversation).toHaveBeenCalledWith(EModelEndpoint.openAI);
    expect(importBatchBuilder.addUserMessage).toHaveBeenCalledTimes(3);
    expect(importBatchBuilder.addUserMessage).toHaveBeenNthCalledWith(
      1,
      'Hello what are you able to do?',
    );
    expect(importBatchBuilder.addUserMessage).toHaveBeenNthCalledWith(
      3,
      'Give me the code that inverts binary tree in COBOL',
    );

    expect(importBatchBuilder.addGptMessage).toHaveBeenCalledTimes(3);
    expect(importBatchBuilder.addGptMessage).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/^Hello! As an AI developed by OpenAI/),
      'gpt-4-1106-preview',
    );
    expect(importBatchBuilder.addGptMessage).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('```cobol'),
      'gpt-3.5-turbo',
    );

    expect(importBatchBuilder.finishConversation).toHaveBeenCalledTimes(2);
    expect(importBatchBuilder.finishConversation).toHaveBeenNthCalledWith(
      1,
      'Hello what are you able to do?',
      expect.any(Date),
      {},
      expect.any(String),
    );
    expect(importBatchBuilder.finishConversation).toHaveBeenNthCalledWith(
      2,
      'Give me the code that inverts ...',
      expect.any(Date),
      {},
      expect.any(String),
    );

    expect(importBatchBuilder.saveBatch).toHaveBeenCalled();
  });
});

describe('getImporter', () => {
  it('should throw an error if the import type is not supported', () => {
    const jsonData = { unsupported: 'data' };
    expect(() => getImporter(jsonData)).toThrow('Unsupported import type');
  });

  it('should throw for array-based files that are not ChatGPT or Claude exports', () => {
    const openWebUiExport = [
      { id: 'abc', title: 'Open WebUI Chat', chat: { history: { messages: {} } } },
    ];
    expect(() => getImporter(openWebUiExport)).toThrow('Unsupported import type');
  });

  it('should route empty arrays to the ChatGPT importer without throwing', () => {
    expect(() => getImporter([])).not.toThrow();
  });
});

describe('processAssistantMessage', () => {
  const testMessage = 'This is a test citation 【3:0†source】【3:1†source】';

  const messageData = {
    metadata: {
      citations: [
        {
          start_ix: 23, // Position of first "【3:0†source】"
          end_ix: 36, // End of first citation (including closing bracket)
          citation_format_type: 'tether_og',
          metadata: {
            type: 'webpage',
            title: 'Signal Sciences - Crunchbase Company Profile & Funding',
            url: 'https://www.crunchbase.com/organization/signal-sciences',
            text: '',
            pub_date: null,
            extra: {
              evidence_text: 'source',
              cited_message_idx: 3,
              search_result_idx: 0,
            },
          },
        },
        {
          start_ix: 36, // Position of second "【3:1†source】"
          end_ix: 49, // End of second citation (including closing bracket)
          citation_format_type: 'tether_og',
          metadata: {
            type: 'webpage',
            title: 'Demand More from Your WAF - Signal Sciences now part of Fastly',
            url: 'https://www.signalsciences.com/',
            text: '',
            pub_date: null,
            extra: {
              evidence_text: 'source',
              cited_message_idx: 3,
              search_result_idx: 1,
            },
          },
        },
      ],
    },
  };

  const messageText = testMessage;
  const expectedOutput =
    'This is a test citation ([Signal Sciences - Crunchbase Company Profile & Funding](https://www.crunchbase.com/organization/signal-sciences)) ([Demand More from Your WAF - Signal Sciences now part of Fastly](https://www.signalsciences.com/))';

  test('should correctly process citations and replace them with markdown links', () => {
    const result = processAssistantMessage(messageData, messageText);
    expect(result).toBe(expectedOutput);
  });

  test('should handle message with no citations', () => {
    const messageWithNoCitations = {
      metadata: {},
    };
    const result = processAssistantMessage(messageWithNoCitations, messageText);
    expect(result).toBe(messageText);
  });

  test('should handle citations with missing metadata', () => {
    const messageWithBadCitation = {
      metadata: {
        citations: [
          {
            start_ix: 85,
            end_ix: 97,
          },
        ],
      },
    };
    const result = processAssistantMessage(messageWithBadCitation, messageText);
    expect(result).toBe(messageText);
  });

  test('should handle citations with non-webpage type', () => {
    const messageWithNonWebpage = {
      metadata: {
        citations: [
          {
            start_ix: 85,
            end_ix: 97,
            metadata: {
              type: 'other',
              title: 'Test',
              url: 'http://test.com',
            },
          },
        ],
      },
    };
    const result = processAssistantMessage(messageWithNonWebpage, messageText);
    expect(result).toBe(messageText);
  });

  test('should handle empty message text', () => {
    const result = processAssistantMessage(messageData, '');
    expect(result).toBe('');
  });

  test('should handle undefined message text', () => {
    const result = processAssistantMessage(messageData, undefined);
    expect(result).toBe(undefined);
  });

  test('should handle invalid citation indices', () => {
    const messageWithBadIndices = {
      metadata: {
        citations: [
          {
            start_ix: 100,
            end_ix: 90, // end before start
            metadata: {
              type: 'webpage',
              title: 'Test',
              url: 'http://test.com',
            },
          },
        ],
      },
    };
    const result = processAssistantMessage(messageWithBadIndices, messageText);
    expect(result).toBe(messageText);
  });

  test('should correctly process citations from real ChatGPT data', () => {
    const jsonData = JSON.parse(
      fs.readFileSync(path.join(__dirname, '__data__', 'chatgpt-citations.json'), 'utf8'),
    );

    // Get the message containing citations from the JSON data
    const assistantMessage = jsonData[0].mapping['4b3aec6b-5146-4bad-ae8e-204fdb6accda'].message;

    const messageText = assistantMessage.content.parts[0];
    const citations = assistantMessage.metadata.citations;

    // Expected output should have all citations replaced with markdown links
    const expectedOutput =
      "Signal Sciences is a web application security company that was founded on March 10, 2014, by Andrew Peterson, Nick Galbreath, and Zane Lackey. It operates as a for-profit company with its legal name being Signal Sciences Corp. The company has achieved significant growth and is recognized as the fastest-growing web application security company in the world. Signal Sciences developed a next-gen web application firewall (NGWAF) and runtime application self-protection (RASP) technologies designed to increase security and maintain reliability without compromising the performance of modern web applications distributed across cloud, on-premise, edge, or hybrid environments ([Signal Sciences - Crunchbase Company Profile & Funding](https://www.crunchbase.com/organization/signal-sciences)) ([Demand More from Your WAF - Signal Sciences now part of Fastly](https://www.signalsciences.com/)).\n\nIn a major development, Fastly, Inc., a provider of an edge cloud platform, announced the completion of its acquisition of Signal Sciences on October 1, 2020. This acquisition was valued at approximately $775 million in cash and stock. By integrating Signal Sciences' powerful web application and API security solutions with Fastly's edge cloud platform and existing security offerings, they aimed to form a unified suite of security solutions. The merger was aimed at expanding Fastly's security portfolio, particularly at a time when digital security has become paramount for businesses operating online ([Fastly Completes Acquisition of Signal Sciences | Fastly](https://www.fastly.com/press/press-releases/fastly-completes-acquisition-signal-sciences)) ([Fastly Agrees to Acquire Signal Sciences for $775 Million - Cooley](https://www.cooley.com/news/coverage/2020/2020-08-27-fastly-agrees-to-acquire-signal-sciences-for-775-million)).";

    const result = processAssistantMessage(assistantMessage, messageText);
    expect(result).toBe(expectedOutput);

    // Additional checks to verify citation processing
    citations.forEach((citation) => {
      // Verify each citation was replaced
      const markdownLink = `([${citation.metadata.title}](${citation.metadata.url}))`;
      expect(result).toContain(markdownLink);

      // Verify original citation format is not present
      const originalCitation = messageText.slice(citation.start_ix, citation.end_ix);
      expect(result).not.toContain(originalCitation);
    });
  });

  test('should link tens of thousands of citations in one message', () => {
    const count = 40000;
    const marker = '【†】';
    const span = `${'word '.repeat(19)}${marker}`;
    const citations = Array.from({ length: count }, (_, index) => ({
      start_ix: (index + 1) * span.length - marker.length,
      end_ix: (index + 1) * span.length,
      metadata: { type: 'webpage', title: 'Source', url: 'https://example.com' },
    }));

    const text = span.repeat(count);
    const startedAt = performance.now();
    const result = processAssistantMessage({ metadata: { citations } }, text);
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(1000);
    expect(result).not.toContain(marker);
    expect(result.split(' ([Source](https://example.com))')).toHaveLength(count + 1);
  });

  test('should handle potential ReDoS attack payloads', () => {
    // Test with increasing input sizes to check for exponential behavior
    const sizes = [32, 33, 34]; // Adding more sizes would increase test time
    const regExp = '(a+)+';
    const results = [];

    sizes.forEach((size) => {
      const startTime = process.hrtime();

      const maliciousMessageData = {
        metadata: {
          citations: [
            {
              start_ix: 0,
              end_ix: size,
              citation_format_type: 'tether_og',
              metadata: {
                type: 'webpage',
                title: 'Test',
                url: 'http://test.com',
                extra: {
                  cited_message_idx: regExp,
                },
              },
            },
          ],
        },
      };

      const maliciousText = '【' + 'a'.repeat(size) + '】';

      processAssistantMessage(maliciousMessageData, maliciousText);

      const endTime = process.hrtime(startTime);
      const duration = endTime[0] * 1000 + endTime[1] / 1000000; // Convert to milliseconds
      results.push(duration);
    });

    // Each size should complete well under 100ms; a ReDoS would cause exponential blowup
    for (let i = 0; i < results.length; i++) {
      expect(results[i]).toBeLessThan(100);
    }

    // Also test with the exact payload from the security report
    const maliciousPayload = {
      metadata: {
        citations: [
          {
            metadata: {
              extra: {
                cited_message_idx: '(a+)+',
              },
              type: 'webpage',
              title: '1',
              url: '2',
            },
          },
        ],
      },
    };

    const text = '【' + 'a'.repeat(32);
    const startTime = process.hrtime();
    processAssistantMessage(maliciousPayload, text);
    const endTime = process.hrtime(startTime);
    const duration = endTime[0] * 1000 + endTime[1] / 1000000;

    // The processing should complete quickly (under 100ms)
    expect(duration).toBeLessThan(100);
  });
});

describe('importClaudeConvo', () => {
  it('should import basic Claude conversation correctly', async () => {
    const jsonData = [
      {
        uuid: 'conv-123',
        name: 'Test Conversation',
        created_at: '2025-01-15T10:00:00.000Z',
        chat_messages: [
          {
            uuid: 'msg-1',
            sender: 'human',
            created_at: '2025-01-15T10:00:01.000Z',
            content: [{ type: 'text', text: 'Hello Claude' }],
          },
          {
            uuid: 'msg-2',
            sender: 'assistant',
            created_at: '2025-01-15T10:00:02.000Z',
            content: [{ type: 'text', text: 'Hello! How can I help you?' }],
          },
        ],
      },
    ];

    const requestUserId = 'user-123';
    const importBatchBuilder = new ImportBatchBuilder(requestUserId);
    jest.spyOn(importBatchBuilder, 'saveMessage');
    jest.spyOn(importBatchBuilder, 'startConversation');
    jest.spyOn(importBatchBuilder, 'finishConversation');

    const importer = getImporter(jsonData);
    await importer(jsonData, requestUserId, () => importBatchBuilder);

    expect(importBatchBuilder.startConversation).toHaveBeenCalledWith(EModelEndpoint.anthropic);
    expect(importBatchBuilder.saveMessage).toHaveBeenCalledTimes(2);
    expect(importBatchBuilder.finishConversation).toHaveBeenCalledWith(
      'Test Conversation',
      expect.any(Date),
      {},
      expect.any(String),
    );

    const savedMessages = importBatchBuilder.saveMessage.mock.calls.map((call) => call[0]);

    // Check user message
    const userMsg = savedMessages.find((msg) => msg.text === 'Hello Claude');
    expect(userMsg.isCreatedByUser).toBe(true);
    expect(userMsg.isUserSubmitted).toBe(true);
    expect(userMsg.sender).toBe('user');
    expect(userMsg.endpoint).toBe(EModelEndpoint.anthropic);

    // Check assistant message
    const assistantMsg = savedMessages.find((msg) => msg.text === 'Hello! How can I help you?');
    expect(assistantMsg.isCreatedByUser).toBe(false);
    expect(assistantMsg.isUserSubmitted).toBe(true);
    expect(assistantMsg.sender).toBe('Claude');
    expect(assistantMsg.parentMessageId).toBe(userMsg.messageId);
  });

  it('should merge thinking content into assistant message', async () => {
    const jsonData = [
      {
        uuid: 'conv-123',
        name: 'Thinking Test',
        created_at: '2025-01-15T10:00:00.000Z',
        chat_messages: [
          {
            uuid: 'msg-1',
            sender: 'human',
            created_at: '2025-01-15T10:00:01.000Z',
            content: [{ type: 'text', text: 'What is 2+2?' }],
          },
          {
            uuid: 'msg-2',
            sender: 'assistant',
            created_at: '2025-01-15T10:00:02.000Z',
            content: [
              { type: 'thinking', thinking: 'Let me calculate this simple math problem.' },
              { type: 'text', text: 'The answer is 4.' },
            ],
          },
        ],
      },
    ];

    const requestUserId = 'user-123';
    const importBatchBuilder = new ImportBatchBuilder(requestUserId);
    jest.spyOn(importBatchBuilder, 'saveMessage');

    const importer = getImporter(jsonData);
    await importer(jsonData, requestUserId, () => importBatchBuilder);

    const savedMessages = importBatchBuilder.saveMessage.mock.calls.map((call) => call[0]);
    const assistantMsg = savedMessages.find((msg) => msg.text === 'The answer is 4.');

    expect(assistantMsg.content).toBeDefined();
    expect(assistantMsg.content).toHaveLength(2);
    expect(assistantMsg.content[0].type).toBe('think');
    expect(assistantMsg.content[0].think).toBe('Let me calculate this simple math problem.');
    expect(assistantMsg.content[1].type).toBe('text');
    expect(assistantMsg.content[1].text).toBe('The answer is 4.');
  });

  it('should not include model field (Claude exports do not contain model info)', async () => {
    const jsonData = [
      {
        uuid: 'conv-123',
        name: 'No Model Test',
        created_at: '2025-01-15T10:00:00.000Z',
        chat_messages: [
          {
            uuid: 'msg-1',
            sender: 'human',
            created_at: '2025-01-15T10:00:01.000Z',
            content: [{ type: 'text', text: 'Hello' }],
          },
        ],
      },
    ];

    const requestUserId = 'user-123';
    const importBatchBuilder = new ImportBatchBuilder(requestUserId);
    jest.spyOn(importBatchBuilder, 'saveMessage');

    const importer = getImporter(jsonData);
    await importer(jsonData, requestUserId, () => importBatchBuilder);

    const savedMessages = importBatchBuilder.saveMessage.mock.calls.map((call) => call[0]);
    // Model should not be explicitly set (will use ImportBatchBuilder default)
    expect(savedMessages[0]).not.toHaveProperty('model');
  });

  it('should set the conversation endpoint and a Claude model so the chat UI loads correctly without a refresh', async () => {
    const jsonData = [
      {
        uuid: 'conv-123',
        name: 'Claude Conversation',
        created_at: '2025-01-15T10:00:00.000Z',
        chat_messages: [
          {
            uuid: 'msg-1',
            sender: 'human',
            created_at: '2025-01-15T10:00:01.000Z',
            content: [{ type: 'text', text: 'Hello' }],
          },
          {
            uuid: 'msg-2',
            sender: 'assistant',
            created_at: '2025-01-15T10:00:02.000Z',
            content: [{ type: 'text', text: 'Hi there!' }],
          },
        ],
      },
    ];

    const requestUserId = 'user-123';
    const importBatchBuilder = new ImportBatchBuilder(requestUserId);

    const importer = getImporter(jsonData);
    await importer(jsonData, requestUserId, () => importBatchBuilder);

    expect(importBatchBuilder.conversations).toHaveLength(1);
    const convo = importBatchBuilder.conversations[0];
    expect(convo.endpoint).toBe(EModelEndpoint.anthropic);
    expect(convo.model).toBe(anthropicSettings.model.default);
    expect(convo.model).not.toBe(openAISettings.model.default);
  });

  it('should prefer the first runtime-configured anthropic model over the hardcoded default', async () => {
    mockGetModelsConfig.mockResolvedValueOnce({
      [EModelEndpoint.anthropic]: ['claude-opus-4-7', 'claude-3-5-sonnet-latest'],
    });

    const jsonData = [
      {
        uuid: 'conv-456',
        name: 'Configured Claude Conversation',
        created_at: '2025-01-15T10:00:00.000Z',
        chat_messages: [
          {
            uuid: 'msg-1',
            sender: 'human',
            created_at: '2025-01-15T10:00:01.000Z',
            content: [{ type: 'text', text: 'Hello' }],
          },
        ],
      },
    ];

    const requestUserId = 'user-123';
    const importBatchBuilder = new ImportBatchBuilder(requestUserId);

    const importer = getImporter(jsonData);
    await importer(jsonData, requestUserId, () => importBatchBuilder);

    const convo = importBatchBuilder.conversations[0];
    expect(convo.endpoint).toBe(EModelEndpoint.anthropic);
    expect(convo.model).toBe('claude-opus-4-7');
  });

  it('should fall back to the anthropic hardcoded default when modelsConfig has no anthropic models', async () => {
    mockGetModelsConfig.mockResolvedValueOnce({
      [EModelEndpoint.anthropic]: [],
    });

    const jsonData = [
      {
        uuid: 'conv-789',
        name: 'Empty modelsConfig Conversation',
        created_at: '2025-01-15T10:00:00.000Z',
        chat_messages: [
          {
            uuid: 'msg-1',
            sender: 'human',
            created_at: '2025-01-15T10:00:01.000Z',
            content: [{ type: 'text', text: 'Hello' }],
          },
        ],
      },
    ];

    const requestUserId = 'user-123';
    const importBatchBuilder = new ImportBatchBuilder(requestUserId);

    const importer = getImporter(jsonData);
    await importer(jsonData, requestUserId, () => importBatchBuilder);

    const convo = importBatchBuilder.conversations[0];
    expect(convo.endpoint).toBe(EModelEndpoint.anthropic);
    expect(convo.model).toBe(anthropicSettings.model.default);
  });

  it('should fall back to the anthropic hardcoded default when getModelsConfig throws', async () => {
    mockGetModelsConfig.mockRejectedValueOnce(new Error('boom'));

    const jsonData = [
      {
        uuid: 'conv-fail',
        name: 'modelsConfig failure',
        created_at: '2025-01-15T10:00:00.000Z',
        chat_messages: [
          {
            uuid: 'msg-1',
            sender: 'human',
            created_at: '2025-01-15T10:00:01.000Z',
            content: [{ type: 'text', text: 'Hello' }],
          },
        ],
      },
    ];

    const requestUserId = 'user-123';
    const importBatchBuilder = new ImportBatchBuilder(requestUserId);

    const importer = getImporter(jsonData);
    await importer(jsonData, requestUserId, () => importBatchBuilder);

    const convo = importBatchBuilder.conversations[0];
    expect(convo.endpoint).toBe(EModelEndpoint.anthropic);
    expect(convo.model).toBe(anthropicSettings.model.default);
  });

  it('should correct timestamp inversions (child before parent)', async () => {
    const jsonData = [
      {
        uuid: 'conv-123',
        name: 'Timestamp Inversion Test',
        created_at: '2025-01-15T10:00:00.000Z',
        chat_messages: [
          {
            uuid: 'msg-1',
            sender: 'human',
            created_at: '2025-01-15T10:00:05.000Z', // Later timestamp
            content: [{ type: 'text', text: 'First message' }],
          },
          {
            uuid: 'msg-2',
            sender: 'assistant',
            created_at: '2025-01-15T10:00:02.000Z', // Earlier timestamp (inverted)
            content: [{ type: 'text', text: 'Second message' }],
          },
        ],
      },
    ];

    const requestUserId = 'user-123';
    const importBatchBuilder = new ImportBatchBuilder(requestUserId);
    jest.spyOn(importBatchBuilder, 'saveMessage');

    const importer = getImporter(jsonData);
    await importer(jsonData, requestUserId, () => importBatchBuilder);

    const savedMessages = importBatchBuilder.saveMessage.mock.calls.map((call) => call[0]);
    const firstMsg = savedMessages.find((msg) => msg.text === 'First message');
    const secondMsg = savedMessages.find((msg) => msg.text === 'Second message');

    // Second message should have timestamp adjusted to be after first
    expect(new Date(secondMsg.createdAt).getTime()).toBeGreaterThan(
      new Date(firstMsg.createdAt).getTime(),
    );
  });

  it('should use conversation create_time for null message timestamps', async () => {
    const convCreateTime = '2025-01-15T10:00:00.000Z';
    const jsonData = [
      {
        uuid: 'conv-123',
        name: 'Null Timestamp Test',
        created_at: convCreateTime,
        chat_messages: [
          {
            uuid: 'msg-1',
            sender: 'human',
            created_at: null, // Null timestamp
            content: [{ type: 'text', text: 'Message with null time' }],
          },
        ],
      },
    ];

    const requestUserId = 'user-123';
    const importBatchBuilder = new ImportBatchBuilder(requestUserId);
    jest.spyOn(importBatchBuilder, 'saveMessage');

    const importer = getImporter(jsonData);
    await importer(jsonData, requestUserId, () => importBatchBuilder);

    const savedMessages = importBatchBuilder.saveMessage.mock.calls.map((call) => call[0]);
    expect(savedMessages[0].createdAt).toEqual(new Date(convCreateTime));
  });

  it('should use text field as fallback when content array is empty', async () => {
    const jsonData = [
      {
        uuid: 'conv-123',
        name: 'Text Fallback Test',
        created_at: '2025-01-15T10:00:00.000Z',
        chat_messages: [
          {
            uuid: 'msg-1',
            sender: 'human',
            created_at: '2025-01-15T10:00:01.000Z',
            text: 'Fallback text content',
            content: [], // Empty content array
          },
        ],
      },
    ];

    const requestUserId = 'user-123';
    const importBatchBuilder = new ImportBatchBuilder(requestUserId);
    jest.spyOn(importBatchBuilder, 'saveMessage');

    const importer = getImporter(jsonData);
    await importer(jsonData, requestUserId, () => importBatchBuilder);

    const savedMessages = importBatchBuilder.saveMessage.mock.calls.map((call) => call[0]);
    expect(savedMessages[0].text).toBe('Fallback text content');
  });

  it('should skip empty messages', async () => {
    const jsonData = [
      {
        uuid: 'conv-123',
        name: 'Skip Empty Test',
        created_at: '2025-01-15T10:00:00.000Z',
        chat_messages: [
          {
            uuid: 'msg-1',
            sender: 'human',
            created_at: '2025-01-15T10:00:01.000Z',
            content: [{ type: 'text', text: 'Valid message' }],
          },
          {
            uuid: 'msg-2',
            sender: 'assistant',
            created_at: '2025-01-15T10:00:02.000Z',
            content: [], // Empty content
            text: '', // Empty text
          },
          {
            uuid: 'msg-3',
            sender: 'human',
            created_at: '2025-01-15T10:00:03.000Z',
            content: [{ type: 'text', text: 'Another valid message' }],
          },
        ],
      },
    ];

    const requestUserId = 'user-123';
    const importBatchBuilder = new ImportBatchBuilder(requestUserId);
    jest.spyOn(importBatchBuilder, 'saveMessage');

    const importer = getImporter(jsonData);
    await importer(jsonData, requestUserId, () => importBatchBuilder);

    // Should only save 2 messages (empty one skipped)
    expect(importBatchBuilder.saveMessage).toHaveBeenCalledTimes(2);
  });

  it('should use default name for unnamed conversations', async () => {
    const jsonData = [
      {
        uuid: 'conv-123',
        name: '', // Empty name
        created_at: '2025-01-15T10:00:00.000Z',
        chat_messages: [
          {
            uuid: 'msg-1',
            sender: 'human',
            created_at: '2025-01-15T10:00:01.000Z',
            content: [{ type: 'text', text: 'Hello' }],
          },
        ],
      },
    ];

    const requestUserId = 'user-123';
    const importBatchBuilder = new ImportBatchBuilder(requestUserId);
    jest.spyOn(importBatchBuilder, 'finishConversation');

    const importer = getImporter(jsonData);
    await importer(jsonData, requestUserId, () => importBatchBuilder);

    expect(importBatchBuilder.finishConversation).toHaveBeenCalledWith(
      'Imported Claude Chat',
      expect.any(Date),
      {},
      expect.any(String),
    );
  });
});
