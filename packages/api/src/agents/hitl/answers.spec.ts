import { Constants, ContentTypes, DEFAULT_RETAINED_ANSWER_TOKENS } from 'librechat-data-provider';
import {
  formatAgentMessages,
  messagesStateReducer,
  getMessagesWithinTokenLimit,
} from '@librechat/agents';
import {
  HumanMessage,
  AIMessage,
  ToolMessage,
  SystemMessage,
  mapStoredMessagesToChatMessages,
  mapChatMessagesToStoredMessages,
} from '@librechat/agents/langchain/messages';
import {
  applyRetainedAnswers,
  prepareRetainedAnswerInvocationMessages,
  RETAINED_ANSWERS_MESSAGE_ID,
  buildRetainedAnswersContext,
  collectRetainedAnswers,
  orderConversationBranch,
  reachesBranchRoot,
  renderRetainedAnswers,
  resolveRetainedAnswersConfig,
  RETAINED_ANSWER_ROW_FIELDS,
  prepareRetainedAnswers,
  withRetainedAnswerTokenCounter,
} from './answers';
import { countFormattedMessageTokens, createCachedTokenCounter } from '../client';
import { attachAskUserQuestionAnswers } from './resume';
import Tokenizer from '~/utils/tokenizer';

const mockWarn = jest.fn();
jest.mock('@librechat/data-schemas', () => ({
  logger: {
    warn: (...args: unknown[]) => mockWarn(...args),
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  },
}));

const ASK = 'ask_user_question';
const NO_PARENT: string = Constants.NO_PARENT;

const countChars = (text: string): number => text.length;

function askPart(args: unknown, output: unknown, id = 'tc-1') {
  return {
    type: ContentTypes.TOOL_CALL,
    tool_call: {
      id,
      name: ASK,
      args: typeof args === 'string' ? args : JSON.stringify(args),
      output,
      progress: 1,
      inputValidationError: undefined as true | undefined,
    },
  };
}

const batchRequest = {
  questions: [
    { id: 'environment', question: 'Which environment should I deploy to?' },
    { id: 'window', question: 'Which time window?', header: 'Window' },
  ],
};

describe('collectRetainedAnswers', () => {
  test('maps a batched answer set onto its questions in question order', () => {
    const sets = collectRetainedAnswers([
      {
        content: [
          { type: ContentTypes.TEXT, text: 'Let me check.' },
          askPart(
            batchRequest,
            JSON.stringify({ answers: { window: 'last 7 days', environment: 'staging' } }),
          ),
        ],
      },
    ]);

    expect(sets).toEqual([
      {
        toolCallId: 'tc-1',
        answers: [
          { question: 'Which environment should I deploy to?', answer: 'staging' },
          { question: 'Which time window?', answer: 'last 7 days' },
        ],
      },
    ]);
  });

  test('keeps a question whose answer is missing out of the set without dropping the rest', () => {
    const sets = collectRetainedAnswers([
      { content: [askPart(batchRequest, JSON.stringify({ answers: { window: 'last 7 days' } }))] },
    ]);
    expect(sets[0].answers).toEqual([{ question: 'Which time window?', answer: 'last 7 days' }]);
  });

  test('quotes a legacy single-question answer exactly as typed, JSON-looking or not', () => {
    const legacy = { question: 'What should I name the file?' };
    const sets = collectRetainedAnswers([
      { content: [askPart(legacy, 'notes.md', 'tc-a')] },
      { content: [askPart(legacy, '{"answer":"yes","reason":"it is late"}', 'tc-b')] },
      { content: [askPart(legacy, '{"answers":{"x":"y"}}', 'tc-c')] },
    ]);
    expect(sets.map((set) => set.answers[0].answer)).toEqual([
      'notes.md',
      '{"answer":"yes","reason":"it is late"}',
      '{"answers":{"x":"y"}}',
    ]);
  });

  test('reads a pause record whose stored args are the bare question string', () => {
    const sets = collectRetainedAnswers([
      { content: [askPart('"What should I name the file?"', 'notes.md', 'tc-s')] },
    ]);
    expect(sets).toEqual([
      {
        toolCallId: 'tc-s',
        answers: [{ question: 'What should I name the file?', answer: 'notes.md' }],
      },
    ]);
  });

  test('skips a call whose input failed validation, whose output is the error', () => {
    const failed = askPart(
      { question: 'Deploy where?' },
      'Option labels must be 280 characters or fewer.',
      'tc-f',
    );
    failed.tool_call.inputValidationError = true;
    expect(collectRetainedAnswers([{ content: [failed] }])).toEqual([]);
  });

  test('ignores other tools, unanswered asks, and malformed stamps', () => {
    const sets = collectRetainedAnswers([
      {
        content: [
          {
            type: ContentTypes.TOOL_CALL,
            tool_call: { id: 'x', name: 'lookup', args: '{}', output: 'ok' },
          },
          askPart(batchRequest, ''),
          askPart(batchRequest, undefined, 'tc-2'),
          askPart('not json', JSON.stringify({ answers: { environment: 'staging' } }), 'tc-3'),
          askPart(batchRequest, 'plain text for a two-question batch', 'tc-4'),
          {
            type: ContentTypes.TOOL_CALL,
            tool_call: { id: 'tc-5', name: ASK, args: '{}', output: 'x' },
          },
        ],
      },
      { content: 'not an array' },
      null as never,
    ]);
    expect(sets).toEqual([]);
  });

  test('keeps every answered call, even when a provider reuses a tool-call id across rows', () => {
    const sets = collectRetainedAnswers([
      {
        content: [
          askPart(batchRequest, JSON.stringify({ answers: { environment: 'staging' } }), 'call_0'),
        ],
      },
      { content: [askPart({ question: 'Other?' }, 'later', 'call_1')] },
      { content: [askPart({ question: 'Ship it?' }, 'yes', 'call_0')] },
    ]);
    expect(sets.map((set) => set.answers[0].answer)).toEqual(['staging', 'later', 'yes']);
  });
});

describe('orderConversationBranch', () => {
  const rows = [
    { messageId: 'root', parentMessageId: NO_PARENT },
    { messageId: 'a1', parentMessageId: 'root' },
    { messageId: 'u2', parentMessageId: 'a1' },
    { messageId: 'a2', parentMessageId: 'u2' },
    { messageId: 'u2-alt', parentMessageId: 'a1' },
    { messageId: 'a2-alt', parentMessageId: 'u2-alt' },
  ];

  test('walks parents from the leaf and returns only that branch, oldest first', () => {
    expect(orderConversationBranch(rows, 'a2').map((row) => row.messageId)).toEqual([
      'root',
      'a1',
      'u2',
      'a2',
    ]);
    expect(orderConversationBranch(rows, 'a2-alt').map((row) => row.messageId)).toEqual([
      'root',
      'a1',
      'u2-alt',
      'a2-alt',
    ]);
  });

  test('returns nothing for no parent, an unknown parent, and stops on a cycle', () => {
    expect(orderConversationBranch(rows, NO_PARENT)).toEqual([]);
    expect(orderConversationBranch(rows, null)).toEqual([]);
    expect(orderConversationBranch(rows, 'missing')).toEqual([]);
    const cyclic = [
      { messageId: 'x', parentMessageId: 'y' },
      { messageId: 'y', parentMessageId: 'x' },
    ];
    expect(orderConversationBranch(cyclic, 'x').map((row) => row.messageId)).toEqual(['y', 'x']);
  });

  test('keeps the first row seen for an id, so the caller decides which rows win', () => {
    const memory = { messageId: 'u2', parentMessageId: 'a1', content: 'memory' };
    const loaded = { messageId: 'u2', parentMessageId: 'a1', content: 'loaded' };
    const branch: Array<{ messageId: string; parentMessageId: string; content?: string }> = [
      memory,
      ...rows,
      loaded,
    ];
    expect(orderConversationBranch(branch, 'u2').map((row) => row.content)).toEqual([
      undefined,
      undefined,
      'memory',
    ]);
  });

  test('reachesBranchRoot tells a whole branch from one cut short of its root', () => {
    expect(reachesBranchRoot([])).toBe(false);
    expect(reachesBranchRoot([{ messageId: 'r', parentMessageId: NO_PARENT }])).toBe(true);
    expect(reachesBranchRoot([{ messageId: 'r', parentMessageId: null }])).toBe(true);
    expect(reachesBranchRoot([{ messageId: 'r', parentMessageId: '' }])).toBe(true);
    expect(reachesBranchRoot([{ messageId: 'a2', parentMessageId: 'u2' }])).toBe(false);
  });
});

describe('renderRetainedAnswers', () => {
  const sets = [
    { toolCallId: 'tc-1', answers: [{ question: 'First?', answer: 'one' }] },
    {
      toolCallId: 'tc-2',
      answers: [
        { question: 'Second?', answer: 'two' },
        { question: 'Third?', answer: 'three' },
      ],
    },
    { toolCallId: 'tc-3', answers: [{ question: 'Fourth?', answer: 'four' }] },
  ];

  test('renders every answer oldest first under the header when the budget allows', async () => {
    const text = await renderRetainedAnswers(sets, 10_000, countChars);
    expect(text).toContain(
      '# Answers the user gave to questions asked earlier in this conversation',
    );
    expect(text).toContain('Q: First?\nA: one');
    expect(text).toContain('Q: Second?\nA: two\n\nQ: Third?\nA: three');
    expect(text?.indexOf('First?')).toBeLessThan(text?.indexOf('Fourth?') ?? -1);
    expect(text).not.toContain('omitted');
  });

  test('drops the oldest sets first once the budget is exceeded and says how many answers went', async () => {
    const newest = (await renderRetainedAnswers([sets[2]], 10_000, countChars)) as string;
    const text = (await renderRetainedAnswers(sets, newest.length + 5, countChars)) as string;
    expect(text).toContain('Q: Fourth?\nA: four');
    expect(text).not.toContain('Second?');
    expect(text).toContain('(3 earlier answers omitted');
  });

  test('budgets the separators and the note, so many tiny sets still fit the ceiling', async () => {
    const tiny = Array.from({ length: 60 }, (_, index) => ({
      toolCallId: `tc-${index}`,
      answers: [{ question: 'Q?', answer: 'y' }],
    }));
    const newest = (await renderRetainedAnswers([tiny[59]], 10_000, countChars)) as string;
    const maxTokens = newest.length + 120;
    const text = (await renderRetainedAnswers(tiny, maxTokens, countChars)) as string;
    expect(text.length).toBeLessThanOrEqual(maxTokens);
    expect(text).toContain('earlier answers omitted');
    expect(text.endsWith('Q: Q?\nA: y')).toBe(true);
  });

  test('does not reserve the omission note when every set fits without it', async () => {
    const full = (await renderRetainedAnswers(sets, 10_000, countChars)) as string;
    expect(full).not.toContain('omitted');
    const exact = (await renderRetainedAnswers(sets, full.length, countChars)) as string;
    expect(exact).toBe(full);
    const short = (await renderRetainedAnswers(sets, full.length - 1, countChars)) as string;
    expect(short).toContain('omitted');
    expect(short).not.toContain('First?');
  });

  test('always keeps the newest set even when it alone exceeds the budget', async () => {
    const text = (await renderRetainedAnswers(sets, 1, countChars)) as string;
    expect(text).toContain('Q: Fourth?\nA: four');
    expect(text).not.toContain('First?');
  });

  test('measures whole blocks when the tokenizer charges per-message overhead', async () => {
    const framed = (text: string) => text.length + 10;
    const full = (await renderRetainedAnswers(sets, 10_000, framed)) as string;
    expect(await renderRetainedAnswers(sets, framed(full), framed)).toBe(full);
  });

  test('stops tokenizing old answers once the retained suffix fills the budget', async () => {
    const history = Array.from({ length: 10_000 }, (_, index) => ({
      answers: [{ question: `Q${index}?`, answer: 'yes' }],
    }));
    const counter = jest.fn(countChars);
    const text = await renderRetainedAnswers(history, 600, counter);
    expect(text).toContain('Q9999?');
    expect(text?.length).toBeLessThanOrEqual(600);
    expect(counter.mock.calls.length).toBeLessThan(30);
  });

  test('does not claim omissions when the only set exceeds the budget', async () => {
    expect(await renderRetainedAnswers([sets[0]], 1, countChars)).not.toContain('omitted');
  });

  test.each(['o200k_base', 'claude'] as const)(
    'fits the final rendered block with the real %s tokenizer',
    async (encoding) => {
      const history = Array.from({ length: 100 }, (_, index) => ({
        answers: [
          {
            question: `Choose ${index}: café or 東京?`,
            answer: '東京 — keep the original wording.',
          },
        ],
      }));
      const counter = (text: string) =>
        countFormattedMessageTokens({ role: 'user', content: text }, encoding) ?? 0;
      const full = (await renderRetainedAnswers(history, 100_000, counter)) as string;
      expect(await renderRetainedAnswers(history, counter(full), counter)).toBe(full);
      const limited = (await renderRetainedAnswers(history, 300, counter)) as string;
      expect(counter(limited)).toBeGreaterThan(0);
      expect(counter(limited)).toBeLessThanOrEqual(300);
      expect(limited).toContain('Choose 99');
    },
  );

  test('returns undefined for no sets', async () => {
    expect(await renderRetainedAnswers([], 100, countChars)).toBeUndefined();
  });
});

describe('resolveRetainedAnswersConfig', () => {
  test('is on with the default budget when nothing is configured', () => {
    expect(resolveRetainedAnswersConfig(undefined)).toEqual({
      enabled: true,
      maxTokens: DEFAULT_RETAINED_ANSWER_TOKENS,
    });
    expect(resolveRetainedAnswersConfig({})).toEqual({
      enabled: true,
      maxTokens: DEFAULT_RETAINED_ANSWER_TOKENS,
    });
  });

  test('honors an explicit off switch and a positive integer budget', () => {
    expect(resolveRetainedAnswersConfig({ retainedAnswers: { enabled: false } }).enabled).toBe(
      false,
    );
    expect(resolveRetainedAnswersConfig({ retainedAnswers: { maxTokens: 512.9 } }).maxTokens).toBe(
      512,
    );
  });

  test('falls back to the default for a budget that reaches runtime unvalidated', () => {
    for (const maxTokens of [0, 0.5, -1, Number.NaN, Number.POSITIVE_INFINITY, '2048', null]) {
      expect(
        resolveRetainedAnswersConfig({ retainedAnswers: { maxTokens: maxTokens as never } })
          .maxTokens,
      ).toBe(DEFAULT_RETAINED_ANSWER_TOKENS);
    }
  });
});

describe('buildRetainedAnswersContext', () => {
  const answered = askPart(batchRequest, JSON.stringify({ answers: { environment: 'staging' } }));
  const summary = {
    type: ContentTypes.SUMMARY,
    text: 'Earlier context, compacted.',
    tokenCount: 5,
  };
  const rows = [
    { messageId: 'u1', parentMessageId: NO_PARENT, content: [{ type: 'text', text: 'deploy' }] },
    { messageId: 'a1', parentMessageId: 'u1', content: [answered] },
    { messageId: 'u2', parentMessageId: 'a1', content: [{ type: 'text', text: 'go on' }] },
    { messageId: 'a2', parentMessageId: 'u2', content: [summary, { type: 'text', text: 'done' }] },
    { messageId: 'u3', parentMessageId: 'a2', content: [{ type: 'text', text: 'next' }] },
  ];
  const ANSWER_LINE = 'Q: Which environment should I deploy to?\nA: staging';

  beforeEach(() => {
    mockWarn.mockClear();
  });

  test('carries an answer given before a checkpoint summary', async () => {
    const text = await buildRetainedAnswersContext({
      messages: rows,
      parentMessageId: 'u3',
      config: undefined,
      countTokens: countChars,
    });
    expect(text).toContain(ANSWER_LINE);
  });

  test('reads only the branch that ends at the parent', async () => {
    const text = await buildRetainedAnswersContext({
      messages: [...rows, { messageId: 'u1-alt', parentMessageId: NO_PARENT, content: [] }],
      parentMessageId: 'u1-alt',
      config: undefined,
      countTokens: countChars,
    });
    expect(text).toBeUndefined();
  });

  test('yields nothing when disabled or when no answer exists', async () => {
    expect(
      await buildRetainedAnswersContext({
        messages: rows,
        parentMessageId: 'u3',
        config: { retainedAnswers: { enabled: false } },
        countTokens: countChars,
      }),
    ).toBeUndefined();
    expect(
      await buildRetainedAnswersContext({
        messages: rows,
        parentMessageId: 'u1',
        config: undefined,
        countTokens: countChars,
      }),
    ).toBeUndefined();
  });

  test('completes a branch cut short of its root through the injected query', async () => {
    const getMessages = jest.fn(async () => rows);
    const cut = [
      { ...rows[3], content: [{ type: 'text', text: 'Earlier context, compacted.' }] },
      rows[4],
    ];
    const text = await buildRetainedAnswersContext({
      messages: cut,
      parentMessageId: 'u3',
      getMessages,
      conversationId: 'convo-1',
      userId: 'user-1',
      config: undefined,
      countTokens: countChars,
    });
    expect(text).toContain(ANSWER_LINE);
    expect(getMessages).toHaveBeenCalledWith(
      { conversationId: 'convo-1', user: 'user-1' },
      RETAINED_ANSWER_ROW_FIELDS,
    );
    expect(RETAINED_ANSWER_ROW_FIELDS).toContain(
      'isUserSubmitted userSubmittedPaths userSubmittedMessageFieldPaths',
    );
  });

  test('completes the branch from the rows the turn already read instead of querying again', async () => {
    const getMessages = jest.fn(async () => rows);
    const cut = [
      { ...rows[3], content: [{ type: 'text', text: 'Earlier context, compacted.' }] },
      rows[4],
    ];
    const text = await buildRetainedAnswersContext({
      messages: cut,
      parentMessageId: 'u3',
      storedRows: rows,
      getMessages,
      conversationId: 'convo-1',
      userId: 'user-1',
      config: undefined,
      countTokens: countChars,
    });
    expect(text).toContain(ANSWER_LINE);
    expect(getMessages).not.toHaveBeenCalled();
  });

  test('completes a lone event message the same way', async () => {
    const getMessages = jest.fn(async () => rows);
    const text = await buildRetainedAnswersContext({
      messages: [rows[4]],
      parentMessageId: 'u3',
      getMessages,
      conversationId: 'convo-1',
      userId: 'user-1',
      config: undefined,
      countTokens: countChars,
    });
    expect(text).toContain(ANSWER_LINE);
    expect(getMessages).toHaveBeenCalledTimes(1);
  });

  test('never queries when the rows in memory reach the root or retention is off', async () => {
    const getMessages = jest.fn(async () => rows);
    const whole = await buildRetainedAnswersContext({
      messages: rows,
      parentMessageId: 'u3',
      getMessages,
      conversationId: 'convo-1',
      userId: 'user-1',
      config: undefined,
      countTokens: countChars,
    });
    expect(whole).toContain(ANSWER_LINE);
    await buildRetainedAnswersContext({
      messages: [rows[4]],
      parentMessageId: 'u3',
      getMessages,
      conversationId: 'convo-1',
      userId: 'user-1',
      config: { retainedAnswers: { enabled: false } },
      countTokens: countChars,
    });
    expect(getMessages).not.toHaveBeenCalled();
  });

  test('lets a stored row outrank the prompt-shaped copy in memory', async () => {
    const withAsk = {
      messageId: 'a2',
      parentMessageId: 'u2',
      content: [summary, askPart({ question: 'Ship it?' }, 'yes', 'tc-a2')],
    };
    const shaped = { ...withAsk, content: [{ type: 'text', text: 'Earlier context, compacted.' }] };
    const text = await buildRetainedAnswersContext({
      messages: [shaped, rows[4]],
      parentMessageId: 'u3',
      getMessages: async () => [rows[0], rows[1], rows[2], withAsk],
      conversationId: 'convo-1',
      userId: 'user-1',
      config: undefined,
      countTokens: countChars,
    });
    expect(text).toContain(ANSWER_LINE);
    expect(text).toContain('Q: Ship it?\nA: yes');
  });

  test('uses canonical stored answers even when a mapped branch still reaches its root', async () => {
    const mapped = rows.map((row) => (row.messageId === 'a1' ? { ...row, content: [] } : row));
    const query = jest.fn();
    const text = await buildRetainedAnswersContext({
      messages: mapped,
      storedRows: rows,
      parentMessageId: 'u3',
      getMessages: query,
      config: undefined,
      countTokens: countChars,
    });
    expect(text).toContain(ANSWER_LINE);
    expect(query).not.toHaveBeenCalled();
  });

  test('carries what is in memory and warns when the stored rows cannot be read', async () => {
    const inMemory = [
      { messageId: 'a9', parentMessageId: 'u9', content: [askPart({ question: 'Ok?' }, 'yes')] },
      { messageId: 'u10', parentMessageId: 'a9', content: [] },
    ];
    const text = await buildRetainedAnswersContext({
      messages: inMemory,
      parentMessageId: 'u10',
      getMessages: async () => {
        throw new Error('rows unavailable');
      },
      conversationId: 'convo-1',
      userId: 'user-1',
      config: undefined,
      countTokens: countChars,
    });
    expect(text).toContain('Q: Ok?\nA: yes');
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  test('never rejects: a failing counter costs the turn its block, not the turn', async () => {
    const text = await buildRetainedAnswersContext({
      messages: rows,
      parentMessageId: 'u3',
      config: undefined,
      countTokens: () => {
        throw new Error('tokenizer down');
      },
    });
    expect(text).toBeUndefined();
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });
});

describe('applyRetainedAnswers', () => {
  const block = '# Answers\n\nQ: Deploy where?\nA: staging';
  const tokenCounter = (message: { content: unknown }) => JSON.stringify(message.content).length;

  test('adds dedicated context and preserves user messages and calibrated counts', () => {
    const user = new HumanMessage({ content: [{ type: 'text', text: 'go on' }], id: 'user-1' });
    const assistant = new AIMessage('unfinished');
    const messages = [user, assistant];
    const counts = { 0: 5000, 1: 12 };
    const result = applyRetainedAnswers({
      block,
      messages,
      indexTokenCountMap: counts,
      tokenCounter,
    });
    expect(result.messages[0].content).toBe(block);
    expect(result.messages[0].id).toBe(RETAINED_ANSWERS_MESSAGE_ID);
    expect(result.messages[1]).toBe(user);
    expect(result.messages[2]).toBe(assistant);
    expect(user.content).toEqual([{ type: 'text', text: 'go on' }]);
    expect(counts).toEqual({ 0: 5000, 1: 12 });
    expect(result.indexTokenCountMap).toEqual({
      0: tokenCounter(result.messages[0]),
      1: 5000,
      2: 12,
    });
  });

  test('survives real summary slicing with no human turn left and preserves the continuation', () => {
    const payload = [
      { role: 'user', content: 'earlier user' },
      {
        role: 'assistant',
        content: [
          { type: 'summary', text: 'Summary', tokenCount: 5 },
          { type: 'text', text: 'unfinished' },
        ],
      },
    ];
    const formatted = formatAgentMessages(payload, { 0: 20, 1: 30 });
    expect(formatted.messages.every((message) => message.getType() !== 'human')).toBe(true);
    const result = applyRetainedAnswers({ block, ...formatted, tokenCounter });
    expect(result.messages.map((message) => message.getType())).toEqual(['human', 'ai']);
    expect(result.messages[0].content).toBe(block);
    expect(result.messages[1]).toBe(formatted.messages[0]);
    expect(result.indexTokenCountMap[1]).toBe(formatted.indexTokenCountMap?.[0]);
    expect(result.indexTokenCountMap[0]).toBe(tokenCounter(result.messages[0]));
    expect(formatted.messages).toHaveLength(1);
  });

  test.each([
    { isMeta: true, source: 'skill' },
    { source: 'skill' },
    { source: 'handoff' },
    { source: 'hook' },
    { source: 'system' },
    { injected: true },
    { role: 'system' },
  ])('keeps retained user context outside synthetic messages: %j', (additional_kwargs) => {
    const prime = new HumanMessage({ content: 'skill instructions', additional_kwargs });
    const continuation = new AIMessage('unfinished');
    for (const hasUser of [false, true]) {
      const messages = hasUser
        ? [new HumanMessage('continue'), prime, continuation]
        : [prime, continuation];
      const result = applyRetainedAnswers({ block, messages, tokenCounter });
      expect(result.messages[0].getType()).toBe('human');
      expect(result.messages[0].content).toContain(block);
      expect(result.messages[0].additional_kwargs).toEqual({
        librechat_retained_answers: block,
      });
      expect(result.messages.slice(1)).toEqual(messages);
      expect(prime.content).toBe('skill instructions');
    }
  });

  test('keeps a legacy system summary first when adding context to a continuation', () => {
    const messages = [new SystemMessage('Summary'), new AIMessage('unfinished')];
    const result = applyRetainedAnswers({
      block,
      messages,
      indexTokenCountMap: { 0: 10, 1: 20 },
      tokenCounter,
    });
    expect(result.messages.map((message) => message.getType())).toEqual(['system', 'human', 'ai']);
    expect(result.indexTokenCountMap).toEqual({
      0: 10,
      1: tokenCounter(result.messages[1]),
      2: 20,
    });
  });

  test('keeps tool-call/result adjacency when summary replay has no human message', () => {
    const messages = [
      new AIMessage({ content: '', tool_calls: [{ id: 'call', name: 'lookup', args: {} }] }),
      new ToolMessage({ content: 'result', tool_call_id: 'call' }),
      new AIMessage('unfinished'),
    ];
    const result = applyRetainedAnswers({
      block,
      messages,
      indexTokenCountMap: { 0: 10, 1: 20, 2: 30 },
      tokenCounter,
    });
    expect(result.messages.slice(1)).toEqual(messages);
    expect(result.indexTokenCountMap).toEqual({
      0: tokenCounter(result.messages[0]),
      1: 10,
      2: 20,
      3: 30,
    });
  });

  test.each(['throw', 'nan', 'undefined'])(
    'leaves the memory transcript and counts untouched on counter failure: %s',
    (failure) => {
      const messages = [new HumanMessage('go on')];
      const counts = { 0: 8 };
      const result = applyRetainedAnswers({
        block,
        messages,
        indexTokenCountMap: counts,
        tokenCounter: () => {
          if (failure === 'throw') throw new Error('counter unavailable');
          return failure === 'nan' ? Number.NaN : (undefined as never);
        },
      });
      expect(result.messages).toBe(messages);
      expect(result.indexTokenCountMap).toBe(counts);
      expect(messages[0].content).toBe('go on');
    },
  );

  test('uses a fresh baseline when the formatted token map has no entry', () => {
    const result = applyRetainedAnswers({
      block,
      messages: [new HumanMessage('go on')],
      indexTokenCountMap: {},
      tokenCounter,
    });
    expect(result.indexTokenCountMap[0]).toBe(tokenCounter(result.messages[0]));
  });

  test('does no work when there is no block', () => {
    const messages = [new HumanMessage('go on')];
    const counts = { 0: 8 };
    const counter = jest.fn();
    expect(
      applyRetainedAnswers({
        block: undefined,
        messages,
        indexTokenCountMap: counts,
        tokenCounter: counter,
      }),
    ).toEqual({ messages, indexTokenCountMap: counts });
    expect(counter).not.toHaveBeenCalled();
  });
});

describe('retained answer lifecycle', () => {
  test('refreshes retained context at the newest position over repeated serialized warm checkpoint turns', async () => {
    let checkpoint: ReturnType<typeof messagesStateReducer> = [];
    const counter = (message: { content: unknown }) => String(message.content).length;
    for (let turn = 0; turn < 50; turn++) {
      const event = new HumanMessage({ id: `event-${turn}`, content: `event ${turn}` });
      const block = `answers for turn ${turn}`;
      const prepared = applyRetainedAnswers({ block, messages: [event], tokenCounter: counter });
      const invocation = await prepareRetainedAnswerInvocationMessages(
        prepared.messages,
        turn > 0,
        async () => ({ values: { messages: checkpoint } }),
      );
      checkpoint = messagesStateReducer(checkpoint, invocation);
      checkpoint = mapStoredMessagesToChatMessages(
        JSON.parse(JSON.stringify(mapChatMessagesToStoredMessages(checkpoint))),
      );
      const retained = checkpoint.filter((message) => message.id === RETAINED_ANSWERS_MESSAGE_ID);
      expect(retained).toHaveLength(1);
      expect(retained[0].content).toBe(block);
      expect(checkpoint[checkpoint.length - 2]).toBe(retained[0]);
      const pruned = getMessagesWithinTokenLimit({
        messages: checkpoint,
        maxContextTokens: counter(retained[0]) + counter(event) + 3,
        indexTokenCountMap: Object.fromEntries(
          checkpoint.map((message, index) => [index, counter(message)]),
        ),
        tokenCounter: counter,
      });
      expect(pruned.context.map((message) => message.content)).toContain(block);
      if (turn > 1) expect(pruned.context.length).toBeLessThan(checkpoint.length);
      expect(checkpoint.filter((message) => message.id?.startsWith('event-'))).toHaveLength(
        turn + 1,
      );
    }
  });

  test('does not read cold/no-answer state and preserves warm state after read failure', async () => {
    const event = new HumanMessage({ id: 'event', content: 'event' });
    const read = jest.fn().mockRejectedValue(new Error('checkpoint unavailable'));
    expect(await prepareRetainedAnswerInvocationMessages([event], false, read)).toEqual([event]);
    expect(await prepareRetainedAnswerInvocationMessages([event], true, read)).toEqual([event]);
    expect(read).not.toHaveBeenCalled();
    const prepared = applyRetainedAnswers({
      block: 'answers',
      messages: [event],
      tokenCounter: () => 10,
    });
    expect(await prepareRetainedAnswerInvocationMessages(prepared.messages, true, read)).toEqual([
      event,
    ]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(
      await prepareRetainedAnswerInvocationMessages(prepared.messages, true, async () => ({
        values: {},
      })),
    ).toEqual([event]);
  });

  test('preserves checkpoint tool pairs and deduplicates a retried event during relocation', async () => {
    const event = new HumanMessage({ id: 'event', content: 'event' });
    const toolPair = [
      new AIMessage({
        id: 'call-message',
        content: '',
        tool_calls: [{ id: 'call', name: 'lookup', args: {} }],
      }),
      new ToolMessage({ id: 'result', content: 'result', tool_call_id: 'call' }),
    ];
    const prepared = applyRetainedAnswers({
      block: 'answers',
      messages: [event],
      tokenCounter: () => 10,
    });
    const history = [...prepared.messages, ...toolPair];
    const invocation = await prepareRetainedAnswerInvocationMessages(
      prepared.messages,
      true,
      async () => ({ values: { messages: history } }),
    );
    expect(messagesStateReducer(history, invocation)).toEqual([...toolPair, ...prepared.messages]);
    expect(history).toEqual([...prepared.messages, ...toolPair]);
  });

  test('rejects imported and caller-authored stamps while preserving exact HITL answer provenance', () => {
    const content = [askPart({ question: 'Where?' }, 'staging')];
    expect(collectRetainedAnswers([{ content, isUserSubmitted: true }])).toEqual([]);
    expect(collectRetainedAnswers([{ content, isCreatedByUser: true }])).toEqual([]);
    for (const path of [
      '/content',
      '/content/0',
      '/content/0/tool_call/name',
      '/content/0/tool_call/args',
      '/content/0/tool_call/output',
    ]) {
      expect(collectRetainedAnswers([{ content, userSubmittedPaths: [path] }])).toEqual([]);
    }
    expect(
      collectRetainedAnswers([
        {
          content,
          isCreatedByUser: false,
          userSubmittedPaths: ['/content/0/tool_call/output'],
          userSubmittedMessageFieldPaths: [
            { path: '/content/0/tool_call/output', field: 'answer' },
          ],
        },
      ]),
    ).toHaveLength(1);
    expect(collectRetainedAnswers([{ content }])).toHaveLength(1);
  });

  test('exact-counts only marked retained text across serialization and merged large content', async () => {
    const prepared = await prepareRetainedAnswers({
      messages: [
        {
          messageId: 'a',
          parentMessageId: NO_PARENT,
          content: [askPart({ question: 'Where?' }, 'staging')],
        },
      ],
      parentMessageId: 'a',
      config: undefined,
    });
    const fallback = jest.fn(await createCachedTokenCounter('o200k_base'));
    const counter = withRetainedAnswerTokenCounter(fallback, 'o200k_base');
    const large = 'large ordinary paste '.repeat(100000);
    const exact = jest.spyOn(Tokenizer, 'countExactTokens');
    try {
      const applied = applyRetainedAnswers({
        block: prepared.block,
        messages: [new HumanMessage(large)],
        tokenCounter: counter,
      });
      const restored = mapStoredMessagesToChatMessages(
        JSON.parse(JSON.stringify(mapChatMessagesToStoredMessages(applied.messages))),
      );
      const originalCount = counter(restored[0]);
      expect(originalCount).toBe(applied.indexTokenCountMap[0]);
      expect(exact.mock.calls.every(([text]) => text.length < 4096)).toBe(true);
      expect(counter(new HumanMessage(String(restored[0].content)))).toBe(
        fallback(new HumanMessage(String(restored[0].content))),
      );
      const merged = new HumanMessage({
        ...restored[0],
        content: [
          { type: 'text', text: 'merged prefix' },
          { type: 'text', text: String(restored[0].content) },
        ],
      });
      expect(counter(merged)).toBeGreaterThanOrEqual(originalCount);
      expect(exact.mock.calls.every(([text]) => text.length < 4096)).toBe(true);
      const changed = new HumanMessage({ ...restored[0], content: 'redacted content' });
      expect(counter(changed)).toBe(fallback(changed));
    } finally {
      exact.mockRestore();
    }
  });

  test('preserves the fallback counter for ordinary content with empty parts', () => {
    const message = new HumanMessage({
      content: [null as never, { type: 'text', text: 'ordinary' }],
    });
    const fallback = jest.fn(() => 12);
    expect(withRetainedAnswerTokenCounter(fallback, 'o200k_base')(message)).toBe(12);
    expect(fallback).toHaveBeenCalledWith(message);
  });

  test.each(['o200k_base', 'claude'] as const)(
    'retains a block over 4 KiB that fits the actual %s token budget',
    async (encoding) => {
      const content = Array.from({ length: 100 }, (_, index) =>
        askPart(
          { question: `Question ${index}: which environment should receive the next deployment?` },
          'Use staging and keep the existing configuration unchanged.',
          `call-${index}`,
        ),
      );
      const prepared = await prepareRetainedAnswers({
        messages: [{ messageId: 'answer', parentMessageId: NO_PARENT, content }],
        parentMessageId: 'answer',
        config: { retainedAnswers: { maxTokens: 4096 } },
        encoding,
      });
      expect(prepared.block?.length).toBeGreaterThan(4096);
      expect(prepared.block).toContain('Question 0:');
      expect(prepared.block).toContain('Question 99:');
      expect(prepared.block).not.toContain('omitted');
      expect(prepared.tokenCount).toBeLessThanOrEqual(4096);
      const fallback = jest.fn(await createCachedTokenCounter(encoding));
      const tokenCounter = withRetainedAnswerTokenCounter(fallback, encoding);
      const messages = [new HumanMessage('Continue.')];
      const result = applyRetainedAnswers({
        block: prepared.block,
        messages,
        indexTokenCountMap: { 0: tokenCounter(messages[0]) },
        tokenCounter,
      });
      expect(result.indexTokenCountMap[0]).toBe(tokenCounter(result.messages[0]));
      expect(result.indexTokenCountMap[0]).toBeLessThan(4200);
      const runtimeCounter = withRetainedAnswerTokenCounter(fallback, encoding);
      const restored = mapStoredMessagesToChatMessages(
        JSON.parse(JSON.stringify(mapChatMessagesToStoredMessages(result.messages))),
      );
      expect(runtimeCounter(restored[0])).toBe(result.indexTokenCountMap[0]);
      const ordinary = new HumanMessage('unrelated large input '.repeat(1000));
      expect(runtimeCounter(ordinary)).toBe(fallback(ordinary));
      const tool = new ToolMessage({ content: prepared.block ?? '', tool_call_id: 'call' });
      expect(runtimeCounter(tool)).toBe(fallback(tool));
    },
  );

  test('carries durable resume stamps after reconstruction, summary slicing, and a second turn without duplication', async () => {
    const request = { questions: [{ id: 'env', question: 'Deploy where?' }] };
    const stamped = attachAskUserQuestionAnswers(
      [askPart(request, undefined)],
      [{ toolCallId: 'tc-1', request, output: JSON.stringify({ answers: { env: 'staging' } }) }],
    );
    const rows = JSON.parse(
      JSON.stringify([
        { messageId: 'u1', parentMessageId: NO_PARENT, content: [] },
        { messageId: 'a1', parentMessageId: 'u1', content: stamped },
        {
          messageId: 'a2',
          parentMessageId: 'a1',
          content: [
            { type: 'summary', text: 'Summary', tokenCount: 5 },
            { type: 'text', text: 'unfinished' },
          ],
        },
      ]),
    );
    const prepared = await prepareRetainedAnswers({
      messages: [rows[2]],
      storedRows: rows,
      parentMessageId: 'a2',
      config: undefined,
      countTokens: countChars,
    });
    expect(prepared.block).toContain('Q: Deploy where?\nA: staging');
    expect(prepared.tokenCount).toBe(prepared.block?.length);
    const original = formatAgentMessages([{ role: 'assistant', content: rows[2].content }], {
      0: 50,
    });
    for (let turn = 0; turn < 2; turn++) {
      const result = applyRetainedAnswers({
        block: prepared.block,
        ...original,
        tokenCounter: (message) => JSON.stringify(message.content).length,
      });
      expect(
        JSON.stringify(result.messages.map((message) => message.content)).match(/Deploy where/g),
      ).toHaveLength(1);
      expect(original.messages).toHaveLength(1);
      expect(JSON.stringify(rows[2])).not.toContain('Deploy where');
    }
  });
});
