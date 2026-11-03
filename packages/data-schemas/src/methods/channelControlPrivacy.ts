import type { Types } from 'mongoose';
import type {
  ChannelControlLaneRecord,
  ChannelControlAssignment,
  ChannelStopSelection,
} from '~/models/channelRun';
import type { ManagedTarget, ManagedState } from '~/types/managed';
import type { ResponseOwner } from '~/models/response';
import { managedTargetPredicate, managedRegistration, assertManagedCleanupTenant } from './managed';
import { getTenantId, tenantStorage, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { createAgentChannelModel, CHANNEL_PRIVATE_FIELDS } from '~/models/channel';
import { createChannelLaneModel } from '~/models/channelRun';
import { includeManagedAllocations } from '~/utils/managed';
import { channelRegistryKey } from './channelRegistryKey';
import { responseScopeKeys } from './responseScope';
import { digest } from './channelProtocol';

interface StoredControl extends ChannelControlLaneRecord {
  _id: Types.ObjectId;
  _managed: ManagedState;
  __v?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

/** A control has only the creator and captured channel generation roles, never a private owner. */
function ownedControl(
  owner: ResponseOwner,
  target: ManagedTarget<'channelLane'>,
  row: StoredControl,
): boolean {
  const state = row._managed;
  if (
    row.kind !== 'control' ||
    !state ||
    state.phase !== 'published' ||
    state.incarnation !== target.incarnation ||
    state.parentId !== target.id ||
    state.receipt !== managedRegistration(target).key ||
    state.logicalId !== row.laneId ||
    row.laneId !== `control:${row.fingerprint}` ||
    !/^[a-f\d]{64}$/.test(row.fingerprint) ||
    row.tenantId !== (owner.tenantId || '_') ||
    (target.tenantId || undefined) !== (owner.tenantId || undefined) ||
    row.channelRef?.target.kind !== 'channel' ||
    (row.channelRef.target.tenantId || undefined) !== (owner.tenantId || undefined)
  )
    return false;
  const expected = [
    responseScopeKeys(owner, '')[0],
    channelRegistryKey(row.channelRef, false),
    channelRegistryKey(row.channelRef),
  ].sort();
  return digest(state.scopeKeys ?? []) === digest(expected);
}

async function closedParent(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  row: StoredControl,
): Promise<boolean> {
  const exact = managedTargetPredicate(mongoose, row.channelRef.target);
  const model = createAgentChannelModel(mongoose);
  if (
    await includeManagedAllocations(
      model.exists({
        ...exact,
        createdBy: owner.userId,
        status: 'deleting',
        '_managed.phase': 'published',
        ...Object.fromEntries(CHANNEL_PRIVATE_FIELDS.map((field) => [field, { $exists: false }])),
      }),
    ).read('primary')
  )
    return true;
  return !(await includeManagedAllocations(model.exists(exact)).read('primary'));
}

// Every new control field must explicitly choose its retained metadata representation.
type Complete<Value> = { [Key in keyof Required<Value>]: Value[Key] };
function physical<Kind extends 'channel' | 'channelLane' | 'channelRun'>(
  value: ManagedTarget<Kind>,
): ManagedTarget<Kind> {
  return {
    kind: value.kind,
    id: value.id,
    incarnation: value.incarnation,
    ...(value.tenantId && { tenantId: value.tenantId }),
  };
}
function assignment(
  value: ChannelControlAssignment | undefined,
): ChannelControlAssignment | undefined {
  if (!value) return undefined;
  const known: Complete<ChannelControlAssignment> = {
    grantId: value.grantId,
    phase: value.phase,
    purpose: value.purpose,
    run: { target: physical(value.run.target), runId: value.run.runId },
    lane: physical(value.lane),
    principalFingerprint: value.principalFingerprint,
    owner: value.owner,
    previousEpoch: value.previousEpoch,
    epoch: value.epoch,
    leaseExpiresAt: value.leaseExpiresAt,
    checkedAt: value.checkedAt,
  };
  return known;
}
function selection(value: ChannelStopSelection | undefined): ChannelStopSelection | undefined {
  if (!value) return undefined;
  return value.result === 'none'
    ? { result: 'none' }
    : {
        result: 'run',
        run: { target: physical(value.run.target), runId: value.run.runId },
        epoch: value.epoch,
      };
}
function stop(value: ChannelControlLaneRecord['stop']): ChannelControlLaneRecord['stop'] {
  if (!value) return undefined;
  const known: Complete<NonNullable<ChannelControlLaneRecord['stop']>> = {
    occurrenceId: value.occurrenceId,
    eventAt: value.eventAt,
    before: value.before,
    principalFingerprint: value.principalFingerprint,
    phase: value.phase,
    selection: selection(value.selection),
  };
  return known;
}

/** Keep only the fixed coordination contract, including when runtime plugins extend the schema. */
async function metadataControl(
  mongoose: typeof import('mongoose'),
  row: StoredControl,
): Promise<StoredControl> {
  const state = row._managed;
  const fields: Complete<ChannelControlLaneRecord> = {
    kind: 'control',
    tenantId: row.tenantId,
    channelId: row.channelId,
    laneId: row.laneId,
    revision: row.revision,
    fingerprint: row.fingerprint,
    channelRef: { target: physical(row.channelRef.target), revision: row.channelRef.revision },
    assignment: assignment(row.assignment),
    stop: stop(row.stop),
  };
  const known: StoredControl = {
    ...fields,
    _id: row._id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    __v: row.__v,
    _managed: {
      incarnation: state.incarnation,
      phase: state.phase,
      parentId: state.parentId,
      receipt: state.receipt,
      logicalId: state.logicalId,
      scopeKeys: state.scopeKeys,
      ...(state.expiredAt && { expiredAt: state.expiredAt }),
    },
  };
  const candidate = new (createChannelLaneModel(mongoose))(known);
  await candidate.validate();
  return known;
}

function assertControlPartition(owner: ResponseOwner, target: ManagedTarget<'channelLane'>): void {
  assertManagedCleanupTenant(owner.tenantId);
  if ((target.tenantId || undefined) !== (owner.tenantId || undefined))
    throw new TypeError('Creator control cleanup partition changed');
}

/** Cleanup may preserve coordination only after inspecting its entire persisted document. */
export async function isRedactedCreatorControl(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  target: ManagedTarget<'channelLane'>,
): Promise<boolean> {
  assertControlPartition(owner, target);
  const row = await includeManagedAllocations(
    createChannelLaneModel(mongoose).findOne(managedTargetPredicate(mongoose, target)),
  )
    .select('+_managed')
    .read('primary')
    .lean<StoredControl | null>();
  return Boolean(
    row &&
      ownedControl(owner, target, row) &&
      (await closedParent(mongoose, owner, row)) &&
      digest(row) === digest(await metadataControl(mongoose, row)),
  );
}

/** Preserve grants and Stop receipts while erasing every non-coordination extension. */
export async function redactCreatorControl(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  target: ManagedTarget<'channelLane'>,
): Promise<void> {
  assertControlPartition(owner, target);
  if (!owner.tenantId && getTenantId() !== SYSTEM_TENANT_ID)
    return tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, () =>
      redactCreatorControl(mongoose, owner, target),
    );
  const model = createChannelLaneModel(mongoose);
  const exact = managedTargetPredicate(mongoose, target);
  for (;;) {
    const row = await includeManagedAllocations(model.findOne(exact))
      .select('+_managed')
      .read('primary')
      .lean<StoredControl | null>();
    if (!row) return;
    if (!ownedControl(owner, target, row) || !(await closedParent(mongoose, owner, row)))
      throw new Error('Creator control cleanup authority unavailable');
    const known = await metadataControl(mongoose, row);
    if (digest(row) === digest(known)) return;
    if (
      !Number.isSafeInteger(row.revision) ||
      row.revision < 0 ||
      row.revision >= Number.MAX_SAFE_INTEGER
    )
      throw new Error('Creator control revision unavailable');
    known.revision = row.revision + 1;
    const result = await model.replaceOne(
      {
        ...exact,
        kind: 'control',
        '_managed.phase': 'published',
        revision: row.revision,
        '_managed.expiredAt': row._managed.expiredAt ?? null,
      },
      known,
      { upsert: false, runValidators: true },
    );
    if (result.matchedCount) {
      if (!(await isRedactedCreatorControl(mongoose, owner, target)))
        throw new Error('Creator control payload erasure is pending');
      return;
    }
  }
}
