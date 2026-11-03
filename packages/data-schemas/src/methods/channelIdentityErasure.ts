import { randomUUID } from 'node:crypto';
import type { FilterQuery, Types } from 'mongoose';
import type {
  ManagedState,
  ManagedTarget,
  ManagedRegistrationIntent,
  ManagedRegistryState,
} from '~/types/managed';
import type { ChannelIdentityRecord } from '~/models/channelIdentity';
import type { ResponseOwner } from '~/models/response';
import {
  managedTargetPredicate,
  retireManagedAllocation,
  assertManagedCleanupTenant,
} from './managed';
import {
  createChannelIdentityModel,
  CHANNEL_IDENTITY_PRIVATE_FIELDS,
} from '~/models/channelIdentity';
import { settleRedactedIdentityTarget, reconcileErasedResponseTargets } from './registration';
import { channelRegistryKey, reconcileClosedChannelTarget } from './channelRegistry';
import { identityRedactionFields } from './channelIdentityPrivacy';
import { createResponseScopeModel } from '~/models/responseScope';
import { includeManagedAllocations } from '~/utils/managed';
import { createAgentChannelModel } from '~/models/channel';
import { responseScopeKeys } from './responseScope';
import { managedRegistryCount } from './registry';

/** Irreversible exact-root closure; retained child registrations remain the drain owner. */
export async function retireChannelIdentity(
  mongoose: typeof import('mongoose'),
  target: ManagedTarget<'channelIdentity'>,
  revision?: string,
): Promise<boolean> {
  assertManagedCleanupTenant(target.tenantId);
  const model = createChannelIdentityModel(mongoose);
  const filter = managedTargetPredicate(mongoose, target);
  if (revision === undefined && (await retireManagedAllocation(mongoose, target, target.id)))
    return true;
  const placeholders = identityRedactionFields(target.id);
  const retired = await model.updateOne(
    {
      ...filter,
      '_managed.phase': 'published',
      ...(revision !== undefined && { revision }),
    },
    {
      $set: {
        ...placeholders,
        state: 'revoked',
        revision: randomUUID(),
        ticketExpiresAtMs: 0,
        expiresAtMs: 0,
        '_managed.phase': 'retired',
      },
      $unset: Object.fromEntries(
        CHANNEL_IDENTITY_PRIVATE_FIELDS.filter(
          (field) => !Object.prototype.hasOwnProperty.call(placeholders, field),
        ).map((field) => [field, 1]),
      ),
    },
    { upsert: false },
  );
  if (!retired.matchedCount && revision !== undefined) return false;
  const closed = await includeManagedAllocations(
    model.exists({
      ...filter,
      '_managed.phase': 'retired',
      state: 'revoked',
    }),
  ).read('primary');
  if (closed) await reconcileClosedChannelTarget(mongoose, target);
  await model.deleteOne({
    ...filter,
    '_managed.phase': 'retired',
    pendingCount: { $in: [null, 0] },
    'pending.0': { $exists: false },
  });
  return retired.matchedCount === 1;
}

interface IdentityMetadata {
  _id: Types.ObjectId;
  _managed: ManagedState;
}

async function eraseIdentityTargets(
  mongoose: typeof import('mongoose'),
  tenantId: string | undefined,
  entries: readonly ManagedRegistrationIntent[],
  discovery: FilterQuery<ChannelIdentityRecord>,
  batchSize: number,
): Promise<void> {
  const model = createChannelIdentityModel(mongoose);
  for (const entry of entries) {
    if (entry.target.kind !== 'channelIdentity') continue;
    if ((entry.target.tenantId || undefined) !== (tenantId || undefined))
      throw new Error('Identity cleanup target tenant changed');
    await retireChannelIdentity(mongoose, { ...entry.target, kind: 'channelIdentity' });
  }
  let after: Types.ObjectId | undefined;
  for (;;) {
    const page = await includeManagedAllocations(
      model.find({
        ...discovery,
        tenantId: tenantId || '_',
        ...(after && { _id: { $gt: after } }),
      }),
    )
      .select('_id _managed')
      .sort({ _id: 1 })
      .limit(batchSize)
      .read('primary')
      .lean<IdentityMetadata[]>();
    if (!page.length) break;
    for (const record of page) {
      if (!record._managed) throw new Error('Identity cleanup requires managed ownership');
      await retireChannelIdentity(mongoose, {
        kind: 'channelIdentity',
        id: String(record._id),
        incarnation: record._managed.incarnation,
        ...(tenantId && { tenantId }),
      });
    }
    after = page[page.length - 1]._id;
  }
}

/** The closed owner registry covers a first association paused before userId publication. */
export async function eraseChannelIdentitiesForOwner(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  batchSize: number,
): Promise<void> {
  assertManagedCleanupTenant(owner.tenantId);
  const key = responseScopeKeys(owner, '')[0];
  const anchor = await createResponseScopeModel(mongoose).findById(key).read('primary').lean();
  if (!anchor?.closed) throw new Error('Identity erasure requires closed owner admission');
  managedRegistryCount(anchor);
  const entries = (anchor.pending ?? []).filter((entry) => entry.target.kind === 'channelIdentity');
  await eraseIdentityTargets(
    mongoose,
    owner.tenantId,
    entries,
    {
      $or: [{ userId: owner.userId }, { '_managed.scopeKeys': key }],
    },
    batchSize,
  );
  for (const entry of entries) await settleRedactedIdentityTarget(mongoose, owner, entry);
  await reconcileErasedResponseTargets(mongoose, owner, []);
}

/** Canonical closure precedes bounded pending/indexed discovery; hidden is never absent. */
export async function eraseChannelIdentitiesForChannel(
  mongoose: typeof import('mongoose'),
  target: ManagedTarget<'channel'>,
  channelId: string,
  batchSize: number,
): Promise<void> {
  assertManagedCleanupTenant(target.tenantId);
  const channel = await includeManagedAllocations(
    createAgentChannelModel(mongoose).findOne({
      ...managedTargetPredicate(mongoose, target),
      status: 'deleting',
    }),
  )
    .select('pending pendingCount')
    .read('primary')
    .lean<ManagedRegistryState | null>();
  if (!channel) throw new Error('Identity erasure requires closed channel authority');
  managedRegistryCount(channel);
  const key = channelRegistryKey({ target, revision: '' }, false);
  await eraseIdentityTargets(
    mongoose,
    target.tenantId,
    channel.pending ?? [],
    {
      $or: [{ 'identity.channelId': channelId }, { '_managed.scopeKeys': key }],
    },
    batchSize,
  );
}
