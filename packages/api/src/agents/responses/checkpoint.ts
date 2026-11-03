import { checkpointerSchema } from 'librechat-data-provider';
import type {
  StoredResponseRecord,
  ResponseStorage,
  ResponseCleanupIdentity,
  ResponseExecutionProof,
} from '@librechat/data-schemas';
import { checkpointOwnerNamespacePrefix } from '~/stream/checkpoints';
import { deleteAgentCheckpoint } from '../checkpointer';

/** Cleanup uses captured server settings, never current config or caller-supplied collection names. */
export type ResponseCheckpointIdentity = Pick<
  StoredResponseRecord,
  'userId' | 'tenantId' | 'conversationId'
> & {
  review?: Pick<NonNullable<StoredResponseRecord['review']>, 'checkpointConfigJSON'>;
  pendingTerminal?: Pick<
    NonNullable<StoredResponseRecord['pendingTerminal']>,
    'checkpointNamespace' | 'checkpointConfigJSON'
  >;
};

export async function cleanupResponseCheckpoint(
  record: ResponseCheckpointIdentity,
  checkpointNamespace: string,
): Promise<void> {
  const receipt = record.pendingTerminal;
  const raw = receipt?.checkpointConfigJSON ?? record.review?.checkpointConfigJSON;
  if (!raw || !checkpointNamespace)
    throw new Error('Response checkpoint cleanup identity unavailable');
  if (
    (receipt?.checkpointNamespace && receipt.checkpointNamespace !== checkpointNamespace) ||
    (receipt?.checkpointConfigJSON &&
      record.review?.checkpointConfigJSON &&
      receipt.checkpointConfigJSON !== record.review.checkpointConfigJSON)
  )
    throw new Error('Response checkpoint cleanup identity changed');
  if (
    !checkpointNamespace.startsWith(checkpointOwnerNamespacePrefix(record.userId, record.tenantId))
  )
    throw new Error('Response checkpoint owner changed');
  const config = checkpointerSchema.parse(JSON.parse(raw));
  if (
    !config ||
    config.type !== 'mongo' ||
    !config.checkpointCollectionName ||
    !config.checkpointWritesCollectionName
  )
    throw new Error('Response checkpoint must retain its durable storage settings');
  await deleteAgentCheckpoint(record.conversationId, config, undefined, {
    throwOnError: true,
    checkpointNamespace,
  });
}

/** Physical checkpoint deletion is acknowledged on the same retained Root before it may disappear. */
export async function eraseResponseExecutionCheckpoint(
  storage: Pick<ResponseStorage, 'acknowledgeCheckpointErasure'>,
  identity: ResponseCleanupIdentity,
  proof: ResponseExecutionProof,
  cleanup: (record: ResponseCheckpointIdentity, namespace: string) => Promise<void>,
): Promise<void> {
  if (!proof.checkpointWriterId) {
    if (proof.checkpointNamespace || proof.checkpointConfigJSON)
      throw new Error('Response checkpoint writer identity unavailable');
    return;
  }
  if (!proof.checkpointNamespace || !proof.checkpointConfigJSON)
    throw new Error('Response checkpoint cleanup identity unavailable');
  await cleanup(
    {
      userId: identity.userId,
      ...(identity.tenantId ? { tenantId: identity.tenantId } : {}),
      conversationId: identity.conversationId,
      pendingTerminal: {
        checkpointNamespace: proof.checkpointNamespace,
        checkpointConfigJSON: proof.checkpointConfigJSON,
      },
    },
    proof.checkpointNamespace,
  );
  if (!(await storage.acknowledgeCheckpointErasure(identity, proof)))
    throw new Error('Response checkpoint erasure acknowledgment conflicted');
}
