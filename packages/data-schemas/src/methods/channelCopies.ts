import type { Types } from 'mongoose';
import type { ManagedState, ManagedTarget, ManagedRegistryState } from '~/types/managed';
import type { ChannelRunRecord, ChannelLaneAuthorityRef } from '~/models/channelRun';
import {
  managedTargetPredicate,
  retireManagedAllocation,
  assertManagedCleanupTenant,
} from './managed';
import { reconcileClosedChannelTarget } from './channelRegistry';
import { hasUncertainChannelDelivery } from './channelProtocol';
import { reconcileErasedResponseTargets } from './registration';
import { createChannelRunControl } from './channelRunControl';
import { sealPublishedChannelRun } from './channelRunWrite';
import { includeManagedAllocations } from '~/utils/managed';
import { createAgentChannelModel } from '~/models/channel';
import { channelRegistryKey } from './channelRegistryKey';
import { responseScopeKeys } from './responseScope';
import { managedRegistryCount } from './registry';

const kinds = ['channelRun', 'channelKey', 'channelLane'] as const;
const models = {
  channelRun: 'ChannelRun',
  channelKey: 'AgentApiKey',
  channelLane: 'ChannelLane',
} as const;
type CopyKind = (typeof kinds)[number];
interface CopyMetadata {
  _id: Types.ObjectId;
  _managed: ManagedState;
  __v?: number;
  state?: ChannelRunRecord['state'];
  terminalFence?: ChannelRunRecord['terminalFence'];
  cursorState?: ChannelRunRecord['cursorState'];
  publication?: ChannelRunRecord['publication'];
  identityRef?: ChannelLaneAuthorityRef<'channelIdentity'>;
  receipts?: ReadonlyArray<Pick<ChannelRunRecord['receipts'][number], 'operationId' | 'outcome'>>;
  progress?: { outcome?: string };
  plan?: { parts: ReadonlyArray<{ operationId: string; required?: boolean }> };
}
const fields =
  '_id _managed __v state terminalFence cursorState publication identityRef receipts.operationId receipts.outcome progress.outcome plan.parts.operationId plan.parts.required';

/** Closed canonical admission freezes every private publisher. Canonical history has a different owner.
 * Active, unfenced or required-uncertain delivery stays pending; absence is never execution retirement. */
export async function eraseChannelCopies(
  mongoose: typeof import('mongoose'),
  connection: { target: ManagedTarget<'channel'>; channelId: string; createdBy: string },
  batchSize: number,
): Promise<boolean> {
  const { target, channelId, createdBy } = connection;
  assertManagedCleanupTenant(target.tenantId);
  const channels = createAgentChannelModel(mongoose);
  const exactParent = managedTargetPredicate(mongoose, target);
  const parent = await includeManagedAllocations(channels.findOne(exactParent))
    .select('status channelId createdBy pending pendingCount _managed.phase')
    .read('primary')
    .lean<
      | (ManagedRegistryState & {
          status: string;
          channelId: string;
          createdBy: string;
          _managed: ManagedState;
        })
      | null
    >();
  if (
    parent &&
    (parent._managed?.phase !== 'published' ||
      parent.status !== 'deleting' ||
      parent.channelId !== channelId ||
      parent.createdBy !== createdBy)
  )
    throw new Error('Channel copy erasure requires closed canonical ownership');
  if (parent) managedRegistryCount(parent);
  const life = channelRegistryKey({ target, revision: '' }, false);
  const creator = { userId: createdBy, ...(target.tenantId && { tenantId: target.tenantId }) };
  const creatorKey = responseScopeKeys(creator, '')[0];
  const control = createChannelRunControl(mongoose, async () => ({}));
  let pending = false;
  for (const kind of kinds) {
    const model = mongoose.model<CopyMetadata>(models[kind]);
    const partition =
      kind === 'channelKey' ? target.tenantId || { $in: [null, ''] } : target.tenantId || '_';
    const scopes = new Set<string>();
    const links = new Map<string, ManagedTarget<'channelIdentity'>>();
    function remember(row: CopyMetadata): void {
      for (const key of row._managed.scopeKeys ?? []) scopes.add(key);
      const link = row.publication?.identity?.target ?? row.identityRef?.target;
      if (link) {
        if ((link.tenantId || undefined) !== (target.tenantId || undefined))
          throw new Error('Channel copy link partition changed');
        links.set(`${link.id}:${link.incarnation}`, link);
      }
    }
    async function flush(): Promise<void> {
      const keys = [...scopes];
      for (let offset = 0; offset < keys.length; offset += batchSize)
        await reconcileErasedResponseTargets(
          mongoose,
          creator,
          keys.slice(offset, offset + batchSize),
        );
      for (const link of links.values()) await reconcileClosedChannelTarget(mongoose, link);
      scopes.clear();
      links.clear();
    }
    async function erase(copy: ManagedTarget<CopyKind>, initial?: CopyMetadata): Promise<void> {
      if ((copy.tenantId || undefined) !== (target.tenantId || undefined))
        throw new TypeError('Channel copy partition changed');
      const exact = managedTargetPredicate(mongoose, copy);
      let row = initial;
      for (;;) {
        row ??=
          (await includeManagedAllocations(model.findOne(exact))
            .select(fields)
            .read('primary')
            .lean<CopyMetadata | null>()) ?? undefined;
        if (!row) return;
        if (
          row._managed.phase !== 'published' &&
          (await retireManagedAllocation(mongoose, copy, copy.id))
        ) {
          remember(row);
          return;
        }
        if (
          !row._managed?.scopeKeys?.includes(life) ||
          !row._managed.scopeKeys.includes(creatorKey)
        )
          throw new Error('Channel copy lineage unavailable');
        if (!['published', 'retired'].includes(row._managed.phase)) {
          if (kind === 'channelRun' && row._managed.phase === 'registered') {
            const erased = await model.deleteOne({
              ...exact,
              '_managed.phase': 'registered',
              sequence: 0,
              execution: { $exists: false },
            });
            if (erased.deletedCount) {
              remember(row);
              return;
            }
            if (
              await includeManagedAllocations(
                model.exists({ ...exact, '_managed.phase': 'registered' }),
              ).read('primary')
            )
              throw new Error('Invalid staged Run erasure');
          }
          if (
            await includeManagedAllocations(
              model.exists({ ...exact, '_managed.phase': row._managed.phase }),
            ).read('primary')
          )
            throw new Error('Invalid channel copy publication');
          row = undefined;
          continue;
        }
        if (kind === 'channelRun') {
          if (
            hasUncertainChannelDelivery(row) ||
            (row._managed.phase === 'published' &&
              (!['delivered', 'failed', 'cancelled'].includes(row.state ?? '') ||
                !row.terminalFence ||
                !row.cursorState))
          ) {
            pending = true;
            return;
          }
          if (
            !row.publication ||
            row.publication.creatorId !== createdBy ||
            channelRegistryKey(row.publication.channel, false) !== life ||
            row._managed.parentId !== copy.id
          )
            throw new Error('Run cleanup publication unavailable');
          if (
            row._managed.phase === 'published' &&
            !(await sealPublishedChannelRun(mongoose, { ...copy, kind: 'channelRun' }, row.__v))
          ) {
            row = undefined;
            continue;
          }
          await control.fenceErasedRun({ ...copy, kind: 'channelRun' });
        }
        const erased = await model.deleteOne({
          ...exact,
          '_managed.phase': kind === 'channelRun' ? 'retired' : row._managed.phase,
          '_managed.scopeKeys': { $all: [life, creatorKey] },
        });
        if (
          erased.deletedCount ||
          !(await includeManagedAllocations(model.exists(exact)).read('primary'))
        ) {
          remember(row);
          return;
        }
        row = undefined;
      }
    }
    for (const entry of parent?.pending ?? []) {
      if (entry.target.kind !== kind) continue;
      await erase({ ...entry.target, kind });
    }
    await flush();
    let after: Types.ObjectId | undefined;
    for (;;) {
      const page = await includeManagedAllocations(
        model.find({
          '_managed.scopeKeys': life,
          tenantId: partition,
          ...(after && { _id: { $gt: after } }),
        }),
      )
        .select(fields)
        .sort({ _id: 1 })
        .limit(batchSize)
        .read('primary')
        .lean<CopyMetadata[]>();
      if (!page.length) break;
      for (const row of page)
        await erase(
          {
            kind,
            id: String(row._id),
            incarnation: row._managed.incarnation,
            ...(target.tenantId && { tenantId: target.tenantId }),
          },
          row,
        );
      await flush();
      after = page[page.length - 1]._id;
    }
    if (pending) return false; // Source credentials/cursors still belong to the unresolved Run.
    if (
      await includeManagedAllocations(
        model.exists({ '_managed.scopeKeys': life, tenantId: partition }),
      ).read('primary')
    )
      return false;
  }
  await reconcileClosedChannelTarget(mongoose, target);
  return true;
}
