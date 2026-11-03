import { durableStorageConfigSchema } from 'librechat-data-provider';
import type { DurableStorageConfig } from 'librechat-data-provider';
import type { ChannelReplyMapping } from 'librechat-data-provider';
import type { Model, FilterQuery } from 'mongoose';
import type {
  ChannelReplyRecord,
  ChannelFeedbackLedger,
  ChannelFeedbackEventRecord,
} from '~/models/channelFeedback';
import type { ChannelFeedbackAuthority } from './channelFeedbackScope';
import type { ManagedTarget } from '~/types/managed';
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
import {
  MAX_BSON_DOCUMENT_BYTES,
  BSON_WRITE_HEADROOM_BYTES,
  ManagedDocumentTooLargeError,
} from '~/utils/bson';
import {
  readChannelFeedbackAuthority,
  ChannelFeedbackAuthorityError,
} from './channelFeedbackScope';
import { includeManagedAllocations } from '~/utils/managed';

export type FeedbackKind = 'channelReply' | 'channelFeedback' | 'channelFeedbackEvent';
export type FeedbackRecord =
  | ChannelReplyRecord
  | ChannelFeedbackLedger
  | ChannelFeedbackEventRecord;
const models = {
  channelReply: 'ChannelReply',
  channelFeedback: 'ChannelFeedback',
  channelFeedbackEvent: 'ChannelFeedbackEvent',
} as const;
export const feedbackModel = (
  mongoose: typeof import('mongoose'),
  kind: FeedbackKind,
): Model<FeedbackRecord> => mongoose.model<FeedbackRecord>(models[kind]);
export const feedbackMapping = (record: FeedbackRecord): ChannelReplyMapping =>
  'mapping' in record ? record.mapping : record;

export type FeedbackRootIdentity = Pick<FeedbackRecord, 'tenantId' | 'source' | '_managed'>;

export function feedbackTarget<K extends FeedbackKind>(
  record: FeedbackRootIdentity,
  kind: K,
): ManagedTarget<K> {
  if (record._managed?.phase !== 'published' || !record._managed.parentId || !record.source)
    throw new ChannelFeedbackAuthorityError();
  return {
    kind,
    id: record._managed.parentId,
    incarnation: record._managed.incarnation,
    ...(record.tenantId !== '_' && { tenantId: record.tenantId }),
  };
}
export function feedbackFilter(
  mongoose: typeof import('mongoose'),
  record: FeedbackRootIdentity,
  kind: FeedbackKind,
): FilterQuery<FeedbackRecord> {
  return {
    ...managedTargetFilter(mongoose, feedbackTarget(record, kind)),
    '_managed.phase': 'published',
    $and: [{ $or: [{ expiredAt: null }, { expiredAt: { $gt: new Date() } }] }],
  };
}
export function feedbackIdentity(
  record: FeedbackRecord,
  kind: FeedbackKind,
): Record<string, string> {
  const mapping = feedbackMapping(record);
  if (kind === 'channelFeedbackEvent' && 'eventId' in record)
    return { tenantId: record.tenantId, channelId: record.channelId, eventId: record.eventId };
  if (kind === 'channelFeedback' && 'key' in record)
    return { tenantId: record.tenantId, key: record.key };
  if (kind === 'channelReply' && !('mapping' in record))
    return {
      tenantId: mapping.tenantId,
      channelId: mapping.channelId,
      teamId: mapping.teamId,
      externalMessageKey: mapping.externalMessageKey,
    };
  throw new TypeError('Invalid feedback record kind');
}
function budget(mongoose: typeof import('mongoose'), record: object): void {
  if (
    mongoose.mongo.BSON.calculateObjectSize(record) + BSON_WRITE_HEADROOM_BYTES >
    MAX_BSON_DOCUMENT_BYTES
  )
    throw new ManagedDocumentTooLargeError();
}

/** One-shot allocation and one initial private publication; no payload-bearing insert/upsert. */
export async function createFeedbackRecord<T extends FeedbackRecord>(
  mongoose: typeof import('mongoose'),
  kind: FeedbackKind,
  record: T,
  authority: ChannelFeedbackAuthority,
  config: Partial<DurableStorageConfig>,
): Promise<T> {
  const limits = durableStorageConfigSchema.parse(config);
  if (
    record.expiredAt &&
    (!(record.expiredAt instanceof Date) ||
      !Number.isFinite(record.expiredAt.getTime()) ||
      record.expiredAt <= new Date())
  )
    throw new ChannelFeedbackAuthorityError();
  const model = feedbackModel(mongoose, kind);
  const identity = feedbackIdentity(record, kind);
  async function winner() {
    const stored = await model
      .findOne({ ...identity, '_managed.phase': 'published' })
      .select('+_managed')
      .read('primary')
      .lean<T | null>();
    if (!stored) return null;
    if (!stored.source || (stored.expiredAt && stored.expiredAt <= new Date()))
      throw new ChannelFeedbackAuthorityError();
    await readChannelFeedbackAuthority(mongoose, feedbackMapping(stored), stored.source);
    return stored;
  }
  const existing = await winner();
  if (existing) return existing;
  if (
    kind === 'channelFeedback' &&
    'votes' in record &&
    (record.revision !== 0 || record.votes.length !== 0 || record.rating !== null)
  )
    throw new TypeError('Invalid initial feedback checkpoint');
  const owner = authority.roles.owner!;
  const target = await allocateManagedTarget(mongoose, kind, owner.tenantId);
  const physical = managedTargetFilter(mongoose, target);
  const metadata = {
    ...channelOwnershipFields(mongoose, target, authority.roles),
    '_managed.parentId': target.id,
    '_managed.receipt': managedRegistration(target).key,
  };
  const deadlines = [record.expiredAt, authority.state.expiredAt].filter(
    (date): date is Date => date instanceof Date,
  );
  try {
    const described = await model.updateOne(
      { ...physical, '_managed.phase': 'empty' },
      { $set: { ...metadata, '_managed.phase': 'registering' } },
      { upsert: false, timestamps: false },
    );
    if (!described.matchedCount) throw new ChannelFeedbackAuthorityError();
    const admitted = await registerChannelOwnership(mongoose, target, authority.roles, limits);
    if (admitted.status !== 'registered') throw new ChannelFeedbackAuthorityError();
    if (admitted.expiredAt) deadlines.push(admitted.expiredAt);
    const value = {
      ...record,
      source: authority.source,
      __v: 0,
      ...(deadlines.length && {
        expiredAt: new Date(Math.min(...deadlines.map((date) => date.getTime()))),
      }),
    };
    Reflect.deleteProperty(value, '_managed');
    Reflect.deleteProperty(value, '_id');
    const candidate = new model({
      ...value,
      _id: new mongoose.Types.ObjectId(target.id),
      _managed: {
        incarnation: target.incarnation,
        phase: 'published',
        parentId: target.id,
        scopeKeys: metadata['_managed.scopeKeys'],
        receipt: metadata['_managed.receipt'],
      },
    });
    await candidate.validate();
    budget(mongoose, candidate.toObject({ transform: false, minimize: false }));
    Reflect.deleteProperty(value, 'expiredAt');
    let published: T | null;
    try {
      published = await includeManagedAllocations(
        model.findOneAndUpdate(
          { ...physical, ...metadata, '_managed.phase': 'registering' },
          {
            $set: { ...value, expiredAt: undefined, ...metadata, '_managed.phase': 'published' },
            ...(deadlines.length && {
              $min: {
                expiredAt: new Date(Math.min(...deadlines.map((date) => date.getTime()))),
                '_managed.expiredAt': new Date(
                  Math.min(...deadlines.map((date) => date.getTime())),
                ),
              },
            }),
          },
          { upsert: false, new: true, runValidators: true, overwriteImmutable: true },
        ),
      )
        .select('+_managed')
        .lean<T | null>();
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 11000) throw error;
      // Only an acknowledged unique collision may select an independently published winner.
      published = await winner();
      if (!published) throw error;
      await retireManagedAllocation(mongoose, target, target.id);
      await reconcileAbsentChannelOwnership(mongoose, target, authority.roles);
      return published;
    }
    if (!published) throw new ChannelFeedbackAuthorityError();
    await readChannelFeedbackAuthority(mongoose, feedbackMapping(record), authority.source);
    await settleChannelOwnership(mongoose, target, authority.roles);
    return published;
  } catch (error) {
    await retireManagedAllocation(mongoose, target, target.id);
    await reconcileAbsentChannelOwnership(mongoose, target, authority.roles);
    throw error;
  }
}

type FeedbackLedgerPatch = Partial<
  Pick<
    ChannelFeedbackLedger,
    'votes' | 'rating' | 'revision' | 'exportStatus' | 'retryAtMs' | 'leaseId' | 'leaseUntilMs'
  >
>;

/** Measure retained fields exactly as the Run writer does; only explicit patches replace values. */
export async function writeFeedbackLedger(
  mongoose: typeof import('mongoose'),
  current: ChannelFeedbackLedger,
  patch: FeedbackLedgerPatch,
  condition: Partial<Pick<ChannelFeedbackLedger, 'revision' | 'leaseId' | 'leaseUntilMs'>> = {},
  unset: Partial<Record<'leaseId' | 'leaseUntilMs', ''>> = {},
): Promise<ChannelFeedbackLedger | null> {
  const version = current.__v;
  if (
    version == null ||
    !Number.isSafeInteger(version) ||
    version < 0 ||
    version >= Number.MAX_SAFE_INTEGER
  )
    throw new ChannelFeedbackAuthorityError();
  const model = mongoose.model<ChannelFeedbackLedger>('ChannelFeedback');
  const candidate = new model({ ...current, ...patch, __v: version + 1 });
  for (const field of Object.keys(unset)) candidate.set(field, undefined);
  await candidate.validate();
  const measured = {
    ...candidate.toObject({ transform: false, minimize: false }),
    ...current,
    ...Object.fromEntries(Object.keys(patch).map((field) => [field, candidate.get(field)])),
    __v: version + 1,
    updatedAt: new Date(),
  };
  for (const field of Object.keys(unset)) Reflect.deleteProperty(measured, field);
  budget(mongoose, measured);
  return model
    .findOneAndUpdate(
      { ...feedbackFilter(mongoose, current, 'channelFeedback'), __v: version, ...condition },
      { $set: patch, $inc: { __v: 1 }, ...(Object.keys(unset).length && { $unset: unset }) },
      { upsert: false, new: true, runValidators: true },
    )
    .select('+_managed')
    .lean();
}
