import { randomUUID } from 'node:crypto';
import { durableStorageConfigSchema } from 'librechat-data-provider';
import type { DurableStorageConfig } from 'librechat-data-provider';
import type { Types } from 'mongoose';
import type { ChannelRunRecord, ChannelPrincipalLaneRecord } from '~/models/channelRun';
import type { ManagedState, ManagedTarget } from '~/types/managed';
import type { ChannelRunEnrollment } from './channelProtocol';
import type { ChannelRunOwnership } from './channelOwnership';
import type { ChannelLaneRoot } from './channelLaneRoot';
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
import { createChannelRunModel, createChannelLaneModel } from '~/models/channelRun';
import { includeManagedAllocations, ALLOCATION_PREFIX } from '~/utils/managed';
import { createChannelLaneRootStorage } from './channelLaneRoot';
import { digest, ChannelRunConflict } from './channelProtocol';
import { createChannelIndexGate } from './channelIndexes';
import { responseScopeKeys } from './responseScope';

type PhysicalRun = ChannelRunRecord & { _id: Types.ObjectId; _managed: ManagedState };
interface ChannelRunPublication {
  admit(
    input: ChannelRunEnrollment,
    now: number,
  ): Promise<{ run: ChannelRunRecord; duplicate: boolean }>;
  recoverPending(tenantId: string, channelId: string, now: number, limit: number): Promise<void>;
}

/** Private staging and one durable lane intent replace the cross-document FIFO transaction. */
export function createChannelRunPublication(
  mongoose: typeof import('mongoose'),
  getDurableConfig: () => Promise<Partial<DurableStorageConfig>>,
): ChannelRunPublication {
  const runs = createChannelRunModel(mongoose);
  const lanes = createChannelLaneModel(mongoose);
  const roots = createChannelLaneRootStorage(mongoose, getDurableConfig);
  const ensureIndexes = createChannelIndexGate(() => [runs, lanes]);
  const physicalRun = (run: PhysicalRun): ManagedTarget<'channelRun'> => ({
    kind: 'channelRun',
    id: String(run._id),
    incarnation: run._managed.incarnation,
    ...(run.tenantId !== '_' && { tenantId: run.tenantId }),
  });
  async function readRun(target: ManagedTarget<'channelRun'>) {
    return includeManagedAllocations(runs.findOne(managedTargetFilter(mongoose, target)))
      .select('+_managed')
      .read('primary')
      .lean<PhysicalRun | null>();
  }
  async function readLane(root: Pick<ChannelLaneRoot, 'target'>) {
    const lane = await lanes
      .findOne({
        ...managedTargetFilter(mongoose, root.target),
        kind: 'principal',
        '_managed.phase': 'published',
      })
      .read('primary')
      .lean<ChannelPrincipalLaneRecord | null>();
    if (!lane) throw new ChannelRunConflict('invalid_transition');
    if (
      !Number.isSafeInteger(lane.nextSequence) ||
      !Number.isSafeInteger(lane.publishedThrough) ||
      lane.nextSequence < 0 ||
      lane.publishedThrough! < 0 ||
      lane.publishedThrough! > lane.nextSequence
    )
      throw new Error('Invalid channel publication frontier');
    return lane;
  }
  async function finishPublisher(
    root: Pick<ChannelLaneRoot, 'target'>,
    lane: ChannelPrincipalLaneRecord,
    roles?: ChannelRunOwnership,
  ) {
    const intent = lane.publisher;
    if (!intent) return;
    if (intent.sequence !== lane.nextSequence || intent.sequence !== lane.publishedThrough! + 1)
      throw new Error('Invalid channel publisher intent');
    const run = await readRun(intent.run.target);
    let retired = !run;
    if (run) {
      if (
        run.runId !== intent.run.runId ||
        digest(run.publication?.lane ?? {}) !== digest(root.target)
      )
        throw new Error('Channel publisher target changed');
      if (run._managed.phase === 'registered') {
        if (run.sequence !== 0 || run.laneId !== `${ALLOCATION_PREFIX}${intent.run.target.id}`)
          throw new Error('Invalid staged channel sequence');
        if (run._managed.expiredAt && run._managed.expiredAt.getTime() <= Date.now()) {
          // Update-only publication cannot revive this exact staged target after acknowledged removal.
          const removed = await runs.deleteOne({
            ...managedTargetFilter(mongoose, intent.run.target),
            '_managed.phase': 'registered',
            runId: intent.run.runId,
            sequence: 0,
          });
          retired = removed.deletedCount === 1;
          if (!retired) {
            const current = await readRun(intent.run.target);
            retired = !current;
            if (
              current &&
              (current._managed.phase !== 'published' ||
                current.sequence !== intent.sequence ||
                current.laneId !== lane.laneId)
            )
              throw new ChannelRunConflict('invalid_transition');
          }
        } else {
          const published = await runs.updateOne(
            {
              ...managedTargetFilter(mongoose, intent.run.target),
              '_managed.phase': 'registered',
              runId: intent.run.runId,
              sequence: 0,
              laneId: run.laneId,
              'publication.lane.id': root.target.id,
              'publication.lane.incarnation': root.target.incarnation,
            },
            {
              $set: {
                laneId: lane.laneId,
                sequence: intent.sequence,
                '_managed.phase': 'published',
              },
            },
            { upsert: false, runValidators: true },
          );
          if (!published.matchedCount) {
            // A competitor may have completed the same intent; inspect the exact target below.
            const current = await readRun(intent.run.target);
            if (
              current &&
              (current._managed.phase !== 'published' ||
                current.sequence !== intent.sequence ||
                current.laneId !== lane.laneId)
            )
              throw new ChannelRunConflict('invalid_transition');
          }
        }
      } else if (
        run._managed.phase !== 'published' ||
        run.sequence !== intent.sequence ||
        run.laneId !== lane.laneId
      )
        throw new ChannelRunConflict('invalid_transition');
    }
    // True physical absence is safe: allocation was acknowledged once and is never replayed.
    const cleanupRoles = roles ?? (run ? capturedOwnership(run) : undefined);
    if (retired && cleanupRoles)
      await reconcileAbsentChannelOwnership(mongoose, intent.run.target, cleanupRoles);
    await lanes.updateOne(
      {
        ...managedTargetFilter(mongoose, root.target),
        kind: 'principal',
        '_managed.phase': 'published',
        revision: lane.revision,
        nextSequence: intent.sequence,
        publishedThrough: intent.sequence - 1,
        'publisher.run.target.id': intent.run.target.id,
        'publisher.run.target.incarnation': intent.run.target.incarnation,
        'publisher.run.runId': intent.run.runId,
        'publisher.sequence': intent.sequence,
      },
      {
        $set: { publishedThrough: intent.sequence },
        $unset: { publisher: 1 },
        $inc: { revision: 1 },
      },
      { upsert: false },
    );
  }
  async function publish(
    root: Pick<ChannelLaneRoot, 'target'>,
    target: ManagedTarget<'channelRun'>,
    roles: ChannelRunOwnership,
  ) {
    for (;;) {
      const lane = await readLane(root);
      if (lane.publisher) {
        await finishPublisher(root, lane, roles);
        continue;
      }
      const run = await readRun(target);
      if (!run) return null;
      if (run._managed.phase === 'published') {
        if (run.sequence > lane.publishedThrough! || run.laneId !== lane.laneId)
          throw new Error('Channel publication frontier lost its intent');
        return run;
      }
      if (run._managed.phase !== 'registered') throw new ChannelRunConflict('invalid_transition');
      if (lane.nextSequence >= Number.MAX_SAFE_INTEGER)
        throw new Error('Channel sequence exhausted');
      await lanes.updateOne(
        {
          ...managedTargetFilter(mongoose, root.target),
          kind: 'principal',
          '_managed.phase': 'published',
          revision: lane.revision,
          nextSequence: lane.nextSequence,
          publishedThrough: lane.nextSequence,
          publisher: { $exists: false },
        },
        {
          $set: {
            publisher: {
              run: { target, runId: run.runId },
              sequence: lane.nextSequence + 1,
            },
          },
          $inc: { revision: 1, nextSequence: 1 },
        },
        { upsert: false, runValidators: true },
      );
    }
  }
  function capturedOwnership(run: PhysicalRun): ChannelRunOwnership {
    const saved = run.publication;
    if (!saved) throw new ChannelRunConflict('invalid_transition');
    const tenantId = run.tenantId === '_' ? undefined : run.tenantId;
    const roles: ChannelRunOwnership = {
      creator: { userId: saved.creatorId, ...(tenantId && { tenantId }) },
      owner: { userId: run.principal.userId, ...(tenantId && { tenantId }) },
      channel: {
        ...saved.channel,
        channelId: run.channelId,
        agentId: run.agentId,
        createdBy: saved.creatorId,
        teamId: run.admission.actor.teamId,
        appId: run.admission.actor.appId,
      },
    };
    if (saved.identity) {
      if (!run.principal.linkId || !run.principal.linkRevision)
        throw new Error('Channel publication lost its identity');
      roles.identity = {
        ...saved.identity,
        linkId: run.principal.linkId,
        userId: run.principal.userId,
        channelId: run.channelId,
        channelRevision: run.principal.channelRevision,
        agentId: run.agentId,
        teamId: run.admission.actor.teamId,
        externalUserId: run.admission.actor.externalUserId,
      };
    }
    return roles;
  }
  return {
    /** Bounded existing-worker recovery, without allocating another Run or execution lane. */
    async recoverPending(
      tenantId: string,
      channelId: string,
      now: number,
      limit: number,
    ): Promise<void> {
      const limits = durableStorageConfigSchema.parse(await getDurableConfig());
      await ensureIndexes();
      const staged = await includeManagedAllocations(
        runs.find({ tenantId, channelId, '_managed.phase': 'registered' }),
      )
        .select('+_managed')
        .sort({ _id: 1 })
        .limit(limit)
        .read('primary')
        .lean<PhysicalRun[]>();
      for (const run of staged) {
        const target = physicalRun(run);
        const roles = capturedOwnership(run);
        const current = await readChannelRunOwnership(mongoose, run, now);
        const admitted =
          current &&
          current.creator.userId === roles.creator.userId &&
          current.owner.userId === roles.owner.userId &&
          digest(current.channel.target) === digest(roles.channel.target) &&
          current.channel.revision === roles.channel.revision &&
          digest(current.identity?.target ?? {}) === digest(roles.identity?.target ?? {}) &&
          current.identity?.revision === roles.identity?.revision
            ? await registerChannelOwnership(mongoose, target, roles, limits)
            : null;
        if (admitted?.status !== 'registered') {
          await runs.deleteOne({
            ...managedTargetFilter(mongoose, target),
            '_managed.phase': 'registered',
          });
          await reconcileAbsentChannelOwnership(mongoose, target, roles);
          continue;
        }
        if (admitted.expiredAt)
          await runs.updateOne(
            managedTargetFilter(mongoose, target),
            {
              $min: { '_managed.expiredAt': admitted.expiredAt },
            },
            { upsert: false },
          );
        const published = await publish({ target: run.publication!.lane }, target, roles);
        if (published) await settleChannelOwnership(mongoose, target, roles);
        else await reconcileAbsentChannelOwnership(mongoose, target, roles);
      }
      // A lost Run-publication reply can leave a visible Run behind an unresolved frontier.
      const pending = await lanes
        .find({
          tenantId,
          channelId,
          kind: 'principal',
          '_managed.phase': 'published',
          publisher: { $exists: true },
        })
        .select('+_managed')
        .sort({ _id: 1 })
        .limit(limit)
        .read('primary')
        .lean<
          Array<ChannelPrincipalLaneRecord & { _id: Types.ObjectId; _managed: ManagedState }>
        >();
      for (const lane of pending) {
        const target: ManagedTarget<'channelLane'> = {
          kind: 'channelLane',
          id: String(lane._id),
          incarnation: lane._managed.incarnation,
          ...(tenantId !== '_' && { tenantId }),
        };
        await finishPublisher({ target }, lane);
        const run = await readRun(lane.publisher!.run.target);
        if (run) await settleChannelOwnership(mongoose, physicalRun(run), capturedOwnership(run));
      }
    },
    async admit(
      input: ChannelRunEnrollment,
      now: number,
    ): Promise<{ run: ChannelRunRecord; duplicate: boolean }> {
      if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Invalid admission time');
      const limits = durableStorageConfigSchema.parse(await getDurableConfig());
      const authority = await readChannelRunOwnership(mongoose, input, now);
      if (!authority) throw new ChannelRunConflict('invalid_transition');
      const roles = authority;
      await ensureIndexes();
      const control = await roots.acquire(input, { kind: 'control' }, now);
      const lane = await roots.acquire(
        input,
        { kind: 'principal', controlTarget: control.target },
        now,
      );
      const publication: NonNullable<ChannelRunRecord['publication']> = {
        creatorId: roles.creator.userId,
        lane: lane.target,
        control: control.target,
        channel: { target: roles.channel.target, revision: roles.channel.revision },
        ...(roles.identity && {
          identity: { target: roles.identity.target, revision: roles.identity.revision },
        }),
      };
      if (
        lane.record.kind !== 'principal' ||
        digest(lane.record.channelRef ?? {}) !== digest(publication.channel) ||
        digest(lane.record.identityRef ?? {}) !== digest(publication.identity ?? {})
      )
        throw new ChannelRunConflict('invalid_transition');
      const eventKey = {
        tenantId: input.tenantId,
        channelId: input.channelId,
        'admission.actor.teamId': input.admission.actor.teamId,
        'admission.actor.appId': input.admission.actor.appId,
        'admission.eventId': input.admission.eventId,
      };
      async function existing() {
        const row = await includeManagedAllocations(runs.findOne(eventKey))
          .select('+_managed')
          .read('primary')
          .lean<PhysicalRun | null>();
        if (!row) return null;
        if (
          !row._managed ||
          digest(row.admission) !== digest(input.admission) ||
          row.agentId !== input.agentId ||
          digest(row.principal) !== digest(input.principal) ||
          digest(row.publication ?? {}) !== digest(publication)
        )
          throw new ChannelRunConflict('event_conflict');
        return row;
      }
      async function finish(row: PhysicalRun, duplicate: boolean) {
        const target = physicalRun(row);
        const admitted = await registerChannelOwnership(mongoose, target, roles, limits);
        if (admitted.status !== 'registered') throw new ChannelRunConflict('invalid_transition');
        if (admitted.expiredAt)
          await runs.updateOne(
            managedTargetFilter(mongoose, target),
            { $min: { '_managed.expiredAt': admitted.expiredAt } },
            { upsert: false },
          );
        const run = await publish(lane, target, roles);
        if (!run) throw new ChannelRunConflict('invalid_transition');
        await settleChannelOwnership(mongoose, target, roles);
        return { run, duplicate };
      }
      const winner = await existing();
      if (winner) return finish(winner, true);
      const body: ChannelRunRecord = {
        tenantId: input.tenantId,
        channelId: input.channelId,
        agentId: input.agentId,
        principal: input.principal,
        admission: input.admission,
        runId: randomUUID(),
        laneId: `${ALLOCATION_PREFIX}${'0'.repeat(24)}`,
        sequence: 0,
        state: 'queued',
        payloadHash: digest(input.admission),
        receivedAt: now,
        leaseEpoch: 0,
        leaseExpiresAt: 0,
        receipts: [],
        cancellationRequested: false,
        publication,
      };
      const candidate = new runs(body);
      await candidate.validate();
      if (
        mongoose.mongo.BSON.calculateObjectSize(candidate.toObject({ transform: false })) +
          BSON_WRITE_HEADROOM_BYTES >
        MAX_BSON_DOCUMENT_BYTES
      )
        throw new ManagedDocumentTooLargeError();
      const target = await allocateManagedTarget(mongoose, 'channelRun', roles.owner.tenantId);
      const physical = managedTargetFilter(mongoose, target);
      const metadata = {
        ...channelOwnershipFields(mongoose, target, roles),
        '_managed.parentId': target.id,
        '_managed.receipt': managedRegistration(target).key,
        '_managed.ownerKey': responseScopeKeys(roles.owner, '')[0],
        '_managed.logicalId': body.runId,
      };
      try {
        const described = await runs.updateOne(
          { ...physical, '_managed.phase': 'empty' },
          { $set: { ...metadata, '_managed.phase': 'registering' } },
          { upsert: false, timestamps: false },
        );
        if (!described.matchedCount) throw new ChannelRunConflict('invalid_transition');
        const admitted = await registerChannelOwnership(mongoose, target, roles, limits);
        if (admitted.status !== 'registered') throw new ChannelRunConflict('invalid_transition');
        const staged = await runs.updateOne(
          { ...physical, ...metadata, '_managed.phase': 'registering' },
          {
            $set: {
              ...body,
              laneId: `${ALLOCATION_PREFIX}${target.id}`,
              ...metadata,
              '_managed.phase': 'registered',
              createdAt: new Date(),
              __v: 0,
            },
            ...(admitted.expiredAt && { $min: { '_managed.expiredAt': admitted.expiredAt } }),
          },
          { upsert: false, runValidators: true },
        );
        if (!staged.matchedCount) throw new ChannelRunConflict('invalid_transition');
        const run = await publish(lane, target, roles);
        if (!run) throw new ChannelRunConflict('invalid_transition');
        await settleChannelOwnership(mongoose, target, roles);
        return { run, duplicate: false };
      } catch (error) {
        if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) {
          const row = await existing();
          if (row) return finish(row, true);
        }
        throw error;
      } finally {
        // Only untouched metadata placeholders qualify; uncertain private staging remains discoverable.
        await retireManagedAllocation(mongoose, target, target.id);
        await reconcileAbsentChannelOwnership(mongoose, target, roles);
      }
    },
  };
}
