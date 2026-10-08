const { getModelMaxTokens } = require('@librechat/api');
const BaseClient = require('../BaseClient');

class FakeClient extends BaseClient {
  constructor(apiKey, options = {}) {
    super(apiKey, options);
    this.sender = 'AI Assistant';
    this.setOptions(options);
  }
  setOptions(options) {
    if (this.options && !this.options.replaceOptions) {
      this.options.modelOptions = {
        ...this.options.modelOptions,
        ...options.modelOptions,
      };
      delete options.modelOptions;
      this.options = {
        ...this.options,
        ...options,
      };
    } else {
      this.options = options;
    }

    if (this.options.openaiApiKey) {
      this.apiKey = this.options.openaiApiKey;
    }

    const modelOptions = this.options.modelOptions || {};
    if (!this.modelOptions) {
      this.modelOptions = {
        ...modelOptions,
        model: modelOptions.model || 'gpt-3.5-turbo',
        temperature:
          typeof modelOptions.temperature === 'undefined' ? 0.8 : modelOptions.temperature,
        top_p: typeof modelOptions.top_p === 'undefined' ? 1 : modelOptions.top_p,
        presence_penalty:
          typeof modelOptions.presence_penalty === 'undefined' ? 1 : modelOptions.presence_penalty,
        stop: modelOptions.stop,
      };
    }

    this.maxContextTokens =
      this.options.maxContextTokens ?? getModelMaxTokens(this.modelOptions.model) ?? 4097;
  }
  buildMessages() {}
  getTokenCount(str) {
    return str.length;
  }
  getTokenCountForMessage(message) {
    return message?.content?.length || message.length;
  }
}

const initializeFakeClient = (apiKey, options, fakeMessages) => {
  let TestClient = new FakeClient(apiKey);
  TestClient.options = options;
  TestClient.abortController = { abort: jest.fn() };
  TestClient.loadHistory = jest
    .fn()
    .mockImplementation((conversationId, parentMessageId = null) => {
      if (!conversationId) {
        TestClient.currentMessages = [];
        return Promise.resolve([]);
      }

      const orderedMessages = TestClient.constructor.getMessagesForConversation({
        messages: fakeMessages,
        parentMessageId,
      });

      TestClient.currentMessages = orderedMessages;
      return Promise.resolve(orderedMessages);
    });

  TestClient.getSaveOptions = jest.fn().mockImplementation(() => {
    return {};
  });

  TestClient.getBuildMessagesOptions = jest.fn().mockImplementation(() => {
    return {};
  });

  TestClient.sendCompletion = jest.fn(async () => {
    return {
      completion: 'Mock response text',
      metadata: undefined,
    };
  });

  TestClient.getCompletion = jest.fn().mockImplementation(async (..._args) => {
    return {
      choices: [
        {
          message: {
            content: 'Mock response text',
          },
        },
      ],
    };
  });

  TestClient.buildMessages = jest.fn(async (messages, parentMessageId) => {
    const orderedMessages = TestClient.constructor.getMessagesForConversation({
      messages,
      parentMessageId,
    });
    const formattedMessages = orderedMessages.map((message) => {
      let { role: _role, sender, text } = message;
      const role = _role ?? sender;
      const content = Array.isArray(message.content) ? message.content : (text ?? '');
      return {
        role: role?.toLowerCase() === 'user' ? 'user' : 'assistant',
        content,
      };
    });
    return {
      prompt: formattedMessages,
      tokenCountMap: null, // Simplified for the mock
    };
  });

  return TestClient;
};

module.exports = { FakeClient, initializeFakeClient };
