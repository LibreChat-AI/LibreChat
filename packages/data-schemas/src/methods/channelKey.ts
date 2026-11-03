import { durableStorageConfigSchema } from 'librechat-data-provider';
import type { DurableStorageConfig } from 'librechat-data-provider';
import type { AgentApiKeyBinding, AgentApiKeyCreateData } from '~/types/agentApiKey';
import type { ManagedRegistration, ManagedState } from '~/types/managed';
import type { ChannelRunRecord } from '~/models/channelRun';
import type { PhysicalChannelRun } from './channelRunWrite';
import type { ChannelOwnership } from './channelRegistry';
import type { IAgentApiKey } from '~/schema/agentApiKey';
import type { ResponseOwner } from '~/models/response';
import {
  capturedChannelRunOwnership,
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
import {
  MAX_BSON_DOCUMENT_BYTES,
  BSON_WRITE_HEADROOM_BYTES,
  ManagedDocumentTooLargeError,
} from '~/utils/bson';
import { settleAbsentResponseTarget, settleRetainedChannelOwnerTarget } from './registration';
import { assertResponseErasureOwner, responseScopeKeys } from './responseScope';
import { CHANNEL_RUN_METADATA_FIELDS } from './channelRunWrite';
import { createAgentApiKeyModel } from '~/models/agentApiKey';
import { createChannelRunModel } from '~/models/channelRun';
import { channelRunStorageTarget } from './channelRunWrite';
import { includeManagedAllocations } from '~/utils/managed';
import { managedTargetPredicate } from './managed';

/** A source key belongs to one physical Run, including across same-ID replacement. */
export function channelRunKeyBinding(run: ChannelRunRecord): AgentApiKeyBinding {
  const target = channelRunStorageTarget(run);
  return {
    kind: 'channel_run',
    id: `${run.channelId}/${run.runId}`,
    targetId: target.id,
    incarnation: target.incarnation,
  };
}

type KeyInput = Omit<AgentApiKeyCreateData, 'binding' | 'expiresAt'> & {
  binding: AgentApiKeyBinding;
  expiresAt?: Date;
  tenantId?: string;
  keyHash: string;
  keyPrefix: string;
};

/** Acknowledged allocation, fixed-role registration and one private publication; no insert replay. */
export async function createManagedChannelKey(
  mongoose: typeof import('mongoose'),
  input: KeyInput,
  config: Partial<DurableStorageConfig> = {},
): Promise<IAgentApiKey> {
  const model = createAgentApiKeyModel(mongoose);
  const limits = durableStorageConfigSchema.parse(config);
  const owner = {
    userId: String(input.userId),
    ...(input.tenantId && { tenantId: input.tenantId }),
  };
  let roles: ChannelOwnership = {
    creator: owner,
  };
  if (input.binding.kind === 'channel_run') {
    const [channelId, runId, extra] = input.binding.id.split('/');
    const { targetId: id, incarnation } = input.binding;
    if (!channelId || !runId || !id || !incarnation || extra != null)
      throw new TypeError('Invalid bound-key Run identity');
    const run = await createChannelRunModel(mongoose)
      .findOne({
        ...managedTargetFilter(mongoose, {
          kind: 'channelRun',
          id,
          incarnation,
          ...(input.tenantId && { tenantId: input.tenantId }),
        }),
        channelId,
        runId,
        'principal.userId': owner.userId,
        '_managed.phase': 'published',
      })
      .select(`${CHANNEL_RUN_METADATA_FIELDS} execution.conversationId`)
      .read('primary')
      .lean<PhysicalChannelRun | null>();
    if (!run || !run.execution?.conversationId) throw new Error('Bound-key Run unavailable');
    roles = { ...capturedChannelRunOwnership(run), conversationId: run.execution.conversationId };
  }
  const candidate = new model(input);
  await candidate.validate();
  if (
    mongoose.mongo.BSON.calculateObjectSize(
      candidate.toObject({ transform: false, minimize: false }),
    ) +
      BSON_WRITE_HEADROOM_BYTES >
    MAX_BSON_DOCUMENT_BYTES
  )
    throw new ManagedDocumentTooLargeError();
  const target = await allocateManagedTarget(mongoose, 'channelKey', input.tenantId);
  const physical = managedTargetFilter(mongoose, target);
  const metadata = {
    ...channelOwnershipFields(mongoose, target, roles),
    '_managed.parentId': target.id,
    '_managed.receipt': managedRegistration(target).key,
  };
  try {
    const described = await model.updateOne(
      { ...physical, '_managed.phase': 'empty' },
      { $set: { ...metadata, '_managed.phase': 'registering' } },
      { upsert: false, timestamps: false },
    );
    if (!described.matchedCount) throw new Error('Bound-key storage target unavailable');
    const admitted = await registerChannelOwnership(mongoose, target, roles, limits);
    if (admitted.status !== 'registered') throw new Error('Bound-key owner unavailable');
    const created = await includeManagedAllocations(
      model.findOneAndUpdate(
        { ...physical, ...metadata, '_managed.phase': 'registering' },
        {
          $set: { ...input, ...metadata, '_managed.phase': 'published', __v: 0 },
          ...(admitted.expiredAt && { $min: { '_managed.expiredAt': admitted.expiredAt } }),
        },
        // This single registering-to-published CAS installs immutable ownership for the first time.
        { new: true, upsert: false, runValidators: true, overwriteImmutable: true },
      ),
    );
    if (!created) throw new Error('Bound-key storage target unavailable');
    await settleChannelOwnership(mongoose, target, roles);
    return created;
  } catch (error) {
    await retireManagedAllocation(mongoose, target, target.id);
    await reconcileAbsentChannelOwnership(mongoose, target, roles);
    throw error;
  }
}

/** Fence frozen publishers first; ordinary owner deletion then cannot miss a late private write. */
export async function eraseChannelKeysForOwner(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  entries: readonly ManagedRegistration[],
): Promise<void> {
  assertResponseErasureOwner(owner);
  const model = createAgentApiKeyModel(mongoose);
  const ownerKey = responseScopeKeys(owner, '')[0];
  for (const entry of entries) {
    if (entry.target.kind !== 'channelKey') continue;
    if ((entry.target.tenantId || undefined) !== (owner.tenantId || undefined))
      throw new TypeError('Bound-key cleanup partition changed');
    const exact = managedTargetPredicate(mongoose, entry.target);
    if (!(await retireManagedAllocation(mongoose, entry.target, entry.target.id))) {
      const current = await includeManagedAllocations(model.findOne(exact))
        .select('userId +_managed')
        .read('primary')
        .lean<{ userId?: string; _managed?: ManagedState } | null>();
      if (
        current?._managed?.phase === 'published' &&
        current._managed.scopeKeys?.includes(ownerKey)
      ) {
        if (String(current.userId) === owner.userId)
          await model.deleteOne({ ...exact, userId: owner.userId, '_managed.phase': 'published' });
        else await settleRetainedChannelOwnerTarget(mongoose, owner, entry);
      }
    }
    await settleAbsentResponseTarget(mongoose, owner, undefined, entry);
  }
  await model.deleteMany({ userId: owner.userId, tenantId: owner.tenantId || { $in: [null, ''] } });
}
