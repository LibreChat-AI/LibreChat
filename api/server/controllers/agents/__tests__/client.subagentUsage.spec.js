const mockGetMultiplier = jest.fn(() => 1);
const mockGetCacheMultiplier = jest.fn(() => 1);

jest.mock('~/models', () => ({
  initializeMessageBudget: jest.fn(),
  getMultiplier: (...args) => mockGetMultiplier(...args),
  getCacheMultiplier: (...args) => mockGetCacheMultiplier(...args),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

const AgentClient = require('../client');

describe('AgentClient#buildSubagentUsageEmitter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses a lifecycle-safe snapshot after the parent client is disposed', async () => {
    const write = jest.fn();
    const usageEmitSink = [];
    const pendingSubagentEmits = [];
    const endpointTokenConfig = { input: 2, output: 3 };
    const self = {
      options: {
        res: { write },
        req: { user: { id: 'user-1' } },
        endpointTokenConfig,
        endpointTokenConfigByAgentId: new Map([['child-agent', endpointTokenConfig]]),
      },
      responseMessageId: 'response-1',
      jobCreatedAt: 1234,
      usageEmitSink,
      pendingSubagentEmits,
      subagentUsageSeq: 4,
    };
    const emit = AgentClient.prototype.buildSubagentUsageEmitter.call(self, {
      interfaceConfig: { contextCost: true },
    });

    /** Mirror the fields cleared by disposeClient before the detached child
     * finishes; the callback must not read any of them. */
    self.options = null;
    self.responseMessageId = null;
    self.jobCreatedAt = null;
    self.usageEmitSink = null;
    self.pendingSubagentEmits = null;

    const usage = {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      model: 'child-model',
      provider: 'custom',
      agentId: 'child-agent',
    };
    await emit(usage);

    expect(usageEmitSink).toEqual([
      expect.objectContaining({
        runId: 'response-1:1234',
        seq: 5,
        usage_type: 'subagent',
        cost: expect.any(Number),
      }),
    ]);
    expect(usage.cost).toBe(usageEmitSink[0].cost);
    expect(write).toHaveBeenCalledTimes(1);
    expect(pendingSubagentEmits).toHaveLength(1);
    await expect(pendingSubagentEmits[0]).resolves.toBeUndefined();
  });
});
