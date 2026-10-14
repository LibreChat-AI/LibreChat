import type { ContextEntry } from './registry';
import type { TurnContextDb, TurnContextRequest } from './prepare';
import {
  prepareTurnContext,
  applyHistoryUpdates,
  planSendContext,
  readConversationAnchor,
  prepareResumedTurnContext,
  storePendingContextAnchor,
} from './prepare';

const ON = { endpoints: { agents: { promptCache: { stableContext: true } } } };
const START = '2026-03-09T20:00:00.000Z';
const ANCHOR: ContextEntry[] = [{ key: 'project', value: 'Anchored project.' }];

const history = (extra: Record<string, unknown> = {}) => [
  { messageId: 'u1', isCreatedByUser: true },
  { messageId: 'a1', isCreatedByUser: false },
  { messageId: 'u2', isCreatedByUser: true, ...extra },
];

const request = (overrides: Partial<TurnContextRequest> = {}): TurnContextRequest => ({
  user: { id: 'user-1' },
  config: ON,
  turnStartedAt: Date.parse(START),
  body: { timezone: 'UTC' },
  ...overrides,
});

const agent = () => ({
  provider: 'openAI',
  dynamicToolContextMap: { web_search: '# `web_search` Runtime Context' },
});

describe('prepareTurnContext', () => {
  const run = (req: TurnContextRequest, opts = {}, messages = history()) =>
    prepareTurnContext({
      req,
      agent: agent(),
      allAgents: [{ agent: agent() }],
      orderedMessages: messages,
      opts,
      conversationId: 'c1',
      anchorPromise: Promise.resolve(ANCHOR),
    });

  it('leaves the prompt live without stableContext', async () => {
    const req = request({ config: {} });
    expect(await run(req)).toBeNull();
    expect(req.turnContextUpdates).toBeUndefined();
  });

  it('stores the net change on the sent user message', async () => {
    const req = request();
    const prepared = await run(req);
    expect(prepared?.plan.currentEntries?.map(({ key }) => key)).toContain('runtime:web_search');
    expect(req.turnContextUpdates).toEqual({
      messageId: 'u2',
      entries: prepared?.plan.currentEntries,
    });
  });

  it('writes nothing for a regeneration and renders what the message stored', async () => {
    const stored = [{ key: 'date', value: '2026-03-10 (Tue)' }];
    const req = request();
    const prepared = await run(req, { isRegenerate: true }, history({ contextUpdates: stored }));
    expect(req.turnContextUpdates).toBeUndefined();
    expect(prepared?.plan.currentEntries).toBeUndefined();
    expect(prepared?.plan.updates.get(2)).toContain('Current date: 2026-03-10 (Tue)');
  });

  it('writes nothing for a regeneration flagged on the request body', async () => {
    const req = request({ body: { timezone: 'UTC', isRegenerate: true } });
    await run(req);
    expect(req.turnContextUpdates).toBeUndefined();
  });

  it('keeps the prompt live when the anchor cannot be read', async () => {
    const prepared = await prepareTurnContext({
      req: request(),
      agent: agent(),
      allAgents: [],
      orderedMessages: history(),
      anchorPromise: Promise.reject(new Error('read failed')),
    });
    expect(prepared).toBeNull();
  });

  it('returns the anchor this turn opened as pending', async () => {
    const prepared = await prepareTurnContext({
      req: request(),
      agent: agent(),
      allAgents: [{ agent: agent() }],
      orderedMessages: history(),
      conversationId: 'c1',
      anchorPromise: Promise.resolve(null),
    });
    expect(prepared?.pending).toEqual({
      messageId: null,
      conversationId: 'c1',
      anchor: prepared?.plan.anchor,
    });
  });
});

describe('prepareTurnContext resets', () => {
  const agentOf = (provider: string, promptCache: boolean, model: string) => ({
    provider,
    model_parameters: { model, promptCache },
    dynamicToolContextMap: {},
  });
  const turn = (agent: ReturnType<typeof agentOf>, anchor: readonly ContextEntry[] | null) =>
    prepareTurnContext({
      req: request(),
      agent,
      allAgents: [{ agent }],
      orderedMessages: history(),
      conversationId: 'c1',
      anchorPromise: Promise.resolve(anchor),
    });

  it.each([
    ['anthropic', true, true],
    ['openrouter', true, true],
    ['bedrock', true, true],
    ['anthropic', false, false],
    ['openAI', true, false],
    ['google', true, false],
  ])('reports a model change for %s with promptCache %s: %s', async (provider, cache, reported) => {
    const first = await turn(agentOf(provider, cache, 'model-a'), null);
    const second = await turn(agentOf(provider, cache, 'model-b'), first?.plan.anchor ?? null);
    expect(second?.plan.reset).toEqual(['model']);
    expect(second?.promptCacheReset).toEqual(reported ? ['model'] : undefined);
  });

  it('reports nothing when the turn did not re-anchor', async () => {
    const first = await turn(agentOf('anthropic', true, 'model-a'), null);
    const second = await turn(agentOf('anthropic', true, 'model-a'), first?.plan.anchor ?? null);
    expect(second?.plan.reset).toBeUndefined();
    expect(second?.promptCacheReset).toBeUndefined();
  });
});

describe('readConversationAnchor', () => {
  it('reads nothing without stableContext', async () => {
    const getConvoContextAnchor = jest.fn();
    const anchor = await readConversationAnchor({
      req: request({ config: {}, resolvedConversation: { contextAnchor: ANCHOR } }),
      conversationId: 'c1',
      db: { getConvoContextAnchor },
    });
    expect(anchor).toBeNull();
    expect(getConvoContextAnchor).not.toHaveBeenCalled();
  });

  it('uses the conversation the ingress read, without a read of its own', async () => {
    const getConvoContextAnchor = jest.fn();
    const anchor = await readConversationAnchor({
      req: request({ resolvedConversation: { contextAnchor: ANCHOR } }),
      conversationId: 'c1',
      db: { getConvoContextAnchor },
    });
    expect(anchor).toEqual(ANCHOR);
    expect(getConvoContextAnchor).not.toHaveBeenCalled();
  });

  it('reads the anchor when an ingress step resolved the conversation without it', async () => {
    const getConvoContextAnchor = jest.fn().mockResolvedValue(ANCHOR);
    const anchor = await readConversationAnchor({
      req: request({ resolvedConversation: {} }),
      conversationId: 'c1',
      db: { getConvoContextAnchor },
    });
    expect(anchor).toEqual(ANCHOR);
    expect(getConvoContextAnchor).toHaveBeenCalledWith('user-1', 'c1');
  });

  it('reads none for a conversation that does not exist yet', async () => {
    const getConvoContextAnchor = jest.fn();
    expect(
      await readConversationAnchor({
        req: request({ resolvedConversation: null }),
        conversationId: 'c1',
        db: { getConvoContextAnchor },
      }),
    ).toBeNull();
    expect(getConvoContextAnchor).not.toHaveBeenCalled();
  });

  it('falls back to a read when the ingress did not resolve the conversation', async () => {
    const getConvoContextAnchor = jest.fn().mockResolvedValue(ANCHOR);
    const anchor = await readConversationAnchor({
      req: request(),
      conversationId: 'c1',
      db: { getConvoContextAnchor },
    });
    expect(anchor).toEqual(ANCHOR);
    expect(getConvoContextAnchor).toHaveBeenCalledWith('user-1', 'c1');
  });
});

describe('prepareResumedTurnContext', () => {
  const rows = [
    { messageId: 'u1', parentMessageId: null, isCreatedByUser: true },
    { messageId: 'a1', parentMessageId: 'u1', isCreatedByUser: false },
  ];
  const resume = (req: TurnContextRequest, getMessages = jest.fn().mockResolvedValue(rows)) =>
    prepareResumedTurnContext({
      req,
      agent: agent(),
      conversationId: 'c1',
      pausedMessageId: 'a1',
      db: { getMessages },
      getBranch: ({ messages }) => messages,
      loadMemories: async () => undefined,
    });

  it('plans from the anchor the ingress read and one projected message read', async () => {
    const getMessages = jest.fn().mockResolvedValue(rows);
    const prepared = await resume(
      request({ resolvedConversation: { contextAnchor: ANCHOR } }),
      getMessages,
    );
    expect(prepared?.plan.anchor).toEqual(ANCHOR);
    expect(prepared?.plan.currentEntries).toBeUndefined();
    expect(getMessages).toHaveBeenCalledTimes(1);
    expect(getMessages).toHaveBeenCalledWith(
      { conversationId: 'c1', user: 'user-1' },
      '+contextUpdates +contextAnchor',
    );
  });

  it('does nothing without stableContext', async () => {
    const getMessages = jest.fn();
    expect(await resume(request({ config: {} }), getMessages)).toBeNull();
    expect(getMessages).not.toHaveBeenCalled();
  });

  it('keeps the prompt live when the messages cannot be read', async () => {
    expect(await resume(request(), jest.fn().mockRejectedValue(new Error('down')))).toBeNull();
  });
});

describe('applyHistoryUpdates', () => {
  it('prepends each block to the prompt copy and counts the added tokens', () => {
    const messages = [{ content: 'First' }, { content: 'Second' }];
    const indexTokenCountMap: Record<number, number> = { 0: 1, 1: 1 };
    const result = applyHistoryUpdates({
      plan: { updates: new Map([[1, '<context_update>\nx\n</context_update>']]) },
      formattedMessages: messages as never,
      indexTokenCountMap,
      countTokens: (message) => String(message.content).length,
    });
    expect(messages[1].content).toBe('<context_update>\nx\n</context_update>\n\nSecond');
    expect(messages[0].content).toBe('First');
    expect(result).toEqual({ addedTokens: 38, applied: true });
    expect(indexTokenCountMap[1]).toBe(39);
  });

  it('reports nothing applied without updates', () => {
    expect(
      applyHistoryUpdates({
        plan: { updates: new Map() },
        formattedMessages: [],
        indexTokenCountMap: {},
        countTokens: () => 0,
      }),
    ).toEqual({ addedTokens: 0, applied: false });
  });
});

describe('planSendContext', () => {
  const send = (req: TurnContextRequest, messages = history()) => {
    const formattedMessages = messages.map(() => ({ content: 'text' }));
    return planSendContext({
      req,
      agent: agent(),
      allAgents: [{ agent: agent() }],
      orderedMessages: messages,
      anchorPromise: Promise.resolve(ANCHOR),
      formattedMessages: formattedMessages as never,
      indexTokenCountMap: {},
      countTokens: (message) => String(message.content).length,
    }).then((result) => ({ ...result, formattedMessages }));
  };

  it('applies the turn context blocks to the prompt copy when the lever is on', async () => {
    const result = await send(request());
    expect(result.prepared?.plan).toBeDefined();
    expect(result.applied).toBe(true);
    expect(String(result.formattedMessages[2].content)).toContain('<context_update>');
  });

  it('leaves the history alone when the lever is off and no note is configured', async () => {
    const result = await send(request({ config: {} }));
    expect(result.prepared).toBeNull();
    expect(result).toMatchObject({ addedTokens: 0, applied: false });
    expect(result.formattedMessages[2].content).toBe('text');
  });

  it('adds send-time notes without the turn context when only timestamps are on', async () => {
    const config = { endpoints: { agents: { promptMessageTimestamps: true } } };
    const result = await send(request({ config }));
    expect(result.prepared).toBeNull();
    expect(result.applied).toBe(true);
    expect(String(result.formattedMessages[2].content)).toContain('Message sent:');
  });
});

describe('storePendingContextAnchor', () => {
  const db = (): TurnContextDb => ({
    setConvoContextAnchor: jest.fn().mockResolvedValue(true),
    setMessageContextAnchor: jest.fn().mockResolvedValue(true),
  });

  it('stores a conversation anchor and a summary message anchor with their own method', async () => {
    const methods = db();
    await storePendingContextAnchor({
      pending: { messageId: null, conversationId: 'c1', anchor: ANCHOR },
      userId: 'user-1',
      db: methods,
    });
    await storePendingContextAnchor({
      pending: { messageId: 'a1', conversationId: 'c1', anchor: ANCHOR },
      userId: 'user-1',
      db: methods,
    });
    expect(methods.setConvoContextAnchor).toHaveBeenCalledWith({
      user: 'user-1',
      conversationId: 'c1',
      anchor: ANCHOR,
    });
    expect(methods.setMessageContextAnchor).toHaveBeenCalledWith({
      user: 'user-1',
      messageId: 'a1',
      anchor: ANCHOR,
    });
  });

  it('stays pending when nothing was stored or the write failed', async () => {
    const methods = db();
    methods.setConvoContextAnchor = jest.fn().mockRejectedValue(new Error('down'));
    const pending = { messageId: null, conversationId: 'c1', anchor: ANCHOR };
    expect(await storePendingContextAnchor({ pending, userId: 'user-1', db: methods })).toBe(false);
    expect(await storePendingContextAnchor({ pending: undefined, userId: 'u', db: methods })).toBe(
      false,
    );
    expect(await storePendingContextAnchor({ pending, userId: undefined, db: methods })).toBe(
      false,
    );
  });
});
