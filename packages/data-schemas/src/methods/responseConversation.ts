import type {
  ResponseOwner,
  StoredResponseRecord,
  ResponseExecutionBinding,
} from '~/models/response';
import type { CanonicalConversationTarget } from '~/types/managed';
import type { ResponseConversationWrites } from './responseTurn';
import { assertManagedTenant, canonicalConversationFilter } from './managed';
import { responseRootFilter, responseReference } from './responseRoot';
import { createStoredResponseModel } from '~/models/response';
import { createConversationMethods } from './conversation';
import { activeExpirationFilter } from '~/utils/retention';
import { isManagedConversationId } from '~/utils/managed';
import { createConversationModel } from '~/models/convo';
import { responseProviderFilter } from '~/utils/receipt';
import { isResponseScopeClosed } from './responseScope';
import { publishResponseTarget } from './projection';
import { createMessageMethods } from './message';

/** Capture existing canonical identity and retention in one primary read at request acceptance. */
export async function readResponseConversationTarget(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  conversationId: string,
): Promise<{
  target: CanonicalConversationTarget;
  expiredAt?: Date;
  isTemporary?: boolean;
} | null> {
  assertManagedTenant(owner.tenantId);
  if (!owner.userId || !conversationId) throw new TypeError('Invalid Response conversation owner');
  const row = await createConversationModel(mongoose)
    .findOne({
      user: owner.userId,
      tenantId: owner.tenantId || { $in: [null, ''] },
      conversationId,
    })
    .select('_id expiredAt isTemporary')
    .read('primary')
    .lean();
  if (!row) return null;
  return {
    target: {
      id: String(row._id),
      userId: owner.userId,
      conversationId,
      ...(owner.tenantId ? { tenantId: owner.tenantId } : {}),
    },
    ...(row.expiredAt ? { expiredAt: row.expiredAt } : {}),
    ...(row.isTemporary != null ? { isTemporary: row.isTemporary } : {}),
  };
}

/** Seed once before model work, or verify the physical identity captured at acceptance. */
export async function prepareResponseConversation(
  mongoose: typeof import('mongoose'),
  record: StoredResponseRecord,
  binding: ResponseExecutionBinding,
  writes: ResponseConversationWrites,
): Promise<StoredResponseRecord | null> {
  if (
    writes.context.userId !== record.userId ||
    writes.conversation.conversationId !== record.conversationId ||
    writes.conversation.agent_id !== record.agentId
  )
    throw new TypeError('Response conversation preparation identity changed');
  const physical = responseRootFilter(mongoose, responseReference(record));
  const active = {
    ...physical,
    ...responseProviderFilter(binding),
    status: 'in_progress',
    $and: [activeExpirationFilter<StoredResponseRecord>()],
  };
  const roots = createStoredResponseModel(mongoose);
  const current = await roots.findOne(active).lean();
  if (!current || (await isResponseScopeClosed(mongoose, current, current.conversationId)))
    return null;
  const conversations = createConversationModel(mongoose);
  const expiredAt =
    current.expiredAt && (!writes.context.expiredAt || current.expiredAt < writes.context.expiredAt)
      ? current.expiredAt
      : writes.context.expiredAt;
  const context = {
    ...writes.context,
    ...(expiredAt ? { expiredAt } : {}),
    ...(current.isTemporary === true || writes.context.isTemporary === true
      ? { isTemporary: true }
      : {}),
  };
  if (context.isTemporary === true && current.isTemporary !== true)
    await roots.updateOne(
      active,
      { $set: { isTemporary: true }, $inc: { revision: 1 } },
      { upsert: false },
    );
  if (current.conversationTarget) {
    if (
      current.conversationTarget.userId !== current.userId ||
      current.conversationTarget.conversationId !== current.conversationId ||
      (current.conversationTarget.tenantId || undefined) !== (current.tenantId || undefined)
    )
      throw new Error('Response captured conversation identity changed');
    if (expiredAt || context.isTemporary === true) {
      const messages = createMessageMethods(mongoose);
      const retained = await createConversationMethods(mongoose, {
        conversationTarget: current.conversationTarget,
        getMessages: messages.getMessages,
        deleteMessages: messages.deleteMessages,
      }).saveConvo(
        context,
        { conversationId: current.conversationId },
        {
          appendMessageIds: [],
          preserveUpdatedAt: true,
          context: 'Responses API - retain captured conversation',
        },
      );
      if (
        !retained ||
        !('_id' in retained) ||
        String(retained._id) !== current.conversationTarget.id
      )
        return null;
      return (await isResponseScopeClosed(mongoose, current, current.conversationId))
        ? null
        : roots.findOne(active).lean();
    }
    const present = await conversations
      .exists({
        ...canonicalConversationFilter(mongoose, current.conversationTarget),
        $and: [activeExpirationFilter()],
      })
      .read('primary');
    return present && !(await isResponseScopeClosed(mongoose, current, current.conversationId))
      ? current
      : null;
  }
  // Existing conversations must already have been captured. A missing continuation
  // is never a new conversation, even when it uses the managed namespace.
  if (
    !isManagedConversationId(current.conversationId) ||
    JSON.parse(current.requestJSON).previous_response_id
  )
    return null;
  const published = await publishResponseTarget(
    mongoose,
    {
      ...current,
      parentId: current.storageTarget!.id,
      logicalId: current.conversationId,
      kind: 'conversation',
      execution: binding,
    },
    async (publication, expiredAt) => {
      const messages = createMessageMethods(mongoose);
      return createConversationMethods(mongoose, {
        managedPublication: publication,
        getMessages: messages.getMessages,
        deleteMessages: messages.deleteMessages,
      }).saveConvo(
        {
          ...context,
          ...(expiredAt && (!context.expiredAt || expiredAt < context.expiredAt)
            ? { expiredAt }
            : {}),
        },
        writes.conversation,
        {
          initialAgentId: writes.initialAgentId,
          appendMessageIds: [],
          context: 'Responses API - seed canonical conversation',
        },
      );
    },
    { expiredAt: current.expiredAt },
  );
  if (!published || !('_id' in published.value) || !published.value._id) return null;
  const target: CanonicalConversationTarget = {
    id: String(published.value._id),
    conversationId: current.conversationId,
    userId: current.userId,
    ...(current.tenantId ? { tenantId: current.tenantId } : {}),
  };
  let captured: StoredResponseRecord | null = null;
  let captureFailure: { error: unknown } | undefined;
  try {
    captured = await roots
      .findOneAndUpdate(
        {
          ...active,
          conversationTarget: { $exists: false },
        },
        { $set: { conversationTarget: target }, $inc: { revision: 1 } },
        { new: true, upsert: false },
      )
      .lean();
  } catch (error) {
    captureFailure = { error };
  }
  if (captured)
    return (await isResponseScopeClosed(mongoose, current, current.conversationId))
      ? null
      : captured;
  // A concurrent or uncertain acknowledgment may have bound the same target, never another.
  const recovered = await roots
    .findOne({
      ...active,
      'conversationTarget.id': target.id,
      'conversationTarget.userId': target.userId,
      'conversationTarget.conversationId': target.conversationId,
    })
    .lean();
  if (recovered)
    return (await isResponseScopeClosed(mongoose, current, current.conversationId))
      ? null
      : recovered;
  if (captureFailure) throw captureFailure.error;
  return null;
}
