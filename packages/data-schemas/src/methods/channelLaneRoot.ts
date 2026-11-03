import { durableStorageConfigSchema } from 'librechat-data-provider';
import type { DurableStorageConfig } from 'librechat-data-provider';
import type { Types } from 'mongoose';
import type { ChannelLaneRecord, ChannelLaneAuthorityRef } from '~/models/channelRun';
import type { ManagedTarget, ManagedState } from '~/types/managed';
import type { ChannelLaneScope } from './channelProtocol';
import {
  readChannelRunOwnership,
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
import { laneKey, stopScopeKey, digest, ChannelRunConflict } from './channelProtocol';
import { createChannelLaneModel } from '~/models/channelRun';
import { createChannelIndexGate } from './channelIndexes';
import { responseScopeKeys } from './responseScope';

type LaneChoice =
  | { kind: 'control' }
  | { kind: 'principal'; controlTarget: ManagedTarget<'channelLane'> };
export interface ChannelLaneRoot {
  target: ManagedTarget<'channelLane'>;
  record: ChannelLaneRecord;
}
interface LaneMetadata {
  _id: Types.ObjectId;
  _managed: ManagedState;
  kind: ChannelLaneRecord['kind'];
  fingerprint?: string;
  userId?: string;
  channelRef?: ChannelLaneAuthorityRef;
  identityRef?: ChannelLaneAuthorityRef;
  controlTarget?: ManagedTarget<'channelLane'>;
}

export interface ChannelLaneRootStorage {
  /** Fresh admission only; a saved Run reads its captured target instead of acquiring a replacement. */
  acquire(scope: ChannelLaneScope, choice: LaneChoice, now: number): Promise<ChannelLaneRoot>;
}

export function createChannelLaneRootStorage(
  mongoose: typeof import('mongoose'),
  getDurableConfig: () => Promise<Partial<DurableStorageConfig>> = async () => ({}),
): ChannelLaneRootStorage {
  const model = createChannelLaneModel(mongoose);
  const ensureIndexes = createChannelIndexGate(() => [model]);
  return {
    async acquire(scope, choice, now) {
      const limits = durableStorageConfigSchema.parse(await getDurableConfig());
      const current = await readChannelRunOwnership(mongoose, scope, now);
      if (!current) throw new ChannelRunConflict('invalid_transition');
      const captured = current;
      const roles =
        choice.kind === 'control'
          ? { creator: captured.creator, channel: captured.channel }
          : captured;
      await ensureIndexes();
      const channelRef: ChannelLaneAuthorityRef<'channel'> = {
        target: captured.channel.target,
        revision: captured.channel.revision,
      };
      const identityRef: ChannelLaneAuthorityRef<'channelIdentity'> | undefined =
        captured.identity && {
          target: captured.identity.target,
          revision: captured.identity.revision,
        };
      const fingerprint = choice.kind === 'control' ? stopScopeKey(scope) : laneKey(scope);
      const laneId = choice.kind === 'control' ? `control:${fingerprint}` : fingerprint;
      if (choice.kind === 'principal') {
        if (choice.controlTarget.kind !== 'channelLane')
          throw new ChannelRunConflict('invalid_transition');
        const control = await model
          .findOne({
            ...managedTargetFilter(mongoose, choice.controlTarget),
            kind: 'control',
            channelId: scope.channelId,
            fingerprint: stopScopeKey(scope),
            '_managed.phase': 'published',
          })
          .select('channelRef')
          .read('primary')
          .lean<{ channelRef: ChannelLaneAuthorityRef } | null>();
        if (!control || digest(control.channelRef) !== digest(channelRef))
          throw new ChannelRunConflict('invalid_transition');
      }
      const body: ChannelLaneRecord =
        choice.kind === 'control'
          ? {
              kind: 'control',
              tenantId: scope.tenantId,
              channelId: scope.channelId,
              laneId,
              fingerprint,
              channelRef,
              revision: 0,
            }
          : {
              kind: 'principal',
              tenantId: scope.tenantId,
              channelId: scope.channelId,
              laneId,
              userId: captured.owner.userId,
              fingerprint,
              channelRef,
              ...(identityRef && { identityRef }),
              controlTarget: choice.controlTarget,
              revision: 0,
              nextSequence: 0,
              publishedThrough: 0,
            };
      const immutable = (row: LaneMetadata | ChannelLaneRecord) => ({
        kind: row.kind,
        fingerprint: row.fingerprint,
        userId: 'userId' in row ? row.userId : undefined,
        channelRef: row.channelRef,
        identityRef: 'identityRef' in row ? row.identityRef : undefined,
        controlTarget: 'controlTarget' in row ? row.controlTarget : undefined,
      });
      async function readWinner(): Promise<ChannelLaneRoot | null> {
        const winner = await model
          .findOne({
            tenantId: scope.tenantId,
            laneId,
            channelId: scope.channelId,
            '_managed.phase': 'published',
          })
          .select('_id kind fingerprint userId channelRef identityRef controlTarget +_managed')
          .read('primary')
          .lean<LaneMetadata | null>();
        if (!winner) return null;
        if (!winner._managed || digest(immutable(winner)) !== digest(immutable(body)))
          throw new ChannelRunConflict('invalid_transition');
        const target: ManagedTarget<'channelLane'> = {
          kind: 'channelLane',
          id: String(winner._id),
          incarnation: winner._managed.incarnation,
          ...(captured.channel.target.tenantId && { tenantId: captured.channel.target.tenantId }),
        };
        return loadRegistered(target);
      }
      async function loadRegistered(
        target: ManagedTarget<'channelLane'>,
      ): Promise<ChannelLaneRoot> {
        const admitted = await registerChannelOwnership(mongoose, target, roles, {
          maxPendingTargetsPerScope: limits.maxPendingTargetsPerScope,
        });
        if (admitted.status !== 'registered') throw new ChannelRunConflict('invalid_transition');
        if (admitted.expiredAt)
          await model.updateOne(
            {
              ...managedTargetFilter(mongoose, target),
              '_managed.phase': 'published',
            },
            { $min: { '_managed.expiredAt': admitted.expiredAt } },
            { upsert: false },
          );
        return readPublished(target);
      }
      async function readPublished(target: ManagedTarget<'channelLane'>): Promise<ChannelLaneRoot> {
        const record = await model
          .findOne({
            ...managedTargetFilter(mongoose, target),
            kind: choice.kind,
            fingerprint,
            '_managed.phase': 'published',
          })
          .read('primary')
          .lean();
        if (!record) throw new ChannelRunConflict('invalid_transition');
        await settleChannelOwnership(mongoose, target, roles);
        return { target, record };
      }
      const existing = await readWinner();
      if (existing) return existing;
      const candidate = new model(body);
      await candidate.validate();
      const bytes = mongoose.mongo.BSON.calculateObjectSize(
        candidate.toObject({ transform: false }),
      );
      if (bytes + BSON_WRITE_HEADROOM_BYTES > MAX_BSON_DOCUMENT_BYTES)
        throw new ManagedDocumentTooLargeError();
      const target = await allocateManagedTarget(
        mongoose,
        'channelLane',
        captured.channel.target.tenantId,
      );
      const physical = managedTargetFilter(mongoose, target);
      const metadata = {
        ...channelOwnershipFields(mongoose, target, roles),
        '_managed.parentId': target.id,
        '_managed.receipt': managedRegistration(target).key,
        '_managed.logicalId': laneId,
        ...(choice.kind === 'principal' && {
          '_managed.ownerKey': responseScopeKeys(captured.owner, '')[0],
        }),
      };
      try {
        const described = await model.updateOne(
          { ...physical, '_managed.phase': 'empty' },
          {
            $set: { ...metadata, '_managed.phase': 'registering' },
          },
          { upsert: false, timestamps: false },
        );
        if (!described.matchedCount) throw new ChannelRunConflict('invalid_transition');
        const admitted = await registerChannelOwnership(mongoose, target, roles, {
          maxPendingTargetsPerScope: limits.maxPendingTargetsPerScope,
        });
        if (admitted.status !== 'registered') throw new ChannelRunConflict('invalid_transition');
        const published = await model.updateOne(
          { ...physical, ...metadata, '_managed.phase': 'registering' },
          {
            $set: {
              ...body,
              ...metadata,
              '_managed.phase': 'published',
              createdAt: new Date(),
              __v: 0,
            },
            ...(admitted.expiredAt && { $min: { '_managed.expiredAt': admitted.expiredAt } }),
          },
          { upsert: false, runValidators: true, overwriteImmutable: true },
        );
        if (!published.matchedCount) throw new ChannelRunConflict('invalid_transition');
        return await readPublished(target);
      } catch (error) {
        if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) {
          const winner = await readWinner();
          if (winner) return winner;
        }
        throw error;
      } finally {
        await retireManagedAllocation(mongoose, target, target.id);
        await reconcileAbsentChannelOwnership(mongoose, target, roles);
      }
    },
  };
}
