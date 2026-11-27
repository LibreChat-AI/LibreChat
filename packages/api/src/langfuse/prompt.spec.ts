import { toTracePrompt, toTraceReply } from './prompt';

const system = { role: 'system', content: 'S'.repeat(400) };
const turn = (index: number) => [
  { role: 'user', content: `question ${index}` },
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: `call-${index}`, name: 'web_search', args: { query: `q${index}` } }],
  },
  { role: 'web_search', content: `result ${index}`, additional_kwargs: {} },
];
const conversation = (turns: number) => ({
  messages: [system, ...Array.from({ length: turns }, (_, index) => turn(index)).flat()],
  tools: [{ type: 'function', name: 'web_search' }, { function: { name: 'read_file' } }, {}],
});

describe('toTracePrompt', () => {
  it('reads the conversation Langfuse stores as JSON text, in the application roles', () => {
    const prompt = toTracePrompt(JSON.stringify(conversation(1)), 10_000);

    expect(prompt).toEqual({
      total: 4,
      omitted: 0,
      tools: ['web_search', 'read_file'],
      messages: [
        { role: 'system', text: { value: 'S'.repeat(400), truncated: false } },
        { role: 'user', text: { value: 'question 0', truncated: false } },
        {
          role: 'assistant',
          toolCalls: [{ name: 'web_search', args: { value: '{"query":"q0"}', truncated: false } }],
        },
        { role: 'tool', toolName: 'web_search', text: { value: 'result 0', truncated: false } },
      ],
    });
  });

  it('keeps the system message and the newest messages when the conversation outgrows the budget', () => {
    const prompt = toTracePrompt(conversation(40), 200);

    expect(prompt?.total).toBe(121);
    expect(prompt?.messages[0]).toEqual({
      role: 'system',
      text: { value: 'S'.repeat(50), truncated: true },
    });
    expect(prompt?.messages[(prompt?.messages.length ?? 0) - 1]).toEqual({
      role: 'tool',
      toolName: 'web_search',
      text: { value: 'result 39', truncated: false },
    });
    expect(prompt?.omitted).toBe(121 - (prompt?.messages.length ?? 0));
    expect(prompt?.omitted).toBeGreaterThan(100);
    const spent = (prompt?.messages ?? []).reduce(
      (total, message) => total + (message.text?.value.length ?? 0),
      0,
    );
    expect(spent).toBeLessThanOrEqual(200);
  });

  it('bounds one long message alone so it cannot hide the messages before it', () => {
    const prompt = toTracePrompt(
      [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'A'.repeat(1000) },
      ],
      400,
    );

    expect(prompt?.messages).toEqual([
      { role: 'user', text: { value: 'first', truncated: false } },
      { role: 'assistant', text: { value: 'A'.repeat(100), truncated: true } },
    ]);
  });

  it('joins text parts and names the parts that are not text', () => {
    const prompt = toTracePrompt(
      [
        {
          type: 'human',
          content: [
            { type: 'text', text: 'Look at this' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            { type: 'text', text: 'and this.' },
          ],
        },
      ],
      1000,
    );

    expect(prompt?.messages).toEqual([
      {
        role: 'user',
        text: { value: 'Look at this\nand this.', truncated: false },
        attachments: ['image_url'],
      },
    ]);
  });

  it('returns nothing for input that is not a conversation', () => {
    expect(toTracePrompt('plain text prompt', 100)).toBeUndefined();
    expect(toTracePrompt('{"messages":', 100)).toBeUndefined();
    expect(toTracePrompt({ question: 'hi' }, 100)).toBeUndefined();
    expect(toTracePrompt([], 100)).toBeUndefined();
    expect(toTracePrompt([1, 'two', null], 100)).toBeUndefined();
    expect(toTracePrompt(undefined, 100)).toBeUndefined();
  });
});

describe('toTraceReply', () => {
  it('reads the message a model call wrote, with the tools it asked for', () => {
    expect(
      toTraceReply(
        JSON.stringify({
          role: 'assistant',
          content: [{ type: 'text', text: 'Let me check.', index: 0 }],
          tool_calls: [{ type: 'function', function: { name: 'read_file', arguments: '{"p":1}' } }],
        }),
        1000,
      ),
    ).toEqual({
      role: 'assistant',
      text: { value: 'Let me check.', truncated: false },
      toolCalls: [{ name: 'read_file', args: { value: '{"p":1}', truncated: false } }],
    });
  });

  it('returns nothing for output that is not an assistant message', () => {
    expect(toTraceReply('short', 100)).toBeUndefined();
    expect(toTraceReply({ role: 'user', content: 'hi' }, 100)).toBeUndefined();
    expect(toTraceReply({ role: 'assistant', content: '' }, 100)).toBeUndefined();
  });
});
