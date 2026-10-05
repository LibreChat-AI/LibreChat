import { ContentTypes } from 'librechat-data-provider';
import type { TMessage, TTraceRecord } from 'librechat-data-provider';
import {
  buildPreviews,
  buildStepPreviews,
  buildPreviewIndex,
  buildMessagePreview,
} from '../preview';
import { buildTraceModel } from '../model';

const BASE = Date.UTC(2026, 8, 12, 11, 30, 0);
const at = (offsetMs: number) => new Date(BASE + offsetMs).toISOString();

function record(overrides: Partial<TTraceRecord> & Pick<TTraceRecord, 'id'>): TTraceRecord {
  return {
    traceId: 'trace-1',
    messageId: 'response-1',
    parentId: null,
    kind: 'span',
    name: overrides.id,
    startTime: at(0),
    endTime: at(1000),
    status: 'ok',
    ...overrides,
  };
}

function message(overrides: Partial<TMessage>): TMessage {
  return {
    messageId: 'response-1',
    conversationId: 'convo-1',
    parentMessageId: 'user-1',
    isCreatedByUser: false,
    text: '',
    ...overrides,
  } as TMessage;
}

const response = message({
  content: [
    { type: ContentTypes.THINK, think: 'Need the weather first.' },
    { type: ContentTypes.TEXT, text: 'Let me   check the weather\nfor you.' },
    {
      type: ContentTypes.TOOL_CALL,
      tool_call: { name: 'web_search', args: { query: 'weather in Paris', limit: 3 } },
    },
    {
      type: ContentTypes.TOOL_CALL,
      tool_call: { name: 'web_search', args: '{"query":"weather in Lyon"}' },
    },
    {
      type: ContentTypes.TOOL_CALL,
      tool_call: {
        id: 'call-3',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"notes.md"}' },
      },
    },
    { type: ContentTypes.TEXT, text: { value: 'Paris is sunny, Lyon is not.' } },
  ],
} as Partial<TMessage>);

describe('buildStepPreviews', () => {
  it('splits a response into what each model call wrote and called', () => {
    expect(buildStepPreviews(response)).toEqual([
      {
        text: 'Let me check the weather for you.',
        toolCalls: [
          {
            name: 'web_search',
            args: 'query: weather in Paris, limit: 3',
            input: '{"query":"weather in Paris","limit":3}',
          },
          {
            name: 'web_search',
            args: 'query: weather in Lyon',
            input: '{"query":"weather in Lyon"}',
          },
          { name: 'read_file', args: 'path: notes.md', input: '{"path":"notes.md"}' },
        ],
      },
      { text: 'Paris is sunny, Lyon is not.', toolCalls: [] },
    ]);
  });

  it('separates consecutive tool-only rounds by run step and keeps parallel calls together', () => {
    const rounds = message({
      content: [
        { type: ContentTypes.TOOL_CALL, tool_call: { name: 'ls', args: {}, stepId: 'step-a' } },
        {
          type: ContentTypes.TOOL_CALL,
          tool_call: { name: 'cat', args: { path: 'a' }, stepId: 'step-a' },
        },
        {
          type: ContentTypes.TOOL_CALL,
          tool_call: { name: 'cat', args: { path: 'b' }, stepId: 'step-b' },
        },
        { type: ContentTypes.TEXT, text: 'Both read.' },
      ],
    } as Partial<TMessage>);

    expect(buildStepPreviews(rounds)).toEqual([
      {
        text: '',
        toolCalls: [
          { name: 'ls', args: '', input: '{}' },
          { name: 'cat', args: 'path: a', input: '{"path":"a"}' },
        ],
      },
      { text: '', toolCalls: [{ name: 'cat', args: 'path: b', input: '{"path":"b"}' }] },
      { text: 'Both read.', toolCalls: [] },
    ]);
  });

  it('starts the next round at reasoning that follows a tool call', () => {
    const rounds = message({
      content: [
        { type: ContentTypes.TOOL_CALL, tool_call: { name: 'ls', args: {} } },
        { type: ContentTypes.THINK, think: 'One more file.' },
        { type: ContentTypes.TOOL_CALL, tool_call: { name: 'cat', args: { path: 'a' } } },
      ],
    } as Partial<TMessage>);

    expect(buildStepPreviews(rounds)).toEqual([
      { text: '', toolCalls: [{ name: 'ls', args: '', input: '{}' }] },
      { text: '', toolCalls: [{ name: 'cat', args: 'path: a', input: '{"path":"a"}' }] },
    ]);
  });

  it('reserves a round for a compaction summary, which is a model call of its own', () => {
    const compacted = message({
      content: [
        { type: ContentTypes.TEXT, text: 'Before.' },
        { type: ContentTypes.SUMMARY, content: [{ type: ContentTypes.TEXT, text: 'Summary.' }] },
        { type: ContentTypes.TOOL_CALL, tool_call: { name: 'ls', args: {} } },
        { type: ContentTypes.TEXT, text: 'After.' },
      ],
    } as Partial<TMessage>);

    expect(buildStepPreviews(compacted)).toEqual([
      { text: 'Before.', toolCalls: [] },
      { text: '', toolCalls: [] },
      { text: '', toolCalls: [{ name: 'ls', args: '', input: '{}' }] },
      { text: 'After.', toolCalls: [] },
    ]);
  });

  it('skips the holes a streaming message leaves in its content', () => {
    const sparse = new Array<TMessage['content'] extends (infer P)[] | undefined ? P : never>(3);
    sparse[0] = { type: ContentTypes.TEXT, text: 'Streaming' };
    sparse[2] = { type: ContentTypes.TEXT, text: 'still.' };

    expect(buildStepPreviews(message({ content: sparse } as Partial<TMessage>))).toEqual([
      { text: 'Streaming still.', toolCalls: [] },
    ]);
  });

  it('falls back to the message text and bounds long previews', () => {
    const long = 'word '.repeat(100);
    expect(buildStepPreviews(message({ text: long }))).toEqual([
      { text: `${long.slice(0, 160).trimEnd()}…`, toolCalls: [] },
    ]);
    expect(buildStepPreviews(undefined)).toEqual([]);
  });
});

describe('buildPreviewIndex', () => {
  const model = buildTraceModel([
    record({ id: 'llm-1', kind: 'generation', name: 'llm', startTime: at(0), endTime: at(1000) }),
    record({
      id: 'search-paris',
      kind: 'tool',
      name: 'web_search',
      startTime: at(1100),
      endTime: at(1500),
    }),
    record({
      id: 'search-lyon',
      kind: 'tool',
      name: 'web_search',
      startTime: at(1600),
      endTime: at(2000),
    }),
    record({ id: 'read', kind: 'tool', name: 'read_file', startTime: at(2100), endTime: at(2200) }),
    record({
      id: 'llm-2',
      kind: 'generation',
      name: 'llm',
      startTime: at(3000),
      endTime: at(4000),
    }),
    record({
      id: 'title',
      traceId: 'trace-title',
      kind: 'generation',
      name: 'llm',
      origin: 'title',
      startTime: at(4100),
      endTime: at(4200),
    }),
  ]);
  const previews = buildPreviews([
    message({ messageId: 'user-1', isCreatedByUser: true, text: 'Weather?' }),
    response,
  ]);
  const preview = (id: string) => buildPreviewIndex(model, previews).get(id);

  it('pairs each step with the text it wrote and each tool with the arguments it was given', () => {
    expect(preview('llm-1')).toBe('Let me check the weather for you.');
    expect(preview('search-paris')).toBe('query: weather in Paris, limit: 3');
    expect(preview('search-lyon')).toBe('query: weather in Lyon');
    expect(preview('read')).toBe('path: notes.md');
    expect(preview('llm-2')).toBe('Paris is sunny, Lyon is not.');
  });

  it('shows nothing for a title run, a record without a message, or a step the message lacks', () => {
    expect(preview('title')).toBeUndefined();
    expect(buildPreviewIndex(model, new Map()).get('llm-1')).toBeUndefined();
    const extra = buildTraceModel([
      record({ id: 'a', kind: 'generation', startTime: at(0), endTime: at(1) }),
      record({ id: 'b', kind: 'generation', startTime: at(2), endTime: at(3) }),
      record({ id: 'c', kind: 'generation', startTime: at(4), endTime: at(5) }),
    ]);
    expect(buildPreviewIndex(extra, previews).get('c')).toBeUndefined();
  });

  it('leaves what ran inside a tool, such as a subagent model call, without a preview', () => {
    const nested = buildTraceModel([
      record({ id: 'llm', kind: 'generation', name: 'llm', startTime: at(0), endTime: at(100) }),
      record({
        id: 'agent',
        kind: 'tool',
        name: 'run_agent',
        startTime: at(200),
        endTime: at(900),
      }),
      record({
        id: 'inner-llm',
        parentId: 'agent',
        kind: 'generation',
        name: 'llm',
        startTime: at(300),
        endTime: at(500),
      }),
      record({
        id: 'inner-tool',
        parentId: 'agent',
        kind: 'tool',
        name: 'run_agent',
        startTime: at(600),
        endTime: at(800),
      }),
    ]);
    const delegating = buildPreviews([
      message({
        content: [
          { type: ContentTypes.TEXT, text: 'Delegating.' },
          { type: ContentTypes.TOOL_CALL, tool_call: { name: 'run_agent', args: { task: 'x' } } },
        ],
      } as Partial<TMessage>),
    ]);
    const nestedPreview = (id: string) => buildPreviewIndex(nested, delegating).get(id);

    expect(nestedPreview('llm')).toBe('Delegating.');
    expect(nestedPreview('agent')).toBe('task: x');
    expect(nestedPreview('inner-llm')).toBeUndefined();
    expect(nestedPreview('inner-tool')).toBeUndefined();
    expect(nested.turns[0].steps).toBe(1);
  });

  it('attaches a message that kept only its final text to the last model call', () => {
    const two = buildTraceModel([
      record({ id: 'first', kind: 'generation', startTime: at(0), endTime: at(100) }),
      record({ id: 'last', kind: 'generation', startTime: at(200), endTime: at(300) }),
    ]);
    const flat = buildPreviews([message({ text: 'The final answer.' })]);
    const filtered = buildPreviews([
      message({ content: [{ type: ContentTypes.TEXT, text: 'Only the answer survived.' }] }),
    ]);

    expect(buildPreviewIndex(two, flat).get('first')).toBeUndefined();
    expect(buildPreviewIndex(two, flat).get('last')).toBe('The final answer.');
    expect(buildPreviewIndex(two, filtered).get('first')).toBeUndefined();
    expect(buildPreviewIndex(two, filtered).get('last')).toBe('Only the answer survived.');
  });

  it('gives no preview to same-name calls that started in the same millisecond', () => {
    const twins = buildTraceModel([
      record({ id: 'llm', kind: 'generation', startTime: at(0), endTime: at(100) }),
      record({ id: 'one', kind: 'tool', name: 'web_search', startTime: at(200), endTime: at(300) }),
      record({ id: 'two', kind: 'tool', name: 'web_search', startTime: at(200), endTime: at(400) }),
    ]);
    const parallel = buildPreviews([
      message({
        content: [
          { type: ContentTypes.TOOL_CALL, tool_call: { name: 'web_search', args: { q: 'a' } } },
          { type: ContentTypes.TOOL_CALL, tool_call: { name: 'web_search', args: { q: 'b' } } },
        ],
      } as Partial<TMessage>),
    ]);

    expect(buildPreviewIndex(twins, parallel).get('one')).toBeUndefined();
    expect(buildPreviewIndex(twins, parallel).get('two')).toBeUndefined();
  });

  it("never treats a failed turn's error text as model output", () => {
    const one = buildTraceModel([
      record({ id: 'llm', kind: 'generation', startTime: at(0), endTime: at(100) }),
    ]);
    const failed = buildPreviews([message({ text: 'Generation failed', error: true })]);

    expect(buildStepPreviews(message({ text: 'Generation failed', error: true }))).toEqual([]);
    expect(buildPreviewIndex(one, failed).get('llm')).toBeUndefined();
  });

  it('splits a handoff to another agent into its own round and withholds parallel lanes', () => {
    const two = buildTraceModel([
      record({ id: 'first', kind: 'generation', startTime: at(0), endTime: at(100) }),
      record({ id: 'last', kind: 'generation', startTime: at(200), endTime: at(300) }),
    ]);
    const handoff = buildPreviews([
      message({
        content: [
          { type: ContentTypes.TEXT, text: 'Agent A says.', agentId: 'agent-a' },
          { type: ContentTypes.TEXT, text: 'Agent B says.', agentId: 'agent-b' },
        ],
      } as Partial<TMessage>),
    ]);
    const parallel = buildPreviews([
      message({
        content: [
          { type: ContentTypes.TEXT, text: 'Lane one.', agentId: 'agent-a', groupId: 1 },
          { type: ContentTypes.TEXT, text: 'Lane two.', agentId: 'agent-b', groupId: 1 },
        ],
      } as Partial<TMessage>),
    ]);

    expect(buildPreviewIndex(two, handoff).get('first')).toBe('Agent A says.');
    expect(buildPreviewIndex(two, handoff).get('last')).toBe('Agent B says.');
    expect(buildPreviewIndex(two, parallel).size).toBe(0);
  });

  it('never marks the surviving text of a failed or unfinished run as final', () => {
    const two = buildTraceModel([
      record({ id: 'first', kind: 'generation', startTime: at(0), endTime: at(100) }),
      record({
        id: 'last',
        kind: 'generation',
        status: 'error',
        startTime: at(200),
        endTime: at(300),
      }),
    ]);
    const failed = buildPreviews([
      message({
        content: [
          { type: ContentTypes.TEXT, text: 'Started well.' },
          { type: ContentTypes.ERROR, text: 'Generation failed' },
        ],
      } as Partial<TMessage>),
    ]);
    const unfinished = buildPreviews([
      message({ unfinished: true, content: [{ type: ContentTypes.TEXT, text: 'Started well.' }] }),
    ]);

    expect(buildPreviewIndex(two, failed).size).toBe(0);
    expect(failed.get('response-1')?.finalOnly).toBe(false);
    expect(buildPreviewIndex(two, failed).get('last')).toBeUndefined();
    expect(buildPreviewIndex(two, unfinished).size).toBe(0);
    expect(unfinished.get('response-1')?.finalOnly).toBe(false);
    expect(buildPreviewIndex(two, unfinished).get('last')).toBeUndefined();
  });

  it('recognizes a handoff whose new agent starts by reasoning', () => {
    const handoff = buildStepPreviews(
      message({
        content: [
          { type: ContentTypes.TEXT, text: 'Agent A.', agentId: 'agent-a' },
          { type: ContentTypes.TOOL_CALL, tool_call: { name: 'ls', args: {} }, agentId: 'agent-a' },
          { type: ContentTypes.THINK, think: 'Taking over.', agentId: 'agent-b' },
          { type: ContentTypes.TEXT, text: 'Agent B.', agentId: 'agent-b' },
        ],
      } as Partial<TMessage>),
    );

    expect(handoff).toEqual([
      { text: 'Agent A.', toolCalls: [{ name: 'ls', args: '', input: '{}' }] },
      { text: 'Agent B.', toolCalls: [] },
    ]);
  });

  it('matches the turn a record limit splits from its end, where its loaded records are', () => {
    const one = buildTraceModel([
      record({ id: 'llm', kind: 'generation', startTime: at(0), endTime: at(100) }),
    ]);
    const answer = buildPreviews([message({ text: 'Answer.' })]);
    expect(buildPreviewIndex(one, answer).get('llm')).toBe('Answer.');
    expect(buildPreviewIndex(one, answer, 'response-1').get('llm')).toBe('Answer.');

    /** Only the last round's records are loaded: the model call that wrote the final text,
     *  hanging from a wrapper the limit cut off. */
    const tail = buildTraceModel([
      record({
        id: 'llm-2',
        parentId: 'not-loaded',
        kind: 'generation',
        startTime: at(3000),
        endTime: at(4000),
      }),
    ]);
    expect(buildPreviewIndex(tail, previews).get('llm-2')).toBeUndefined();
    expect(buildPreviewIndex(tail, previews, 'response-1').get('llm-2')).toBe(
      'Paris is sunny, Lyon is not.',
    );

    /** The oldest loaded response is often whole, the next page holding an older response. One
     *  that then disagrees with its message is unmatched, not read as a tail of it. */
    const whole = buildTraceModel([
      record({ id: 'llm-2', kind: 'generation', startTime: at(3000), endTime: at(4000) }),
    ]);
    expect(buildPreviewIndex(whole, previews, 'response-1').get('llm-2')).toBeUndefined();

    /** More steps than the message has rounds cannot be a tail of it. */
    expect(
      buildPreviewIndex(model, buildPreviews([message({ content: [] })]), 'response-1').size,
    ).toBe(0);
  });

  it('gives no tool a preview in the first loaded step of a split response, whose round may be cut', () => {
    const cut = (id: string, kind: TTraceRecord['kind'], name: string, start: number) =>
      record({
        id,
        parentId: 'not-loaded',
        kind,
        name,
        startTime: at(start),
        endTime: at(start + 50),
      });
    /** The limit fell inside the first round: its model call and its first search are not loaded. */
    const split = buildTraceModel([
      cut('search-lyon', 'tool', 'web_search', 1600),
      cut('read', 'tool', 'read_file', 2100),
      cut('llm-2', 'generation', 'llm', 3000),
    ]);
    const index = buildPreviewIndex(split, previews, 'response-1');

    expect(index.get('search-lyon')).toBeUndefined();
    expect(index.get('read')).toBeUndefined();
    expect(index.get('llm-2')).toBe('Paris is sunny, Lyon is not.');
  });

  it('keeps text and tool previews for a single attributed lane', () => {
    const single = message({
      content: response.content?.map((part) => ({ ...part, agentId: 'agent-a', groupId: 1 })),
    });
    const index = buildPreviewIndex(model, buildPreviews([single]));
    expect(index.get('llm-1')).toBe('Let me check the weather for you.');
    expect(index.get('search-paris')).toBe('query: weather in Paris, limit: 3');
    expect(index.get('llm-2')).toBe('Paris is sunny, Lyon is not.');
  });

  it.each([false, true])('aligns output across consecutive steers (reasoning: %s)', (reasoning) => {
    const steered = message({
      content: [
        { type: ContentTypes.TEXT, text: 'Before.' },
        { type: ContentTypes.STEER, steer: 'Change direction.' },
        { type: ContentTypes.STEER, steer: 'And be brief.' },
        ...(reasoning ? [{ type: ContentTypes.THINK, think: 'New direction.' }] : []),
        { type: ContentTypes.TEXT, text: 'After.' },
      ],
    } as Partial<TMessage>);
    const two = buildTraceModel([
      record({ id: 'first', kind: 'generation', startTime: at(0) }),
      record({ id: 'last', kind: 'generation', startTime: at(200) }),
    ]);
    expect(buildStepPreviews(steered)).toEqual([
      { text: 'Before.', toolCalls: [] },
      { text: 'After.', toolCalls: [] },
    ]);
    expect([...buildPreviewIndex(two, buildPreviews([steered]))]).toEqual([
      ['first', 'Before.'],
      ['last', 'After.'],
    ]);
  });

  it('withholds filtered mixed output until every round can be aligned', () => {
    const records = [
      record({ id: 'a', kind: 'generation', startTime: at(0) }),
      record({ id: 'b', kind: 'generation', startTime: at(100) }),
      record({ id: 'tool-b', kind: 'tool', name: 'search', startTime: at(200) }),
      record({ id: 'c', kind: 'generation', startTime: at(300) }),
    ];
    const filtered = message({
      content: [
        { type: ContentTypes.TOOL_CALL, tool_call: { name: 'search', args: { q: 'B' } } },
        { type: ContentTypes.TEXT, text: 'Final C.' },
      ],
    } as Partial<TMessage>);
    for (const mode of ['simple', 'full'] as const) {
      expect(
        buildPreviewIndex(buildTraceModel(records, mode), buildPreviews([filtered])).size,
      ).toBe(0);
      const restored = message({
        content: [
          { type: ContentTypes.TEXT, text: 'Round A.', agentId: 'agent-a' },
          { type: ContentTypes.THINK, think: 'Round B.', agentId: 'agent-b' },
          ...(filtered.content ?? []),
        ],
      } as Partial<TMessage>);
      expect([
        ...buildPreviewIndex(buildTraceModel(records, mode), buildPreviews([restored])),
      ]).toEqual([
        ['a', 'Round A.'],
        ['tool-b', 'q: B'],
        ['c', 'Final C.'],
      ]);
    }
  });

  it('does not final-align unfinished flat text or text followed by a steer', () => {
    expect(
      buildMessagePreview(message({ text: 'Still working.', unfinished: true })).finalOnly,
    ).toBe(false);
    expect(
      buildMessagePreview(
        message({
          content: [
            { type: ContentTypes.TEXT, text: 'Before.' },
            { type: ContentTypes.STEER, steer: 'Continue.' },
          ],
        } as Partial<TMessage>),
      ).finalOnly,
    ).toBe(false);
  });

  it('does not preview messages the user wrote', () => {
    expect(previews.has('user-1')).toBe(false);
  });
});
