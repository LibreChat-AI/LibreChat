import type { TCheckpointerConfig } from 'librechat-data-provider';
import type { AgentEventCheckpointReference } from '../checkpointer';
import {
  captureAgentEventCheckpoint,
  deleteOwnedActorCheckpointScope,
  deleteAgentEventCheckpointReference,
  forkAgentEventCheckpoint,
  getAgentCheckpointer,
  LIBRECHAT_CHECKPOINT_NAMESPACE_KEY,
  LIBRECHAT_CHECKPOINT_OWNER_KEY,
  LIBRECHAT_LEGACY_CHECKPOINT_KEY,
} from '../checkpointer';
import { checkpointOwnerNamespacePrefix } from '../../stream/checkpoints';
import { acknowledgeActorPruning, drainActorPruning } from './pruning';

type HistoricalReference = Omit<AgentEventCheckpointReference, 'checkpointId'> & {
  checkpointId?: string;
};

/** Preserve the SDK wire format; each new payload row carries authenticated ownership. */
export function createOwnedActorCheckpoints(user: string, tenantId?: string) {
  const owner = checkpointOwnerNamespacePrefix(user, tenantId);
  async function resolveNamespace(
    reference: HistoricalReference,
    cfg?: TCheckpointerConfig,
  ): Promise<string | undefined> {
    if (!reference.checkpointId)
      throw new Error('Historical actor checkpoint reference is missing its checkpoint id');
    const saver = await getAgentCheckpointer(cfg);
    if (!saver) throw new Error('Event actor checkpoints require a durable checkpointer');
    const tuple = await saver.getTuple({
      configurable: {
        thread_id: reference.threadId,
        checkpoint_ns: '',
        checkpoint_id: reference.checkpointId,
        [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: reference.checkpointNs,
        [LIBRECHAT_CHECKPOINT_OWNER_KEY]: owner,
        [LIBRECHAT_LEGACY_CHECKPOINT_KEY]: reference.checkpointId,
      },
    });
    return tuple?.checkpoint.id === reference.checkpointId ? reference.checkpointNs : undefined;
  }

  const fork: typeof forkAgentEventCheckpoint = async (
    source,
    logical,
    invocationId,
    cfg,
    overlay,
  ) => forkAgentEventCheckpoint(source, logical, invocationId, cfg, overlay, owner);

  async function capture(
    threadId: string,
    logical: string,
    invocationId: string,
    cfg?: TCheckpointerConfig,
    storageNamespace?: string | null,
    legacyCheckpointId?: string,
  ): Promise<AgentEventCheckpointReference | null> {
    if (storageNamespace === null) return null;
    return captureAgentEventCheckpoint(
      threadId,
      storageNamespace ?? logical,
      invocationId,
      cfg,
      owner,
      legacyCheckpointId,
    );
  }

  async function removeOwned(
    reference: Pick<AgentEventCheckpointReference, 'threadId' | 'checkpointNs'>,
    cfg?: TCheckpointerConfig,
  ): Promise<void> {
    await deleteOwnedActorCheckpointScope(reference.threadId, reference.checkpointNs, owner, cfg);
  }

  async function remove(reference: HistoricalReference, cfg?: TCheckpointerConfig): Promise<void> {
    if (!reference.checkpointId)
      throw new Error('Historical actor checkpoint reference is missing its checkpoint id');
    await removeOwned(reference, cfg);
    await deleteAgentEventCheckpointReference(
      { ...reference, checkpointId: reference.checkpointId },
      cfg,
      owner,
    );
  }

  return {
    resolveNamespace,
    fork,
    capture,
    remove,
    removeOwned,
    drain: (threadId: string, cfg?: TCheckpointerConfig) =>
      drainActorPruning(user, tenantId, threadId, (reference) => remove(reference, cfg)),
    acknowledgePruning: (reference: AgentEventCheckpointReference) =>
      acknowledgeActorPruning(user, tenantId, reference.threadId, reference),
  };
}
