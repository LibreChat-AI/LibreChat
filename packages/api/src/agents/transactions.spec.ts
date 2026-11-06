import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  CANCEL_RATE,
  createMethods,
  balanceSchema,
  transactionSchema,
} from '@librechat/data-schemas';
import type { PricingFns, TxMetadata, PreparedEntry } from './transactions';
import {
  prepareStructuredTokenSpend,
  bulkWriteTransactions,
  prepareTokenSpend,
} from './transactions';

jest.mock('@librechat/data-schemas', () => {
  const actual = jest.requireActual('@librechat/data-schemas');
  return {
    ...actual,
    logger: {
      debug: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
    },
  };
});

let mongoServer: MongoMemoryServer;
let Transaction: mongoose.Model<unknown>;
let Balance: mongoose.Model<unknown>;
let dbMethods: ReturnType<typeof createMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  Transaction = mongoose.models.Transaction || mongoose.model('Transaction', transactionSchema);
  Balance = mongoose.models.Balance || mongoose.model('Balance', balanceSchema);
  dbMethods = createMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
});

const testUserId = new mongoose.Types.ObjectId().toString();

const baseTxData: TxMetadata = {
  user: testUserId,
  context: 'message',
  conversationId: 'convo-123',
  model: 'gpt-4',
  messageId: 'msg-123',
  balance: { enabled: true },
  transactions: { enabled: true },
};

const mockPricing: PricingFns = {
  getMultiplier: jest.fn().mockReturnValue(2),
  getCacheMultiplier: jest.fn().mockReturnValue(null),
};

describe('prepareTokenSpend', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should prepare prompt + completion entries', () => {
    const entries = prepareTokenSpend(
      baseTxData,
      { promptTokens: 100, completionTokens: 50 },
      mockPricing,
    );
    expect(entries).toHaveLength(2);
    expect(entries[0].doc.tokenType).toBe('prompt');
    expect(entries[1].doc.tokenType).toBe('completion');
  });

  it('should return empty array when transactions disabled', () => {
    const txData = { ...baseTxData, transactions: { enabled: false } };
    const entries = prepareTokenSpend(
      txData,
      { promptTokens: 100, completionTokens: 50 },
      mockPricing,
    );
    expect(entries).toHaveLength(0);
  });

  it('should filter out NaN rawAmount entries', () => {
    const entries = prepareTokenSpend(
      baseTxData,
      { promptTokens: NaN, completionTokens: 50 },
      mockPricing,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].doc.tokenType).toBe('completion');
  });

  it('should handle promptTokens only', () => {
    const entries = prepareTokenSpend(baseTxData, { promptTokens: 100 }, mockPricing);
    expect(entries).toHaveLength(1);
    expect(entries[0].doc.tokenType).toBe('prompt');
  });

  it('should handle completionTokens only', () => {
    const entries = prepareTokenSpend(baseTxData, { completionTokens: 50 }, mockPricing);
    expect(entries).toHaveLength(1);
    expect(entries[0].doc.tokenType).toBe('completion');
  });

  it('should handle zero tokens', () => {
    const entries = prepareTokenSpend(
      baseTxData,
      { promptTokens: 0, completionTokens: 0 },
      mockPricing,
    );
    expect(entries).toHaveLength(2);
    expect(entries[0].doc.rawAmount).toBe(0);
    expect(entries[1].doc.rawAmount).toBe(0);
  });

  it('should calculate tokenValue using pricing multiplier', () => {
    (mockPricing.getMultiplier as jest.Mock).mockReturnValue(3);
    const entries = prepareTokenSpend(
      baseTxData,
      { promptTokens: 100, completionTokens: 50 },
      mockPricing,
    );
    expect(entries[0].doc.rate).toBe(3);
    expect(entries[0].doc.tokenValue).toBe(-100 * 3);
    expect(entries[1].doc.rate).toBe(3);
    expect(entries[1].doc.tokenValue).toBe(-50 * 3);
  });

  it('should pass valueKey to getMultiplier', () => {
    prepareTokenSpend(baseTxData, { promptTokens: 100 }, mockPricing);
    expect(mockPricing.getMultiplier).toHaveBeenCalledWith(
      expect.objectContaining({ tokenType: 'prompt', model: 'gpt-4' }),
    );
  });

  it('should carry balance config on each entry', () => {
    const entries = prepareTokenSpend(
      baseTxData,
      { promptTokens: 100, completionTokens: 50 },
      mockPricing,
    );
    for (const entry of entries) {
      expect(entry.balance).toEqual({ enabled: true });
    }
  });
});

describe('prepareTokenSpend — CANCEL_RATE', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockPricing.getMultiplier as jest.Mock).mockReturnValue(2);
  });

  it('should apply CANCEL_RATE to completion tokens with incomplete context', () => {
    const txData: TxMetadata = { ...baseTxData, context: 'incomplete' };
    const entries = prepareTokenSpend(
      txData,
      { promptTokens: 100, completionTokens: 50 },
      mockPricing,
    );
    const completion = entries.find((e) => e.doc.tokenType === 'completion');
    expect(completion).toBeDefined();
    expect(completion!.doc.rate).toBe(2 * CANCEL_RATE);
    expect(completion!.doc.tokenValue).toBe(Math.ceil(-50 * 2 * CANCEL_RATE));
  });

  it('should NOT apply CANCEL_RATE to prompt tokens with incomplete context', () => {
    const txData: TxMetadata = { ...baseTxData, context: 'incomplete' };
    const entries = prepareTokenSpend(
      txData,
      { promptTokens: 100, completionTokens: 50 },
      mockPricing,
    );
    const prompt = entries.find((e) => e.doc.tokenType === 'prompt');
    expect(prompt!.doc.rate).toBe(2);
  });

  it('should NOT apply CANCEL_RATE for abort context', () => {
    const txData: TxMetadata = { ...baseTxData, context: 'abort' };
    const entries = prepareTokenSpend(txData, { completionTokens: 50 }, mockPricing);
    expect(entries[0].doc.rate).toBe(2);
  });
});

describe('prepareStructuredTokenSpend', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockPricing.getMultiplier as jest.Mock).mockReturnValue(2);
    (mockPricing.getCacheMultiplier as jest.Mock).mockReturnValue(null);
  });

  it('should prepare prompt + completion for structured tokens', () => {
    const entries = prepareStructuredTokenSpend(
      baseTxData,
      { promptTokens: { input: 100, write: 50, read: 30 }, completionTokens: 80 },
      mockPricing,
    );
    expect(entries).toHaveLength(2);
    expect(entries[0].doc.tokenType).toBe('prompt');
    expect(entries[0].doc.inputTokens).toBe(-100);
    expect(entries[0].doc.writeTokens).toBe(-50);
    expect(entries[0].doc.readTokens).toBe(-30);
    expect(entries[1].doc.tokenType).toBe('completion');
  });

  it('should use cache multipliers when available', () => {
    (mockPricing.getCacheMultiplier as jest.Mock).mockImplementation(({ cacheType }) => {
      if (cacheType === 'write') {
        return 5;
      }
      if (cacheType === 'read') {
        return 0.5;
      }
      return null;
    });

    const entries = prepareStructuredTokenSpend(
      baseTxData,
      { promptTokens: { input: 100, write: 50, read: 30 }, completionTokens: 0 },
      mockPricing,
    );
    const prompt = entries.find((e) => e.doc.tokenType === 'prompt');
    expect(prompt).toBeDefined();
    expect(prompt!.doc.rateDetail).toEqual({ input: 2, write: 5, read: 0.5 });
  });

  it('should return empty when transactions disabled', () => {
    const txData = { ...baseTxData, transactions: { enabled: false } };
    const entries = prepareStructuredTokenSpend(
      txData,
      { promptTokens: { input: 100 }, completionTokens: 50 },
      mockPricing,
    );
    expect(entries).toHaveLength(0);
  });

  it('should handle zero totalPromptTokens (fallback rate)', () => {
    const entries = prepareStructuredTokenSpend(
      baseTxData,
      { promptTokens: { input: 0, write: 0, read: 0 }, completionTokens: 50 },
      mockPricing,
    );
    const prompt = entries.find((e) => e.doc.tokenType === 'prompt');
    expect(prompt).toBeDefined();
    expect(prompt!.doc.rate).toBe(2);
  });
});

describe('bulkWriteTransactions (real DB)', () => {
  it('should return early for empty docs without DB writes', async () => {
    const dbOps = {
      insertMany: dbMethods.bulkInsertTransactions,
      updateBalance: dbMethods.updateBalance,
    };
    await bulkWriteTransactions({ user: testUserId, docs: [] }, dbOps);
    const txCount = await Transaction.countDocuments();
    expect(txCount).toBe(0);
  });

  it('should insert transaction documents into MongoDB', async () => {
    const docs: PreparedEntry[] = [
      {
        doc: {
          user: testUserId,
          conversationId: 'c1',
          tokenType: 'prompt',
          tokenValue: -200,
          rate: 2,
          rawAmount: -100,
        },
        tokenValue: -200,
        balance: { enabled: true },
      },
      {
        doc: {
          user: testUserId,
          conversationId: 'c1',
          tokenType: 'completion',
          tokenValue: -100,
          rate: 2,
          rawAmount: -50,
        },
        tokenValue: -100,
        balance: { enabled: true },
      },
    ];
    const dbOps = {
      insertMany: dbMethods.bulkInsertTransactions,
      updateBalance: dbMethods.updateBalance,
    };
    await bulkWriteTransactions({ user: testUserId, docs }, dbOps);

    const saved = await Transaction.find({ user: testUserId }).lean();
    expect(saved).toHaveLength(2);
    expect(saved.map((t: Record<string, unknown>) => t.tokenType).sort()).toEqual([
      'completion',
      'prompt',
    ]);
  });

  it('should create balance document and update credits', async () => {
    const docs: PreparedEntry[] = [
      {
        doc: { user: testUserId, conversationId: 'c1', tokenType: 'prompt', tokenValue: -300 },
        tokenValue: -300,
        balance: { enabled: true },
      },
    ];
    const dbOps = {
      insertMany: dbMethods.bulkInsertTransactions,
      updateBalance: dbMethods.updateBalance,
    };
    await bulkWriteTransactions({ user: testUserId, docs }, dbOps);

    const bal = (await Balance.findOne({ user: testUserId }).lean()) as Record<
      string,
      unknown
    > | null;
    expect(bal).toBeDefined();
    expect(bal!.tokenCredits).toBe(0);
  });

  it('should NOT update balance when no docs have balance enabled', async () => {
    const docs: PreparedEntry[] = [
      {
        doc: { user: testUserId, conversationId: 'c1', tokenType: 'prompt', tokenValue: -100 },
        tokenValue: -100,
        balance: { enabled: false },
      },
    ];
    const dbOps = {
      insertMany: dbMethods.bulkInsertTransactions,
      updateBalance: dbMethods.updateBalance,
    };
    await bulkWriteTransactions({ user: testUserId, docs }, dbOps);

    const txCount = await Transaction.countDocuments({ user: testUserId });
    expect(txCount).toBe(1);
    const bal = await Balance.findOne({ user: testUserId }).lean();
    expect(bal).toBeNull();
  });

  it('should only sum tokenValue from balance-enabled docs', async () => {
    await Balance.create({ user: testUserId, tokenCredits: 1000 });

    const docs: PreparedEntry[] = [
      {
        doc: { user: testUserId, conversationId: 'c1', tokenType: 'prompt', tokenValue: -100 },
        tokenValue: -100,
        balance: { enabled: true },
      },
      {
        doc: { user: testUserId, conversationId: 'c1', tokenType: 'completion', tokenValue: -50 },
        tokenValue: -50,
        balance: { enabled: false },
      },
    ];
    const dbOps = {
      insertMany: dbMethods.bulkInsertTransactions,
      updateBalance: dbMethods.updateBalance,
    };
    await bulkWriteTransactions({ user: testUserId, docs }, dbOps);

    const bal = (await Balance.findOne({ user: testUserId }).lean()) as Record<
      string,
      unknown
    > | null;
    expect(bal!.tokenCredits).toBe(900);
  });

  it('should handle null balance gracefully', async () => {
    const docs: PreparedEntry[] = [
      {
        doc: { user: testUserId, conversationId: 'c1', tokenType: 'prompt', tokenValue: -100 },
        tokenValue: -100,
        balance: null,
      },
    ];
    const dbOps = {
      insertMany: dbMethods.bulkInsertTransactions,
      updateBalance: dbMethods.updateBalance,
    };
    await bulkWriteTransactions({ user: testUserId, docs }, dbOps);

    const txCount = await Transaction.countDocuments({ user: testUserId });
    expect(txCount).toBe(1);
    const bal = await Balance.findOne({ user: testUserId }).lean();
    expect(bal).toBeNull();
  });

  it('should not debit the balance when inserting the ledger entries fails', async () => {
    await Balance.create({ user: testUserId, tokenCredits: 1000 });
    const docs: PreparedEntry[] = [
      {
        doc: { user: testUserId, conversationId: 'c1', tokenType: 'prompt', tokenValue: -100 },
        tokenValue: -100,
        balance: { enabled: true },
      },
    ];
    const updateBalance = jest.fn(dbMethods.updateBalance);
    const dbOps = {
      insertMany: jest.fn().mockRejectedValue(new Error('insert failed')),
      updateBalance,
    };

    await expect(bulkWriteTransactions({ user: testUserId, docs }, dbOps)).rejects.toThrow(
      'insert failed',
    );

    expect(updateBalance).not.toHaveBeenCalled();
    const bal = (await Balance.findOne({ user: testUserId }).lean()) as Record<
      string,
      unknown
    > | null;
    expect(bal!.tokenCredits).toBe(1000);
  });
});

describe('end-to-end: prepare → bulk write → verify', () => {
  it('should prepare, write, and correctly update balance for standard tokens', async () => {
    await Balance.create({ user: testUserId, tokenCredits: 10000 });
    (mockPricing.getMultiplier as jest.Mock).mockReturnValue(2);

    const entries = prepareTokenSpend(
      baseTxData,
      { promptTokens: 100, completionTokens: 50 },
      mockPricing,
    );
    const dbOps = {
      insertMany: dbMethods.bulkInsertTransactions,
      updateBalance: dbMethods.updateBalance,
    };
    await bulkWriteTransactions({ user: testUserId, docs: entries }, dbOps);

    const txns = (await Transaction.find({ user: testUserId }).lean()) as Record<string, unknown>[];
    expect(txns).toHaveLength(2);

    const prompt = txns.find((t) => t.tokenType === 'prompt');
    const completion = txns.find((t) => t.tokenType === 'completion');
    expect(prompt!.tokenValue).toBe(-200);
    expect(prompt!.rate).toBe(2);
    expect(completion!.tokenValue).toBe(-100);
    expect(completion!.rate).toBe(2);

    const bal = (await Balance.findOne({ user: testUserId }).lean()) as Record<
      string,
      unknown
    > | null;
    expect(bal!.tokenCredits).toBe(10000 + -200 + -100);
  });

  it('should prepare and write structured tokens with cache pricing', async () => {
    await Balance.create({ user: testUserId, tokenCredits: 5000 });
    (mockPricing.getMultiplier as jest.Mock).mockReturnValue(1);
    (mockPricing.getCacheMultiplier as jest.Mock).mockImplementation(({ cacheType }) => {
      if (cacheType === 'write') {
        return 3;
      }
      if (cacheType === 'read') {
        return 0.1;
      }
      return null;
    });

    const entries = prepareStructuredTokenSpend(
      baseTxData,
      { promptTokens: { input: 100, write: 50, read: 200 }, completionTokens: 80 },
      mockPricing,
    );
    const dbOps = {
      insertMany: dbMethods.bulkInsertTransactions,
      updateBalance: dbMethods.updateBalance,
    };
    await bulkWriteTransactions({ user: testUserId, docs: entries }, dbOps);

    const txns = (await Transaction.find({ user: testUserId }).lean()) as Record<string, unknown>[];
    expect(txns).toHaveLength(2);

    const prompt = txns.find((t) => t.tokenType === 'prompt');
    expect(prompt!.inputTokens).toBe(-100);
    expect(prompt!.writeTokens).toBe(-50);
    expect(prompt!.readTokens).toBe(-200);

    const bal = (await Balance.findOne({ user: testUserId }).lean()) as Record<
      string,
      unknown
    > | null;
    expect(bal!.tokenCredits).toBeLessThan(5000);
  });
});
