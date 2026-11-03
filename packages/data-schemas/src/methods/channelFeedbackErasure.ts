import type { Types } from 'mongoose';
import type { Model } from 'mongoose';
import type {
  ChannelReplyRecord,
  ChannelFeedbackEventRecord,
  ChannelFeedbackLedger,
} from '~/models/channelFeedback';
import type { ManagedTarget, ManagedState, ManagedRegistrationIntent } from '~/types/managed';
import type { ManagedRegistryState } from '~/types/managed';
import type { ResponseOwner } from '~/models/response';
import {
  createChannelReplyModel,
  createChannelFeedbackEventModel,
  createChannelFeedbackModel,
} from '~/models/channelFeedback';
import {
  managedTargetPredicate,
  retireManagedAllocation,
  assertManagedCleanupTenant,
} from './managed';
import { channelRegistryKey, reconcileClosedChannelTarget } from './channelRegistry';
import { responseScopeKeys, assertResponseErasureOwner } from './responseScope';
import { createResponseScopeModel } from '~/models/responseScope';
import { reconcileErasedResponseTargets } from './registration';
import { includeManagedAllocations } from '~/utils/managed';
import { createAgentChannelModel } from '~/models/channel';
import { managedRegistryCount } from './registry';

const kinds = ['channelReply', 'channelFeedbackEvent', 'channelFeedback'] as const;
type FeedbackRecord = ChannelReplyRecord | ChannelFeedbackEventRecord | ChannelFeedbackLedger;
function models(
  mongoose: typeof import('mongoose'),
): Record<(typeof kinds)[number], Model<FeedbackRecord>> {
  createChannelReplyModel(mongoose);
  createChannelFeedbackEventModel(mongoose);
  createChannelFeedbackModel(mongoose);
  return {
    channelReply: mongoose.model<FeedbackRecord>('ChannelReply'),
    channelFeedbackEvent: mongoose.model<FeedbackRecord>('ChannelFeedbackEvent'),
    channelFeedback: mongoose.model<FeedbackRecord>('ChannelFeedback'),
  };
}
interface Metadata {
  _id: Types.ObjectId;
  _managed: ManagedState;
}

/** All private feedback is database-owned; no provider drain or external delivery is inferred here. */
async function eraseTargets(
  mongoose: typeof import('mongoose'),
  tenantId: string | undefined,
  entries: readonly ManagedRegistrationIntent[],
  keys: readonly string[],
): Promise<void> {
  assertManagedCleanupTenant(tenantId);
  const domain = models(mongoose);
  async function erase(target: ManagedRegistrationIntent['target']) {
    if (!kinds.some((kind) => kind === target.kind)) return;
    if ((target.tenantId || undefined) !== (tenantId || undefined))
      throw new TypeError('Feedback cleanup target partition changed');
    if (await retireManagedAllocation(mongoose, target, target.id)) return;
    const kind = kinds.find((value) => value === target.kind)!;
    await domain[kind].deleteOne({
      ...managedTargetPredicate(mongoose, target),
      '_managed.phase': 'published',
      '_managed.scopeKeys': { $in: [...keys] },
    });
  }
  // Closure freezes these entries, covering private publication behind the indexed scan.
  for (const entry of entries) await erase(entry.target);
  for (const kind of kinds) {
    const cursor = includeManagedAllocations(
      domain[kind].find({ tenantId: tenantId || '_', '_managed.scopeKeys': { $in: [...keys] } }),
    )
      .select('_id _managed')
      .sort({ _id: 1 })
      .read('primary')
      .lean<Metadata[]>()
      .cursor({ batchSize: 100 });
    for await (const record of cursor) {
      if (!record._managed?.incarnation) throw new Error('Feedback cleanup ownership unavailable');
      await erase({
        kind,
        id: String(record._id),
        incarnation: record._managed.incarnation,
        ...(tenantId && { tenantId }),
      });
    }
  }
}

/** Owner or conversation closure precedes both frozen registration and indexed payload cleanup. */
export async function eraseChannelFeedbackForOwner(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  conversationIds?: readonly string[],
): Promise<void> {
  assertResponseErasureOwner(owner);
  const ownerKey = responseScopeKeys(owner, '')[0];
  const ownerAnchor = await createResponseScopeModel(mongoose)
    .findById(ownerKey)
    .read('primary')
    .lean();
  const ownerClosed =
    ownerAnchor?.closed || (ownerAnchor?.expiredAt && ownerAnchor.expiredAt <= new Date());
  const keys =
    !conversationIds || ownerClosed
      ? [ownerKey]
      : conversationIds.map((id) => responseScopeKeys(owner, id)[1]);
  const anchors = await createResponseScopeModel(mongoose)
    .find({ _id: { $in: keys } })
    .read('primary')
    .lean();
  if (
    anchors.length !== new Set(keys).size ||
    anchors.some(
      (anchor) => !anchor.closed && !(anchor.expiredAt && anchor.expiredAt <= new Date()),
    )
  )
    throw new Error('Feedback erasure requires closed admission');
  for (const anchor of anchors) managedRegistryCount(anchor);
  await eraseTargets(
    mongoose,
    owner.tenantId,
    anchors.flatMap((anchor) => anchor.pending ?? []),
    keys,
  );
  await reconcileErasedResponseTargets(
    mongoose,
    owner,
    keys.filter((key) => key !== ownerKey),
  );
}

export async function eraseChannelFeedbackForChannel(
  mongoose: typeof import('mongoose'),
  target: ManagedTarget<'channel'>,
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
  if (!channel) throw new Error('Feedback erasure requires closed canonical channel');
  managedRegistryCount(channel);
  await eraseTargets(mongoose, target.tenantId, channel.pending ?? [], [
    channelRegistryKey({ target, revision: '' }, false),
  ]);
  await reconcileClosedChannelTarget(mongoose, target);
}
