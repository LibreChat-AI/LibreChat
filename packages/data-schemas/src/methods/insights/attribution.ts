import type { Model } from 'mongoose';
import type { IConversation } from '~/types/convo';

export type InsightsRecordIdentity = {
  conversationId?: string;
  user?: string | { toString(): string };
  tenantId?: string;
};

export type InsightsConversationContext = {
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

/** Empty means permanently unattributed; absent means legacy/dynamic or not yet resolved. */
export async function resolveInsightsAttributions(
  mongoose: typeof import('mongoose'),
  records: readonly InsightsRecordIdentity[],
  cachedConversations: readonly InsightsConversationContext[] = [],
): Promise<Map<string, string>> {
  const Conversation = mongoose.models.Conversation as Model<IConversation> | undefined;
  const identities = new Map<string, InsightsRecordIdentity>();
  for (const record of records) {
    if (!record.conversationId || !record.user?.toString()) continue;
    identities.set(insightsIdentityKey(record), record);
  }
  const result = new Map<string, string>();
  /** `initial_agent_id` is not selected when the app loads a conversation, so a loaded copy
   *  without it says nothing about the root: only a copy that settles the hint skips the read. */
  const conversations = cachedConversations.filter((conversation) => {
    const key = insightsIdentityKey(conversation);
    const decisive =
      Object.prototype.hasOwnProperty.call(conversation, 'initial_agent_id') ||
      Object.prototype.hasOwnProperty.call(conversation, 'subagentThread') ||
      conversation.isTemporary === true;
    if (!decisive || !identities.has(key)) return false;
    identities.delete(key);
    return true;
  });
  if (Conversation && identities.size > 0)
    conversations.push(
      ...(await Conversation.find(
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
      ).lean<InsightsConversationContext[]>()),
    );
  for (const conversation of conversations) {
    /** Insights reads trust the hint without re-checking the conversation, so every chat it
     *  must not count is marked here: sub-agent threads and temporary chats. */
    if (
      Object.prototype.hasOwnProperty.call(conversation, 'subagentThread') ||
      conversation.isTemporary === true
    ) {
      result.set(insightsIdentityKey(conversation), '');
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(conversation, 'initial_agent_id')) continue;
    result.set(
      insightsIdentityKey(conversation),
      typeof conversation.initial_agent_id === 'string' ? conversation.initial_agent_id : '',
    );
  }
  return result;
}

/** Server-derived hints are never accepted from a message/transaction payload. */
export async function withInsightsAttribution<
  T extends InsightsRecordIdentity & {
    insightsAgentId?: string;
    insightsConversation?: InsightsConversationContext;
  },
>(
  mongoose: typeof import('mongoose'),
  records: readonly T[],
): Promise<
  Array<Omit<T, 'insightsAgentId' | 'insightsConversation'> & { insightsAgentId?: string }>
> {
  const sources = records
    .map((record) => record.insightsConversation)
    .filter((source): source is InsightsConversationContext => source != null);
  const attributions = await resolveInsightsAttributions(mongoose, records, sources);
  return records.map((record) => {
    const { insightsAgentId: _hint, insightsConversation: _context, ...fields } = record;
    const hint = attributions.get(insightsIdentityKey(record));
    return { ...fields, ...(hint !== undefined && { insightsAgentId: hint }) };
  });
}

/** A new conversation's first records are saved before the conversation exists, so they could not
 *  resolve a hint then. When the conversation is created, those records receive it. */
export async function attributeEarlierRecords(
  mongoose: typeof import('mongoose'),
  saved: Record<string, unknown>,
): Promise<void> {
  const { conversationId, user, tenantId } = saved;
  if (typeof conversationId !== 'string' || typeof user !== 'string') return;
  const conversation: InsightsConversationContext = {
    conversationId,
    user,
    ...(typeof tenantId === 'string' && { tenantId }),
    ...(Object.prototype.hasOwnProperty.call(saved, 'initial_agent_id') && {
      initial_agent_id: saved.initial_agent_id as string | null,
    }),
    ...(Object.prototype.hasOwnProperty.call(saved, 'subagentThread') && {
      subagentThread: saved.subagentThread as object | null,
    }),
    ...(saved.isTemporary === true && { isTemporary: true }),
  };
  const hint = (await resolveInsightsAttributions(mongoose, [conversation], [conversation])).get(
    insightsIdentityKey(conversation),
  );
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
