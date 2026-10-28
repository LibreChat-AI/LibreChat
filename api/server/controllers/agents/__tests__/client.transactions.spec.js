const mockSpendTokens = jest.fn().mockResolvedValue(undefined);

jest.mock('~/models', () => ({
  initializeMessageBudget: jest.fn(),
  spendTokens: mockSpendTokens,
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

const AgentClient = require('../client');

describe('AgentClient#recordTokenUsage transactions config', () => {
  /** @returns {AgentClient} */
  const createClient = () =>
    Object.create(AgentClient.prototype, {
      user: { value: 'user-1' },
      conversationId: { value: 'convo-1' },
      responseMessageId: { value: 'msg-1' },
      options: { value: { req: { user: { id: 'user-1' } }, endpointTokenConfig: undefined } },
    });

  beforeEach(() => {
    mockSpendTokens.mockClear();
  });

  it('forwards the transactions config to spendTokens', async () => {
    await createClient().recordTokenUsage({
      model: 'gpt-4o-mini',
      promptTokens: 10,
      completionTokens: 5,
      balance: { enabled: false },
      transactions: { enabled: false },
    });

    expect(mockSpendTokens).toHaveBeenCalledTimes(1);
    expect(mockSpendTokens.mock.calls[0][0]).toEqual(
      expect.objectContaining({ transactions: { enabled: false } }),
    );
  });

  it('forwards the transactions config on the reasoning-token spend', async () => {
    await createClient().recordTokenUsage({
      model: 'gpt-4o-mini',
      promptTokens: 10,
      completionTokens: 5,
      transactions: { enabled: false },
      usage: { reasoning_tokens: 7 },
    });

    expect(mockSpendTokens).toHaveBeenCalledTimes(2);
    expect(mockSpendTokens.mock.calls[1][0]).toEqual(
      expect.objectContaining({ context: 'reasoning', transactions: { enabled: false } }),
    );
  });

  it('still records when transactions are enabled', async () => {
    await createClient().recordTokenUsage({
      model: 'gpt-4o-mini',
      promptTokens: 10,
      completionTokens: 5,
      transactions: { enabled: true },
    });

    expect(mockSpendTokens.mock.calls[0][0]).toEqual(
      expect.objectContaining({ transactions: { enabled: true } }),
    );
  });
});
