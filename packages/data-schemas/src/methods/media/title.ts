import type { MediaTitleMethods } from '~/types/mediaTitle';
import type { MediaStoredJob } from '~/types/media';
import { createMediaJobModel, createMediaThreadModel } from '~/models/media';
import { mediaScopeFilter } from '~/utils/media';
import { durable } from './scope';

/** A durable one-shot claim prevents duplicate paid title calls after concurrent submit or restart. */
export function createMediaTitleMethods(mongoose: typeof import('mongoose')): MediaTitleMethods {
  const Job = createMediaJobModel(mongoose);
  const Thread = createMediaThreadModel(mongoose);

  const claimMediaThreadTitle: MediaTitleMethods['claimMediaThreadTitle'] = async ({
    scope,
    jobId,
    threadId,
    expectedTitle,
  }) => {
    const owner = mediaScopeFilter(scope);
    const job = await Job.findOne({
      ...owner,
      jobId,
      threadId,
      newThread: true,
      executionOwner: 'media',
      phase: { $in: ['queued', 'submitting', 'running', 'ingesting'] },
      'receipt.phase': 'accepted',
      'request.temporary': { $ne: true },
      cancelRequestedAt: null,
    })
      .select('threadEpoch execution accounting')
      .lean<MediaStoredJob>();
    if (!job || (job.execution.accountingMode === 'balance' && job.accounting?.phase !== 'held')) {
      return false;
    }
    const result = await Thread.updateOne(
      {
        ...owner,
        threadId,
        originRequestId: jobId,
        epoch: job.threadEpoch,
        title: expectedTitle,
        status: 'active',
        titleClaim: null,
      },
      { $set: { titleClaim: { jobId, claimedAt: new Date() } } },
      { writeConcern: durable },
    );
    return result.modifiedCount === 1;
  };
  return { claimMediaThreadTitle };
}
