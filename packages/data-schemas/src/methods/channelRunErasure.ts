import type { Types } from 'mongoose';
import type { ManagedState, ManagedTarget, ManagedRegistration } from '~/types/managed';
import type { ChannelRunRecord } from '~/models/channelRun';
import type { ResponseOwner } from '~/models/response';
import { ALLOCATION_PREFIX, includeManagedAllocations } from '~/utils/managed';
import { managedTargetPredicate, retireManagedAllocation } from './managed';
import { createChannelRunControl } from './channelRunControl';
import { settleAbsentResponseTarget } from './registration';
import { responseScopeKeys } from './responseScope';

interface Metadata {
  _id: Types.ObjectId;
  _managed: ManagedState;
  principal?: ChannelRunRecord['principal'];
  publication?: ChannelRunRecord['publication'];
  userId?: string;
  kind?: 'principal' | 'control';
  __v?: number;
  runId?: string;
  laneId?: string;
}

/** The caller has completed canonical Response owner erasure, not merely requested cancellation.
 * Closed admission plus this update-only publication fence prevents any new execution or payload.
 * Other accounts' published Runs and principal cursors remain owned by their retirement paths. */
export async function eraseOwnedChannelRuns(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  entries: readonly ManagedRegistration[],
  batchSize: number,
): Promise<void> {
  const ownerKey = responseScopeKeys(owner, '')[0];
  const control = createChannelRunControl(mongoose, async () => ({}));
  for (const kind of ['channelRun', 'channelLane'] as const) {
    const model = mongoose.model<Metadata>(kind === 'channelRun' ? 'ChannelRun' : 'ChannelLane');
    async function erase(target: ManagedTarget<typeof kind>) {
      if ((target.tenantId || undefined) !== (owner.tenantId || undefined))
        throw new TypeError('Channel cleanup partition changed');
      const exact = managedTargetPredicate(mongoose, target);
      for (;;) {
        const current = await includeManagedAllocations(model.findOne(exact))
          .select('_id _managed principal publication userId kind __v runId laneId')
          .read('primary')
          .lean<Metadata | null>();
        if (!current) return;
        if (!current._managed?.scopeKeys?.includes(ownerKey))
          throw new Error('Channel cleanup ownership unavailable');
        const placeholder =
          (kind === 'channelRun' ? current.runId : current.laneId) ===
          `${ALLOCATION_PREFIX}${target.id}`;
        if (placeholder) {
          if (await retireManagedAllocation(mongoose, target, target.id)) return;
          continue;
        }
        if (kind === 'channelRun' && current._managed.phase === 'registered') {
          // Private staging has never been eligible for a lease or canonical execution.
          const erased = await model.deleteOne({
            ...exact,
            '_managed.phase': 'registered',
            sequence: 0,
            execution: { $exists: false },
          });
          if (erased.deletedCount) return;
          if (
            await includeManagedAllocations(
              model.exists({ ...exact, '_managed.phase': 'registered' }),
            ).read('primary')
          )
            throw new Error('Invalid staged Run cleanup state');
          continue; // Publication may have won; re-read only this physical target.
        }
        if (!['published', 'retired'].includes(current._managed.phase))
          throw new Error('Channel cleanup publication unavailable');
        if (kind === 'channelLane') {
          if (current.kind !== 'principal' || current.userId !== owner.userId) return;
          await model.deleteOne({ ...exact, kind: 'principal', userId: owner.userId });
          return;
        }
        if (current.principal?.userId !== owner.userId) return;
        if (!current.publication || current._managed.parentId !== target.id)
          throw new Error('Run cleanup publication unavailable');
        if (current._managed.phase === 'published') {
          if (
            typeof current.__v !== 'number' ||
            !Number.isSafeInteger(current.__v) ||
            current.__v < 0 ||
            current.__v >= Number.MAX_SAFE_INTEGER
          )
            throw new Error('Run cleanup version unavailable');
          const sealed = await model.updateOne(
            {
              ...exact,
              '_managed.phase': 'published',
              'principal.userId': owner.userId,
              __v: current.__v,
            },
            { $set: { '_managed.phase': 'retired' }, $inc: { __v: 1 } },
            { upsert: false },
          );
          if (!sealed.matchedCount) continue;
        }
        // Retain the sealed Run until its exact control revision acknowledges retirement.
        // A crash here is recovered from the indexed retired root, never a missing-job guess.
        await control.fenceErasedRun({ ...target, kind: 'channelRun' });
        await model.deleteOne({
          ...exact,
          '_managed.phase': 'retired',
          'principal.userId': owner.userId,
        });
        return;
      }
    }
    for (const entry of entries) {
      if (entry.target.kind !== kind) continue;
      await erase({ ...entry.target, kind });
      await settleAbsentResponseTarget(mongoose, owner, undefined, entry);
    }
    let after: Types.ObjectId | undefined;
    for (;;) {
      const page = await includeManagedAllocations(
        model.find({
          tenantId: owner.tenantId || '_',
          '_managed.scopeKeys': ownerKey,
          ...(after && { _id: { $gt: after } }),
        }),
      )
        .select('_id _managed')
        .sort({ _id: 1 })
        .limit(batchSize)
        .read('primary')
        .lean<Metadata[]>();
      if (!page.length) break;
      for (const row of page)
        await erase({
          kind,
          id: String(row._id),
          incarnation: row._managed.incarnation,
          ...(owner.tenantId && { tenantId: owner.tenantId }),
        });
      after = page[page.length - 1]._id;
    }
  }
}
