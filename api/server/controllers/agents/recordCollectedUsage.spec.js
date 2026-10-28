/**
 * Tests for AgentClient.recordCollectedUsage
 *
 * This is a critical function that handles token spending for agent LLM calls.
 * The client now delegates to the TS recordCollectedUsage from @librechat/api,
 * passing pricing and bulkWriteOps deps.
 */

const { EModelEndpoint } = require('librechat-data-provider');

const mockSpendTokens = jest.fn().mockResolvedValue();
const mockSpendStructuredTokens = jest.fn().mockResolvedValue();
const mockGetMultiplier = jest.fn().mockReturnValue(1);
const mockGetCacheMultiplier = jest.fn().mockReturnValue(null);
const mockUpdateBalance = jest.fn().mockResolvedValue({});
const mockBulkInsertTransactions = jest.fn().mockResolvedValue(undefined);
const mockRecordCollectedUsage = jest
  .fn()
  .mockResolvedValue({ input_tokens: 100, output_tokens: 50 });

jest.mock('~/models', () => ({
  initializeMessageBudget: jest.fn(),
  spendTokens: (...args) => mockSpendTokens(...args),
  spendStructuredTokens: (...args) => mockSpendStructuredTokens(...args),
  getMultiplier: mockGetMultiplier,
  getCacheMultiplier: mockGetCacheMultiplier,
  updateBalance: mockUpdateBalance,
  bulkInsertTransactions: mockBulkInsertTransactions,
}));

jest.mock('~/config', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  },
  getMCPManager: jest.fn(() => ({
    formatInstructionsForContext: jest.fn(),
  })),
}));

jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  createMetadataAggregator: () => ({
    handleLLMEnd: jest.fn(),
    collected: [],
  }),
}));

jest.mock('@librechat/api', () => {
  const actual = jest.requireActual('@librechat/api');
  return {
    ...actual,
    recordCollectedUsage: (...args) => mockRecordCollectedUsage(...args),
  };
});

const AgentClient = require('./client');

describe('AgentClient - recordCollectedUsage', () => {
  let client;
  let mockAgent;
  let mockOptions;

  beforeEach(() => {
    jest.clearAllMocks();

    mockAgent = {
      id: 'agent-123',
      endpoint: EModelEndpoint.openAI,
      provider: EModelEndpoint.openAI,
      model_parameters: {
        model: 'gpt-4',
      },
    };

    mockOptions = {
      req: {
        user: { id: 'user-123' },
        body: { model: 'gpt-4', endpoint: EModelEndpoint.openAI },
      },
      res: {},
      agent: mockAgent,
      endpointTokenConfig: {},
    };

    client = new AgentClient(mockOptions);
    client.conversationId = 'convo-123';
    client.user = 'user-123';
  });

  describe('recordTokenUsage fallback', () => {
    const estimate = { promptTokens: 40, completionTokens: 7 };

    it('does not bill the estimate when provider usage was already recorded', async () => {
      await client.recordTokenUsage({
        ...estimate,
        usage: { input_tokens: 40, output_tokens: 0 },
        model: 'gpt-4',
      });

      expect(mockSpendTokens).not.toHaveBeenCalled();
    });

    it('bills the estimate when no provider usage was recorded', async () => {
      await client.recordTokenUsage({ ...estimate, usage: undefined, model: 'gpt-4' });

      expect(mockSpendTokens).toHaveBeenCalledTimes(1);
      expect(mockSpendTokens).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-4', context: 'message' }),
        estimate,
      );
    });

    it('labels the estimate as an abort when the run was stopped and no context is given', async () => {
      client.abortController = { signal: { aborted: true } };

      await client.recordTokenUsage({ ...estimate, usage: undefined, model: 'gpt-4' });

      expect(mockSpendTokens).toHaveBeenCalledWith(
        expect.objectContaining({ context: 'abort' }),
        estimate,
      );
    });

    it('labels the estimate as a message when the run completed and no context is given', async () => {
      client.abortController = { signal: { aborted: false } };

      await client.recordTokenUsage({ ...estimate, usage: undefined, model: 'gpt-4' });

      expect(mockSpendTokens).toHaveBeenCalledWith(
        expect.objectContaining({ context: 'message' }),
        estimate,
      );
    });

    it('does not bill the estimate when a later primary call was billed but the aggregate hides it', async () => {
      client.collectedUsage = [
        { input_tokens: 0, output_tokens: 0 },
        { input_tokens: 5, output_tokens: 0 },
      ];

      await client.recordTokenUsage({
        ...estimate,
        usage: { input_tokens: 0, output_tokens: 0 },
        model: 'gpt-4',
      });

      expect(mockSpendTokens).not.toHaveBeenCalled();
    });

    it('still bills the estimate when the recorded report is all zero', async () => {
      await client.recordTokenUsage({
        ...estimate,
        usage: { input_tokens: 0, output_tokens: 0 },
        model: 'gpt-4',
      });

      expect(mockSpendTokens).toHaveBeenCalledTimes(1);
    });
  });

  describe('basic functionality', () => {
    it('should delegate to recordCollectedUsage with full deps', async () => {
      const collectedUsage = [{ input_tokens: 100, output_tokens: 50, model: 'gpt-4' }];

      await client.recordCollectedUsage({
        collectedUsage,
        balance: { enabled: true },
        transactions: { enabled: true },
      });

      expect(mockRecordCollectedUsage).toHaveBeenCalledTimes(1);
      const [deps, params] = mockRecordCollectedUsage.mock.calls[0];

      expect(deps).toHaveProperty('spendTokens');
      expect(deps).toHaveProperty('spendStructuredTokens');
      expect(deps).toHaveProperty('pricing');
      expect(deps.pricing).toHaveProperty('getMultiplier');
      expect(deps.pricing).toHaveProperty('getCacheMultiplier');
      expect(deps).toHaveProperty('bulkWriteOps');
      expect(deps.bulkWriteOps).toHaveProperty('insertMany');
      expect(deps.bulkWriteOps).toHaveProperty('updateBalance');

      expect(params).toEqual(
        expect.objectContaining({
          user: 'user-123',
          conversationId: 'convo-123',
          collectedUsage,
          context: 'message',
          balance: { enabled: true },
          transactions: { enabled: true },
        }),
      );
    });

    it('should not set this.usage if collectedUsage is empty (returns undefined)', async () => {
      mockRecordCollectedUsage.mockResolvedValue(undefined);

      await client.recordCollectedUsage({
        collectedUsage: [],
        balance: { enabled: true },
        transactions: { enabled: true },
      });

      expect(client.usage).toBeUndefined();
    });

    it('should not set this.usage if collectedUsage is null (returns undefined)', async () => {
      mockRecordCollectedUsage.mockResolvedValue(undefined);

      await client.recordCollectedUsage({
        collectedUsage: null,
        balance: { enabled: true },
        transactions: { enabled: true },
      });

      expect(client.usage).toBeUndefined();
    });

    it('should set this.usage from recordCollectedUsage result', async () => {
      mockRecordCollectedUsage.mockResolvedValue({ input_tokens: 200, output_tokens: 75 });
      const collectedUsage = [{ input_tokens: 200, output_tokens: 75, model: 'gpt-4' }];

      await client.recordCollectedUsage({
        collectedUsage,
        balance: { enabled: true },
        transactions: { enabled: true },
      });

      expect(client.usage).toEqual({ input_tokens: 200, output_tokens: 75 });
    });
  });

  describe('sequential execution (single agent with tool calls)', () => {
    it('should pass all usage entries to recordCollectedUsage', async () => {
      const collectedUsage = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
        { input_tokens: 150, output_tokens: 30, model: 'gpt-4' },
        { input_tokens: 180, output_tokens: 20, model: 'gpt-4' },
      ];

      mockRecordCollectedUsage.mockResolvedValue({ input_tokens: 100, output_tokens: 100 });

      await client.recordCollectedUsage({
        collectedUsage,
        balance: { enabled: true },
        transactions: { enabled: true },
      });

      expect(mockRecordCollectedUsage).toHaveBeenCalledTimes(1);
      const [, params] = mockRecordCollectedUsage.mock.calls[0];
      expect(params.collectedUsage).toHaveLength(3);
      expect(client.usage.output_tokens).toBe(100);
      expect(client.usage.input_tokens).toBe(100);
    });
  });

  describe('parallel execution (multiple agents)', () => {
    it('should pass parallel agent usage to recordCollectedUsage', async () => {
      const collectedUsage = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
        { input_tokens: 80, output_tokens: 40, model: 'gpt-4' },
      ];

      mockRecordCollectedUsage.mockResolvedValue({ input_tokens: 100, output_tokens: 90 });

      await client.recordCollectedUsage({
        collectedUsage,
        balance: { enabled: true },
        transactions: { enabled: true },
      });

      expect(mockRecordCollectedUsage).toHaveBeenCalledTimes(1);
      expect(client.usage.output_tokens).toBe(90);
      expect(client.usage.output_tokens).toBeGreaterThan(0);
    });

    /** Bug regression: parallel agents where second agent has LOWER input tokens produced negative output via incremental calculation. */
    it('should NOT produce negative output_tokens', async () => {
      const collectedUsage = [
        { input_tokens: 200, output_tokens: 100, model: 'gpt-4' },
        { input_tokens: 50, output_tokens: 30, model: 'gpt-4' },
      ];

      mockRecordCollectedUsage.mockResolvedValue({ input_tokens: 200, output_tokens: 130 });

      await client.recordCollectedUsage({
        collectedUsage,
        balance: { enabled: true },
        transactions: { enabled: true },
      });

      expect(client.usage.output_tokens).toBeGreaterThan(0);
      expect(client.usage.output_tokens).toBe(130);
    });
  });

  describe('real-world scenarios', () => {
    it('should correctly handle sequential tool calls with growing context', async () => {
      const collectedUsage = [
        { input_tokens: 31596, output_tokens: 151, model: 'claude-opus-4-5-20251101' },
        { input_tokens: 35368, output_tokens: 150, model: 'claude-opus-4-5-20251101' },
        { input_tokens: 58362, output_tokens: 295, model: 'claude-opus-4-5-20251101' },
        { input_tokens: 112604, output_tokens: 193, model: 'claude-opus-4-5-20251101' },
        { input_tokens: 257440, output_tokens: 2217, model: 'claude-opus-4-5-20251101' },
      ];

      mockRecordCollectedUsage.mockResolvedValue({ input_tokens: 31596, output_tokens: 3006 });

      await client.recordCollectedUsage({
        collectedUsage,
        balance: { enabled: true },
        transactions: { enabled: true },
      });

      expect(client.usage.input_tokens).toBe(31596);
      expect(client.usage.output_tokens).toBe(3006);
    });

    it('should correctly handle cache tokens', async () => {
      const collectedUsage = [
        {
          input_tokens: 788,
          output_tokens: 163,
          input_token_details: { cache_read: 0, cache_creation: 30808 },
          model: 'claude-opus-4-5-20251101',
        },
      ];

      mockRecordCollectedUsage.mockResolvedValue({ input_tokens: 31596, output_tokens: 163 });

      await client.recordCollectedUsage({
        collectedUsage,
        balance: { enabled: true },
        transactions: { enabled: true },
      });

      expect(client.usage.input_tokens).toBe(31596);
      expect(client.usage.output_tokens).toBe(163);
    });
  });

  describe('model fallback', () => {
    it('should use param model when available', async () => {
      mockRecordCollectedUsage.mockResolvedValue({ input_tokens: 100, output_tokens: 50 });
      const collectedUsage = [{ input_tokens: 100, output_tokens: 50 }];

      await client.recordCollectedUsage({
        model: 'param-model',
        collectedUsage,
        balance: { enabled: true },
        transactions: { enabled: true },
      });

      const [, params] = mockRecordCollectedUsage.mock.calls[0];
      expect(params.model).toBe('param-model');
    });

    it('should fallback to client.model when param model is missing', async () => {
      client.model = 'client-model';
      mockRecordCollectedUsage.mockResolvedValue({ input_tokens: 100, output_tokens: 50 });
      const collectedUsage = [{ input_tokens: 100, output_tokens: 50 }];

      await client.recordCollectedUsage({
        collectedUsage,
        balance: { enabled: true },
        transactions: { enabled: true },
      });

      const [, params] = mockRecordCollectedUsage.mock.calls[0];
      expect(params.model).toBe('client-model');
    });

    it('should fallback to agent model_parameters.model as last resort', async () => {
      mockRecordCollectedUsage.mockResolvedValue({ input_tokens: 100, output_tokens: 50 });
      const collectedUsage = [{ input_tokens: 100, output_tokens: 50 }];

      await client.recordCollectedUsage({
        collectedUsage,
        balance: { enabled: true },
        transactions: { enabled: true },
      });

      const [, params] = mockRecordCollectedUsage.mock.calls[0];
      expect(params.model).toBe('gpt-4');
    });
  });

  describe('getStreamUsage integration', () => {
    it('should return the usage object set by recordCollectedUsage', async () => {
      mockRecordCollectedUsage.mockResolvedValue({ input_tokens: 100, output_tokens: 50 });
      const collectedUsage = [{ input_tokens: 100, output_tokens: 50, model: 'gpt-4' }];

      await client.recordCollectedUsage({
        collectedUsage,
        balance: { enabled: true },
        transactions: { enabled: true },
      });

      const usage = client.getStreamUsage();
      expect(usage).toEqual({ input_tokens: 100, output_tokens: 50 });
    });

    it('should return undefined before recordCollectedUsage is called', () => {
      const usage = client.getStreamUsage();
      expect(usage).toBeUndefined();
    });

    /** Verifies usage passes the check in BaseClient.sendMessage: if (usage != null && Number(usage[this.outputTokensKey]) > 0) */
    it('should have output_tokens > 0 for BaseClient.sendMessage check', async () => {
      mockRecordCollectedUsage.mockResolvedValue({ input_tokens: 200, output_tokens: 130 });
      const collectedUsage = [
        { input_tokens: 200, output_tokens: 100, model: 'gpt-4' },
        { input_tokens: 50, output_tokens: 30, model: 'gpt-4' },
      ];

      await client.recordCollectedUsage({
        collectedUsage,
        balance: { enabled: true },
        transactions: { enabled: true },
      });

      const usage = client.getStreamUsage();
      expect(usage).not.toBeNull();
      expect(Number(usage.output_tokens)).toBeGreaterThan(0);
    });
  });
});
