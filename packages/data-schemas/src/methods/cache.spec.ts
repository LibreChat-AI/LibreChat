import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { ITransaction } from '~/schema/transaction';
import type { IBalance } from '~/types';
import { matchModelName, findMatchingPattern } from './test-helpers';
import { createSpendTokensMethods } from './spendTokens';
import { createTransactionMethods } from './transaction';
import transactionSchema from '~/schema/transaction';
import balanceSchema from '~/schema/balance';
import { createTxMethods } from './tx';

let server: MongoMemoryServer;
let Balance: mongoose.Model<IBalance>;
let Transaction: mongoose.Model<ITransaction>;
const pricing = createTxMethods(mongoose, { matchModelName, findMatchingPattern });
const methods = createTransactionMethods(mongoose, pricing);
const { spendStructuredTokens } = createSpendTokensMethods(mongoose, methods);

beforeAll(async () => {
  server = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  await mongoose.connect(server.getUri());
  Balance = mongoose.model('Balance', balanceSchema);
  Transaction = mongoose.model('Transaction', transactionSchema);
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

it.each([
  { input: 0, write: 10000, write12h: 10000, read: 0, debit: 500000 },
  { input: 1000, write: 7000, write12h: 4000, read: 4000, debit: 303000 },
  { input: 261000, write: 7000, write12h: 4000, read: 4000, debit: 5503000 },
  { input: 261001, write: 7000, write12h: 4000, read: 4000, debit: 10736040 },
  { input: 0, write: 10000, write12h: 0, read: 0, debit: 250000 },
  { input: 0, write: 10000, write12h: 20000, read: 0, debit: 500000 },
])(
  'debits the legacy transaction path once for TTL shares: %j',
  async ({ debit, ...promptTokens }) => {
    const user = new mongoose.Types.ObjectId().toString();
    const initial = 20000000;
    await Balance.create({ user, tokenCredits: initial });
    const result = await spendStructuredTokens(
      {
        user,
        model: 'gpt-6-cyber',
        conversationId: 'cache-conversation',
        balance: { enabled: true },
      },
      { promptTokens },
    );
    expect(result.prompt?.prompt).toBe(-debit);
    const transaction = await Transaction.findOne({ user }).lean();
    expect(transaction).toMatchObject({
      tokenValue: -debit,
      rawAmount: -(promptTokens.input + promptTokens.write + promptTokens.read),
      writeTokens: -promptTokens.write,
    });
    expect((await Balance.findOne({ user }).lean())?.tokenCredits).toBe(initial - debit);
  },
);
