import type { TContextUsageEvent, TTokenUsageEvent } from 'librechat-data-provider';
import type { RecordUsageDeps, RecordUsageParams, SubagentUsageEvent } from './usage';
import type { UsageMetadata } from '../stream/interfaces/IJobStore';
import type { BulkWriteDeps, PricingFns } from './transactions';
import {
  computeUsageCostUSD,
  aggregateEmittedUsage,
  createDetachedSubagentUsageRecorder,
  createSubagentUsageSink,
  aggregateCollectedUsage,
  recordCollectedUsage,
  resolveAgentTokenConfig,
  resolveRunUsageContext,
  hasRecordedProviderUsage,
  hasRecordedPrimaryUsage,
  recordFallbackTokenUsage,
  buildPersistedContextUsage,
  buildAbortedResponseMetadata,
  computeSummaryUsedTokens,
  priorRunOutputTokens,
  resolveRetainedToolTokens,
} from './usage';
import { runWithDetachedSubagentUsage } from './subagentTaskContext';
import Tokenizer from '~/utils/tokenizer';

describe('resolveRetainedToolTokens', () => {
  const toolPart = (id: string, output: string) => ({
    type: 'tool_call',
    tool_call: { id, name: 'read_file', args: '{"path":"a"}', output },
  });

  beforeAll(async () => {
    await Tokenizer.initEncoding('o200k_base');
  });

  it('counts the results retained past the snapshot when the tool limit stopped the turn', () => {
    /** Left to its default, the counter is the run's own tokenizer — the one the
     *  snapshot was measured with — so the figure is the real token count of the
     *  retained result and nothing else. */
    const retained = resolveRetainedToolTokens({
      stoppedAtToolLimit: true,
      contentParts: [
        toolPart('call_1', 'the result the snapshot counted'),
        toolPart('call_2', 'the retained result'),
      ],
      priorToolCallIds: new Set(['call_1']),
      encoding: 'o200k_base',
    });
    expect(retained).toBe(Tokenizer.countExactTokens('the retained result', 'o200k_base'));
  });

  it('reports nothing for every other ending, whatever the turn produced', () => {
    /** Its tools were followed by another model call, hence another snapshot that
     *  already counts them as kept-message context. */
    expect(
      resolveRetainedToolTokens({
        stoppedAtToolLimit: false,
        contentParts: [toolPart('call_1', 'a result the next call re-counted')],
        priorToolCallIds: new Set(),
        encoding: 'o200k_base',
      }),
    ).toBeUndefined();
  });

  it('passes the deployment ceiling on to the counter', () => {
    /** `endpoints.agents.maxRetainedToolCountChars`: past it the figure is withdrawn
     *  rather than estimated, so the gauge under-reports instead of stalling a save. */
    expect(
      resolveRetainedToolTokens({
        stoppedAtToolLimit: true,
        contentParts: [toolPart('call_1', 'a result longer than the ceiling allows')],
        priorToolCallIds: new Set(),
        encoding: 'o200k_base',
        maxCountChars: 4,
      }),
    ).toBeUndefined();
  });

  it('takes a supplied counter instead of reaching for the shared tokenizer', () => {
    const countExact = jest.fn((text: string) => text.length);
    expect(
      resolveRetainedToolTokens({
        stoppedAtToolLimit: true,
        contentParts: [toolPart('call_1', 'result')],
        priorToolCallIds: new Set(),
        encoding: 'claude',
        countExact,
      }),
    ).toBe(Math.ceil('result'.length * 1.1));
    expect(countExact).toHaveBeenCalledWith('result');
  });
});

describe('aggregateCollectedUsage', () => {
  it('preserves the no-child baseline and ignores absent entries', () => {
    expect(
      aggregateCollectedUsage([{ input_tokens: 100, output_tokens: 40, provider: 'openai' }, null]),
    ).toEqual({
      total: {
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
        cacheReadTokens: 0,
        reasoningTokens: 0,
      },
      primary: {
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
        cacheReadTokens: 0,
        reasoningTokens: 0,
      },
      subagent: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        reasoningTokens: 0,
      },
    });
  });

  it('includes multiple child calls once in the combined and subagent totals', () => {
    const result = aggregateCollectedUsage([
      { input_tokens: 100, output_tokens: 40, provider: 'openai' },
      {
        input_tokens: 25,
        output_tokens: 10,
        provider: 'openai',
        usage_type: 'subagent',
      },
      {
        input_tokens: 35,
        output_tokens: 15,
        provider: 'openai',
        usage_type: 'subagent',
      },
    ]);

    expect(result.total).toEqual(
      expect.objectContaining({ inputTokens: 160, outputTokens: 65, totalTokens: 225 }),
    );
    expect(result.subagent).toEqual(
      expect.objectContaining({ inputTokens: 60, outputTokens: 25, totalTokens: 85 }),
    );
  });

  it('uses provider-aware cache normalization for primary and child calls', () => {
    const result = aggregateCollectedUsage([
      {
        input_tokens: 200,
        output_tokens: 80,
        provider: 'anthropic',
        input_token_details: { cache_creation: 60, cache_read: 30 },
      },
      {
        input_tokens: 100,
        output_tokens: 50,
        provider: 'bedrock',
        usage_type: 'subagent',
        input_token_details: { cache_creation: 20, cache_read: 10 },
      },
    ]);

    expect(result.primary.inputTokens).toBe(200);
    expect(result.subagent.inputTokens).toBe(130);
    expect(result.total.cacheReadTokens).toBe(40);
  });

  it('repairs provider output undercounts and aggregates reasoning details', () => {
    const result = aggregateCollectedUsage([
      {
        input_tokens: 64,
        output_tokens: 2674,
        total_tokens: 3379,
        provider: 'vertexai',
        output_token_details: { reasoning: 641 },
      },
      {
        input_tokens: 20,
        output_tokens: 10,
        provider: 'openai',
        usage_type: 'subagent',
        output_token_details: { reasoning_tokens: 3 },
      },
    ]);

    expect(result.total.outputTokens).toBe(3325);
    expect(result.total.reasoningTokens).toBe(644);
  });
});

describe('recordCollectedUsage', () => {
  let mockSpendTokens: jest.Mock;
  let mockSpendStructuredTokens: jest.Mock;
  let deps: RecordUsageDeps;

  const baseParams: Omit<RecordUsageParams, 'collectedUsage'> = {
    user: 'user-123',
    conversationId: 'convo-123',
    model: 'gpt-4',
    context: 'message',
    balance: { enabled: true },
    transactions: { enabled: true },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockSpendTokens = jest.fn().mockResolvedValue(undefined);
    mockSpendStructuredTokens = jest.fn().mockResolvedValue(undefined);
    deps = {
      spendTokens: mockSpendTokens,
      spendStructuredTokens: mockSpendStructuredTokens,
    };
  });

  describe('basic functionality', () => {
    it('should return undefined if collectedUsage is empty', async () => {
      const result = await recordCollectedUsage(deps, {
        ...baseParams,
        collectedUsage: [],
      });

      expect(result).toBeUndefined();
      expect(mockSpendTokens).not.toHaveBeenCalled();
      expect(mockSpendStructuredTokens).not.toHaveBeenCalled();
    });

    it('should return undefined if collectedUsage is null-ish', async () => {
      const result = await recordCollectedUsage(deps, {
        ...baseParams,
        collectedUsage: null as unknown as UsageMetadata[],
      });

      expect(result).toBeUndefined();
      expect(mockSpendTokens).not.toHaveBeenCalled();
    });

    it('should handle single usage entry correctly', async () => {
      const collectedUsage: UsageMetadata[] = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
      ];

      const result = await recordCollectedUsage(deps, {
        ...baseParams,
        collectedUsage,
      });

      expect(mockSpendTokens).toHaveBeenCalledTimes(1);
      expect(mockSpendTokens).toHaveBeenCalledWith(
        expect.objectContaining({
          user: 'user-123',
          conversationId: 'convo-123',
          model: 'gpt-4',
          context: 'message',
        }),
        { promptTokens: 100, completionTokens: 50 },
      );
      expect(result).toEqual({ input_tokens: 100, output_tokens: 50 });
    });

    it('should skip null entries in collectedUsage', async () => {
      const collectedUsage = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
        null,
        { input_tokens: 200, output_tokens: 60, model: 'gpt-4' },
      ] as UsageMetadata[];

      const result = await recordCollectedUsage(deps, {
        ...baseParams,
        collectedUsage,
      });

      expect(mockSpendTokens).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ input_tokens: 100, output_tokens: 110 });
    });
  });

  describe('sequential execution (tool calls)', () => {
    it('should calculate tokens correctly for sequential tool calls', async () => {
      const collectedUsage: UsageMetadata[] = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
        { input_tokens: 150, output_tokens: 30, model: 'gpt-4' },
        { input_tokens: 180, output_tokens: 20, model: 'gpt-4' },
      ];

      const result = await recordCollectedUsage(deps, {
        ...baseParams,
        collectedUsage,
      });

      expect(mockSpendTokens).toHaveBeenCalledTimes(3);
      expect(result?.output_tokens).toBe(100); // 50 + 30 + 20
      expect(result?.input_tokens).toBe(100); // First entry's input
    });
  });

  describe('summarization usage segregation', () => {
    it('includes summarization output tokens in total while billing under separate context', async () => {
      const collectedUsage: UsageMetadata[] = [
        {
          usage_type: 'message',
          input_tokens: 120,
          output_tokens: 40,
          model: 'gpt-4',
        },
        {
          usage_type: 'summarization',
          input_tokens: 30,
          output_tokens: 12,
          model: 'gpt-4.1-mini',
        },
      ];

      const result = await recordCollectedUsage(deps, {
        ...baseParams,
        collectedUsage,
      });

      expect(result).toEqual({ input_tokens: 120, output_tokens: 52 });
      expect(mockSpendTokens).toHaveBeenCalledTimes(2);
      expect(mockSpendTokens).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ context: 'message', model: 'gpt-4' }),
        expect.any(Object),
      );
      expect(mockSpendTokens).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          context: 'summarization',
          model: 'gpt-4.1-mini',
        }),
        expect.any(Object),
      );
    });
  });

  describe('subagent usage segregation', () => {
    it('bills subagent entries under separate context while excluding them from reported totals', async () => {
      const collectedUsage: UsageMetadata[] = [
        {
          usage_type: 'message',
          input_tokens: 120,
          output_tokens: 40,
          model: 'gpt-4',
        },
        {
          usage_type: 'subagent',
          input_tokens: 900,
          output_tokens: 700,
          model: 'claude-haiku-4-5',
          provider: 'anthropic',
        },
        {
          usage_type: 'subagent',
          input_tokens: 1100,
          output_tokens: 300,
          model: 'claude-haiku-4-5',
          provider: 'anthropic',
        },
      ];

      const result = await recordCollectedUsage(deps, {
        ...baseParams,
        collectedUsage,
      });

      /**
       * `input_tokens` comes from the first MESSAGE usage; `output_tokens`
       * excludes subagent completions — the result becomes the parent
       * response message's tokenCount, and child output the parent never
       * saw must not distort next-turn context accounting.
       */
      expect(result).toEqual({ input_tokens: 120, output_tokens: 40 });
      /** ...but every subagent call is still billed against balance. */
      expect(mockSpendTokens).toHaveBeenCalledTimes(3);
      expect(mockSpendTokens).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          context: 'subagent',
          model: 'claude-haiku-4-5',
        }),
        { promptTokens: 900, completionTokens: 700 },
      );
      expect(mockSpendTokens).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          context: 'subagent',
          model: 'claude-haiku-4-5',
        }),
        { promptTokens: 1100, completionTokens: 300 },
      );
    });

    it('bills hidden sequential-agent usage but excludes it from reported totals', async () => {
      const collectedUsage: UsageMetadata[] = [
        { usage_type: 'message', input_tokens: 120, output_tokens: 40, model: 'gpt-4' },
        { usage_type: 'sequential', input_tokens: 800, output_tokens: 250, model: 'gpt-4' },
      ];

      const result = await recordCollectedUsage(deps, { ...baseParams, collectedUsage });

      /** Hidden intermediate output stays out of the parent's tokenCount... */
      expect(result).toEqual({ input_tokens: 120, output_tokens: 40 });
      /** ...but is still billed under its own context. */
      expect(mockSpendTokens).toHaveBeenCalledTimes(2);
      expect(mockSpendTokens).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ context: 'sequential', model: 'gpt-4' }),
        { promptTokens: 800, completionTokens: 250 },
      );
    });

    it('does not let a leading subagent entry hijack reported input_tokens', async () => {
      const collectedUsage: UsageMetadata[] = [
        {
          usage_type: 'subagent',
          input_tokens: 5000,
          output_tokens: 900,
          model: 'claude-haiku-4-5',
        },
        {
          input_tokens: 120,
          output_tokens: 40,
          model: 'gpt-4',
        },
      ];

      const result = await recordCollectedUsage(deps, {
        ...baseParams,
        collectedUsage,
      });

      expect(result).toEqual({ input_tokens: 120, output_tokens: 40 });
      expect(mockSpendTokens).toHaveBeenCalledTimes(2);
    });

    it('uses structured spend for subagent entries with cache tokens', async () => {
      const collectedUsage: UsageMetadata[] = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
        {
          usage_type: 'subagent',
          input_tokens: 200,
          output_tokens: 80,
          model: 'claude-haiku-4-5',
          provider: 'anthropic',
          input_token_details: { cache_creation: 60, cache_read: 30 },
        },
      ];

      await recordCollectedUsage(deps, {
        ...baseParams,
        collectedUsage,
      });

      expect(mockSpendStructuredTokens).toHaveBeenCalledTimes(1);
      /** Anthropic input_tokens is cache-inclusive, so cache is subtracted out
       *  of the billed input: 200 − 60 − 30 = 110 (not double-charged). */
      expect(mockSpendStructuredTokens).toHaveBeenCalledWith(
        expect.objectContaining({
          context: 'subagent',
          model: 'claude-haiku-4-5',
        }),
        {
          promptTokens: { input: 110, write: 60, read: 30 },
          completionTokens: 80,
        },
      );
    });
  });

  describe('parallel execution (multiple agents)', () => {
    it('should handle parallel agents with independent input tokens', async () => {
      const collectedUsage: UsageMetadata[] = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
        { input_tokens: 80, output_tokens: 40, model: 'gpt-4' },
      ];

      const result = await recordCollectedUsage(deps, {
        ...baseParams,
        collectedUsage,
      });

      expect(mockSpendTokens).toHaveBeenCalledTimes(2);
      expect(result?.output_tokens).toBe(90); // 50 + 40
      expect(result?.output_tokens).toBeGreaterThan(0);
    });

    it('should NOT produce negative output_tokens for parallel execution', async () => {
      const collectedUsage: UsageMetadata[] = [
        { input_tokens: 200, output_tokens: 100, model: 'gpt-4' },
        { input_tokens: 50, output_tokens: 30, model: 'gpt-4' },
      ];

      const result = await recordCollectedUsage(deps, {
        ...baseParams,
        collectedUsage,
      });

      expect(result?.output_tokens).toBeGreaterThan(0);
      expect(result?.output_tokens).toBe(130); // 100 + 30
    });

    it('should calculate correct total output for multiple parallel agents', async () => {
      const collectedUsage: UsageMetadata[] = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
        { input_tokens: 120, output_tokens: 60, model: 'gpt-4-turbo' },
        { input_tokens: 80, output_tokens: 40, model: 'claude-3' },
      ];

      const result = await recordCollectedUsage(deps, {
        ...baseParams,
        collectedUsage,
      });

      expect(mockSpendTokens).toHaveBeenCalledTimes(3);
      expect(result?.output_tokens).toBe(150); // 50 + 60 + 40
    });
  });

  describe('cache token handling - subset providers (input_tokens already includes cache)', () => {
    it('subtracts cache from input_tokens for OpenAI to avoid double-counting', async () => {
      const collectedUsage: UsageMetadata[] = [
        {
          input_tokens: 100,
          output_tokens: 50,
          model: 'gpt-4',
          provider: 'openAI',
          input_token_details: {
            cache_creation: 20,
            cache_read: 10,
          },
        },
      ];

      const result = await recordCollectedUsage(deps, {
        ...baseParams,
        collectedUsage,
      });

      expect(mockSpendStructuredTokens).toHaveBeenCalledTimes(1);
      expect(mockSpendTokens).not.toHaveBeenCalled();
      expect(mockSpendStructuredTokens).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-4' }),
        {
          promptTokens: { input: 70, write: 20, read: 10 },
          completionTokens: 50,
        },
      );
      expect(result?.input_tokens).toBe(100);
    });

    it('does not double-count cache_read for Gemini — issue #12855', async () => {
      // Real numbers from the issue report
      const collectedUsage: UsageMetadata[] = [
        {
          input_tokens: 11125,
          output_tokens: 20,
          model: 'gemini-3-flash-preview',
          provider: 'google',
          input_token_details: { cache_read: 7441 },
        },
      ];

      const result = await recordCollectedUsage(deps, {
        ...baseParams,
        collectedUsage,
      });

      expect(mockSpendStructuredTokens).toHaveBeenCalledTimes(1);
      expect(mockSpendStructuredTokens).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gemini-3-flash-preview' }),
        {
          promptTokens: { input: 3684, write: 0, read: 7441 },
          completionTokens: 20,
        },
      );
      expect(result?.input_tokens).toBe(11125);
    });

    it('also applies to Vertex AI', async () => {
      const collectedUsage: UsageMetadata[] = [
        {
          input_tokens: 5000,
          output_tokens: 100,
          model: 'gemini-2.5-pro',
          provider: 'vertexai',
          input_token_details: { cache_read: 4000 },
        },
      ];

      await recordCollectedUsage(deps, {
        ...baseParams,
        collectedUsage,
      });

      expect(mockSpendStructuredTokens).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gemini-2.5-pro' }),
        {
          promptTokens: { input: 1000, write: 0, read: 4000 },
          completionTokens: 100,
        },
      );
    });

    it('handles cache_read >= input_tokens defensively (clamps inputOnly to 0)', async () => {
      const collectedUsage: UsageMetadata[] = [
        {
          input_tokens: 1000,
          output_tokens: 30,
          model: 'gemini-2.5-pro',
          provider: 'google',
          input_token_details: { cache_read: 1000 },
        },
      ];

      await recordCollectedUsage(deps, {
        ...baseParams,
        collectedUsage,
      });

      expect(mockSpendStructuredTokens).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gemini-2.5-pro' }),
        {
          promptTokens: { input: 0, write: 0, read: 1000 },
          completionTokens: 30,
        },
      );
    });

    it('falls through to additive (historical default) when provider is missing', async () => {
      // Defensive: an unclassified or pre-this-PR usage entry should keep old behavior
      const collectedUsage: UsageMetadata[] = [
        {
          input_tokens: 100,
          output_tokens: 50,
          model: 'gpt-4',
          input_token_details: { cache_creation: 20, cache_read: 10 },
        },
      ];

      const result = await recordCollectedUsage(deps, {
        ...baseParams,
        collectedUsage,
      });

      expect(mockSpendStructuredTokens).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-4' }),
        {
          promptTokens: { input: 100, write: 20, read: 10 },
          completionTokens: 50,
        },
      );
      expect(result?.input_tokens).toBe(130);
    });
  });

  describe('cache token handling - Anthropic format', () => {
    it('should use spendStructuredTokens for cache tokens (cache_*_input_tokens)', async () => {
      /** Cache-inclusive input_tokens (140 = 100 fresh + 25 write + 15 read). */
      const collectedUsage: UsageMetadata[] = [
        {
          input_tokens: 140,
          output_tokens: 50,
          model: 'claude-3',
          provider: 'anthropic',
          cache_creation_input_tokens: 25,
          cache_read_input_tokens: 15,
        },
      ];

      const result = await recordCollectedUsage(deps, {
        ...baseParams,
        collectedUsage,
      });

      expect(mockSpendStructuredTokens).toHaveBeenCalledTimes(1);
      expect(mockSpendTokens).not.toHaveBeenCalled();
      expect(mockSpendStructuredTokens).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-3' }),
        {
          promptTokens: { input: 100, write: 25, read: 15 },
          completionTokens: 50,
        },
      );
      expect(result?.input_tokens).toBe(140);
    });
  });

  describe('reasoning token handling - issue #13006', () => {
    it('uses total - input when output_tokens undercounts (Vertex stream undercount with details present)', async () => {
      const collectedUsage: UsageMetadata[] = [
        {
          input_tokens: 80657,
          output_tokens: 766,
          total_tokens: 83265,
          output_token_details: { reasoning: 1842 },
          model: 'gemini-3-flash-preview',
          provider: 'vertexai',
        },
      ];

      const result = await recordCollectedUsage(deps, {
        ...baseParams,
        collectedUsage,
      });

      expect(mockSpendTokens).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gemini-3-flash-preview' }),
        { promptTokens: 80657, completionTokens: 2608 },
      );
      expect(result?.output_tokens).toBe(2608);
    });

    it('uses total - input even when output_token_details is missing (raw langchain google-common path)', async () => {
      const collectedUsage: UsageMetadata[] = [
        {
          input_tokens: 12,
          output_tokens: 135,
          total_tokens: 309,
          model: 'gemini-3-flash-preview',
          provider: 'vertexai',
        },
      ];

      const result = await recordCollectedUsage(deps, {
        ...baseParams,
        collectedUsage,
      });

      expect(mockSpendTokens).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gemini-3-flash-preview' }),
        { promptTokens: 12, completionTokens: 297 },
      );
      expect(result?.output_tokens).toBe(297);
    });

    it('does not change output when invariant already holds (OpenAI o-series, reasoning already a subset)', async () => {
      const collectedUsage: UsageMetadata[] = [
        {
          input_tokens: 100,
          output_tokens: 500,
          total_tokens: 600,
          output_token_details: { reasoning: 200 },
          model: 'o1-preview',
          provider: 'openAI',
        },
      ];

      const result = await recordCollectedUsage(deps, {
        ...baseParams,
        collectedUsage,
      });

      expect(mockSpendTokens).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'o1-preview' }),
        { promptTokens: 100, completionTokens: 500 },
      );
      expect(result?.output_tokens).toBe(500);
    });

    it('routes correction through structured spend when cache tokens are present', async () => {
      const collectedUsage: UsageMetadata[] = [
        {
          input_tokens: 80657,
          output_tokens: 766,
          total_tokens: 83265,
          output_token_details: { reasoning: 1842 },
          input_token_details: { cache_read: 30000 },
          model: 'gemini-3-flash-preview',
          provider: 'vertexai',
        },
      ];

      await recordCollectedUsage(deps, {
        ...baseParams,
        collectedUsage,
      });

      expect(mockSpendStructuredTokens).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gemini-3-flash-preview' }),
        {
          promptTokens: { input: 50657, write: 0, read: 30000 },
          completionTokens: 2608,
        },
      );
    });

    it('no-op when total_tokens is absent or zero', async () => {
      const collectedUsage: UsageMetadata[] = [
        {
          input_tokens: 100,
          output_tokens: 50,
          model: 'gpt-4',
          provider: 'openAI',
        },
      ];

      const result = await recordCollectedUsage(deps, {
        ...baseParams,
        collectedUsage,
      });

      expect(mockSpendTokens).toHaveBeenCalledWith(expect.anything(), {
        promptTokens: 100,
        completionTokens: 50,
      });
      expect(result?.output_tokens).toBe(50);
    });
  });

  describe('mixed cache and non-cache entries', () => {
    it('should handle mixed entries correctly', async () => {
      const collectedUsage: UsageMetadata[] = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
        {
          input_tokens: 150,
          output_tokens: 30,
          model: 'gpt-4',
          input_token_details: { cache_creation: 10, cache_read: 5 },
        },
        { input_tokens: 200, output_tokens: 20, model: 'gpt-4' },
      ];

      const result = await recordCollectedUsage(deps, {
        ...baseParams,
        collectedUsage,
      });

      expect(mockSpendTokens).toHaveBeenCalledTimes(2);
      expect(mockSpendStructuredTokens).toHaveBeenCalledTimes(1);
      expect(result?.output_tokens).toBe(100); // 50 + 30 + 20
    });
  });

  describe('model fallback', () => {
    it('should use usage.model when available', async () => {
      const collectedUsage: UsageMetadata[] = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4-turbo' },
      ];

      await recordCollectedUsage(deps, {
        ...baseParams,
        model: 'fallback-model',
        collectedUsage,
      });

      expect(mockSpendTokens).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-4-turbo' }),
        expect.any(Object),
      );
    });

    it('should fallback to param model when usage.model is missing', async () => {
      const collectedUsage: UsageMetadata[] = [{ input_tokens: 100, output_tokens: 50 }];

      await recordCollectedUsage(deps, {
        ...baseParams,
        model: 'param-model',
        collectedUsage,
      });

      expect(mockSpendTokens).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'param-model' }),
        expect.any(Object),
      );
    });
  });

  describe('real-world scenarios', () => {
    it('should correctly sum output tokens for sequential tool calls with growing context', async () => {
      const collectedUsage: UsageMetadata[] = [
        { input_tokens: 31596, output_tokens: 151, model: 'claude-opus' },
        { input_tokens: 35368, output_tokens: 150, model: 'claude-opus' },
        { input_tokens: 58362, output_tokens: 295, model: 'claude-opus' },
        { input_tokens: 112604, output_tokens: 193, model: 'claude-opus' },
        { input_tokens: 257440, output_tokens: 2217, model: 'claude-opus' },
      ];

      const result = await recordCollectedUsage(deps, {
        ...baseParams,
        collectedUsage,
      });

      expect(result?.input_tokens).toBe(31596);
      expect(result?.output_tokens).toBe(3006); // 151 + 150 + 295 + 193 + 2217
      expect(mockSpendTokens).toHaveBeenCalledTimes(5);
    });

    it('should handle cache tokens with multiple tool calls', async () => {
      /** Cache-inclusive Anthropic wire: input_tokens = fresh + write + read. */
      const collectedUsage: UsageMetadata[] = [
        {
          input_tokens: 31596, // 788 fresh + 30808 write
          output_tokens: 163,
          model: 'claude-opus',
          provider: 'anthropic',
          input_token_details: { cache_read: 0, cache_creation: 30808 },
        },
        {
          input_tokens: 35378, // 3802 fresh + 30808 read + 768 write
          output_tokens: 149,
          model: 'claude-opus',
          provider: 'anthropic',
          input_token_details: { cache_read: 30808, cache_creation: 768 },
        },
        {
          input_tokens: 58384, // 26808 fresh + 31576 read
          output_tokens: 225,
          model: 'claude-opus',
          provider: 'anthropic',
          input_token_details: { cache_read: 31576, cache_creation: 0 },
        },
      ];

      const result = await recordCollectedUsage(deps, {
        ...baseParams,
        collectedUsage,
      });

      // input_tokens = total prompt of first call (cache-inclusive)
      expect(result?.input_tokens).toBe(31596);
      // output_tokens = 163 + 149 + 225 = 537
      expect(result?.output_tokens).toBe(537);
      expect(mockSpendStructuredTokens).toHaveBeenCalledTimes(3);
      expect(mockSpendTokens).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should catch and log errors from spendTokens without throwing', async () => {
      mockSpendTokens.mockRejectedValue(new Error('DB error'));

      const collectedUsage: UsageMetadata[] = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
      ];

      const result = await recordCollectedUsage(deps, {
        ...baseParams,
        collectedUsage,
      });

      expect(result).toEqual({ input_tokens: 100, output_tokens: 50 });
    });

    it('should catch and log errors from spendStructuredTokens without throwing', async () => {
      mockSpendStructuredTokens.mockRejectedValue(new Error('DB error'));

      const collectedUsage: UsageMetadata[] = [
        {
          input_tokens: 100,
          output_tokens: 50,
          model: 'gpt-4',
          provider: 'openAI',
          input_token_details: { cache_creation: 20, cache_read: 10 },
        },
      ];

      const result = await recordCollectedUsage(deps, {
        ...baseParams,
        collectedUsage,
      });

      // openAI is a subset provider → input_tokens already includes cache
      expect(result).toEqual({ input_tokens: 100, output_tokens: 50 });
    });
  });

  describe('transaction metadata', () => {
    it('should pass all metadata fields to spend functions', async () => {
      const collectedUsage: UsageMetadata[] = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
      ];

      const endpointTokenConfig = { 'gpt-4': { prompt: 0.01, completion: 0.03, context: 8192 } };

      await recordCollectedUsage(deps, {
        ...baseParams,
        messageId: 'msg-123',
        endpointTokenConfig,
        collectedUsage,
      });

      expect(mockSpendTokens).toHaveBeenCalledWith(
        {
          user: 'user-123',
          conversationId: 'convo-123',
          model: 'gpt-4',
          context: 'message',
          messageId: 'msg-123',
          balance: { enabled: true },
          transactions: { enabled: true },
          endpointTokenConfig,
        },
        { promptTokens: 100, completionTokens: 50 },
      );
    });

    it('prices each usage with its agent endpoint config (multi-endpoint graph)', async () => {
      /** Two endpoints share a model id but bill at different rates. */
      const primaryConfig = { 'shared-model': { prompt: 0.01, completion: 0.03, context: 8192 } };
      const subagentConfig = { 'shared-model': { prompt: 0.05, completion: 0.15, context: 8192 } };
      const byAgent: Record<string, typeof primaryConfig> = {
        primary: primaryConfig,
        sub: subagentConfig,
      };
      const collectedUsage: UsageMetadata[] = [
        {
          usage_type: 'message',
          agentId: 'primary',
          input_tokens: 100,
          output_tokens: 50,
          model: 'shared-model',
        },
        {
          usage_type: 'subagent',
          agentId: 'sub',
          input_tokens: 200,
          output_tokens: 80,
          model: 'shared-model',
        },
      ];

      await recordCollectedUsage(deps, {
        ...baseParams,
        collectedUsage,
        endpointTokenConfig: primaryConfig,
        resolveEndpointTokenConfig: (usage) =>
          usage.agentId != null ? byAgent[usage.agentId] : undefined,
      });

      expect(mockSpendTokens).toHaveBeenCalledWith(
        expect.objectContaining({
          context: 'message',
          model: 'shared-model',
          endpointTokenConfig: primaryConfig,
        }),
        { promptTokens: 100, completionTokens: 50 },
      );
      expect(mockSpendTokens).toHaveBeenCalledWith(
        expect.objectContaining({
          context: 'subagent',
          model: 'shared-model',
          endpointTokenConfig: subagentConfig,
        }),
        { promptTokens: 200, completionTokens: 80 },
      );
    });

    it('trusts the resolver result, including undefined (built-in pricing for known agents)', async () => {
      const batch = { 'gpt-4': { prompt: 0.01, completion: 0.03, context: 8192 } };
      await recordCollectedUsage(deps, {
        ...baseParams,
        collectedUsage: [
          { agentId: 'known-openai', input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
        ],
        endpointTokenConfig: batch,
        /** A known agent with no configured rates: the resolver returns undefined
         *  and the billing path must honor it (built-in pricing), NOT re-apply
         *  the batch/primary config. */
        resolveEndpointTokenConfig: () => undefined,
      });

      expect(mockSpendTokens).toHaveBeenCalledWith(
        expect.objectContaining({ endpointTokenConfig: undefined }),
        { promptTokens: 100, completionTokens: 50 },
      );
    });

    it('should use default context "message" when not provided', async () => {
      const collectedUsage: UsageMetadata[] = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
      ];

      await recordCollectedUsage(deps, {
        user: 'user-123',
        conversationId: 'convo-123',
        collectedUsage,
      });

      expect(mockSpendTokens).toHaveBeenCalledWith(
        expect.objectContaining({ context: 'message' }),
        expect.any(Object),
      );
    });

    it('should allow custom context like "title"', async () => {
      const collectedUsage: UsageMetadata[] = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
      ];

      await recordCollectedUsage(deps, {
        ...baseParams,
        context: 'title',
        collectedUsage,
      });

      expect(mockSpendTokens).toHaveBeenCalledWith(
        expect.objectContaining({ context: 'title' }),
        expect.any(Object),
      );
    });
  });

  describe('messageId propagation', () => {
    it('should pass messageId to spendTokens', async () => {
      const collectedUsage: UsageMetadata[] = [
        { input_tokens: 10, output_tokens: 5, model: 'gpt-4' },
      ];

      await recordCollectedUsage(deps, {
        ...baseParams,
        messageId: 'msg-1',
        collectedUsage,
      });

      expect(mockSpendTokens).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'msg-1' }),
        expect.any(Object),
      );
    });

    it('should pass messageId to spendStructuredTokens for cache paths', async () => {
      const collectedUsage: UsageMetadata[] = [
        {
          input_tokens: 100,
          output_tokens: 50,
          model: 'claude-3',
          cache_creation_input_tokens: 25,
          cache_read_input_tokens: 15,
        },
      ];

      await recordCollectedUsage(deps, {
        ...baseParams,
        messageId: 'msg-cache-1',
        collectedUsage,
      });

      expect(mockSpendStructuredTokens).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'msg-cache-1' }),
        expect.any(Object),
      );
      expect(mockSpendTokens).not.toHaveBeenCalled();
    });

    it('should pass undefined messageId when not provided', async () => {
      const collectedUsage: UsageMetadata[] = [
        { input_tokens: 10, output_tokens: 5, model: 'gpt-4' },
      ];

      await recordCollectedUsage(deps, {
        user: 'user-123',
        conversationId: 'convo-123',
        collectedUsage,
      });

      expect(mockSpendTokens).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: undefined }),
        expect.any(Object),
      );
    });

    it('should propagate messageId across multiple usage entries', async () => {
      const collectedUsage: UsageMetadata[] = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
        { input_tokens: 200, output_tokens: 60, model: 'gpt-4' },
        {
          input_tokens: 150,
          output_tokens: 30,
          model: 'gpt-4',
          input_token_details: { cache_creation: 10, cache_read: 5 },
        },
      ];

      await recordCollectedUsage(deps, {
        ...baseParams,
        messageId: 'msg-multi',
        collectedUsage,
      });

      expect(mockSpendTokens).toHaveBeenCalledTimes(2);
      expect(mockSpendStructuredTokens).toHaveBeenCalledTimes(1);

      for (const call of mockSpendTokens.mock.calls) {
        expect(call[0]).toEqual(expect.objectContaining({ messageId: 'msg-multi' }));
      }
      expect(mockSpendStructuredTokens.mock.calls[0][0]).toEqual(
        expect.objectContaining({ messageId: 'msg-multi' }),
      );
    });
  });

  describe('bulk write path', () => {
    let mockInsertMany: jest.Mock;
    let mockUpdateBalance: jest.Mock;
    let mockPricing: PricingFns;
    let mockBulkWriteOps: BulkWriteDeps;
    let bulkDeps: RecordUsageDeps;

    beforeEach(() => {
      mockInsertMany = jest.fn().mockResolvedValue(undefined);
      mockUpdateBalance = jest.fn().mockResolvedValue({});
      mockPricing = {
        getMultiplier: jest.fn().mockReturnValue(1),
        getCacheMultiplier: jest.fn().mockReturnValue(null),
      };
      mockBulkWriteOps = {
        insertMany: mockInsertMany,
        updateBalance: mockUpdateBalance,
      };
      bulkDeps = {
        spendTokens: mockSpendTokens,
        spendStructuredTokens: mockSpendStructuredTokens,
        pricing: mockPricing,
        bulkWriteOps: mockBulkWriteOps,
      };
    });

    it('should use bulk path when pricing and bulkWriteOps are provided', async () => {
      const collectedUsage: UsageMetadata[] = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
      ];

      const result = await recordCollectedUsage(bulkDeps, {
        ...baseParams,
        collectedUsage,
      });

      expect(mockInsertMany).toHaveBeenCalledTimes(1);
      expect(mockSpendTokens).not.toHaveBeenCalled();
      expect(mockSpendStructuredTokens).not.toHaveBeenCalled();
      expect(result).toEqual({ input_tokens: 100, output_tokens: 50 });
    });

    it('should batch all entries into a single insertMany call', async () => {
      const collectedUsage: UsageMetadata[] = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
        { input_tokens: 200, output_tokens: 60, model: 'gpt-4' },
        { input_tokens: 300, output_tokens: 70, model: 'gpt-4' },
      ];

      await recordCollectedUsage(bulkDeps, {
        ...baseParams,
        collectedUsage,
      });

      expect(mockInsertMany).toHaveBeenCalledTimes(1);
      const insertedDocs = mockInsertMany.mock.calls[0][0];
      expect(insertedDocs.length).toBe(6); // 2 per entry (prompt + completion)
    });

    it('should call updateBalance once when balance is enabled', async () => {
      const collectedUsage: UsageMetadata[] = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
        { input_tokens: 200, output_tokens: 60, model: 'gpt-4' },
      ];

      await recordCollectedUsage(bulkDeps, {
        ...baseParams,
        balance: { enabled: true },
        collectedUsage,
      });

      expect(mockUpdateBalance).toHaveBeenCalledTimes(1);
      expect(mockUpdateBalance).toHaveBeenCalledWith(
        expect.objectContaining({
          user: 'user-123',
          incrementValue: expect.any(Number),
        }),
      );
    });

    it('should not call updateBalance when balance is disabled', async () => {
      const collectedUsage: UsageMetadata[] = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
      ];

      await recordCollectedUsage(bulkDeps, {
        ...baseParams,
        balance: { enabled: false },
        collectedUsage,
      });

      expect(mockInsertMany).toHaveBeenCalledTimes(1);
      expect(mockUpdateBalance).not.toHaveBeenCalled();
    });

    it('should handle cache tokens via bulk path', async () => {
      const collectedUsage: UsageMetadata[] = [
        {
          input_tokens: 100,
          output_tokens: 50,
          model: 'gpt-4',
          input_token_details: { cache_creation: 20, cache_read: 10 },
        },
      ];

      const result = await recordCollectedUsage(bulkDeps, {
        ...baseParams,
        collectedUsage,
      });

      expect(mockInsertMany).toHaveBeenCalledTimes(1);
      expect(mockSpendStructuredTokens).not.toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('should handle mixed cache and non-cache entries in bulk', async () => {
      const collectedUsage: UsageMetadata[] = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
        {
          input_tokens: 150,
          output_tokens: 30,
          model: 'gpt-4',
          input_token_details: { cache_creation: 10, cache_read: 5 },
        },
      ];

      const result = await recordCollectedUsage(bulkDeps, {
        ...baseParams,
        collectedUsage,
      });

      expect(mockInsertMany).toHaveBeenCalledTimes(1);
      expect(mockSpendTokens).not.toHaveBeenCalled();
      expect(mockSpendStructuredTokens).not.toHaveBeenCalled();
      expect(result?.output_tokens).toBe(80);
    });

    it('should fall back to legacy path when pricing is missing', async () => {
      const legacyDeps: RecordUsageDeps = {
        spendTokens: mockSpendTokens,
        spendStructuredTokens: mockSpendStructuredTokens,
        bulkWriteOps: mockBulkWriteOps,
        // no pricing
      };

      const collectedUsage: UsageMetadata[] = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
      ];

      await recordCollectedUsage(legacyDeps, {
        ...baseParams,
        collectedUsage,
      });

      expect(mockSpendTokens).toHaveBeenCalledTimes(1);
      expect(mockInsertMany).not.toHaveBeenCalled();
    });

    it('should fall back to legacy path when bulkWriteOps is missing', async () => {
      const legacyDeps: RecordUsageDeps = {
        spendTokens: mockSpendTokens,
        spendStructuredTokens: mockSpendStructuredTokens,
        pricing: mockPricing,
        // no bulkWriteOps
      };

      const collectedUsage: UsageMetadata[] = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
      ];

      await recordCollectedUsage(legacyDeps, {
        ...baseParams,
        collectedUsage,
      });

      expect(mockSpendTokens).toHaveBeenCalledTimes(1);
      expect(mockInsertMany).not.toHaveBeenCalled();
    });

    it('should handle errors in bulk write gracefully', async () => {
      mockInsertMany.mockRejectedValue(new Error('DB error'));

      const collectedUsage: UsageMetadata[] = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
      ];

      const result = await recordCollectedUsage(bulkDeps, {
        ...baseParams,
        collectedUsage,
      });

      expect(result).toEqual({ input_tokens: 100, output_tokens: 50 });
    });
  });

  describe('Bedrock prompt caching — completion token inflation regression', () => {
    it('does not fold cache_creation into completion on the first cached step', async () => {
      // Bedrock: total = input + output + cache_creation (additive, not subset).
      // Before fix: resolveCompletionTokens returned output + cache_creation (5500)
      // instead of output (500).
      const collectedUsage: UsageMetadata[] = [
        {
          input_tokens: 100,
          output_tokens: 500,
          total_tokens: 5600,
          cache_creation_input_tokens: 5000,
          cache_read_input_tokens: 0,
          model: 'claude-sonnet-4-6',
        },
      ];

      const result = await recordCollectedUsage(deps, { ...baseParams, collectedUsage });

      expect(mockSpendStructuredTokens).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-sonnet-4-6' }),
        {
          promptTokens: { input: 100, write: 5000, read: 0 },
          completionTokens: 500,
        },
      );
      expect(result?.output_tokens).toBe(500);
    });

    it('does not fold cache_read into completion on subsequent cached steps', async () => {
      // Bedrock: total = input + output + cache_read on every read step.
      // Before fix: each step returned output + cache_read instead of output.
      const collectedUsage: UsageMetadata[] = [
        {
          input_tokens: 200,
          output_tokens: 300,
          total_tokens: 4500,
          cache_read_input_tokens: 4000,
          cache_creation_input_tokens: 0,
          model: 'claude-sonnet-4-6',
        },
      ];

      const result = await recordCollectedUsage(deps, { ...baseParams, collectedUsage });

      expect(mockSpendStructuredTokens).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-sonnet-4-6' }),
        {
          promptTokens: { input: 200, write: 0, read: 4000 },
          completionTokens: 300,
        },
      );
      expect(result?.output_tokens).toBe(300);
    });

    it('handles cache tokens in input_token_details format (alternate field path)', async () => {
      const collectedUsage: UsageMetadata[] = [
        {
          input_tokens: 200,
          output_tokens: 300,
          total_tokens: 4500,
          input_token_details: { cache_read: 4000, cache_creation: 0 },
          model: 'claude-sonnet-4-6',
        },
      ];

      const result = await recordCollectedUsage(deps, { ...baseParams, collectedUsage });

      expect(result?.output_tokens).toBe(300);
    });

    it('accumulates only true output across a multi-step cached agent run', async () => {
      // 1 write step + 4 read steps. Without the fix, each step folds its
      // cache tokens into completion, inflating the total by the full cache size.
      const writeStep: UsageMetadata = {
        input_tokens: 100,
        output_tokens: 500,
        total_tokens: 5600,
        cache_creation_input_tokens: 5000,
        cache_read_input_tokens: 0,
        model: 'claude-sonnet-4-6',
      };
      const readSteps: UsageMetadata[] = Array.from({ length: 4 }, (_, i) => ({
        input_tokens: 200,
        output_tokens: 300 + i * 50,
        total_tokens: 200 + (300 + i * 50) + 5000,
        cache_read_input_tokens: 5000,
        cache_creation_input_tokens: 0,
        model: 'claude-sonnet-4-6',
      }));

      const result = await recordCollectedUsage(deps, {
        ...baseParams,
        collectedUsage: [writeStep, ...readSteps],
      });

      // True output: 500 + 300 + 350 + 400 + 450 = 2000
      const trueOutput = 500 + readSteps.reduce((sum, s) => sum + (s.output_tokens ?? 0), 0);
      expect(result?.output_tokens).toBe(trueOutput);
    });
  });

  describe('bulk write with summarization usage', () => {
    let mockInsertMany: jest.Mock;
    let mockUpdateBalance: jest.Mock;
    let mockPricing: PricingFns;
    let mockBulkWriteOps: BulkWriteDeps;
    let bulkDeps: RecordUsageDeps;

    beforeEach(() => {
      mockInsertMany = jest.fn().mockResolvedValue(undefined);
      mockUpdateBalance = jest.fn().mockResolvedValue({});
      mockPricing = {
        getMultiplier: jest.fn().mockReturnValue(1),
        getCacheMultiplier: jest.fn().mockReturnValue(null),
      };
      mockBulkWriteOps = {
        insertMany: mockInsertMany,
        updateBalance: mockUpdateBalance,
      };
      bulkDeps = {
        spendTokens: mockSpendTokens,
        spendStructuredTokens: mockSpendStructuredTokens,
        pricing: mockPricing,
        bulkWriteOps: mockBulkWriteOps,
      };
    });

    it('combines message and summarization docs into a single bulk write', async () => {
      const collectedUsage: UsageMetadata[] = [
        {
          usage_type: 'message',
          input_tokens: 200,
          output_tokens: 80,
          model: 'gpt-4',
        },
        {
          usage_type: 'summarization',
          input_tokens: 50,
          output_tokens: 20,
          model: 'gpt-4.1-mini',
        },
      ];

      const result = await recordCollectedUsage(bulkDeps, {
        ...baseParams,
        collectedUsage,
      });

      expect(mockInsertMany).toHaveBeenCalledTimes(1);
      expect(mockUpdateBalance).toHaveBeenCalledTimes(1);
      expect(mockSpendTokens).not.toHaveBeenCalled();
      expect(mockSpendStructuredTokens).not.toHaveBeenCalled();

      const insertedDocs = mockInsertMany.mock.calls[0][0];
      // 2 docs per entry (prompt + completion) x 2 entries = 4 docs
      expect(insertedDocs).toHaveLength(4);

      const messageContextDocs = insertedDocs.filter(
        (d: Record<string, unknown>) => d.context === 'message',
      );
      const summarizationContextDocs = insertedDocs.filter(
        (d: Record<string, unknown>) => d.context === 'summarization',
      );
      expect(messageContextDocs).toHaveLength(2);
      expect(summarizationContextDocs).toHaveLength(2);

      expect(result).toEqual({ input_tokens: 200, output_tokens: 100 });
    });

    it('handles summarization-only usage in bulk mode', async () => {
      const collectedUsage: UsageMetadata[] = [
        {
          usage_type: 'summarization',
          input_tokens: 60,
          output_tokens: 25,
          model: 'gpt-4.1-mini',
        },
      ];

      const result = await recordCollectedUsage(bulkDeps, {
        ...baseParams,
        collectedUsage,
      });

      expect(mockInsertMany).toHaveBeenCalledTimes(1);
      expect(mockSpendTokens).not.toHaveBeenCalled();
      expect(mockSpendStructuredTokens).not.toHaveBeenCalled();

      const insertedDocs = mockInsertMany.mock.calls[0][0];
      expect(insertedDocs).toHaveLength(2);

      const summarizationContextDocs = insertedDocs.filter(
        (d: Record<string, unknown>) => d.context === 'summarization',
      );
      expect(summarizationContextDocs).toHaveLength(2);

      expect(result).toEqual({ input_tokens: 0, output_tokens: 25 });
    });

    it('handles message-only usage in bulk mode', async () => {
      const collectedUsage: UsageMetadata[] = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
        { input_tokens: 200, output_tokens: 60, model: 'gpt-4' },
      ];

      const result = await recordCollectedUsage(bulkDeps, {
        ...baseParams,
        collectedUsage,
      });

      expect(mockInsertMany).toHaveBeenCalledTimes(1);
      expect(mockSpendTokens).not.toHaveBeenCalled();
      expect(mockSpendStructuredTokens).not.toHaveBeenCalled();

      const insertedDocs = mockInsertMany.mock.calls[0][0];
      // 2 docs per entry x 2 entries = 4 docs
      expect(insertedDocs).toHaveLength(4);

      const messageContextDocs = insertedDocs.filter(
        (d: Record<string, unknown>) => d.context === 'message',
      );
      expect(messageContextDocs).toHaveLength(4);

      expect(result).toEqual({ input_tokens: 100, output_tokens: 110 });
    });
  });
});

describe('createSubagentUsageSink', () => {
  const makeEvent = (overrides: Partial<SubagentUsageEvent> = {}): SubagentUsageEvent => ({
    usage: { input_tokens: 900, output_tokens: 700, total_tokens: 1600 },
    model: 'claude-haiku-4-5',
    provider: 'anthropic',
    subagentType: 'researcher',
    subagentRunId: 'run-1_sub_abc',
    subagentAgentId: 'researcher',
    runId: 'run-1',
    ...overrides,
  });

  it('pushes usage tagged with usage_type subagent and the child model/provider', () => {
    const collectedUsage: UsageMetadata[] = [];
    const sink = createSubagentUsageSink(collectedUsage);

    sink(makeEvent());

    expect(collectedUsage).toEqual([
      {
        usage_type: 'subagent',
        input_tokens: 900,
        output_tokens: 700,
        total_tokens: 1600,
        model: 'claude-haiku-4-5',
        provider: 'anthropic',
        agentId: 'researcher',
      },
    ]);
  });

  it('tags the child agent id so the host can price with the subagent endpoint config', () => {
    const collectedUsage: UsageMetadata[] = [];
    const emitted: UsageMetadata[] = [];
    const sink = createSubagentUsageSink(collectedUsage, (u) => {
      emitted.push(u);
    });

    sink(makeEvent({ subagentAgentId: 'agent_xyz' }));

    expect(collectedUsage[0].agentId).toBe('agent_xyz');
    /** The same tagged object is handed to onUsage (the live emitter). */
    expect(emitted[0]).toBe(collectedUsage[0]);
    expect(emitted[0].agentId).toBe('agent_xyz');
  });

  it('prices graph usage with the member agent instead of the synthetic execution subject', () => {
    const collectedUsage: UsageMetadata[] = [];
    const sink = createSubagentUsageSink(collectedUsage);

    sink(
      makeEvent({
        subagentKind: 'graph',
        subagentAgentId: 'graph:research_team',
        memberAgentId: 'agent_writer',
      }),
    );

    expect(collectedUsage[0].agentId).toBe('agent_writer');
  });

  it('falls back to the execution subject when the member agent id is empty', () => {
    const collectedUsage: UsageMetadata[] = [];
    const sink = createSubagentUsageSink(collectedUsage);

    sink(makeEvent({ subagentAgentId: 'agent_researcher', memberAgentId: '' }));

    expect(collectedUsage[0].agentId).toBe('agent_researcher');
  });

  it('preserves cache token details from the child call', () => {
    const collectedUsage: UsageMetadata[] = [];
    const sink = createSubagentUsageSink(collectedUsage);

    sink(
      makeEvent({
        usage: {
          input_tokens: 200,
          output_tokens: 80,
          total_tokens: 280,
          input_token_details: { cache_creation: 60, cache_read: 30 },
        } as SubagentUsageEvent['usage'],
      }),
    );

    expect(collectedUsage[0].input_token_details).toEqual({
      cache_creation: 60,
      cache_read: 30,
    });
  });

  it('omits model/provider tags when the event carries none', () => {
    const collectedUsage: UsageMetadata[] = [];
    const sink = createSubagentUsageSink(collectedUsage);

    sink(makeEvent({ model: undefined, provider: undefined }));

    expect(collectedUsage).toHaveLength(1);
    expect(collectedUsage[0].usage_type).toBe('subagent');
    expect(collectedUsage[0]).not.toHaveProperty('model');
    expect(collectedUsage[0]).not.toHaveProperty('provider');
  });

  it('ignores events without usage', () => {
    const collectedUsage: UsageMetadata[] = [];
    const sink = createSubagentUsageSink(collectedUsage);

    sink(makeEvent({ usage: undefined as unknown as SubagentUsageEvent['usage'] }));

    expect(collectedUsage).toEqual([]);
  });

  it('routes detached usage to its awaited billing and durable child collectors', async () => {
    const collectedUsage: UsageMetadata[] = [];
    const detachedUsage: UsageMetadata[] = [];
    const emitted: UsageMetadata[] = [];
    const recordDetachedUsage = jest.fn().mockResolvedValue(undefined);
    const sink = createSubagentUsageSink(
      collectedUsage,
      (usage) => {
        emitted.push(usage);
      },
      recordDetachedUsage,
    );

    await runWithDetachedSubagentUsage(detachedUsage, async () => {
      await sink(makeEvent());
    });

    expect(collectedUsage).toEqual([]);
    expect(detachedUsage).toHaveLength(1);
    expect(emitted[0]).toBe(detachedUsage[0]);
    expect(recordDetachedUsage).toHaveBeenCalledWith(detachedUsage[0]);

    /** The same sink still batches ordinary foreground subagents with the parent. */
    await sink(makeEvent({ subagentRunId: 'foreground-child' }));
    expect(collectedUsage).toHaveLength(1);
    expect(recordDetachedUsage).toHaveBeenCalledTimes(1);
  });

  it('still records detached usage when the auxiliary emitter throws', async () => {
    const collectedUsage: UsageMetadata[] = [];
    const detachedUsage: UsageMetadata[] = [];
    const recordDetachedUsage = jest.fn().mockResolvedValue(undefined);
    const sink = createSubagentUsageSink(
      collectedUsage,
      () => {
        throw new Error('parent transport was disposed');
      },
      recordDetachedUsage,
    );

    await runWithDetachedSubagentUsage(detachedUsage, async () => {
      await sink(makeEvent());
    });

    expect(collectedUsage).toEqual([]);
    expect(detachedUsage).toHaveLength(1);
    expect(recordDetachedUsage).toHaveBeenCalledWith(detachedUsage[0]);
  });

  it('round-trips into recordCollectedUsage as billed subagent transactions', async () => {
    const collectedUsage: UsageMetadata[] = [];
    const sink = createSubagentUsageSink(collectedUsage);

    /** Parent's own call, collected by ModelEndHandler as usual. */
    collectedUsage.push({ input_tokens: 120, output_tokens: 40, model: 'gpt-4' });
    /** Child calls reported through the sink mid-run. */
    sink(makeEvent());
    sink(
      makeEvent({
        usage: { input_tokens: 1100, output_tokens: 300, total_tokens: 1400 },
      }),
    );

    const spendTokens = jest.fn().mockResolvedValue(undefined);
    const spendStructuredTokens = jest.fn().mockResolvedValue(undefined);
    const result = await recordCollectedUsage(
      { spendTokens, spendStructuredTokens },
      {
        user: 'user-123',
        conversationId: 'convo-123',
        model: 'gpt-4',
        collectedUsage,
      },
    );

    /** All three calls billed; child output excluded from reported totals. */
    expect(spendTokens).toHaveBeenCalledTimes(3);
    expect(spendTokens).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ context: 'subagent', model: 'claude-haiku-4-5' }),
      { promptTokens: 900, completionTokens: 700 },
    );
    expect(result).toEqual({ input_tokens: 120, output_tokens: 40 });
  });
});

describe('computeUsageCostUSD', () => {
  /** Stub pricing: base prompt 3 / completion 15, cache write 3.75 / read 0.3;
   *  a premium tier above 200k input prompt tokens (8 / 40). Mirrors the
   *  shape of the real getMultiplier(inputTokenCount) premium switch. */
  const pricing: PricingFns = {
    getMultiplier: ({ tokenType, inputTokenCount }) => {
      const premium = (inputTokenCount ?? 0) > 200000;
      if (tokenType === 'completion') {
        return premium ? 40 : 15;
      }
      return premium ? 8 : 3;
    },
    getCacheMultiplier: ({ cacheType }) => (cacheType === 'write' ? 3.75 : 0.3),
  };

  it('prices a standard call at base rates', () => {
    const cost = computeUsageCostUSD(
      { input_tokens: 1000, output_tokens: 500, model: 'gpt-4', provider: 'openAI' },
      pricing,
    );
    expect(cost).toBeCloseTo((1000 * 3 + 500 * 15) / 1e6);
  });

  it('applies the premium tier when the call exceeds the input threshold', () => {
    /** The exact gap finding A flagged: a long-context call bills premium */
    const cost = computeUsageCostUSD(
      { input_tokens: 300000, output_tokens: 1000, model: 'gpt-5.5', provider: 'openAI' },
      pricing,
    );
    expect(cost).toBeCloseTo((300000 * 8 + 1000 * 40) / 1e6);
  });

  it('prices cache-inclusive Anthropic input by subtracting cache, then cache at its own rates', () => {
    /** input_tokens is cache-inclusive (13000 = 1000 fresh + 2000 write + 10000
     *  read). The fresh 1000 is billed at the input rate, the cache at its own
     *  rates — never the cache portion at the input rate too (LibreChat#13795). */
    const cost = computeUsageCostUSD(
      {
        input_tokens: 13000,
        output_tokens: 500,
        model: 'claude-haiku-4-5',
        provider: 'anthropic',
        input_token_details: { cache_creation: 2000, cache_read: 10000 },
      },
      pricing,
    );
    expect(cost).toBeCloseTo((1000 * 3 + 2000 * 3.75 + 10000 * 0.3 + 500 * 15) / 1e6);
  });

  it('routes nested cache_write_tokens to the write bucket, not the input rate', () => {
    /** OpenAI GPT-5.6 reports cache writes as `cache_write_tokens`. Those 2000
     *  tokens must bill at the write rate (3.75), not fold into input (3);
     *  inputOnly = 13000 - 2000 write - 10000 read = 1000. */
    const cost = computeUsageCostUSD(
      {
        input_tokens: 13000,
        output_tokens: 500,
        model: 'gpt-5.6',
        provider: 'openAI',
        input_token_details: { cache_read: 10000, cache_write_tokens: 2000 },
      },
      pricing,
    );
    expect(cost).toBeCloseTo((1000 * 3 + 2000 * 3.75 + 10000 * 0.3 + 500 * 15) / 1e6);
  });

  it('routes top-level cache_write_tokens to the write bucket alongside the premium input tier', () => {
    /** Top-level `cache_write_tokens` (Chat/Responses flattened shape) is also
     *  recognized; inputOnly = 280000 - 5000 - 15000 = 260000, above the premium
     *  threshold so input/completion price at the premium tier (8 / 40). */
    const cost = computeUsageCostUSD(
      {
        input_tokens: 280000,
        output_tokens: 500,
        model: 'gpt-5.6',
        provider: 'openAI',
        input_token_details: { cache_read: 15000 },
        cache_write_tokens: 5000,
      },
      pricing,
    );
    expect(cost).toBeCloseTo((260000 * 8 + 5000 * 3.75 + 15000 * 0.3 + 500 * 40) / 1e6);
  });
});

describe('aggregateEmittedUsage', () => {
  it('returns null for no emitted events', () => {
    expect(aggregateEmittedUsage([])).toBeNull();
  });

  it('normalizes each call into display units (input excludes cache) and sums cost', () => {
    const events: TTokenUsageEvent[] = [
      {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        model: 'gpt-4o-mini',
        provider: 'openAI',
        cost: 0.001,
      },
      {
        input_tokens: 150,
        output_tokens: 10,
        total_tokens: 160,
        input_token_details: { cache_creation: 30, cache_read: 50 },
        model: 'gpt-4o-mini',
        provider: 'openAI',
        cost: 0.002,
      },
    ];
    /** openAI is cache-subset: input excludes cache (150−30−50=70) */
    expect(aggregateEmittedUsage(events)).toEqual({
      input: 170,
      output: 30,
      cacheWrite: 30,
      cacheRead: 50,
      cost: 0.003,
    });
  });

  it('omits cost when no event carried it (contextCost off)', () => {
    const rollup = aggregateEmittedUsage([
      { input_tokens: 100, output_tokens: 20, total_tokens: 120, provider: 'openAI' },
    ]);
    expect(rollup).toEqual({ input: 100, output: 20, cacheWrite: 0, cacheRead: 0 });
    expect(rollup?.cost).toBeUndefined();
  });

  it('omits cost when any call lacked it (partial pricing failure)', () => {
    /** One call priced, one missing cost (e.g. computeUsageCostUSD threw) →
     *  the sum would under-report, so coverage is incomplete and cost omitted. */
    const rollup = aggregateEmittedUsage([
      { input_tokens: 100, output_tokens: 20, provider: 'openAI', cost: 0.01 },
      { input_tokens: 50, output_tokens: 10, provider: 'openAI' },
    ]);
    expect(rollup?.cost).toBeUndefined();
    expect(rollup?.input).toBe(150);
    expect(rollup?.output).toBe(30);
  });

  it('normalizes mixed-provider calls per their own provider before summing', () => {
    /** bedrock is additive (cache separate from input), openAI is subset */
    const rollup = aggregateEmittedUsage([
      {
        input_tokens: 100,
        output_tokens: 20,
        provider: 'bedrock',
        input_token_details: { cache_read: 40 },
        cost: 0.01,
      },
      {
        input_tokens: 90,
        output_tokens: 5,
        usage_type: 'subagent',
        provider: 'openAI',
        input_token_details: { cache_read: 30 },
        cost: 0.02,
      },
    ]);
    /** bedrock input stays 100 (additive); openAI input 90−30=60 → 160 */
    expect(rollup?.input).toBe(160);
    expect(rollup?.output).toBe(25);
    expect(rollup?.cacheRead).toBe(70);
    expect(rollup?.cost).toBeCloseTo(0.03);
  });

  it('uses the magnitude fallback for provider-less cached events (matches live)', () => {
    /** No provider: the client's normalizeUsageUnits uses a magnitude heuristic
     *  (cache ≤ input ⇒ input includes cache), so the rollup must too — billing
     *  splitUsage would treat it as additive and leave input at 1000, diverging
     *  from the live display after reload. */
    const rollup = aggregateEmittedUsage([
      { input_tokens: 1000, output_tokens: 100, input_token_details: { cache_read: 400 } },
    ]);
    expect(rollup).toEqual({ input: 600, output: 100, cacheWrite: 0, cacheRead: 400 });
  });
});

describe('buildPersistedContextUsage', () => {
  const baseSnapshot: TContextUsageEvent = {
    runId: 'run-1',
    breakdown: {
      maxContextTokens: 8000,
      instructionTokens: 100,
      systemMessageTokens: 80,
      dynamicInstructionTokens: 20,
      toolSchemaTokens: 30,
      summaryTokens: 0,
      toolCount: 2,
      messageCount: 3,
      messageTokens: 500,
      availableForMessages: 7000,
      toolTokenCounts: { add: 15, noop: 0 },
    },
    contextBudget: 7800,
  };

  it('persists positive per-tool schema counts', () => {
    const result = buildPersistedContextUsage(baseSnapshot);
    expect(result.breakdown.toolTokenCounts).toEqual({ add: 15 });
    expect(result.contextBudget).toBe(7800);
  });

  it('omits a schema-count record with no positive counts', () => {
    const result = buildPersistedContextUsage({
      ...baseSnapshot,
      breakdown: { ...baseSnapshot.breakdown, toolTokenCounts: { add: 0 } },
    });
    expect(result.breakdown.toolTokenCounts).toBeUndefined();
  });

  it('passes through a snapshot without tool counts', () => {
    const { toolTokenCounts: _omit, ...breakdown } = baseSnapshot.breakdown;
    const result = buildPersistedContextUsage({ ...baseSnapshot, breakdown });
    expect(result.breakdown.toolTokenCounts).toBeUndefined();
    expect(result.breakdown.messageTokens).toBe(500);
  });

  it('passes a non-zero toolMessageTokens split through to the blob', () => {
    const result = buildPersistedContextUsage({
      ...baseSnapshot,
      breakdown: { ...baseSnapshot.breakdown, toolMessageTokens: 220 },
    });
    expect(result.breakdown.toolMessageTokens).toBe(220);
    expect(result.breakdown.messageTokens).toBe(500);
  });

  it('keeps invocation-inclusive totals separate from per-tool result shares', () => {
    const result = buildPersistedContextUsage({
      ...baseSnapshot,
      breakdown: {
        ...baseSnapshot.breakdown,
        toolMessageTokens: 10,
        toolMessageTokenCounts: { search: 4 },
      },
    });
    expect(result.breakdown.toolMessageTokens).toBe(10);
    expect(result.breakdown.toolMessageTokenCounts).toEqual({ search: 4 });
    expect(
      Object.values(result.breakdown.toolMessageTokenCounts ?? {}).reduce(
        (total, count) => total + count,
        0,
      ),
    ).toBeLessThan(result.breakdown.toolMessageTokens ?? 0);
  });

  it('trims zero-valued result-message entries and clamps their sum', () => {
    const result = buildPersistedContextUsage({
      ...baseSnapshot,
      breakdown: {
        ...baseSnapshot.breakdown,
        toolMessageTokens: 2,
        toolMessageTokenCounts: { grep: 180, read_file: 0 },
      },
    });
    expect(result.breakdown.toolMessageTokenCounts).toEqual({ grep: 2 });
    expect(
      Object.values(result.breakdown.toolMessageTokenCounts ?? {}).reduce(
        (total, count) => total + count,
        0,
      ),
    ).toBeLessThanOrEqual(result.breakdown.toolMessageTokens ?? 0);
  });

  it('preserves a known-zero tool-message total', () => {
    const result = buildPersistedContextUsage({
      ...baseSnapshot,
      breakdown: { ...baseSnapshot.breakdown, toolMessageTokens: 0 },
    });
    expect(result.breakdown.toolMessageTokens).toBe(0);
    expect(Object.prototype.hasOwnProperty.call(result.breakdown, 'toolMessageTokens')).toBe(true);
  });
  it('safely persists prototype-sensitive names and ignores malformed counts', () => {
    const counts = JSON.parse('{"__proto__":3,"constructor":3,"invalid":"4"}') as Record<
      string,
      number
    >;
    const sdkExtension = {
      nested: { source: 'retained-sdk-field', flags: ['opaque'] },
      invocation: { estimated: 4, providerOnly: true },
    };
    const snapshot = {
      ...baseSnapshot,
      breakdown: {
        ...baseSnapshot.breakdown,
        toolMessageTokens: 5,
        toolMessageTokenCounts: counts,
        sdkExtension,
      },
    };
    const result = buildPersistedContextUsage(snapshot);
    const persistedCounts = result.breakdown.toolMessageTokenCounts;
    expect(persistedCounts?.['__proto__']).toBe(3);
    expect(persistedCounts?.constructor).toBe(2);
    expect(persistedCounts?.invalid).toBeUndefined();
    expect(Object.keys(persistedCounts ?? {})).toEqual(['__proto__', 'constructor']);
    expect(result.breakdown).toMatchObject({ sdkExtension });
    expect(snapshot.breakdown.toolMessageTokenCounts).toBe(counts);
  });

  it('records the final primary call output as completedOutputTokens', () => {
    /** The latest snapshot precedes the final call, so its post-snapshot delta
     *  is that call's output — not the full multi-call response tokenCount. */
    const events: TTokenUsageEvent[] = [
      { input_tokens: 100, output_tokens: 40, total_tokens: 140, provider: 'openAI' },
      { input_tokens: 200, output_tokens: 25, total_tokens: 225, provider: 'openAI' },
      {
        input_tokens: 50,
        output_tokens: 12,
        usage_type: 'subagent',
        provider: 'openAI',
      },
    ];
    const result = buildPersistedContextUsage(baseSnapshot, events);
    /** Last PRIMARY call's completion (25), skipping the trailing subagent event */
    expect(result.completedOutputTokens).toBe(25);
  });

  it('carries a counted retained tool figure as a second post-snapshot delta', () => {
    /** A turn stopped at the tool-call limit keeps the results of the tools its
     *  final call ran. They are outside the pre-invoke breakdown AND outside the
     *  final call's output, so they ride as their own field — never folded into
     *  the provider-reconciled `messageTokens`. */
    const events: TTokenUsageEvent[] = [
      { input_tokens: 200, output_tokens: 25, total_tokens: 225, provider: 'openAI' },
    ];
    const result = buildPersistedContextUsage(baseSnapshot, events, { retainedToolTokens: 640 });
    expect(result.retainedToolTokens).toBe(640);
    expect(result.completedOutputTokens).toBe(25);
    /** The provider-reconciled message total is untouched: the retained result is
     *  an addend the client applies, not part of the exact accounting. */
    expect(result.breakdown).toEqual(buildPersistedContextUsage(baseSnapshot, events).breakdown);
  });

  it.each([
    ['a normal turn passes nothing', undefined],
    ['no tool result was retained', 0],
    ['the count is negative', -5],
    ['the count is not finite', Number.NaN],
  ])('omits the retained tool figure when %s', (_label, retainedToolTokens) => {
    const result = buildPersistedContextUsage(baseSnapshot, [], { retainedToolTokens });
    expect(Object.prototype.hasOwnProperty.call(result, 'retainedToolTokens')).toBe(false);
  });

  it.each(['openAI', 'bedrock'])('persists the final primary cache split for %s', (provider) => {
    const events: TTokenUsageEvent[] = [
      { runId: 'run-1', input_tokens: 100, input_token_details: { cache_read: 10 } },
      {
        runId: 'run-1',
        provider,
        model: 'primary-model',
        input_tokens: 200,
        output_tokens: 25,
        input_token_details: { cache_read: 80, cache_creation: 40 },
      },
      { runId: 'run-2', input_tokens: 900, input_token_details: { cache_read: 900 } },
      { usage_type: 'summarization', input_tokens: 500, input_token_details: { cache_read: 500 } },
      { usage_type: 'subagent', input_tokens: 600, input_token_details: { cache_read: 600 } },
    ];
    const result = buildPersistedContextUsage(baseSnapshot, events);
    expect(result).toMatchObject({
      cacheRead: 80,
      cacheWrite: 40,
      model: 'primary-model',
      provider,
      completedOutputTokens: 25,
    });
  });

  it('replaces an earlier cache split with a final uncached call', () => {
    const result = buildPersistedContextUsage({ ...baseSnapshot, cacheRead: 80, cacheWrite: 40 }, [
      { input_tokens: 200, output_tokens: 25 },
    ]);
    expect(result).toMatchObject({ cacheRead: 0, cacheWrite: 0 });
    expect(buildPersistedContextUsage(baseSnapshot).cacheRead).toBeUndefined();
    expect(buildPersistedContextUsage(baseSnapshot).model).toBeUndefined();
  });

  it('omits completedOutputTokens when there are no primary calls', () => {
    expect(buildPersistedContextUsage(baseSnapshot, []).completedOutputTokens).toBeUndefined();
  });

  it('reconciles the inflated estimate to the final call’s real prompt tokens', () => {
    /** Real web-search + summarization turn: calibration pinned at 5 inflated
     *  messageTokens to 187471 (used 213375), but the answer call's true prompt was
     *  55773 (Anthropic input_tokens is cache-inclusive; 2071 of it is cache read).
     *  The persisted blob must show the real context so a reload isn't stuck
     *  several× too high. */
    const inflated: TContextUsageEvent = {
      runId: 'run-1',
      breakdown: {
        maxContextTokens: 250000,
        instructionTokens: 4205,
        systemMessageTokens: 384,
        dynamicInstructionTokens: 1525,
        toolSchemaTokens: 2296,
        summaryTokens: 1938,
        toolCount: 1,
        messageCount: 2,
        messageTokens: 187471,
        availableForMessages: 233295,
      },
      contextBudget: 237500,
      remainingContextTokens: 24125,
      calibrationRatio: 5,
    };
    const events: TTokenUsageEvent[] = [
      {
        input_tokens: 55773, // cache-inclusive: 53702 fresh + 2071 read
        output_tokens: 3780,
        input_token_details: { cache_read: 2071, cache_creation: 0 },
        provider: 'anthropic',
        runId: 'run-1',
      },
    ];
    const result = buildPersistedContextUsage(inflated, events);
    expect(237500 - (result.remainingContextTokens ?? 0)).toBe(55773);
    expect(result.breakdown.messageTokens).toBe(55773 - 4205 - 1938);
    expect(result.completedOutputTokens).toBe(3780);
  });

  it('attributes completedOutputTokens to the snapshot run, not a parallel run', () => {
    /** Parallel/direct runs interleave: this snapshot is run-1, but run-2 emits a
     *  later primary usage. The persisted delta must be run-1's own output (40),
     *  never run-2's trailing output (99). */
    const events: TTokenUsageEvent[] = [
      {
        input_tokens: 100,
        output_tokens: 40,
        total_tokens: 140,
        provider: 'openAI',
        runId: 'run-1',
      },
      {
        input_tokens: 200,
        output_tokens: 99,
        total_tokens: 299,
        provider: 'openAI',
        runId: 'run-2',
      },
    ];
    const result = buildPersistedContextUsage(baseSnapshot, events);
    expect(result.completedOutputTokens).toBe(40);
  });

  it('omits completedOutputTokens when only other runs emitted usage', () => {
    /** The snapshot run never completed (no matching primary); a sibling run's
     *  output must not be borrowed — fall back to the per-message estimate. */
    const events: TTokenUsageEvent[] = [
      {
        input_tokens: 200,
        output_tokens: 99,
        total_tokens: 299,
        provider: 'openAI',
        runId: 'run-2',
      },
    ];
    expect(buildPersistedContextUsage(baseSnapshot, events).completedOutputTokens).toBeUndefined();
  });

  it('matches untagged usage events for back-compat (older lib / resume)', () => {
    /** Events without a runId predate run tagging; they match any snapshot so the
     *  last primary (25) is still recorded. */
    const events: TTokenUsageEvent[] = [
      { input_tokens: 100, output_tokens: 40, total_tokens: 140, provider: 'openAI' },
      { input_tokens: 200, output_tokens: 25, total_tokens: 225, provider: 'openAI' },
    ];
    expect(buildPersistedContextUsage(baseSnapshot, events).completedOutputTokens).toBe(25);
  });
});

describe('computeSummaryUsedTokens', () => {
  const summarized = (over?: Partial<TContextUsageEvent>): TContextUsageEvent => ({
    runId: 'run-1',
    breakdown: {
      maxContextTokens: 1000,
      instructionTokens: 50,
      systemMessageTokens: 50,
      dynamicInstructionTokens: 0,
      toolSchemaTokens: 0,
      summaryTokens: 80,
      toolCount: 0,
      messageCount: 1,
      messageTokens: 20,
      availableForMessages: 900,
    },
    contextBudget: 1000,
    remainingContextTokens: 700,
    effectiveInstructionTokens: 50,
    ...over,
  });

  it('uses contextBudget − remainingContextTokens when available', () => {
    expect(computeSummaryUsedTokens(summarized())).toBe(300);
  });

  it('falls back to instructions + summary + messages, including summaryTokens', () => {
    /** summaryTokens is a separate breakdown field, so the no-remaining fallback
     *  must add it: 50 + 80 + 20 = 150, not 70. */
    expect(computeSummaryUsedTokens(summarized({ remainingContextTokens: undefined }))).toBe(150);
  });

  it('returns undefined when the turn did not summarize', () => {
    expect(
      computeSummaryUsedTokens(
        summarized({ breakdown: { ...summarized().breakdown, summaryTokens: 0 } }),
      ),
    ).toBeUndefined();
    expect(computeSummaryUsedTokens(null)).toBeUndefined();
    expect(computeSummaryUsedTokens(undefined)).toBeUndefined();
  });

  it('subtracts the response’s earlier tool-loop outputs from the marker', () => {
    /** 300 baseUsed − 90 earlier outputs = 210, so the client estimate
     *  (summaryBaseline + full response tokenCount) doesn’t double-count them. */
    expect(computeSummaryUsedTokens(summarized(), 90)).toBe(210);
  });

  it('clamps to undefined when the prior outputs exceed the baseline', () => {
    expect(computeSummaryUsedTokens(summarized(), 5000)).toBeUndefined();
  });
});

describe('priorRunOutputTokens', () => {
  const ev = (over: Partial<TTokenUsageEvent>): TTokenUsageEvent => ({
    input_tokens: 10,
    output_tokens: 0,
    total_tokens: 10,
    provider: 'openAI',
    ...over,
  });

  it('sums primary outputs before the index for the matching run', () => {
    const events = [
      ev({ output_tokens: 20, runId: 'run-1' }),
      ev({ output_tokens: 30, runId: 'run-1' }),
      ev({ output_tokens: 99, runId: 'run-1' }), // at/after the index — excluded
    ];
    expect(priorRunOutputTokens(events, 2, 'run-1')).toBe(50);
  });

  it('counts run-matched primary + summarization, skips subagent/sequential and other runs', () => {
    /** Both the primary and the summarization output are in this run's tokenCount
     *  AND baseline, so both are subtracted; subagent/sequential are excluded from
     *  the reported output total; a parallel run's primary is not this snapshot's. */
    const events = [
      ev({ output_tokens: 20, runId: 'run-1' }), // primary, matches
      ev({ output_tokens: 8, runId: 'run-1', usage_type: 'summarization' }), // counted
      ev({ output_tokens: 5, runId: 'run-1', usage_type: 'subagent' }), // skipped
      ev({ output_tokens: 7, runId: 'run-1', usage_type: 'sequential' }), // skipped
      ev({ output_tokens: 40, runId: 'run-2' }), // other-run primary — skipped
    ];
    expect(priorRunOutputTokens(events, 5, 'run-1')).toBe(28);
  });

  it('does not subtract a parallel sibling run’s summarization output', () => {
    /** The summarize detour inherits the graph run id (traceConfig), so a sibling
     *  run's summary carries a DIFFERENT runId; its summary is in the sibling's
     *  baseline, not this snapshot's, so subtracting it would under-report. */
    const events = [
      ev({ output_tokens: 20, runId: 'run-1' }),
      ev({ output_tokens: 8, runId: 'run-2', usage_type: 'summarization' }), // sibling — skipped
    ];
    expect(priorRunOutputTokens(events, 2, 'run-1')).toBe(20);
  });

  it('matches untagged events for back-compat and returns 0 with no prior calls', () => {
    const events = [ev({ output_tokens: 20 }), ev({ output_tokens: 30 })];
    expect(priorRunOutputTokens(events, 2, 'run-1')).toBe(50);
    expect(priorRunOutputTokens(events, 0, 'run-1')).toBe(0);
  });
});

describe('buildAbortedResponseMetadata', () => {
  it('returns undefined for an empty job', () => {
    expect(buildAbortedResponseMetadata(undefined)).toBeUndefined();
    expect(buildAbortedResponseMetadata({})).toBeUndefined();
    expect(buildAbortedResponseMetadata({ tokenUsage: 'not json' })).toBeUndefined();
  });

  it('rebuilds the usage/cost rollup from the job’s persisted emitted usage', () => {
    const events: TTokenUsageEvent[] = [
      { input_tokens: 100, output_tokens: 20, total_tokens: 120, provider: 'openAI', cost: 0.001 },
    ];
    const result = buildAbortedResponseMetadata({ tokenUsage: JSON.stringify(events) });
    expect(result?.usage).toEqual({
      input: 100,
      output: 20,
      cacheWrite: 0,
      cacheRead: 0,
      cost: 0.001,
    });
  });

  it('never persists a breakdown for a stopped response (avoids final-call over-count)', () => {
    const events: TTokenUsageEvent[] = [
      { input_tokens: 100, output_tokens: 20, total_tokens: 120, provider: 'openAI' },
    ];
    const result = buildAbortedResponseMetadata({ tokenUsage: JSON.stringify(events) });
    expect(result).toEqual({ usage: { input: 100, output: 20, cacheWrite: 0, cacheRead: 0 } });
    expect((result as { contextUsage?: unknown }).contextUsage).toBeUndefined();
  });

  const abortSnapshot: TContextUsageEvent = {
    runId: 'run-1',
    breakdown: {
      maxContextTokens: 1000,
      instructionTokens: 50,
      systemMessageTokens: 50,
      dynamicInstructionTokens: 0,
      toolSchemaTokens: 0,
      summaryTokens: 80,
      toolCount: 0,
      messageCount: 1,
      messageTokens: 20,
      availableForMessages: 900,
    },
    contextBudget: 1000,
    remainingContextTokens: 700,
  };

  it('persists the summary marker (but not the full snapshot) for a stopped summarized turn', () => {
    /** A single-call stopped turn: the interrupted call emitted no usage, so the
     *  marker is the full baseUsed (300) with nothing to subtract. */
    const result = buildAbortedResponseMetadata({
      tokenUsage: JSON.stringify([]),
      contextUsage: JSON.stringify(abortSnapshot),
    });
    expect(result?.summaryUsedTokens).toBe(300);
    /** The full snapshot stays off the abort path (completedOutputTokens ambiguity). */
    expect((result as { contextUsage?: unknown }).contextUsage).toBeUndefined();
  });

  it('does not subtract any output from the marker on a stopped turn', () => {
    /** The abort tokenCount comes from countTokens(text) or is absent — it does
     *  NOT fold in summarization/earlier-call output the way recordCollectedUsage
     *  does. So the marker is the full baseUsed (300); subtracting the summarization
     *  (8) or the primary (20) here would under-report after reload. */
    const events: TTokenUsageEvent[] = [
      {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        provider: 'openAI',
        runId: 'run-1',
      },
      {
        input_tokens: 60,
        output_tokens: 8,
        total_tokens: 68,
        provider: 'openAI',
        runId: 'run-1',
        usage_type: 'summarization',
      },
    ];
    const result = buildAbortedResponseMetadata({
      tokenUsage: JSON.stringify(events),
      contextUsage: JSON.stringify(abortSnapshot),
    });
    expect(result?.summaryUsedTokens).toBe(300);
  });
});

describe('resolveAgentTokenConfig', () => {
  const primary = { 'gpt-4': { prompt: 0.01, completion: 0.03, context: 8192 } };
  const subagent = { 'gpt-4': { prompt: 0.05, completion: 0.15, context: 8192 } };

  it('returns the producing agent’s own config', () => {
    const byAgentId = new Map([
      ['primary', primary],
      ['sub', subagent],
    ]);
    expect(resolveAgentTokenConfig({ agentId: 'sub', byAgentId, fallback: primary })).toBe(
      subagent,
    );
  });

  it('observes a selected lazy subagent added after the resolver is created', () => {
    const byAgentId = new Map([['primary', primary]]);
    const resolveForUsage = (agentId: string) =>
      resolveAgentTokenConfig({ agentId, byAgentId, fallback: primary });

    byAgentId.set('lazy-subagent', subagent);

    expect(resolveForUsage('lazy-subagent')).toBe(subagent);
  });

  it('returns undefined for a known agent with no configured rates (built-in pricing)', () => {
    /** A known non-custom agent (e.g. a normal OpenAI agent) is recorded with an
     *  undefined config; it must NOT inherit the custom-primary rates. */
    const byAgentId = new Map<string, typeof primary | undefined>([
      ['primary', primary],
      ['known-openai', undefined],
    ]);
    expect(
      resolveAgentTokenConfig({ agentId: 'known-openai', byAgentId, fallback: primary }),
    ).toBeUndefined();
  });

  it('falls back to the primary config for an untagged usage', () => {
    const byAgentId = new Map([['primary', primary]]);
    expect(resolveAgentTokenConfig({ agentId: undefined, byAgentId, fallback: primary })).toBe(
      primary,
    );
  });

  it('falls back to the primary config for an unknown agent id', () => {
    const byAgentId = new Map([['primary', primary]]);
    expect(resolveAgentTokenConfig({ agentId: 'ghost', byAgentId, fallback: primary })).toBe(
      primary,
    );
  });

  it('returns the fallback when there is no per-agent map (single-endpoint graphs)', () => {
    expect(resolveAgentTokenConfig({ agentId: 'primary', fallback: primary })).toBe(primary);
  });
});

describe('createDetachedSubagentUsageRecorder', () => {
  it('snapshots per-agent pricing and records each call as subagent usage', async () => {
    const spendTokens = jest.fn().mockResolvedValue(undefined);
    const childConfig = { 'child-model': { prompt: 0.01, completion: 0.02, context: 4096 } };
    const configs = new Map([['child-agent', childConfig]]);
    const recorder = createDetachedSubagentUsageRecorder(
      {
        spendTokens,
        spendStructuredTokens: jest.fn().mockResolvedValue(undefined),
      },
      {
        user: 'user-1',
        conversationId: 'parent-1',
        messageId: 'response-1',
        model: 'parent-model',
        endpointTokenConfigByAgentId: configs,
      },
    );
    configs.set('child-agent', {
      'child-model': { prompt: 99, completion: 99, context: 4096 },
    });

    await recorder({
      usage_type: 'subagent',
      input_tokens: 12,
      output_tokens: 4,
      model: 'child-model',
      agentId: 'child-agent',
    });

    expect(spendTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        user: 'user-1',
        conversationId: 'parent-1',
        messageId: 'response-1',
        context: 'subagent',
        model: 'child-model',
        endpointTokenConfig: childConfig,
      }),
      { promptTokens: 12, completionTokens: 4 },
    );
  });

  it('does not recreate billing records after the owning principal is fenced or deleted', async () => {
    const spendTokens = jest.fn().mockResolvedValue(undefined);
    const updateBalance = jest.fn().mockResolvedValue(undefined);
    const insertMany = jest.fn().mockResolvedValue(undefined);
    const recorder = createDetachedSubagentUsageRecorder(
      {
        spendTokens,
        spendStructuredTokens: jest.fn().mockResolvedValue(undefined),
        bulkWriteOps: { updateBalance, insertMany },
        isPrincipalActive: jest.fn().mockResolvedValue(false),
      },
      {
        user: 'deleted-user',
        conversationId: 'parent-1',
        messageId: 'response-1',
        model: 'child-model',
      },
    );

    await recorder({
      usage_type: 'subagent',
      input_tokens: 12,
      output_tokens: 4,
      model: 'child-model',
    });

    expect(spendTokens).not.toHaveBeenCalled();
    expect(updateBalance).not.toHaveBeenCalled();
    expect(insertMany).not.toHaveBeenCalled();
  });
});

describe('resolveRunUsageContext', () => {
  it('labels a stopped run as an abort and a completed run as a message', () => {
    expect(resolveRunUsageContext(true)).toBe('abort');
    expect(resolveRunUsageContext(false)).toBe('message');
  });
});

describe('hasRecordedProviderUsage', () => {
  it('is true once the provider reported any consumption, even with no output', () => {
    expect(hasRecordedProviderUsage({ input_tokens: 10, output_tokens: 0 })).toBe(true);
    expect(hasRecordedProviderUsage({ input_tokens: 0, output_tokens: 5 })).toBe(true);
  });

  it('is false when nothing was recorded or the report is all zero', () => {
    expect(hasRecordedProviderUsage(undefined)).toBe(false);
    expect(hasRecordedProviderUsage(null)).toBe(false);
    expect(hasRecordedProviderUsage({ input_tokens: 0, output_tokens: 0 })).toBe(false);
    expect(hasRecordedProviderUsage({})).toBe(false);
  });
});

describe('recordFallbackTokenUsage', () => {
  const txMetadata = {
    user: 'user-1',
    conversationId: 'convo-1',
    messageId: 'msg-1',
    model: 'gpt-4',
    balance: { enabled: true },
    transactions: { enabled: true },
  };
  const estimate = { promptTokens: 40, completionTokens: 7 };

  it('records nothing once provider usage was recorded, even with no output', async () => {
    const spendTokens = jest.fn().mockResolvedValue(undefined);

    await recordFallbackTokenUsage(
      { spendTokens },
      { ...estimate, usage: { input_tokens: 40, output_tokens: 0 }, txMetadata },
    );

    expect(spendTokens).not.toHaveBeenCalled();
  });

  it('bills the estimate under the given context when nothing was recorded', async () => {
    const spendTokens = jest.fn().mockResolvedValue(undefined);

    await recordFallbackTokenUsage({ spendTokens }, { ...estimate, txMetadata, context: 'abort' });

    expect(spendTokens).toHaveBeenCalledTimes(1);
    expect(spendTokens).toHaveBeenCalledWith({ ...txMetadata, context: 'abort' }, estimate);
  });

  it('labels the estimate from the stop state when no context is given', async () => {
    const spendTokens = jest.fn().mockResolvedValue(undefined);

    await recordFallbackTokenUsage({ spendTokens }, { ...estimate, txMetadata, aborted: true });
    await recordFallbackTokenUsage({ spendTokens }, { ...estimate, txMetadata, aborted: false });
    await recordFallbackTokenUsage({ spendTokens }, { ...estimate, txMetadata });

    expect(spendTokens.mock.calls.map(([tx]) => tx.context)).toEqual([
      'abort',
      'message',
      'message',
    ]);
  });

  it('lets an explicit context override the stop state', async () => {
    const spendTokens = jest.fn().mockResolvedValue(undefined);

    await recordFallbackTokenUsage(
      { spendTokens },
      { ...estimate, txMetadata, aborted: true, context: 'incomplete' },
    );

    expect(spendTokens).toHaveBeenCalledWith({ ...txMetadata, context: 'incomplete' }, estimate);
  });

  it('records nothing when a later primary call was billed but the aggregate hides it', async () => {
    const spendTokens = jest.fn().mockResolvedValue(undefined);

    await recordFallbackTokenUsage(
      { spendTokens },
      {
        ...estimate,
        usage: { input_tokens: 0, output_tokens: 0 },
        collectedUsage: [
          { input_tokens: 0, output_tokens: 0 },
          { input_tokens: 5, output_tokens: 0 },
        ],
        txMetadata,
      },
    );

    expect(spendTokens).not.toHaveBeenCalled();
  });

  it('still bills the estimate when only non-primary calls were collected', async () => {
    const spendTokens = jest.fn().mockResolvedValue(undefined);

    await recordFallbackTokenUsage(
      { spendTokens },
      {
        ...estimate,
        usage: { input_tokens: 0, output_tokens: 0 },
        collectedUsage: [
          { input_tokens: 9, output_tokens: 3, usage_type: 'summarization' },
          { input_tokens: 9, output_tokens: 3, usage_type: 'subagent' },
        ],
        txMetadata,
      },
    );

    expect(spendTokens).toHaveBeenCalledTimes(1);
  });

  it('bills a reasoning count the estimate cannot see as its own row', async () => {
    const spendTokens = jest.fn().mockResolvedValue(undefined);

    await recordFallbackTokenUsage(
      { spendTokens },
      {
        ...estimate,
        usage: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 12 },
        txMetadata,
      },
    );

    expect(spendTokens).toHaveBeenCalledTimes(2);
    expect(spendTokens).toHaveBeenLastCalledWith(
      { ...txMetadata, context: 'reasoning' },
      { completionTokens: 12 },
    );
  });

  it('logs a billing failure instead of throwing', async () => {
    const spendTokens = jest.fn().mockRejectedValue(new Error('db down'));

    await expect(
      recordFallbackTokenUsage({ spendTokens }, { ...estimate, txMetadata }),
    ).resolves.toBeUndefined();
  });
});

describe('hasRecordedPrimaryUsage', () => {
  it('finds a billed primary call anywhere in the collected entries', () => {
    expect(
      hasRecordedPrimaryUsage([
        { input_tokens: 0, output_tokens: 0 },
        null,
        { input_tokens: 5, output_tokens: 0 },
      ]),
    ).toBe(true);
    expect(
      hasRecordedPrimaryUsage([{ input_tokens: 0, output_tokens: 7, usage_type: 'message' }]),
    ).toBe(true);
  });

  it('ignores non-primary entries and empty input', () => {
    expect(
      hasRecordedPrimaryUsage([
        { input_tokens: 9, output_tokens: 3, usage_type: 'summarization' },
        { input_tokens: 9, output_tokens: 3, usage_type: 'subagent' },
        { input_tokens: 9, output_tokens: 3, usage_type: 'sequential' },
      ]),
    ).toBe(false);
    expect(hasRecordedPrimaryUsage([{ input_tokens: 0, output_tokens: 0 }])).toBe(false);
    expect(hasRecordedPrimaryUsage([])).toBe(false);
    expect(hasRecordedPrimaryUsage(undefined)).toBe(false);
  });
});
