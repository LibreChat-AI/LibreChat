const { z } = require('zod');
const { tool } = require('@langchain/core/tools');
const { ChatGenerationChunk } = require('@langchain/core/outputs');
const { HumanMessage, AIMessage, AIMessageChunk } = require('@langchain/core/messages');
const {
  Run,
  Providers,
  GraphEvents,
  FakeChatModel,
  createContentAggregator,
} = require('@librechat/agents');
const {
  GenerationJobManager,
  aggregateEmittedUsage,
  resolveAgentTokenConfig,
  buildPersistedContextUsage,
} = require('@librechat/api');
const { getDefaultHandlers } = require('~/server/controllers/agents/callbacks');

jest.mock('nanoid', () => ({
  nanoid: jest.fn(() => 'mock-nanoid'),
}));

jest.mock('~/server/services/Files/Citations', () => ({
  processFileCitations: jest.fn(),
}));

jest.mock('~/server/services/Files/Code/process', () => ({
  processCodeOutput: jest.fn(),
  runPreviewFinalize: jest.fn(),
}));

jest.mock('~/server/services/Files/process', () => ({
  saveBase64Image: jest.fn(),
}));

/** Real pipeline guard: published lib versions without the event skip its assertions */
const hasContextUsageEvent = GraphEvents.ON_CONTEXT_USAGE != null;

/**
 * FakeChatModel that attaches provider-style usage_metadata on a final
 * empty chunk (the OpenAI streaming pattern), so CHAT_MODEL_END carries
 * aggregated usage through the real @librechat/agents pipeline.
 */
class UsageFakeModel extends FakeChatModel {
  constructor(options, usagePerCall) {
    super(options);
    this.usagePerCall = usagePerCall;
    this.usageCallIndex = 0;
  }

  async *_streamResponseChunks(messages, options, runManager) {
    yield* super._streamResponseChunks(messages, options, runManager);
    const index = Math.min(this.usageCallIndex, this.usagePerCall.length - 1);
    this.usageCallIndex += 1;
    yield new ChatGenerationChunk({
      text: '',
      message: new AIMessageChunk({ content: '', usage_metadata: this.usagePerCall[index] }),
    });
  }
}

const addTool = tool(async ({ a, b }) => String(a + b), {
  name: 'add',
  description: 'Add two numbers',
  schema: z.object({ a: z.number(), b: z.number() }),
});

const charCounter = (msg) => {
  const content = msg.content;
  if (typeof content === 'string') {
    return content.length + 3;
  }
  if (Array.isArray(content)) {
    let length = 3;
    for (const part of content) {
      if (typeof part === 'string') {
        length += part.length;
      } else if (typeof part?.text === 'string') {
        length += part.text.length;
      }
    }
    return length;
  }
  return 3;
};

function createMockRes() {
  const events = [];
  return {
    events,
    headersSent: true,
    writableEnded: false,
    write(payload) {
      for (const line of String(payload).split('\n')) {
        if (line.startsWith('data: ')) {
          events.push(JSON.parse(line.slice(6)));
        }
      }
      return true;
    },
  };
}

const FIRST_CALL_USAGE = {
  input_tokens: 100,
  output_tokens: 20,
  total_tokens: 120,
};

const SECOND_CALL_USAGE = {
  input_tokens: 150,
  output_tokens: 10,
  total_tokens: 160,
  input_token_details: { cache_creation: 30, cache_read: 50 },
};

const MAX_CONTEXT_TOKENS = 8000;

async function runToolLoop({
  res,
  streamId = null,
  collectedUsage,
  contextUsageSink = null,
  usageEmitSink = null,
  usageCost = null,
}) {
  const { contentParts, aggregateContent } = createContentAggregator();
  const handlers = getDefaultHandlers({
    res,
    aggregateContent,
    toolEndCallback: () => {},
    collectedUsage,
    streamId,
    contextUsageSink,
    usageEmitSink,
    usageCost,
  });

  const run = await Run.create({
    runId: 'usage-e2e-response',
    graphConfig: {
      type: 'standard',
      llmConfig: {
        provider: Providers.OPENAI,
        model: 'gpt-4o-mini',
        streaming: true,
        streamUsage: false,
      },
      instructions: 'You are a helpful assistant.',
      maxContextTokens: MAX_CONTEXT_TOKENS,
      tools: [addTool],
    },
    returnContent: true,
    customHandlers: handlers,
    tokenCounter: charCounter,
    indexTokenCountMap: {},
  });

  run.Graph.overrideModel = new UsageFakeModel(
    {
      responses: ['Let me calculate that.', 'The answer is 4.'],
      toolCalls: [{ name: 'add', args: { a: 2, b: 2 }, id: 'tc_1', type: 'tool_call' }],
    },
    [FIRST_CALL_USAGE, SECOND_CALL_USAGE],
  );

  await run.processStream(
    { messages: [new HumanMessage('What is 2+2?')] },
    {
      configurable: { thread_id: 'usage-e2e-thread', user_id: 'user-1' },
      streamMode: 'values',
      version: 'v2',
    },
  );

  return { run, contentParts };
}

describe('usage events through the real agents pipeline', () => {
  jest.setTimeout(30000);

  afterAll(async () => {
    await GenerationJobManager.destroy();
  });

  test('emits on_token_usage per model call with collectedUsage parity', async () => {
    const res = createMockRes();
    const collectedUsage = [];
    const { contentParts } = await runToolLoop({ res, collectedUsage });

    const usageEvents = res.events.filter((e) => e.event === 'on_token_usage');
    expect(usageEvents).toHaveLength(2);

    expect(usageEvents[0].data).toMatchObject(FIRST_CALL_USAGE);
    expect(usageEvents[1].data).toMatchObject(SECOND_CALL_USAGE);
    expect(usageEvents[0].data.provider).toBe(Providers.OPENAI);
    expect(usageEvents[0].data.model).toBeTruthy();
    expect(usageEvents[0].data.usage_type).toBeUndefined();

    expect(collectedUsage).toHaveLength(2);
    expect(collectedUsage[0]).toMatchObject(FIRST_CALL_USAGE);
    expect(collectedUsage[1]).toMatchObject(SECOND_CALL_USAGE);

    const text = contentParts
      .filter((part) => part?.type === 'text')
      .map((part) => part.text)
      .join('');
    expect(text).toContain('The answer is 4.');
  });

  test('emits a context snapshot before each model call', async () => {
    if (!hasContextUsageEvent) {
      console.warn('Skipping: installed @librechat/agents predates ON_CONTEXT_USAGE');
      return;
    }
    const res = createMockRes();
    const { run } = await runToolLoop({ res, collectedUsage: [] });
    expect(run).toBeDefined();

    const contextEvents = res.events.filter((e) => e.event === 'on_context_usage');
    expect(contextEvents).toHaveLength(2);

    for (const event of contextEvents) {
      const { breakdown, contextBudget, remainingContextTokens, effectiveInstructionTokens } =
        event.data;
      expect(breakdown.maxContextTokens).toBe(MAX_CONTEXT_TOKENS);
      expect(contextBudget).toBeGreaterThan(0);
      expect(contextBudget).toBeLessThanOrEqual(MAX_CONTEXT_TOKENS);
      expect(effectiveInstructionTokens).toBeGreaterThan(0);
      expect(remainingContextTokens).toBeGreaterThan(0);
      expect(remainingContextTokens).toBeLessThan(contextBudget);
      expect(breakdown.toolTokenCounts.add).toBeGreaterThan(0);
    }
    expect(contextEvents[0].data.breakdown.toolMessageTokens).toBe(0);
    const toolBreakdown = contextEvents[1].data.breakdown;
    expect(toolBreakdown.toolMessageTokens).toBeGreaterThan(0);
    expect(toolBreakdown.toolMessageTokens).toBeLessThanOrEqual(toolBreakdown.messageTokens);
    expect(toolBreakdown.toolMessageTokenCounts.add).toBeGreaterThan(0);
    expect(
      Object.values(toolBreakdown.toolMessageTokenCounts).reduce((sum, count) => sum + count, 0),
    ).toBeLessThanOrEqual(toolBreakdown.toolMessageTokens);

    /** Tool loop grows the context between calls */
    expect(contextEvents[1].data.prePruneContextTokens).toBeGreaterThan(
      contextEvents[0].data.prePruneContextTokens,
    );

    /** Snapshot precedes the call's usage event */
    const firstContextIndex = res.events.findIndex((e) => e.event === 'on_context_usage');
    const firstUsageIndex = res.events.findIndex((e) => e.event === 'on_token_usage');
    expect(firstContextIndex).toBeGreaterThanOrEqual(0);
    expect(firstContextIndex).toBeLessThan(firstUsageIndex);
  });

  test('captures the usage rollup + latest context snapshot for message persistence', () => {
    const res = createMockRes();
    const contextUsageSink = { latest: null };
    const usageEmitSink = [];
    return runToolLoop({ res, collectedUsage: [], contextUsageSink, usageEmitSink }).then(() => {
      /** Both model calls' emitted payloads are captured for the rollup */
      expect(usageEmitSink).toHaveLength(2);

      const usage = aggregateEmittedUsage(usageEmitSink);
      /** Display units: openAI is cache-subset, so input excludes cache
       *  (150−30−50=70); output is repaired completion */
      expect(usage).toEqual({
        input:
          FIRST_CALL_USAGE.input_tokens +
          (SECOND_CALL_USAGE.input_tokens -
            SECOND_CALL_USAGE.input_token_details.cache_creation -
            SECOND_CALL_USAGE.input_token_details.cache_read),
        output: FIRST_CALL_USAGE.output_tokens + SECOND_CALL_USAGE.output_tokens,
        cacheWrite: SECOND_CALL_USAGE.input_token_details.cache_creation,
        cacheRead: SECOND_CALL_USAGE.input_token_details.cache_read,
      });
      /** contextCost off → no cost folded into the rollup */
      expect(usage.cost).toBeUndefined();

      if (hasContextUsageEvent) {
        expect(contextUsageSink.latest).not.toBeNull();
        const persisted = buildPersistedContextUsage(contextUsageSink.latest);
        expect(persisted.breakdown.maxContextTokens).toBe(MAX_CONTEXT_TOKENS);
        /** Zero-valued tool counts are trimmed from the persisted blob */
        for (const count of Object.values(persisted.breakdown.toolTokenCounts ?? {})) {
          expect(count).toBeGreaterThan(0);
        }
      }
    });
  });

  test('folds authoritative per-event cost into the rollup when contextCost is on', async () => {
    const res = createMockRes();
    const usageEmitSink = [];
    /** Stub pricing mirroring getMultiplier/getCacheMultiplier shape */
    const usageCost = {
      enabled: true,
      pricing: {
        getMultiplier: ({ tokenType }) => (tokenType === 'completion' ? 15 : 3),
        getCacheMultiplier: ({ cacheType }) => (cacheType === 'write' ? 3.75 : 0.3),
      },
    };
    await runToolLoop({ res, collectedUsage: [], usageEmitSink, usageCost });

    for (const event of usageEmitSink) {
      expect(typeof event.cost).toBe('number');
    }
    const usage = aggregateEmittedUsage(usageEmitSink);
    expect(usage.cost).toBeGreaterThan(0);
    expect(usage.cost).toBeCloseTo(usageEmitSink.reduce((sum, e) => sum + e.cost, 0));
  });

  test('emit path prices each call by its producing agent and strips the agentId tag', () => {
    const res = createMockRes();
    const usageEmitSink = [];
    /** Two endpoints share a model id but bill at different rates. */
    const primaryConfig = { 'gpt-4': { prompt: 0.01, completion: 0.03, context: 8192 } };
    const subagentConfig = { 'gpt-4': { prompt: 0.05, completion: 0.15, context: 8192 } };
    const byAgentId = new Map([
      ['primary', primaryConfig],
      ['sub', subagentConfig],
    ]);
    const usageCost = {
      enabled: true,
      endpointTokenConfig: primaryConfig,
      pricing: {
        getMultiplier: ({ tokenType, model, endpointTokenConfig }) =>
          endpointTokenConfig?.[model]?.[tokenType] ?? 0,
        getCacheMultiplier: () => 0,
      },
      resolveEndpointTokenConfig: (usage) =>
        resolveAgentTokenConfig({ agentId: usage?.agentId, byAgentId, fallback: primaryConfig }),
    };

    const { aggregateContent } = createContentAggregator();
    const handlers = getDefaultHandlers({
      res,
      aggregateContent,
      toolEndCallback: () => {},
      collectedUsage: [],
      usageEmitSink,
      usageCost,
    });
    /** The CHAT_MODEL_END handler's emitUsage IS the real emitTokenUsage closure. */
    const emitUsage = handlers[GraphEvents.CHAT_MODEL_END].emitUsage;
    const call = { model: 'gpt-4', input_tokens: 100, output_tokens: 50, total_tokens: 150 };
    emitUsage({ ...call, agentId: 'sub' });
    emitUsage({ ...call, agentId: 'primary' });

    const events = res.events.filter((e) => e.event === 'on_token_usage');
    expect(events).toHaveLength(2);
    /** agentId is an internal pricing tag — never streamed to the client nor
     *  folded into the persisted rollup. */
    for (const e of events) {
      expect(e.data.agentId).toBeUndefined();
    }
    for (const entry of usageEmitSink) {
      expect(entry.agentId).toBeUndefined();
    }
    /** Same tokens + model id, but the subagent endpoint's higher rates price
     *  its call above the primary — proving per-agent emit pricing. The 5× ratio
     *  ((100·0.05+50·0.15)/(100·0.01+50·0.03)) is scale-independent of credit units. */
    expect(events[1].data.cost).toBeGreaterThan(0);
    expect(events[0].data.cost).toBeGreaterThan(events[1].data.cost);
    expect(events[0].data.cost / events[1].data.cost).toBeCloseTo(5);
  });

  test('persists usage and context snapshot for resume via GenerationJobManager', async () => {
    const streamId = `usage-e2e-stream-${Date.now()}`;
    await GenerationJobManager.createJob(streamId, 'user-1', 'convo-1');

    const res = createMockRes();
    await runToolLoop({ res, streamId, collectedUsage: [] });

    const resumeState = await GenerationJobManager.getResumeState(streamId);
    expect(resumeState).not.toBeNull();

    expect(resumeState.collectedUsage).toHaveLength(2);
    expect(resumeState.collectedUsage[0]).toMatchObject(FIRST_CALL_USAGE);
    expect(resumeState.collectedUsage[1]).toMatchObject(SECOND_CALL_USAGE);

    if (hasContextUsageEvent) {
      expect(resumeState.contextUsage.breakdown.maxContextTokens).toBe(MAX_CONTEXT_TOKENS);
      /** Latest-wins: the persisted snapshot is the second call's */
      expect(resumeState.contextUsage.prePruneContextTokens).toBeGreaterThan(0);
      /** Reconciled to the final primary call's actual prompt: openAI folds cache
       *  into input_tokens (150), so the resume snapshot's used = 150 — the real
       *  context, not the calibrated estimate. */
      const used =
        resumeState.contextUsage.contextBudget - resumeState.contextUsage.remainingContextTokens;
      expect(used).toBe(SECOND_CALL_USAGE.input_tokens);
    }
  });

  /** Drives a real summarization (tight context + padded history); self-summarize
   *  reuses the overridden fake model so no API key is needed. */
  async function runSummarizationLoop({ res, collectedUsage, contextUsageSink, usageEmitSink }) {
    const { aggregateContent } = createContentAggregator();
    const handlers = getDefaultHandlers({
      res,
      aggregateContent,
      toolEndCallback: () => {},
      collectedUsage,
      contextUsageSink,
      usageEmitSink,
      summarizationOptions: { enabled: true },
    });

    const pad = 'context detail to overflow the tiny budget. '.repeat(40);
    const history = [
      new HumanMessage(`Turn 1 question. ${pad}`),
      new AIMessage(`Turn 1 answer. ${pad}`),
      new HumanMessage(`Turn 2 question. ${pad}`),
      new AIMessage(`Turn 2 answer. ${pad}`),
      new HumanMessage(`Final question after a lot of prior history. ${pad}`),
    ];
    const indexTokenCountMap = {};
    history.forEach((message, i) => {
      indexTokenCountMap[i] = charCounter(message);
    });

    const run = await Run.create({
      runId: `summ-e2e-${Date.now()}`,
      graphConfig: {
        type: 'standard',
        llmConfig: {
          provider: Providers.OPENAI,
          model: 'gpt-4o-mini',
          streaming: true,
          streamUsage: false,
        },
        instructions: 'You are a helpful assistant.',
        maxContextTokens: 700,
        summarizationEnabled: true,
        summarizationConfig: { provider: Providers.OPENAI, model: 'gpt-4o-mini' },
      },
      returnContent: true,
      customHandlers: handlers,
      tokenCounter: charCounter,
      indexTokenCountMap,
    });

    run.Graph.overrideModel = new UsageFakeModel(
      { responses: ['## Summary\nPrior turns compacted.', 'Here is the final answer.'] },
      [{ input_tokens: 40, output_tokens: 8, total_tokens: 48 }],
    );

    await run.processStream(
      { messages: history },
      {
        configurable: { thread_id: 'summ-e2e-thread', user_id: 'user-1' },
        streamMode: 'values',
        version: 'v2',
      },
    );
    return run;
  }

  /** A summarized turn compacts the context (summary tokens replace the older
   *  turns) and the reduced snapshot is persisted — the latest snapshot is
   *  followed by a primary usage, so the save guard keeps it and the client
   *  uses the snapshot (not the inflated whole-history estimate). */
  test('persists the reduced (compacted) snapshot after summarization', async () => {
    if (!hasContextUsageEvent) {
      return;
    }
    const res = createMockRes();
    const contextUsageSink = { latest: null, count: 0 };
    const usageEmitSink = [];
    await runSummarizationLoop({ res, collectedUsage: [], contextUsageSink, usageEmitSink });

    const snapshot = contextUsageSink.latest;
    /** Summarization fired: a summary exists and the kept message tokens are
     *  small (the compacted context, not the full history). */
    expect(snapshot?.breakdown?.summaryTokens).toBeGreaterThan(0);
    expect(snapshot?.breakdown?.messageTokens).toBeLessThan(snapshot?.breakdown?.summaryTokens);

    /** The save guard keeps it: a primary usage follows the latest snapshot. */
    const afterLatest = usageEmitSink.slice(contextUsageSink.latestUsageIndex ?? 0);
    expect(afterLatest.some((e) => e.usage_type == null)).toBe(true);
    expect(
      buildPersistedContextUsage(snapshot, usageEmitSink).breakdown.summaryTokens,
    ).toBeGreaterThan(0);
  });
});
