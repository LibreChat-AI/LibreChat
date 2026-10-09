/**
 * Bulk path parity tests for recordCollectedUsage.
 *
 * Every test here mirrors a corresponding legacy-path test in usage.spec.ts.
 * The return values (input_tokens, output_tokens) must be identical between paths.
 * The docs written to insertMany must carry the same metadata as the args that
 * would have been passed to spendTokens/spendStructuredTokens.
 */
import type { UsageMetadata } from '../stream/interfaces/IJobStore';
import type { RecordUsageDeps, RecordUsageParams } from './usage';
import type { BulkWriteDeps, PricingFns } from './transactions';
import { recordCollectedUsage } from './usage';

describe('recordCollectedUsage — bulk path parity', () => {
  let mockSpendTokens: jest.Mock;
  let mockSpendStructuredTokens: jest.Mock;
  let mockInsertMany: jest.Mock;
  let mockUpdateBalance: jest.Mock;
  let mockPricing: PricingFns;
  let mockBulkWriteOps: BulkWriteDeps;
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
    deps = {
      spendTokens: mockSpendTokens,
      spendStructuredTokens: mockSpendStructuredTokens,
      pricing: mockPricing,
      bulkWriteOps: mockBulkWriteOps,
    };
  });

  describe('basic functionality', () => {
    it('should return undefined if collectedUsage is empty', async () => {
      const result = await recordCollectedUsage(deps, { ...baseParams, collectedUsage: [] });
      expect(result).toBeUndefined();
      expect(mockInsertMany).not.toHaveBeenCalled();
      expect(mockSpendTokens).not.toHaveBeenCalled();
    });

    it('should return undefined if collectedUsage is null-ish', async () => {
      const result = await recordCollectedUsage(deps, {
        ...baseParams,
        collectedUsage: null as unknown as UsageMetadata[],
      });
      expect(result).toBeUndefined();
      expect(mockInsertMany).not.toHaveBeenCalled();
    });

    it('should handle single usage entry — same return value as legacy path', async () => {
      const collectedUsage: UsageMetadata[] = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
      ];

      const result = await recordCollectedUsage(deps, { ...baseParams, collectedUsage });

      expect(result).toEqual({ input_tokens: 100, output_tokens: 50 });
      expect(mockSpendTokens).not.toHaveBeenCalled();
      expect(mockInsertMany).toHaveBeenCalledTimes(1);

      const docs = mockInsertMany.mock.calls[0][0];
      expect(docs).toHaveLength(2);
      const promptDoc = docs.find((d: { tokenType: string }) => d.tokenType === 'prompt');
      const completionDoc = docs.find((d: { tokenType: string }) => d.tokenType === 'completion');
      expect(promptDoc.user).toBe('user-123');
      expect(promptDoc.conversationId).toBe('convo-123');
      expect(promptDoc.model).toBe('gpt-4');
      expect(promptDoc.context).toBe('message');
      expect(promptDoc.rawAmount).toBe(-100);
      expect(completionDoc.rawAmount).toBe(-50);
    });

    it('should skip null entries — same return value as legacy path', async () => {
      const collectedUsage = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
        null,
        { input_tokens: 200, output_tokens: 60, model: 'gpt-4' },
      ] as UsageMetadata[];

      const result = await recordCollectedUsage(deps, { ...baseParams, collectedUsage });

      expect(result).toEqual({ input_tokens: 100, output_tokens: 110 });
      expect(mockInsertMany).toHaveBeenCalledTimes(1);
      const docs = mockInsertMany.mock.calls[0][0];
      expect(docs).toHaveLength(4); // 2 non-null entries × 2 docs each
    });
  });

  describe('sequential execution (tool calls)', () => {
    it('should calculate tokens correctly for sequential tool calls — same totals as legacy', async () => {
      const collectedUsage: UsageMetadata[] = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
        { input_tokens: 150, output_tokens: 30, model: 'gpt-4' },
        { input_tokens: 180, output_tokens: 20, model: 'gpt-4' },
      ];

      const result = await recordCollectedUsage(deps, { ...baseParams, collectedUsage });

      expect(result?.output_tokens).toBe(100); // 50 + 30 + 20
      expect(result?.input_tokens).toBe(100); // first entry's input

      expect(mockInsertMany).toHaveBeenCalledTimes(1);
      const docs = mockInsertMany.mock.calls[0][0];
      expect(docs).toHaveLength(6); // 3 entries × 2 docs
      expect(mockSpendTokens).not.toHaveBeenCalled();
    });
  });

  describe('parallel execution (multiple agents)', () => {
    it('should handle parallel agents — same output_tokens total as legacy', async () => {
      const collectedUsage: UsageMetadata[] = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
        { input_tokens: 80, output_tokens: 40, model: 'gpt-4' },
      ];

      const result = await recordCollectedUsage(deps, { ...baseParams, collectedUsage });

      expect(result?.output_tokens).toBe(90); // 50 + 40
      expect(result?.output_tokens).toBeGreaterThan(0);
      expect(mockInsertMany).toHaveBeenCalledTimes(1);
    });

    /** Bug regression: parallel agents where second agent has LOWER input tokens produced negative output via incremental calculation. */
    it('should NOT produce negative output_tokens — same positive result as legacy', async () => {
      const collectedUsage: UsageMetadata[] = [
        { input_tokens: 200, output_tokens: 100, model: 'gpt-4' },
        { input_tokens: 50, output_tokens: 30, model: 'gpt-4' },
      ];

      const result = await recordCollectedUsage(deps, { ...baseParams, collectedUsage });

      expect(result?.output_tokens).toBeGreaterThan(0);
      expect(result?.output_tokens).toBe(130); // 100 + 30
    });

    it('should calculate correct total output for 3 parallel agents', async () => {
      const collectedUsage: UsageMetadata[] = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
        { input_tokens: 120, output_tokens: 60, model: 'gpt-4-turbo' },
        { input_tokens: 80, output_tokens: 40, model: 'claude-3' },
      ];

      const result = await recordCollectedUsage(deps, { ...baseParams, collectedUsage });

      expect(result?.output_tokens).toBe(150); // 50 + 60 + 40
      expect(mockInsertMany).toHaveBeenCalledTimes(1);
      const docs = mockInsertMany.mock.calls[0][0];
      expect(docs).toHaveLength(6);
      expect(mockSpendTokens).not.toHaveBeenCalled();
    });
  });

  describe('cache token handling - subset providers (input_tokens already includes cache)', () => {
    it('subtracts cache from input portion in bulk docs for OpenAI', async () => {
      const collectedUsage: UsageMetadata[] = [
        {
          input_tokens: 100,
          output_tokens: 50,
          model: 'gpt-4',
          provider: 'openAI',
          input_token_details: { cache_creation: 20, cache_read: 10 },
        },
      ];

      const result = await recordCollectedUsage(deps, { ...baseParams, collectedUsage });

      expect(result?.input_tokens).toBe(100);
      expect(mockInsertMany).toHaveBeenCalledTimes(1);
      expect(mockSpendStructuredTokens).not.toHaveBeenCalled();
      expect(mockSpendTokens).not.toHaveBeenCalled();

      const docs = mockInsertMany.mock.calls[0][0];
      const promptDoc = docs.find((d: { tokenType: string }) => d.tokenType === 'prompt');
      expect(promptDoc.inputTokens).toBe(-70);
      expect(promptDoc.writeTokens).toBe(-20);
      expect(promptDoc.readTokens).toBe(-10);
      expect(promptDoc.model).toBe('gpt-4');
    });

    it('does not double-count cache_read for Gemini in bulk path — issue #12855', async () => {
      const collectedUsage: UsageMetadata[] = [
        {
          input_tokens: 11125,
          output_tokens: 20,
          model: 'gemini-3-flash-preview',
          provider: 'google',
          input_token_details: { cache_read: 7441 },
        },
      ];

      const result = await recordCollectedUsage(deps, { ...baseParams, collectedUsage });

      expect(result?.input_tokens).toBe(11125);
      expect(mockInsertMany).toHaveBeenCalledTimes(1);

      const docs = mockInsertMany.mock.calls[0][0];
      const promptDoc = docs.find((d: { tokenType: string }) => d.tokenType === 'prompt');
      expect(promptDoc.inputTokens).toBe(-3684);
      expect(promptDoc.readTokens).toBe(-7441);
      expect(promptDoc.writeTokens || 0).toBe(0);
    });
  });

  describe('cache token handling - Anthropic format', () => {
    it('routes Anthropic cache entries to structured path and subtracts cache from input', async () => {
      /** Production Anthropic wire: input_tokens is cache-inclusive (140 =
       *  100 fresh + 25 write + 15 read) and provider is tagged. The billed
       *  input must be the fresh 100, not 140 — otherwise cache is charged
       *  twice (full input rate + cache rate). Regression for LibreChat#13795. */
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

      const result = await recordCollectedUsage(deps, { ...baseParams, collectedUsage });

      expect(result?.input_tokens).toBe(140);
      expect(mockInsertMany).toHaveBeenCalledTimes(1);
      expect(mockSpendStructuredTokens).not.toHaveBeenCalled();

      const docs = mockInsertMany.mock.calls[0][0];
      const promptDoc = docs.find((d: { tokenType: string }) => d.tokenType === 'prompt');
      expect(promptDoc.inputTokens).toBe(-100);
      expect(promptDoc.writeTokens).toBe(-25);
      expect(promptDoc.readTokens).toBe(-15);
      expect(promptDoc.model).toBe('claude-3');
    });
  });

  describe('mixed cache and non-cache entries', () => {
    it('should handle mixed entries — same output_tokens as legacy', async () => {
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

      const result = await recordCollectedUsage(deps, { ...baseParams, collectedUsage });

      expect(result?.output_tokens).toBe(100); // 50 + 30 + 20
      expect(mockInsertMany).toHaveBeenCalledTimes(1);
      expect(mockSpendTokens).not.toHaveBeenCalled();
      expect(mockSpendStructuredTokens).not.toHaveBeenCalled();

      const docs = mockInsertMany.mock.calls[0][0];
      expect(docs).toHaveLength(6); // 3 entries × 2 docs each
    });
  });

  describe('model fallback', () => {
    it('should use usage.model when available — model lands in doc', async () => {
      const collectedUsage: UsageMetadata[] = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4-turbo' },
      ];

      await recordCollectedUsage(deps, {
        ...baseParams,
        model: 'fallback-model',
        collectedUsage,
      });

      const docs = mockInsertMany.mock.calls[0][0];
      expect(docs[0].model).toBe('gpt-4-turbo');
    });

    it('should fallback to param model when usage.model is missing — model lands in doc', async () => {
      const collectedUsage: UsageMetadata[] = [{ input_tokens: 100, output_tokens: 50 }];

      await recordCollectedUsage(deps, {
        ...baseParams,
        model: 'param-model',
        collectedUsage,
      });

      const docs = mockInsertMany.mock.calls[0][0];
      expect(docs[0].model).toBe('param-model');
    });

    it('should fallback to undefined model when both usage.model and param model are missing', async () => {
      const collectedUsage: UsageMetadata[] = [{ input_tokens: 100, output_tokens: 50 }];

      await recordCollectedUsage(deps, {
        ...baseParams,
        model: undefined,
        collectedUsage,
      });

      const docs = mockInsertMany.mock.calls[0][0];
      expect(docs[0].model).toBeUndefined();
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

      const result = await recordCollectedUsage(deps, { ...baseParams, collectedUsage });

      expect(result?.input_tokens).toBe(31596);
      expect(result?.output_tokens).toBe(3006); // 151+150+295+193+2217

      expect(mockInsertMany).toHaveBeenCalledTimes(1);
      const docs = mockInsertMany.mock.calls[0][0];
      expect(docs).toHaveLength(10); // 5 entries × 2 docs
      expect(mockSpendTokens).not.toHaveBeenCalled();
    });

    it('should handle cache tokens with multiple tool calls — same totals as legacy', async () => {
      /** Cache-inclusive Anthropic wire (input_tokens = fresh + write + read).
       *  The billed input on each call is the fresh portion only. */
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

      const result = await recordCollectedUsage(deps, { ...baseParams, collectedUsage });

      expect(result?.input_tokens).toBe(31596); // total prompt of first call
      expect(result?.output_tokens).toBe(537); // 163 + 149 + 225
      expect(mockInsertMany).toHaveBeenCalledTimes(1);
      expect(mockSpendStructuredTokens).not.toHaveBeenCalled();
      expect(mockSpendTokens).not.toHaveBeenCalled();

      /** Each prompt doc bills only the fresh portion — cache is never folded
       *  into inputTokens on top of its own write/read charge. */
      const promptDocs = mockInsertMany.mock.calls[0][0].filter(
        (d: { tokenType: string }) => d.tokenType === 'prompt',
      );
      expect(promptDocs.map((d: { inputTokens: number }) => d.inputTokens)).toEqual([
        -788, -3802, -26808,
      ]);
    });
  });

  describe('error handling', () => {
    it('should catch bulk write errors — still returns correct result', async () => {
      mockInsertMany.mockRejectedValue(new Error('DB error'));

      const collectedUsage: UsageMetadata[] = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
      ];

      const result = await recordCollectedUsage(deps, { ...baseParams, collectedUsage });

      expect(result).toEqual({ input_tokens: 100, output_tokens: 50 });
    });
  });

  describe('transaction metadata — doc fields match what legacy would pass to spendTokens', () => {
    it('should pass all metadata fields to docs', async () => {
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

      const docs = mockInsertMany.mock.calls[0][0];
      for (const doc of docs) {
        expect(doc.user).toBe('user-123');
        expect(doc.conversationId).toBe('convo-123');
        expect(doc.model).toBe('gpt-4');
        expect(doc.context).toBe('message');
        expect(doc.messageId).toBe('msg-123');
      }
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

      const docs = mockInsertMany.mock.calls[0][0];
      expect(docs[0].context).toBe('message');
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

      const docs = mockInsertMany.mock.calls[0][0];
      expect(docs[0].context).toBe('title');
    });
  });

  describe('messageId propagation — messageId on every doc', () => {
    it('should propagate messageId to all docs', async () => {
      const collectedUsage: UsageMetadata[] = [
        { input_tokens: 10, output_tokens: 5, model: 'gpt-4' },
      ];

      await recordCollectedUsage(deps, {
        ...baseParams,
        messageId: 'msg-1',
        collectedUsage,
      });

      const docs = mockInsertMany.mock.calls[0][0];
      for (const doc of docs) {
        expect(doc.messageId).toBe('msg-1');
      }
    });

    it('should propagate messageId to structured cache docs', async () => {
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

      const docs = mockInsertMany.mock.calls[0][0];
      for (const doc of docs) {
        expect(doc.messageId).toBe('msg-cache-1');
      }
      expect(mockSpendStructuredTokens).not.toHaveBeenCalled();
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

      const docs = mockInsertMany.mock.calls[0][0];
      expect(docs[0].messageId).toBeUndefined();
    });

    it('should propagate messageId across all entries in a multi-entry batch', async () => {
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

      const docs = mockInsertMany.mock.calls[0][0];
      for (const doc of docs) {
        expect(doc.messageId).toBe('msg-multi');
      }
      expect(mockSpendTokens).not.toHaveBeenCalled();
      expect(mockSpendStructuredTokens).not.toHaveBeenCalled();
    });
  });

  describe('balance behavior parity', () => {
    it('should not call updateBalance when balance is disabled — same as legacy', async () => {
      const collectedUsage: UsageMetadata[] = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
      ];

      await recordCollectedUsage(deps, {
        ...baseParams,
        balance: { enabled: false },
        collectedUsage,
      });

      expect(mockInsertMany).toHaveBeenCalledTimes(1);
      expect(mockUpdateBalance).not.toHaveBeenCalled();
    });

    it('should not insert docs when transactions are disabled — same as legacy', async () => {
      const collectedUsage: UsageMetadata[] = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
      ];

      await recordCollectedUsage(deps, {
        ...baseParams,
        transactions: { enabled: false },
        collectedUsage,
      });

      expect(mockInsertMany).not.toHaveBeenCalled();
      expect(mockUpdateBalance).not.toHaveBeenCalled();
    });
  });
});
