import type { DurableStorageConfig } from 'librechat-data-provider';
import type { Types } from 'mongoose';
import type { ManagedState, ManagedTargetKind } from '~/types/managed';
import { discardManagedAllocation, retireManagedAllocation, managedTargetModels } from './managed';
import { ALLOCATION_PREFIX, includeManagedAllocations } from '~/utils/managed';
import { runAsSystem, tenantStorage } from '~/config/tenantContext';
import { discardResponseTargetOrphans } from './projection';

interface AllocationMetadata {
  _id: Types.ObjectId;
  tenantId?: string;
  _managed: ManagedState;
}

const kinds = ['response', 'message', 'conversation'] as const;
const identities = { response: 'responseId', message: 'messageId', conversation: 'conversationId' };

/** Share the existing maintenance cadence; each turn advances one bounded physical-key page. */
export function createResponseAllocationReclaimer(
  mongoose: typeof import('mongoose'),
  getConfig: () => Promise<DurableStorageConfig>,
) {
  const cursors: Partial<Record<ManagedTargetKind, string>> = {};
  let nextKind = 0;
  return async (limit: number, activity: { found: boolean }): Promise<number> => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit >= Number.MAX_SAFE_INTEGER)
      throw new TypeError('Invalid allocation maintenance page');
    const kindIndex = nextKind;
    const kind = kinds[kindIndex];
    const field = identities[kind];
    const { allocationGraceMs } = await getConfig();
    // Only allocator metadata crosses system scope, never a request, answer or credential.
    const rows = await runAsSystem(() =>
      includeManagedAllocations(
        mongoose.model<AllocationMetadata>(managedTargetModels[kind]).find({
          [field]: {
            $gt: `${ALLOCATION_PREFIX}${cursors[kind] ?? ''}`,
            $lt: `${ALLOCATION_PREFIX}\uffff`,
          },
          user: { $exists: false },
          ...(kind === 'response' ? { userId: { $exists: false } } : {}),
          createdAt: { $lte: new Date(Math.max(0, Date.now() - allocationGraceMs)) },
          '_managed.phase': {
            $in:
              kind === 'response'
                ? ['empty', 'registered', 'retired']
                : ['empty', 'pinned', 'registering', 'registered', 'retired'],
          },
        }),
      )
        .select({ _id: 1, tenantId: 1, _managed: 1 })
        .sort({ [field]: 1 })
        .limit(limit + 1)
        .read('primary')
        .lean(),
    );
    const page = rows.slice(0, limit);
    if (page.length) activity.found = true;
    let deleted = 0;
    const partitions = new Map<string | undefined, AllocationMetadata[]>();
    for (const row of page) {
      const tenantId = row.tenantId || undefined;
      const partition = partitions.get(tenantId) ?? [];
      partition.push(row);
      partitions.set(tenantId, partition);
    }
    for (const [tenantId, partition] of partitions) {
      await tenantStorage.run({ tenantId }, async () => {
        const orphans: Parameters<typeof discardResponseTargetOrphans>[2] = [];
        for (const row of partition) {
          const target = {
            id: String(row._id),
            incarnation: row._managed.incarnation,
            ...(tenantId ? { tenantId } : {}),
          };
          if (kind === 'response') {
            if (await retireManagedAllocation(mongoose, { ...target, kind }, target.id)) deleted++;
          } else if (['empty', 'retired'].includes(row._managed.phase)) {
            if (await discardManagedAllocation(mongoose, { ...target, kind })) deleted++;
          } else {
            orphans.push({ target: { ...target, kind }, state: row._managed });
          }
        }
        deleted += await discardResponseTargetOrphans(mongoose, tenantId, orphans);
      });
    }
    if (rows.length > limit) cursors[kind] = String(page[page.length - 1]._id);
    else delete cursors[kind];
    nextKind = (kindIndex + 1) % kinds.length;
    return deleted;
  };
}
