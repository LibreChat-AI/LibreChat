/**
 * Real-DB parity tests for the bulk transaction path.
 *
 * Each test uses the actual getMultiplier/getCacheMultiplier pricing functions
 * (the same ones the legacy createTransaction path uses) and runs the bulk path
 * against a real MongoMemoryServer instance.
 *
 * The assertion pattern: compute the expected tokenValue/rate/rawAmount from the
 * pricing functions directly, then verify the DB state matches exactly. Since both
 * legacy (createTransaction) and bulk (prepareTokenSpend + bulkWriteTransactions)
 * call the same pricing functions with the same inputs, their outputs must be
 * numerically identical.
 */
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  tokenValues,
  CANCEL_RATE,
  createMethods,
  balanceSchema,
  transactionSchema,
  premiumTokenValues,
} from '@librechat/data-schemas';
import type { PricingFns, TxMetadata } from './transactions';
import {
  prepareStructuredTokenSpend,
  bulkWriteTransactions,
  prepareTokenSpend,
} from './transactions';

/** Inlined from packages/data-schemas/src/methods/test-helpers.ts — keep in sync */
function findMatchingPattern(
  modelName: string,
  tokensMap: Record<string, number | Record<string, number>>,
): string | undefined {
  const keys = Object.keys(tokensMap);
  const lowerModelName = modelName.toLowerCase();
  for (let i = keys.length - 1; i >= 0; i--) {
    if (lowerModelName.includes(keys[i])) {
      return keys[i];
    }
  }
  return undefined;
}

/** Inlined from packages/data-schemas/src/methods/test-helpers.ts — keep in sync */
function matchModelName(modelName: string, _endpoint?: string): string | undefined {
  return typeof modelName === 'string' ? modelName : undefined;
}

jest.mock('@librechat/data-schemas', () => {
  const actual = jest.requireActual('@librechat/data-schemas');
  return {
    ...actual,
    logger: { debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() },
  };
});

let mongoServer: MongoMemoryServer;
let Transaction: mongoose.Model<unknown>;
let Balance: mongoose.Model<unknown>;
let dbMethods: ReturnType<typeof createMethods>;
let pricing: PricingFns;
let getMultiplier: ReturnType<typeof createMethods>['getMultiplier'];
let getCacheMultiplier: ReturnType<typeof createMethods>['getCacheMultiplier'];

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  Transaction = mongoose.models.Transaction || mongoose.model('Transaction', transactionSchema);
  Balance = mongoose.models.Balance || mongoose.model('Balance', balanceSchema);
  dbMethods = createMethods(mongoose, { matchModelName, findMatchingPattern });
  getMultiplier = dbMethods.getMultiplier;
  getCacheMultiplier = dbMethods.getCacheMultiplier;
  pricing = { getMultiplier, getCacheMultiplier };
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
});

const dbOps = () => ({
  insertMany: dbMethods.bulkInsertTransactions,
  updateBalance: dbMethods.updateBalance,
});

function txMeta(user: string, extra: Partial<TxMetadata> = {}): TxMetadata {
  return {
    user,
    conversationId: 'test-convo',
    context: 'test',
    balance: { enabled: true },
    transactions: { enabled: true },
    ...extra,
  };
}

describe('Standard token parity', () => {
  test('balance should decrease by promptCost + completionCost — identical to legacy path', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const initialBalance = 10000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'gpt-3.5-turbo';
    const promptTokens = 100;
    const completionTokens = 50;

    const promptMultiplier = getMultiplier({
      model,
      tokenType: 'prompt',
      inputTokenCount: promptTokens,
    });
    const completionMultiplier = getMultiplier({
      model,
      tokenType: 'completion',
      inputTokenCount: promptTokens,
    });
    const expectedCost = promptTokens * promptMultiplier + completionTokens * completionMultiplier;
    const expectedBalance = initialBalance - expectedCost;

    const entries = prepareTokenSpend(
      txMeta(userId, { model }),
      { promptTokens, completionTokens },
      pricing,
    );
    await bulkWriteTransactions({ user: userId, docs: entries }, dbOps());

    const balance = (await Balance.findOne({ user: userId }).lean()) as Record<string, unknown>;
    expect(balance.tokenCredits).toBeCloseTo(expectedBalance, 0);

    const txns = (await Transaction.find({ user: userId }).lean()) as Record<string, unknown>[];
    expect(txns).toHaveLength(2);
    const promptTx = txns.find((t) => t.tokenType === 'prompt');
    const completionTx = txns.find((t) => t.tokenType === 'completion');
    expect(promptTx!.rawAmount).toBe(-promptTokens);
    expect(promptTx!.rate).toBe(promptMultiplier);
    expect(promptTx!.tokenValue).toBe(-promptTokens * promptMultiplier);
    expect(completionTx!.rawAmount).toBe(-completionTokens);
    expect(completionTx!.rate).toBe(completionMultiplier);
    expect(completionTx!.tokenValue).toBe(-completionTokens * completionMultiplier);
  });

  test('balance unchanged when balance.enabled is false — identical to legacy path', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const initialBalance = 10000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const entries = prepareTokenSpend(
      txMeta(userId, { model: 'gpt-3.5-turbo', balance: { enabled: false } }),
      { promptTokens: 100, completionTokens: 50 },
      pricing,
    );
    await bulkWriteTransactions({ user: userId, docs: entries }, dbOps());

    const balance = (await Balance.findOne({ user: userId }).lean()) as Record<string, unknown>;
    expect(balance.tokenCredits).toBe(initialBalance);
    const txns = await Transaction.find({ user: userId }).lean();
    expect(txns).toHaveLength(2); // transactions still inserted
  });

  test('no docs when transactions.enabled is false — identical to legacy path', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const initialBalance = 10000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const entries = prepareTokenSpend(
      txMeta(userId, { model: 'gpt-3.5-turbo', transactions: { enabled: false } }),
      { promptTokens: 100, completionTokens: 50 },
      pricing,
    );
    await bulkWriteTransactions({ user: userId, docs: entries }, dbOps());

    const txns = await Transaction.find({ user: userId }).lean();
    expect(txns).toHaveLength(0);
    const balance = (await Balance.findOne({ user: userId }).lean()) as Record<string, unknown>;
    expect(balance.tokenCredits).toBe(initialBalance);
  });

  test('abort context — transactions inserted, no balance update when balance not passed', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const initialBalance = 10000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'gpt-3.5-turbo';
    const entries = prepareTokenSpend(
      txMeta(userId, { model, context: 'abort', balance: undefined }),
      { promptTokens: 100, completionTokens: 50 },
      pricing,
    );
    await bulkWriteTransactions({ user: userId, docs: entries }, dbOps());

    const txns = await Transaction.find({ user: userId }).lean();
    expect(txns).toHaveLength(2);
    const balance = (await Balance.findOne({ user: userId }).lean()) as Record<string, unknown>;
    expect(balance.tokenCredits).toBe(initialBalance);
  });

  test('NaN promptTokens — only completion doc inserted, identical to legacy', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const initialBalance = 10000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const entries = prepareTokenSpend(
      txMeta(userId, { model: 'gpt-3.5-turbo' }),
      { promptTokens: NaN, completionTokens: 50 },
      pricing,
    );
    await bulkWriteTransactions({ user: userId, docs: entries }, dbOps());

    const txns = (await Transaction.find({ user: userId }).lean()) as Record<string, unknown>[];
    expect(txns).toHaveLength(1);
    expect(txns[0].tokenType).toBe('completion');
  });

  test('zero tokens produce docs with rawAmount=0, tokenValue=0', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    await Balance.create({ user: userId, tokenCredits: 10000 });

    const entries = prepareTokenSpend(
      txMeta(userId, { model: 'gpt-3.5-turbo' }),
      { promptTokens: 0, completionTokens: 0 },
      pricing,
    );
    await bulkWriteTransactions({ user: userId, docs: entries }, dbOps());

    const txns = (await Transaction.find({ user: userId }).lean()) as Record<string, unknown>[];
    expect(txns).toHaveLength(2);
    expect(txns.every((t) => t.rawAmount === 0)).toBe(true);
    expect(txns.every((t) => t.tokenValue === 0)).toBe(true);
  });
});

describe('CANCEL_RATE parity (incomplete context)', () => {
  test('CANCEL_RATE applied to completion token — same tokenValue as legacy', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    await Balance.create({ user: userId, tokenCredits: 10000000 });

    const model = 'claude-3-5-sonnet';
    const completionTokens = 50;
    const promptTokens = 10;

    const completionMultiplier = getMultiplier({
      model,
      tokenType: 'completion',
      inputTokenCount: promptTokens,
    });
    const expectedCompletionTokenValue = Math.ceil(
      -completionTokens * completionMultiplier * CANCEL_RATE,
    );

    const entries = prepareTokenSpend(
      txMeta(userId, { model, context: 'incomplete' }),
      { promptTokens, completionTokens },
      pricing,
    );
    await bulkWriteTransactions({ user: userId, docs: entries }, dbOps());

    const txns = (await Transaction.find({ user: userId }).lean()) as Record<string, unknown>[];
    const completionTx = txns.find((t) => t.tokenType === 'completion');
    expect(completionTx!.tokenValue).toBe(expectedCompletionTokenValue);
    expect(completionTx!.rate).toBeCloseTo(completionMultiplier * CANCEL_RATE, 5);
  });

  test('CANCEL_RATE NOT applied to prompt tokens in incomplete context', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    await Balance.create({ user: userId, tokenCredits: 10000000 });

    const model = 'claude-3-5-sonnet';
    const promptTokens = 100;

    const promptMultiplier = getMultiplier({
      model,
      tokenType: 'prompt',
      inputTokenCount: promptTokens,
    });

    const entries = prepareTokenSpend(
      txMeta(userId, { model, context: 'incomplete' }),
      { promptTokens, completionTokens: 0 },
      pricing,
    );
    await bulkWriteTransactions({ user: userId, docs: entries }, dbOps());

    const txns = (await Transaction.find({ user: userId }).lean()) as Record<string, unknown>[];
    const promptTx = txns.find((t) => t.tokenType === 'prompt');
    expect(promptTx!.rate).toBe(promptMultiplier); // no CANCEL_RATE
  });
});

describe('Structured token parity', () => {
  test('balance deduction identical to legacy spendStructuredTokens', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const initialBalance = 17613154.55;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'claude-3-5-sonnet';
    const tokenUsage = {
      promptTokens: { input: 11, write: 140522, read: 0 },
      completionTokens: 5,
    };

    const promptMultiplier = getMultiplier({
      model,
      tokenType: 'prompt',
      inputTokenCount: 11 + 140522,
    });
    const completionMultiplier = getMultiplier({
      model,
      tokenType: 'completion',
      inputTokenCount: 11 + 140522,
    });
    const writeMultiplier = getCacheMultiplier({ model, cacheType: 'write' }) ?? promptMultiplier;
    const readMultiplier = getCacheMultiplier({ model, cacheType: 'read' }) ?? promptMultiplier;

    const expectedPromptCost =
      tokenUsage.promptTokens.input * promptMultiplier +
      tokenUsage.promptTokens.write * writeMultiplier +
      tokenUsage.promptTokens.read * readMultiplier;
    const expectedCompletionCost = tokenUsage.completionTokens * completionMultiplier;
    const expectedTotalCost = expectedPromptCost + expectedCompletionCost;
    const expectedBalance = initialBalance - expectedTotalCost;

    const entries = prepareStructuredTokenSpend(txMeta(userId, { model }), tokenUsage, pricing);
    await bulkWriteTransactions({ user: userId, docs: entries }, dbOps());

    const balance = (await Balance.findOne({ user: userId }).lean()) as Record<string, unknown>;
    expect(Math.abs((balance.tokenCredits as number) - expectedBalance)).toBeLessThan(100);

    const txns = (await Transaction.find({ user: userId }).lean()) as Record<string, unknown>[];
    const promptTx = txns.find((t) => t.tokenType === 'prompt');
    expect(promptTx!.inputTokens).toBe(-11);
    expect(promptTx!.writeTokens).toBe(-140522);
    expect(Math.abs(Number(promptTx!.readTokens ?? 0))).toBe(0);
  });

  test('structured tokens with both cache_creation and cache_read', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const initialBalance = 10000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'claude-3-5-sonnet';
    const tokenUsage = {
      promptTokens: { input: 100, write: 50, read: 30 },
      completionTokens: 80,
    };
    const totalInput = 180;

    const promptMultiplier = getMultiplier({
      model,
      tokenType: 'prompt',
      inputTokenCount: totalInput,
    });
    const writeMultiplier = getCacheMultiplier({ model, cacheType: 'write' }) ?? promptMultiplier;
    const readMultiplier = getCacheMultiplier({ model, cacheType: 'read' }) ?? promptMultiplier;
    const completionMultiplier = getMultiplier({
      model,
      tokenType: 'completion',
      inputTokenCount: totalInput,
    });

    const expectedPromptCost = 100 * promptMultiplier + 50 * writeMultiplier + 30 * readMultiplier;
    const expectedCost = expectedPromptCost + 80 * completionMultiplier;

    const entries = prepareStructuredTokenSpend(txMeta(userId, { model }), tokenUsage, pricing);
    await bulkWriteTransactions({ user: userId, docs: entries }, dbOps());

    const txns = (await Transaction.find({ user: userId }).lean()) as Record<string, unknown>[];
    expect(txns).toHaveLength(2);
    const promptTx = txns.find((t) => t.tokenType === 'prompt');
    expect(promptTx!.inputTokens).toBe(-100);
    expect(promptTx!.writeTokens).toBe(-50);
    expect(promptTx!.readTokens).toBe(-30);

    const balance = (await Balance.findOne({ user: userId }).lean()) as Record<string, unknown>;
    expect(
      Math.abs((balance.tokenCredits as number) - (initialBalance - expectedCost)),
    ).toBeLessThan(1);
  });

  test('CANCEL_RATE applied to completion in structured incomplete context', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    await Balance.create({ user: userId, tokenCredits: 17613154.55 });

    const model = 'claude-3-5-sonnet';
    const tokenUsage = {
      promptTokens: { input: 10, write: 100, read: 5 },
      completionTokens: 50,
    };

    const completionMultiplier = getMultiplier({
      model,
      tokenType: 'completion',
      inputTokenCount: 115,
    });
    const expectedCompletionTokenValue = Math.ceil(-50 * completionMultiplier * CANCEL_RATE);

    const entries = prepareStructuredTokenSpend(
      txMeta(userId, { model, context: 'incomplete' }),
      tokenUsage,
      pricing,
    );
    await bulkWriteTransactions({ user: userId, docs: entries }, dbOps());

    const txns = (await Transaction.find({ user: userId }).lean()) as Record<string, unknown>[];
    const completionTx = txns.find((t) => t.tokenType === 'completion');
    expect(completionTx!.tokenValue).toBeCloseTo(expectedCompletionTokenValue, 0);
  });
});

describe('One-hour cache write parity', () => {
  test('bulk and legacy paths bill 1-hour writes identically, long-context tier included', async () => {
    const model = 'claude-haiku-5-5';
    const { threshold } = premiumTokenValues[model];
    const tokenUsage = {
      promptTokens: { input: threshold, write: 3000, write1h: 2000, read: 500 },
      completionTokens: 40,
    };
    const bulkUser = new mongoose.Types.ObjectId().toString();
    const legacyUser = new mongoose.Types.ObjectId().toString();
    await Balance.create({ user: bulkUser, tokenCredits: 10000000 });
    await Balance.create({ user: legacyUser, tokenCredits: 10000000 });

    const entries = prepareStructuredTokenSpend(txMeta(bulkUser, { model }), tokenUsage, pricing);
    await bulkWriteTransactions({ user: bulkUser, docs: entries }, dbOps());
    await dbMethods.spendStructuredTokens(
      {
        user: legacyUser,
        conversationId: 'test-convo',
        context: 'test',
        model,
        balance: { enabled: true },
      },
      tokenUsage,
    );

    const inputTokenCount = threshold + 3000 + 500;
    const promptRate = getMultiplier({ model, tokenType: 'prompt', inputTokenCount });
    const expectedPrompt =
      threshold * promptRate +
      1000 * getCacheMultiplier({ model, cacheType: 'write', inputTokenCount })! +
      2000 * getCacheMultiplier({ model, cacheType: 'write1h', inputTokenCount })! +
      500 * getCacheMultiplier({ model, cacheType: 'read', inputTokenCount })!;
    expect(getCacheMultiplier({ model, cacheType: 'write1h', inputTokenCount })).toBe(
      premiumTokenValues[model].prompt * 2,
    );

    const prompts = (await Transaction.find({ tokenType: 'prompt' }).lean()) as Record<
      string,
      unknown
    >[];
    expect(prompts).toHaveLength(2);
    for (const tx of prompts) {
      expect(tx.tokenValue as number).toBeCloseTo(-expectedPrompt);
      expect(tx.writeTokens).toBe(-3000);
    }
    const [bulkBalance, legacyBalance] = (await Promise.all([
      Balance.findOne({ user: bulkUser }).lean(),
      Balance.findOne({ user: legacyUser }).lean(),
    ])) as Record<string, number>[];
    expect(bulkBalance.tokenCredits).toBeCloseTo(legacyBalance.tokenCredits);
  });
});

describe('Premium pricing parity', () => {
  test('standard pricing below threshold — identical to legacy', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const initialBalance = 100000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'gemini-3.1';
    const promptTokens = 100000;
    const completionTokens = 500;

    const standardPromptRate = (tokenValues as Record<string, Record<string, number>>)[model]
      .prompt;
    const standardCompletionRate = (tokenValues as Record<string, Record<string, number>>)[model]
      .completion;
    const expectedCost =
      promptTokens * standardPromptRate + completionTokens * standardCompletionRate;

    const entries = prepareTokenSpend(
      txMeta(userId, { model }),
      { promptTokens, completionTokens },
      pricing,
    );
    await bulkWriteTransactions({ user: userId, docs: entries }, dbOps());

    const balance = (await Balance.findOne({ user: userId }).lean()) as Record<string, unknown>;
    expect(balance.tokenCredits).toBeCloseTo(initialBalance - expectedCost, 0);
  });

  test('premium pricing above threshold — identical to legacy', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const initialBalance = 100000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'gemini-3.1';
    const promptTokens = 250000;
    const completionTokens = 500;

    const premiumPromptRate = (premiumTokenValues as Record<string, Record<string, number>>)[model]
      .prompt;
    const premiumCompletionRate = (premiumTokenValues as Record<string, Record<string, number>>)[
      model
    ].completion;
    const expectedCost =
      promptTokens * premiumPromptRate + completionTokens * premiumCompletionRate;

    const entries = prepareTokenSpend(
      txMeta(userId, { model }),
      { promptTokens, completionTokens },
      pricing,
    );
    await bulkWriteTransactions({ user: userId, docs: entries }, dbOps());

    const balance = (await Balance.findOne({ user: userId }).lean()) as Record<string, unknown>;
    expect(balance.tokenCredits).toBeCloseTo(initialBalance - expectedCost, 0);
  });

  test('standard pricing at exactly the threshold — identical to legacy', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const initialBalance = 100000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'gemini-3.1';
    const promptTokens = (premiumTokenValues as Record<string, Record<string, number>>)[model]
      .threshold;
    const completionTokens = 500;

    const standardPromptRate = (tokenValues as Record<string, Record<string, number>>)[model]
      .prompt;
    const standardCompletionRate = (tokenValues as Record<string, Record<string, number>>)[model]
      .completion;
    const expectedCost =
      promptTokens * standardPromptRate + completionTokens * standardCompletionRate;

    const entries = prepareTokenSpend(
      txMeta(userId, { model }),
      { promptTokens, completionTokens },
      pricing,
    );
    await bulkWriteTransactions({ user: userId, docs: entries }, dbOps());

    const balance = (await Balance.findOne({ user: userId }).lean()) as Record<string, unknown>;
    expect(balance.tokenCredits).toBeCloseTo(initialBalance - expectedCost, 0);
  });
});

describe('Multi-entry batch parity', () => {
  test('real-world sequential tool calls — total balance deduction identical to N individual legacy calls', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const initialBalance = 100000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'claude-opus-4-5-20251101';
    const calls = [
      { promptTokens: 31596, completionTokens: 151 },
      { promptTokens: 35368, completionTokens: 150 },
      { promptTokens: 58362, completionTokens: 295 },
      { promptTokens: 112604, completionTokens: 193 },
      { promptTokens: 257440, completionTokens: 2217 },
    ];

    let expectedTotalCost = 0;
    const allEntries = [];
    for (const { promptTokens, completionTokens } of calls) {
      const pm = getMultiplier({ model, tokenType: 'prompt', inputTokenCount: promptTokens });
      const cm = getMultiplier({ model, tokenType: 'completion', inputTokenCount: promptTokens });
      expectedTotalCost += promptTokens * pm + completionTokens * cm;
      const entries = prepareTokenSpend(
        txMeta(userId, { model }),
        { promptTokens, completionTokens },
        pricing,
      );
      allEntries.push(...entries);
    }

    await bulkWriteTransactions({ user: userId, docs: allEntries }, dbOps());

    const txns = await Transaction.find({ user: userId }).lean();
    expect(txns).toHaveLength(10); // 5 calls × 2 docs

    const balance = (await Balance.findOne({ user: userId }).lean()) as Record<string, unknown>;
    expect(balance.tokenCredits).toBeCloseTo(initialBalance - expectedTotalCost, 0);
  });

  test('structured premium above threshold — batch vs individual produce same balance deduction', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const initialBalance = 100000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    const model = 'gemini-3.1';
    const tokenUsage = {
      promptTokens: { input: 200000, write: 10000, read: 5000 },
      completionTokens: 1000,
    };
    const totalInput = 215000;

    const premiumPromptRate = (premiumTokenValues as Record<string, Record<string, number>>)[model]
      .prompt;
    const premiumCompletionRate = (premiumTokenValues as Record<string, Record<string, number>>)[
      model
    ].completion;
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

    expect(totalInput).toBeGreaterThan(
      (premiumTokenValues as Record<string, Record<string, number>>)[model].threshold,
    );

    const entries = prepareStructuredTokenSpend(txMeta(userId, { model }), tokenUsage, pricing);
    await bulkWriteTransactions({ user: userId, docs: entries }, dbOps());

    const balance = (await Balance.findOne({ user: userId }).lean()) as Record<string, unknown>;
    expect(balance.tokenCredits).toBeCloseTo(initialBalance - expectedTotalCost, 0);
  });
});
