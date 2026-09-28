import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { IBalance } from '..';
import type { ITransaction } from '~/schema/transaction';
import type { TxData } from './transaction';
import { createTxMethods, tokenValues, premiumTokenValues, defaultRate } from './tx';
import { matchModelName, findMatchingPattern } from './test-helpers';
import { createSpendTokensMethods } from './spendTokens';
import { createTransactionMethods } from './transaction';
import { createModels } from '~/models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: InstanceType<typeof MongoMemoryServer>;
let Balance: mongoose.Model<IBalance>;
let Transaction: mongoose.Model<ITransaction>;
let spendTokens: ReturnType<typeof createSpendTokensMethods>['spendTokens'];
let spendStructuredTokens: ReturnType<typeof createSpendTokensMethods>['spendStructuredTokens'];
let createTransaction: ReturnType<typeof createTransactionMethods>['createTransaction'];
let createStructuredTransaction: ReturnType<
  typeof createTransactionMethods
>['createStructuredTransaction'];
let reserveBalance: ReturnType<typeof createTransactionMethods>['reserveBalance'];
let renewBalanceReservation: ReturnType<typeof createTransactionMethods>['renewBalanceReservation'];
let releaseBalanceReservation: ReturnType<
  typeof createTransactionMethods
>['releaseBalanceReservation'];
let findBalanceByUser: ReturnType<typeof createTransactionMethods>['findBalanceByUser'];
let upsertBalanceFields: ReturnType<typeof createTransactionMethods>['upsertBalanceFields'];
let updateBalance: ReturnType<typeof createTransactionMethods>['updateBalance'];
let getMultiplier: ReturnType<typeof createTxMethods>['getMultiplier'];
let getCacheMultiplier: ReturnType<typeof createTxMethods>['getCacheMultiplier'];

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();

  // Register models
  const models = createModels(mongoose);
  Object.assign(mongoose.models, models);

  Balance = mongoose.models.Balance;
  Transaction = mongoose.models.Transaction;

  // Create methods from factories (following the chain in methods/index.ts)
  const txMethods = createTxMethods(mongoose, { matchModelName, findMatchingPattern });
  getMultiplier = txMethods.getMultiplier;
  getCacheMultiplier = txMethods.getCacheMultiplier;

  const transactionMethods = createTransactionMethods(mongoose, {
    getMultiplier: txMethods.getMultiplier,
    getCacheMultiplier: txMethods.getCacheMultiplier,
  });
  createTransaction = transactionMethods.createTransaction;
  createStructuredTransaction = transactionMethods.createStructuredTransaction;
  reserveBalance = transactionMethods.reserveBalance;
  renewBalanceReservation = transactionMethods.renewBalanceReservation;
  releaseBalanceReservation = transactionMethods.releaseBalanceReservation;
  findBalanceByUser = transactionMethods.findBalanceByUser;
  upsertBalanceFields = transactionMethods.upsertBalanceFields;
  updateBalance = transactionMethods.updateBalance;

  const spendMethods = createSpendTokensMethods(mongoose, {
    createTransaction: transactionMethods.createTransaction,
    createStructuredTransaction: transactionMethods.createStructuredTransaction,
  });
  spendTokens = spendMethods.spendTokens;
  spendStructuredTokens = spendMethods.spendStructuredTokens;

  await mongoose.connect(mongoUri);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
});

describe('Regular Token Spending Tests', () => {
  test('Balance should decrease when spending tokens with spendTokens', async () => {
    // Arrange
    const userId = new mongoose.Types.ObjectId();
    const initialBalance = 10000000; // $10.00
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'gpt-3.5-turbo';
    const txData = {
      user: userId,
      conversationId: 'test-conversation-id',
      model,
      context: 'test',
      endpointTokenConfig: null,
      balance: { enabled: true },
    };

    const tokenUsage = {
      promptTokens: 100,
      completionTokens: 50,
    };

    // Act
    await spendTokens(txData, tokenUsage);

    // Assert
    const updatedBalance = await Balance.findOne({ user: userId });
    const promptMultiplier = getMultiplier({ model, tokenType: 'prompt' });
    const completionMultiplier = getMultiplier({ model, tokenType: 'completion' });
    const expectedTotalCost = 100 * promptMultiplier + 50 * completionMultiplier;
    const expectedBalance = initialBalance - expectedTotalCost;

    expect(updatedBalance?.tokenCredits).toBeCloseTo(expectedBalance, 0);
  });

  test('spendTokens should handle zero completion tokens', async () => {
    // Arrange
    const userId = new mongoose.Types.ObjectId();
    const initialBalance = 10000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'gpt-3.5-turbo';
    const txData = {
      user: userId,
      conversationId: 'test-conversation-id',
      model,
      context: 'test',
      endpointTokenConfig: null,
      balance: { enabled: true },
    };

    const tokenUsage = {
      promptTokens: 100,
      completionTokens: 0,
    };

    // Act
    await spendTokens(txData, tokenUsage);

    // Assert
    const updatedBalance = await Balance.findOne({ user: userId });
    const promptMultiplier = getMultiplier({ model, tokenType: 'prompt' });
    const expectedCost = 100 * promptMultiplier;
    expect(updatedBalance?.tokenCredits).toBeCloseTo(initialBalance - expectedCost, 0);
  });

  test('spendTokens should handle undefined token counts', async () => {
    // Arrange
    const userId = new mongoose.Types.ObjectId();
    const initialBalance = 10000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'gpt-3.5-turbo';
    const txData = {
      user: userId,
      conversationId: 'test-conversation-id',
      model,
      context: 'test',
      endpointTokenConfig: null,
      balance: { enabled: true },
    };

    const tokenUsage = {};

    // Act
    const result = await spendTokens(txData, tokenUsage);

    // Assert: No transaction should be created
    expect(result).toBeUndefined();
  });

  test('spendTokens should handle only prompt tokens', async () => {
    // Arrange
    const userId = new mongoose.Types.ObjectId();
    const initialBalance = 10000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'gpt-3.5-turbo';
    const txData = {
      user: userId,
      conversationId: 'test-conversation-id',
      model,
      context: 'test',
      endpointTokenConfig: null,
      balance: { enabled: true },
    };

    const tokenUsage = { promptTokens: 100 };

    // Act
    await spendTokens(txData, tokenUsage);

    // Assert
    const updatedBalance = await Balance.findOne({ user: userId });
    const promptMultiplier = getMultiplier({ model, tokenType: 'prompt' });
    const expectedCost = 100 * promptMultiplier;
    expect(updatedBalance?.tokenCredits).toBeCloseTo(initialBalance - expectedCost, 0);
  });

  test('spendTokens should not update balance when balance feature is disabled', async () => {
    // Arrange: Balance config is now passed directly in txData
    const userId = new mongoose.Types.ObjectId();
    const initialBalance = 10000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'gpt-3.5-turbo';
    const txData = {
      user: userId,
      conversationId: 'test-conversation-id',
      model,
      context: 'test',
      endpointTokenConfig: null,
      balance: { enabled: false },
    };

    const tokenUsage = {
      promptTokens: 100,
      completionTokens: 50,
    };

    // Act
    await spendTokens(txData, tokenUsage);

    // Assert: Balance should remain unchanged.
    const updatedBalance = await Balance.findOne({ user: userId });
    expect(updatedBalance?.tokenCredits).toBe(initialBalance);
  });
});

describe('Structured Token Spending Tests', () => {
  test('Balance should decrease and rawAmount should be set when spending a large number of structured tokens', async () => {
    // Arrange
    const userId = new mongoose.Types.ObjectId();
    const initialBalance = 17613154.55; // $17.61
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'claude-3-5-sonnet';
    const txData = {
      user: userId,
      conversationId: 'c23a18da-706c-470a-ac28-ec87ed065199',
      model,
      context: 'message',
      endpointTokenConfig: null,
      balance: { enabled: true },
    };

    const tokenUsage = {
      promptTokens: {
        input: 11,
        write: 140522,
        read: 0,
      },
      completionTokens: 5,
    };

    const promptMultiplier = getMultiplier({ model, tokenType: 'prompt' });
    const completionMultiplier = getMultiplier({ model, tokenType: 'completion' });
    const writeMultiplier = getCacheMultiplier({ model, cacheType: 'write' }) ?? promptMultiplier;
    const readMultiplier = getCacheMultiplier({ model, cacheType: 'read' }) ?? promptMultiplier;

    // Act
    const result = await spendStructuredTokens(txData, tokenUsage);

    // Calculate expected costs.
    const expectedPromptCost =
      tokenUsage.promptTokens.input * promptMultiplier +
      tokenUsage.promptTokens.write * writeMultiplier +
      tokenUsage.promptTokens.read * readMultiplier;
    const expectedCompletionCost = tokenUsage.completionTokens * completionMultiplier;
    const expectedTotalCost = expectedPromptCost + expectedCompletionCost;
    const expectedBalance = initialBalance - expectedTotalCost;

    // Assert
    expect(result?.completion?.balance).toBeLessThan(initialBalance);
    const allowedDifference = 100;
    expect(Math.abs((result?.completion?.balance ?? 0) - expectedBalance)).toBeLessThan(
      allowedDifference,
    );
    const balanceDecrease = initialBalance - (result?.completion?.balance ?? 0);
    expect(balanceDecrease).toBeCloseTo(expectedTotalCost, 0);

    const expectedPromptTokenValue = -expectedPromptCost;
    const expectedCompletionTokenValue = -expectedCompletionCost;
    expect(result?.prompt?.prompt).toBeCloseTo(expectedPromptTokenValue, 1);
    expect(result?.completion?.completion).toBe(expectedCompletionTokenValue);
  });

  test('should handle zero completion tokens in structured spending', async () => {
    // Arrange
    const userId = new mongoose.Types.ObjectId();
    const initialBalance = 17613154.55;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'claude-3-5-sonnet';
    const txData = {
      user: userId,
      conversationId: 'test-convo',
      model,
      context: 'message',
      balance: { enabled: true },
    };

    const tokenUsage = {
      promptTokens: {
        input: 10,
        write: 100,
        read: 5,
      },
      completionTokens: 0,
    };

    // Act
    const result = await spendStructuredTokens(txData, tokenUsage);

    // Assert
    expect(result.prompt).toBeDefined();
    expect(result.completion).toBeUndefined();
    expect(result?.prompt?.prompt).toBeLessThan(0);
  });

  test('should handle only prompt tokens in structured spending', async () => {
    // Arrange
    const userId = new mongoose.Types.ObjectId();
    const initialBalance = 17613154.55;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'claude-3-5-sonnet';
    const txData = {
      user: userId,
      conversationId: 'test-convo',
      model,
      context: 'message',
      balance: { enabled: true },
    };

    const tokenUsage = {
      promptTokens: {
        input: 10,
        write: 100,
        read: 5,
      },
    };

    // Act
    const result = await spendStructuredTokens(txData, tokenUsage);

    // Assert
    expect(result.prompt).toBeDefined();
    expect(result.completion).toBeUndefined();
    expect(result?.prompt?.prompt).toBeLessThan(0);
  });

  test('should handle undefined token counts in structured spending', async () => {
    // Arrange
    const userId = new mongoose.Types.ObjectId();
    const initialBalance = 17613154.55;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'claude-3-5-sonnet';
    const txData = {
      user: userId,
      conversationId: 'test-convo',
      model,
      context: 'message',
      balance: { enabled: true },
    };

    const tokenUsage = {};

    // Act
    const result = await spendStructuredTokens(txData, tokenUsage);

    // Assert
    expect(result).toEqual({
      prompt: undefined,
      completion: undefined,
    });
  });

  test('should handle incomplete context for completion tokens', async () => {
    // Arrange
    const userId = new mongoose.Types.ObjectId();
    const initialBalance = 17613154.55;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'claude-3-5-sonnet';
    const txData = {
      user: userId,
      conversationId: 'test-convo',
      model,
      context: 'incomplete',
      balance: { enabled: true },
    };

    const tokenUsage = {
      promptTokens: {
        input: 10,
        write: 100,
        read: 5,
      },
      completionTokens: 50,
    };

    // Act
    const result = await spendStructuredTokens(txData, tokenUsage);

    // Assert:
    // (Assuming a multiplier for completion of 15 and a cancel rate of 1.15 as noted in the original test.)
    expect(result?.completion?.completion).toBeCloseTo(-50 * 15 * 1.15, 0);
  });
});

describe('NaN Handling Tests', () => {
  test('should skip transaction creation when rawAmount is NaN', async () => {
    // Arrange
    const userId = new mongoose.Types.ObjectId();
    const initialBalance = 10000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'gpt-3.5-turbo';
    const txData: TxData = {
      user: userId,
      conversationId: 'test-conversation-id',
      model,
      context: 'test',
      endpointTokenConfig: null,
      rawAmount: NaN,
      tokenType: 'prompt',
      balance: { enabled: true },
    };

    // Act
    const result = await createTransaction(txData);

    // Assert: No transaction should be created and balance remains unchanged.
    expect(result).toBeUndefined();
    const balance = await Balance.findOne({ user: userId });
    expect(balance?.tokenCredits).toBe(initialBalance);
  });
});

describe('Transactions Config Tests', () => {
  test('createTransaction should not save when transactions.enabled is false', async () => {
    // Arrange
    const userId = new mongoose.Types.ObjectId();
    const initialBalance = 10000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'gpt-3.5-turbo';
    const txData: TxData = {
      user: userId,
      conversationId: 'test-conversation-id',
      model,
      context: 'test',
      endpointTokenConfig: null,
      rawAmount: -100,
      tokenType: 'prompt',
      transactions: { enabled: false },
    };

    // Act
    const result = await createTransaction(txData);

    // Assert: No transaction should be created
    expect(result).toBeUndefined();
    const transactions = await Transaction.find({ user: userId });
    expect(transactions).toHaveLength(0);
    const balance = await Balance.findOne({ user: userId });
    expect(balance?.tokenCredits).toBe(initialBalance);
  });

  test('createTransaction should save when transactions.enabled is true', async () => {
    // Arrange
    const userId = new mongoose.Types.ObjectId();
    const initialBalance = 10000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'gpt-3.5-turbo';
    const txData: TxData = {
      user: userId,
      conversationId: 'test-conversation-id',
      model,
      context: 'test',
      endpointTokenConfig: null,
      rawAmount: -100,
      tokenType: 'prompt',
      transactions: { enabled: true },
      balance: { enabled: true },
    };

    // Act
    const result = await createTransaction(txData);

    // Assert: Transaction should be created
    expect(result).toBeDefined();
    expect(result?.balance).toBeLessThan(initialBalance);
    const transactions = await Transaction.find({ user: userId });
    expect(transactions).toHaveLength(1);
    expect(transactions[0].rawAmount).toBe(-100);
  });

  test('createTransaction should save when balance.enabled is true even if transactions config is missing', async () => {
    // Arrange
    const userId = new mongoose.Types.ObjectId();
    const initialBalance = 10000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'gpt-3.5-turbo';
    const txData: TxData = {
      user: userId,
      conversationId: 'test-conversation-id',
      model,
      context: 'test',
      endpointTokenConfig: null,
      rawAmount: -100,
      tokenType: 'prompt',
      balance: { enabled: true },
      // No transactions config provided
    };

    // Act
    const result = await createTransaction(txData);

    // Assert: Transaction should be created (backward compatibility)
    expect(result).toBeDefined();
    expect(result?.balance).toBeLessThan(initialBalance);
    const transactions = await Transaction.find({ user: userId });
    expect(transactions).toHaveLength(1);
  });

  test('createTransaction should save transaction but not update balance when balance is disabled but transactions enabled', async () => {
    // Arrange
    const userId = new mongoose.Types.ObjectId();
    const initialBalance = 10000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'gpt-3.5-turbo';
    const txData: TxData = {
      user: userId,
      conversationId: 'test-conversation-id',
      model,
      context: 'test',
      endpointTokenConfig: null,
      rawAmount: -100,
      tokenType: 'prompt',
      transactions: { enabled: true },
      balance: { enabled: false },
    };

    // Act
    const result = await createTransaction(txData);

    // Assert: Transaction should be created but balance unchanged
    expect(result).toBeUndefined();
    const transactions = await Transaction.find({ user: userId });
    expect(transactions).toHaveLength(1);
    expect(transactions[0].rawAmount).toBe(-100);
    const balance = await Balance.findOne({ user: userId });
    expect(balance?.tokenCredits).toBe(initialBalance);
  });

  test('createStructuredTransaction should not save when transactions.enabled is false', async () => {
    // Arrange
    const userId = new mongoose.Types.ObjectId();
    const initialBalance = 10000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'claude-3-5-sonnet';
    const txData: TxData = {
      user: userId,
      conversationId: 'test-conversation-id',
      model,
      context: 'message',
      tokenType: 'prompt',
      inputTokens: -10,
      writeTokens: -100,
      readTokens: -5,
      transactions: { enabled: false },
    };

    // Act
    const result = await createStructuredTransaction(txData);

    // Assert: No transaction should be created
    expect(result).toBeUndefined();
    const transactions = await Transaction.find({ user: userId });
    expect(transactions).toHaveLength(0);
    const balance = await Balance.findOne({ user: userId });
    expect(balance?.tokenCredits).toBe(initialBalance);
  });

  test('createStructuredTransaction should save transaction but not update balance when balance is disabled but transactions enabled', async () => {
    // Arrange
    const userId = new mongoose.Types.ObjectId();
    const initialBalance = 10000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'claude-3-5-sonnet';
    const txData: TxData = {
      user: userId,
      conversationId: 'test-conversation-id',
      model,
      context: 'message',
      tokenType: 'prompt',
      inputTokens: -10,
      writeTokens: -100,
      readTokens: -5,
      transactions: { enabled: true },
      balance: { enabled: false },
    };

    // Act
    const result = await createStructuredTransaction(txData);

    // Assert: Transaction should be created but balance unchanged
    expect(result).toBeUndefined();
    const transactions = await Transaction.find({ user: userId });
    expect(transactions).toHaveLength(1);
    expect(transactions[0].inputTokens).toBe(-10);
    expect(transactions[0].writeTokens).toBe(-100);
    expect(transactions[0].readTokens).toBe(-5);
    const balance = await Balance.findOne({ user: userId });
    expect(balance?.tokenCredits).toBe(initialBalance);
  });
});

describe('Partial endpointTokenConfig fallback', () => {
  const endpointTokenConfig = {
    'custom-model': { prompt: 1.5, completion: 4.5, read: 0.3 },
  };

  test('uses override rates for a listed model', () => {
    expect(getMultiplier({ model: 'custom-model', tokenType: 'prompt', endpointTokenConfig })).toBe(
      1.5,
    );
    expect(
      getCacheMultiplier({ model: 'custom-model', cacheType: 'read', endpointTokenConfig }),
    ).toBe(0.3);
  });

  test('falls back to standard tables for a model absent from the override', () => {
    const fallbackPrompt = getMultiplier({ model: 'gpt-4', tokenType: 'prompt' });
    expect(getMultiplier({ model: 'gpt-4', tokenType: 'prompt', endpointTokenConfig })).toBe(
      fallbackPrompt,
    );
    expect(getMultiplier({ model: 'gpt-4', tokenType: 'prompt', endpointTokenConfig })).not.toBe(
      defaultRate,
    );

    const fallbackCacheRead = getCacheMultiplier({ model: 'claude-3-5-sonnet', cacheType: 'read' });
    expect(
      getCacheMultiplier({ model: 'claude-3-5-sonnet', cacheType: 'read', endpointTokenConfig }),
    ).toBe(fallbackCacheRead);
  });
});

describe('calculateTokenValue Edge Cases', () => {
  test('should derive multiplier from model when valueKey is not provided', async () => {
    const userId = new mongoose.Types.ObjectId();
    const initialBalance = 100000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'gpt-4';
    const promptTokens = 1000;

    const result = await createTransaction({
      user: userId,
      conversationId: 'test-no-valuekey',
      model,
      tokenType: 'prompt',
      rawAmount: -promptTokens,
      context: 'test',
      balance: { enabled: true },
    });

    const expectedRate = getMultiplier({ model, tokenType: 'prompt' });
    expect(result?.rate).toBe(expectedRate);

    const tx = await Transaction.findOne({ user: userId });
    expect(tx?.tokenValue).toBe(-promptTokens * expectedRate);
    expect(tx?.rate).toBe(expectedRate);
  });

  test('should derive valueKey and apply correct rate for an unknown model with tokenType', async () => {
    const userId = new mongoose.Types.ObjectId();
    const initialBalance = 100000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    await createTransaction({
      user: userId,
      conversationId: 'test-unknown-model',
      model: 'some-unrecognized-model-xyz',
      tokenType: 'prompt',
      rawAmount: -500,
      context: 'test',
      balance: { enabled: true },
    });

    const tx = await Transaction.findOne({ user: userId });
    expect(tx?.rate).toBeDefined();
    expect(tx?.rate).toBeGreaterThan(0);
    expect(tx?.tokenValue).toBe((tx?.rawAmount ?? 0) * (tx?.rate ?? 0));
  });

  test('should correctly apply model-derived multiplier without valueKey for completion', async () => {
    const userId = new mongoose.Types.ObjectId();
    const initialBalance = 100000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'claude-opus-4-6';
    const completionTokens = 500;

    const result = await createTransaction({
      user: userId,
      conversationId: 'test-completion-no-valuekey',
      model,
      tokenType: 'completion',
      rawAmount: -completionTokens,
      context: 'test',
      balance: { enabled: true },
    });

    const expectedRate = getMultiplier({ model, tokenType: 'completion' });
    expect(expectedRate).toBe(tokenValues[model].completion);
    expect(result?.rate).toBe(expectedRate);

    const updatedBalance = await Balance.findOne({ user: userId });
    expect(updatedBalance?.tokenCredits).toBeCloseTo(
      initialBalance - completionTokens * expectedRate,
      0,
    );
  });
});

describe('Premium Token Pricing Integration Tests', () => {
  test('spendTokens should apply standard pricing when prompt tokens are below premium threshold', async () => {
    const userId = new mongoose.Types.ObjectId();
    const initialBalance = 100000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'gemini-3.1';
    const promptTokens = 100000;
    const completionTokens = 500;

    const txData = {
      user: userId,
      conversationId: 'test-premium-below',
      model,
      context: 'test',
      endpointTokenConfig: null,
      balance: { enabled: true },
    };

    await spendTokens(txData, { promptTokens, completionTokens });

    const standardPromptRate = tokenValues[model].prompt;
    const standardCompletionRate = tokenValues[model].completion;
    const expectedCost =
      promptTokens * standardPromptRate + completionTokens * standardCompletionRate;

    const updatedBalance = await Balance.findOne({ user: userId });
    expect(updatedBalance?.tokenCredits).toBeCloseTo(initialBalance - expectedCost, 0);
  });

  test('spendTokens should apply premium pricing when prompt tokens exceed premium threshold', async () => {
    const userId = new mongoose.Types.ObjectId();
    const initialBalance = 100000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'gemini-3.1';
    const promptTokens = 250000;
    const completionTokens = 500;

    const txData = {
      user: userId,
      conversationId: 'test-premium-above',
      model,
      context: 'test',
      endpointTokenConfig: null,
      balance: { enabled: true },
    };

    await spendTokens(txData, { promptTokens, completionTokens });

    const premiumPromptRate = premiumTokenValues[model].prompt;
    const premiumCompletionRate = premiumTokenValues[model].completion;
    const expectedCost =
      promptTokens * premiumPromptRate + completionTokens * premiumCompletionRate;

    const updatedBalance = await Balance.findOne({ user: userId });
    expect(updatedBalance?.tokenCredits).toBeCloseTo(initialBalance - expectedCost, 0);
  });

  test('spendTokens should apply standard pricing at exactly the premium threshold', async () => {
    const userId = new mongoose.Types.ObjectId();
    const initialBalance = 100000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'gemini-3.1';
    const promptTokens = premiumTokenValues[model].threshold;
    const completionTokens = 500;

    const txData = {
      user: userId,
      conversationId: 'test-premium-exact',
      model,
      context: 'test',
      endpointTokenConfig: null,
      balance: { enabled: true },
    };

    await spendTokens(txData, { promptTokens, completionTokens });

    const standardPromptRate = tokenValues[model].prompt;
    const standardCompletionRate = tokenValues[model].completion;
    const expectedCost =
      promptTokens * standardPromptRate + completionTokens * standardCompletionRate;

    const updatedBalance = await Balance.findOne({ user: userId });
    expect(updatedBalance?.tokenCredits).toBeCloseTo(initialBalance - expectedCost, 0);
  });

  test('spendStructuredTokens should apply premium pricing when total input tokens exceed threshold', async () => {
    const userId = new mongoose.Types.ObjectId();
    const initialBalance = 100000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'gemini-3.1';
    const txData = {
      user: userId,
      conversationId: 'test-structured-premium',
      model,
      context: 'message',
      endpointTokenConfig: null,
      balance: { enabled: true },
    };

    const tokenUsage = {
      promptTokens: {
        input: 200000,
        write: 10000,
        read: 5000,
      },
      completionTokens: 1000,
    };

    const totalInput =
      tokenUsage.promptTokens.input + tokenUsage.promptTokens.write + tokenUsage.promptTokens.read;

    await spendStructuredTokens(txData, tokenUsage);

    const premiumPromptRate = premiumTokenValues[model].prompt;
    const premiumCompletionRate = premiumTokenValues[model].completion;
    const promptMultiplier = getMultiplier({
      model,
      tokenType: 'prompt',
      inputTokenCount: totalInput,
    });
    const writeMultiplier = getCacheMultiplier({ model, cacheType: 'write' }) ?? promptMultiplier;
    const readMultiplier = getCacheMultiplier({ model, cacheType: 'read' }) ?? promptMultiplier;

    const expectedPromptCost =
      tokenUsage.promptTokens.input * premiumPromptRate +
      tokenUsage.promptTokens.write * writeMultiplier +
      tokenUsage.promptTokens.read * readMultiplier;
    const expectedCompletionCost = tokenUsage.completionTokens * premiumCompletionRate;
    const expectedTotalCost = expectedPromptCost + expectedCompletionCost;

    const updatedBalance = await Balance.findOne({ user: userId });
    expect(totalInput).toBeGreaterThan(premiumTokenValues[model].threshold);
    expect(updatedBalance?.tokenCredits).toBeCloseTo(initialBalance - expectedTotalCost, 0);
  });

  test('spendStructuredTokens should apply standard pricing when total input tokens are below threshold', async () => {
    const userId = new mongoose.Types.ObjectId();
    const initialBalance = 100000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'gemini-3.1';
    const txData = {
      user: userId,
      conversationId: 'test-structured-standard',
      model,
      context: 'message',
      endpointTokenConfig: null,
      balance: { enabled: true },
    };

    const tokenUsage = {
      promptTokens: {
        input: 50000,
        write: 10000,
        read: 5000,
      },
      completionTokens: 1000,
    };

    const totalInput =
      tokenUsage.promptTokens.input + tokenUsage.promptTokens.write + tokenUsage.promptTokens.read;

    await spendStructuredTokens(txData, tokenUsage);

    const standardPromptRate = tokenValues[model].prompt;
    const standardCompletionRate = tokenValues[model].completion;
    const promptMultiplier = getMultiplier({
      model,
      tokenType: 'prompt',
      inputTokenCount: totalInput,
    });
    const writeMultiplier = getCacheMultiplier({ model, cacheType: 'write' }) ?? promptMultiplier;
    const readMultiplier = getCacheMultiplier({ model, cacheType: 'read' }) ?? promptMultiplier;

    const expectedPromptCost =
      tokenUsage.promptTokens.input * standardPromptRate +
      tokenUsage.promptTokens.write * writeMultiplier +
      tokenUsage.promptTokens.read * readMultiplier;
    const expectedCompletionCost = tokenUsage.completionTokens * standardCompletionRate;
    const expectedTotalCost = expectedPromptCost + expectedCompletionCost;

    const updatedBalance = await Balance.findOne({ user: userId });
    expect(totalInput).toBeLessThanOrEqual(premiumTokenValues[model].threshold);
    expect(updatedBalance?.tokenCredits).toBeCloseTo(initialBalance - expectedTotalCost, 0);
  });

  test('spendTokens should apply standard pricing for gemini-3.1-pro-preview below threshold', async () => {
    const userId = new mongoose.Types.ObjectId();
    const initialBalance = 100000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'gemini-3.1-pro-preview';
    const promptTokens = 100000;
    const completionTokens = 500;

    const txData = {
      user: userId,
      conversationId: 'test-gemini31-below',
      model,
      context: 'test',
      endpointTokenConfig: null,
      balance: { enabled: true },
    };

    await spendTokens(txData, { promptTokens, completionTokens });

    const standardPromptRate = tokenValues['gemini-3.1'].prompt;
    const standardCompletionRate = tokenValues['gemini-3.1'].completion;
    const expectedCost =
      promptTokens * standardPromptRate + completionTokens * standardCompletionRate;

    const updatedBalance = await Balance.findOne({ user: userId });
    expect(updatedBalance?.tokenCredits).toBeCloseTo(initialBalance - expectedCost, 0);
  });

  test('spendTokens should apply premium pricing for gemini-3.1-pro-preview above threshold', async () => {
    const userId = new mongoose.Types.ObjectId();
    const initialBalance = 100000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'gemini-3.1-pro-preview';
    const promptTokens = 250000;
    const completionTokens = 500;

    const txData = {
      user: userId,
      conversationId: 'test-gemini31-above',
      model,
      context: 'test',
      endpointTokenConfig: null,
      balance: { enabled: true },
    };

    await spendTokens(txData, { promptTokens, completionTokens });

    const premiumPromptRate = premiumTokenValues['gemini-3.1'].prompt;
    const premiumCompletionRate = premiumTokenValues['gemini-3.1'].completion;
    const expectedCost =
      promptTokens * premiumPromptRate + completionTokens * premiumCompletionRate;

    const updatedBalance = await Balance.findOne({ user: userId });
    expect(updatedBalance?.tokenCredits).toBeCloseTo(initialBalance - expectedCost, 0);
  });

  test('spendTokens should apply standard pricing for gemini-3.1-pro-preview at exactly the threshold', async () => {
    const userId = new mongoose.Types.ObjectId();
    const initialBalance = 100000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'gemini-3.1-pro-preview';
    const promptTokens = premiumTokenValues['gemini-3.1'].threshold;
    const completionTokens = 500;

    const txData = {
      user: userId,
      conversationId: 'test-gemini31-exact',
      model,
      context: 'test',
      endpointTokenConfig: null,
      balance: { enabled: true },
    };

    await spendTokens(txData, { promptTokens, completionTokens });

    const standardPromptRate = tokenValues['gemini-3.1'].prompt;
    const standardCompletionRate = tokenValues['gemini-3.1'].completion;
    const expectedCost =
      promptTokens * standardPromptRate + completionTokens * standardCompletionRate;

    const updatedBalance = await Balance.findOne({ user: userId });
    expect(updatedBalance?.tokenCredits).toBeCloseTo(initialBalance - expectedCost, 0);
  });

  test('spendStructuredTokens should apply premium pricing for gemini-3.1 when total input exceeds threshold', async () => {
    const userId = new mongoose.Types.ObjectId();
    const initialBalance = 100000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'gemini-3.1-pro-preview';
    const txData = {
      user: userId,
      conversationId: 'test-gemini31-structured-premium',
      model,
      context: 'message',
      endpointTokenConfig: null,
      balance: { enabled: true },
    };

    const tokenUsage = {
      promptTokens: {
        input: 200000,
        write: 10000,
        read: 5000,
      },
      completionTokens: 1000,
    };

    const totalInput =
      tokenUsage.promptTokens.input + tokenUsage.promptTokens.write + tokenUsage.promptTokens.read;

    await spendStructuredTokens(txData, tokenUsage);

    const premiumPromptRate = premiumTokenValues['gemini-3.1'].prompt;
    const premiumCompletionRate = premiumTokenValues['gemini-3.1'].completion;
    const promptMultiplier = getMultiplier({
      model,
      tokenType: 'prompt',
      inputTokenCount: totalInput,
    });
    const writeMultiplier = getCacheMultiplier({ model, cacheType: 'write' }) ?? promptMultiplier;
    const readMultiplier = getCacheMultiplier({ model, cacheType: 'read' }) ?? promptMultiplier;

    const expectedPromptCost =
      tokenUsage.promptTokens.input * premiumPromptRate +
      tokenUsage.promptTokens.write * writeMultiplier +
      tokenUsage.promptTokens.read * readMultiplier;
    const expectedCompletionCost = tokenUsage.completionTokens * premiumCompletionRate;
    const expectedTotalCost = expectedPromptCost + expectedCompletionCost;

    const updatedBalance = await Balance.findOne({ user: userId });
    expect(totalInput).toBeGreaterThan(premiumTokenValues['gemini-3.1'].threshold);
    expect(updatedBalance?.tokenCredits).toBeCloseTo(initialBalance - expectedTotalCost, 0);
  });

  test('non-premium models should not be affected by inputTokenCount regardless of prompt size', async () => {
    const userId = new mongoose.Types.ObjectId();
    const initialBalance = 100000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'claude-opus-4-6';
    const promptTokens = 300000;
    const completionTokens = 500;

    const txData = {
      user: userId,
      conversationId: 'test-no-premium',
      model,
      context: 'test',
      endpointTokenConfig: null,
      balance: { enabled: true },
    };

    await spendTokens(txData, { promptTokens, completionTokens });

    const standardPromptRate = getMultiplier({ model, tokenType: 'prompt' });
    const standardCompletionRate = getMultiplier({ model, tokenType: 'completion' });
    const expectedCost =
      promptTokens * standardPromptRate + completionTokens * standardCompletionRate;

    const updatedBalance = await Balance.findOne({ user: userId });
    expect(updatedBalance?.tokenCredits).toBeCloseTo(initialBalance - expectedCost, 0);
  });
});

describe('Balance Reservations', () => {
  const inFuture = () => new Date(Date.now() + 60_000);
  const newId = () => new mongoose.Types.ObjectId().toString();
  const reserve = (user: string, amount: number, reservationId = newId()) =>
    reserveBalance({ user, amount, reservationId, expiresAt: inFuture() });
  const readState = (user: mongoose.Types.ObjectId) =>
    Balance.findOne({ user }).select('+reservations +reservedCredits +pendingRefill').lean();

  /** Runs `interleave` once, immediately before the next `Balance` write executes. */
  const interleaveBeforeNextWrite = (interleave: () => Promise<unknown>) => {
    let fired = false;
    const realUpdateOne = Balance.updateOne.bind(Balance);
    const realBulkWrite = Balance.bulkWrite.bind(Balance);
    const before = (write: () => unknown): unknown => {
      if (fired) {
        return write();
      }
      fired = true;
      return interleave().then(() => write());
    };
    jest
      .spyOn(Balance, 'updateOne')
      .mockImplementation(((...args: Parameters<typeof Balance.updateOne>) =>
        before(() => realUpdateOne(...args))) as unknown as typeof Balance.updateOne);
    jest
      .spyOn(Balance, 'bulkWrite')
      .mockImplementation(((...args: Parameters<typeof Balance.bulkWrite>) =>
        before(() => realBulkWrite(...args))) as unknown as typeof Balance.bulkWrite);
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('returns null when the user has no balance record and no initial balance', async () => {
    await expect(reserve(newId(), 100)).resolves.toBeNull();
  });

  test('creates a missing record from the initial balance and admits against it', async () => {
    const user = new mongoose.Types.ObjectId();

    await expect(
      reserveBalance({
        user: user.toString(),
        amount: 400,
        reservationId: newId(),
        expiresAt: inFuture(),
        initialBalance: { user: user.toString(), tokenCredits: 1000 },
      }),
    ).resolves.toEqual({ reserved: true, balance: 1000 });

    const stored = await readState(user);
    expect(stored?.tokenCredits).toBe(1000);
    expect(stored?.reservedCredits).toBe(400);
  });

  test('never overwrites a record another writer created while initializing', async () => {
    const user = new mongoose.Types.ObjectId();
    const realFindOneAndUpdate = Balance.findOneAndUpdate.bind(Balance);
    jest.spyOn(Balance, 'findOneAndUpdate').mockImplementationOnce(((
      ...args: Parameters<typeof Balance.findOneAndUpdate>
    ) => ({
      lean: () =>
        upsertBalanceFields(user.toString(), { tokenCredits: 50 }).then(() =>
          realFindOneAndUpdate(...args).lean(),
        ),
    })) as unknown as typeof Balance.findOneAndUpdate);

    await expect(
      reserveBalance({
        user: user.toString(),
        amount: 100,
        reservationId: newId(),
        expiresAt: inFuture(),
        initialBalance: { user: user.toString(), tokenCredits: 1000 },
      }),
    ).resolves.toEqual({ reserved: false, balance: 50 });
    expect((await readState(user))?.tokenCredits).toBe(50);
    expect(await Balance.countDocuments({ user })).toBe(1);
  });

  test('creates a missing record under the user id, so racing creators share one record', async () => {
    const reserved = new mongoose.Types.ObjectId();
    const synced = new mongoose.Types.ObjectId();
    const spent = new mongoose.Types.ObjectId();
    const racing = new mongoose.Types.ObjectId();
    const initialReservation = (user: mongoose.Types.ObjectId) =>
      reserveBalance({
        user: user.toString(),
        amount: 400,
        reservationId: newId(),
        expiresAt: inFuture(),
        initialBalance: { user: user.toString(), tokenCredits: 1000 },
      });

    await initialReservation(reserved);
    await upsertBalanceFields(synced.toString(), { tokenCredits: 50 }, { refillAmount: 5 });
    await updateBalance({ user: spent.toString(), incrementValue: 25 });
    const racingResults = await Promise.all(
      Array.from({ length: 10 }, () => initialReservation(racing)),
    );

    for (const user of [reserved, synced, spent, racing]) {
      const records = await Balance.find({ user }).lean();
      expect(records.map((record) => record._id.toString())).toEqual([user.toString()]);
    }
    expect(await Balance.findById(synced).lean()).toMatchObject({
      tokenCredits: 50,
      refillAmount: 5,
    });
    expect((await Balance.findById(spent).lean())?.tokenCredits).toBe(25);
    expect(racingResults.filter((result) => result?.reserved)).toHaveLength(2);
  });

  test('resolves a user with duplicate records to their oldest record on every path', async () => {
    const user = new mongoose.Types.ObjectId();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const newer = mongoose.Types.ObjectId.createFromTime(nowSeconds);
    const older = mongoose.Types.ObjectId.createFromTime(nowSeconds - 3600);
    await Balance.create({ _id: newer, user, tokenCredits: 5000 });
    await Balance.create({ _id: older, user, tokenCredits: 1000 });

    expect((await findBalanceByUser(user.toString()))?._id?.toString()).toBe(older.toString());
    await expect(reserve(user.toString(), 2000)).resolves.toEqual({
      reserved: false,
      balance: 1000,
    });
    await reserve(user.toString(), 400);
    await updateBalance({ user: user.toString(), incrementValue: -100 });
    await upsertBalanceFields(user.toString(), { refillAmount: 7 });

    expect(await Balance.findById(older).select('+reservedCredits').lean()).toMatchObject({
      tokenCredits: 900,
      reservedCredits: 400,
      refillAmount: 7,
    });
    const untouched = await Balance.findById(newer).select('+reservedCredits').lean();
    expect(untouched?.tokenCredits).toBe(5000);
    expect(untouched?.reservedCredits).toBeUndefined();
  });

  test('admits concurrent requests only up to the credits no other request holds', async () => {
    const user = new mongoose.Types.ObjectId();
    await Balance.create({ user, tokenCredits: 1000 });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => reserve(user.toString(), 300)),
    );

    expect(results.filter((result) => result?.reserved)).toHaveLength(3);
    const stored = await readState(user);
    expect(stored?.tokenCredits).toBe(1000);
    expect(stored?.reservations).toHaveLength(3);
    expect(stored?.reservedCredits).toBe(900);
  });

  test('commits each admission of a funded burst on its first write', async () => {
    const user = new mongoose.Types.ObjectId();
    await Balance.create({ user, tokenCredits: 100_000 });
    const realUpdateOne = Balance.updateOne.bind(Balance);
    const writes = jest
      .spyOn(Balance, 'updateOne')
      .mockImplementation(((...args: Parameters<typeof Balance.updateOne>) =>
        new Promise((resolve) => setTimeout(resolve, 25)).then(() =>
          realUpdateOne(...args),
        )) as unknown as typeof Balance.updateOne);

    const results = await Promise.all(
      Array.from({ length: 50 }, () => reserve(user.toString(), 100)),
    );

    expect(results.every((result) => result?.reserved)).toBe(true);
    expect(writes).toHaveBeenCalledTimes(50);
    const stored = await readState(user);
    expect(stored?.reservations).toHaveLength(50);
    expect(stored?.reservedCredits).toBe(5000);
  });

  test('holds whole credits so the running total stays exact', async () => {
    const user = new mongoose.Types.ObjectId();
    await Balance.create({ user, tokenCredits: 1000 });
    const reservationId = newId();

    await expect(reserve(user.toString(), 0.3, reservationId)).resolves.toEqual({
      reserved: true,
      balance: 1000,
    });
    expect((await readState(user))?.reservedCredits).toBe(1);

    await releaseBalanceReservation({ user: user.toString(), reservationId, amount: 0.3 });
    const stored = await readState(user);
    expect(stored?.reservedCredits).toBe(0);
    expect(stored?.reservations).toEqual([]);
  });

  test('releasing a reservation returns its credits to later admissions, once', async () => {
    const user = new mongoose.Types.ObjectId();
    await Balance.create({ user, tokenCredits: 1000 });
    const firstId = newId();

    await expect(reserve(user.toString(), 600, firstId)).resolves.toEqual({
      reserved: true,
      balance: 1000,
    });
    await expect(reserve(user.toString(), 600)).resolves.toEqual({
      reserved: false,
      balance: 400,
    });

    const release = { user: user.toString(), reservationId: firstId, amount: 600 };
    await Promise.all([releaseBalanceReservation(release), releaseBalanceReservation(release)]);
    expect((await readState(user))?.reservedCredits).toBe(0);

    await expect(reserve(user.toString(), 600)).resolves.toEqual({
      reserved: true,
      balance: 1000,
    });
  });

  test('prunes expired reservations together with their credits', async () => {
    const user = new mongoose.Types.ObjectId();
    await Balance.create({
      user,
      tokenCredits: 1000,
      reservedCredits: 900,
      reservations: [{ id: 'stale', amount: 900, expiresAt: new Date(Date.now() - 1000) }],
    });

    const reservationId = newId();
    await expect(reserve(user.toString(), 600, reservationId)).resolves.toEqual({
      reserved: true,
      balance: 1000,
    });

    const stored = await readState(user);
    expect(stored?.reservations?.map((reservation) => reservation.id)).toEqual([reservationId]);
    expect(stored?.reservedCredits).toBe(600);
  });

  test('prunes a backlog of expired reservations in one bulk write', async () => {
    const user = new mongoose.Types.ObjectId();
    const expiredAt = new Date(Date.now() - 1000);
    await Balance.create({
      user,
      tokenCredits: 1000,
      reservedCredits: 201,
      reservations: [
        { id: 'live', amount: 1, expiresAt: inFuture() },
        ...Array.from({ length: 200 }, (_, i) => ({
          id: `stale-${i}`,
          amount: 1,
          expiresAt: expiredAt,
        })),
      ],
    });
    const writes = jest.spyOn(Balance, 'updateOne');
    const bulkWrites = jest.spyOn(Balance, 'bulkWrite');

    const reservationId = newId();
    await expect(reserve(user.toString(), 100, reservationId)).resolves.toEqual({
      reserved: true,
      balance: 999,
    });

    expect(bulkWrites).toHaveBeenCalledTimes(1);
    expect(bulkWrites.mock.calls[0][0]).toHaveLength(200);
    expect(writes).toHaveBeenCalledTimes(1);
    const stored = await readState(user);
    expect(stored?.reservations?.map((reservation) => reservation.id)).toEqual([
      'live',
      reservationId,
    ]);
    expect(stored?.reservedCredits).toBe(101);
  });

  test('prunes the rest in the same write when one expired reservation is renewed mid-attempt', async () => {
    const user = new mongoose.Types.ObjectId();
    const expiredAt = new Date(Date.now() - 1000);
    await Balance.create({
      user,
      tokenCredits: 1000,
      reservedCredits: 900,
      reservations: [
        { id: 'renewed', amount: 400, expiresAt: expiredAt },
        { id: 'stale', amount: 500, expiresAt: expiredAt },
      ],
    });

    interleaveBeforeNextWrite(() =>
      renewBalanceReservation({
        user: user.toString(),
        reservationId: 'renewed',
        expiresAt: inFuture(),
      }),
    );

    const reads = jest.spyOn(Balance, 'findOne');
    const reservationId = newId();
    await expect(reserve(user.toString(), 600, reservationId)).resolves.toEqual({
      reserved: true,
      balance: 600,
    });
    expect(reads).toHaveBeenCalledTimes(2);
    const stored = await readState(user);
    expect(stored?.reservations?.map((reservation) => reservation.id)).toEqual([
      'renewed',
      reservationId,
    ]);
    expect(stored?.reservedCredits).toBe(1000);
  });

  test('renews a live reservation and never resurrects a released one', async () => {
    const user = new mongoose.Types.ObjectId();
    await Balance.create({ user, tokenCredits: 1000 });
    const liveId = newId();
    const releasedId = newId();
    await reserve(user.toString(), 300, liveId);
    await reserve(user.toString(), 200, releasedId);
    await releaseBalanceReservation({
      user: user.toString(),
      reservationId: releasedId,
      amount: 200,
    });

    const renewedUntil = new Date(Date.now() + 3_600_000);
    await renewBalanceReservation({
      user: user.toString(),
      reservationId: liveId,
      expiresAt: renewedUntil,
    });
    await renewBalanceReservation({
      user: user.toString(),
      reservationId: releasedId,
      expiresAt: renewedUntil,
    });

    const stored = await readState(user);
    expect(stored?.reservations).toEqual([{ id: liveId, amount: 300, expiresAt: renewedUntil }]);
    expect(stored?.reservedCredits).toBe(300);
  });

  test('keeps a reservation that was renewed after a pruning read saw it expired', async () => {
    const user = new mongoose.Types.ObjectId();
    await Balance.create({
      user,
      tokenCredits: 1000,
      reservedCredits: 900,
      reservations: [{ id: 'renewed', amount: 900, expiresAt: new Date(Date.now() - 1000) }],
    });

    interleaveBeforeNextWrite(() =>
      renewBalanceReservation({
        user: user.toString(),
        reservationId: 'renewed',
        expiresAt: inFuture(),
      }),
    );

    await expect(reserve(user.toString(), 600)).resolves.toEqual({
      reserved: false,
      balance: 100,
    });
    const stored = await readState(user);
    expect(stored?.reservations?.map((reservation) => reservation.id)).toEqual(['renewed']);
    expect(stored?.reservedCredits).toBe(900);
  });

  test('admits a zero-cost request without storing a reservation', async () => {
    const user = new mongoose.Types.ObjectId();
    await Balance.create({ user, tokenCredits: 0 });

    await expect(reserve(user.toString(), 0)).resolves.toEqual({ reserved: true, balance: 0 });

    const stored = await readState(user);
    expect(stored?.reservations).toBeUndefined();
    expect(stored?.reservedCredits).toBeUndefined();
  });

  test('reports only unexpired reservations when a read asks for the reserved credits', async () => {
    const user = new mongoose.Types.ObjectId();
    await Balance.create({
      user,
      tokenCredits: 1000,
      reservedCredits: 1200,
      reservations: [
        { id: 'live', amount: 300, expiresAt: inFuture() },
        { id: 'stale', amount: 900, expiresAt: new Date(Date.now() - 1000) },
      ],
    });

    const record = await findBalanceByUser(user.toString(), { includeReservedCredits: true });

    expect(record?.tokenCredits).toBe(1000);
    expect(record?.reservedCredits).toBe(300);
    expect(record).not.toHaveProperty('reservations');
  });

  test('keeps reservation state out of ordinary balance reads and writes', async () => {
    const user = new mongoose.Types.ObjectId();
    await Balance.create({ user, tokenCredits: 1000 });
    await reserve(user.toString(), 100);

    const hidden = ['reservations', 'reservedCredits', 'pendingRefill'];
    const record = await findBalanceByUser(user.toString());
    const synced = await upsertBalanceFields(user.toString(), { refillAmount: 5 });
    const spent = await updateBalance({ user: user.toString(), incrementValue: -10 });

    expect(record?.tokenCredits).toBe(1000);
    expect(spent.tokenCredits).toBe(990);
    for (const read of [record, synced, spent]) {
      for (const field of hidden) {
        expect(read).not.toHaveProperty(field);
      }
    }
  });

  test('removes a reservation whose write committed but failed to acknowledge', async () => {
    const user = new mongoose.Types.ObjectId();
    await Balance.create({ user, tokenCredits: 1000 });
    const realUpdateOne = Balance.updateOne.bind(Balance);
    jest.spyOn(Balance, 'updateOne').mockImplementationOnce(((
      ...args: Parameters<typeof Balance.updateOne>
    ) =>
      realUpdateOne(...args).then(() => {
        throw new Error('connection reset');
      })) as unknown as typeof Balance.updateOne);

    await expect(reserve(user.toString(), 400)).rejects.toThrow('connection reset');

    const stored = await readState(user);
    expect(stored?.reservations).toEqual([]);
    expect(stored?.reservedCredits).toBe(0);
  });

  test('re-reads when a spend lands between the read and the write', async () => {
    const user = new mongoose.Types.ObjectId();
    await Balance.create({ user, tokenCredits: 1000 });

    interleaveBeforeNextWrite(() =>
      Balance.collection.updateOne({ user }, { $inc: { tokenCredits: -800 } }),
    );

    await expect(reserve(user.toString(), 500)).resolves.toEqual({
      reserved: false,
      balance: 200,
    });
    expect((await readState(user))?.reservedCredits).toBeUndefined();
  });

  test('re-reads when another admission takes the credits between the read and the write', async () => {
    const user = new mongoose.Types.ObjectId();
    await Balance.create({ user, tokenCredits: 1000 });

    interleaveBeforeNextWrite(() => reserve(user.toString(), 800));

    await expect(reserve(user.toString(), 500)).resolves.toEqual({
      reserved: false,
      balance: 200,
    });
    expect((await readState(user))?.reservedCredits).toBe(800);
  });

  describe('auto-refill', () => {
    const refillable = {
      tokenCredits: 0,
      autoRefillEnabled: true,
      refillAmount: 1000,
      refillIntervalValue: 30,
      refillIntervalUnit: 'days' as const,
      lastRefill: new Date('2020-01-01T00:00:00.000Z'),
    };

    test('applies one refill per eligibility window across concurrent admissions', async () => {
      const user = new mongoose.Types.ObjectId();
      await Balance.create({ user, ...refillable });

      const results = await Promise.all(
        Array.from({ length: 10 }, () => reserve(user.toString(), 150)),
      );

      expect(results.filter((result) => result?.reserved)).toHaveLength(6);
      const stored = await readState(user);
      expect(stored?.tokenCredits).toBe(1000);
      expect(stored?.lastRefill.getTime()).toBeGreaterThan(refillable.lastRefill.getTime());
      expect(stored?.pendingRefill).toBeUndefined();
      const refills = await Transaction.find({ user, context: 'autoRefill' }).lean();
      expect(refills).toHaveLength(1);
      expect(refills[0].rawAmount).toBe(1000);
    });

    test.each([
      ['lastRefill advances', { lastRefill: new Date() }, 0],
      ['auto-refill is disabled', { autoRefillEnabled: false }, 0],
      ['the refill amount changes', { refillAmount: 10 }, 10],
      ['the refill interval lengthens', { refillIntervalValue: 100_000 }, 0],
    ])(
      'applies the current refill settings when %s mid-attempt',
      async (_case, change, credits) => {
        const user = new mongoose.Types.ObjectId();
        await Balance.create({ user, ...refillable });

        interleaveBeforeNextWrite(() => Balance.collection.updateOne({ user }, { $set: change }));

        await expect(reserve(user.toString(), 150)).resolves.toEqual({
          reserved: false,
          balance: credits,
        });
        expect((await readState(user))?.tokenCredits).toBe(credits);
        expect(await Transaction.countDocuments({ user, context: 'autoRefill' })).toBe(
          credits > 0 ? 1 : 0,
        );
      },
    );

    test('does not refill when a release frees enough credits mid-attempt', async () => {
      const user = new mongoose.Types.ObjectId();
      await Balance.create({ user, ...refillable, tokenCredits: 1000 });
      const heldId = newId();
      await reserve(user.toString(), 900, heldId);

      interleaveBeforeNextWrite(() =>
        releaseBalanceReservation({ user: user.toString(), reservationId: heldId, amount: 900 }),
      );

      await expect(reserve(user.toString(), 200)).resolves.toEqual({
        reserved: true,
        balance: 1000,
      });
      const stored = await readState(user);
      expect(stored?.tokenCredits).toBe(1000);
      expect(stored?.lastRefill.getTime()).toBe(refillable.lastRefill.getTime());
      expect(await Transaction.countDocuments({ user, context: 'autoRefill' })).toBe(0);
    });

    test('still applies a due refill when the refilled balance cannot cover the request', async () => {
      const user = new mongoose.Types.ObjectId();
      await Balance.create({ user, ...refillable, refillAmount: 100 });

      await expect(reserve(user.toString(), 500)).resolves.toEqual({
        reserved: false,
        balance: 100,
      });
      const stored = await readState(user);
      expect(stored?.tokenCredits).toBe(100);
      expect(stored?.reservations).toBeUndefined();
    });

    test.each([
      ['covers the request exactly', 100, true, 100],
      ['still falls short', 10, false, 10],
    ])(
      'applies a refill whose interval is due again at once only once per admission when it %s',
      async (_case, refillAmount, reserved, credits) => {
        const user = new mongoose.Types.ObjectId();
        await Balance.create({ user, ...refillable, refillAmount, refillIntervalValue: 0 });

        await expect(reserve(user.toString(), 100)).resolves.toEqual({
          reserved,
          balance: credits,
        });
        expect((await readState(user))?.tokenCredits).toBe(credits);
        expect(await Transaction.countDocuments({ user, context: 'autoRefill' })).toBe(1);
      },
    );

    test('does not refill while the unreserved balance covers the request', async () => {
      const user = new mongoose.Types.ObjectId();
      await Balance.create({ user, ...refillable, tokenCredits: 500 });

      await expect(reserve(user.toString(), 100)).resolves.toEqual({
        reserved: true,
        balance: 500,
      });
      expect((await readState(user))?.tokenCredits).toBe(500);
    });

    test('records the ledger transaction of a refill whose first recording failed', async () => {
      const user = new mongoose.Types.ObjectId();
      await Balance.create({ user, ...refillable });
      const save = jest
        .spyOn(Transaction.prototype, 'save')
        .mockRejectedValue(new Error('ledger unavailable'));

      await expect(reserve(user.toString(), 150)).resolves.toEqual({
        reserved: true,
        balance: 1000,
      });
      const applied = await readState(user);
      expect(applied?.tokenCredits).toBe(1000);
      expect(applied?.pendingRefill?.rawAmount).toBe(1000);
      expect(await Transaction.countDocuments({ user, context: 'autoRefill' })).toBe(0);

      save.mockRestore();
      await reserve(user.toString(), 150);

      const settled = await readState(user);
      expect(settled?.tokenCredits).toBe(1000);
      expect(settled?.pendingRefill).toBeUndefined();
      const refills = await Transaction.find({ user, context: 'autoRefill' }).lean();
      expect(refills.map((refill) => refill._id.toString())).toEqual([
        applied?.pendingRefill?.transactionId.toString(),
      ]);
    });

    test('does not duplicate a ledger transaction that was recorded before its marker cleared', async () => {
      const user = new mongoose.Types.ObjectId();
      const transactionId = new mongoose.Types.ObjectId();
      await Transaction.create({
        _id: transactionId,
        user,
        tokenType: 'credits',
        context: 'autoRefill',
        rawAmount: 1000,
      });
      await Balance.create({
        user,
        ...refillable,
        tokenCredits: 1000,
        lastRefill: new Date(),
        pendingRefill: { transactionId, rawAmount: 1000 },
      });

      await reserve(user.toString(), 150);

      expect((await readState(user))?.pendingRefill).toBeUndefined();
      expect(await Transaction.countDocuments({ user, context: 'autoRefill' })).toBe(1);
    });
  });
});
