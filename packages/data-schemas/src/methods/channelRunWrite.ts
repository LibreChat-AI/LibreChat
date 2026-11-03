import type { DurableStorageConfig } from 'librechat-data-provider';
import type { Types, FilterQuery } from 'mongoose';
import type { ManagedState, ManagedTarget } from '~/types/managed';
import type { ChannelRunRecord } from '~/models/channelRun';
import {
  MAX_BSON_DOCUMENT_BYTES,
  BSON_WRITE_HEADROOM_BYTES,
  ManagedDocumentTooLargeError,
} from '~/utils/bson';
import { registerResponseTarget, settleResponseTarget } from './registration';
import { managedRegistration, managedTargetFilter } from './managed';
import { ChannelRunConflict } from './channelProtocol';
import { responseScopeKeys } from './responseScope';

export type PhysicalChannelRun = ChannelRunRecord & {
  _id: Types.ObjectId;
  _managed: ManagedState;
  __v: number;
};

/** Scheduling and authority recovery never need prompt, snapshot, plan or delivery payloads. */
export type ChannelRunMetadata = Pick<
  PhysicalChannelRun,
  | '_id'
  | '_managed'
  | '__v'
  | 'tenantId'
  | 'channelId'
  | 'agentId'
  | 'runId'
  | 'laneId'
  | 'principal'
  | 'publication'
  | 'sequence'
  | 'leaseOwner'
  | 'leaseGrantId'
  | 'leaseEpoch'
  | 'leaseExpiresAt'
  | 'state'
  | 'errorCode'
  | 'claimCheckedAt'
  | 'receivedAt'
> & {
  admission: Pick<
    ChannelRunRecord['admission'],
    'actor' | 'externalChannelId' | 'externalThreadKey'
  >;
};
export const CHANNEL_RUN_METADATA_FIELDS: string =
  '_id tenantId channelId agentId runId laneId principal publication sequence leaseOwner leaseGrantId leaseEpoch leaseExpiresAt state errorCode claimCheckedAt receivedAt __v admission.actor admission.externalChannelId admission.externalThreadKey +_managed';

/** A captured Run can never adopt another physical record with the same public identity. */
export function channelRunTarget(
  run: Pick<PhysicalChannelRun, '_id' | '_managed' | 'tenantId' | 'publication'>,
): ManagedTarget<'channelRun'> {
  if (!run._managed?.incarnation || run._managed.phase !== 'published' || !run.publication)
    throw new Error('Channel Run publication identity unavailable');
  return {
    kind: 'channelRun',
    id: String(run._id),
    incarnation: run._managed.incarnation,
    ...(run.tenantId !== '_' && { tenantId: run.tenantId }),
  };
}

/** Full persisted size, including existing extensions, before one plugin-aware version CAS. */
export async function writeChannelRunPatch(
  mongoose: typeof import('mongoose'),
  current: PhysicalChannelRun,
  patch: Partial<ChannelRunRecord>,
  condition: FilterQuery<ChannelRunRecord>,
  getDurableConfig: () => Promise<Partial<DurableStorageConfig>>,
  retireLease = false,
): Promise<PhysicalChannelRun | null> {
  if (
    !Number.isSafeInteger(current.__v) ||
    current.__v < 0 ||
    current.__v >= Number.MAX_SAFE_INTEGER
  )
    throw new Error('Channel Run write version unavailable');
  if (retireLease && !['delivered', 'failed', 'cancelled'].includes(patch.state ?? ''))
    throw new Error('Lease retirement requires a terminal Run');
  const model = mongoose.model<ChannelRunRecord>('ChannelRun');
  const candidate = new model({ ...current, ...patch, __v: current.__v + 1 });
  await candidate.validate();
  const values = {
    ...candidate.toObject({ transform: false, minimize: false }),
    ...current,
    ...Object.fromEntries(Object.keys(patch).map((field) => [field, candidate.get(field)])),
    __v: current.__v + 1,
    updatedAt: new Date(),
  };
  if (
    mongoose.mongo.BSON.calculateObjectSize(values) + BSON_WRITE_HEADROOM_BYTES >
    MAX_BSON_DOCUMENT_BYTES
  )
    throw new ManagedDocumentTooLargeError();
  const target = channelRunTarget(current);
  const owner = {
    userId: current.principal.userId,
    ...(target.tenantId && { tenantId: target.tenantId }),
  };
  const conversationId = patch.execution?.conversationId;
  if (
    current.execution &&
    patch.execution &&
    (current.execution.conversationId !== patch.execution.conversationId ||
      current.execution.parentMessageId !== patch.execution.parentMessageId ||
      current.execution.requestId !== patch.execution.requestId)
  )
    throw new ChannelRunConflict('invalid_transition');
  const firstConversation = conversationId && !current.execution;
  const admission = firstConversation
    ? await registerResponseTarget(
        mongoose,
        owner,
        conversationId,
        managedRegistration(target),
        await getDurableConfig(),
      )
    : null;
  if (admission && admission.status !== 'registered')
    throw new ChannelRunConflict('invalid_transition');
  const conversationFields = firstConversation
    ? {
        '_managed.scopeKeys': [
          ...new Set([
            ...(current._managed.scopeKeys ?? []),
            responseScopeKeys(owner, conversationId)[1],
          ]),
        ],
      }
    : {};
  const result = await model
    .findOneAndUpdate(
      {
        ...condition,
        ...managedTargetFilter(mongoose, channelRunTarget(current)),
        '_managed.phase': 'published',
        __v: current.__v,
      },
      {
        $set: { ...patch, ...conversationFields },
        $inc: { __v: 1 },
        ...(retireLease && { $unset: { leaseOwner: 1, 'execution.encryptedApiKey': 1 } }),
        ...(admission?.status === 'registered' &&
          admission.expiredAt && {
            $min: { '_managed.expiredAt': admission.expiredAt },
          }),
      },
      { upsert: false, new: true, runValidators: true },
    )
    .select('+_managed')
    .lean<PhysicalChannelRun | null>();
  if (result && firstConversation)
    await settleResponseTarget(mongoose, owner, conversationId, managedRegistration(target));
  return result;
}
