import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { IBalance } from '..';
import type { ITransaction } from '~/schema/transaction';
import { matchModelName, findMatchingPattern } from './test-helpers';
import { supportsTransactions } from '~/utils/transactions';
import { createTransactionMethods } from './transaction';
import { createModels } from '~/models';
import { createTxMethods } from './tx';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let replica: MongoMemoryReplSet;
let Balance: mongoose.Model<IBalance>;
let Transaction: mongoose.Model<ITransaction>;
let applyIdempotentCredit: ReturnType<typeof createTransactionMethods>['applyIdempotentCredit'];

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replica.getUri());

  const models = createModels(mongoose);
  Object.assign(mongoose.models, models);
  Balance = mongoose.models.Balance;
  Transaction = mongoose.models.Transaction;
  await Promise.all([Balance.syncIndexes(), Transaction.syncIndexes()]);

  const txMethods = createTxMethods(mongoose, { matchModelName, findMatchingPattern });
  const transactionMethods = createTransactionMethods(mongoose, {
    getMultiplier: txMethods.getMultiplier,
    getCacheMultiplier: txMethods.getCacheMultiplier,
  });
  applyIdempotentCredit = transactionMethods.applyIdempotentCredit;

  if (!(await supportsTransactions(mongoose))) {
    throw new Error('Replica-set tests require MongoDB transactions');
  }
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await replica?.stop();
});

beforeEach(async () => {
  await Promise.all([Balance.deleteMany({}), Transaction.deleteMany({})]);
  jest.restoreAllMocks();
});

describe('applyIdempotentCredit (transactional path)', () => {
  test('applies a fresh credit, committing the ledger row and the balance increment together', async () => {
    const user = new mongoose.Types.ObjectId().toString();

    const result = await applyIdempotentCredit({
      user,
      incrementValue: 500,
      idempotencyKey: 'txn-key-1',
      context: 'admin',
    });

    expect(result.applied).toBe(true);
    expect(result.resultingBalance).toBe(500);
    const balance = await Balance.findOne({ user }).lean();
    expect(balance?.tokenCredits).toBe(500);
    const ledgerRow = await Transaction.findById(result.transactionId).lean();
    expect(ledgerRow?.idempotencyKey).toBe('txn-key-1');
  });

  test('a retry with the same key reports applied: false and does not re-increment', async () => {
    const user = new mongoose.Types.ObjectId().toString();
    const first = await applyIdempotentCredit({
      user,
      incrementValue: 500,
      idempotencyKey: 'txn-key-2',
      context: 'admin',
    });

    const second = await applyIdempotentCredit({
      user,
      incrementValue: 500,
      idempotencyKey: 'txn-key-2',
      context: 'admin',
    });

    expect(second.applied).toBe(false);
    expect(second.resultingBalance).toBe(500);
    expect(second.transactionId).toBe(first.transactionId);
    const balance = await Balance.findOne({ user }).lean();
    expect(balance?.tokenCredits).toBe(500);
    expect(await Transaction.countDocuments({ idempotencyKey: 'txn-key-2' })).toBe(1);
  });

  test('exactly one of several concurrent same-key calls applies the increment', async () => {
    const user = new mongoose.Types.ObjectId().toString();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        applyIdempotentCredit({
          user,
          incrementValue: 500,
          idempotencyKey: 'txn-key-3',
          context: 'admin',
        }),
      ),
    );

    expect(results.filter((r) => r.applied)).toHaveLength(1);
    const balance = await Balance.findOne({ user }).lean();
    expect(balance?.tokenCredits).toBe(500);
    expect(await Transaction.countDocuments({ idempotencyKey: 'txn-key-3' })).toBe(1);
  });

  test('a failure between the ledger insert and the balance increment leaves neither committed, unlike the non-transactional path', async () => {
    const user = new mongoose.Types.ObjectId().toString();
    await Balance.create({ user, tokenCredits: 0 });
    jest.spyOn(Balance, 'findOneAndUpdate').mockImplementationOnce(() => {
      throw new Error('injected failure after ledger insert, before balance increment');
    });

    await expect(
      applyIdempotentCredit({
        user,
        incrementValue: 500,
        idempotencyKey: 'txn-key-crash',
        context: 'admin',
      }),
    ).rejects.toThrow('injected failure after ledger insert, before balance increment');

    // Neither side effect of the aborted transaction persisted — the ledger
    // insert that happened before the injected failure was rolled back along
    // with everything else, instead of surviving as an orphaned row the way
    // it would under the two-step, non-transactional path.
    expect(await Transaction.countDocuments({ idempotencyKey: 'txn-key-crash' })).toBe(0);
    expect((await Balance.findOne({ user }).lean())?.tokenCredits).toBe(0);

    // A clean retry (no injected failure) starts from scratch and succeeds —
    // not blocked or corrupted by the aborted attempt.
    const retry = await applyIdempotentCredit({
      user,
      incrementValue: 500,
      idempotencyKey: 'txn-key-crash',
      context: 'admin',
    });
    expect(retry.applied).toBe(true);
    expect(retry.resultingBalance).toBe(500);
  });

  test('surviving many unrelated credits in between does not matter — there is no ring buffer to evict from', async () => {
    const user = new mongoose.Types.ObjectId().toString();
    const first = await applyIdempotentCredit({
      user,
      incrementValue: 500,
      idempotencyKey: 'txn-key-no-eviction',
      context: 'admin',
    });
    expect(first.applied).toBe(true);

    for (let i = 0; i < 55; i += 1) {
      await applyIdempotentCredit({
        user,
        incrementValue: 10,
        idempotencyKey: `unrelated-key-${i}`,
        context: 'admin',
      });
    }

    const retry = await applyIdempotentCredit({
      user,
      incrementValue: 500,
      idempotencyKey: 'txn-key-no-eviction',
      context: 'admin',
    });

    expect(retry.applied).toBe(false);
    // 500 (first) + 55 * 10 (unrelated) — the retry must NOT add another 500.
    expect(retry.resultingBalance).toBe(500 + 55 * 10);
  });
});
