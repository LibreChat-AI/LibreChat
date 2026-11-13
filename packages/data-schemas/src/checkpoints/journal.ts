import mongoose from 'mongoose';
import { createHash } from 'crypto';
import type {
  CheckpointDeletionJournal,
  CheckpointDeletionTarget,
  CheckpointReference,
  CheckpointStorageConfig,
} from './types';
import { checkpointDatabase, checkpointModelCollectionName } from './database';
import { checkpointOwnerNamespacePrefix } from './identity';
import { checkpointStorageKey } from './catalog';

type DeletionRow = Omit<CheckpointDeletionTarget, 'id'> & { _id: string };
const targetFromRow = ({ _id, ...target }: DeletionRow): CheckpointDeletionTarget => ({
  id: _id,
  ...target,
});

const DELETION_COLLECTION = 'agent_checkpoint_deletions';

async function hasPersistence(target: CheckpointDeletionTarget): Promise<boolean> {
  const db = checkpointDatabase();
  const { userId, tenantId, threadId, checkpoint, storage } = target;
  const owners = (tenantId ? [tenantId, undefined] : [undefined]).map((tenant) =>
    checkpointOwnerNamespacePrefix(userId, tenant),
  );
  const user = mongoose.isValidObjectId(userId) ? new mongoose.Types.ObjectId(userId) : userId;
  const siblingCollections = [
    [checkpointModelCollectionName('Conversation', 'conversations'), userId],
    [checkpointModelCollectionName('Message', 'messages'), userId],
    [checkpointModelCollectionName('ToolCall', 'toolcalls'), user],
    [checkpointModelCollectionName('SharedLink', 'sharedlinks'), userId],
  ] as const;
  const siblings = siblingCollections.map(([name, owner]) =>
    db
      .collection(name)
      .findOne({ user: owner, conversationId: threadId }, { projection: { _id: 1 } }),
  );
  const payload =
    storage.type === 'memory'
      ? []
      : [storage.checkpointCollectionName, storage.checkpointWritesCollectionName].map((name) =>
          db.collection(name).findOne(
            {
              $or: [
                ...owners.map((owner) => ({
                  thread_id: { $in: [threadId, `${owner}${threadId}`] },
                  $or: [{ checkpoint_ns: { $regex: `^${owner}` } }, { lc_owner: owner }],
                })),
                ...(checkpoint == null
                  ? []
                  : [
                      {
                        thread_id: checkpoint.threadId,
                        checkpoint_ns: checkpoint.checkpointNs,
                        checkpoint_id: checkpoint.checkpointId,
                        $or: [{ lc_owner: { $in: owners } }, { lc_owner: { $exists: false } }],
                      },
                    ]),
              ],
            },
            { projection: { _id: 1 } },
          ),
        );
  return (await Promise.all([...siblings, ...payload])).some((row) => row != null);
}

function deletionPrefixes(
  userId: string,
  tenantId: string | undefined,
  rootConversationId: string | undefined,
): string[] {
  const rootHash = createHash('sha256')
    .update(JSON.stringify(rootConversationId ?? null))
    .digest('hex');
  return (tenantId ? [tenantId, undefined] : [undefined]).map((tenant) => {
    const owner = checkpointOwnerNamespacePrefix(userId, tenant);
    return rootConversationId == null ? owner : `${owner}[0-9a-f]{64}:${rootHash}:`;
  });
}

export function createCheckpointDeletionJournal(): CheckpointDeletionJournal {
  const collection = () => checkpointDatabase().collection<DeletionRow>(DELETION_COLLECTION);
  return {
    async retained(userId, tenantId, rootConversationId) {
      const prefixes = deletionPrefixes(userId, tenantId, rootConversationId);
      return (
        await collection()
          .find({ $or: prefixes.map((prefix) => ({ _id: { $regex: `^${prefix}` } })) })
          .toArray()
      ).map(targetFromRow);
    },
    async remember(targets) {
      // eslint-disable-next-line no-restricted-syntax -- Native journal collection; receipts are owner-qualified CAS identities.
      await collection().bulkWrite(
        targets.map(({ id, ...fields }) => ({
          updateOne: { filter: { _id: id }, update: { $set: fields }, upsert: true },
        })),
      );
    },
    async acknowledge(targets) {
      await collection().deleteMany({
        $or: targets.map(({ id, version }) => ({ _id: id, version })),
      });
    },
    async hasPending(userId, tenantId, rootConversationId) {
      const prefixes = deletionPrefixes(userId, tenantId, rootConversationId);
      return (
        (await collection().findOne(
          { $or: prefixes.map((prefix) => ({ _id: { $regex: `^${prefix}` } })) },
          { projection: { _id: 1 } },
        )) != null
      );
    },
    async scan(limit, after) {
      return (
        await collection()
          .find(after == null ? {} : { _id: { $gt: after } })
          .sort({ _id: 1 })
          .limit(limit)
          .toArray()
      ).map(targetFromRow);
    },
    async reclaim(target) {
      return (await collection().deleteOne({ _id: target.id, version: target.version }))
        .deletedCount;
    },
    async hasConversation(userId, threadId) {
      return (
        (await checkpointDatabase()
          .collection(checkpointModelCollectionName('Conversation', 'conversations'))
          .findOne({ user: userId, conversationId: threadId }, { projection: { _id: 1 } })) != null
      );
    },
    hasPersistence,
  };
}

/** Preserve persisted journal keys so mixed-version retries share the same CAS receipts. */
export function checkpointDeletionTarget(
  scope: { userId: string; tenantId?: string; rootConversationId?: string },
  storage: CheckpointStorageConfig,
  threadId: string,
  version: string,
  checkpoint?: CheckpointReference,
  proof?: 'owned' | 'historical',
): CheckpointDeletionTarget {
  const hash = (value: string | null): string =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const prefix = `${checkpointOwnerNamespacePrefix(scope.userId, scope.tenantId)}${checkpointStorageKey(storage)}:${hash(scope.rootConversationId ?? null)}:`;
  const evidence =
    checkpoint == null
      ? ''
      : `:${hash(JSON.stringify(proof === 'owned' ? [checkpoint.threadId, checkpoint.checkpointNs, checkpoint.checkpointId] : [checkpoint.checkpointNs, checkpoint.checkpointId]))}`;
  return {
    id: `${prefix}${hash(threadId)}${evidence}`,
    version,
    threadId,
    userId: scope.userId,
    tenantId: scope.tenantId,
    storage,
    ...(checkpoint == null ? {} : { checkpoint }),
  };
}
