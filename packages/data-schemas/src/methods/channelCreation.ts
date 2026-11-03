import { durableStorageConfigSchema } from 'librechat-data-provider';
import type { DurableStorageConfig } from 'librechat-data-provider';
import type { AgentChannelRecord } from '~/models/channel';
import {
  registerChannelOwnership,
  settleChannelOwnership,
  reconcileAbsentChannelOwnership,
  channelOwnershipFields,
} from './channelOwnership';
import {
  allocateManagedTarget,
  managedTargetFilter,
  managedRegistration,
  retireManagedAllocation,
} from './managed';
import { createAgentChannelModel, CHANNEL_PRIVATE_FIELDS } from '~/models/channel';
import { initializeChannelScope, touchChannelScope } from './channelScope';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { includeManagedAllocations } from '~/utils/managed';
import { assertChannelBudget } from './channelBudget';

/** One private publication into an acknowledged root; no transaction or payload-bearing insert. */
export async function createManagedAgentChannel(
  mongoose: typeof import('mongoose'),
  input: AgentChannelRecord,
  options: Partial<DurableStorageConfig>,
): Promise<AgentChannelRecord> {
  const limits = durableStorageConfigSchema.parse(options);
  const currentTenant = getTenantId();
  const record: AgentChannelRecord = {
    channelId: input.channelId,
    tenantId: input.tenantId ?? (currentTenant === SYSTEM_TENANT_ID ? undefined : currentTenant),
    agentId: input.agentId,
    createdBy: input.createdBy,
    type: input.type,
    status: input.status,
    credentialMode: input.credentialMode,
    revision: input.revision,
    ...(input.slack && {
      slack: {
        teamId: input.slack.teamId,
        appId: input.slack.appId,
        botUserId: input.slack.botUserId,
      },
    }),
    ...(input.encryptedBotToken !== undefined && { encryptedBotToken: input.encryptedBotToken }),
    ...(input.encryptedSigningSecret !== undefined && {
      encryptedSigningSecret: input.encryptedSigningSecret,
    }),
  };
  if (record.status === 'deleting') throw new TypeError('Channel deletion requires retirement');
  const model = createAgentChannelModel(mongoose);
  const now = new Date();
  const candidate = new model(record);
  candidate.set('createdAt', now);
  candidate.set('updatedAt', now);
  candidate.set('__v', 0);
  candidate.set('_managed', {
    incarnation: '0'.repeat(36),
    phase: 'published',
    parentId: '0'.repeat(24),
    receipt: '0'.repeat(64),
    scopeKeys: ['0'.repeat(64)],
  });
  candidate.set('pendingCount', Number.MAX_SAFE_INTEGER);
  candidate.set('retentionEpoch', Number.MAX_SAFE_INTEGER);
  await candidate.validate();
  assertChannelBudget(mongoose, candidate.toObject({ transform: false, minimize: false }));
  await initializeChannelScope(mongoose, record.tenantId, record.channelId);
  if (!(await touchChannelScope(mongoose, record.tenantId, record.channelId)))
    throw new Error('Channel admission closed');
  const target = await allocateManagedTarget(mongoose, 'channel', record.tenantId);
  const roles = {
    creator: { userId: record.createdBy, ...(record.tenantId && { tenantId: record.tenantId }) },
  };
  const physical = managedTargetFilter(mongoose, target);
  const metadata = {
    ...channelOwnershipFields(mongoose, target, roles),
    '_managed.parentId': target.id,
    '_managed.receipt': managedRegistration(target).key,
  };
  try {
    const described = await model.updateOne(
      { ...physical, '_managed.phase': 'empty' },
      {
        $set: { ...metadata, '_managed.phase': 'registering' },
      },
      { upsert: false, timestamps: false },
    );
    if (!described.matchedCount) throw new Error('Channel storage target unavailable');
    const admitted = await registerChannelOwnership(mongoose, target, roles, {
      maxPendingTargetsPerScope: limits.maxPendingTargetsPerScope,
    });
    if (admitted.status !== 'registered')
      throw new Error(
        admitted.status === 'closed'
          ? 'Channel owner unavailable'
          : 'Channel admission unavailable',
      );
    const created = await includeManagedAllocations(
      model.findOneAndUpdate(
        {
          ...physical,
          ...metadata,
          '_managed.phase': 'registering',
        },
        {
          $set: { ...record, ...metadata, createdAt: now, __v: 0, '_managed.phase': 'published' },
          ...(admitted.expiredAt && { $min: { '_managed.expiredAt': admitted.expiredAt } }),
        },
        { new: true, upsert: false, runValidators: true },
      ),
    )
      .select(CHANNEL_PRIVATE_FIELDS.map((field) => `+${field}`).join(' '))
      .lean();
    if (!created) throw new Error('Channel storage target unavailable');
    await settleChannelOwnership(mongoose, target, roles);
    return created;
  } catch (error) {
    // The exact placeholder CAS cannot discard a winner whose private publication applied.
    await retireManagedAllocation(mongoose, target, target.id);
    await reconcileAbsentChannelOwnership(mongoose, target, roles);
    throw error;
  }
}
