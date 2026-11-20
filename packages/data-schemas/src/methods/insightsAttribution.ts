import type { Model } from 'mongoose';
import type { IConversation } from '~/types/convo';

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
};

export function insightsIdentityKey(record: InsightsRecordIdentity): string {
  return JSON.stringify([record.tenantId ?? null, record.conversationId, record.user?.toString()]);
}

/** Empty means never counted (no agent, sub-agent thread, temporary chat); undefined means a
 *  legacy conversation without `initial_agent_id`. */
function hintFor(conversation: Record<string, unknown>): string | undefined {
  if (
    Object.prototype.hasOwnProperty.call(conversation, 'subagentThread') ||
    conversation.isTemporary === true
  ) {
    return '';
  }
  if (!Object.prototype.hasOwnProperty.call(conversation, 'initial_agent_id')) return undefined;
  return typeof conversation.initial_agent_id === 'string' ? conversation.initial_agent_id : '';
}

export async function resolveInsightsAttributions(
  mongoose: typeof import('mongoose'),
  records: readonly InsightsRecordIdentity[],
): Promise<Map<string, string>> {
  const Conversation = mongoose.models.Conversation as Model<IConversation> | undefined;
  const identities = new Map<string, InsightsRecordIdentity>();
  for (const record of records) {
    if (!record.conversationId || !record.user?.toString()) continue;
    identities.set(insightsIdentityKey(record), record);
  }
  const result = new Map<string, string>();
  if (!Conversation || identities.size === 0) return result;
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
    },
  ).lean<ConversationRoot[]>();
  for (const conversation of conversations) {
    const hint = hintFor(conversation);
    if (hint !== undefined) result.set(insightsIdentityKey(conversation), hint);
  }
  return result;
}

export async function withInsightsAttribution<
  T extends InsightsRecordIdentity & { insightsAgentId?: string },
>(
  mongoose: typeof import('mongoose'),
  records: readonly T[],
): Promise<Array<Omit<T, 'insightsAgentId'> & { insightsAgentId?: string }>> {
  const attributions = await resolveInsightsAttributions(mongoose, records);
  return records.map((record) => {
    const { insightsAgentId: _hint, ...fields } = record;
    const hint = attributions.get(insightsIdentityKey(record));
    return { ...fields, ...(hint !== undefined && { insightsAgentId: hint }) };
  });
}

export async function attributeEarlierRecords(
  mongoose: typeof import('mongoose'),
  saved: Record<string, unknown>,
): Promise<void> {
  const { conversationId, user } = saved;
  if (typeof conversationId !== 'string' || typeof user !== 'string') return;
  const hint = hintFor(saved);
  if (hint === undefined) return;
  const filter = { conversationId, user, insightsAgentId: { $exists: false } };
  const update = { $set: { insightsAgentId: hint } };
  /** Transactions store the owner as an ObjectId. */
  const models = [
    mongoose.models.Message,
    ...(mongoose.isValidObjectId(user) ? [mongoose.models.Transaction] : []),
  ];
  await Promise.all(
    models
      .filter((model) => model != null)
      .map((model) => model.updateMany(filter, update, { timestamps: false })),
  );
}
