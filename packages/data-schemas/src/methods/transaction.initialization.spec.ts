import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { ITransaction } from '~/schema/transaction';
import type { IBalance } from '~/types';
import { createSpendTokensMethods } from './spendTokens';
import { createTransactionMethods } from './transaction';
import transactionSchema from '~/schema/transaction';
import balanceSchema from '~/schema/balance';

jest.mock('~/config/winston', () => ({ error: jest.fn(), debug: jest.fn() }));

let server: MongoMemoryServer;
let Balance: mongoose.Model<IBalance>;
let Transaction: mongoose.Model<ITransaction>;
let methods: ReturnType<typeof createTransactionMethods>;
let spend: ReturnType<typeof createSpendTokensMethods>;

const policy = {
  enabled: true,
  startBalance: 1000,
  autoRefillEnabled: true,
  refillAmount: 1000,
  refillMode: 'reset' as const,
  refillIntervalValue: 7,
  refillIntervalUnit: 'days' as const,
};

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  Balance = mongoose.model<IBalance>('Balance', balanceSchema);
  Transaction = mongoose.model<ITransaction>('Transaction', transactionSchema);
  methods = createTransactionMethods(mongoose, {
    getMultiplier: () => 2,
    getCacheMultiplier: () => 1,
  });
  spend = createSpendTokensMethods(mongoose, methods);
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

describe('debit-first balance initialization', () => {
  test.each(['regular', 'structured'] as const)(
    '%s spending grants the configured start balance before charging a missing record',
    async (kind) => {
      const user = new mongoose.Types.ObjectId();
      const context = { user, balance: policy };
      if (kind === 'regular') {
        await spend.spendTokens(context, { promptTokens: 100, completionTokens: 50 });
      } else {
        await spend.spendStructuredTokens(context, {
          promptTokens: { input: 100 },
          completionTokens: 50,
        });
      }
      const balance = await Balance.findOne({ user }).lean();
      expect(balance).toMatchObject({
        tokenCredits: 700,
        autoRefillEnabled: true,
        refillMode: 'reset',
        refillAmount: 1000,
        refillIntervalValue: 7,
        refillIntervalUnit: 'days',
        allotment: 1000,
      });
      expect(balance?.allottedAt).toEqual(balance?.lastRefill);
      expect(await Balance.countDocuments({ user })).toBe(1);
      expect(await Transaction.countDocuments({ user })).toBe(2);
    },
  );

  test('concurrent debits and admission grant the starting allowance only once', async () => {
    const user = new mongoose.Types.ObjectId();
    await Promise.all([
      methods.createTransaction({ user, balance: policy, tokenType: 'completion', rawAmount: -10 }),
      methods.createStructuredTransaction({
        user,
        balance: policy,
        tokenType: 'completion',
        rawAmount: -20,
      }),
      methods.reserveBalance({
        user: user.toString(),
        reservationId: 'admission',
        amount: 0,
        expiresAt: new Date(Date.now() + 60000),
        initialBalance: {
          tokenCredits: 1000,
          autoRefillEnabled: true,
          refillAmount: 1000,
          refillMode: 'reset',
          refillIntervalValue: 7,
          refillIntervalUnit: 'days',
        },
      }),
    ]);
    expect((await Balance.findOne({ user }).lean())?.tokenCredits).toBe(940);
    expect(await Balance.countDocuments({ user })).toBe(1);
  });

  test.each([0, 400])('never restores an existing balance of %s credits', async (tokenCredits) => {
    const user = new mongoose.Types.ObjectId();
    const lastRefill = new Date();
    await Balance.create({ user, tokenCredits, lastRefill });
    await methods.createTransaction({
      user,
      balance: policy,
      tokenType: 'completion',
      rawAmount: -10,
    });
    const balance = await Balance.findOne({ user }).lean();
    expect(balance?.tokenCredits).toBe(Math.max(0, tokenCredits - 20));
    expect(balance?.lastRefill).toEqual(lastRefill);
  });

  test('preserves legacy zero initialization without a configured starting allowance', async () => {
    const user = new mongoose.Types.ObjectId();
    await methods.createTransaction({
      user,
      balance: { enabled: true },
      tokenType: 'completion',
      rawAmount: -10,
    });
    expect((await Balance.findOne({ user }).lean())?.tokenCredits).toBe(0);
  });

  test('an administrative credit grants only the requested amount', async () => {
    const user = new mongoose.Types.ObjectId();
    await methods.createTransaction({
      user,
      balance: policy,
      tokenType: 'credits',
      context: 'admin',
      rawAmount: 200,
    });
    expect((await Balance.findOne({ user }).lean())?.tokenCredits).toBe(400);
  });

  test('an explicitly zero starting allowance stays zero', async () => {
    const user = new mongoose.Types.ObjectId();
    await methods.createTransaction({
      user,
      balance: { ...policy, startBalance: 0 },
      tokenType: 'completion',
      rawAmount: -10,
    });
    expect((await Balance.findOne({ user }).lean())?.tokenCredits).toBe(0);
  });

  test('a zero-cost first transaction does not poison the next debit', async () => {
    const user = new mongoose.Types.ObjectId();
    await methods.createTransaction({ user, balance: policy, tokenType: 'prompt', rawAmount: 0 });
    await methods.createTransaction({
      user,
      balance: policy,
      tokenType: 'completion',
      rawAmount: -10,
    });
    expect((await Balance.findOne({ user }).lean())?.tokenCredits).toBe(980);
  });

  test('a bulk debit can initialize from the effective balance policy', async () => {
    const user = new mongoose.Types.ObjectId();
    await methods.updateBalance({
      user: user.toString(),
      incrementValue: -300,
      balanceConfig: policy,
    });
    expect((await Balance.findOne({ user }).lean())?.tokenCredits).toBe(700);
  });
});
