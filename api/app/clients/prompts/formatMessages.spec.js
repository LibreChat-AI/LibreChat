const { ATTACHMENT_ONLY_TEXT } = require('@librechat/api');
const { Constants, ContentTypes } = require('librechat-data-provider');
const {
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
} = require('@librechat/agents/langchain/messages');
const {
  formatMessage,
  formatAgentMessages,
  formatLangChainMessages,
  formatFromLangChain,
} = require('./formatMessages');

describe('formatMessage', () => {
  it('formats user message', () => {
    const input = {
      message: {
        sender: 'user',
        text: 'Hello',
      },
      userName: 'John',
    };
    const result = formatMessage(input);
    expect(result).toEqual({
      role: 'user',
      content: 'Hello',
      name: 'John',
    });
  });

  it('sanitizes the name by replacing invalid characters (per OpenAI)', () => {
    const input = {
      message: {
        sender: 'user',
        text: 'Hello',
      },
      userName: ' John$Doe@Example! ',
    };
    const result = formatMessage(input);
    expect(result).toEqual({
      role: 'user',
      content: 'Hello',
      name: '_John_Doe_Example__',
    });
  });

  it('trims the name to a maximum length of 64 characters', () => {
    const longName = 'a'.repeat(100);
    const input = {
      message: {
        sender: 'user',
        text: 'Hello',
      },
      userName: longName,
    };
    const result = formatMessage(input);
    expect(result.name.length).toBe(64);
    expect(result.name).toBe('a'.repeat(64));
  });

  it('formats a realistic user message', () => {
    const input = {
      message: {
        _id: '6512cdfb92cbf69fea615331',
        messageId: 'b620bf73-c5c3-4a38-b724-76886aac24c4',
        __v: 0,
        conversationId: '5c23d24f-941f-4aab-85df-127b596c8aa5',
        createdAt: Date.now(),
        error: false,
        finish_reason: null,
        isCreatedByUser: true,
        model: null,
        parentMessageId: Constants.NO_PARENT,
        sender: 'User',
        text: 'hi',
        tokenCount: 5,
        unfinished: false,
        updatedAt: Date.now(),
        user: '6512cdf475f05c86d44c31d2',
      },
      userName: 'John',
    };
    const result = formatMessage(input);
    expect(result).toEqual({
      role: 'user',
      content: 'hi',
      name: 'John',
    });
  });

  it('formats assistant message', () => {
    const input = {
      message: {
        sender: 'assistant',
        text: 'Hi there',
      },
      assistantName: 'Assistant',
    };
    const result = formatMessage(input);
    expect(result).toEqual({
      role: 'assistant',
      content: 'Hi there',
      name: 'Assistant',
    });
  });

  it('formats system message', () => {
    const input = {
      message: {
        role: 'system',
        text: 'Hi there',
      },
    };
    const result = formatMessage(input);
    expect(result).toEqual({
      role: 'system',
      content: 'Hi there',
    });
  });

  it('formats user message with langChain', () => {
    const input = {
      message: {
        sender: 'user',
        text: 'Hello',
      },
      userName: 'John',
      langChain: true,
    };
    const result = formatMessage(input);
    expect(result).toBeInstanceOf(HumanMessage);
    expect(result.lc_kwargs.content).toEqual(input.message.text);
    expect(result.lc_kwargs.name).toEqual(input.userName);
  });

  it('formats assistant message with langChain', () => {
    const input = {
      message: {
        sender: 'assistant',
        text: 'Hi there',
      },
      assistantName: 'Assistant',
      langChain: true,
    };
    const result = formatMessage(input);
    expect(result).toBeInstanceOf(AIMessage);
    expect(result.lc_kwargs.content).toEqual(input.message.text);
    expect(result.lc_kwargs.name).toEqual(input.assistantName);
  });

  it('formats system message with langChain', () => {
    const input = {
      message: {
        role: 'system',
        text: 'This is a system message.',
      },
      langChain: true,
    };
    const result = formatMessage(input);
    expect(result).toBeInstanceOf(SystemMessage);
    expect(result.lc_kwargs.content).toEqual(input.message.text);
  });

  it('formats langChain messages into OpenAI payload format', () => {
    const human = {
      message: new HumanMessage({
        content: 'Hello',
      }),
    };
    const system = {
      message: new SystemMessage({
        content: 'Hello',
      }),
    };
    const ai = {
      message: new AIMessage({
        content: 'Hello',
      }),
    };
    const humanResult = formatMessage(human);
    const systemResult = formatMessage(system);
    const aiResult = formatMessage(ai);
    expect(humanResult).toEqual({
      role: 'user',
      content: 'Hello',
    });
    expect(systemResult).toEqual({
      role: 'system',
      content: 'Hello',
    });
    expect(aiResult).toEqual({
      role: 'assistant',
      content: 'Hello',
    });
  });

  it('includes the text part for vision messages that have text', () => {
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } };
    const result = formatMessage({
      message: { role: 'user', text: 'Describe this', image_urls: [image] },
      endpoint: 'anthropic',
    });
    expect(result.content).toEqual([image, { type: 'text', text: 'Describe this' }]);
  });

  it('omits the empty text part for image-only Anthropic messages', () => {
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } };
    const result = formatMessage({
      message: { role: 'user', text: '', image_urls: [image] },
      endpoint: 'anthropic',
    });
    // No empty { type: 'text', text: '' } block; Anthropic rejects those with HTTP 400.
    expect(result.content).toEqual([image]);
  });

  it('omits the empty text part for image-only messages on other endpoints', () => {
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } };
    const result = formatMessage({
      message: { role: 'user', text: '   ', image_urls: [image] },
      endpoint: 'openAI',
    });
    expect(result.content).toEqual([image]);
  });

  it('substitutes text for an attachment-only turn with no inline content', () => {
    const result = formatMessage({
      message: { role: 'user', text: '', files: [{ file_id: 'f1', embedded: true }] },
      endpoint: 'anthropic',
    });
    expect(result.content).toBe(ATTACHMENT_ONLY_TEXT);
  });

  it('keeps the user text when an attachment-only turn also has text', () => {
    const result = formatMessage({
      message: { role: 'user', text: 'Summarize it', files: [{ file_id: 'f1', embedded: true }] },
      endpoint: 'anthropic',
    });
    expect(result.content).toBe('Summarize it');
  });

  it('leaves empty content alone when the turn carries no files', () => {
    const result = formatMessage({ message: { role: 'user', text: '' }, endpoint: 'anthropic' });
    expect(result.content).toBe('');
  });

  it('does not substitute text for an assistant turn', () => {
    const result = formatMessage({
      message: { role: 'assistant', text: '', files: [{ file_id: 'f1' }] },
      endpoint: 'anthropic',
    });
    expect(result.content).toBe('');
  });
});

describe('formatLangChainMessages', () => {
  it('formats an array of messages for LangChain', () => {
    const messages = [
      {
        role: 'system',
        content: 'This is a system message',
      },
      {
        sender: 'user',
        text: 'Hello',
      },
      {
        sender: 'assistant',
        text: 'Hi there',
      },
    ];
    const formatOptions = {
      userName: 'John',
      assistantName: 'Assistant',
    };
    const result = formatLangChainMessages(messages, formatOptions);
    expect(result).toHaveLength(3);
    expect(result[0]).toBeInstanceOf(SystemMessage);
    expect(result[1]).toBeInstanceOf(HumanMessage);
    expect(result[2]).toBeInstanceOf(AIMessage);

    expect(result[0].lc_kwargs.content).toEqual(messages[0].content);
    expect(result[1].lc_kwargs.content).toEqual(messages[1].text);
    expect(result[2].lc_kwargs.content).toEqual(messages[2].text);

    expect(result[1].lc_kwargs.name).toEqual(formatOptions.userName);
    expect(result[2].lc_kwargs.name).toEqual(formatOptions.assistantName);
  });

  describe('formatFromLangChain', () => {
    it('should merge kwargs and additional_kwargs', () => {
      const message = {
        kwargs: {
          content: 'some content',
          name: 'dan',
          additional_kwargs: {
            function_call: {
              name: 'dall-e',
              arguments: '{\n  "input": "Subject: hedgehog, Style: cute"\n}',
            },
          },
        },
      };

      const expected = {
        content: 'some content',
        name: 'dan',
        function_call: {
          name: 'dall-e',
          arguments: '{\n  "input": "Subject: hedgehog, Style: cute"\n}',
        },
      };

      expect(formatFromLangChain(message)).toEqual(expected);
    });

    it('should handle messages without additional_kwargs', () => {
      const message = {
        kwargs: {
          content: 'some content',
          name: 'dan',
        },
      };

      const expected = {
        content: 'some content',
        name: 'dan',
      };

      expect(formatFromLangChain(message)).toEqual(expected);
    });

    it('should handle empty messages', () => {
      const message = {
        kwargs: {},
      };

      const expected = {};

      expect(formatFromLangChain(message)).toEqual(expected);
    });
  });
});

describe('formatAgentMessages assistant replay folding', () => {
  const text = (value, extra = {}) => ({
    type: ContentTypes.TEXT,
    [ContentTypes.TEXT]: value,
    ...extra,
  });
  const image = (fileId, extra = {}) => ({
    type: 'image_file',
    image_file: { file_id: fileId, filepath: `/images/${fileId}.png` },
    ...extra,
  });
  const toolCall = (id) => ({
    type: ContentTypes.TOOL_CALL,
    tool_call: { id, name: 'verify', args: '{}', output: 'ok' },
  });

  it('folds text around a plain image part into a string AIMessage that keeps its tool calls', () => {
    const [message, tool] = formatAgentMessages([
      {
        role: 'assistant',
        content: [
          text('Here is the chart.'),
          image('chart'),
          text('Let me verify.', { tool_call_ids: ['call-1'] }),
          toolCall('call-1'),
        ],
      },
    ]);
    expect(message).toBeInstanceOf(AIMessage);
    expect(message.content).toBe('Here is the chart.\n\nLet me verify.');
    expect(message.tool_calls).toMatchObject([{ id: 'call-1', name: 'verify', args: {} }]);
    expect(tool).toBeInstanceOf(ToolMessage);
  });

  it('folds a reasoning turn to the joined text and drops the reasoning part', () => {
    const [message] = formatAgentMessages([
      {
        role: 'assistant',
        content: [
          { type: ContentTypes.THINK, [ContentTypes.THINK]: 'Weighing options.' },
          text('First.'),
          image('sketch'),
          text('Second.'),
        ],
      },
    ]);
    expect(message.content).toBe('First.\nSecond.');
  });

  it('keeps native media parts as an ordered array through the tool-call flush', () => {
    const [message, tool] = formatAgentMessages([
      {
        role: 'assistant',
        content: [
          text('Drawing.'),
          image('native', { native_media: { continuationRef: 'native:job-1:0' } }),
          text('Checking.', { tool_call_ids: ['call-2'] }),
          toolCall('call-2'),
        ],
      },
    ]);
    expect(Array.isArray(message.content)).toBe(true);
    expect(message.content.map((part) => part.type)).toEqual(['text', 'image_file', 'text']);
    expect(message.content[1].native_media).toEqual({ continuationRef: 'native:job-1:0' });
    expect(message.tool_calls).toMatchObject([{ id: 'call-2' }]);
    expect(tool).toBeInstanceOf(ToolMessage);
  });

  it('keeps native media parts in order when a reasoning part would otherwise fold the turn', () => {
    const [message] = formatAgentMessages([
      {
        role: 'assistant',
        content: [
          { type: ContentTypes.THINK, [ContentTypes.THINK]: 'Composing.' },
          text('Before.'),
          image('native', { native_media: { continuationRef: 'native:job-2:0' } }),
          text('After.'),
        ],
      },
    ]);
    expect(message.content.map((part) => part.type)).toEqual(['text', 'image_file', 'text']);
  });
});
