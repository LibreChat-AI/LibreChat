import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { PrincipalType, PrincipalModel, ResourceType } from 'librechat-data-provider';
import type { AnyBulkWriteOperation, Model } from 'mongoose';
import type { IConversationTag } from '~/schema/conversationTag';
import type { ITransaction } from '~/schema/transaction';
import type * as t from '~/types';
import { createConversationTagMethods } from '~/methods/conversationTag';
import { createTransactionMethods } from '~/methods/transaction';
import { createConversationMethods } from '~/methods/conversation';
import { createAclEntryMethods } from '~/methods/aclEntry';
import { createMessageMethods } from '~/methods/message';
import { runAsSystem } from '~/config/tenantContext';
import { createFileMethods } from '~/methods/file';
import { createModels } from '~/models';

/**
 * Differential bulkWrite specs. FerretDB's compatibility documentation lists
 * `bulkWrite` as unsupported, so these measure what actually happens across
 * the five bulkWrite call paths in this repo:
 *
 *   1. import — `bulkSaveConvos` + `bulkSaveMessages` (both hard-code/accept
 *      `timestamps:false`, matching `importBatchBuilder.saveBatch()`)
 *   2. `bulkWriteAclEntries` — ACL sharing grants
 *   3. `bulkIncrementTagCounts` — tag count bookkeeping
 *   4. `Transaction.insertMany` via `bulkInsertTransactions`
 *   5. the file-TTL bulkWrite — `extendFilesTTL`
 *
 * Multi-document transactions already degrade gracefully through the
 * `supportsTransactions` probe in `~/utils/transactions` (exercised in
 * `misc/documentdb/compat.documentdb.spec.ts`) — not re-tested here.
 *
 * Every flow runs the identical operation sequence first against a real
 * mongodb-memory-server (always, ungated — this is the correctness
 * baseline) and then, only when FERRETDB_URI is set, against FerretDB,
 * asserting the two runs produce equal normalized results (bulk-op counts
 * plus the resulting documents' business fields — no raw driver result
 * objects or wall-clock-sensitive timestamps are compared directly).
 *
 * Run against FerretDB (2.x requires auth):
 *   FERRETDB_URI="mongodb://ferretdb:ferretdb@127.0.0.1:27020/bulkwrite_test" \
 *     npx jest --config misc/ferretdb/jest.ferretdb.config.mjs bulkWrite.ferretdb --testTimeout=120000
 *
 * Without FERRETDB_URI set, only the mongodb-memory-server baseline runs.
 */

const FERRETDB_URI = process.env.FERRETDB_URI;
const itIfFerretDB = FERRETDB_URI ? it : it.skip;

const HOUR = 3_600_000;

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  if (mongoose.modelNames().length === 0) {
    createModels(mongoose);
  }
});

afterAll(async () => {
  await mongoServer.stop();
});

/**
 * Connects the shared mongoose singleton to `uri`, drops any leftover
 * database, runs `work`, then disconnects. Models are registered once at
 * module scope (`createModels`) and stay bound to `mongoose.connection`
 * across reconnects, so the same method objects transparently redirect
 * between the memory-server and FerretDB runs. `autoIndex: false` skips
 * building indexes for all ~37 models on every reconnect — these flows
 * only assert on data, and index builds racing the next flow's disconnect
 * otherwise log noisy (harmless) "Operation interrupted" errors.
 *
 * `work` runs inside `runAsSystem()` because these flows call production
 * methods unscoped, exactly as a cross-tenant maintenance job would; without
 * it the tenant-isolation middleware throws under `TENANT_ISOLATION_STRICT`.
 */
async function withStore<T>(uri: string, work: () => Promise<T>): Promise<T> {
  await mongoose.connect(uri, { autoIndex: false });
  await mongoose.connection.dropDatabase().catch(() => undefined);
  try {
    return await runAsSystem(work);
  } finally {
    await mongoose.connection.dropDatabase().catch(() => undefined);
    await mongoose.disconnect();
  }
}

interface BulkCounts {
  matchedCount: number;
  modifiedCount: number;
  upsertedCount: number;
}

/** Normalizes a bulkWrite result to just the counts flows in this file assert on. */
function pickCounts(result: unknown): BulkCounts {
  const r = result as Partial<BulkCounts> | null | undefined;
  return {
    matchedCount: r?.matchedCount ?? 0,
    modifiedCount: r?.modifiedCount ?? 0,
    upsertedCount: r?.upsertedCount ?? 0,
  };
}

// ─── FLOW 1: import — bulkSaveConvos + bulkSaveMessages ───────────────────

interface ImportFlowResult {
  convoBulk: BulkCounts;
  messageBulk: BulkCounts;
  convos: Array<{
    conversationId: string;
    user: string;
    title: string;
    endpoint: string;
    model: string;
  }>;
  messages: Array<{
    messageId: string;
    conversationId: string;
    user: string;
    sender: string;
    text: string;
    isCreatedByUser: boolean;
  }>;
}

async function runImportFlow(): Promise<ImportFlowResult> {
  const conversationMethods = createConversationMethods(mongoose);
  const messageMethods = createMessageMethods(mongoose);
  const Conversation = mongoose.models.Conversation as Model<t.IConversation>;
  const Message = mongoose.models.Message as Model<t.IMessage>;
  const user = 'import-flow-user';

  // First import batch: three brand-new conversations (upsert-only path).
  await conversationMethods.bulkSaveConvos([
    { conversationId: 'import-convo-1', user, title: 'First', endpoint: 'openAI', model: 'gpt-4' },
    { conversationId: 'import-convo-2', user, title: 'Second', endpoint: 'openAI', model: 'gpt-4' },
    { conversationId: 'import-convo-3', user, title: 'Third', endpoint: 'openAI', model: 'gpt-4' },
  ]);

  // Second import batch: re-imports two existing conversations — a full
  // document REPLACE, since bulkSaveConvos' update has no `$set` — plus one
  // brand-new conversation, exercising matched+modified and upserted in the
  // same bulkWrite call.
  const convoBulk = pickCounts(
    await conversationMethods.bulkSaveConvos([
      {
        conversationId: 'import-convo-1',
        user,
        title: 'First (re-imported)',
        endpoint: 'openAI',
        model: 'gpt-4',
      },
      {
        conversationId: 'import-convo-2',
        user,
        title: 'Second (re-imported)',
        endpoint: 'openAI',
        model: 'gpt-4',
      },
      {
        conversationId: 'import-convo-4',
        user,
        title: 'Fourth',
        endpoint: 'openAI',
        model: 'gpt-4',
      },
    ]),
  );

  const messageBulk = pickCounts(
    await messageMethods.bulkSaveMessages(
      [
        {
          messageId: 'import-msg-1',
          conversationId: 'import-convo-1',
          user,
          sender: 'user',
          text: 'Hi',
          isCreatedByUser: true,
        },
        {
          messageId: 'import-msg-2',
          conversationId: 'import-convo-1',
          user,
          sender: 'GPT-4',
          text: 'Hello',
          isCreatedByUser: false,
        },
        {
          messageId: 'import-msg-3',
          conversationId: 'import-convo-2',
          user,
          sender: 'user',
          text: 'Hey',
          isCreatedByUser: true,
        },
        {
          messageId: 'import-msg-4',
          conversationId: 'import-convo-4',
          user,
          sender: 'user',
          text: 'New',
          isCreatedByUser: true,
        },
      ],
      true, // overrideTimestamp, matching importBatchBuilder.saveBatch()
    ),
  );

  const convos = await Conversation.find({ user })
    .sort({ conversationId: 1 })
    .select({ conversationId: 1, user: 1, title: 1, endpoint: 1, model: 1, _id: 0 })
    .lean<ImportFlowResult['convos']>();

  const messages = await Message.find({ user })
    .sort({ messageId: 1 })
    .select({
      messageId: 1,
      conversationId: 1,
      user: 1,
      sender: 1,
      text: 1,
      isCreatedByUser: 1,
      _id: 0,
    })
    .lean<ImportFlowResult['messages']>();

  return { convoBulk, messageBulk, convos, messages };
}

describe('import path: bulkSaveConvos + bulkSaveMessages (timestamps:false)', () => {
  let baseline: ImportFlowResult;

  it('produces the expected upsert/update counts on mongodb-memory-server', async () => {
    baseline = await withStore(mongoServer.getUri(), runImportFlow);
    expect(baseline.convoBulk).toEqual({ matchedCount: 2, modifiedCount: 2, upsertedCount: 1 });
    expect(baseline.messageBulk).toEqual({ matchedCount: 0, modifiedCount: 0, upsertedCount: 4 });
    expect(baseline.convos.map((c) => c.conversationId)).toEqual([
      'import-convo-1',
      'import-convo-2',
      'import-convo-3',
      'import-convo-4',
    ]);
    expect(baseline.convos.find((c) => c.conversationId === 'import-convo-1')?.title).toBe(
      'First (re-imported)',
    );
    expect(baseline.messages).toHaveLength(4);
  });

  itIfFerretDB('matches mongodb-memory-server on FerretDB', async () => {
    const ferret = await withStore(FERRETDB_URI as string, runImportFlow);
    expect(ferret).toEqual(baseline);
  });
});

// ─── FLOW 2: bulkWriteAclEntries ───────────────────────────────────────────

const ACL_RESOURCE_ID = new mongoose.Types.ObjectId('507f1f77bcf86cd799439011');
const ACL_USER_1 = new mongoose.Types.ObjectId('507f1f77bcf86cd799439012');
const ACL_USER_2 = new mongoose.Types.ObjectId('507f1f77bcf86cd799439013');
const ACL_USER_3 = new mongoose.Types.ObjectId('507f1f77bcf86cd799439014');
const ACL_GROUP_1 = new mongoose.Types.ObjectId('507f1f77bcf86cd799439015');
const ACL_GRANTED_BY = new mongoose.Types.ObjectId('507f1f77bcf86cd799439016');

/** Mirrors the `updateOne` + `$set`/`$setOnInsert` + `upsert:true` shape PermissionService.js builds for sharing grants. */
function grantOp(
  principalType: PrincipalType,
  principalId: mongoose.Types.ObjectId,
  principalModel: PrincipalModel,
  permBits: number,
): AnyBulkWriteOperation<t.AclEntry> {
  return {
    updateOne: {
      filter: {
        principalType,
        principalId,
        resourceType: ResourceType.AGENT,
        resourceId: ACL_RESOURCE_ID,
      },
      update: {
        $set: { permBits, grantedBy: ACL_GRANTED_BY },
        $setOnInsert: {
          principalType,
          resourceType: ResourceType.AGENT,
          resourceId: ACL_RESOURCE_ID,
          principalId,
          principalModel,
        },
      },
      upsert: true,
    },
  };
}

interface AclFlowResult {
  firstBulk: BulkCounts;
  secondBulk: BulkCounts;
  entries: Array<{
    principalType: string;
    principalId: string;
    resourceType: string;
    resourceId: string;
    permBits: number;
  }>;
}

async function runAclFlow(): Promise<AclFlowResult> {
  const aclMethods = createAclEntryMethods(mongoose);
  const AclEntry = mongoose.models.AclEntry as Model<t.IAclEntry>;

  const firstBulk = pickCounts(
    await aclMethods.bulkWriteAclEntries([
      grantOp(PrincipalType.USER, ACL_USER_1, PrincipalModel.USER, 1),
      grantOp(PrincipalType.USER, ACL_USER_2, PrincipalModel.USER, 1),
      grantOp(PrincipalType.GROUP, ACL_GROUP_1, PrincipalModel.GROUP, 3),
    ]),
  );

  // A second share round: widens two existing grants and adds a new
  // principal — matched+modified and upserted in the same bulkWrite call.
  const secondBulk = pickCounts(
    await aclMethods.bulkWriteAclEntries([
      grantOp(PrincipalType.USER, ACL_USER_1, PrincipalModel.USER, 7),
      grantOp(PrincipalType.USER, ACL_USER_2, PrincipalModel.USER, 2),
      grantOp(PrincipalType.USER, ACL_USER_3, PrincipalModel.USER, 1),
    ]),
  );

  const entries = await AclEntry.find({ resourceId: ACL_RESOURCE_ID })
    .sort({ principalType: 1, permBits: 1 })
    .lean<t.IAclEntry[]>();

  return {
    firstBulk,
    secondBulk,
    entries: entries.map((entry) => ({
      principalType: entry.principalType,
      principalId: String(entry.principalId),
      resourceType: entry.resourceType,
      resourceId: String(entry.resourceId),
      permBits: entry.permBits,
    })),
  };
}

describe('bulkWriteAclEntries (ACL sharing grants)', () => {
  let baseline: AclFlowResult;

  it('produces the expected upsert/update counts on mongodb-memory-server', async () => {
    baseline = await withStore(mongoServer.getUri(), runAclFlow);
    expect(baseline.firstBulk).toEqual({ matchedCount: 0, modifiedCount: 0, upsertedCount: 3 });
    expect(baseline.secondBulk).toEqual({ matchedCount: 2, modifiedCount: 2, upsertedCount: 1 });
    expect(baseline.entries).toHaveLength(4);
    expect(baseline.entries.map((e) => e.permBits).sort((a, b) => a - b)).toEqual([1, 2, 3, 7]);
  });

  itIfFerretDB('matches mongodb-memory-server on FerretDB', async () => {
    const ferret = await withStore(FERRETDB_URI as string, runAclFlow);
    expect(ferret).toEqual(baseline);
  });
});

// ─── FLOW 3: bulkIncrementTagCounts ────────────────────────────────────────

interface TagFlowResult {
  tags: Array<{ tag: string; count: number }>;
}

async function runTagFlow(): Promise<TagFlowResult> {
  const tagMethods = createConversationTagMethods(mongoose);
  const ConversationTag = mongoose.models.ConversationTag as Model<IConversationTag>;
  const user = 'tag-flow-user';

  await ConversationTag.create([
    { user, tag: 'existing-a', count: 2, position: 0 },
    { user, tag: 'existing-b', count: 0, position: 1 },
  ]);

  // Duplicates in the input dedupe to a single increment (Set-based); 'missing'
  // has no pre-existing row and bulkIncrementTagCounts does not upsert, so it
  // is silently skipped ("increments existing tags only").
  await tagMethods.bulkIncrementTagCounts(user, [
    'existing-a',
    'existing-a',
    'existing-b',
    'missing',
  ]);

  const tags = await ConversationTag.find({ user })
    .sort({ tag: 1 })
    .select({ tag: 1, count: 1, _id: 0 })
    .lean<TagFlowResult['tags']>();

  return { tags };
}

describe('bulkIncrementTagCounts (existing-only, deduped)', () => {
  let baseline: TagFlowResult;

  it('increments existing tags once each and skips missing tags on mongodb-memory-server', async () => {
    baseline = await withStore(mongoServer.getUri(), runTagFlow);
    expect(baseline.tags).toEqual([
      { tag: 'existing-a', count: 3 },
      { tag: 'existing-b', count: 1 },
    ]);
  });

  itIfFerretDB('matches mongodb-memory-server on FerretDB', async () => {
    const ferret = await withStore(FERRETDB_URI as string, runTagFlow);
    expect(ferret).toEqual(baseline);
  });
});

// ─── FLOW 4: Transaction.insertMany (bulkInsertTransactions) ──────────────

const TX_USER = '507f1f77bcf86cd799439020';

interface TransactionFlowResult {
  transactions: Array<{
    user: string;
    conversationId?: string;
    tokenType: string;
    model?: string;
    rawAmount?: number;
    tokenValue?: number;
  }>;
}

async function runTransactionFlow(): Promise<TransactionFlowResult> {
  const transactionMethods = createTransactionMethods(mongoose, {
    getMultiplier: () => 1,
    getCacheMultiplier: () => null,
  });
  const Transaction = mongoose.models.Transaction as Model<ITransaction>;

  await transactionMethods.bulkInsertTransactions([
    {
      user: TX_USER,
      conversationId: 'tx-convo-1',
      tokenType: 'prompt',
      model: 'gpt-4',
      rawAmount: -100,
      tokenValue: -100,
    },
    {
      user: TX_USER,
      conversationId: 'tx-convo-1',
      tokenType: 'completion',
      model: 'gpt-4',
      rawAmount: -50,
      tokenValue: -50,
    },
    {
      user: TX_USER,
      conversationId: 'tx-convo-2',
      tokenType: 'credits',
      rawAmount: 500,
      tokenValue: 500,
    },
  ]);

  const transactions = await Transaction.find({ user: TX_USER })
    .sort({ conversationId: 1, tokenType: 1 })
    .select({
      user: 1,
      conversationId: 1,
      tokenType: 1,
      model: 1,
      rawAmount: 1,
      tokenValue: 1,
      _id: 0,
    })
    .lean<TransactionFlowResult['transactions']>();

  return {
    transactions: transactions.map((tx) => ({ ...tx, user: String(tx.user) })),
  };
}

describe('Transaction.insertMany (bulkInsertTransactions)', () => {
  let baseline: TransactionFlowResult;

  it('inserts every transaction doc on mongodb-memory-server', async () => {
    baseline = await withStore(mongoServer.getUri(), runTransactionFlow);
    expect(baseline.transactions).toHaveLength(3);
    expect(baseline.transactions.map((tx) => tx.tokenType)).toEqual([
      'completion',
      'prompt',
      'credits',
    ]);
  });

  itIfFerretDB('matches mongodb-memory-server on FerretDB', async () => {
    const ferret = await withStore(FERRETDB_URI as string, runTransactionFlow);
    expect(ferret).toEqual(baseline);
  });
});

// ─── FLOW 5: file-TTL bulkWrite (extendFilesTTL) ───────────────────────────

const FILE_TTL_USER = '507f1f77bcf86cd799439030';
/** `createFile`'s `Partial<IMongoFile>` requires a real ObjectId; `extendFilesTTL`'s owner scope takes a string (Mongoose casts filters automatically). */
const FILE_TTL_USER_OID = new mongoose.Types.ObjectId(FILE_TTL_USER);

interface FileTtlFlowResult {
  widenedCount: number;
  verdicts: Record<string, 'widened' | 'unchanged'>;
}

async function runFileTtlFlow(): Promise<FileTtlFlowResult> {
  const fileMethods = createFileMethods(mongoose);
  const File = mongoose.models.File as Model<t.IMongoFile>;

  const nearExpiryId = 'file-ttl-near-expiry';
  const farExpiryId = 'file-ttl-far-expiry';

  await fileMethods.createFile({
    file_id: nearExpiryId,
    user: FILE_TTL_USER_OID,
    filename: 'near.txt',
    filepath: '/uploads/near.txt',
    type: 'text/plain',
    bytes: 1,
  });
  await fileMethods.createFile({
    file_id: farExpiryId,
    user: FILE_TTL_USER_OID,
    filename: 'far.txt',
    filepath: '/uploads/far.txt',
    type: 'text/plain',
    bytes: 1,
  });

  // nearExpiry: about to lapse (1 minute out) — the hold should widen it.
  // farExpiry: already beyond the 24h renewal target (30 hours out) — the
  // `expiresAt >= next` write guard should leave it alone.
  await File.updateOne(
    { file_id: nearExpiryId },
    { $set: { expiresAt: new Date(Date.now() + 60_000) } },
    { timestamps: false },
  );
  await File.updateOne(
    { file_id: farExpiryId },
    { $set: { expiresAt: new Date(Date.now() + 30 * HOUR) } },
    { timestamps: false },
  );

  const before = await File.find({ user: FILE_TTL_USER })
    .select({ file_id: 1, expiresAt: 1, _id: 0 })
    .lean<Array<{ file_id: string; expiresAt?: Date }>>();
  const beforeByFile = new Map(before.map((f) => [f.file_id, f.expiresAt?.getTime()]));

  const widenedCount = await fileMethods.extendFilesTTL(
    [nearExpiryId, farExpiryId],
    { renewMs: 24 * HOUR, maxLifetimeMs: 48 * HOUR },
    { user: FILE_TTL_USER },
  );

  const after = await File.find({ user: FILE_TTL_USER })
    .select({ file_id: 1, expiresAt: 1, _id: 0 })
    .sort({ file_id: 1 })
    .lean<Array<{ file_id: string; expiresAt?: Date }>>();

  const verdicts: Record<string, 'widened' | 'unchanged'> = {};
  for (const file of after) {
    const beforeMs = beforeByFile.get(file.file_id);
    const afterMs = file.expiresAt?.getTime();
    verdicts[file.file_id] = beforeMs !== afterMs ? 'widened' : 'unchanged';
  }

  return { widenedCount, verdicts };
}

describe('file-TTL bulkWrite (extendFilesTTL)', () => {
  let baseline: FileTtlFlowResult;

  it('widens only the near-expiry file on mongodb-memory-server', async () => {
    baseline = await withStore(mongoServer.getUri(), runFileTtlFlow);
    expect(baseline.widenedCount).toBe(1);
    expect(baseline.verdicts).toEqual({
      'file-ttl-near-expiry': 'widened',
      'file-ttl-far-expiry': 'unchanged',
    });
  });

  itIfFerretDB('matches mongodb-memory-server on FerretDB', async () => {
    const ferret = await withStore(FERRETDB_URI as string, runFileTtlFlow);
    expect(ferret).toEqual(baseline);
  });
});
