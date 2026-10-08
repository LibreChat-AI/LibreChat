import mongoose from 'mongoose';
import type { IConversation } from '@librechat/data-schemas';
import type { AgentEventCheckpointReference } from '../checkpointer';

function conversations() {
  const db = mongoose.connection.db;
  if (!db || mongoose.connection.readyState !== 1) {
    throw new Error('Actor checkpoint cleanup requires Mongo storage');
  }
  return db.collection<Omit<IConversation, 'tenantId'> & { tenantId?: string | null }>(
    mongoose.models.Conversation?.collection.name ?? 'conversations',
  );
}

export async function acknowledgeActorPruning(
  user: string,
  tenantId: string | undefined,
  conversationId: string,
  reference: AgentEventCheckpointReference,
): Promise<void> {
  await conversations().updateOne(
    { user, tenantId: tenantId ?? null, conversationId },
    { $pull: { agentEventActorCleanup: reference } },
  );
}

export async function drainActorPruning(
  user: string,
  tenantId: string | undefined,
  conversationId: string,
  remove: (reference: AgentEventCheckpointReference) => Promise<void>,
): Promise<void> {
  const conversation = await conversations().findOne(
    { user, tenantId: tenantId ?? null, conversationId },
    { projection: { agentEventActorCleanup: 1 } },
  );
  for (const reference of conversation?.agentEventActorCleanup ?? []) {
    await remove(reference);
    await acknowledgeActorPruning(user, tenantId, conversationId, reference);
  }
}

/** Read hidden historical evidence while the owner-filtered conversation still exists. */
export async function* historicalActorReferences(
  user: string,
  tenantId: string | undefined,
  conversationIds: readonly string[] | undefined,
): AsyncGenerator<AgentEventCheckpointReference> {
  const ids = conversationIds == null ? undefined : [...new Set(conversationIds)];
  for (let offset = 0; offset < (ids?.length ?? 1); offset += 256) {
    const cursor = conversations().find(
      {
        user,
        tenantId: tenantId ? { $in: [tenantId, null] } : null,
        subagentThread: { $exists: true },
        ...(ids && { conversationId: { $in: ids.slice(offset, offset + 256) } }),
      },
      {
        projection: {
          conversationId: 1,
          'agentEventActor.checkpoint': 1,
          'agentEventActor.previousCheckpoint': 1,
          'agentEventActorSuspension.suspension.checkpoint': 1,
          'agentEventActorSuspension.suspension.invocation.fork': 1,
          'agentEventActorSuspension.suspension.invocation.base.checkpoint': 1,
          'agentEventActorReconciliations.checkpoint': 1,
          agentEventActorCleanup: 1,
        },
      },
    );
    for await (const conversation of cursor) {
      const suspension = conversation.agentEventActorSuspension?.suspension;
      const candidates = [
        conversation.agentEventActor?.checkpoint,
        conversation.agentEventActor?.previousCheckpoint,
        suspension?.checkpoint,
        suspension?.invocation?.fork,
        suspension?.invocation?.base?.checkpoint,
        ...(conversation.agentEventActorReconciliations ?? []).map((entry) => entry.checkpoint),
        ...(conversation.agentEventActorCleanup ?? []),
      ];
      const seen = new Set<string>();
      for (const reference of candidates) {
        if (
          typeof reference?.checkpointId !== 'string' ||
          reference.checkpointId.length === 0 ||
          typeof reference.checkpointNs !== 'string' ||
          !reference.checkpointNs.startsWith('event-actor/') ||
          reference.threadId !== conversation.conversationId
        ) {
          continue;
        }
        const key = JSON.stringify([
          reference.threadId,
          reference.checkpointNs,
          reference.checkpointId,
        ]);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        yield {
          threadId: reference.threadId,
          checkpointNs: reference.checkpointNs,
          checkpointId: reference.checkpointId,
        };
      }
    }
  }
}
