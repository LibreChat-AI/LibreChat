import { createActorCheckpointPruning } from '@librechat/data-schemas';
import type { ActorCheckpointPruning } from '@librechat/data-schemas';
import type { AgentEventCheckpointReference } from '../checkpointer';

export async function acknowledgeActorPruning(
  user: string,
  tenantId: string | undefined,
  conversationId: string,
  reference: AgentEventCheckpointReference,
  storage: ActorCheckpointPruning = createActorCheckpointPruning(),
): Promise<void> {
  await storage.acknowledge(user, tenantId, conversationId, reference);
}

export async function drainActorPruning(
  user: string,
  tenantId: string | undefined,
  conversationId: string,
  remove: (reference: AgentEventCheckpointReference) => Promise<void>,
  storage: ActorCheckpointPruning = createActorCheckpointPruning(),
): Promise<void> {
  for (const reference of await storage.pending(user, tenantId, conversationId)) {
    await remove(reference);
    await storage.acknowledge(user, tenantId, conversationId, reference);
  }
}

export function historicalActorReferences(
  user: string,
  tenantId: string | undefined,
  conversationIds: readonly string[] | undefined,
  storage: ActorCheckpointPruning = createActorCheckpointPruning(),
): AsyncIterable<AgentEventCheckpointReference> {
  return storage.historical(user, tenantId, conversationIds);
}
