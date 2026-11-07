import type { TurnContextDb, TurnContextRequest } from './prepare';
import type { ContextEntry } from './registry';
import {
  prepareTurnContext,
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

  it('does not plan when the hidden servers cannot be read, which would bind hidden schemas', async () => {
    const reader = jest.fn().mockRejectedValue(new Error('config unreadable'));
    const req = request();
    await expect(
      prepareTurnContext({
        req,
        agent: agent(),
        allAgents: [{ agent: agent() }],
        orderedMessages: history(),
        conversationId: 'c1',
        anchorPromise: Promise.resolve(ANCHOR),
        getHiddenServers: reader,
      }),
    ).rejects.toThrow('config unreadable');
    expect(reader).toHaveBeenCalledWith(req.user);
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
    const stored = [{ key: 'date', value: '2026-03-10 (Tuesday)' }];
    const req = request();
    const prepared = await run(req, { isRegenerate: true }, history({ contextUpdates: stored }));
    expect(req.turnContextUpdates).toBeUndefined();
    expect(prepared?.plan.currentEntries).toBeUndefined();
    expect(prepared?.plan.updates.get(2)).toContain('Current date: 2026-03-10 (Tuesday)');
  });
});

describe('prepareTurnContext without a tool dispatcher in the installed SDK', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('@librechat/agents');
    jest.dontMock('@librechat/data-schemas');
  });

  it('keeps the tools as loaded and the rest of the turn context, and warns once', async () => {
    const warn = jest.fn();
    jest.resetModules();
    jest.doMock('@librechat/agents', () => ({
      ...jest.requireActual('@librechat/agents'),
      TOOL_DISPATCHER_NAME: undefined,
    }));
    jest.doMock('@librechat/data-schemas', () => ({
      ...jest.requireActual('@librechat/data-schemas'),
      logger: { warn, error: jest.fn(), debug: jest.fn(), info: jest.fn() },
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { prepareTurnContext: prepare } = require('./prepare') as typeof import('./prepare');
    const mcpAgent = () => ({
      ...agent(),
      toolDefinitions: [{ name: 'search_mcp_alpha', serverName: 'alpha' }],
    });
    const turn = () =>
      prepare({
        req: request(),
        agent: mcpAgent(),
        allAgents: [{ agent: mcpAgent() }],
        orderedMessages: history(),
        conversationId: 'c1',
        anchorPromise: Promise.resolve(ANCHOR),
        getHiddenServers: async () => new Set(),
      });
    const first = await turn();
    const second = await turn();
    expect(first?.plan.tools).toBeUndefined();
    expect(second?.plan.tools).toBeUndefined();
    expect(first?.plan.currentEntries?.map(({ key }) => key)).toContain('runtime:web_search');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('prepareTurnContext memory', () => {
  const EMPTY = { withKeys: '', withoutKeys: '' };
  const anchored = async ({
    memories,
    inlineTools = false,
  }: {
    memories?: { withKeys?: string; withoutKeys?: string };
    inlineTools?: boolean;
  }) => {
    const primary = { ...agent(), ...(inlineTools ? { memoryToolsRegistered: true } : {}) };
    const prepared = await prepareTurnContext({
      req: request({ config: ON }),
      agent: primary,
      allAgents: [{ agent: primary }],
      orderedMessages: history(),
      memories,
      conversationId: 'c1',
      anchorPromise: Promise.resolve(null),
    });
    return prepared?.plan.anchor?.find(({ key }) => key === 'memory')?.value;
  };

  it('anchors no memory notice for an agent that cannot use memory while the store is empty', async () => {
    expect(await anchored({ memories: EMPTY })).toBeUndefined();
    expect(await anchored({ memories: EMPTY, inlineTools: true })).toBeDefined();
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
});

describe('readConversationAnchor', () => {
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
});
