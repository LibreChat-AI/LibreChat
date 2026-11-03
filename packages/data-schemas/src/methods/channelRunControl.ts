import { randomUUID } from 'node:crypto';
import type { DurableStorageConfig } from 'librechat-data-provider';
import type { Types, UpdateQuery } from 'mongoose';
import type {
  ChannelRunRecord,
  ChannelControlLaneRecord,
  ChannelPrincipalLaneRecord,
  ChannelStopSelection,
  ChannelLaneAuthorityRef,
} from '~/models/channelRun';
import type { PhysicalChannelRun, ChannelRunMetadata } from './channelRunWrite';
import type { ManagedState, ManagedTarget } from '~/types/managed';
import type { ChannelLaneScope } from './channelProtocol';
import {
  laneKey,
  stopScopeKey,
  digest,
  activeStates,
  leaseDeadline,
  ChannelRunConflict,
} from './channelProtocol';
import {
  MAX_BSON_DOCUMENT_BYTES,
  BSON_WRITE_HEADROOM_BYTES,
  ManagedDocumentTooLargeError,
} from '~/utils/bson';
import {
  channelRunTarget,
  writeChannelRunPatch,
  CHANNEL_RUN_METADATA_FIELDS,
} from './channelRunWrite';
import { createChannelLaneModel, createChannelRunModel } from '~/models/channelRun';
import { registerResponseTarget, settleResponseTarget } from './registration';
import { managedTargetFilter, managedRegistration } from './managed';
import { createResponseScopeModel } from '~/models/responseScope';
import { createChannelLaneRootStorage } from './channelLaneRoot';
import { readChannelRunOwnership } from './channelOwnership';
import { includeManagedAllocations } from '~/utils/managed';
import { responseScopeKeys } from './responseScope';
import { managedTargetPredicate } from './managed';

type Control = ChannelControlLaneRecord & { _id: Types.ObjectId; _managed: ManagedState };
type Principal = ChannelPrincipalLaneRecord & { _id: Types.ObjectId; _managed: ManagedState };
const terminal = (run: Pick<ChannelRunRecord, 'state'>) =>
  ['delivered', 'failed', 'cancelled'].includes(run.state);
const same = (left: object | undefined, right: object | undefined) =>
  digest(left ?? {}) === digest(right ?? {});

// The actor control spans configuration versions; each Run's live authority remains versioned.
const sameParent = (
  left: ChannelLaneAuthorityRef<'channel'> | undefined,
  right: ChannelLaneAuthorityRef<'channel'> | undefined,
): boolean => Boolean(left && right && same(left.target, right.target));

export type ChannelRunClaim = Pick<
  PhysicalChannelRun,
  '_id' | '_managed' | 'tenantId' | 'publication' | 'leaseEpoch'
>;
interface ChannelRunControl {
  claim(
    run: ChannelRunClaim,
    owner: string,
    now: number,
    leaseMs: number,
    cleanup?: boolean,
  ): Promise<PhysicalChannelRun | null>;
  isActive(run: PhysicalChannelRun): Promise<boolean>;
  /** Called only after canonical owner erasure and the private Run publication fence. */
  fenceErasedRun(target: ManagedTarget<'channelRun'>): Promise<void>;
  repairTerminal(run: PhysicalChannelRun, now: number): Promise<PhysicalChannelRun>;
  observeStop(
    scope: ChannelLaneScope,
    eventAt: number,
    observedAt: number,
  ): Promise<{ run: PhysicalChannelRun; before: number } | null>;
  readActive(scope: ChannelLaneScope, before: number): Promise<PhysicalChannelRun | null>;
}

/** One actor/thread assignment owns every epoch grant and immutable Stop selection. */
export function createChannelRunControl(
  mongoose: typeof import('mongoose'),
  getDurableConfig: () => Promise<Partial<DurableStorageConfig>>,
): ChannelRunControl {
  const lanes = createChannelLaneModel(mongoose);
  const runs = createChannelRunModel(mongoose);
  const roots = createChannelLaneRootStorage(mongoose, getDurableConfig);
  async function readRun(target: ManagedTarget<'channelRun'>) {
    return runs
      .findOne({ ...managedTargetFilter(mongoose, target), '_managed.phase': 'published' })
      .select('+_managed')
      .read('primary')
      .lean<PhysicalChannelRun | null>();
  }
  async function readMetadata(target: ManagedTarget<'channelRun'>) {
    return runs
      .findOne({ ...managedTargetFilter(mongoose, target), '_managed.phase': 'published' })
      .select(CHANNEL_RUN_METADATA_FIELDS)
      .read('primary')
      .lean<ChannelRunMetadata | null>();
  }
  async function claimedPayload(target: ManagedTarget<'channelRun'>, owner: string, now: number) {
    const run = await readRun(target);
    return run &&
      !terminal(run) &&
      run.leaseOwner === owner &&
      run.leaseExpiresAt > now &&
      (await active(run))
      ? run
      : null;
  }
  async function readControl(target: ManagedTarget<'channelLane'>, cleanup = false) {
    return lanes
      .findOne({
        ...(cleanup
          ? managedTargetPredicate(mongoose, target)
          : managedTargetFilter(mongoose, target)),
        kind: 'control',
        '_managed.phase': 'published',
      })
      .select('+_managed')
      .read('primary')
      .lean<Control | null>();
  }
  const controlTarget = (row: Control): ManagedTarget<'channelLane'> => ({
    kind: 'channelLane',
    id: String(row._id),
    incarnation: row._managed.incarnation,
    ...(row.tenantId !== '_' && { tenantId: row.tenantId }),
  });
  function assertLaneBudget(current: object, fields: object, unset: object = {}) {
    const values = { ...current, ...fields, updatedAt: new Date() };
    for (const field of Object.keys(unset)) Reflect.deleteProperty(values, field);
    if (
      mongoose.mongo.BSON.calculateObjectSize(values) + BSON_WRITE_HEADROOM_BYTES >
      MAX_BSON_DOCUMENT_BYTES
    )
      throw new ManagedDocumentTooLargeError();
  }
  async function updateControl(
    row: Control,
    update: UpdateQuery<ChannelControlLaneRecord>,
    cleanup = false,
  ) {
    if (
      !Number.isSafeInteger(row.revision) ||
      row.revision < 0 ||
      row.revision >= Number.MAX_SAFE_INTEGER
    )
      throw new Error('Control revision unavailable');
    assertLaneBudget(row, { ...update.$set, revision: row.revision + 1 }, update.$unset);
    return lanes.updateOne(
      {
        ...(cleanup
          ? managedTargetPredicate(mongoose, controlTarget(row))
          : managedTargetFilter(mongoose, controlTarget(row))),
        kind: 'control',
        '_managed.phase': 'published',
        revision: row.revision,
      },
      { ...update, $inc: { revision: 1 } },
      { upsert: false, runValidators: true },
    );
  }
  async function live(run: PhysicalChannelRun, now: number) {
    const current = await readChannelRunOwnership(mongoose, run, now);
    if (
      !current ||
      !run.publication ||
      !same(current.channel.target, run.publication.channel.target) ||
      current.channel.revision !== run.publication.channel.revision ||
      !same(current.identity?.target, run.publication.identity?.target) ||
      current.identity?.revision !== run.publication.identity?.revision
    )
      return false;
    const anchor = await createResponseScopeModel(mongoose)
      .findOne({
        _id: responseScopeKeys(current.owner, '')[0],
        closed: false,
        $or: [{ expiredAt: null }, { expiredAt: { $gt: new Date() } }],
      })
      .select('_id')
      .read('primary')
      .lean();
    return Boolean(anchor);
  }
  async function recoverGrant(control: Control): Promise<void> {
    const grant = control.assignment;
    if (!grant || grant.phase !== 'granting') return;
    for (;;) {
      const run = await readRun(grant.run.target);
      if (
        !run ||
        run.runId !== grant.run.runId ||
        !same(run.publication?.control, controlTarget(control)) ||
        !sameParent(run.publication?.channel, control.channelRef) ||
        !same(run.publication?.lane, grant.lane) ||
        laneKey(run) !== grant.principalFingerprint
      )
        return;
      if (terminal(run)) break; // A terminal CAS made every delayed active-state grant inert.
      if (run.leaseEpoch === grant.epoch && run.leaseGrantId === grant.grantId) break;
      if (run.leaseEpoch !== grant.previousEpoch) return;
      const updated = await writeChannelRunPatch(
        mongoose,
        run,
        {
          leaseOwner: grant.owner,
          leaseGrantId: grant.grantId,
          leaseEpoch: grant.epoch,
          leaseExpiresAt: grant.leaseExpiresAt,
          claimCheckedAt: grant.checkedAt,
          receipts: run.receipts.map((receipt) =>
            receipt.outcome === 'inflight' ? { ...receipt, outcome: 'unknown' as const } : receipt,
          ),
          ...(run.progress?.outcome === 'inflight' && {
            progress: { ...run.progress, outcome: 'unknown' as const },
          }),
          ...(grant.purpose === 'cleanup' && {
            cancellationRequested: true,
            errorCode: 'channel_authority_changed',
          }),
        },
        { leaseEpoch: grant.previousEpoch, state: { $in: activeStates } },
        getDurableConfig,
      );
      if (updated) break;
    }
    // A competing helper may already have acknowledged this exact immutable grant.
    await updateControl(control, { $set: { assignment: { ...grant, phase: 'active' } } });
  }
  async function settleStop(control: Control, now: number): Promise<void> {
    const stop = control.stop;
    if (!stop || stop.phase !== 'selecting') return;
    if (control.assignment?.phase === 'granting')
      throw new Error('Stop selected an unfinished grant');
    const assignment = control.assignment;
    let selection: ChannelStopSelection = { result: 'none' };
    if (assignment) {
      const run = await readRun(assignment.run.target);
      if (
        run &&
        run.runId === assignment.run.runId &&
        run.leaseEpoch === assignment.epoch &&
        run.leaseGrantId === assignment.grantId &&
        laneKey(run) === stop.principalFingerprint &&
        ['queued', 'executing', 'requires_action'].includes(run.state) &&
        run.receivedAt <= stop.before &&
        (run.claimCheckedAt ?? Infinity) <= stop.before &&
        (await live(run, now))
      )
        selection = { result: 'run', run: assignment.run, epoch: assignment.epoch };
    }
    await updateControl(control, { $set: { stop: { ...stop, phase: 'selected', selection } } });
  }
  async function active(run: ChannelRunMetadata): Promise<boolean> {
    if (!run.publication) return false;
    const row = await readControl(run.publication.control);
    const assignment = row?.assignment;
    return Boolean(
      assignment &&
        assignment.phase === 'active' &&
        same(assignment.run.target, channelRunTarget(run)) &&
        assignment.run.runId === run.runId &&
        assignment.epoch === run.leaseEpoch &&
        assignment.grantId === run.leaseGrantId &&
        assignment.owner === run.leaseOwner &&
        same(assignment.lane, run.publication.lane) &&
        sameParent(row?.channelRef, run.publication.channel) &&
        assignment.principalFingerprint === laneKey(run),
    );
  }
  async function repairTerminal(
    initial: PhysicalChannelRun,
    now: number,
  ): Promise<PhysicalChannelRun> {
    if (
      !terminal(initial) ||
      !initial.publication ||
      !initial.terminalFence ||
      initial.terminalFence.epoch !== initial.leaseEpoch ||
      initial.terminalFence.grantId !== initial.leaseGrantId
    )
      throw new Error('Cursor repair requires a terminal Run receipt');
    let run = initial;
    const target = channelRunTarget(run);
    while (!run.cursorState || run.cursorState === 'pending') {
      const lane = await lanes
        .findOne({
          ...managedTargetFilter(mongoose, run.publication!.lane),
          kind: 'principal',
          '_managed.phase': 'published',
        })
        .select('+_managed')
        .read('primary')
        .lean<Principal | null>();
      let retired = !lane;
      if (
        lane &&
        !(lane.handoff?.sequence === run.sequence && same(lane.handoff.run.target, target))
      ) {
        if ((lane.handoff?.sequence ?? 0) >= run.sequence)
          throw new Error('Cursor handoff changed target');
        const success = run.state === 'delivered';
        const conversationId = success ? run.execution?.conversationId : undefined;
        const responseId = success ? run.execution?.responseId : undefined;
        if (success && (!conversationId || !responseId))
          throw new Error('Delivered Run lost its continuation');
        const owner = {
          userId: run.principal.userId,
          ...(target.tenantId && { tenantId: target.tenantId }),
        };
        const laneTarget = run.publication!.lane;
        const admitted = conversationId
          ? await registerResponseTarget(
              mongoose,
              owner,
              conversationId,
              managedRegistration(laneTarget),
              await getDurableConfig(),
            )
          : null;
        if (admitted && admitted.status !== 'registered') retired = true;
        else {
          assertLaneBudget(lane, {
            handoff: { run: { target, runId: run.runId }, sequence: run.sequence },
            revision: lane.revision + 1,
            ...(conversationId && {
              conversationId,
              responseId,
              _managed: {
                ...lane._managed,
                scopeKeys: [
                  ...new Set([
                    ...(lane._managed.scopeKeys ?? []),
                    responseScopeKeys(owner, conversationId)[1],
                  ]),
                ],
              },
            }),
          });
          const result = await lanes.updateOne(
            {
              ...managedTargetFilter(mongoose, laneTarget),
              kind: 'principal',
              '_managed.phase': 'published',
              revision: lane.revision,
            },
            {
              $set: {
                handoff: { run: { target, runId: run.runId }, sequence: run.sequence },
                ...(conversationId && {
                  conversationId,
                  responseId,
                  '_managed.scopeKeys': [
                    ...new Set([
                      ...(lane._managed.scopeKeys ?? []),
                      responseScopeKeys(owner, conversationId)[1],
                    ]),
                  ],
                }),
              },
              $inc: { revision: 1 },
              ...(admitted?.status === 'registered' &&
                admitted.expiredAt && { $min: { '_managed.expiredAt': admitted.expiredAt } }),
            },
            { upsert: false, runValidators: true },
          );
          if (!result.matchedCount) continue;
          if (conversationId)
            await settleResponseTarget(
              mongoose,
              owner,
              conversationId,
              managedRegistration(laneTarget),
            );
        }
      }
      const updated = await writeChannelRunPatch(
        mongoose,
        run,
        { cursorState: retired ? 'retired' : 'complete' },
        { state: run.state, leaseEpoch: run.leaseEpoch },
        getDurableConfig,
      );
      if (updated) run = updated;
      else {
        const current = await readRun(target);
        if (!current) return run;
        run = current;
      }
    }
    for (;;) {
      const control = await readControl(run.publication!.control);
      if (!control || !control.assignment || !same(control.assignment.run.target, target))
        return run;
      if (control.assignment.phase === 'granting') {
        await recoverGrant(control);
        continue;
      }
      if (control.stop?.phase === 'selecting') {
        await settleStop(control, now);
        continue;
      }
      const cleared = await updateControl(control, { $unset: { assignment: 1 } });
      if (cleared.matchedCount) return run;
    }
  }
  return {
    isActive: active,
    async fenceErasedRun(target) {
      const run = await includeManagedAllocations(
        runs.findOne({ ...managedTargetPredicate(mongoose, target), '_managed.phase': 'retired' }),
      )
        .select(CHANNEL_RUN_METADATA_FIELDS)
        .read('primary')
        .lean<ChannelRunMetadata | null>();
      if (!run) {
        if (
          !(await includeManagedAllocations(
            runs.exists(managedTargetPredicate(mongoose, target)),
          ).read('primary'))
        )
          return;
        throw new Error('Erased Run retirement proof unavailable');
      }
      if (!run.publication || run._managed.parentId !== target.id)
        throw new Error('Erased Run retirement proof unavailable');
      const binding = run.publication.control;
      for (;;) {
        const control = await readControl(binding, true);
        if (!control) {
          // An unpublished control hidden by normal visibility is not physical absence.
          if (
            await includeManagedAllocations(
              lanes.exists(managedTargetPredicate(mongoose, binding)),
            ).read('primary')
          )
            throw new Error('Erased Run control retirement is pending');
          return;
        }
        if (!sameParent(control.channelRef, run.publication.channel))
          throw new Error('Erased Run control authority changed');
        const ownAssignment = same(control.assignment?.run.target, target);
        const stop = control.stop;
        const resolveStop = stop?.phase === 'selecting' && (ownAssignment || !control.assignment);
        // Every grant selector reads this revision before re-reading the published Run.
        // Touch it even without an assignment, invalidating a paused pre-retirement selector.
        const fenced = await updateControl(
          control,
          {
            ...(ownAssignment && { $unset: { assignment: 1 } }),
            ...(resolveStop && {
              $set: { stop: { ...stop, phase: 'selected', selection: { result: 'none' } } },
            }),
          },
          true,
        );
        if (fenced.matchedCount) return;
      }
    },
    repairTerminal,
    async claim(initial, owner, now, leaseMs, cleanup = false) {
      if (!initial.publication) throw new Error('Run publication unavailable');
      const target = channelRunTarget(initial);
      const binding = initial.publication.control;
      let selectedGrant: string | undefined;
      for (;;) {
        const control = await readControl(binding);
        if (!control || !sameParent(control.channelRef, initial.publication.channel)) return null;
        if (control.assignment?.phase === 'granting') {
          await recoverGrant(control);
          const pending = await readControl(binding);
          if (pending?.assignment?.phase === 'granting') return null;
          continue;
        }
        if (control.stop?.phase === 'selecting') {
          await settleStop(control, now);
          continue;
        }
        if (control.assignment && !same(control.assignment.run.target, target)) {
          const previous = await readMetadata(control.assignment.run.target);
          if (!previous || !terminal(previous)) return null;
          const terminalRun = await readRun(control.assignment.run.target);
          if (!terminalRun) return null;
          await repairTerminal(terminalRun, now);
          continue;
        }
        const run = await readMetadata(target);
        if (!run || terminal(run)) {
          if (run) {
            const terminalRun = await readRun(target);
            if (terminalRun) await repairTerminal(terminalRun, now);
          }
          return null;
        }
        if (
          selectedGrant &&
          control.assignment?.grantId === selectedGrant &&
          run.leaseGrantId === selectedGrant &&
          run.leaseOwner === owner &&
          run.leaseExpiresAt > now &&
          (await active(run))
        )
          return claimedPayload(target, owner, now);
        if (
          cleanup &&
          run.leaseEpoch === initial.leaseEpoch &&
          control.assignment?.purpose === 'cleanup' &&
          run.errorCode === 'channel_authority_changed' &&
          run.leaseOwner === owner &&
          run.leaseExpiresAt > now &&
          (await active(run))
        )
          return claimedPayload(target, owner, now);
        if (
          cleanup &&
          (run.leaseEpoch !== initial.leaseEpoch ||
            (run.errorCode === 'channel_authority_changed' && run.leaseExpiresAt > now))
        )
          return null;
        if (!cleanup && (await active(run)) && run.leaseOwner === owner && run.leaseExpiresAt > now)
          return claimedPayload(target, owner, now);
        if (!cleanup && run.leaseExpiresAt > now) return null;
        const lane = await lanes
          .findOne({
            ...managedTargetFilter(mongoose, run.publication!.lane),
            kind: 'principal',
            '_managed.phase': 'published',
          })
          .select('publishedThrough')
          .read('primary')
          .lean<Principal | null>();
        if (!lane || run.sequence > (lane.publishedThrough ?? -1)) return null;
        if (!Number.isSafeInteger(run.leaseEpoch) || run.leaseEpoch >= Number.MAX_SAFE_INTEGER)
          throw new Error('Run lease epoch exhausted');
        const grantId = randomUUID();
        const selected = await updateControl(control, {
          $set: {
            assignment: {
              grantId,
              phase: 'granting',
              purpose: cleanup ? 'cleanup' : 'work',
              run: { target, runId: run.runId },
              lane: run.publication!.lane,
              principalFingerprint: laneKey(run),
              owner,
              previousEpoch: run.leaseEpoch,
              epoch: run.leaseEpoch + 1,
              leaseExpiresAt: leaseDeadline(now, leaseMs),
              checkedAt: now,
            },
          },
        });
        if (!selected.matchedCount) continue;
        selectedGrant = grantId;
      }
    },
    async observeStop(scope, eventAt, observedAt) {
      if (!Number.isSafeInteger(eventAt) || eventAt <= 0 || !Number.isSafeInteger(observedAt))
        throw new TypeError('Invalid Stop time');
      const authority = await readChannelRunOwnership(mongoose, scope, observedAt);
      if (!authority) return null;
      const fingerprint = stopScopeKey(scope);
      let row = await lanes
        .findOne({
          tenantId: scope.tenantId,
          channelId: scope.channelId,
          kind: 'control',
          laneId: `control:${fingerprint}`,
          '_managed.phase': 'published',
        })
        .select('+_managed')
        .read('primary')
        .lean<Control | null>();
      const binding = row
        ? controlTarget(row)
        : (await roots.acquire(scope, { kind: 'control' }, observedAt)).target;
      for (;;) {
        row = await readControl(binding);
        if (
          !row ||
          !sameParent(row.channelRef, {
            target: authority.channel.target,
            revision: authority.channel.revision,
          })
        )
          return null;
        if (row.assignment?.phase === 'granting') {
          await recoverGrant(row);
          const pending = await readControl(binding);
          if (pending?.assignment?.phase === 'granting')
            throw new ChannelRunConflict('invalid_transition');
          continue;
        }
        if (row.stop?.phase === 'selecting') {
          await settleStop(row, observedAt);
          continue;
        }
        const stop = row.stop;
        if (stop && stop.eventAt > eventAt) return null;
        if (stop?.eventAt === eventAt) {
          if (stop.principalFingerprint !== laneKey(scope) || stop.selection?.result !== 'run')
            return null;
          const run = await readRun(stop.selection.run.target);
          return run &&
            run.runId === stop.selection.run.runId &&
            run.receivedAt <= stop.before &&
            (run.claimCheckedAt ?? Infinity) <= stop.before &&
            run.leaseEpoch === stop.selection.epoch &&
            laneKey(run) === stop.principalFingerprint &&
            ['queued', 'executing', 'requires_action'].includes(run.state) &&
            (await live(run, observedAt))
            ? { run, before: stop.before }
            : null;
        }
        await updateControl(row, {
          $set: {
            stop: {
              occurrenceId: digest({ fingerprint, eventAt }),
              eventAt,
              before: Math.min(eventAt, observedAt),
              principalFingerprint: laneKey(scope),
              phase: 'selecting',
            },
          },
        });
      }
    },
    async readActive(scope, before) {
      const row = await lanes
        .findOne({
          tenantId: scope.tenantId,
          channelId: scope.channelId,
          kind: 'control',
          laneId: `control:${stopScopeKey(scope)}`,
          '_managed.phase': 'published',
        })
        .select('+_managed')
        .read('primary')
        .lean<Control | null>();
      if (!row?.assignment || row.assignment.phase !== 'active') return null;
      const run = await readRun(row.assignment.run.target);
      return run &&
        run.runId === row.assignment.run.runId &&
        run.leaseGrantId === row.assignment.grantId &&
        run.leaseEpoch === row.assignment.epoch &&
        laneKey(run) === laneKey(scope) &&
        run.receivedAt <= before &&
        (run.claimCheckedAt ?? Infinity) <= before &&
        ['queued', 'executing', 'requires_action'].includes(run.state) &&
        (await live(run, before))
        ? run
        : null;
    },
  };
}
