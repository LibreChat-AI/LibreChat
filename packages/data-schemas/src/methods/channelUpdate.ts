import { randomUUID } from 'node:crypto';
import type { Types } from 'mongoose';
import type { AgentChannelRecord } from '~/models/channel';
import type { ManagedState } from '~/types/managed';
import { createAgentChannelModel, CHANNEL_PRIVATE_FIELDS } from '~/models/channel';
import { managedTargetFilter, managedRegistration } from './managed';
import { createResponseScopeModel } from '~/models/responseScope';
import { assertChannelBudget } from './channelBudget';
import { responseScopeKeys } from './responseScope';

type ChannelPatch = Partial<
  Omit<AgentChannelRecord, 'channelId' | 'tenantId' | 'agentId' | 'createdBy'>
>;
type ChannelSnapshot = AgentChannelRecord & {
  _id: Types.ObjectId;
  _managed: ManagedState;
  __v: number;
};

/** An indexed published root needs no new admission slot; irreversible retirement fences late edits. */
export async function updateManagedAgentChannel(
  mongoose: typeof import('mongoose'),
  channelId: string,
  createdBy: string,
  update: ChannelPatch,
  expectedStatus?: AgentChannelRecord['status'],
  expectedRevision?: string,
): Promise<AgentChannelRecord | null> {
  if (expectedStatus === 'deleting' || update.status === 'deleting') return null;
  const fields: ChannelPatch = {
    ...(update.type !== undefined && { type: update.type }),
    ...(update.status !== undefined && { status: update.status }),
    ...(update.credentialMode !== undefined && { credentialMode: update.credentialMode }),
    ...(update.revision !== undefined && { revision: update.revision }),
    ...(update.slack !== undefined && {
      slack: {
        teamId: update.slack?.teamId,
        appId: update.slack?.appId,
        botUserId: update.slack?.botUserId,
      },
    }),
    ...(update.encryptedBotToken !== undefined && { encryptedBotToken: update.encryptedBotToken }),
    ...(update.encryptedSigningSecret !== undefined && {
      encryptedSigningSecret: update.encryptedSigningSecret,
    }),
  };
  if (!Object.keys(fields).length) return null;
  const model = createAgentChannelModel(mongoose);
  const secrets = CHANNEL_PRIVATE_FIELDS.map((field) => `+${field}`).join(' ');
  const projection = `${secrets} +_managed +pending +pendingCount +retentionEpoch`;
  let current = await model
    .findOne({ channelId, createdBy, '_managed.phase': 'published' })
    .select(projection)
    .read('primary')
    .lean<ChannelSnapshot | null>();
  if (!current?._managed) return null;
  const tenantId = current.tenantId || undefined;
  const target = {
    kind: 'channel' as const,
    id: String(current._id),
    incarnation: current._managed.incarnation,
    ...(tenantId && { tenantId }),
  };
  const physical = managedTargetFilter(mongoose, target);
  const ownerKey = responseScopeKeys({ userId: createdBy, tenantId }, '')[0];
  const revision = fields.revision ?? randomUUID();
  // Only a failed comparison is retried. An ambiguous applied command always escapes to its caller.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (
      !current ||
      current.status === 'deleting' ||
      (expectedStatus !== undefined && current.status !== expectedStatus) ||
      (expectedRevision !== undefined && current.revision !== expectedRevision) ||
      current.revision === revision
    )
      return null;
    if (
      !Number.isSafeInteger(current.__v) ||
      current.__v < 0 ||
      current.__v >= Number.MAX_SAFE_INTEGER
    )
      throw new Error('Channel write version unavailable');
    if (
      current._managed.parentId !== target.id ||
      current._managed.receipt !== managedRegistration(target).key ||
      !current._managed.scopeKeys?.includes(ownerKey)
    )
      return null;
    const owner = await createResponseScopeModel(mongoose)
      .findOne({
        _id: ownerKey,
        closed: false,
        $or: [{ expiredAt: null }, { expiredAt: { $gt: new Date() } }],
      })
      .select('expiredAt')
      .read('primary')
      .lean();
    if (!owner) return null;
    const patch = { ...fields, revision };
    const candidate = new model({ ...current, ...patch });
    await candidate.validate();
    assertChannelBudget(mongoose, 'channel', current, patch);
    const updated = await model
      .findOneAndUpdate(
        {
          ...physical,
          channelId,
          createdBy,
          '_managed.phase': 'published',
          '_managed.scopeKeys': ownerKey,
          status: current.status,
          revision: current.revision,
          __v: current.__v,
        },
        {
          $set: patch,
          $inc: { __v: 1 },
          ...(owner.expiredAt && { $min: { '_managed.expiredAt': owner.expiredAt } }),
        },
        { upsert: false, new: true, runValidators: true },
      )
      .select(secrets)
      .lean();
    if (updated) return updated;
    current = await model
      .findOne({ ...physical, channelId, createdBy, '_managed.phase': 'published' })
      .select(projection)
      .read('primary')
      .lean<ChannelSnapshot | null>();
  }
  return null;
}
