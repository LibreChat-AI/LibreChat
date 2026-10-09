const { ContentTypes } = require('librechat-data-provider');
const {
  AIMessage,
  ToolMessage,
  HumanMessage,
  SystemMessage,
} = require('@librechat/agents/langchain/messages');
const { formatAgentMessages } = require('./formatMessages');

describe('formatAgentMessages', () => {
  it('should format simple user and AI messages', () => {
    const payload = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ];
    const result = formatAgentMessages(payload);
    expect(result).toHaveLength(2);
    expect(result[0]).toBeInstanceOf(HumanMessage);
    expect(result[1]).toBeInstanceOf(AIMessage);
  });

  it('should handle system messages', () => {
    const payload = [{ role: 'system', content: 'You are a helpful assistant.' }];
    const result = formatAgentMessages(payload);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(SystemMessage);
  });

  it('should format messages with content arrays', () => {
    const payload = [
      {
        role: 'user',
        content: [{ type: ContentTypes.TEXT, [ContentTypes.TEXT]: 'Hello' }],
      },
    ];
    const result = formatAgentMessages(payload);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(HumanMessage);
  });

  it('should handle tool calls and create ToolMessages', () => {
    const payload = [
      {
        role: 'assistant',
        content: [
          {
            type: ContentTypes.TEXT,
            [ContentTypes.TEXT]: 'Let me check that for you.',
            tool_call_ids: ['123'],
          },
          {
            type: ContentTypes.TOOL_CALL,
            tool_call: {
              id: '123',
              name: 'search',
              args: '{"query":"weather"}',
              output: 'The weather is sunny.',
              inputValidationError: true,
            },
          },
        ],
      },
    ];
    const result = formatAgentMessages(payload);
    expect(result).toHaveLength(2);
    expect(result[0]).toBeInstanceOf(AIMessage);
    expect(result[1]).toBeInstanceOf(ToolMessage);
    expect(result[0].tool_calls).toHaveLength(1);
    expect(result[0].tool_calls[0]).not.toHaveProperty('inputValidationError');
    expect(result[1].tool_call_id).toBe('123');
  });

  it('should handle multiple content parts in assistant messages', () => {
    const payload = [
      {
        role: 'assistant',
        content: [
          { type: ContentTypes.TEXT, [ContentTypes.TEXT]: 'Part 1' },
          { type: ContentTypes.TEXT, [ContentTypes.TEXT]: 'Part 2' },
        ],
      },
    ];
    const result = formatAgentMessages(payload);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(AIMessage);
    expect(result[0].content).toHaveLength(2);
  });

  it('should throw an error for invalid tool call structure', () => {
    const payload = [
      {
        role: 'assistant',
        content: [
          {
            type: ContentTypes.TOOL_CALL,
            tool_call: {
              id: '123',
              name: 'search',
              args: '{"query":"weather"}',
              output: 'The weather is sunny.',
            },
          },
        ],
      },
    ];
    expect(() => formatAgentMessages(payload)).toThrow('Invalid tool call structure');
  });

  it('should handle tool calls with non-JSON args', () => {
    const payload = [
      {
        role: 'assistant',
        content: [
          { type: ContentTypes.TEXT, [ContentTypes.TEXT]: 'Checking...', tool_call_ids: ['123'] },
          {
            type: ContentTypes.TOOL_CALL,
            tool_call: {
              id: '123',
              name: 'search',
              args: 'non-json-string',
              output: 'Result',
            },
          },
        ],
      },
    ];
    const result = formatAgentMessages(payload);
    expect(result).toHaveLength(2);
    expect(result[0].tool_calls[0].args).toStrictEqual({ input: 'non-json-string' });
  });

  it('should handle complex tool calls with multiple steps', () => {
    const payload = [
      {
        role: 'assistant',
        content: [
          {
            type: ContentTypes.TEXT,
            [ContentTypes.TEXT]: "I'll search for that information.",
            tool_call_ids: ['search_1'],
          },
          {
            type: ContentTypes.TOOL_CALL,
            tool_call: {
              id: 'search_1',
              name: 'search',
              args: '{"query":"weather in New York"}',
              output: 'The weather in New York is currently sunny with a temperature of 75°F.',
            },
          },
          {
            type: ContentTypes.TEXT,
            [ContentTypes.TEXT]: "Now, I'll convert the temperature.",
            tool_call_ids: ['convert_1'],
          },
          {
            type: ContentTypes.TOOL_CALL,
            tool_call: {
              id: 'convert_1',
              name: 'convert_temperature',
              args: '{"temperature": 75, "from": "F", "to": "C"}',
              output: '23.89°C',
            },
          },
          { type: ContentTypes.TEXT, [ContentTypes.TEXT]: "Here's your answer." },
        ],
      },
    ];

    const result = formatAgentMessages(payload);

    expect(result).toHaveLength(5);
    expect(result[0]).toBeInstanceOf(AIMessage);
    expect(result[1]).toBeInstanceOf(ToolMessage);
    expect(result[2]).toBeInstanceOf(AIMessage);
    expect(result[3]).toBeInstanceOf(ToolMessage);
    expect(result[4]).toBeInstanceOf(AIMessage);

    // Check first AIMessage
    expect(result[0].content).toBe("I'll search for that information.");
    expect(result[0].tool_calls).toHaveLength(1);
    expect(result[0].tool_calls[0]).toEqual({
      id: 'search_1',
      name: 'search',
      args: { query: 'weather in New York' },
    });

    // Check first ToolMessage
    expect(result[1].tool_call_id).toBe('search_1');
    expect(result[1].name).toBe('search');
    expect(result[1].content).toBe(
      'The weather in New York is currently sunny with a temperature of 75°F.',
    );

    // Check second AIMessage
    expect(result[2].content).toBe("Now, I'll convert the temperature.");
    expect(result[2].tool_calls).toHaveLength(1);
    expect(result[2].tool_calls[0]).toEqual({
      id: 'convert_1',
      name: 'convert_temperature',
      args: { temperature: 75, from: 'F', to: 'C' },
    });

    // Check second ToolMessage
    expect(result[3].tool_call_id).toBe('convert_1');
    expect(result[3].name).toBe('convert_temperature');
    expect(result[3].content).toBe('23.89°C');

    // Check final AIMessage
    expect(result[4].content).toStrictEqual([
      { [ContentTypes.TEXT]: "Here's your answer.", type: ContentTypes.TEXT },
    ]);
  });

  it.skip('should not produce two consecutive assistant messages and format content correctly', () => {
    const payload = [
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: [{ type: ContentTypes.TEXT, [ContentTypes.TEXT]: 'Hi there!' }],
      },
      {
        role: 'assistant',
        content: [{ type: ContentTypes.TEXT, [ContentTypes.TEXT]: 'How can I help you?' }],
      },
      { role: 'user', content: "What's the weather?" },
      {
        role: 'assistant',
        content: [
          {
            type: ContentTypes.TEXT,
            [ContentTypes.TEXT]: 'Let me check that for you.',
            tool_call_ids: ['weather_1'],
          },
          {
            type: ContentTypes.TOOL_CALL,
            tool_call: {
              id: 'weather_1',
              name: 'check_weather',
              args: '{"location":"New York"}',
              output: 'Sunny, 75°F',
            },
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: ContentTypes.TEXT, [ContentTypes.TEXT]: "Here's the weather information." },
        ],
      },
    ];

    const result = formatAgentMessages(payload);

    // Check correct message count and types
    expect(result).toHaveLength(6);
    expect(result[0]).toBeInstanceOf(HumanMessage);
    expect(result[1]).toBeInstanceOf(AIMessage);
    expect(result[2]).toBeInstanceOf(HumanMessage);
    expect(result[3]).toBeInstanceOf(AIMessage);
    expect(result[4]).toBeInstanceOf(ToolMessage);
    expect(result[5]).toBeInstanceOf(AIMessage);

    // Check content of messages
    expect(result[0].content).toStrictEqual([
      { [ContentTypes.TEXT]: 'Hello', type: ContentTypes.TEXT },
    ]);
    expect(result[1].content).toStrictEqual([
      { [ContentTypes.TEXT]: 'Hi there!', type: ContentTypes.TEXT },
      { [ContentTypes.TEXT]: 'How can I help you?', type: ContentTypes.TEXT },
    ]);
    expect(result[2].content).toStrictEqual([
      { [ContentTypes.TEXT]: "What's the weather?", type: ContentTypes.TEXT },
    ]);
    expect(result[3].content).toBe('Let me check that for you.');
    expect(result[4].content).toBe('Sunny, 75°F');
    expect(result[5].content).toStrictEqual([
      { [ContentTypes.TEXT]: "Here's the weather information.", type: ContentTypes.TEXT },
    ]);

    // Check that there are no consecutive AIMessages
    const messageTypes = result.map((message) => message.constructor);
    for (let i = 0; i < messageTypes.length - 1; i++) {
      expect(messageTypes[i] === AIMessage && messageTypes[i + 1] === AIMessage).toBe(false);
    }

    // Additional check to ensure the consecutive assistant messages were combined
    expect(result[1].content).toHaveLength(2);
  });

  it('should skip THINK type content parts', () => {
    const payload = [
      {
        role: 'assistant',
        content: [
          { type: ContentTypes.TEXT, [ContentTypes.TEXT]: 'Initial response' },
          { type: ContentTypes.THINK, [ContentTypes.THINK]: 'Reasoning about the problem...' },
          { type: ContentTypes.TEXT, [ContentTypes.TEXT]: 'Final answer' },
        ],
      },
    ];

    const result = formatAgentMessages(payload);

    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(AIMessage);
    expect(result[0].content).toEqual('Initial response\nFinal answer');
  });

  it('should join TEXT content as string when THINK content type is present', () => {
    const payload = [
      {
        role: 'assistant',
        content: [
          { type: ContentTypes.THINK, [ContentTypes.THINK]: 'Analyzing the problem...' },
          { type: ContentTypes.TEXT, [ContentTypes.TEXT]: 'First part of response' },
          { type: ContentTypes.TEXT, [ContentTypes.TEXT]: 'Second part of response' },
          { type: ContentTypes.TEXT, [ContentTypes.TEXT]: 'Final part of response' },
        ],
      },
    ];

    const result = formatAgentMessages(payload);

    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(AIMessage);
    expect(typeof result[0].content).toBe('string');
    expect(result[0].content).toBe(
      'First part of response\nSecond part of response\nFinal part of response',
    );
    expect(result[0].content).not.toContain('Analyzing the problem...');
  });

  it('should exclude ERROR type content parts', () => {
    const payload = [
      {
        role: 'assistant',
        content: [
          { type: ContentTypes.TEXT, [ContentTypes.TEXT]: 'Hello there' },
          {
            type: ContentTypes.ERROR,
            [ContentTypes.ERROR]:
              'An error occurred while processing the request: Something went wrong',
          },
          { type: ContentTypes.TEXT, [ContentTypes.TEXT]: 'Final answer' },
        ],
      },
    ];

    const result = formatAgentMessages(payload);

    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(AIMessage);
    expect(result[0].content).toEqual([
      { type: ContentTypes.TEXT, [ContentTypes.TEXT]: 'Hello there' },
      { type: ContentTypes.TEXT, [ContentTypes.TEXT]: 'Final answer' },
    ]);

    // Make sure no error content exists in the result
    const hasErrorContent = result[0].content.some(
      (item) =>
        item.type === ContentTypes.ERROR || JSON.stringify(item).includes('An error occurred'),
    );
    expect(hasErrorContent).toBe(false);
  });

  describe('Vertex Gemini thoughtSignatures persistence (issue #13006 follow-up)', () => {
    const SIG_A = 'AY89a1/sigA==';
    const SIG_B = 'AY89a1/sigB==';

    it('restores additional_kwargs.signatures onto the AIMessage that owns the tool_call', () => {
      const payload = [
        { role: 'user', content: 'list files' },
        {
          role: 'assistant',
          metadata: { thoughtSignatures: { t1: SIG_A } },
          content: [
            { type: ContentTypes.TEXT, [ContentTypes.TEXT]: '', tool_call_ids: ['t1'] },
            {
              type: ContentTypes.TOOL_CALL,
              tool_call: { id: 't1', name: 'bash', args: '{}', output: 'ok' },
            },
          ],
        },
      ];

      const result = formatAgentMessages(payload);

      const assistant = result.find((m) => m instanceof AIMessage);
      expect(assistant.tool_calls).toHaveLength(1);
      expect(assistant.additional_kwargs?.signatures).toEqual([SIG_A]);
    });

    it('attaches signatures per-step in multi-step tool turns (codex review fix)', () => {
      // Reproduces the Codex P1 concern: an assistant turn where the agent
      // loop made two LLM cycles, each emitting its own tool_call. Each step
      // must carry its OWN signature on resume — Vertex validates per-step,
      // not per-turn.
      const payload = [
        { role: 'user', content: 'do two things' },
        {
          role: 'assistant',
          metadata: { thoughtSignatures: { t1: SIG_A, t2: SIG_B } },
          content: [
            { type: ContentTypes.TEXT, [ContentTypes.TEXT]: 'first', tool_call_ids: ['t1'] },
            {
              type: ContentTypes.TOOL_CALL,
              tool_call: { id: 't1', name: 'a', args: '{}', output: 'okA' },
            },
            { type: ContentTypes.TEXT, [ContentTypes.TEXT]: 'second', tool_call_ids: ['t2'] },
            {
              type: ContentTypes.TOOL_CALL,
              tool_call: { id: 't2', name: 'b', args: '{}', output: 'okB' },
            },
          ],
        },
      ];

      const result = formatAgentMessages(payload);
      const aiMessages = result.filter((m) => m instanceof AIMessage);
      expect(aiMessages).toHaveLength(2);
      expect(aiMessages[0].tool_calls).toHaveLength(1);
      expect(aiMessages[0].additional_kwargs?.signatures).toEqual([SIG_A]);
      expect(aiMessages[1].tool_calls).toHaveLength(1);
      expect(aiMessages[1].additional_kwargs?.signatures).toEqual([SIG_B]);
    });

    it('preserves tool_call ordering when signatures are partial', () => {
      // Mixed case: only some tool_calls have stored signatures. Position-
      // aligned array (with empty placeholders) lets the agents-side
      // dispatcher attach the correct signature to the correct functionCall.
      const payload = [
        { role: 'user', content: 'two parallel tools' },
        {
          role: 'assistant',
          metadata: { thoughtSignatures: { t2: SIG_B } },
          content: [
            { type: ContentTypes.TEXT, [ContentTypes.TEXT]: '', tool_call_ids: ['t1', 't2'] },
            {
              type: ContentTypes.TOOL_CALL,
              tool_call: { id: 't1', name: 'a', args: '{}', output: 'okA' },
            },
            {
              type: ContentTypes.TOOL_CALL,
              tool_call: { id: 't2', name: 'b', args: '{}', output: 'okB' },
            },
          ],
        },
      ];

      const result = formatAgentMessages(payload);
      const assistant = result.find((m) => m instanceof AIMessage);
      expect(assistant.additional_kwargs?.signatures).toEqual(['', SIG_B]);
    });

    it('no-op when metadata.thoughtSignatures is absent', () => {
      const payload = [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: [
            { type: ContentTypes.TEXT, [ContentTypes.TEXT]: '', tool_call_ids: ['t1'] },
            {
              type: ContentTypes.TOOL_CALL,
              tool_call: { id: 't1', name: 'bash', args: '{}', output: 'ok' },
            },
          ],
        },
      ];

      const result = formatAgentMessages(payload);
      const assistant = result.find((m) => m instanceof AIMessage);
      expect(assistant.additional_kwargs?.signatures).toBeUndefined();
    });

    it('no-op when assistant message has no tool_calls', () => {
      const payload = [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          metadata: { thoughtSignatures: { t1: SIG_A } },
          content: 'plain text reply',
        },
      ];

      const result = formatAgentMessages(payload);
      const assistant = result.find((m) => m instanceof AIMessage);
      expect(assistant.additional_kwargs?.signatures).toBeUndefined();
    });

    it('no-op when no tool_call has a corresponding stored signature', () => {
      // The persisted map exists but addresses different tool_call_ids
      // (e.g., the previous turn's signatures, somehow leaked). Don't
      // fabricate empty arrays onto the AIMessage.
      const payload = [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          metadata: { thoughtSignatures: { unrelated_id: SIG_A } },
          content: [
            { type: ContentTypes.TEXT, [ContentTypes.TEXT]: '', tool_call_ids: ['t1'] },
            {
              type: ContentTypes.TOOL_CALL,
              tool_call: { id: 't1', name: 'bash', args: '{}', output: 'ok' },
            },
          ],
        },
      ];

      const result = formatAgentMessages(payload);
      const assistant = result.find((m) => m instanceof AIMessage);
      expect(assistant.additional_kwargs?.signatures).toBeUndefined();
    });
  });

  describe('steer content parts', () => {
    it('replays a steer between tool steps as a standalone HumanMessage', () => {
      const payload = [
        {
          role: 'assistant',
          content: [
            {
              type: ContentTypes.TEXT,
              [ContentTypes.TEXT]: 'Checking the weather.',
              tool_call_ids: ['t1'],
            },
            {
              type: ContentTypes.TOOL_CALL,
              tool_call: { id: 't1', name: 'search', args: '{}', output: 'sunny' },
            },
            {
              type: ContentTypes.STEER,
              [ContentTypes.STEER]: 'also check tomorrow',
              steerId: 's1',
            },
            {
              type: ContentTypes.TEXT,
              [ContentTypes.TEXT]: 'Checking tomorrow too.',
              tool_call_ids: ['t2'],
            },
            {
              type: ContentTypes.TOOL_CALL,
              tool_call: { id: 't2', name: 'search', args: '{}', output: 'rain' },
            },
          ],
        },
      ];

      const result = formatAgentMessages(payload);
      expect(result.map((m) => m.constructor)).toEqual([
        AIMessage,
        ToolMessage,
        HumanMessage,
        AIMessage,
        ToolMessage,
      ]);
      expect(result[2].content).toBe('also check tomorrow');
      expect(result[2].additional_kwargs).toEqual({ source: 'steer' });
      expect(result[3].tool_calls).toHaveLength(1);
    });

    it('flushes accumulated assistant text before the steer', () => {
      const payload = [
        {
          role: 'assistant',
          content: [
            { type: ContentTypes.TEXT, [ContentTypes.TEXT]: 'Some prose so far.' },
            { type: ContentTypes.STEER, [ContentTypes.STEER]: 'change direction' },
            { type: ContentTypes.TEXT, [ContentTypes.TEXT]: 'New direction prose.' },
          ],
        },
      ];

      const result = formatAgentMessages(payload);
      expect(result.map((m) => m.constructor)).toEqual([AIMessage, HumanMessage, AIMessage]);
      expect(result[0].content).toBe('Some prose so far.');
      expect(result[1].content).toBe('change direction');
      expect(result[2].content).toEqual([
        { type: ContentTypes.TEXT, [ContentTypes.TEXT]: 'New direction prose.' },
      ]);
    });

    it('handles a steer as the final content part', () => {
      const payload = [
        {
          role: 'assistant',
          content: [
            { type: ContentTypes.TEXT, [ContentTypes.TEXT]: 'Answer text.' },
            { type: ContentTypes.STEER, [ContentTypes.STEER]: 'trailing steer' },
          ],
        },
      ];

      const result = formatAgentMessages(payload);
      expect(result.map((m) => m.constructor)).toEqual([AIMessage, HumanMessage]);
      expect(result[1].content).toBe('trailing steer');
    });

    it('prefers stamped media content for multimodal steers', () => {
      const media = [
        { type: 'text', text: 'see the chart' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc', detail: 'auto' } },
      ];
      const payload = [
        {
          role: 'assistant',
          content: [
            {
              type: ContentTypes.STEER,
              [ContentTypes.STEER]: 'see the chart',
              files: [{ file_id: 'f1' }],
              media,
            },
          ],
        },
      ];

      const result = formatAgentMessages(payload);
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(HumanMessage);
      expect(result[0].content).toEqual(media);
    });
  });

  describe('promptless sends', () => {
    const PLACEHOLDER = [{ type: 'text', text: '(no text)' }];

    it('should stand in for a replayed promptless turn instead of a blank block', () => {
      const result = formatAgentMessages([
        { role: 'user', content: '' },
        { role: 'assistant', content: 'Hi' },
      ]);

      expect(result).toHaveLength(2);
      expect(result[0]).toBeInstanceOf(HumanMessage);
      expect(result[0].content).toEqual(PLACEHOLDER);
      expect(result[0].content).not.toContainEqual(
        expect.objectContaining({ type: 'text', text: '' }),
      );
    });

    it('should keep the turn so assistant messages never become adjacent', () => {
      const result = formatAgentMessages([
        { role: 'assistant', content: 'first' },
        { role: 'user', content: '' },
        { role: 'assistant', content: 'second' },
      ]);

      expect(result).toHaveLength(3);
      expect(result[1]).toBeInstanceOf(HumanMessage);
    });

    it('should not emit a blank text block for a whitespace-only user message', () => {
      const result = formatAgentMessages([{ role: 'user', content: '   ' }]);

      expect(result).toHaveLength(1);
      expect(result[0].content).toEqual(PLACEHOLDER);
    });

    it('should keep a promptless user message that still carries its images', () => {
      const image_urls = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }];
      const result = formatAgentMessages([{ role: 'user', content: '', image_urls }]);

      expect(result).toHaveLength(1);
      expect(result[0].content).toEqual(image_urls);
      expect(result[0].content).not.toContainEqual(
        expect.objectContaining({ type: 'text', text: '' }),
      );
    });

    it('should still format a user message that has text', () => {
      const result = formatAgentMessages([{ role: 'user', content: 'hello' }]);

      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(HumanMessage);
      expect(result[0].content).toEqual([{ type: 'text', text: 'hello' }]);
    });
  });
});
