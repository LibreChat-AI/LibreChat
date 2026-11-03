import { durableStorageConfigSchema } from 'librechat-data-provider';
import type { DurableStorageConfig } from 'librechat-data-provider';
import type { Types } from 'mongoose';
import type { ChannelIdentityRecord } from '~/models/channelIdentity';
import type { ManagedState, ManagedTarget } from '~/types/managed';
import {
  channelOwnershipFields,
  registerChannelOwnership,
  settleChannelOwnership,
  reconcileAbsentChannelOwnership,
} from './channelOwnership';
import {
  allocateManagedTarget,
  managedTargetFilter,
  managedRegistration,
  retireManagedAllocation,
} from './managed';
import { createChannelIdentityModel } from '~/models/channelIdentity';
import { retireChannelIdentity } from './channelIdentityErasure';
import { readChannelAuthority } from './channelRegistry';
import { assertChannelBudget } from './channelBudget';
import { responseScopeKeys } from './responseScope';

interface CurrentIdentity extends ChannelIdentityRecord {
  _id: Types.ObjectId;
  _managed: ManagedState;
}

/** Root ownership may acquire its first account once; relinking always allocates a new authority. */
export async function writeChannelIdentity(
  mongoose: typeof import('mongoose'),
  input: ChannelIdentityRecord,
  expectedRevision: string | null,
  options: Partial<DurableStorageConfig>,
): Promise<boolean> {
  const limits = durableStorageConfigSchema.parse(options);
  const record: ChannelIdentityRecord = {
    tenantId: input.tenantId,
    linkId: input.linkId,
    revision: input.revision,
    state: input.state,
    identity: {
      tenantId: input.identity.tenantId,
      channelId: input.identity.channelId,
      channelRevision: input.identity.channelRevision,
      teamId: input.identity.teamId,
      externalUserId: input.identity.externalUserId,
      agentId: input.identity.agentId,
    },
    ticketHash: input.ticketHash,
    ticketExpiresAtMs: input.ticketExpiresAtMs,
    expiresAtMs: input.expiresAtMs,
    ...(input.userId && { userId: input.userId }),
    ...(input.accountLabel != null && { accountLabel: input.accountLabel }),
  };
  const model = createChannelIdentityModel(mongoose);
  const candidate = new model(record);
  await candidate.validate();
  if (expectedRevision !== null && record.revision === expectedRevision)
    throw new TypeError('Channel identity revision must advance');
  // Reserve the maximal fixed descriptor/counter shape before any allocation or owner selection.
  const now = new Date();
  const budget = {
    ...candidate.toObject({ transform: false }),
    createdAt: now,
    updatedAt: now,
    _managed: {
      incarnation: '0'.repeat(36),
      phase: 'published',
      parentId: '0'.repeat(24),
      receipt: '0'.repeat(64),
      ownerKey: '0'.repeat(64),
      scopeKeys: Array(4).fill('0'.repeat(64)),
    },
  };
  assertChannelBudget(mongoose, 'channelIdentity', budget, record);
  const channel = await readChannelAuthority(mongoose, record.identity);
  if (!channel) return false;
  const tenantId = channel.target.tenantId;
  const roles = {
    creator: { userId: channel.createdBy, ...(tenantId && { tenantId }) },
    channel,
    ...(record.userId && { owner: { userId: record.userId, ...(tenantId && { tenantId }) } }),
  };
  let current: CurrentIdentity | null = null;
  if (expectedRevision !== null) {
    current = await model
      .findOne({
        tenantId: record.tenantId,
        revision: expectedRevision,
        'identity.channelId': record.identity.channelId,
        'identity.teamId': record.identity.teamId,
        'identity.externalUserId': record.identity.externalUserId,
        'identity.agentId': record.identity.agentId,
      })
      .select('+_managed +ticketHash +pending +pendingCount +retentionEpoch')
      .read('primary')
      .lean<CurrentIdentity | null>();
    if (!current || !current._managed) return false;
    if (current.linkId !== record.linkId) {
      // No private owner transfer. Closure and a fresh physical target release the unique identity slot.
      if (
        !(await retireChannelIdentity(
          mongoose,
          {
            kind: 'channelIdentity',
            id: String(current._id),
            incarnation: current._managed.incarnation,
            ...(tenantId && { tenantId }),
          },
          expectedRevision,
        ))
      )
        return false;
      current = null;
    } else if (
      current.state === 'revoked' ||
      current.identity.channelRevision !== record.identity.channelRevision ||
      (current.userId && current.userId !== record.userId) ||
      (current._managed.ownerKey &&
        (!roles.owner || current._managed.ownerKey !== responseScopeKeys(roles.owner, '')[0]))
    )
      return false;
  }
  const initial = !current;
  if (current) assertChannelBudget(mongoose, 'channelIdentity', current, record);
  const target: ManagedTarget<'channelIdentity'> = current
    ? {
        kind: 'channelIdentity',
        id: String(current._id),
        incarnation: current._managed.incarnation,
        ...(tenantId && { tenantId }),
      }
    : await allocateManagedTarget(mongoose, 'channelIdentity', tenantId);
  const physical = managedTargetFilter(mongoose, target);
  const metadata = {
    ...channelOwnershipFields(mongoose, target, roles),
    '_managed.parentId': target.id,
    '_managed.receipt': managedRegistration(target).key,
    ...(roles.owner && { '_managed.ownerKey': responseScopeKeys(roles.owner, '')[0] }),
  };
  try {
    if (initial) {
      const described = await model.updateOne(
        { ...physical, '_managed.phase': 'empty' },
        {
          $set: { ...metadata, '_managed.phase': 'registering' },
        },
        { upsert: false, timestamps: false },
      );
      if (!described.matchedCount) return false;
    } else if (roles.owner && !current!.userId) {
      // Select one immutable owner before any competing account can register this same root.
      const ownerKey = responseScopeKeys(roles.owner, '')[0];
      const selected = await model.updateOne(
        {
          ...physical,
          revision: expectedRevision,
          '_managed.phase': 'published',
          userId: { $exists: false },
          $or: [{ '_managed.ownerKey': { $exists: false } }, { '_managed.ownerKey': ownerKey }],
        },
        { $set: metadata },
        { upsert: false },
      );
      if (!selected.matchedCount) return false;
    }
    const admitted = await registerChannelOwnership(mongoose, target, roles, {
      maxPendingTargetsPerScope: limits.maxPendingTargetsPerScope,
    });
    if (admitted.status !== 'registered') return false;
    const result = await model.updateOne(
      {
        ...physical,
        '_managed.phase': initial ? 'registering' : 'published',
        ...(initial ? metadata : { revision: expectedRevision }),
        ...(roles.owner && { '_managed.ownerKey': responseScopeKeys(roles.owner, '')[0] }),
      },
      {
        $set: {
          ...record,
          ...metadata,
          '_managed.phase': 'published',
          ...(initial && { createdAt: now, __v: 0 }),
        },
        ...(!record.accountLabel && record.accountLabel !== '' && { $unset: { accountLabel: 1 } }),
        ...(admitted.expiredAt && { $min: { '_managed.expiredAt': admitted.expiredAt } }),
      },
      { upsert: false, runValidators: true },
    );
    if (!result.matchedCount) return false;
    await settleChannelOwnership(mongoose, target, roles);
    return true;
  } catch (error) {
    if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) return false;
    throw error;
  } finally {
    if (initial) {
      // Only unpublished metadata may be discarded, including after a lost applied write reply.
      await retireManagedAllocation(mongoose, target, target.id);
      await reconcileAbsentChannelOwnership(mongoose, target, roles);
    }
  }
}
