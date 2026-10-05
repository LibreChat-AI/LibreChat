import { randomUUID } from 'crypto';
import type { FilterQuery } from 'mongoose';
import type { MediaMethods, MediaOwnerScope, MediaStoredJob } from '~/types/media';
import type { MediaPersistenceContext } from './context';
import {
  MediaPersistenceError,
  positiveMediaLimit as positive,
  mediaScopeFilter as scopeFilter,
} from '~/utils/media';
import { SYSTEM_TENANT_ID, runAsSystem, tenantStorage } from '~/config/tenantContext';
import { digest, duplicate, durable, terminal } from './scope';
type PermitRequest = Parameters<MediaMethods['acquireMediaPermit']>[0];

export function createMediaPermitsMethods({
  getJob,
  Permit,
  Job,
  releaseOwnerWork,
}: Pick<MediaPersistenceContext, 'getJob' | 'Permit' | 'Job' | 'releaseOwnerWork'>): Pick<
  MediaPersistenceContext,
  'acquireMediaPermit' | 'acquireMediaPermits' | 'releaseMediaPermits' | 'reconcileMediaPermits'
> {
  /** `permitId` is set only when this call inserted the permit, so a rollback never touches an earlier grant. */
  async function acquirePermit(
    input: PermitRequest,
  ): Promise<{ acquired: boolean; permitId?: string }> {
    const scope = scopeFilter(input.scope);
    positive(input.capacity);
    const job = await getJob(scope, input.jobId);
    if (!job || terminal.includes(job.phase) || job.receipt.phase === 'rejected') {
      return { acquired: false };
    }
    if (input.kind !== 'queue' && job.executionOwner !== 'media') {
      return { acquired: false };
    }
    let capacityIdentity: MediaOwnerScope | string = 'deployment';
    if (input.kind === 'owner') {
      capacityIdentity = scope;
    } else if (input.kind === 'integration') {
      if (!input.key) {
        throw new MediaPersistenceError(
          'invalid_input',
          'Integration capacity requires an identity',
        );
      }
      capacityIdentity = input.key;
    }
    const capacityKey = digest([input.kind, capacityIdentity]);
    const jobIdentity = digest([scope, input.jobId]);
    if (await Permit.exists({ capacityKey, jobIdentity })) {
      return { acquired: true };
    }
    if ((await Permit.countDocuments({ capacityKey })) >= input.capacity) {
      return { acquired: false };
    }
    const start = parseInt(jobIdentity.slice(0, 8), 16) % input.capacity;
    for (let offset = 0; offset < input.capacity; offset++) {
      const permitId = randomUUID();
      try {
        await new Permit({
          ...scope,
          permitId,
          capacityKey,
          kind: input.kind,
          slot: (start + offset) % input.capacity,
          jobId: input.jobId,
          jobIdentity,
          createdAt: new Date(),
        }).save(durable);
        const current = await getJob(scope, input.jobId);
        if (current && !terminal.includes(current.phase)) {
          return { acquired: true, permitId };
        }
        await releaseMediaPermits({ scope, jobId: input.jobId, kind: input.kind });
        return { acquired: false };
      } catch (error) {
        if (!duplicate(error)) {
          throw error;
        }
        if (await Permit.exists({ capacityKey, jobIdentity })) {
          return { acquired: true };
        }
      }
    }
    return { acquired: false };
  }

  const acquireMediaPermit: MediaMethods['acquireMediaPermit'] = async (input) =>
    (await acquirePermit(input)).acquired;

  const acquireMediaPermits: MediaMethods['acquireMediaPermits'] = async ({
    scope: inputScope,
    jobId,
    permits,
  }) => {
    const scope = scopeFilter(inputScope);
    const inserted: string[] = [];
    const rollback = async (): Promise<void> => {
      if (!inserted.length) {
        return;
      }
      await Permit.deleteMany(
        { ...scope, jobId, permitId: { $in: inserted } },
        { writeConcern: durable },
      );
    };
    for (const permit of permits) {
      let result: Awaited<ReturnType<typeof acquirePermit>>;
      try {
        result = await acquirePermit({ scope, jobId, ...permit });
      } catch (error) {
        await rollback();
        throw error;
      }
      if (result.permitId) {
        inserted.push(result.permitId);
      }
      if (!result.acquired) {
        await rollback();
        return false;
      }
    }
    return true;
  };

  const releaseMediaPermits: MediaMethods['releaseMediaPermits'] = async ({
    scope: inputScope,
    jobId,
    kind,
  }) => {
    const scope = scopeFilter(inputScope);
    const job = await getJob(scope, jobId);
    // Worker death, an expired lease, and a cancellation intent never release remote capacity.
    if (
      !job ||
      !terminal.includes(job.phase) ||
      !['unsubmitted', 'terminal'].includes(job.provider.certainty)
    ) {
      return false;
    }
    const permitFilter = { ...scope, jobId, ...(kind ? { kind } : {}) };
    const releasedKinds = await Permit.distinct('kind', permitFilter);
    const released = await Permit.deleteMany(permitFilter, { writeConcern: durable });
    if (released.deletedCount > 0) {
      const now = new Date();
      await runAsSystem(async () => {
        for (const releasedKind of releasedKinds) {
          if (releasedKind === 'queue') continue;
          const capacityFilter: FilterQuery<MediaStoredJob> = {};
          if (releasedKind === 'owner') Object.assign(capacityFilter, scope);
          if (releasedKind === 'integration')
            capacityFilter['execution.connectionId'] = job.execution.connectionId;
          await Job.findOneAndUpdate(
            {
              ...capacityFilter,
              phase: 'queued',
              executionOwner: 'media',
              'receipt.phase': 'accepted',
              'provider.certainty': 'unsubmitted',
              leaseToken: { $exists: false },
              dueAt: { $gt: now },
            },
            { $set: { dueAt: now } },
            { sort: { createdAt: 1, jobId: 1 }, writeConcern: durable },
          );
        }
      });
    }
    await releaseOwnerWork(scope, `job:${jobId}`);
    return true;
  };

  const reconcileMediaPermits: MediaMethods['reconcileMediaPermits'] = async ({
    limit,
    cursor,
  }) => {
    if (tenantStorage.getStore()?.tenantId !== SYSTEM_TENANT_ID) {
      throw new MediaPersistenceError(
        'not_found',
        'System context required for media permit reconciliation',
      );
    }
    positive(limit);
    const rows = await Permit.find(cursor ? { permitId: { $gt: cursor } } : {})
      .sort({ permitId: 1 })
      .limit(limit + 1)
      .lean();
    await Promise.all(
      rows
        .slice(0, limit)
        .map((permit) => releaseMediaPermits({ scope: permit, jobId: permit.jobId })),
    );
    return {
      inspected: Math.min(rows.length, limit),
      ...(rows.length > limit ? { nextCursor: rows[limit - 1].permitId } : {}),
    };
  };
  return {
    acquireMediaPermit,
    acquireMediaPermits,
    releaseMediaPermits,
    reconcileMediaPermits,
  };
}
