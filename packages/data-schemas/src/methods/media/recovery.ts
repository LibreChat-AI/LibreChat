import { createHash } from 'node:crypto';
import type { MediaRecoveryRequest } from 'librechat-data-provider';
import type {
  MediaRecoveryMethods,
  MediaRecoveryRecord,
  MediaRecoveryDecision,
} from '~/types/mediaRecovery';
import type { MediaStoredJob } from '~/types/media';
import { assertMediaTenant as assertTenant, positiveMediaLimit } from '~/utils/media';
import { createMediaJobModel } from '~/models/media';
import { MediaPersistenceError } from './index';
import { durable, cursorParts } from './scope';

function fingerprint(request: MediaRecoveryRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        request.action,
        request.expectedVersion,
        request.evidence,
        request.action === 'settle' ? request.terminalStatus : null,
        request.action === 'settle' ? request.costUSD : null,
      ]),
    )
    .digest('hex');
}
export function createMediaRecoveryMethods(
  mongoose: typeof import('mongoose'),
): MediaRecoveryMethods {
  const Job = createMediaJobModel(mongoose);
  const listMediaRecoveryJobs: MediaRecoveryMethods['listMediaRecoveryJobs'] = async ({
    tenantId,
    limit,
    cursor,
  }) => {
    assertTenant(tenantId);
    positiveMediaLimit(limit);
    const after = cursorParts(cursor);
    const rows = await Job.aggregate<MediaRecoveryRecord>([
      {
        $match: {
          tenantId,
          $and: [
            {
              $or: [
                { phase: 'requires_attention' },
                { phase: 'reconciling', 'recoveryDecisions.0': { $exists: true } },
              ],
            },
            ...(after
              ? [
                  {
                    $or: [
                      { jobId: { $gt: after[0] } },
                      { jobId: after[0], ownerId: { $gt: after[1] } },
                    ],
                  },
                ]
              : []),
          ],
        },
      },
      { $sort: { jobId: 1, ownerId: 1 } },
      { $limit: limit + 1 },
      {
        $project: {
          _id: 0,
          ownerId: 1,
          tenantId: 1,
          jobId: 1,
          threadId: 1,
          version: 1,
          phase: 1,
          executionOwner: 1,
          operation: 1,
          selection: 1,
          createdAt: 1,
          updatedAt: 1,
          error: 1,
          execution: 1,
          accounting: 1,
          provider: {
            certainty: '$provider.certainty',
            operationId: '$provider.operationId',
            requestId: '$provider.requestId',
          },
          hasTerminalRecovery: {
            $and: [
              { $eq: ['$provider.certainty', 'terminal'] },
              {
                $or: [
                  { $isArray: '$provider.recovery.parts' },
                  { $in: ['$provider.recovery.terminalStatus', ['failed', 'cancelled']] },
                ],
              },
            ],
          },
        },
      },
    ]);
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return {
      items,
      ...(rows.length > limit && last
        ? {
            nextCursor: Buffer.from(JSON.stringify([last.jobId, last.ownerId])).toString(
              'base64url',
            ),
          }
        : {}),
    };
  };
  const resolveMediaRecovery: MediaRecoveryMethods['resolveMediaRecovery'] = async (input) => {
    assertTenant(input.scope.tenantId);
    const now = new Date(input.now);
    if (
      !input.scope.ownerId ||
      !input.actorId ||
      !Number.isFinite(now.getTime()) ||
      !Number.isSafeInteger(input.maxEvidenceChars) ||
      input.maxEvidenceChars <= 0 ||
      !Number.isSafeInteger(input.maxDecisions) ||
      input.maxDecisions <= 0
    )
      throw new MediaPersistenceError('invalid_input', 'Invalid media recovery evidence');
    const query = { ...input.scope, jobId: input.jobId };
    const job = await Job.findOne(query).lean<MediaStoredJob | null>();
    if (!job) throw new MediaPersistenceError('not_found', 'Media job is unavailable');
    const identity = fingerprint(input.request);
    const existing = job.recoveryDecisions?.find(
      (decision) => decision.request.clientRequestId === input.request.clientRequestId,
    );
    if (existing) {
      if (existing.fingerprint !== identity)
        throw new MediaPersistenceError('conflict', 'Media recovery request identity changed');
      return job;
    }
    if (!input.request.evidence.trim() || input.request.evidence.length > input.maxEvidenceChars) {
      throw new MediaPersistenceError('invalid_input', 'Invalid media recovery evidence');
    }
    if (job.phase !== 'requires_attention' || job.version !== input.request.expectedVersion)
      throw new MediaPersistenceError('version_conflict', 'Media recovery job changed');
    if ((job.recoveryDecisions?.length ?? 0) >= input.maxDecisions)
      throw new MediaPersistenceError('capacity', 'Media recovery decision capacity reached');
    if ((input.request.action === 'acknowledge') !== (job.executionOwner === 'chat'))
      throw new MediaPersistenceError('invalid_input', 'Unsupported media recovery action');
    if (
      input.request.action === 'settle' &&
      (!Number.isFinite(input.request.costUSD) || input.request.costUSD < 0)
    )
      throw new MediaPersistenceError('invalid_input', 'Final media cost must be explicit');
    if (
      input.request.action === 'resume' &&
      job.provider.certainty !== 'unsubmitted' &&
      !job.provider.operationId &&
      !(job.provider.certainty === 'terminal' && job.provider.recovery)
    )
      throw new MediaPersistenceError(
        'unsafe_retry',
        'No durable provider identity is available for recovery',
      );
    const decision: MediaRecoveryDecision = {
      actorId: input.actorId,
      createdAt: now.toISOString(),
      fingerprint: identity,
      request: structuredClone(input.request),
    };
    const nextPhase =
      input.request.action === 'resume' && job.provider.certainty === 'unsubmitted'
        ? 'queued'
        : 'reconciling';
    const resolved = await Job.findOneAndUpdate(
      {
        ...query,
        phase: 'requires_attention',
        version: input.request.expectedVersion,
        $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: now } }],
      },
      {
        $set: { phase: nextPhase, dueAt: now, updatedAt: now },
        $unset: { leaseToken: 1, leaseOwner: 1, leaseUntil: 1, error: 1 },
        $push: { recoveryDecisions: decision },
        $inc: { version: 1 },
      },
      { new: true, writeConcern: durable },
    ).lean<MediaStoredJob | null>();
    if (resolved) return resolved;
    const winner = await Job.findOne(query).lean<MediaStoredJob | null>();
    if (
      winner?.recoveryDecisions?.some(
        (entry) =>
          entry.request.clientRequestId === input.request.clientRequestId &&
          entry.fingerprint === identity,
      )
    )
      return winner;
    throw new MediaPersistenceError('version_conflict', 'Media recovery job changed');
  };
  return { listMediaRecoveryJobs, resolveMediaRecovery };
}
