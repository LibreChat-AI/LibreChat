import { randomUUID } from 'crypto';
import type { FilterQuery } from 'mongoose';
import type { MediaJobFence, MediaMethods, MediaStoredJob } from '~/types/media';
import type { MediaPersistenceContext } from './context';
import {
  MediaPersistenceError,
  positiveMediaLimit as positive,
  mediaScopeFilter as scopeFilter,
} from '~/utils/media';
import { claimable, durable, mediaDate, terminal } from './scope';
import { jobView } from './views';

export function createMediaJobsMethods({
  Job,
  admitOwnerWork,
  Thread,
  releaseOwnerWork,
  releaseMediaPermits,
  refreshThread,
  stage,
}: Pick<
  MediaPersistenceContext,
  | 'Job'
  | 'admitOwnerWork'
  | 'Thread'
  | 'releaseOwnerWork'
  | 'releaseMediaPermits'
  | 'refreshThread'
  | 'stage'
>): Pick<
  MediaPersistenceContext,
  | 'getJob'
  | 'claimMediaJob'
  | 'renewMediaJob'
  | 'beginMediaSubmission'
  | 'releaseMediaJobLease'
  | 'recordMediaJobObservation'
  | 'cancelMediaJob'
  | 'retryMediaJob'
> {
  const getJob: MediaMethods['getMediaJob'] = async (scope, jobId) =>
    Job.findOne({ ...scopeFilter(scope), jobId }).lean<MediaStoredJob | null>();

  function fenceQuery(input: MediaJobFence, now: Date | string): FilterQuery<MediaStoredJob> {
    return {
      ...scopeFilter(input.scope),
      jobId: input.jobId,
      leaseToken: input.leaseToken,
      version: input.expectedVersion,
      leaseUntil: { $gt: mediaDate(now) },
      'receipt.phase': 'accepted',
    };
  }

  const claimMediaJob: MediaMethods['claimMediaJob'] = async ({
    scope,
    workerId,
    now,
    leaseMs,
    takeoverSkewMs = 0,
  }) => {
    const timestamp = mediaDate(now);
    const job = await Job.findOneAndUpdate(
      {
        ...scopeFilter(scope),
        executionOwner: 'media',
        'receipt.phase': 'accepted',
        phase: { $in: claimable },
        dueAt: { $lte: timestamp },
        $or: [
          { leaseUntil: { $exists: false } },
          {
            leaseUntil: {
              $lte: new Date(timestamp.getTime() - Math.max(0, takeoverSkewMs)),
            },
          },
        ],
      },
      {
        $set: {
          leaseToken: randomUUID(),
          leaseOwner: workerId,
          leaseUntil: new Date(timestamp.getTime() + positive(leaseMs)),
          updatedAt: timestamp,
        },
        $inc: { version: 1 },
      },
      {
        new: true,
        sort: { dueAt: 1, createdAt: 1, jobId: 1 },
        writeConcern: durable,
        timestamps: false,
      },
    ).lean<MediaStoredJob | null>();
    if (job?.phase === 'submitting') {
      // A lease loss is not evidence that the previous process missed the remote call.
      return Job.findOneAndUpdate(
        { ...scope, jobId: job.jobId, leaseToken: job.leaseToken, version: job.version },
        {
          $set: {
            phase: 'reconciling',
            'provider.certainty': job.provider.operationId ? 'submitted' : 'unknown',
          },
          $inc: { version: 1 },
        },
        { new: true, writeConcern: durable, timestamps: false },
      ).lean<MediaStoredJob | null>();
    }
    return job;
  };

  const renewMediaJob: MediaMethods['renewMediaJob'] = async (input) =>
    Job.findOneAndUpdate(
      fenceQuery(input, input.now),
      {
        $set: {
          leaseUntil: new Date(new Date(input.now).getTime() + positive(input.leaseMs)),
          updatedAt: mediaDate(input.now),
        },
        $inc: { version: 1 },
      },
      { new: true, writeConcern: durable, timestamps: false },
    ).lean<MediaStoredJob | null>();

  const beginMediaSubmission: MediaMethods['beginMediaSubmission'] = async (input) => {
    const job = await Job.findOne({
      ...fenceQuery(input, input.now),
      phase: 'queued',
      executionOwner: 'media',
      cancelRequestedAt: { $exists: false },
      'provider.certainty': 'unsubmitted',
    }).lean();
    if (!job) {
      return null;
    }
    if (!(await admitOwnerWork(input.scope, `job:${job.jobId}`))) {
      return null;
    }
    // The thread CAS is the linearization point shared with retirement.
    const grant = await Thread.updateOne(
      {
        ...scopeFilter(input.scope),
        threadId: job.threadId,
        status: 'active',
        epoch: job.threadEpoch,
      },
      { $addToSet: { dispatchJobIds: job.jobId } },
      { writeConcern: durable, timestamps: false },
    );
    if (!grant.matchedCount) {
      return null;
    }
    return Job.findOneAndUpdate(
      {
        ...fenceQuery(input, input.now),
        phase: 'queued',
        cancelRequestedAt: { $exists: false },
        'provider.certainty': 'unsubmitted',
      },
      {
        $set: {
          phase: 'submitting',
          'provider.certainty': 'unknown',
          dispatchGrantedAt: mediaDate(input.now),
          updatedAt: mediaDate(input.now),
        },
        $inc: { version: 1 },
      },
      { new: true, writeConcern: durable, timestamps: false },
    ).lean<MediaStoredJob | null>();
  };

  const releaseMediaJobLease: MediaMethods['releaseMediaJobLease'] = async (input) => {
    const result = await Job.updateOne(
      { ...scopeFilter(input.scope), jobId: input.jobId, leaseToken: input.leaseToken },
      { $unset: { leaseToken: 1, leaseOwner: 1, leaseUntil: 1 }, $inc: { version: 1 } },
      { writeConcern: durable, timestamps: false },
    );
    return result.matchedCount > 0;
  };

  const recordMediaJobObservation: MediaMethods['recordMediaJobObservation'] = async (input) => {
    const before = await Job.findOne(fenceQuery(input, input.now)).lean();
    if (!before || terminal.includes(before.phase)) {
      return null;
    }
    const observation = input.observation;
    const transitions: Record<string, string[]> = {
      queued: ['queued', 'failed', 'cancelled', 'requires_attention'],
      submitting: [
        'running',
        'ingesting',
        'reconciling',
        'requires_attention',
        'failed',
        'cancelled',
      ],
      running: ['running', 'ingesting', 'reconciling', 'requires_attention', 'failed', 'cancelled'],
      ingesting: ['ingesting', 'reconciling', 'requires_attention', 'succeeded', 'failed'],
      reconciling: [
        'running',
        'ingesting',
        'reconciling',
        'requires_attention',
        'succeeded',
        'failed',
        'cancelled',
      ],
    };
    if (!transitions[before.phase]?.includes(observation.phase)) {
      throw new MediaPersistenceError('unsafe_retry', 'Invalid media job phase transition');
    }
    if (observation.phase === 'queued' && before.phase !== 'queued') {
      throw new MediaPersistenceError(
        'unsafe_retry',
        'A provider attempt cannot be submitted again',
      );
    }
    const certainty = observation.provider?.certainty ?? before.provider.certainty;
    const certaintyRank = { unsubmitted: 0, unknown: 1, submitted: 2, terminal: 3 };
    if (certaintyRank[certainty] < certaintyRank[before.provider.certainty]) {
      throw new MediaPersistenceError(
        'unsafe_retry',
        'Provider submission certainty cannot be reversed',
      );
    }
    if (before.provider.certainty !== 'unsubmitted' && certainty === 'unsubmitted') {
      throw new MediaPersistenceError(
        'unsafe_retry',
        'Provider submission certainty cannot be reversed',
      );
    }
    if (terminal.includes(observation.phase) && !['unsubmitted', 'terminal'].includes(certainty)) {
      throw new MediaPersistenceError(
        'unsafe_retry',
        'Unknown provider outcome cannot become safely terminal',
      );
    }
    const isTerminal = terminal.includes(observation.phase);
    const update: Record<string, unknown> = {
      phase: observation.phase,
      updatedAt: mediaDate(input.now),
      ...(observation.provider ? { provider: observation.provider } : {}),
      ...(observation.outputs ? { outputs: observation.outputs } : {}),
      ...(observation.error ? { error: observation.error } : {}),
      ...(observation.dueAt ? { dueAt: mediaDate(observation.dueAt) } : {}),
      ...(observation.recoveryFailures != null
        ? { recoveryFailures: Math.max(0, Math.floor(observation.recoveryFailures)) }
        : {}),
    };
    const unset = {
      ...(isTerminal ? { activeSlot: 1 } : {}),
      ...(isTerminal || observation.releaseLease
        ? { leaseToken: 1, leaseOwner: 1, leaseUntil: 1 }
        : {}),
    };
    const job = await Job.findOneAndUpdate(
      fenceQuery(input, input.now),
      {
        $set: update,
        $inc: { version: 1 },
        ...(Object.keys(unset).length ? { $unset: unset } : {}),
      },
      { new: true, writeConcern: durable, timestamps: false },
    ).lean<MediaStoredJob | null>();
    if (job && isTerminal) {
      await releaseOwnerWork(input.scope, `job:${job.jobId}`);
      await releaseMediaPermits({ scope: input.scope, jobId: job.jobId });
      await Thread.updateOne(
        { ...scopeFilter(input.scope), threadId: job.threadId },
        { $pull: { dispatchJobIds: job.jobId } },
      );
      await refreshThread(input.scope, job.threadId);
    }
    return job;
  };

  const cancelMediaJob: MediaMethods['cancelMediaJob'] = async (
    scope,
    jobId,
    providerApis = [],
  ) => {
    scopeFilter(scope);
    const now = new Date();
    const cancelled = await Job.findOneAndUpdate(
      {
        ...scope,
        jobId,
        executionOwner: 'media',
        phase: 'queued',
        'provider.certainty': 'unsubmitted',
      },
      {
        $set: { phase: 'cancelled', cancelRequestedAt: now, updatedAt: now },
        $unset: { activeSlot: 1, leaseToken: 1, leaseOwner: 1, leaseUntil: 1 },
        $inc: { version: 1 },
      },
      { new: true, writeConcern: durable },
    ).lean<MediaStoredJob | null>();
    if (cancelled) {
      await releaseOwnerWork(scope, `job:${jobId}`);
      if (cancelled.receipt.phase === 'preparing') {
        await Job.updateOne(
          { ...scope, jobId, 'receipt.phase': 'preparing' },
          {
            $set: { 'receipt.phase': 'rejected', 'receipt.error': { code: 'not_ready' } },
            $inc: { version: 1 },
          },
          { writeConcern: durable },
        );
      }
      await releaseMediaPermits({ scope, jobId });
      await Thread.updateOne(
        { ...scope, threadId: cancelled.threadId },
        { $pull: { dispatchJobIds: jobId } },
      );
      await refreshThread(scope, cancelled.threadId);
      return jobView(cancelled);
    }
    if (providerApis.length) {
      await Job.updateOne(
        {
          ...scope,
          jobId,
          executionOwner: 'media',
          phase: { $in: ['running', 'reconciling'] },
          'provider.certainty': 'submitted',
          'provider.operationId': { $exists: true },
          'execution.api': { $in: providerApis },
          'execution.cancellation': { $in: ['best-effort', 'confirmed'] },
          cancelRequestedAt: { $exists: false },
        },
        {
          $set: { cancelRequestedAt: now, dueAt: now, updatedAt: now },
          $inc: { version: 1 },
        },
        { writeConcern: durable },
      );
    }
    const job = await getJob(scope, jobId);
    return job ? jobView(job) : null;
  };

  const retryMediaJob: MediaMethods['retryMediaJob'] = async ({
    scope,
    jobId,
    clientRequestId,
    maxActiveJobs,
    maxPendingTotal,
    execution,
  }) => {
    const job = await getJob(scope, jobId);
    if (!job) {
      throw new MediaPersistenceError('not_found', 'Media job not found');
    }
    if (
      clientRequestId === job.clientRequestId ||
      !jobView(job).allowedActions.retry ||
      job.executionOwner !== 'media'
    ) {
      throw new MediaPersistenceError('unsafe_retry', 'Media job cannot be safely retried');
    }
    return stage(
      {
        scope,
        request: { ...job.request, clientRequestId },
        execution: execution ?? job.execution,
        maxActiveJobs,
        maxPendingTotal,
        executionOwner: 'media',
      },
      job,
    );
  };
  return {
    getJob,
    claimMediaJob,
    renewMediaJob,
    beginMediaSubmission,
    releaseMediaJobLease,
    recordMediaJobObservation,
    cancelMediaJob,
    retryMediaJob,
  };
}
