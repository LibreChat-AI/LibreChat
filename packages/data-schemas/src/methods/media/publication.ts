import { randomUUID } from 'crypto';
import type { MediaImportReceipt, MediaSubmissionReceipt } from 'librechat-data-provider';
import type {
  MediaMethods,
  MediaOwnerScope,
  MediaStoredJob,
  MediaStoredThread,
  MediaStoredTurn,
  StageMediaSubmissionInput,
} from '~/types/media';
import type { MediaPersistenceContext } from './context';
import {
  MediaPersistenceError,
  positiveMediaLimit as positive,
  mediaScopeFilter as scopeFilter,
} from '~/utils/media';
import { deriveMediaThreadTitle, digest, duplicate, durable, mediaDate, terminal } from './scope';
import { temporaryExpiry } from './views';

export function createMediaPublicationMethods({
  Thread,
  ensureMediaIndexes,
  activateMedia,
  Job,
  assertOwnerActive,
  Turn,
  acquireMediaPermit,
  getJob,
  File,
  retainMediaThreadAsset,
  admitOwnerWork,
  releaseOwnerWork,
}: Pick<
  MediaPersistenceContext,
  | 'Thread'
  | 'ensureMediaIndexes'
  | 'activateMedia'
  | 'Job'
  | 'assertOwnerActive'
  | 'Turn'
  | 'acquireMediaPermit'
  | 'getJob'
  | 'File'
  | 'retainMediaThreadAsset'
  | 'admitOwnerWork'
  | 'releaseOwnerWork'
>): Pick<
  MediaPersistenceContext,
  | 'stage'
  | 'refreshThread'
  | 'publishMediaSubmission'
  | 'stageMediaImport'
  | 'publishMediaImport'
  | 'recoverMediaPublications'
> {
  async function currentThread(
    scope: MediaOwnerScope,
    threadId?: string,
  ): Promise<MediaStoredThread | null> {
    if (!threadId) {
      return null;
    }
    const thread = await Thread.findOne({ ...scopeFilter(scope), threadId }).lean();
    if (!thread) {
      throw new MediaPersistenceError('not_found', 'Media thread not found');
    }
    if (thread.status !== 'active') {
      throw new MediaPersistenceError('retired', 'Media thread is retired');
    }
    return thread;
  }

  async function stage(
    input: StageMediaSubmissionInput,
    retry?: MediaStoredJob,
  ): Promise<MediaSubmissionReceipt> {
    await ensureMediaIndexes();
    await activateMedia();
    const scope = scopeFilter(input.scope);
    const request = structuredClone(input.request);
    const temporary = retry
      ? (retry.temporary ?? retry.request.temporary ?? false)
      : (input.temporary ?? request.temporary ?? false);
    if (retry) {
      if (retry.request.temporary === undefined) delete request.temporary;
      else request.temporary = retry.request.temporary;
    }
    const publicationExpiresAt = retry ? retry.publicationExpiresAt : input.publicationExpiresAt;
    const fingerprint = digest({ request, temporary, retryOfJobId: retry?.jobId });
    const matches = (stored: MediaStoredJob): boolean => {
      if (stored.fingerprint === fingerprint) return true;
      if (stored.temporary !== undefined || (stored.request.temporary ?? false) !== temporary)
        return false;
      const legacyRequest: MediaStoredJob['request'] = { ...request };
      if (stored.request.temporary === undefined) delete legacyRequest.temporary;
      else legacyRequest.temporary = temporary;
      return stored.fingerprint === digest({ request: legacyRequest, retryOfJobId: retry?.jobId });
    };
    const replay = await Job.findOne({
      ...scope,
      clientRequestId: request.clientRequestId,
    }).lean<MediaStoredJob | null>();
    if (replay) {
      if (!matches(replay)) {
        throw new MediaPersistenceError(
          'conflict',
          'Media request key was used for different content',
        );
      }
      return replay.receipt;
    }
    await assertOwnerActive(scope);
    const thread = await currentThread(scope, retry?.threadId ?? request.threadId);
    if (
      request.parentTurnId &&
      !(await Turn.exists({
        ...scope,
        turnId: request.parentTurnId,
        threadId: thread?.threadId,
        publicationPhase: 'accepted',
      }))
    ) {
      throw new MediaPersistenceError('not_found', 'Media parent turn not found');
    }
    const now = new Date();
    const threadId = thread?.threadId ?? randomUUID();
    const turnId = retry?.turnId ?? randomUUID();
    const jobId = randomUUID();
    const receipt: MediaSubmissionReceipt = {
      schemaVersion: 1,
      clientRequestId: request.clientRequestId,
      threadId,
      turnId,
      jobId,
      phase: 'preparing',
    };
    const record: MediaStoredJob = {
      ...scope,
      schemaVersion: 1,
      jobId,
      threadId,
      turnId,
      clientRequestId: request.clientRequestId,
      fingerprint,
      request,
      execution: structuredClone(input.execution),
      receipt,
      queueCapacity: positive(input.maxPendingTotal),
      newThread: !thread,
      threadEpoch: thread?.epoch ?? 1,
      phase: 'queued',
      executionOwner: 'media',
      temporary,
      provider: { certainty: 'unsubmitted' },
      operation: request.operation,
      selection: request.selection,
      outputs: [],
      allowedActions: { cancel: true, retry: false },
      version: 1,
      createdAt: now,
      updatedAt: now,
      dueAt: now,
      ...(publicationExpiresAt !== undefined
        ? {
            publicationExpiresAt:
              publicationExpiresAt === null ? null : mediaDate(publicationExpiresAt),
          }
        : {}),
      ...(retry ? { retryOfJobId: retry.jobId } : {}),
    };
    const capacity = positive(input.maxActiveJobs);
    const start = parseInt(fingerprint.slice(0, 8), 16) % capacity;
    for (let offset = 0; offset < capacity; offset++) {
      try {
        await new Job({ ...record, activeSlot: (start + offset) % capacity }).save(durable);
        return await admitQueue(record);
      } catch (error) {
        if (!duplicate(error)) {
          throw error;
        }
        const winner = await Job.findOne({
          ...scope,
          clientRequestId: request.clientRequestId,
        }).lean<MediaStoredJob | null>();
        if (winner) {
          if (!matches(winner)) {
            throw new MediaPersistenceError(
              'conflict',
              'Media request key was used for different content',
            );
          }
          return winner.receipt;
        }
      }
    }
    throw new MediaPersistenceError('capacity', 'Media queue capacity reached');
  }

  async function admitQueue(job: MediaStoredJob): Promise<MediaSubmissionReceipt> {
    if (
      await acquireMediaPermit({
        scope: job,
        jobId: job.jobId,
        kind: 'queue',
        capacity: job.queueCapacity,
      })
    ) {
      return job.receipt;
    }
    await Job.updateOne(
      { ...scopeFilter(job), jobId: job.jobId, 'receipt.phase': 'preparing' },
      {
        $set: {
          'receipt.phase': 'rejected',
          'receipt.error': { code: 'quota_exceeded' },
          phase: 'failed',
        },
        $unset: { activeSlot: 1 },
        $inc: { version: 1 },
      },
      { writeConcern: durable },
    );
    return (await getJob(job, job.jobId))!.receipt;
  }

  async function ensureThread(
    turn: MediaStoredTurn,
    title: string,
    expiresAt?: Date,
    temporary = false,
  ): Promise<MediaStoredThread> {
    const scope = scopeFilter(turn);
    if (turn.newThread) {
      await Thread.updateOne(
        { ...scope, threadId: turn.threadId },
        {
          $setOnInsert: {
            ...scope,
            schemaVersion: 1,
            threadId: turn.threadId,
            version: 1,
            title,
            status: 'active',
            epoch: turn.threadEpoch,
            originRequestId: turn.sourceJobId ?? turn.clientRequestId,
            createdAt: turn.createdAt,
            updatedAt: turn.createdAt,
            nextTurnSequence: 0,
            dispatchJobIds: [],
            temporary,
            ...(expiresAt ? { expiresAt } : {}),
          },
        },
        { upsert: true, writeConcern: durable, timestamps: false },
      );
    }
    const thread = await currentThread(scope, turn.threadId);
    if (!thread || thread.epoch !== turn.threadEpoch) {
      throw new MediaPersistenceError('retired', 'Media thread epoch changed');
    }
    return thread;
  }

  /** A pending slot names the turn owning the increment. Every caller can repair it. */
  async function assignSequence(scope: MediaOwnerScope, turnId: string): Promise<void> {
    scope = scopeFilter(scope);
    for (;;) {
      const turn = await Turn.findOne({ ...scopeFilter(scope), turnId }).lean();
      if (!turn || turn.sequence !== undefined) {
        return;
      }
      let thread = await Thread.findOne({ ...scope, threadId: turn.threadId }).lean();
      if (!thread || thread.status !== 'active' || thread.epoch !== turn.threadEpoch) {
        throw new MediaPersistenceError('retired', 'Media thread is retired');
      }
      if (!thread.pendingTurnId) {
        thread = await Thread.findOneAndUpdate(
          {
            ...scope,
            threadId: turn.threadId,
            epoch: turn.threadEpoch,
            status: 'active',
            pendingTurnId: { $exists: false },
          },
          { $set: { pendingTurnId: turnId }, $inc: { nextTurnSequence: 1 } },
          { new: true, writeConcern: durable },
        ).lean();
        if (!thread) {
          continue;
        }
      }
      const pendingId = thread.pendingTurnId;
      const assigned = await Turn.updateOne(
        { ...scope, threadId: turn.threadId, turnId: pendingId, sequence: { $exists: false } },
        { $set: { sequence: thread.nextTurnSequence } },
        { writeConcern: durable },
      );
      // Another publisher may have completed this same turn before we acquired the slot.
      // Its immutable sequence wins; unused counter values are harmless.
      if (
        !assigned.matchedCount &&
        !(await Turn.exists({ ...scope, turnId: pendingId, sequence: { $exists: true } }))
      ) {
        throw new MediaPersistenceError('conflict', 'Media sequence owner is missing');
      }
      await Thread.updateOne(
        {
          ...scope,
          threadId: turn.threadId,
          pendingTurnId: pendingId,
          nextTurnSequence: thread.nextTurnSequence,
        },
        { $unset: { pendingTurnId: 1 } },
        { writeConcern: durable },
      );
    }
  }

  async function pinInputs(turn: MediaStoredTurn, maxRetainers: number): Promise<void> {
    for (const fileId of new Set(turn.inputs.map((item) => item.file_id))) {
      const file = await File.findOne({
        user: turn.ownerId,
        tenantId: turn.tenantId,
        file_id: fileId,
        mediaLifecycle: 'live',
        mediaOutputKey: { $exists: true },
      }).lean();
      if (!file) {
        throw new MediaPersistenceError(
          'invalid_input',
          'Media input requires an owned immutable original',
        );
      }
      // One pin per thread, independent of turn count. Publication and deletion race on this File.
      const retained = await retainMediaThreadAsset({
        scope: scopeFilter(turn),
        fileId,
        threadId: turn.threadId,
        maxRetainers,
      });
      if (!retained) {
        throw new MediaPersistenceError('invalid_input', 'Media input was retired');
      }
    }
  }

  async function publishTurn(
    turn: MediaStoredTurn,
    maxRetainers: number,
    maxTitleChars: number,
    expiresAt?: Date,
    temporary = false,
  ): Promise<void> {
    const title = deriveMediaThreadTitle(turn.importRequest?.title ?? turn.prompt, maxTitleChars);
    await ensureThread(turn, title, expiresAt, temporary);
    await Turn.updateOne(
      { ...scopeFilter(turn), turnId: turn.turnId },
      { $setOnInsert: turn },
      { upsert: true, writeConcern: durable, timestamps: false },
    );
    await assignSequence(turn, turn.turnId);
    await pinInputs(turn, maxRetainers);
    // A retirement after this check is still fenced by dispatch admission and hidden from reads.
    await currentThread(turn, turn.threadId);
  }

  async function refreshThread(scope: MediaOwnerScope, threadId: string): Promise<void> {
    const [turnCount, pendingJobCount] = await Promise.all([
      Turn.countDocuments({ ...scopeFilter(scope), threadId, publicationPhase: 'accepted' }),
      Job.countDocuments({
        ...scopeFilter(scope),
        threadId,
        'receipt.phase': 'accepted',
        phase: { $nin: terminal },
      }),
    ]);
    await Thread.updateOne(
      { ...scope, threadId },
      { $set: { turnCount, pendingJobCount }, $inc: { version: 1 } },
    );
  }

  const publishMediaSubmission: MediaMethods['publishMediaSubmission'] = async (
    scope,
    jobId,
    options,
  ) => {
    const job = await getJob(scope, jobId);
    if (!job || job.receipt.phase !== 'preparing') {
      return job?.receipt ?? null;
    }
    if (terminal.includes(job.phase)) {
      await Job.updateOne(
        { ...scopeFilter(scope), jobId, 'receipt.phase': 'preparing' },
        {
          $set: { 'receipt.phase': 'rejected', 'receipt.error': { code: 'not_ready' } },
          $inc: { version: 1 },
        },
        { writeConcern: durable },
      );
      return (await getJob(scope, jobId))!.receipt;
    }
    const queued = await admitQueue(job);
    if (queued.phase !== 'preparing') {
      return queued;
    }
    const turn: MediaStoredTurn = {
      ...scopeFilter(scope),
      schemaVersion: 1,
      version: 1,
      threadId: job.threadId,
      turnId: job.turnId,
      threadEpoch: job.threadEpoch,
      kind: 'generation',
      createdAt: job.createdAt,
      updatedAt: job.createdAt,
      prompt: job.request.prompt,
      inputs: job.request.inputs,
      selection: job.selection,
      operation: job.operation,
      parentTurnId: job.request.parentTurnId,
      ...(job.request.comparisonId ? { comparisonId: job.request.comparisonId } : {}),
      sourceJobId: job.jobId,
      newThread: job.newThread,
      publicationPhase: 'preparing',
    };
    try {
      if (!(await admitOwnerWork(scope, `job:${jobId}`))) {
        throw new MediaPersistenceError('retired', 'Media account is being deleted');
      }
      await publishTurn(
        turn,
        options.maxRetainers,
        options.maxTitleChars,
        job.publicationExpiresAt === undefined
          ? temporaryExpiry(
              turn,
              job.temporary ?? job.request.temporary,
              options.temporaryRetentionMs,
            )
          : (job.publicationExpiresAt ?? undefined),
        job.temporary ?? job.request.temporary,
      );
      await Turn.updateOne(
        { ...scope, turnId: job.turnId },
        { $set: { publicationPhase: 'accepted' } },
        { writeConcern: durable },
      );
      await Job.updateOne(
        {
          ...scope,
          jobId,
          'receipt.phase': 'preparing',
          phase: 'queued',
          cancelRequestedAt: { $exists: false },
        },
        {
          $set: { 'receipt.phase': 'accepted' },
          $inc: { version: 1 },
        },
        { writeConcern: durable },
      );
      await refreshThread(scope, job.threadId);
    } catch (error) {
      if (
        !(error instanceof MediaPersistenceError) ||
        !['retired', 'invalid_input', 'not_found'].includes(error.code)
      ) {
        throw error;
      }
      await Job.updateOne(
        { ...scope, jobId, 'receipt.phase': 'preparing', phase: 'queued' },
        {
          $set: {
            'receipt.phase': 'rejected',
            'receipt.error': {
              code: error.code === 'invalid_input' ? 'invalid_request' : 'not_found',
            },
            phase: 'failed',
            error: { code: error.code === 'invalid_input' ? 'invalid_request' : 'not_found' },
          },
          $unset: { activeSlot: 1 },
          $inc: { version: 1 },
        },
        { writeConcern: durable },
      );
      await releaseOwnerWork(scope, `job:${jobId}`);
    }
    return (await getJob(scope, jobId))?.receipt ?? null;
  };

  const stageMediaImport: MediaMethods['stageMediaImport'] = async ({
    scope: inputScope,
    request,
    identityRequest,
    publicationExpiresAt,
  }) => {
    await ensureMediaIndexes();
    await activateMedia();
    const scope = scopeFilter(inputScope);
    const fingerprint = digest(identityRequest ?? request);
    const key = { ...scope, kind: 'import', clientRequestId: request.clientRequestId };
    const existing = await Turn.findOne(key).lean();
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new MediaPersistenceError(
          'conflict',
          'Media import key was used for different content',
        );
      }
      return existing.importReceipt!;
    }
    await assertOwnerActive(scope);
    const thread = await currentThread(scope, request.threadId);
    const now = new Date();
    const receipt: MediaImportReceipt = {
      schemaVersion: 1,
      phase: 'preparing',
      clientRequestId: request.clientRequestId,
      threadId: thread?.threadId ?? randomUUID(),
      turnId: randomUUID(),
    };
    try {
      await new Turn({
        ...scope,
        schemaVersion: 1,
        version: 1,
        turnId: receipt.turnId,
        threadId: receipt.threadId,
        threadEpoch: thread?.epoch ?? 1,
        kind: 'import',
        newThread: !thread,
        clientRequestId: request.clientRequestId,
        fingerprint,
        importRequest: structuredClone(request),
        importIdentityRequest: structuredClone(identityRequest ?? request),
        importReceipt: receipt,
        createdAt: now,
        updatedAt: now,
        prompt: '',
        inputs: request.inputs,
        publicationPhase: 'preparing',
        ...(publicationExpiresAt !== undefined
          ? {
              publicationExpiresAt:
                publicationExpiresAt === null ? null : mediaDate(publicationExpiresAt),
            }
          : {}),
      }).save(durable);
      return receipt;
    } catch (error) {
      if (!duplicate(error)) {
        throw error;
      }
      const winner = await Turn.findOne(key).lean();
      if (!winner || winner.fingerprint !== fingerprint) {
        throw new MediaPersistenceError(
          'conflict',
          'Media import key was used for different content',
        );
      }
      return winner.importReceipt!;
    }
  };

  const publishMediaImport: MediaMethods['publishMediaImport'] = async (scope, turnId, options) => {
    const turn = await Turn.findOne({
      ...scopeFilter(scope),
      turnId,
      kind: 'import',
    }).lean<MediaStoredTurn | null>();
    if (!turn?.importReceipt || turn.importReceipt.phase !== 'preparing') {
      return turn?.importReceipt ?? null;
    }
    try {
      if (!(await admitOwnerWork(scope, `import:${turnId}`))) {
        throw new MediaPersistenceError('retired', 'Media account is being deleted');
      }
      await publishTurn(
        turn,
        options.maxRetainers,
        options.maxTitleChars,
        turn.publicationExpiresAt === undefined
          ? temporaryExpiry(turn, turn.importRequest?.temporary, options.temporaryRetentionMs)
          : (turn.publicationExpiresAt ?? undefined),
        turn.importRequest?.temporary,
      );
      await Turn.updateOne(
        { ...scope, turnId, 'importReceipt.phase': 'preparing' },
        {
          $set: {
            publicationPhase: 'accepted',
            'importReceipt.phase': 'accepted',
          },
          $inc: { version: 1 },
        },
        { writeConcern: durable },
      );
      await refreshThread(scope, turn.threadId);
    } catch (error) {
      if (
        !(error instanceof MediaPersistenceError) ||
        !['retired', 'invalid_input', 'not_found'].includes(error.code)
      ) {
        throw error;
      }
      await Turn.updateOne(
        { ...scope, turnId, 'importReceipt.phase': 'preparing' },
        {
          $set: {
            publicationPhase: 'rejected',
            'importReceipt.phase': 'rejected',
            'importReceipt.error': {
              code: error.code === 'invalid_input' ? 'invalid_request' : 'not_found',
            },
          },
          $inc: { version: 1 },
        },
        { writeConcern: durable },
      );
    }
    await releaseOwnerWork(scope, `import:${turnId}`);
    return (await Turn.findOne({ ...scope, turnId }).lean())?.importReceipt ?? null;
  };

  const recoverMediaPublications: MediaMethods['recoverMediaPublications'] = async ({
    scope,
    limit,
    maxRetainers,
    maxTitleChars,
    temporaryRetentionMs,
  }) => {
    positive(limit);
    const [jobs, imports] = await Promise.all([
      Job.find({ ...scopeFilter(scope), 'receipt.phase': 'preparing' })
        .sort({ createdAt: 1 })
        .limit(limit)
        .lean(),
      Turn.find({ ...scopeFilter(scope), kind: 'import', publicationPhase: 'preparing' })
        .sort({ createdAt: 1 })
        .limit(limit)
        .lean(),
    ]);
    await Promise.all(
      jobs.map((job) =>
        publishMediaSubmission(scope, job.jobId, {
          maxRetainers,
          maxTitleChars,
          temporaryRetentionMs,
        }),
      ),
    );
    await Promise.all(
      imports.map((turn) =>
        publishMediaImport(scope, turn.turnId, {
          maxRetainers,
          maxTitleChars,
          temporaryRetentionMs,
        }),
      ),
    );
    return jobs.length + imports.length;
  };
  return {
    stage,
    refreshThread,
    publishMediaSubmission,
    stageMediaImport,
    publishMediaImport,
    recoverMediaPublications,
  };
}
