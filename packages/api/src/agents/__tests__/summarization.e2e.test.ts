/**
 * E2E Backend Integration Tests for Summarization
 *
 * Exercises the FULL LibreChat -> agents pipeline:
 *   LibreChat's createRun (@librechat/api)
 *     -> agents package Run.create (@librechat/agents)
 *     -> graph execution -> summarization node -> events
 *
 * Uses real AI providers, real formatAgentMessages, real token accounting.
 * Tracks summaries both mid-run and between runs.
 *
 * Run from packages/api:
 *   npx jest summarization.e2e --no-coverage --testTimeout=180000
 *
 * Requires real API keys in the environment (ANTHROPIC_API_KEY, OPENAI_API_KEY).
 */
import {
  Providers,
  Calculator,
  GraphEvents,
  ToolEndHandler,
  ModelEndHandler,
  createTokenCounter,
  formatAgentMessages,
  ChatModelStreamHandler,
  createContentAggregator,
} from '@librechat/agents';
import type {
  SummarizeCompleteEvent,
  MessageContentComplex,
  SummaryContentBlock,
  SummarizeStartEvent,
  TokenCounter,
  EventHandler,
} from '@librechat/agents';
import { hydrateMissingIndexTokenCounts } from '~/utils';
import { ioredisClient, keyvRedisClient } from '~/cache';
import { createRun } from '~/agents';

afterAll(async () => {
  await ioredisClient?.quit().catch(() => {});
  await keyvRedisClient?.disconnect().catch(() => {});
});

// ---------------------------------------------------------------------------
// Shared test infrastructure
// ---------------------------------------------------------------------------

interface Spies {
  onMessageDelta: jest.Mock;
  onRunStep: jest.Mock;
  onSummarizeStart: jest.Mock;
  onSummarizeDelta: jest.Mock;
  onSummarizeComplete: jest.Mock;
}

type PayloadMessage = {
  role: string;
  content: string | Array<Record<string, unknown>>;
};

function getSummaryText(summary: SummaryContentBlock): string {
  if (Array.isArray(summary.content)) {
    return summary.content
      .map((b: MessageContentComplex) => ('text' in b ? (b as { text: string }).text : ''))
      .join('');
  }
  return '';
}

function createSpies(): Spies {
  return {
    onMessageDelta: jest.fn(),
    onRunStep: jest.fn(),
    onSummarizeStart: jest.fn(),
    onSummarizeDelta: jest.fn(),
    onSummarizeComplete: jest.fn(),
  };
}

function buildHandlers(
  collectedUsage: ConstructorParameters<typeof ModelEndHandler>[0],
  aggregateContent: (params: { event: string; data: unknown }) => void,
  spies: Spies,
): Record<string, EventHandler> {
  return {
    [GraphEvents.TOOL_END]: new ToolEndHandler(),
    [GraphEvents.CHAT_MODEL_END]: new ModelEndHandler(collectedUsage),
    [GraphEvents.CHAT_MODEL_STREAM]: new ChatModelStreamHandler(),
    [GraphEvents.ON_RUN_STEP]: {
      handle: (event: string, data: unknown) => {
        spies.onRunStep(event, data);
        aggregateContent({ event, data });
      },
    },
    [GraphEvents.ON_RUN_STEP_COMPLETED]: {
      handle: (event: string, data: unknown) => {
        aggregateContent({ event, data });
      },
    },
    [GraphEvents.ON_RUN_STEP_DELTA]: {
      handle: (event: string, data: unknown) => {
        aggregateContent({ event, data });
      },
    },
    [GraphEvents.ON_MESSAGE_DELTA]: {
      handle: (event: string, data: unknown, metadata?: Record<string, unknown>) => {
        spies.onMessageDelta(event, data, metadata);
        aggregateContent({ event, data });
      },
    },
    [GraphEvents.TOOL_START]: {
      handle: () => {},
    },
    [GraphEvents.ON_SUMMARIZE_START]: {
      handle: (_event: string, data: unknown) => {
        spies.onSummarizeStart(data);
      },
    },
    [GraphEvents.ON_SUMMARIZE_DELTA]: {
      handle: (_event: string, data: unknown) => {
        spies.onSummarizeDelta(data);
        aggregateContent({ event: GraphEvents.ON_SUMMARIZE_DELTA, data });
      },
    },
    [GraphEvents.ON_SUMMARIZE_COMPLETE]: {
      handle: (_event: string, data: unknown) => {
        spies.onSummarizeComplete(data);
      },
    },
  };
}

function getDefaultModel(provider: string): string {
  switch (provider) {
    case Providers.ANTHROPIC:
      return 'claude-haiku-4-5-20251001';
    case Providers.OPENAI:
      return 'gpt-4.1-mini';
    default:
      return 'gpt-4.1-mini';
  }
}

// ---------------------------------------------------------------------------
// Turn runner — mirrors AgentClient.chatCompletion() message flow
// ---------------------------------------------------------------------------

interface RunFullTurnParams {
  payload: PayloadMessage[];
  agentProvider: string;
  summarizationProvider: string;
  summarizationModel?: string;
  maxContextTokens: number;
  instructions: string;
  spies: Spies;
  tokenCounter: TokenCounter;
  model?: string;
}

async function runFullTurn({
  payload,
  agentProvider,
  summarizationProvider,
  summarizationModel,
  maxContextTokens,
  instructions,
  spies,
  tokenCounter,
  model,
}: RunFullTurnParams) {
  const collectedUsage: ConstructorParameters<typeof ModelEndHandler>[0] = [];
  const { contentParts, aggregateContent } = createContentAggregator();

  const formatted = formatAgentMessages(payload as never, {});
  const { messages: initialMessages, summary: initialSummary } = formatted;
  let { indexTokenCountMap } = formatted;

  indexTokenCountMap = hydrateMissingIndexTokenCounts({
    messages: initialMessages,
    indexTokenCountMap: indexTokenCountMap as Record<string, number | undefined>,
    tokenCounter,
  });

  const abortController = new AbortController();
  const agent = {
    id: `test-agent-${agentProvider}`,
    name: 'Test Agent',
    provider: agentProvider,
    instructions,
    tools: [new Calculator()],
    maxContextTokens,
    model_parameters: {
      model: model || getDefaultModel(agentProvider),
      streaming: true,
      streamUsage: true,
    },
  };

  const summarizationConfig = {
    enabled: true,
    provider: summarizationProvider,
    model: summarizationModel || getDefaultModel(summarizationProvider),
    prompt:
      'You are a summarization assistant. Summarize the following conversation messages concisely, preserving key facts, decisions, and context needed to continue the conversation. Do not include preamble -- output only the summary.',
  };

  const run = await createRun({
    agents: [agent] as never,
    messages: initialMessages,
    indexTokenCountMap,
    initialSummary,
    runId: `e2e-${Date.now()}`,
    signal: abortController.signal,
    customHandlers: buildHandlers(
      collectedUsage,
      aggregateContent as (params: { event: string; data: unknown }) => void,
      spies,
    ) as never,
    summarizationConfig,
    tokenCounter,
  });

  const streamConfig = {
    configurable: { thread_id: `e2e-${Date.now()}` },
    recursionLimit: 100,
    streamMode: 'values' as const,
    version: 'v2' as const,
  };
  let result: unknown;
  let processError: Error | undefined;
  try {
    result = await run.processStream({ messages: initialMessages }, streamConfig);
  } catch (err) {
    processError = err as Error;
  }
  const runMessages = run.getRunMessages() || [];

  return {
    result,
    processError,
    runMessages,
    collectedUsage,
    contentParts,
    indexTokenCountMap,
  };
}

function getLastContent(runMessages: Array<{ content: string | unknown }>): string {
  const last = runMessages[runMessages.length - 1];
  if (!last) {
    return '';
  }
  return typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
}

// ---------------------------------------------------------------------------
// Anthropic Tests
// ---------------------------------------------------------------------------

const hasAnthropic =
  process.env.ANTHROPIC_API_KEY != null && process.env.ANTHROPIC_API_KEY !== 'test';
(hasAnthropic ? describe : describe.skip)('Anthropic Summarization E2E (LibreChat)', () => {
  jest.setTimeout(180_000);

  const instructions =
    'You are an expert math tutor. You MUST use the calculator tool for ALL computations. Keep answers to 1-2 sentences.';

  test('multi-turn triggers summarization, summary persists across runs', async () => {
    const spies = createSpies();
    const tokenCounter = await createTokenCounter();
    const conversationPayload: PayloadMessage[] = [];

    const addTurn = async (userMsg: string, maxTokens: number) => {
      conversationPayload.push({ role: 'user', content: userMsg });
      const result = await runFullTurn({
        payload: conversationPayload,
        agentProvider: Providers.ANTHROPIC,
        summarizationProvider: Providers.ANTHROPIC,
        summarizationModel: 'claude-haiku-4-5-20251001',
        maxContextTokens: maxTokens,
        instructions,
        spies,
        tokenCounter,
      });
      conversationPayload.push({ role: 'assistant', content: getLastContent(result.runMessages) });
      return result;
    };

    await addTurn('What is 12345 * 6789? Use the calculator.', 2000);
    await addTurn(
      'Now divide that result by 137. Then multiply by 42. Calculator for each step.',
      2000,
    );
    await addTurn(
      'Compute step by step: 1) 9876543 - 1234567  2) sqrt of result  3) Add 100. Calculator for each.',
      1500,
    );
    await addTurn('What is 2^20? Calculator. Then list everything we calculated so far.', 800);

    if (spies.onSummarizeStart.mock.calls.length === 0) {
      await addTurn('Calculate 355 / 113. Calculator.', 600);
    }
    if (spies.onSummarizeStart.mock.calls.length === 0) {
      await addTurn('What is 999 * 999? Calculator.', 400);
    }

    const startCalls = spies.onSummarizeStart.mock.calls.length;
    const completeCalls = spies.onSummarizeComplete.mock.calls.length;

    expect(startCalls).toBeGreaterThanOrEqual(1);
    expect(completeCalls).toBeGreaterThanOrEqual(1);

    const startPayload = spies.onSummarizeStart.mock.calls[0][0] as SummarizeStartEvent;
    expect(startPayload.agentId).toBeDefined();
    expect(startPayload.provider).toBeDefined();
    expect(startPayload.messagesToRefineCount).toBeGreaterThan(0);
    expect(startPayload.summaryVersion).toBeGreaterThanOrEqual(1);

    const completePayload = spies.onSummarizeComplete.mock.calls[0][0] as SummarizeCompleteEvent;
    expect(completePayload.summary).toBeDefined();
    expect(getSummaryText(completePayload.summary!).length).toBeGreaterThan(10);
    expect(completePayload.summary!.tokenCount).toBeGreaterThan(0);
    expect(completePayload.summary!.tokenCount!).toBeLessThan(2000);
    expect(completePayload.summary!.provider).toBeDefined();
    expect(completePayload.summary!.createdAt).toBeDefined();
    expect(completePayload.summary!.summaryVersion).toBeGreaterThanOrEqual(1);

    // --- Cross-run: persist summary -> formatAgentMessages -> new run ---
    const summaryBlock = completePayload.summary!;
    const crossRunPayload: PayloadMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'summary',
            content: [{ type: 'text', text: getSummaryText(summaryBlock) }],
            tokenCount: summaryBlock.tokenCount,
          },
        ],
      },
      conversationPayload[conversationPayload.length - 2],
      conversationPayload[conversationPayload.length - 1],
      {
        role: 'user',
        content: 'What was the first calculation we did? Verify with calculator.',
      },
    ];

    spies.onSummarizeStart.mockClear();
    spies.onSummarizeComplete.mockClear();

    const crossRun = await runFullTurn({
      payload: crossRunPayload,
      agentProvider: Providers.ANTHROPIC,
      summarizationProvider: Providers.ANTHROPIC,
      summarizationModel: 'claude-haiku-4-5-20251001',
      maxContextTokens: 2000,
      instructions,
      spies,
      tokenCounter,
    });

    console.log(
      `  Cross-run: messages=${crossRun.runMessages.length}, content=${crossRun.contentParts.length}, deltas=${spies.onMessageDelta.mock.calls.length}`,
    );
    // Content aggregator should have received response deltas even if getRunMessages is empty
    expect(crossRun.contentParts.length + spies.onMessageDelta.mock.calls.length).toBeGreaterThan(
      0,
    );
  });

  test('tight context (maxContextTokens=200) does not infinite-loop', async () => {
    const spies = createSpies();
    const tokenCounter = await createTokenCounter();
    const conversationPayload: PayloadMessage[] = [];

    conversationPayload.push({ role: 'user', content: 'What is 42 * 58? Calculator.' });
    const t1 = await runFullTurn({
      payload: conversationPayload,
      agentProvider: Providers.ANTHROPIC,
      summarizationProvider: Providers.ANTHROPIC,
      summarizationModel: 'claude-haiku-4-5-20251001',
      maxContextTokens: 2000,
      instructions,
      spies,
      tokenCounter,
    });
    conversationPayload.push({ role: 'assistant', content: getLastContent(t1.runMessages) });

    conversationPayload.push({ role: 'user', content: 'Now compute 2436 + 1337. Calculator.' });
    const t2 = await runFullTurn({
      payload: conversationPayload,
      agentProvider: Providers.ANTHROPIC,
      summarizationProvider: Providers.ANTHROPIC,
      summarizationModel: 'claude-haiku-4-5-20251001',
      maxContextTokens: 2000,
      instructions,
      spies,
      tokenCounter,
    });
    conversationPayload.push({ role: 'assistant', content: getLastContent(t2.runMessages) });

    conversationPayload.push({ role: 'user', content: 'What is 100 / 4? Calculator.' });

    let error: Error | undefined;
    try {
      await runFullTurn({
        payload: conversationPayload,
        agentProvider: Providers.ANTHROPIC,
        summarizationProvider: Providers.ANTHROPIC,
        summarizationModel: 'claude-haiku-4-5-20251001',
        maxContextTokens: 200,
        instructions,
        spies,
        tokenCounter,
      });
    } catch (err) {
      error = err as Error;
    }

    // The key guarantee: the system terminates — no true infinite loop.
    // With very tight context, the graph may either:
    //   1. Complete normally (model responds within budget)
    //   2. Hit recursion limit (bounded tool-call cycles)
    //   3. Error with empty_messages (context too small for any message)
    // All are valid termination modes.
    if (error) {
      const isCleanTermination =
        error.message.includes('Recursion limit') || error.message.includes('empty_messages');

      expect(isCleanTermination).toBe(true);
    }

    // Summarization may or may not fire depending on whether the budget
    // allows any messages before the graph terminates. With 200 tokens
    // and instructions at ~100 tokens, there may be no room for history,
    // which correctly skips summarization.

    console.log(
      `  Tight context: summarize=${spies.onSummarizeStart.mock.calls.length}, error=${error?.message?.substring(0, 80) ?? 'none'}`,
    );
  });
});

// ---------------------------------------------------------------------------
// OpenAI Tests
// ---------------------------------------------------------------------------

const hasOpenAI = process.env.OPENAI_API_KEY != null && process.env.OPENAI_API_KEY !== 'test';
(hasOpenAI ? describe : describe.skip)('OpenAI Summarization E2E (LibreChat)', () => {
  jest.setTimeout(180_000);

  const instructions =
    'You are a helpful math tutor. Use the calculator tool for ALL computations. Keep responses concise.';

  test('multi-turn with cross-run summary continuity', async () => {
    const spies = createSpies();
    const tokenCounter = await createTokenCounter();
    const conversationPayload: PayloadMessage[] = [];

    const addTurn = async (userMsg: string, maxTokens: number) => {
      conversationPayload.push({ role: 'user', content: userMsg });
      const result = await runFullTurn({
        payload: conversationPayload,
        agentProvider: Providers.OPENAI,
        summarizationProvider: Providers.OPENAI,
        summarizationModel: 'gpt-4.1-mini',
        maxContextTokens: maxTokens,
        instructions,
        spies,
        tokenCounter,
      });
      conversationPayload.push({ role: 'assistant', content: getLastContent(result.runMessages) });
      return result;
    };

    await addTurn('What is 1234 * 5678? Calculator.', 2000);
    await addTurn('Compute sqrt(7006652) with calculator.', 1500);
    await addTurn('Calculate 99*101 and 2^15. Calculator for each.', 1200);
    await addTurn('What is 314159 * 271828? Calculator. Remind me of all prior results.', 800);

    if (spies.onSummarizeStart.mock.calls.length === 0) {
      await addTurn('Calculate 999999 / 7. Calculator.', 600);
    }
    if (spies.onSummarizeStart.mock.calls.length === 0) {
      await addTurn('What is 42 + 58? Calculator.', 400);
    }
    if (spies.onSummarizeStart.mock.calls.length === 0) {
      await addTurn('Calculate 7 * 13. Calculator.', 300);
    }
    if (spies.onSummarizeStart.mock.calls.length === 0) {
      await addTurn('What is 100 - 37? Calculator.', 200);
    }

    expect(spies.onSummarizeStart.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(spies.onSummarizeComplete.mock.calls.length).toBeGreaterThanOrEqual(1);

    const complete = spies.onSummarizeComplete.mock.calls[0][0] as SummarizeCompleteEvent;
    expect(getSummaryText(complete.summary!).length).toBeGreaterThan(10);
    expect(complete.summary!.tokenCount).toBeGreaterThan(0);
    expect(complete.summary!.summaryVersion).toBeGreaterThanOrEqual(1);
    expect(complete.summary!.provider).toBe(Providers.OPENAI);

    const summaryBlock = complete.summary!;
    const crossRunPayload: PayloadMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'summary',
            content: [{ type: 'text', text: getSummaryText(summaryBlock) }],
            tokenCount: summaryBlock.tokenCount,
          },
        ],
      },
      conversationPayload[conversationPayload.length - 2],
      conversationPayload[conversationPayload.length - 1],
      { role: 'user', content: 'What was the first number we calculated? Verify with calculator.' },
    ];

    spies.onSummarizeStart.mockClear();
    spies.onSummarizeComplete.mockClear();

    const crossRun = await runFullTurn({
      payload: crossRunPayload,
      agentProvider: Providers.OPENAI,
      summarizationProvider: Providers.OPENAI,
      summarizationModel: 'gpt-4.1-mini',
      maxContextTokens: 2000,
      instructions,
      spies,
      tokenCounter,
    });

    console.log(
      `  Cross-run: messages=${crossRun.runMessages.length}, content=${crossRun.contentParts.length}, deltas=${spies.onMessageDelta.mock.calls.length}`,
    );
    expect(crossRun.contentParts.length + spies.onMessageDelta.mock.calls.length).toBeGreaterThan(
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// Cross-provider: Anthropic agent, OpenAI summarizer
// ---------------------------------------------------------------------------

const hasBothProviders = hasAnthropic && hasOpenAI;
(hasBothProviders ? describe : describe.skip)(
  'Cross-provider Summarization E2E (LibreChat)',
  () => {
    jest.setTimeout(180_000);

    const instructions =
      'You are a math assistant. Use the calculator for every computation. Be brief.';

    test('Anthropic agent with OpenAI summarizer', async () => {
      const spies = createSpies();
      const tokenCounter = await createTokenCounter();
      const conversationPayload: PayloadMessage[] = [];

      const addTurn = async (userMsg: string, maxTokens: number) => {
        conversationPayload.push({ role: 'user', content: userMsg });
        const result = await runFullTurn({
          payload: conversationPayload,
          agentProvider: Providers.ANTHROPIC,
          summarizationProvider: Providers.OPENAI,
          summarizationModel: 'gpt-4.1-mini',
          maxContextTokens: maxTokens,
          instructions,
          spies,
          tokenCounter,
        });
        conversationPayload.push({
          role: 'assistant',
          content: getLastContent(result.runMessages),
        });
        return result;
      };

      await addTurn('Compute 54321 * 12345 using calculator.', 2000);
      await addTurn('Now calculate 670592745 / 99991. Calculator.', 1500);
      await addTurn('What is sqrt(670592745)? Calculator.', 1000);
      await addTurn('Compute 2^32 with calculator. List all prior results.', 600);

      if (spies.onSummarizeStart.mock.calls.length === 0) {
        await addTurn('13 * 17 * 19 = ? Calculator.', 400);
      }

      expect(spies.onSummarizeComplete.mock.calls.length).toBeGreaterThanOrEqual(1);
      const complete = spies.onSummarizeComplete.mock.calls[0][0] as SummarizeCompleteEvent;

      expect(complete.summary!.provider).toBe(Providers.OPENAI);
      expect(complete.summary!.model).toBe('gpt-4.1-mini');
      expect(getSummaryText(complete.summary!).length).toBeGreaterThan(10);
    });
  },
);
