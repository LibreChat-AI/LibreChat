import { MongoServerError } from 'mongodb';
import type { ClientSession, FilterQuery, Model } from 'mongoose';
import type { TenantContext } from '~/config/tenantContext';
import type { IConversation } from '~/types/convo';
import type { IMessage } from '~/types/message';
import { createInsightsExclusionModel } from '~/models/insightsExclusion';
import { runAfterTransaction } from '~/utils/postCommit';
import { tenantStorage } from '~/config/tenantContext';
import { retryWithBackoff } from '~/utils/retry';
import logger from '~/config/winston';

export type InsightsRecordIdentity = {
  conversationId?: string;
  user?: string | { toString(): string };
  tenantId?: string;
};

type ConversationRoot = {
  conversationId: string;
  user: string;
  tenantId?: string;
  initial_agent_id?: string | null;
  subagentThread?: object | null;
  isTemporary?: boolean | null;
  agent_id?: unknown;
};

export function insightsIdentityKey(record: InsightsRecordIdentity): string {
  return JSON.stringify([record.tenantId ?? null, record.conversationId, record.user?.toString()]);
}

/** Empty means never counted (no agent, sub-agent thread, temporary chat); null means a
 *  legacy conversation without `initial_agent_id`. */
function hintFor(
  conversation: Partial<Record<'isTemporary' | 'initial_agent_id', unknown>>,
): string | null {
  if (
    Object.prototype.hasOwnProperty.call(conversation, 'subagentThread') ||
    conversation.isTemporary === true
  ) {
    return '';
  }
  if (!Object.prototype.hasOwnProperty.call(conversation, 'initial_agent_id')) return null;
  return typeof conversation.initial_agent_id === 'string' ? conversation.initial_agent_id : '';
}

async function readRoots(
  mongoose: typeof import('mongoose'),
  records: readonly InsightsRecordIdentity[],
  { preview = false }: { preview?: boolean } = {},
): Promise<Map<string, string | null>> {
  const Conversation = mongoose.models.Conversation as Model<IConversation> | undefined;
  const identities = new Map<string, InsightsRecordIdentity>();
  for (const record of records) {
    if (!record.conversationId || !record.user?.toString()) continue;
    identities.set(insightsIdentityKey(record), record);
  }
  const roots = new Map<string, string | null>();
  if (!Conversation || identities.size === 0) return roots;
  const conversations = await Conversation.find(
    {
      $or: [...identities.values()].map(({ conversationId, user, tenantId }) => ({
        conversationId,
        user: user?.toString(),
        tenantId: tenantId ?? { $exists: false },
      })),
    },
    {
      _id: 0,
      conversationId: 1,
      user: 1,
      tenantId: 1,
      initial_agent_id: 1,
      subagentThread: 1,
      isTemporary: 1,
      agent_id: 1,
    },
  ).lean<ConversationRoot[]>();
  for (const conversation of conversations) {
    const { agent_id } = conversation;
    const legacy = typeof agent_id === 'string' && agent_id.trim() !== '' ? agent_id : null;
    roots.set(
      insightsIdentityKey(conversation),
      hintFor(conversation) ?? (preview ? legacy : null),
    );
  }
  return roots;
}

export async function resolveInsightsAttributions(
  mongoose: typeof import('mongoose'),
  records: readonly InsightsRecordIdentity[],
  options: { preview?: boolean } = {},
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const [key, hint] of await readRoots(mongoose, records, options)) {
    if (hint != null) result.set(key, hint);
  }
  return result;
}

type Turn = { hints: Map<string, string>; legacy: Set<string>; pending: Set<string> };

const turns = new WeakMap<TenantContext, Turn>();

function getTurn(): Turn {
  const context = tenantStorage.getStore();
  const turn = (context && turns.get(context)) ?? {
    hints: new Map(),
    legacy: new Set(),
    pending: new Set(),
  };
  if (context?.userId) turns.set(context, turn);
  return turn;
}

function remember({ hints, legacy }: Turn, key: string, hint: string | null): void {
  if (hint == null) legacy.add(key);
  else if (!hints.has(key)) hints.set(key, hint);
}

export function rememberInsightsRoot(conversation: IConversation | null): IConversation | null {
  if (!conversation) return conversation;
  remember(getTurn(), insightsIdentityKey(conversation), hintFor(conversation));
  delete conversation.initial_agent_id;
  return conversation;
}

export async function lookupInsightsAttributions(
  mongoose: typeof import('mongoose'),
  records: readonly InsightsRecordIdentity[],
): Promise<{ fresh: boolean; hints: Map<string, string> }> {
  const turn = getTurn();
  const { hints, legacy } = turn;
  const missing = records.filter((record) => !hints.has(insightsIdentityKey(record)));
  const unread = missing.filter((record) => !legacy.has(insightsIdentityKey(record)));
  try {
    for (const [key, hint] of await readRoots(mongoose, unread)) remember(turn, key, hint);
    return { fresh: unread.length === missing.length, hints };
  } catch (error) {
    logger.error('[lookupInsightsAttributions] Failed to read Insights attribution', error);
    return { fresh: false, hints };
  }
}

export async function withInsightsAttribution<
  T extends InsightsRecordIdentity & { insightsAgentId?: string },
>(
  mongoose: typeof import('mongoose'),
  records: readonly T[],
): Promise<Array<Omit<T, 'insightsAgentId'> & { insightsAgentId?: string }>> {
  const { hints } = await lookupInsightsAttributions(mongoose, records);
  return records.map((record) => {
    const { insightsAgentId: _hint, ...fields } = record;
    const hint = hints.get(insightsIdentityKey(record));
    return { ...fields, ...(hint !== undefined && { insightsAgentId: hint }) };
  });
}

async function storeAttribution(
  mongoose: typeof import('mongoose'),
  { conversationId, user, tenantId }: { conversationId: string; user: string; tenantId?: string },
  hint: string,
  { created, session }: { created?: boolean; session?: ClientSession },
): Promise<void> {
  const filter = {
    conversationId,
    user,
    tenantId: tenantId ?? { $exists: false },
    insightsAgentId: created ? { $exists: false } : { $ne: hint },
  };
  const update = { $set: { insightsAgentId: hint } };
  /** Transactions store the owner as an ObjectId. */
  const models = [
    mongoose.models.Message,
    ...(mongoose.isValidObjectId(user) ? [mongoose.models.Transaction] : []),
  ].filter((model) => model != null);
  if (session) {
    for (const model of models) {
      await model.updateMany(filter, update, { timestamps: false, session });
    }
    return;
  }
  await Promise.all(
    models.map((model) =>
      retryWithBackoff(
        async () => model.updateMany(filter, update, { timestamps: false }),
        `updateMany(${model.modelName})`,
      ),
    ),
  );
}

export async function syncInsightsAttribution(
  mongoose: typeof import('mongoose'),
  saved: Record<string, unknown>,
  {
    created,
    converted,
    session,
  }: { created?: boolean; converted?: boolean; session?: ClientSession },
): Promise<void> {
  const { conversationId, user, tenantId } = saved;
  if (typeof conversationId !== 'string' || typeof user !== 'string') return;
  const hint = hintFor(saved);
  if (hint == null) return;
  const identity = { conversationId, user, ...(typeof tenantId === 'string' && { tenantId }) };
  const { hints, pending } = getTurn();
  const key = insightsIdentityKey(identity);
  if (!created && !converted && !hints.get(key) && !pending.has(key)) return;
  const unneeded = created && hint === '';
  if (session?.inTransaction()) {
    if (!unneeded) await storeAttribution(mongoose, identity, hint, { created, session });
    return runAfterTransaction(session, async () => {
      hints.set(key, hint);
      pending.delete(key);
    });
  }
  hints.set(key, hint);
  if (unneeded) return;
  pending.add(key);
  try {
    await storeAttribution(mongoose, identity, hint, { created });
    pending.delete(key);
  } catch (error) {
    logger.error('[syncInsightsAttribution] Failed to attribute Insights records', error);
  }
}

type ExcludedChat = { conversationId: string; user: string; tenantId?: string };

const exclusionOf = ({ conversationId, user, tenantId }: ExcludedChat) => ({
  conversationId,
  user,
  tenantId: tenantId ?? { $exists: false },
});

export async function excludeFromInsights(
  mongoose: typeof import('mongoose'),
  chat: ExcludedChat,
  session?: ClientSession,
): Promise<boolean> {
  try {
    const { upsertedCount } = await createInsightsExclusionModel(mongoose).updateOne(
      exclusionOf(chat),
      { $setOnInsert: { createdAt: new Date() } },
      { upsert: true, session },
    );
    return upsertedCount > 0;
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) return false;
    throw error;
  }
}

export async function includeInInsights(
  mongoose: typeof import('mongoose'),
  chat: ExcludedChat,
  session?: ClientSession,
): Promise<void> {
  await createInsightsExclusionModel(mongoose).deleteOne(exclusionOf(chat), { session });
}

const exclusionBatchSize = 1000;

export async function clearExcludedRecords(
  mongoose: typeof import('mongoose'),
  tenant: FilterQuery<IConversation>,
  reported: Partial<Record<'Message' | 'Transaction', FilterQuery<IMessage>>>,
): Promise<void> {
  const Exclusion = createInsightsExclusionModel(mongoose);
  if (!(await Exclusion.exists(tenant))) return;
  const clear = async (conversationIds: string[]) => {
    if (conversationIds.length === 0) return;
    const excluded = await Exclusion.find(
      { ...tenant, conversationId: { $in: conversationIds } },
      { _id: 0, conversationId: 1, user: 1 },
    ).lean();
    if (excluded.length === 0) return;
    const owned = excluded.filter(({ user }) => mongoose.isValidObjectId(user));
    const counted = { ...tenant, insightsAgentId: { $nin: ['', null] } };
    const update = { $set: { insightsAgentId: '' } };
    await mongoose.models.Message.updateMany(
      { ...counted, $or: excluded.map(({ conversationId, user }) => ({ conversationId, user })) },
      update,
      { timestamps: false },
    );
    if (owned.length === 0) return;
    await mongoose.models.Transaction.updateMany(
      {
        ...counted,
        $or: owned.map(({ conversationId, user }) => ({
          conversationId,
          user: new mongoose.Types.ObjectId(user),
        })),
      },
      update,
      { timestamps: false },
    );
  };
  for (const [name, match] of Object.entries(reported)) {
    let batch: string[] = [];
    const conversations = mongoose.models[name]
      .aggregate<{ _id: unknown }>([{ $match: match }, { $group: { _id: '$conversationId' } }])
      .cursor({ batchSize: exclusionBatchSize });
    for await (const { _id } of conversations) {
      if (typeof _id === 'string') batch.push(_id);
      if (batch.length < exclusionBatchSize) continue;
      await clear(batch);
      batch = [];
    }
    await clear(batch);
  }
}
