import { channelStorageConfigSchema } from 'librechat-data-provider';
import type { ChannelStorageConfig } from 'librechat-data-provider';
import type { Types } from 'mongoose';
import type { ManagedState, ManagedStorageTarget } from '~/types/managed';
import type { ResponseOwner } from '~/models/response';
import { ResponseErasurePendingError, createResponseOwnerErasureMethods } from './responseErasure';
import { reconcileErasedResponseTargets, settleRedactedChannelTarget } from './registration';
import { createAgentChannelModel, CHANNEL_PRIVATE_FIELDS } from '~/models/channel';
import { responseScopeKeys, assertResponseErasureOwner } from './responseScope';
import { managedTargetPredicate, retireManagedAllocation } from './managed';
import { eraseChannelFeedbackForChannel } from './channelFeedbackErasure';
import { eraseChannelIdentitiesForOwner } from './channelIdentityErasure';
import { tenantStorage, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { retireAgentChannel, closeAgentChannel } from './channelScope';
import { createChannelIdentityModel } from '~/models/channelIdentity';
import { createResponseScopeModel } from '~/models/responseScope';
import { createChannelRunModel } from '~/models/channelRun';
import { eraseOwnedChannelRuns } from './channelRunErasure';
import { includeManagedAllocations } from '~/utils/managed';
import { eraseChannelKeysForOwner } from './channelKey';
import { createIndexesWithRetry } from '~/utils/retry';
import { managedRegistryCount } from './registry';

/** Validate operation configuration before the caller closes irreversible admission fences. */
export function resolveChannelErasureConfig(
  options: Partial<ChannelStorageConfig> = {},
): ChannelStorageConfig {
  return channelStorageConfigSchema.parse(options);
}

/** The caller closes the response owner admission anchor before entering this cascade. */
export async function eraseChannelPersistenceForUser(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  options: Pick<Partial<ChannelStorageConfig>, 'erasureBatchSize'> = {},
): Promise<void> {
  const config = resolveChannelErasureConfig(options);
  assertResponseErasureOwner(owner);
  const partitions = owner.tenantId ? [owner, { userId: owner.userId }] : [owner];
  for (const partition of partitions)
    await tenantStorage.run({ tenantId: partition.tenantId || SYSTEM_TENANT_ID }, () =>
      eraseChannelPartition(mongoose, partition, config.erasureBatchSize, true),
    );
  // Provider and checkpoint retirement must positively complete before removing any Run.
  await createResponseOwnerErasureMethods(mongoose).eraseUserResponses(owner);
  for (const partition of partitions)
    await tenantStorage.run({ tenantId: partition.tenantId || SYSTEM_TENANT_ID }, () =>
      eraseChannelPartition(mongoose, partition, config.erasureBatchSize),
    );
}

async function eraseChannelPartition(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  batchSize: number,
  closeOnly = false,
): Promise<void> {
  const ownerKey = responseScopeKeys(owner, '')[0];
  const anchor = await createResponseScopeModel(mongoose).findById(ownerKey).read('primary').lean();
  if (!anchor?.closed) throw new Error('Channel erasure requires closed owner admission');
  managedRegistryCount(anchor);
  const tenantId = owner.tenantId || '_';
  if (!closeOnly) await eraseChannelKeysForOwner(mongoose, owner, anchor.pending ?? []);
  const runs = createChannelRunModel(mongoose);
  const channels = createAgentChannelModel(mongoose);
  await createIndexesWithRetry(channels);
  const partition = owner.tenantId || { $in: [null, ''] };
  interface ConnectionMetadata {
    _id: Types.ObjectId;
    channelId: string;
    createdBy?: string;
    tenantId?: string;
    _managed?: ManagedState;
  }
  const projection = '_id channelId createdBy tenantId _managed';
  async function eraseConnection(connection: ConnectionMetadata): Promise<void> {
    if (connection._managed && connection._managed.phase !== 'published') {
      const target = {
        kind: 'channel' as const,
        id: String(connection._id),
        incarnation: connection._managed.incarnation,
        ...(owner.tenantId && { tenantId: owner.tenantId }),
      };
      if (await retireManagedAllocation(mongoose, target, target.id)) return;
      // Publication may have won the phase CAS. Re-read that same physical target.
      const current = await includeManagedAllocations(
        channels.findOne(managedTargetPredicate(mongoose, target)),
      )
        .select(projection)
        .read('primary')
        .lean<ConnectionMetadata | null>();
      if (!current) return;
      connection = current;
    }
    if (
      connection.createdBy !== owner.userId ||
      (connection._managed && connection._managed.phase !== 'published')
    )
      throw new ResponseErasurePendingError();
    const captured = {
      ...connection,
      id: String(connection._id),
      incarnation: connection._managed?.incarnation,
      createdBy: owner.userId,
    };
    if (closeOnly) {
      await closeAgentChannel(mongoose, captured, true);
      return;
    }
    // Keep redacted deletion metadata while other principals' runs drain. The
    // deleted owner's credentials are erased immediately.
    await retireAgentChannel(mongoose, captured, true, { erasureBatchSize: batchSize });
    if (!connection._managed) throw new Error('Channel cleanup ownership unavailable');
    await eraseChannelFeedbackForChannel(mongoose, {
      kind: 'channel',
      id: String(connection._id),
      incarnation: connection._managed.incarnation,
      ...(connection.tenantId && { tenantId: connection.tenantId }),
    });
    if (
      !(await runs
        .exists({
          channelId: connection.channelId,
          tenantId,
          state: { $in: ['queued', 'executing', 'requires_action', 'delivering', 'blocked'] },
        })
        .read('primary')) &&
      !(await includeManagedAllocations(
        createChannelIdentityModel(mongoose).exists({
          tenantId,
          'identity.channelId': connection.channelId,
        }),
      ).read('primary'))
    )
      await channels.deleteOne({
        _id: connection._id,
        status: 'deleting',
        pendingCount: { $in: [null, 0] },
        'pending.0': { $exists: false },
      });
  }
  // Frozen registrations cover a publisher whose first indexed write lands behind the cursor.
  const entries = (anchor.pending ?? []).filter((entry) => entry.target.kind === 'channel');
  for (const entry of entries) {
    const target: ManagedStorageTarget = entry.target;
    if ((target.tenantId || undefined) !== (owner.tenantId || undefined))
      throw new Error('Channel cleanup target tenant changed');
    const current = await includeManagedAllocations(
      channels.findOne(managedTargetPredicate(mongoose, target)),
    )
      .select(projection)
      .read('primary')
      .lean<ConnectionMetadata | null>();
    if (current) await eraseConnection(current);
  }
  const discovery = {
    tenantId: partition,
    $or: [{ createdBy: owner.userId }, { '_managed.scopeKeys': ownerKey }],
  };
  let after: Types.ObjectId | undefined;
  for (;;) {
    const page = await includeManagedAllocations(
      channels.find({ ...discovery, ...(after && { _id: { $gt: after } }) }),
    )
      .select(projection)
      .sort({ _id: 1 })
      .limit(batchSize)
      .read('primary')
      .lean<ConnectionMetadata[]>();
    if (!page.length) break;
    for (const connection of page) await eraseConnection(connection);
    after = page[page.length - 1]._id;
  }
  if (closeOnly) return;
  // Redact creator credentials before private Run control cleanup can fail.
  await eraseOwnedChannelRuns(mongoose, owner, anchor.pending ?? [], batchSize);
  // Creator channels close and redact credentials before any identity cascade can fail.
  await eraseChannelIdentitiesForOwner(mongoose, owner, batchSize);
  for (const entry of entries) await settleRedactedChannelTarget(mongoose, owner, entry);
  await reconcileErasedResponseTargets(mongoose, owner, []);
  if (
    await includeManagedAllocations(
      channels.exists({
        ...discovery,
        '_managed.phase': { $in: ['published', null] },
        $and: [
          {
            $or: [
              { status: { $ne: 'deleting' } },
              ...CHANNEL_PRIVATE_FIELDS.map((field) => ({ [field]: { $exists: true } })),
            ],
          },
        ],
      }),
    ).read('primary')
  )
    throw new ResponseErasurePendingError();
}
