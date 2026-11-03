import { channelStorageConfigSchema } from 'librechat-data-provider';
import type { DurableStorageConfig } from 'librechat-data-provider';
import type { Types } from 'mongoose';
import type {
  ChannelRunRecord,
  ChannelControlAssignment,
  ChannelLaneAuthorityRef,
} from '~/models/channelRun';
import type {
  ManagedRegistryState,
  ManagedState,
  ManagedTarget,
  ManagedStorageTarget,
} from '~/types/managed';
import type { DisabledChannelGeneration } from './channelClosure';
import type { PhysicalChannelRun } from './channelRunWrite';
import {
  managedTargetPredicate,
  managedTargetModels,
  managedRegistration,
  retireManagedAllocation,
} from './managed';
import { managedRegistryCount, managedRegistryEpoch, managedRegistryEntryFilter } from './registry';
import { disabledChannelGenerationFilter, isDisabledChannelGeneration } from './channelClosure';
import { hasCreatorControlLineage } from './channelControlPrivacy';
import { retireChannelIdentity } from './channelIdentityErasure';
import { hasUncertainChannelDelivery } from './channelProtocol';
import { reconcileErasedResponseTargets } from './registration';
import { createChannelRunControl } from './channelRunControl';
import { includeManagedAllocations } from '~/utils/managed';
import { createAgentChannelModel } from '~/models/channel';
import { channelRegistryKey } from './channelRegistryKey';
import { responseScopeKeys } from './responseScope';

export class ChannelDrainPendingError extends Error {
  readonly code = 'channel_drain_pending';
  constructor() {
    super('Channel requests are still draining');
    this.name = 'ChannelDrainPendingError';
  }
}

const children = [
  'channelIdentity',
  'channelRun',
  'channelKey',
  'channelLane',
  'channelReply',
  'channelFeedbackEvent',
  'channelFeedback',
] as const;
type Child = (typeof children)[number];
type RegistryTarget = ManagedTarget<'channel' | 'channelIdentity'>;
interface Metadata extends ManagedRegistryState {
  _id: Types.ObjectId;
  _managed: ManagedState;
  __v?: number;
  state?: string;
  revision?: string;
  runId?: string;
  tenantId?: string;
  channelId?: string;
  kind?: string;
  laneId?: string;
  fingerprint?: string;
  channelRef?: ChannelLaneAuthorityRef<'channel'>;
  assignment?: ChannelControlAssignment;
  publication?: ChannelRunRecord['publication'];
  leaseOwner?: string;
  leaseGrantId?: string;
  leaseEpoch?: number;
  leaseExpiresAt?: number;
  terminalFence?: ChannelRunRecord['terminalFence'];
  cursorState?: ChannelRunRecord['cursorState'];
  receipts?: ReadonlyArray<Pick<ChannelRunRecord['receipts'][number], 'operationId' | 'outcome'>>;
  progress?: { outcome?: string };
  plan?: { parts: ReadonlyArray<{ operationId: string; required?: boolean }> };
}
type Inspection =
  | { status: 'pending' }
  | { status: 'absent' }
  | { status: 'retained'; row: Metadata };
const fields =
  '_id _managed __v state revision runId tenantId channelId kind laneId fingerprint channelRef assignment publication leaseOwner leaseGrantId leaseEpoch leaseExpiresAt terminalFence cursorState receipts.operationId receipts.outcome progress.outcome plan.parts.operationId plan.parts.required pending pendingCount retentionEpoch';

function terminalReceipt(row: Metadata): boolean {
  return (
    ['delivered', 'failed', 'cancelled'].includes(row.state ?? '') &&
    Boolean(row.terminalFence?.owner && row.terminalFence.grantId) &&
    Number.isSafeInteger(row.leaseEpoch) &&
    (row.leaseEpoch ?? 0) > 0 &&
    row.terminalFence?.epoch === row.leaseEpoch &&
    row.terminalFence?.grantId === row.leaseGrantId &&
    row.leaseOwner === undefined &&
    row.leaseExpiresAt === 0 &&
    !hasUncertainChannelDelivery(row)
  );
}

/** Re-enable fences unfinished publication and drains effects; published receipts remain history. */
export async function drainDisabledChannelGeneration(
  mongoose: typeof import('mongoose'),
  generation: DisabledChannelGeneration,
  batchSize: number,
  getDurableConfig: () => Promise<Partial<DurableStorageConfig>> = async () => ({}),
): Promise<'ready' | 'pending' | 'changed'> {
  const { erasureBatchSize } = channelStorageConfigSchema.parse({ erasureBatchSize: batchSize });
  const parentFilter = disabledChannelGenerationFilter(mongoose, generation);
  const parent = await includeManagedAllocations(
    createAgentChannelModel(mongoose).findOne(parentFilter),
  )
    .select('pending pendingCount retentionEpoch')
    .read('primary')
    .lean<ManagedRegistryState | null>();
  if (!parent) return 'changed';
  managedRegistryCount(parent);
  const life = channelRegistryKey({ target: generation.target, revision: '' }, false);
  const creator = {
    userId: generation.createdBy,
    ...(generation.target.tenantId && { tenantId: generation.target.tenantId }),
  };
  const creatorKey = responseScopeKeys(creator, '')[0];
  const wireTenant = generation.target.tenantId || '_';
  const control = createChannelRunControl(mongoose, getDurableConfig);
  const erasedScopes = new Set<string>();
  const targetFor = (kind: Child, row: Metadata): ManagedTarget<Child> => ({
    kind,
    id: String(row._id),
    incarnation: row._managed.incarnation,
    ...(generation.target.tenantId && { tenantId: generation.target.tenantId }),
  });
  const modelFor = (target: ManagedTarget<Child>) =>
    mongoose.model<Metadata>(managedTargetModels[target.kind]);
  function checkedTarget(target: ManagedStorageTarget): ManagedTarget<Child> {
    const kind = children.find((candidate) => candidate === target.kind);
    if (!kind || (target.tenantId || undefined) !== (generation.target.tenantId || undefined))
      throw new TypeError('Invalid channel drain target');
    return { ...target, kind };
  }
  function owned(target: ManagedTarget<Child>, row: Metadata): boolean {
    return (
      row._managed.parentId === target.id &&
      row._managed.receipt === managedRegistration(target).key &&
      [life, creatorKey].every((key) => row._managed.scopeKeys?.includes(key))
    );
  }
  function remember(row: Metadata): void {
    for (const key of [...(row._managed.scopeKeys ?? []), row._managed.ownerKey])
      if (key) erasedScopes.add(key);
  }
  async function flush(): Promise<void> {
    const keys = [...erasedScopes];
    for (let offset = 0; offset < keys.length; offset += erasureBatchSize)
      await reconcileErasedResponseTargets(
        mongoose,
        creator,
        keys.slice(offset, offset + erasureBatchSize),
      );
    erasedScopes.clear();
  }
  async function read(target: ManagedTarget<Child>) {
    return includeManagedAllocations(
      modelFor(target).findOne(managedTargetPredicate(mongoose, target)),
    )
      .select(fields)
      .read('primary')
      .lean<Metadata | null>();
  }
  async function repair(target: ManagedTarget<Child>, row: Metadata): Promise<boolean> {
    if (!terminalReceipt(row)) return false;
    const full = await mongoose
      .model<ChannelRunRecord>('ChannelRun')
      .findOne({
        ...managedTargetPredicate(mongoose, target),
        '_managed.phase': 'published',
      })
      .select('+_managed')
      .read('primary')
      .lean<PhysicalChannelRun | null>();
    if (!full) return true; // The inspector re-reads that exact target before acknowledging it.
    if (!terminalReceipt(full)) return false;
    await control.repairTerminal(full, Date.now());
    return true;
  }
  async function inspect(target: ManagedTarget<Child>, initial?: Metadata): Promise<Inspection> {
    let row = initial ?? (await read(target));
    for (;;) {
      if (!row) return { status: 'absent' };
      if (row._managed.phase !== 'published') {
        if (await retireManagedAllocation(mongoose, target, target.id)) {
          remember(row);
          return { status: 'absent' };
        }
        row = await read(target);
        if (!row) return { status: 'absent' };
      }
      if (!owned(target, row)) throw new Error('Channel drain ownership unavailable');
      if (row._managed.phase !== 'published') {
        if (target.kind === 'channelRun' && row._managed.phase === 'registered') {
          const removed = await modelFor(target).deleteOne({
            ...managedTargetPredicate(mongoose, target),
            '_managed.phase': 'registered',
            sequence: 0,
            execution: { $exists: false },
          });
          if (removed.deletedCount) {
            remember(row);
            return { status: 'absent' };
          }
          const current = await read(target);
          if (current?._managed.phase === 'registered')
            throw new Error('Invalid staged channel drain');
          row = current;
          continue;
        }
        if (target.kind === 'channelRun' && row._managed.phase === 'retired') {
          if (hasUncertainChannelDelivery(row)) return { status: 'pending' };
          await control.fenceErasedRun({ ...target, kind: 'channelRun' });
          await modelFor(target).deleteOne({
            ...managedTargetPredicate(mongoose, target),
            '_managed.phase': 'retired',
          });
          remember(row);
          row = await read(target);
          continue;
        }
        if (!(target.kind === 'channelIdentity' && row._managed.phase === 'retired'))
          throw new Error('Channel drain publication unavailable');
      }
      if (target.kind === 'channelIdentity') {
        await retireChannelIdentity(mongoose, { ...target, kind: 'channelIdentity' });
        if (!(await reconcileRegistry({ ...target, kind: 'channelIdentity' })))
          return { status: 'pending' };
        await retireChannelIdentity(mongoose, { ...target, kind: 'channelIdentity' });
        remember(row);
        row = await read(target);
        if (row) return { status: 'pending' };
        return { status: 'absent' };
      }
      if (target.kind === 'channelRun') {
        if (!terminalReceipt(row)) return { status: 'pending' };
        if (!['complete', 'retired'].includes(row.cursorState ?? '')) {
          if (!(await repair(target, row))) return { status: 'pending' };
          row = await read(target);
          continue;
        }
      }
      if (target.kind === 'channelLane' && row.kind === 'control') {
        if (
          typeof row.laneId !== 'string' ||
          typeof row.fingerprint !== 'string' ||
          !row.channelRef ||
          row.channelId !== generation.channelId ||
          row.tenantId !== wireTenant ||
          !hasCreatorControlLineage(
            creator,
            { ...target, kind: 'channelLane' },
            {
              kind: 'control',
              tenantId: wireTenant,
              channelId: generation.channelId,
              laneId: row.laneId,
              fingerprint: row.fingerprint,
              channelRef: row.channelRef,
              _managed: row._managed,
            },
          )
        )
          throw new Error('Channel control drain lineage unavailable');
        if (row.assignment) {
          if (row.assignment.run.target.kind !== 'channelRun')
            throw new Error('Invalid channel control assignment');
          const assigned = checkedTarget(row.assignment.run.target);
          const run = await read(assigned);
          if (!run) return { status: 'pending' };
          if (
            run.runId !== row.assignment.run.runId ||
            run.publication?.control.id !== target.id ||
            run.publication.control.incarnation !== target.incarnation
          )
            throw new Error('Channel control assignment changed target');
          if (run._managed.phase === 'retired') {
            if ((await inspect(assigned, run)).status === 'pending') return { status: 'pending' };
          } else if (!(await repair(assigned, run))) return { status: 'pending' };
          row = await read(target);
          if (row?.assignment) return { status: 'pending' };
          continue;
        }
      }
      return { status: 'retained', row };
    }
  }
  async function reconcileRegistry(target: RegistryTarget): Promise<boolean> {
    const model = mongoose.model<Metadata>(managedTargetModels[target.kind]);
    const filter =
      target.kind === 'channel'
        ? parentFilter
        : {
            ...managedTargetPredicate(mongoose, target),
            '_managed.phase': 'retired',
            state: 'revoked',
          };
    const anchor = await includeManagedAllocations(model.findOne(filter))
      .select(fields)
      .read('primary')
      .lean<Metadata | null>();
    if (!anchor) return true;
    managedRegistryCount(anchor);
    const epoch = managedRegistryEpoch(anchor);
    let ready = true;
    for (const kind of children)
      for (const entry of anchor.pending ?? []) {
        if (entry.target.kind !== kind) continue;
        if (target.kind === 'channelIdentity' && kind === 'channelIdentity')
          throw new Error('Invalid nested channel identity registry');
        const selected = checkedTarget(entry.target);
        const proof = await inspect(selected);
        if (proof.status === 'pending') {
          ready = false;
          continue;
        }
        if (proof.status === 'retained') {
          if (
            !entry.authorityRevision ||
            ![
              channelRegistryKey({ target, revision: '' }, false),
              channelRegistryKey({ target, revision: entry.authorityRevision }),
            ].every((key) => proof.row._managed.scopeKeys?.includes(key))
          )
            throw new Error('Channel drain registration lineage unavailable');
        }
        await model.updateOne(
          { ...filter, revision: anchor.revision, ...managedRegistryEntryFilter(entry, epoch) },
          { $pull: { pending: { key: entry.key } }, $inc: { pendingCount: -1 } },
          { upsert: false, timestamps: false },
        );
      }
    return ready;
  }

  // Existing work must finish through its provider/receipt owners; this gate never guesses drain.
  if (
    await includeManagedAllocations(
      mongoose.model('ChannelRun').exists({
        tenantId: wireTenant,
        '_managed.scopeKeys': life,
        '_managed.phase': 'published',
        state: { $in: ['queued', 'executing', 'requires_action', 'delivering', 'blocked'] },
      }),
    ).read('primary')
  )
    return (await isDisabledChannelGeneration(mongoose, generation)) ? 'pending' : 'changed';

  for (const kind of children) {
    for (const entry of parent.pending ?? []) {
      if (entry.target.kind !== kind) continue;
      if ((await inspect(checkedTarget(entry.target))).status === 'pending')
        return (await isDisabledChannelGeneration(mongoose, generation)) ? 'pending' : 'changed';
    }
    const model = mongoose.model<Metadata>(managedTargetModels[kind]);
    let after: Types.ObjectId | undefined;
    for (;;) {
      const page = await includeManagedAllocations(
        model.find({
          '_managed.scopeKeys': life,
          tenantId:
            kind === 'channelKey' ? generation.target.tenantId || { $in: [null, ''] } : wireTenant,
          ...(after && { _id: { $gt: after } }),
        }),
      )
        .select(fields)
        .sort({ _id: 1 })
        .limit(erasureBatchSize)
        .read('primary')
        .lean<Metadata[]>();
      if (!(await isDisabledChannelGeneration(mongoose, generation))) return 'changed';
      if (!page.length) break;
      for (const row of page)
        if ((await inspect(targetFor(kind, row), row)).status === 'pending')
          return (await isDisabledChannelGeneration(mongoose, generation)) ? 'pending' : 'changed';
      await flush();
      after = page[page.length - 1]._id;
    }
  }
  if (!(await reconcileRegistry(generation.target)))
    return (await isDisabledChannelGeneration(mongoose, generation)) ? 'pending' : 'changed';
  await flush();
  const current = await includeManagedAllocations(
    createAgentChannelModel(mongoose).findOne(parentFilter),
  )
    .select('pending pendingCount')
    .read('primary')
    .lean<ManagedRegistryState | null>();
  if (!current) return 'changed';
  return managedRegistryCount(current) ? 'pending' : 'ready';
}
