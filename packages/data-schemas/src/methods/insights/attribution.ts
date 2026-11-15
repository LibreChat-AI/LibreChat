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
  const conversations = cachedConversations.filter((conversation) => {
    const key = insightsIdentityKey(conversation);
    if (!identities.has(key)) return false;
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
        },
      ).lean<InsightsConversationContext[]>()),
    );
  for (const conversation of conversations) {
    if (Object.prototype.hasOwnProperty.call(conversation, 'subagentThread')) {
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
