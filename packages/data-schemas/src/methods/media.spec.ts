import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  FileSources,
  FileContext,
  mediaAssetSchema,
  mediaImportReceiptSchema,
  mediaSubmissionReceiptSchema,
  mediaJobSchema,
  mediaSubmissionRequestSchema,
  mediaThreadSchema,
  mediaTurnSchema,
} from 'librechat-data-provider';
import type {
  MediaMethods,
  MediaOwnerScope,
  MediaStoredJob,
  StageMediaSubmissionInput,
  MediaAssetContent,
} from '~/types/media';
import { createMediaMethods, deriveMediaThreadTitle } from './media';
import { runAsSystem, tenantStorage } from '~/config/tenantContext';
import { createFileMethods } from './file';
import { digest } from './media/scope';

describe('media persistence on standalone MongoDB', () => {
  let mongo: MongoMemoryServer;
  let methods: MediaMethods;
  let scope: MediaOwnerScope;
  const options = { maxRetainers: 4, maxTitleChars: 20 };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    methods = createMediaMethods(mongoose, { ownerExists: async () => true });
    await methods.ensureMediaIndexes();
  }, 60000);
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });
  beforeEach(async () => {
    await Promise.all(
      Object.values(mongoose.models).map((model) => model.collection.deleteMany({})),
    );
    scope = { ownerId: new mongoose.Types.ObjectId().toString(), tenantId: null };
    methods = createMediaMethods(mongoose, { ownerExists: async () => true });
  });

  function submission(clientRequestId: string, extra = {}): StageMediaSubmissionInput {
    const request = mediaSubmissionRequestSchema.parse({
      clientRequestId,
      operation: 'image.generate',
      prompt: 'A quiet observatory',
      selection: { connectionId: 'images', modelId: 'model-a', catalogVersion: 'v1' },
      ...extra,
    });
    return {
      scope,
      request,
      maxActiveJobs: 10,
      maxPendingTotal: 100,
      execution: {
        ...request.selection,
        api: 'openrouter.images',
        bindingRevision: 'destination-account-v1',
      },
    };
  }
  async function accepted(clientRequestId: string, extra = {}): Promise<MediaStoredJob> {
    const receipt = await methods.stageMediaSubmission(submission(clientRequestId, extra));
    const published = await methods.publishMediaSubmission(scope, receipt.jobId, options);
    expect(published?.phase).toBe('accepted');
    return (await methods.getMediaJob(scope, receipt.jobId))!;
  }

  async function markLegacyChatJob(jobId: string) {
    // Existing chat records remain readable; production no longer stages this ownership lane.
    await mongoose.models.MediaJob.updateOne(
      { ...scope, jobId },
      { $set: { executionOwner: 'chat' }, $unset: { activeSlot: 1 } },
    );
  }

  it('scopes provider diagnostics to the owner, tenant and active published thread', async () => {
    const job = await accepted('diagnostics');
    expect(await methods.getMediaJobDiagnostics(scope, job.jobId)).toEqual({});
    const diagnostic = { status: 400, code: 'INVALID_ARGUMENT', message: 'Unsupported input.' };
    await mongoose.models.MediaJob.updateOne(
      { ...scope, jobId: job.jobId },
      { $set: { 'provider.recovery.diagnostic': diagnostic } },
    );
    expect(await methods.getMediaJobDiagnostics(scope, job.jobId)).toEqual({ diagnostic });
    const view = await methods.getMediaJobView(scope, job.jobId);
    expect(mediaJobSchema.safeParse(view).success).toBe(true);
    expect(view).not.toHaveProperty('provider');
    expect(view).not.toHaveProperty('diagnostic');
    expect(
      await methods.getMediaJobDiagnostics(
        { ...scope, ownerId: new mongoose.Types.ObjectId().toString() },
        job.jobId,
      ),
    ).toBeNull();
    expect(
      await methods.getMediaJobDiagnostics({ ...scope, tenantId: 'foreign' }, job.jobId),
    ).toBeNull();
    const unpublished = await methods.stageMediaSubmission(submission('unpublished-diagnostics'));
    expect(await methods.getMediaJobDiagnostics(scope, unpublished.jobId)).toBeNull();
    await methods.retireMediaThread(scope, job.threadId);
    expect(await methods.getMediaJobDiagnostics(scope, job.jobId)).toBeNull();
  });

  it('stores BSON lifecycle dates and omits the platform tenant while preserving ISO views', async () => {
    const job = await accepted('stored-dates');
    const now = new Date(Date.now() + 1000);
    await methods.claimMediaJob({
      scope,
      workerId: 'date-worker',
      now: now.toISOString(),
      leaseMs: 60000,
    });
    const raw = await mongoose.models.MediaJob.collection.findOne({ jobId: job.jobId });
    expect(raw).toMatchObject({
      createdAt: expect.any(Date),
      updatedAt: now,
      dueAt: expect.any(Date),
      leaseUntil: new Date(now.getTime() + 60000),
    });
    expect(raw).not.toHaveProperty('tenantId');
    for (const name of ['MediaOwner', 'MediaThread', 'MediaTurn']) {
      const row = await mongoose.models[name].collection.findOne({ ownerId: scope.ownerId });
      expect(row?.updatedAt).toBeInstanceOf(Date);
      expect(row).not.toHaveProperty('tenantId');
    }
    const [thread] = (await methods.listMediaThreads({ scope, limit: 10 })).items;
    expect(typeof thread.createdAt).toBe('string');
    expect(mediaThreadSchema.safeParse(thread).success).toBe(true);
    const turns = await methods.listMediaTurns({
      scope,
      threadId: job.threadId,
      limit: 10,
      jobsPerTurn: 10,
    });
    expect(typeof turns.items[0].createdAt).toBe('string');
    expect(typeof turns.items[0].jobs[0].updatedAt).toBe('string');
    // Null remains an exact default-tenant fence and continues to read historical null rows.
    await mongoose.models.MediaJob.collection.updateOne(
      { jobId: job.jobId },
      { $set: { tenantId: null } },
    );
    expect(await methods.getMediaJob(scope, job.jobId)).not.toBeNull();
    expect(await methods.getMediaJob({ ...scope, tenantId: 'foreign' }, job.jobId)).toBeNull();
  });

  it('converts existing string lifecycle fields without rewriting provider envelopes', async () => {
    const job = await accepted('date-upgrade');
    const past = new Date(Date.now() - 60000);
    await mongoose.models.MediaJob.collection.updateOne(
      { jobId: job.jobId },
      {
        $set: {
          createdAt: past.toISOString(),
          updatedAt: past.toISOString(),
          dueAt: past.toISOString(),
          nativeSource: { expiresAt: past.toISOString() },
        },
      },
    );
    await mongoose.models.MediaThread.collection.updateOne(
      { threadId: job.threadId },
      {
        $set: { expiresAt: past.toISOString(), 'titleClaim.claimedAt': past.toISOString() },
      },
    );
    await mongoose.models.File.collection.insertOne({
      file_id: 'legacy-unlink',
      mediaUnlinkedAt: 'thread:legacy:1',
    });
    await createMediaMethods(mongoose, { ownerExists: async () => true }).ensureMediaIndexes();
    const row = await mongoose.models.MediaJob.collection.findOne({ jobId: job.jobId });
    expect(row).toMatchObject({
      createdAt: past,
      updatedAt: past,
      dueAt: past,
      nativeSource: { expiresAt: past.toISOString() },
    });
    expect((await methods.getMediaThread(scope, job.threadId))?.expiresAt).toBe(past.toISOString());
    expect(
      await mongoose.models.File.collection.findOne({ file_id: 'legacy-unlink' }),
    ).toMatchObject({ mediaUnlinkedBy: 'thread:legacy:1' });
    expect(await methods.retireExpiredMediaThreads({ scope, limit: 10, now: new Date() })).toBe(1);
  });

  it('measures queued age and active execution including ambiguous provider work', async () => {
    const queued = await accepted('metric-queued');
    const running = await accepted('metric-running');
    const uncertain = await accepted('metric-uncertain');
    const native = await accepted('metric-native');
    await mongoose.models.MediaJob.collection.updateOne(
      { jobId: queued.jobId },
      { $set: { createdAt: new Date(Date.now() - 5000) } },
    );
    await mongoose.models.MediaJob.updateOne(
      { jobId: running.jobId },
      { $set: { phase: 'running', cancelRequestedAt: new Date() } },
    );
    await mongoose.models.MediaJob.updateOne(
      { jobId: uncertain.jobId },
      { $set: { phase: 'reconciling', 'provider.certainty': 'unknown' } },
    );
    await mongoose.models.MediaJob.updateOne(
      { jobId: native.jobId },
      { $set: { executionOwner: 'chat', phase: 'running' } },
    );
    const metrics = await runAsSystem(() => methods.getMediaBacklogMetrics());
    expect(metrics).toMatchObject({ queued: 1, activeJobs: 2 });
    expect(metrics.oldestQueuedAgeSeconds).toBeGreaterThanOrEqual(5);
    await methods.cancelMediaJob(scope, queued.jobId);
    expect(await runAsSystem(() => methods.getMediaBacklogMetrics())).toMatchObject({
      queued: 0,
      oldestQueuedAgeSeconds: 0,
    });
  });

  it('searches literal titles across pages while keeping tenant, owner and lifecycle fences', async () => {
    const wanted = await accepted('literal', { prompt: 'A [star] appears' });
    await accepted('plain', { prompt: 'Another star appears' });
    for (const include of [undefined, 'activity'] as const) {
      const page = await methods.listMediaThreads({ scope, limit: 1, search: '[STAR]', include });
      expect(page.items.map((thread) => thread.threadId)).toEqual([wanted.threadId]);
      expect(
        await methods.listMediaThreads({
          scope: { ...scope, tenantId: 'other' },
          limit: 1,
          search: '[star]',
          include,
        }),
      ).toEqual({ items: [] });
      expect(
        await methods.listMediaThreads({
          scope: { ...scope, ownerId: new mongoose.Types.ObjectId().toString() },
          limit: 1,
          search: '[star]',
          include,
        }),
      ).toEqual({ items: [] });
    }
    await methods.retireMediaThread(scope, wanted.threadId);
    expect((await methods.listMediaThreads({ scope, limit: 1, search: '[star]' })).items).toEqual(
      [],
    );
  });

  it('clears the owner library through retirement without deleting another tenant or later creation', async () => {
    const first = await accepted('clear-first');
    const second = await accepted('clear-second');
    const foreign = await methods.stageMediaSubmission({
      ...submission('foreign'),
      scope: { ...scope, tenantId: 'other' },
    });
    await methods.publishMediaSubmission({ ...scope, tenantId: 'other' }, foreign.jobId, options);
    expect(await methods.retireAllMediaThreads(scope)).toBe(2);
    expect((await methods.listMediaThreads({ scope, limit: 10 })).items).toEqual([]);
    expect((await methods.getMediaJob(scope, first.jobId))?.phase).toBe('cancelled');
    expect((await methods.getMediaJob(scope, second.jobId))?.phase).toBe('cancelled');
    expect((await methods.getMediaJob({ ...scope, tenantId: 'other' }, foreign.jobId))?.phase).toBe(
      'queued',
    );
    const later = await accepted('after-clear');
    expect(
      (await methods.listMediaThreads({ scope, limit: 10 })).items.map((thread) => thread.threadId),
    ).toEqual([later.threadId]);
  });

  it('fences takeover until both the lease and configured clock-skew margin expire', async () => {
    const queued = await accepted('skew-margin');
    const now = Date.now();
    const first = await methods.claimMediaJob({
      scope,
      workerId: 'first',
      now: new Date(now).toISOString(),
      leaseMs: 60_000,
    });
    expect(first?.jobId).toBe(queued.jobId);
    expect(
      await methods.claimMediaJob({
        scope,
        workerId: 'early',
        now: new Date(now + 65_000).toISOString(),
        leaseMs: 60_000,
        takeoverSkewMs: 30_000,
      }),
    ).toBeNull();
    expect(
      await methods.claimMediaJob({
        scope,
        workerId: 'replacement',
        now: new Date(now + 90_001).toISOString(),
        leaseMs: 60_000,
        takeoverSkewMs: 30_000,
      }),
    ).toMatchObject({ jobId: queued.jobId, leaseOwner: 'replacement' });
  });

  it('wakes an older capacity-deferred job when a terminal job releases permits', async () => {
    const active = await accepted('capacity-holder');
    const waiting = await accepted('capacity-waiter');
    expect(
      await methods.acquireMediaPermit({ scope, jobId: active.jobId, kind: 'owner', capacity: 1 }),
    ).toBe(true);
    await mongoose.models.MediaJob.updateOne(
      { jobId: waiting.jobId },
      { $set: { dueAt: new Date(Date.now() + 60_000).toISOString() } },
    );
    await methods.cancelMediaJob(scope, active.jobId);
    const woken = await methods.getMediaJob(scope, waiting.jobId);
    expect(woken!.dueAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(
      await methods.claimMediaJob({
        scope,
        workerId: 'next',
        now: new Date().toISOString(),
        leaseMs: 60_000,
      }),
    ).toMatchObject({ jobId: waiting.jobId });
  });

  it('bounds creation titles without truncating prompts or changing replay identity', async () => {
    const prompt = 'A🌲 in a quiet forest at dawn';
    const input = submission('bounded-title', { prompt });
    const receipt = await methods.stageMediaSubmission(input);
    await methods.publishMediaSubmission(scope, receipt.jobId, { ...options, maxTitleChars: 2 });
    expect((await methods.getMediaThread(scope, receipt.threadId))?.title).toBe('A');
    expect((await methods.getMediaJob(scope, receipt.jobId))?.request.prompt).toBe(prompt);
    expect(
      (
        await methods.listMediaTurns({
          scope,
          threadId: receipt.threadId,
          limit: 10,
          jobsPerTurn: 10,
        })
      ).items[0].prompt,
    ).toBe(prompt);
    expect((await methods.stageMediaSubmission(input)).jobId).toBe(receipt.jobId);
  });

  it('replaces a prompt-derived title once and never after the owner renames the thread', async () => {
    const job = await accepted('generated-title');
    const before = (await methods.getMediaThread(scope, job.threadId))!;
    expect(before.title).toBe(deriveMediaThreadTitle('A quiet observatory', options.maxTitleChars));
    expect(
      await methods.replaceMediaThreadTitle({
        scope,
        threadId: job.threadId,
        expectedTitle: before.title,
        title: 'Quiet Observatory',
      }),
    ).toBe(true);
    const generated = (await methods.getMediaThread(scope, job.threadId))!;
    expect(generated.title).toBe('Quiet Observatory');
    expect(generated.version).toBe(before.version + 1);
    expect(generated.updatedAt >= before.updatedAt).toBe(true);
    await methods.updateMediaThread({
      scope,
      threadId: job.threadId,
      expectedVersion: generated.version,
      title: 'My observatory',
    });
    expect(
      await methods.replaceMediaThreadTitle({
        scope,
        threadId: job.threadId,
        expectedTitle: 'Quiet Observatory',
        title: 'Late Generated Title',
      }),
    ).toBe(false);
    expect((await methods.getMediaThread(scope, job.threadId))?.title).toBe('My observatory');
    expect(
      await methods.replaceMediaThreadTitle({
        scope,
        threadId: 'missing-thread',
        expectedTitle: 'anything',
        title: 'Generated',
      }),
    ).toBe(false);
    expect(
      await methods.replaceMediaThreadTitle({
        scope: { ...scope, ownerId: new mongoose.Types.ObjectId().toString() },
        threadId: job.threadId,
        expectedTitle: 'My observatory',
        title: 'Stolen',
      }),
    ).toBe(false);
  });

  it('applies configured title bounds while recovering a preparing submission', async () => {
    const prompt = 'My long observatory prompt';
    const receipt = await methods.stageMediaSubmission(submission('recover-title', { prompt }));
    await methods.recoverMediaPublications({ scope, limit: 10, ...options, maxTitleChars: 7 });
    expect((await methods.getMediaThread(scope, receipt.threadId))?.title).toBe('My long');
    expect((await methods.getMediaJob(scope, receipt.jobId))?.request.prompt).toBe(prompt);
  });
  async function original(outputKey = 'upload:original', type = 'image/png') {
    const write = await methods.reserveMediaAssetWrite({
      scope,
      outputKey,
      rendition: 'original',
      ingestToken: 'ingest-a',
      fingerprint: 'bytes-digest',
      storageKey: `images/${scope.ownerId}/${outputKey}.png`,
    });
    const content = {
      file_id: write.fileId,
      filename: 'original.png',
      type,
      bytes: 32,
      filepath: `/${write.storageKey}`,
      source: 'local',
      storageKey: write.storageKey,
      contentDigest: 'bytes-digest',
    };
    const asset = await methods.commitMediaAssetWrite({ scope, writeId: write.writeId, content });
    return { write, content, asset };
  }

  it.each([
    ['upload:reference', 'image/png', FileContext.message_attachment],
    ['capture:reference', 'video/mp4', FileContext.message_attachment],
    ['job:generated-image', 'image/png', FileContext.image_generation],
    ['job:generated-video', 'video/mp4', FileContext.video_generation],
  ])('labels the Files entry for %s', async (outputKey, type, context) => {
    const { asset } = await original(outputKey, type);
    expect(await mongoose.models.File.findOne({ file_id: asset!.file_id }).lean()).toMatchObject({
      context,
    });
  });
  function fence(job: MediaStoredJob, now: string) {
    return {
      scope,
      jobId: job.jobId,
      leaseToken: job.leaseToken!,
      expectedVersion: job.version,
      now,
    };
  }

  it('publishes one linked job for simultaneous replay and rejects a changed request', async () => {
    const input = submission('same-key');
    const receipts = await Promise.all(
      Array.from({ length: 8 }, () => methods.stageMediaSubmission(input)),
    );
    expect(new Set(receipts.map((item) => item.jobId)).size).toBe(1);
    expect(receipts.every((item) => item.phase === 'preparing')).toBe(true);
    expect(
      await methods.claimMediaJob({
        scope,
        workerId: 'w',
        now: new Date().toISOString(),
        leaseMs: 10000,
      }),
    ).toBeNull();
    await expect(
      methods.stageMediaSubmission(submission('same-key', { prompt: 'Different' })),
    ).rejects.toMatchObject({ code: 'conflict' });
    const results = await Promise.all(
      receipts.map((item) => methods.publishMediaSubmission(scope, item.jobId, options)),
    );
    results.forEach((item) =>
      expect(mediaSubmissionReceiptSchema.parse(item).phase).toBe('accepted'),
    );
    expect(await mongoose.models.MediaThread.countDocuments()).toBe(1);
    expect(await mongoose.models.MediaTurn.countDocuments()).toBe(1);
    expect(await mongoose.models.MediaJob.countDocuments()).toBe(1);
  });

  it('repairs a staged command with a fresh repository after process loss', async () => {
    const receipt = await methods.stageMediaSubmission(submission('crash-before-links'));
    methods = createMediaMethods(mongoose, { ownerExists: async () => true });
    expect(await methods.recoverMediaPublications({ scope, limit: 10, ...options })).toBe(1);
    expect(await methods.getMediaSubmission(scope, 'crash-before-links')).toMatchObject({
      ...receipt,
      phase: 'accepted',
    });
    expect(
      (
        await methods.listMediaTurns({
          scope,
          threadId: receipt.threadId,
          limit: 10,
          jobsPerTurn: 10,
        })
      ).items,
    ).toHaveLength(1);
  });

  it('repairs the sequence owner before assigning a parallel turn', async () => {
    const first = await accepted('first');
    const staged = await methods.stageMediaSubmission(
      submission('second', { threadId: first.threadId }),
    );
    const job = (await methods.getMediaJob(scope, staged.jobId))!;
    await mongoose.models.MediaTurn.create({
      ...scope,
      schemaVersion: 1,
      version: 1,
      threadId: job.threadId,
      turnId: job.turnId,
      threadEpoch: 1,
      kind: 'generation',
      createdAt: job.createdAt,
      updatedAt: job.createdAt,
      prompt: job.request.prompt,
      inputs: [],
      sourceJobId: job.jobId,
      newThread: false,
      publicationPhase: 'preparing',
    });
    await mongoose.models.MediaThread.updateOne(
      { threadId: first.threadId },
      { $set: { pendingTurnId: job.turnId }, $inc: { nextTurnSequence: 1 } },
    );
    const third = await accepted('third', { threadId: first.threadId });
    await methods.publishMediaSubmission(scope, staged.jobId, options);
    const turns = await methods.listMediaTurns({
      scope,
      threadId: third.threadId,
      limit: 10,
      jobsPerTurn: 10,
    });
    expect(turns.items.map((turn) => turn.sequence)).toEqual([3, 2, 1]);
  });

  it('enforces queue capacity with an index across independent repositories', async () => {
    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        createMediaMethods(mongoose, { ownerExists: async () => true }).stageMediaSubmission({
          ...submission(`capacity-${index}`),
          maxActiveJobs: 2,
        }),
      ),
    );
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(2);
    expect(await mongoose.models.MediaJob.countDocuments()).toBe(2);
  });

  it('isolates owner and tenant reads, commands, and tenant contexts', async () => {
    const job = await accepted('private');
    const stranger = { ...scope, ownerId: new mongoose.Types.ObjectId().toString() };
    expect(await methods.getMediaJob(stranger, job.jobId)).toBeNull();
    expect(await methods.getMediaSubmission({ ...scope, tenantId: 'other' }, 'private')).toBeNull();
    expect(await methods.cancelMediaJob(stranger, job.jobId)).toBeNull();
    expect(await methods.retireMediaThread(stranger, job.threadId)).toBe(false);
    await expect(
      tenantStorage.run({ tenantId: 'other' }, async () => methods.getMediaJob(scope, job.jobId)),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('has authoritative import receipts without any provider job', async () => {
    const { asset } = await original();
    const [second, retired, foreignOwner, foreignTenant] = await Promise.all(
      ['second', 'retired', 'foreign-owner', 'foreign-tenant'].map((key) => original(key)),
    );
    const request = {
      schemaVersion: 1 as const,
      clientRequestId: 'import-1',
      inputs: [second.asset, retired.asset, asset, foreignOwner.asset, foreignTenant.asset].map(
        (file) => ({ role: 'reference' as const, file_id: file.file_id }),
      ),
    };
    const receipts = await Promise.all([
      methods.stageMediaImport({ scope, request }),
      methods.stageMediaImport({ scope, request }),
    ]);
    expect(receipts[0]).toEqual(receipts[1]);
    const published = await methods.publishMediaImport(scope, receipts[0].turnId, options);
    expect(mediaImportReceiptSchema.parse(published).phase).toBe('accepted');
    expect(await mongoose.models.MediaJob.countDocuments()).toBe(0);
    expect(
      await methods.claimMediaAssetDeletion({ scope, fileId: asset.file_id, token: 'delete' }),
    ).toBeNull();
    await Promise.all([
      mongoose.models.File.collection.updateOne(
        { file_id: retired.asset.file_id },
        { $set: { mediaLifecycle: 'retiring' } },
      ),
      mongoose.models.File.collection.updateOne(
        { file_id: foreignOwner.asset.file_id },
        { $set: { user: new mongoose.Types.ObjectId() } },
      ),
      mongoose.models.File.collection.updateOne(
        { file_id: foreignTenant.asset.file_id },
        { $set: { tenantId: 'foreign' } },
      ),
    ]);
    const turns = await methods.listMediaTurns({
      scope,
      threadId: receipts[0].threadId,
      limit: 10,
      jobsPerTurn: 2,
    });
    expect(turns.items[0].assets).toEqual([second.asset, asset]);
    expect(turns.items[0].inputs).toEqual(request.inputs);
    expect(turns.items[0].jobs).toEqual([]);
    // Import and generation request identifiers intentionally have separate namespaces.
    expect((await methods.stageMediaSubmission(submission('import-1'))).phase).toBe('preparing');
  });

  it('bounds recovered import titles while preserving the original import request', async () => {
    const { asset } = await original();
    const request = {
      schemaVersion: 1 as const,
      clientRequestId: 'import-title',
      title: 'Imported reference set',
      inputs: [{ role: 'reference' as const, file_id: asset.file_id }],
    };
    const receipt = await methods.stageMediaImport({ scope, request });
    await methods.recoverMediaPublications({ scope, limit: 10, ...options, maxTitleChars: 8 });
    expect((await methods.getMediaThread(scope, receipt.threadId))?.title).toBe('Imported');
    expect((await methods.stageMediaImport({ scope, request })).turnId).toBe(receipt.turnId);
  });

  it.each([false, true])(
    'preserves an import temporary flag of %s independently of retention',
    async (temporary) => {
      const { asset } = await original();
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      const receipt = await methods.stageMediaImport({
        scope,
        request: {
          schemaVersion: 1,
          clientRequestId: 'import-retention',
          temporary,
          inputs: [{ role: 'reference', file_id: asset.file_id }],
        },
        publicationExpiresAt: expiresAt,
      });
      await methods.publishMediaImport(scope, receipt.turnId, options);
      expect(await methods.getMediaThread(scope, receipt.threadId)).toMatchObject({
        temporary,
        expiresAt,
      });
      for (const include of [undefined, 'activity'] as const) {
        const listed = await methods.listMediaThreads({ scope, limit: 10, include });
        expect(listed.items.map((thread) => thread.threadId)).toEqual(
          temporary ? [] : [receipt.threadId],
        );
      }
    },
  );

  it('rejects an import of someone else’s original without publishing a job', async () => {
    const { asset } = await original();
    const other = { ...scope, ownerId: new mongoose.Types.ObjectId().toString() };
    const receipt = await methods.stageMediaImport({
      scope: other,
      request: {
        schemaVersion: 1,
        clientRequestId: 'foreign',
        inputs: [{ role: 'reference', file_id: asset.file_id }],
      },
    });
    expect(await methods.publishMediaImport(other, receipt.turnId, options)).toMatchObject({
      phase: 'rejected',
      error: { code: 'invalid_request' },
    });
    expect(await mongoose.models.MediaJob.countDocuments()).toBe(0);
  });

  it('releases an owned lease immediately without releasing a replacement worker lease', async () => {
    const job = await accepted('release-lease');
    const now = new Date().toISOString();
    const first = (await methods.claimMediaJob({
      scope,
      workerId: 'first',
      now,
      leaseMs: 10_000,
    }))!;
    const lease = { scope, jobId: job.jobId, leaseToken: first.leaseToken! };
    expect(await methods.releaseMediaJobLease({ ...lease, leaseToken: 'wrong-token' })).toBe(false);
    expect(await methods.releaseMediaJobLease(lease)).toBe(true);
    const second = (await methods.claimMediaJob({
      scope,
      workerId: 'second',
      now,
      leaseMs: 10_000,
    }))!;
    expect(second).toMatchObject({ jobId: job.jobId, phase: 'queued', leaseOwner: 'second' });
    expect(await methods.releaseMediaJobLease(lease)).toBe(false);
    expect(await methods.getMediaJob(scope, job.jobId)).toMatchObject({
      leaseToken: second.leaseToken,
      leaseOwner: 'second',
    });
  });

  it('allows only one claim and fences stale writes after takeover', async () => {
    const job = await accepted('claim');
    const now = new Date(Date.now() + 1000).toISOString();
    const claims = await Promise.all(
      ['one', 'two'].map((workerId) =>
        methods.claimMediaJob({ scope, workerId, now, leaseMs: 1000 }),
      ),
    );
    const claimed = claims.find((item) => item !== null)!;
    expect(claims.filter(Boolean)).toHaveLength(1);
    const begun = (await methods.beginMediaSubmission(fence(claimed, now)))!;
    expect(begun.phase).toBe('submitting');
    const later = new Date(new Date(now).getTime() + 2000).toISOString();
    const takeover = (await methods.claimMediaJob({
      scope,
      workerId: 'restart',
      now: later,
      leaseMs: 1000,
    }))!;
    expect(takeover).toMatchObject({
      jobId: job.jobId,
      phase: 'reconciling',
      provider: { certainty: 'unknown' },
    });
    expect(
      await methods.recordMediaJobObservation({
        ...fence(begun, later),
        observation: {
          phase: 'succeeded',
          provider: { certainty: 'terminal' },
        },
      }),
    ).toBeNull();
    await expect(
      methods.recordMediaJobObservation({
        ...fence(takeover, later),
        observation: { phase: 'queued' },
      }),
    ).rejects.toMatchObject({ code: 'unsafe_retry' });
    await expect(
      methods.retryMediaJob({
        scope,
        jobId: job.jobId,
        clientRequestId: 'unsafe',
        maxActiveJobs: 10,
        maxPendingTotal: 100,
      }),
    ).rejects.toMatchObject({ code: 'unsafe_retry' });
  });

  it('keeps dispatched work unchanged when cancellation loses admission', async () => {
    await accepted('cancel-submitted');
    const now = new Date(Date.now() + 1000).toISOString();
    const claim = (await methods.claimMediaJob({ scope, workerId: 'one', now, leaseMs: 10000 }))!;
    const begun = (await methods.beginMediaSubmission(fence(claim, now)))!;
    const result = await methods.cancelMediaJob(scope, begun.jobId);
    expect(result).toMatchObject({
      phase: 'submitting',
      version: begun.version,
      allowedActions: { cancel: false, retry: false },
    });
    expect(await methods.getMediaJob(scope, begun.jobId)).toEqual(begun);
  });

  it('cancels claimed queued work once and fences off later dispatch', async () => {
    await accepted('cancel-claimed');
    const now = new Date(Date.now() + 1000).toISOString();
    const claim = (await methods.claimMediaJob({ scope, workerId: 'one', now, leaseMs: 10000 }))!;
    const cancelled = await methods.cancelMediaJob(scope, claim.jobId);
    expect(cancelled).toMatchObject({
      phase: 'cancelled',
      allowedActions: { cancel: false, retry: true },
    });
    expect(await methods.beginMediaSubmission(fence(claim, now))).toBeNull();
    expect(await methods.cancelMediaJob(scope, claim.jobId)).toEqual(cancelled);
    expect((await methods.getMediaThread(scope, claim.threadId))?.pendingJobCount).toBe(0);
  });

  it('records accepted-provider intent once without releasing its lease, capacity, or owner fence', async () => {
    const input = submission('cancel-remote');
    input.execution = { ...input.execution, api: 'krea.images', cancellation: 'best-effort' };
    const receipt = await methods.stageMediaSubmission(input);
    await methods.publishMediaSubmission(scope, receipt.jobId, options);
    const now = new Date(Date.now() + 1000).toISOString();
    const claim = (await methods.claimMediaJob({ scope, workerId: 'one', now, leaseMs: 10000 }))!;
    const begun = (await methods.beginMediaSubmission(fence(claim, now)))!;
    const running = (await methods.recordMediaJobObservation({
      ...fence(begun, now),
      observation: { phase: 'running', provider: { certainty: 'submitted', operationId: 'owned' } },
    }))!;
    expect((await methods.getMediaJobView(scope, running.jobId))?.allowedActions.cancel).toBe(true);
    expect(
      (await methods.cancelMediaJob(scope, running.jobId, ['runway.videos']))?.cancellation,
    ).toBeUndefined();
    expect(
      await methods.cancelMediaJob(
        { ...scope, ownerId: new mongoose.Types.ObjectId().toString() },
        running.jobId,
        ['krea.images'],
      ),
    ).toBeNull();
    const beforePermits = await mongoose.models.MediaPermit.countDocuments({
      jobId: running.jobId,
    });
    const beforeOwner = await mongoose.models.MediaOwner.findOne(scope).lean();
    const requested = await methods.cancelMediaJob(scope, running.jobId, ['krea.images']);
    expect(requested).toMatchObject({
      phase: 'running',
      version: running.version + 1,
      cancellation: 'requested',
      allowedActions: { cancel: false, retry: false },
    });
    expect(await methods.cancelMediaJob(scope, running.jobId, ['krea.images'])).toEqual(requested);
    expect(await methods.getMediaJob(scope, running.jobId)).toMatchObject({
      leaseToken: running.leaseToken,
      leaseUntil: running.leaseUntil,
      provider: running.provider,
    });
    expect(await mongoose.models.MediaPermit.countDocuments({ jobId: running.jobId })).toBe(
      beforePermits,
    );
    expect(await mongoose.models.MediaOwner.findOne(scope).lean()).toEqual(beforeOwner);
    expect((await methods.getMediaThread(scope, running.threadId))?.pendingJobCount).toBe(1);
    expect(
      await methods.recordMediaJobObservation({
        ...fence(running, now),
        observation: { phase: 'running' },
      }),
    ).toBeNull();
  });

  it('keeps legacy accepted snapshots without verified cancellation queued-only', async () => {
    const input = submission('cancel-legacy');
    input.execution.api = 'krea.images';
    const receipt = await methods.stageMediaSubmission(input);
    await methods.publishMediaSubmission(scope, receipt.jobId, options);
    const now = new Date(Date.now() + 1000).toISOString();
    const claim = (await methods.claimMediaJob({ scope, workerId: 'one', now, leaseMs: 10000 }))!;
    const begun = (await methods.beginMediaSubmission(fence(claim, now)))!;
    const running = (await methods.recordMediaJobObservation({
      ...fence(begun, now),
      observation: { phase: 'running', provider: { certainty: 'submitted', operationId: 'owned' } },
    }))!;
    expect(await methods.cancelMediaJob(scope, running.jobId, ['krea.images'])).toMatchObject({
      phase: 'running',
      version: running.version,
      allowedActions: { cancel: false, retry: false },
    });
    expect(await methods.getMediaJob(scope, running.jobId)).toEqual(running);
  });

  it('leaves chat-owned work to its own cancellation protocol', async () => {
    const receipt = await methods.stageMediaSubmission(submission('cancel-native'));
    await methods.publishMediaSubmission(scope, receipt.jobId, options);
    await markLegacyChatJob(receipt.jobId);
    const before = await methods.getMediaJob(scope, receipt.jobId);
    expect(await methods.cancelMediaJob(scope, receipt.jobId)).toMatchObject({
      phase: 'queued',
      executionOwner: 'chat',
      allowedActions: { cancel: false, retry: false },
    });
    expect(await methods.getMediaJob(scope, receipt.jobId)).toEqual(before);
  });

  it('explicit safe retry creates a new job under the immutable turn', async () => {
    const job = await accepted('cancel-queued');
    await methods.cancelMediaJob(scope, job.jobId);
    const receipt = await methods.retryMediaJob({
      scope,
      jobId: job.jobId,
      clientRequestId: 'retry',
      maxActiveJobs: 10,
      maxPendingTotal: 100,
    });
    expect(receipt.turnId).toBe(job.turnId);
    expect(receipt.jobId).not.toBe(job.jobId);
    await methods.publishMediaSubmission(scope, receipt.jobId, options);
    expect((await methods.getMediaJob(scope, job.jobId))?.phase).toBe('cancelled');
    expect((await methods.getMediaJob(scope, receipt.jobId))?.retryOfJobId).toBe(job.jobId);
    expect(await mongoose.models.MediaTurn.countDocuments()).toBe(1);
  });

  it('retries under a fresh execution snapshot instead of copying the failed one', async () => {
    const job = await accepted('retry-execution');
    await methods.cancelMediaJob(scope, job.jobId);
    const execution = { ...job.execution, connectionId: 'images-b', bindingRevision: 'v2' };
    const receipt = await methods.retryMediaJob({
      scope,
      jobId: job.jobId,
      clientRequestId: 'retry-fresh',
      maxActiveJobs: 10,
      maxPendingTotal: 100,
      execution,
    });
    expect((await methods.getMediaJob(scope, receipt.jobId))?.execution).toEqual(execution);
    expect((await methods.getMediaJob(scope, job.jobId))?.execution).toEqual(job.execution);
  });

  it('prevents dispatch after thread retirement and never recreates the identity', async () => {
    const job = await accepted('retire');
    const now = new Date(Date.now() + 1000).toISOString();
    const claim = (await methods.claimMediaJob({ scope, workerId: 'one', now, leaseMs: 10000 }))!;
    await methods.retireMediaThread(scope, job.threadId);
    expect(await methods.beginMediaSubmission(fence(claim, now))).toBeNull();
    expect(await methods.getMediaThread(scope, job.threadId)).toBeNull();
    await expect(
      methods.stageMediaSubmission(submission('late', { threadId: job.threadId })),
    ).rejects.toMatchObject({ code: 'retired' });
    expect(await mongoose.models.MediaThread.countDocuments()).toBe(1);
  });

  it('never claims a native chat-owned job for paid execution', async () => {
    const receipt = await methods.stageMediaSubmission(submission('native'));
    await methods.publishMediaSubmission(scope, receipt.jobId, options);
    await markLegacyChatJob(receipt.jobId);
    expect(
      await methods.claimMediaJob({
        scope,
        workerId: 'one',
        now: new Date(Date.now() + 1000).toISOString(),
        leaseMs: 10000,
      }),
    ).toBeNull();
  });

  it('returns public snapshots without credentials, provider recovery URLs, or owner fields', async () => {
    const job = await accepted('public');
    const view = await methods.getMediaJobView(scope, job.jobId);
    expect(mediaJobSchema.parse(view)).toEqual(view);
    expect(view).not.toHaveProperty('ownerId');
    expect(view).not.toHaveProperty('execution');
    expect(view).not.toHaveProperty('provider');
  });

  it('paginates stable turn creation order while jobs complete independently', async () => {
    const first = await accepted('ordered');
    await Promise.all(
      ['parallel-a', 'parallel-b', 'parallel-c'].map((key) =>
        accepted(key, { threadId: first.threadId, parentTurnId: first.turnId }),
      ),
    );
    const one = await methods.listMediaTurns({
      scope,
      threadId: first.threadId,
      limit: 2,
      jobsPerTurn: 2,
    });
    const two = await methods.listMediaTurns({
      scope,
      threadId: first.threadId,
      limit: 2,
      jobsPerTurn: 2,
      cursor: one.nextCursor,
    });
    expect([...one.items, ...two.items].map((turn) => turn.sequence)).toEqual([4, 3, 2, 1]);
    expect(two.nextCursor).toBeUndefined();
  });

  it('bounds joined jobs per turn before materializing the page and isolates colliding scopes', async () => {
    const first = await accepted('bounded-first');
    const newest = await accepted('bounded-newest', {
      threadId: first.threadId,
      parameters: { count: 2 },
    });
    const retries = Array.from({ length: 8 }, (_, index) => {
      const jobId = `retry-0${index}`;
      const job = {
        ...newest,
        _id: new mongoose.Types.ObjectId(),
        jobId,
        clientRequestId: jobId,
        retryOfJobId: newest.jobId,
        phase: 'cancelled',
        createdAt: new Date(newest.createdAt.getTime() + 1_000),
        cancelRequestedAt: newest.createdAt,
        execution: { ...newest.execution, cancellation: 'confirmed' },
        provider: {
          certainty: 'terminal',
          recovery: {
            terminalStatus: 'cancelled',
            parts: [{ kind: 'text', ordinal: 0, text: 'Private continuation' }],
          },
        },
        receipt: { ...newest.receipt, jobId },
      };
      delete job.activeSlot;
      return job;
    });
    const foreignScopes = [
      { ...scope, ownerId: new mongoose.Types.ObjectId().toString() },
      { ...scope, tenantId: 'foreign' },
    ];
    await mongoose.models.MediaJob.collection.insertMany([
      ...retries,
      ...foreignScopes.map((foreignScope) => ({
        ...retries[0],
        ...foreignScope,
        _id: new mongoose.Types.ObjectId(),
        createdAt: new Date(0),
      })),
      {
        ...retries[0],
        _id: new mongoose.Types.ObjectId(),
        jobId: 'unpublished',
        clientRequestId: 'unpublished',
        createdAt: new Date(0),
        receipt: { ...newest.receipt, phase: 'preparing' },
      },
    ]);
    const storedTurn = await mongoose.models.MediaTurn.findOne({ turnId: newest.turnId }).lean();
    await mongoose.models.MediaTurn.collection.insertMany([
      ...foreignScopes.map((foreignScope) => ({
        ...storedTurn,
        ...foreignScope,
        _id: new mongoose.Types.ObjectId(),
        sequence: 99,
      })),
      {
        ...storedTurn,
        _id: new mongoose.Types.ObjectId(),
        turnId: 'unpublished',
        sequence: 99,
        publicationPhase: 'preparing',
      },
    ]);
    const aggregate = jest.spyOn(mongoose.models.MediaTurn, 'aggregate');
    const input = { scope, threadId: first.threadId, limit: 1, jobsPerTurn: 2 };
    const page = await methods.listMediaTurns(input);
    const pipeline = aggregate.mock.calls[0][0]!;
    aggregate.mockRestore();
    const materialized = await mongoose.models.MediaTurn.aggregate<{
      turnId: string;
      job?: MediaStoredJob;
    }>(pipeline);
    expect(materialized.map((turn) => [turn.turnId, turn.job?.jobId])).toEqual([
      [newest.turnId, newest.jobId],
      [newest.turnId, retries[0].jobId],
      [newest.turnId, retries[1].jobId],
      [first.turnId, first.jobId],
    ]);
    expect(materialized[1].job).not.toHaveProperty('provider.recovery.parts');
    expect(page.items[0].parameters).toEqual({ count: 2 });
    expect(page.items[0].jobs).toEqual(
      await Promise.all(
        [newest.jobId, retries[0].jobId].map((id) => methods.getMediaJobView(scope, id)),
      ),
    );
    const nextJobs = await methods.listMediaTurnJobs({
      scope,
      turnId: newest.turnId,
      limit: 10,
      cursor: page.items[0].jobsNextCursor,
    });
    expect(nextJobs.items.map((job) => job.jobId)).toEqual(
      retries.slice(1).map((job) => job.jobId),
    );
    expect(nextJobs.nextCursor).toBeUndefined();
    const nextTurns = await methods.listMediaTurns({ ...input, cursor: page.nextCursor });
    expect(nextTurns.items.map((turn) => turn.turnId)).toEqual([first.turnId]);
    expect(nextTurns.nextCursor).toBeUndefined();
    await methods.retireMediaThread(scope, first.threadId);
    expect(await methods.listMediaTurns(input)).toEqual({ items: [] });
  });

  it('lists individually valid jobs whose combined public outputs exceed one BSON document', async () => {
    const older = await accepted('large-older');
    const first = await accepted('large-turn', { threadId: older.threadId });
    await mongoose.models.MediaJob.updateOne(
      { jobId: first.jobId },
      { $set: { phase: 'failed', 'provider.certainty': 'terminal' }, $unset: { activeSlot: 1 } },
    );
    const text = 'x'.repeat(900_000);
    const outputs = Array.from({ length: 4 }, (_, ordinal) => ({
      kind: 'text',
      outputId: `text-${ordinal}`,
      ordinal,
      text,
    }));
    const retries = Array.from({ length: 5 }, (_, index) => {
      const jobId = `large-retry-${index}`;
      const job = {
        ...first,
        _id: new mongoose.Types.ObjectId(),
        jobId,
        clientRequestId: jobId,
        retryOfJobId: first.jobId,
        createdAt: new Date(first.createdAt.getTime() + index + 1),
        phase: 'failed',
        provider: { certainty: 'terminal' },
        receipt: { ...first.receipt, jobId },
        outputs,
      };
      delete job.activeSlot;
      return job;
    });
    await mongoose.models.MediaJob.collection.insertMany(retries);
    const page = await methods.listMediaTurns({
      scope,
      threadId: first.threadId,
      limit: 1,
      jobsPerTurn: 6,
    });
    expect(page.items[0].jobs.map((job) => job.jobId)).toEqual([
      first.jobId,
      ...retries.map((job) => job.jobId),
    ]);
    for (const job of page.items[0].jobs.slice(1)) expect(job.outputs).toEqual(outputs);
    expect(
      page.items[0].jobs.reduce(
        (bytes, job) =>
          bytes +
          job.outputs.reduce(
            (total, output) => total + (output.kind === 'text' ? output.text.length : 0),
            0,
          ),
        0,
      ),
    ).toBe(18_000_000);
    expect(page.items[0].jobsNextCursor).toBeUndefined();
    const next = await methods.listMediaTurns({
      scope,
      threadId: first.threadId,
      limit: 1,
      jobsPerTurn: 6,
      cursor: page.nextCursor,
    });
    expect(next.items.map((turn) => turn.turnId)).toEqual([older.turnId]);
    expect(next.items[0].jobs.map((job) => job.jobId)).toEqual([older.jobId]);
    expect(next.nextCursor).toBeUndefined();
  });

  it('discovers restart work only through an explicit bounded system scan', async () => {
    await methods.stageMediaSubmission(submission('due'));
    await expect(
      methods.listDueMediaScopes({ now: new Date().toISOString(), limit: 1 }),
    ).rejects.toMatchObject({ code: 'not_found' });
    const result = await runAsSystem(async () =>
      methods.listDueMediaScopes({ now: new Date().toISOString(), limit: 1 }),
    );
    expect(result.items).toEqual([scope]);
  });

  it('replays immutable asset publication and detects changed bytes', async () => {
    const { write, content, asset } = await original();
    expect(await methods.commitMediaAssetWrite({ scope, writeId: write.writeId, content })).toEqual(
      asset,
    );
    await expect(
      methods.commitMediaAssetWrite({
        scope,
        writeId: write.writeId,
        content: { ...content, contentDigest: 'changed' },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await mongoose.models.File.countDocuments()).toBe(1);
    expect(await methods.getMediaAssetContent(scope, asset.file_id)).toMatchObject({
      storageKey: write.storageKey,
      contentDigest: content.contentDigest,
    });
  });

  it('omits unset dimensions when publishing and reading a video original', async () => {
    const write = await methods.reserveMediaAssetWrite({
      scope,
      outputKey: 'video-original',
      rendition: 'original',
      ingestToken: 'video-ingest',
      fingerprint: 'video-digest',
      storageKey: `images/${scope.ownerId}/original.mp4`,
    });
    const asset = await methods.commitMediaAssetWrite({
      scope,
      writeId: write.writeId,
      content: {
        file_id: write.fileId,
        filename: 'original.mp4',
        type: 'video/mp4',
        width: undefined,
        height: undefined,
        bytes: 32,
        filepath: `/${write.storageKey}`,
        source: 'local',
        storageKey: write.storageKey,
        contentDigest: 'video-digest',
      },
    });
    expect(mediaAssetSchema.parse(asset)).toMatchObject({ type: 'video/mp4', bytes: 32 });
    expect(asset).not.toHaveProperty('width');
    expect(asset).not.toHaveProperty('height');
    expect(mediaAssetSchema.parse(await methods.getMediaAsset(scope, asset.file_id))).toEqual(
      asset,
    );
  });

  it('freezes cloud locations while allowing refreshed URLs and publishes sidecars without leaking storage metadata', async () => {
    const planned = {
      scope,
      outputKey: 'cloud-image',
      rendition: 'original',
      ingestToken: 'cloud-ingest',
      fingerprint: 'cloud-digest',
      source: FileSources.s3 as const,
      storageKey: `images/${scope.ownerId}/cloud.png`,
      storageRegion: 'us-east-1',
      filepath: 'https://storage.test/original?signature=before',
      renditionLocations: [
        {
          kind: 'thumbnail' as const,
          source: FileSources.s3 as const,
          storageKey: `images/${scope.ownerId}/thumbnail.png`,
          storageRegion: 'us-east-1',
          filepath: 'https://storage.test/thumbnail?signature=before',
        },
      ],
    };
    const write = await methods.reserveMediaAssetWrite(planned);
    expect(
      (
        await methods.reserveMediaAssetWrite({
          ...planned,
          filepath: 'https://storage.test/original?signature=after',
        })
      ).writeId,
    ).toBe(write.writeId);
    for (const changed of [
      { source: FileSources.firebase as const },
      { storageRegion: 'us-west-2' },
      { storageKey: 'different-key' },
    ]) {
      await expect(
        methods.reserveMediaAssetWrite({ ...planned, ...changed }),
      ).rejects.toMatchObject({ code: 'conflict' });
    }
    const content: MediaAssetContent = {
      file_id: write.fileId,
      filename: 'original.png',
      type: 'image/png',
      bytes: 32,
      source: FileSources.s3,
      storageKey: planned.storageKey,
      storageRegion: planned.storageRegion,
      filepath: 'https://storage.test/original?signature=after',
      contentDigest: 'original-digest',
      mediaRenditions: {
        thumbnail: {
          source: FileSources.s3,
          storageKey: planned.renditionLocations[0].storageKey,
          storageRegion: 'us-east-1',
          filepath: 'https://storage.test/thumbnail?signature=after',
          type: 'image/png',
          bytes: 12,
          width: 16,
          height: 8,
          contentDigest: 'thumbnail-digest',
        },
      },
    };
    await expect(
      methods.commitMediaAssetWrite({
        scope,
        writeId: write.writeId,
        content: {
          ...content,
          mediaRenditions: {
            thumbnail: { ...content.mediaRenditions!.thumbnail!, storageKey: 'unplanned-key' },
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const asset = await methods.commitMediaAssetWrite({ scope, writeId: write.writeId, content });
    expect(asset.filepath).toBe(`/api/media/assets/${asset.file_id}/content`);
    expect(asset.renditions?.thumbnail).toEqual({
      filepath: `/api/media/assets/${asset.file_id}/content?rendition=thumbnail`,
      type: 'image/png',
      bytes: 12,
      width: 16,
      height: 8,
    });
    expect(asset).not.toHaveProperty('storageKey');
    expect(asset).not.toHaveProperty('mediaRenditions');
    expect(await methods.getMediaAssetContent(scope, asset.file_id)).toMatchObject(content);
    expect(
      await methods.claimMediaAssetWriteDeletion({
        scope,
        writeId: write.writeId,
        token: 'cleanup',
        staleBefore: new Date().toISOString(),
      }),
    ).toBeNull();
    expect(
      await methods.claimMediaAssetDeletion({ scope, fileId: asset.file_id, token: 'cleanup' }),
    ).toMatchObject(content);
  });

  it('returns the original and planned sidecar cloud locations when an upload is abandoned', async () => {
    const write = await methods.reserveMediaAssetWrite({
      scope,
      outputKey: 'abandoned-cloud',
      rendition: 'original',
      ingestToken: 'abandoned-ingest',
      fingerprint: 'abandoned-digest',
      source: FileSources.azure_blob,
      storageKey: `images/${scope.ownerId}/original.mp4`,
      filepath: 'https://storage.test/files/original.mp4',
      renditionLocations: [
        {
          kind: 'poster',
          source: FileSources.azure_blob,
          storageKey: `images/${scope.ownerId}/poster.png`,
          filepath: 'https://storage.test/files/poster.png',
        },
      ],
    });
    const claimed = await methods.claimMediaAssetWriteDeletion({
      scope,
      writeId: write.writeId,
      token: 'cleanup',
      staleBefore: new Date(Date.now() + 1000).toISOString(),
    });
    expect(claimed).toMatchObject({
      source: FileSources.azure_blob,
      storageKey: write.storageKey,
      filepath: write.filepath,
      renditionLocations: write.renditionLocations,
    });
    expect(
      await methods.completeMediaAssetWriteDeletion({
        scope,
        writeId: write.writeId,
        token: 'cleanup',
      }),
    ).toBe(true);
  });

  it('does not let a canonical local object prevent cleaning the same key on a different backend', async () => {
    const { write: local } = await original('same-path');
    await mongoose.models.MediaAssetWrite.deleteOne({ writeId: local.writeId });
    const cloud = await methods.reserveMediaAssetWrite({
      scope,
      outputKey: 'different-backend',
      rendition: 'original',
      ingestToken: 'different-ingest',
      fingerprint: 'different-digest',
      source: FileSources.s3,
      storageKey: local.storageKey,
    });
    expect(
      await methods.claimMediaAssetWriteDeletion({
        scope,
        writeId: cloud.writeId,
        token: 'cleanup',
        staleBefore: new Date(Date.now() + 1000).toISOString(),
      }),
    ).toMatchObject({ source: FileSources.s3, storageKey: local.storageKey });
    expect(await methods.getMediaAssetContent(scope, local.fileId)).not.toBeNull();
  });

  it('normalizes unset dimensions in previously stored output and cover snapshots', async () => {
    const { asset } = await original();
    const job = await accepted('legacy-video', { operation: 'video.generate' });
    const legacyAsset = {
      ...asset,
      type: 'video/mp4',
      width: null,
      height: null,
      durationSeconds: null,
    };
    await mongoose.models.MediaJob.updateOne(
      { jobId: job.jobId },
      {
        $set: {
          phase: 'succeeded',
          outputs: [
            {
              kind: 'video',
              outputId: 'video-output',
              ordinal: 0,
              state: 'ready',
              asset: legacyAsset,
            },
          ],
        },
      },
    );
    await mongoose.models.MediaThread.updateOne(
      { threadId: job.threadId },
      { $set: { cover: legacyAsset } },
    );
    const detail = mediaJobSchema.parse(await methods.getMediaJobView(scope, job.jobId));
    expect(detail.outputs[0]).toMatchObject({ kind: 'video', asset: { type: 'video/mp4' } });
    expect(detail.outputs[0]).not.toHaveProperty('asset.width');
    const jobs = await methods.listMediaTurnJobs({ scope, turnId: job.turnId, limit: 10 });
    expect(mediaJobSchema.parse(jobs.items[0])).toEqual(detail);
    const turns = await methods.listMediaTurns({
      scope,
      threadId: job.threadId,
      limit: 10,
      jobsPerTurn: 10,
    });
    expect(mediaJobSchema.parse(turns.items[0].jobs[0])).toEqual(detail);
    const thread = mediaThreadSchema.parse(await methods.getMediaThread(scope, job.threadId));
    expect(thread.cover).not.toHaveProperty('height');
    expect(thread.cover).not.toHaveProperty('durationSeconds');
    const threads = await methods.listMediaThreads({ scope, limit: 10 });
    expect(mediaThreadSchema.parse(threads.items[0])).toEqual(thread);
  });

  it('shows a gallery original and model before opening its thread, without changing legacy views', async () => {
    const { asset } = await original();
    const job = await accepted('unopened-gemini', {
      selection: { connectionId: 'router', modelId: 'google/gemini-image', catalogVersion: 'v1' },
    });
    await mongoose.models.MediaJob.updateOne(
      { jobId: job.jobId },
      {
        $set: {
          phase: 'succeeded',
          outputs: [
            { kind: 'text', outputId: 'caption', ordinal: 0, text: 'Here is your image' },
            { kind: 'image', outputId: 'image', ordinal: 1, state: 'ready', asset },
          ],
        },
      },
    );
    const legacy = (await methods.listMediaThreads({ scope, limit: 10 })).items[0];
    expect(legacy.cover).toBeUndefined();
    expect(legacy.activity).toBeUndefined();
    const result = await methods.listMediaThreads({ scope, limit: 10, include: 'activity' });
    const thread = mediaThreadSchema.parse(result.items[0]);
    expect(thread).toMatchObject({
      cover: asset,
      pendingJobCount: 0,
      activity: { readyOutputs: 1, latestJob: { phase: 'succeeded', selection: job.selection } },
    });
    expect(thread.version).toBe(legacy.version);
    expect(thread).not.toHaveProperty('ownerId');
    expect(thread.activity?.latestJob).not.toHaveProperty('execution');
    const stored = await mongoose.models.MediaThread.findOne({ threadId: job.threadId }).lean();
    expect(stored).toMatchObject({ threadId: job.threadId });
    expect(stored).not.toHaveProperty('cover');
  });

  it.each(['image', 'video'] as const)(
    'updates the default %s cover to the latest result while preserving explicit covers',
    async (kind) => {
      const type = kind === 'image' ? 'image/png' : 'video/mp4';
      const first = await accepted('first-cover', { operation: `${kind}.generate` });
      const initial = (await original('initial-cover', type)).asset;
      const latest = (await original('latest-cover', type)).asset;
      const complete = (job: MediaStoredJob, asset: typeof initial) =>
        mongoose.models.MediaJob.updateOne(
          { jobId: job.jobId },
          {
            $set: {
              phase: 'succeeded',
              outputs: [{ kind, outputId: job.jobId, ordinal: 0, state: 'ready', asset }],
            },
          },
        );
      await complete(first, initial);
      expect((await methods.getMediaThread(scope, first.threadId))?.cover).toEqual(initial);
      const second = await accepted('second-cover', {
        operation: `${kind}.generate`,
        threadId: first.threadId,
      });
      const gallery = async () =>
        (await methods.listMediaThreads({ scope, limit: 10, include: 'activity' })).items[0];
      // Keep the last usable result while a follow-up is running.
      expect((await gallery()).cover).toEqual(initial);
      await complete(second, latest);
      // A stored default from an older server must not hide the latest result in history.
      expect((await gallery()).cover).toEqual(latest);
      const restored = (await methods.getMediaThread(scope, first.threadId))!;
      expect(restored.cover).toEqual(latest);
      expect(await methods.getMediaThread(scope, first.threadId)).toEqual(restored);
      // An older job completing later must not replace the newer generation's cover.
      await complete(first, initial);
      expect((await gallery()).cover).toEqual(latest);
      expect((await methods.getMediaThread(scope, first.threadId))?.cover).toEqual(latest);
      await methods.retainMediaThreadAsset({
        scope,
        threadId: first.threadId,
        fileId: initial.file_id,
        maxRetainers: options.maxRetainers,
      });
      const current = (await methods.getMediaThread(scope, first.threadId))!;
      await methods.updateMediaThread({
        scope,
        threadId: first.threadId,
        expectedVersion: current.version,
        coverFileId: initial.file_id,
      });
      expect((await gallery()).cover).toEqual(initial);
      expect((await methods.getMediaThread(scope, first.threadId))?.cover).toEqual(initial);
    },
  );

  it('filters and paginates gallery results by saved output instead of treating failures as completed', async () => {
    const { asset } = await original();
    const ready = await accepted('ready-gallery');
    const failed = await accepted('failed-gallery');
    const pending = await accepted('pending-gallery');
    await mongoose.models.MediaJob.updateOne(
      { jobId: ready.jobId },
      {
        $set: {
          phase: 'succeeded',
          outputs: [{ kind: 'image', outputId: 'ready', ordinal: 0, state: 'ready', asset }],
        },
      },
    );
    await mongoose.models.MediaJob.updateOne(
      { jobId: failed.jobId },
      { $set: { phase: 'failed' } },
    );
    const completed = await methods.listMediaThreads({
      scope,
      limit: 1,
      include: 'activity',
      filter: 'completed',
    });
    expect(completed.items.map((thread) => thread.threadId)).toEqual([ready.threadId]);
    expect(completed.nextCursor).toBeUndefined();
    const running = await methods.listMediaThreads({
      scope,
      limit: 1,
      include: 'activity',
      filter: 'pending',
    });
    expect(running.items.map((thread) => thread.threadId)).toEqual([pending.threadId]);
    const first = await methods.listMediaThreads({ scope, limit: 2, include: 'activity' });
    const second = await methods.listMediaThreads({
      scope,
      limit: 2,
      include: 'activity',
      cursor: first.nextCursor,
    });
    expect(new Set([...first.items, ...second.items].map((thread) => thread.threadId)).size).toBe(
      3,
    );
    expect(second.nextCursor).toBeUndefined();
  });

  it('keeps explicit gallery covers cleared and excludes other owners and tenants from activity', async () => {
    const { asset } = await original();
    const job = await accepted('private-gallery');
    await mongoose.models.MediaThread.updateOne(
      { threadId: job.threadId },
      { $set: { coverExplicit: true } },
    );
    await mongoose.models.MediaJob.updateOne(
      { jobId: job.jobId },
      {
        $set: {
          phase: 'succeeded',
          outputs: [{ kind: 'image', outputId: 'own', ordinal: 0, state: 'ready', asset }],
        },
      },
    );
    const row = await mongoose.models.MediaJob.findOne({ jobId: job.jobId }).lean();
    for (const other of [
      { ownerId: new mongoose.Types.ObjectId().toString() },
      { tenantId: 'another-tenant' },
    ]) {
      await mongoose.models.MediaJob.collection.insertOne({
        ...row,
        ...other,
        _id: new mongoose.Types.ObjectId(),
        jobId: new mongoose.Types.ObjectId().toString(),
        phase: 'running',
        createdAt: '2099-01-01T00:00:00.000Z',
      });
    }
    const thread = (await methods.listMediaThreads({ scope, limit: 10, include: 'activity' }))
      .items[0];
    expect(thread.cover).toBeUndefined();
    expect(thread).toMatchObject({
      pendingJobCount: 0,
      activity: { readyOutputs: 1, latestJob: { phase: 'succeeded' } },
    });
  });

  it('linearizes save versus retirement on the File document', async () => {
    const { asset } = await original();
    const [saved, deletion] = await Promise.all([
      methods.retainMediaAsset({
        scope,
        fileId: asset.file_id,
        retainer: 'library',
        maxRetainers: 2,
      }),
      methods.claimMediaAssetDeletion({ scope, fileId: asset.file_id, token: 'delete' }),
    ]);
    expect(Number(saved) + Number(deletion !== null)).toBe(1);
    if (deletion) {
      expect(
        await methods.completeMediaAssetDeletion({ scope, fileId: asset.file_id, token: 'wrong' }),
      ).toBe(false);
      expect(
        await methods.completeMediaAssetDeletion({ scope, fileId: asset.file_id, token: 'delete' }),
      ).toBe(true);
      expect(await methods.getMediaAsset(scope, asset.file_id)).toBeNull();
    }
  });

  it('bounds retainers and keeps live originals out of legacy deletion and retention', async () => {
    const { asset } = await original();
    await mongoose.models.File.updateOne(
      { file_id: asset.file_id },
      { $set: { expiredAt: new Date(0) } },
    );
    expect(
      await methods.retainMediaAsset({
        scope,
        fileId: asset.file_id,
        retainer: 'one',
        maxRetainers: 1,
      }),
    ).toBe(true);
    expect(
      await methods.retainMediaAsset({
        scope,
        fileId: asset.file_id,
        retainer: 'two',
        maxRetainers: 1,
      }),
    ).toBe(false);
    const legacy = createFileMethods(mongoose);
    expect(await legacy.getExpiredFiles()).toEqual([]);
    expect(await legacy.deleteFile(asset.file_id)).toBeNull();
    expect(await legacy.deleteFiles([asset.file_id])).toMatchObject({ deletedCount: 0 });
    expect(await methods.getMediaAsset(scope, asset.file_id)).not.toBeNull();
  });

  it('enforces deployment queue and execution capacity across owners and process restarts', async () => {
    const firstInput = { ...submission('global-first'), maxPendingTotal: 1 };
    const secondInput = {
      ...submission('global-second'),
      maxPendingTotal: 1,
      scope: { ...scope, ownerId: new mongoose.Types.ObjectId().toString() },
    };
    const first = await methods.stageMediaSubmission(firstInput);
    expect((await methods.stageMediaSubmission(secondInput)).phase).toBe('rejected');
    await methods.publishMediaSubmission(scope, first.jobId, options);
    expect(
      await methods.acquireMediaPermit({
        scope,
        jobId: first.jobId,
        kind: 'deployment',
        capacity: 1,
      }),
    ).toBe(true);
    const second = await methods.stageMediaSubmission({
      ...secondInput,
      maxPendingTotal: 10,
      request: { ...secondInput.request, clientRequestId: 'global-third' },
    });
    await methods.publishMediaSubmission(secondInput.scope, second.jobId, options);
    methods = createMediaMethods(mongoose, { ownerExists: async () => true });
    expect(
      await methods.acquireMediaPermit({
        scope: secondInput.scope,
        jobId: second.jobId,
        kind: 'deployment',
        capacity: 1,
      }),
    ).toBe(false);
    const now = new Date(Date.now() + 1000).toISOString();
    const claimed = (await methods.claimMediaJob({
      scope,
      workerId: 'worker',
      now,
      leaseMs: 10000,
    }))!;
    const submitted = (await methods.beginMediaSubmission(fence(claimed, now)))!;
    expect(await methods.releaseMediaPermits({ scope, jobId: first.jobId })).toBe(false);
    expect(
      await methods.recordMediaJobObservation({
        ...fence(submitted, now),
        observation: {
          phase: 'failed',
          provider: { certainty: 'terminal' },
        },
      }),
    ).not.toBeNull();
    expect(
      await methods.acquireMediaPermit({
        scope: secondInput.scope,
        jobId: second.jobId,
        kind: 'deployment',
        capacity: 1,
      }),
    ).toBe(true);
  });

  it('rolls back every permit a failed multi-permit acquisition inserted', async () => {
    const other = { ...scope, ownerId: new mongoose.Types.ObjectId().toString() };
    const [firstA, secondA] = await Promise.all([accepted('owner-a-1'), accepted('owner-a-2')]);
    const staged = await methods.stageMediaSubmission({ ...submission('owner-b'), scope: other });
    await methods.publishMediaSubmission(other, staged.jobId, options);
    const permits = [
      { kind: 'deployment' as const, capacity: 2 },
      { kind: 'owner' as const, capacity: 1 },
    ];
    const held = (jobId: string) =>
      mongoose.models.MediaPermit.find({ jobId })
        .distinct('kind')
        .then((kinds) => kinds.sort());
    expect(await methods.acquireMediaPermits({ scope, jobId: firstA.jobId, permits })).toBe(true);
    expect(await held(firstA.jobId)).toEqual(['deployment', 'owner', 'queue']);
    expect(await methods.acquireMediaPermits({ scope, jobId: secondA.jobId, permits })).toBe(false);
    expect(await held(secondA.jobId)).toEqual(['queue']);
    expect(await mongoose.models.MediaPermit.countDocuments({ kind: 'deployment' })).toBe(1);
    expect(await methods.acquireMediaPermits({ scope: other, jobId: staged.jobId, permits })).toBe(
      true,
    );
    expect(await held(staged.jobId)).toEqual(['deployment', 'owner', 'queue']);
  });

  it('repairs a lost asset receipt acknowledgement from the canonical immutable File', async () => {
    const { write, asset } = await original();
    await mongoose.models.MediaAssetWrite.updateOne(
      { writeId: write.writeId },
      { $set: { state: 'reserved' }, $unset: { asset: 1 } },
    );
    expect(
      await methods.getPublishedMediaAsset({
        scope,
        outputKey: write.outputKey,
        rendition: 'original',
      }),
    ).toEqual(asset);
    expect(
      await mongoose.models.MediaAssetWrite.findOne({ writeId: write.writeId }).lean(),
    ).toMatchObject({ state: 'published' });
    expect(
      await methods.getPublishedMediaAsset({
        scope: { ...scope, ownerId: new mongoose.Types.ObjectId().toString() },
        outputKey: write.outputKey,
        rendition: 'original',
      }),
    ).toBeNull();
  });

  it('replays an import by original request identity after capturing different immutable file IDs', async () => {
    const { asset } = await original();
    const identityRequest = {
      schemaVersion: 1 as const,
      clientRequestId: 'captured-import',
      inputs: [{ role: 'reference' as const, file_id: 'legacy-source' }],
    };
    const first = await methods.stageMediaImport({
      scope,
      identityRequest,
      request: { ...identityRequest, inputs: [{ role: 'reference', file_id: asset.file_id }] },
    });
    await methods.publishMediaImport(scope, first.turnId, options);
    expect(
      await methods.stageMediaImport({ scope, request: identityRequest, identityRequest }),
    ).toMatchObject({ turnId: first.turnId, phase: 'accepted' });
    expect(await mongoose.models.MediaTurn.findOne({ turnId: first.turnId }).lean()).toMatchObject({
      inputs: [{ file_id: asset.file_id }],
    });
  });

  it('preserves a hard retention deadline when saving an orphan into a thread', async () => {
    const write = await methods.reserveMediaAssetWrite({
      scope,
      outputKey: 'temporary-copy',
      rendition: 'original',
      ingestToken: 'hard',
      fingerprint: 'hard',
      storageKey: 'images/hard.png',
    });
    const deadline = new Date(Date.now() + 60000).toISOString();
    await methods.commitMediaAssetWrite({
      scope,
      writeId: write.writeId,
      content: {
        file_id: write.fileId,
        filename: 'hard.png',
        type: 'image/png',
        bytes: 1,
        filepath: '/images/hard.png',
        source: 'local',
        storageKey: write.storageKey,
        contentDigest: 'hard',
        expiredAt: deadline,
        hardExpiresAt: deadline,
      },
    });
    expect(
      await methods.retainMediaAsset({
        scope,
        fileId: write.fileId,
        retainer: 'thread:temporary',
        maxRetainers: 4,
      }),
    ).toBe(true);
    expect((await methods.getMediaAssetContent(scope, write.fileId))?.expiredAt).toBe(deadline);
    const expired = await createFileMethods(mongoose).getExpiredFiles(10, {
      now: new Date(Date.parse(deadline) + 1),
    });
    expect(expired.map((asset) => asset.file_id)).toContain(write.fileId);
  });

  it('fences account deletion against queued dispatch and safely releases a rejected deletion attempt', async () => {
    const job = await accepted('delete-busy');
    const now = new Date(Date.now() + 1000).toISOString();
    const claimed = (await methods.claimMediaJob({
      scope,
      workerId: 'worker',
      now,
      leaseMs: 10000,
    }))!;
    expect(await methods.prepareMediaAccountDeletion({ scope, token: 'delete-one' })).toBe(false);
    expect(await methods.beginMediaSubmission(fence(claimed, now))).toBeNull();
    await expect(methods.stageMediaSubmission(submission('delete-new'))).rejects.toMatchObject({
      code: 'retired',
    });
    await methods.cancelMediaAccountDeletion({ scope, token: 'wrong-token' });
    expect(await methods.beginMediaSubmission(fence(claimed, now))).toBeNull();
    await methods.cancelMediaAccountDeletion({ scope, token: 'delete-one' });
    expect(await methods.beginMediaSubmission(fence(claimed, now))).not.toBeNull();
    expect(await methods.prepareMediaAccountDeletion({ scope, token: 'delete-two' })).toBe(false);
    expect((await methods.getMediaJob(scope, job.jobId))?.provider.certainty).toBe('unknown');
  });

  it('retains a deleted owner tombstone and erases history only after durable retirement begins', async () => {
    const { asset } = await original();
    const job = await accepted('delete-safe', {
      inputs: [{ role: 'reference', file_id: asset.file_id }],
    });
    await methods.cancelMediaJob(scope, job.jobId);
    expect(await methods.prepareMediaAccountDeletion({ scope, token: 'delete' })).toBe(true);
    await methods.completeMediaAccountDeletion({ scope, token: 'delete' });
    await methods.completeMediaAccountDeletion({ scope, token: 'delete' });
    expect(await methods.getMediaThread(scope, job.threadId)).toBeNull();
    expect(
      (
        await runAsSystem(() =>
          methods.listMediaCleanupScopes({ limit: 10, now: new Date().toISOString() }),
        )
      ).items,
    ).toContainEqual(scope);
    await methods.reconcileMediaAccountDeletion({ scope, limit: 10 });
    expect(await methods.getMediaJob(scope, job.jobId)).toBeNull();
    const claimed = await methods.claimMediaAssetDeletion({
      scope,
      fileId: asset.file_id,
      token: 'storage-delete',
    });
    expect(claimed?.file_id).toBe(asset.file_id);
    await methods.completeMediaAssetDeletion({
      scope,
      fileId: asset.file_id,
      token: 'storage-delete',
    });
    await methods.reconcileMediaAccountDeletion({ scope, limit: 10 });
    expect(await mongoose.models.File.countDocuments({ user: scope.ownerId })).toBe(0);
    expect(await mongoose.models.MediaOwner.findOne(scope).lean()).toMatchObject({
      status: 'deleted',
    });
    await methods.cancelMediaAccountDeletion({ scope, token: 'delete' });
    await expect(methods.stageMediaSubmission(submission('resurrect'))).rejects.toMatchObject({
      code: 'retired',
    });
  });

  it('recovers an admitted original after a crash before File publication and excludes it from cleanup', async () => {
    const write = await methods.reserveMediaAssetWrite({
      scope,
      outputKey: 'crash-upload',
      rendition: 'original',
      ingestToken: 'crash',
      fingerprint: 'digest',
      storageKey: 'images/crash.png',
    });
    const content = {
      file_id: write.fileId,
      filename: 'crash.png',
      type: 'image/png',
      bytes: 2,
      filepath: '/images/crash.png',
      source: 'local',
      storageKey: write.storageKey,
      contentDigest: 'digest',
    };
    const failedWrite = jest.spyOn(mongoose.models.File, 'updateOne').mockImplementationOnce(() => {
      throw new Error('database disconnected');
    });
    await expect(
      methods.commitMediaAssetWrite({ scope, writeId: write.writeId, content }),
    ).rejects.toThrow('database disconnected');
    failedWrite.mockRestore();
    expect(
      await mongoose.models.MediaAssetWrite.findOne({ writeId: write.writeId }).lean(),
    ).toMatchObject({ state: 'committing', publicationContent: content });
    expect(
      await methods.claimMediaAssetWriteDeletion({
        scope,
        writeId: write.writeId,
        token: 'cleanup',
        staleBefore: new Date(Date.now() + 60000).toISOString(),
      }),
    ).toBeNull();
    expect(await methods.prepareMediaAccountDeletion({ scope, token: 'delete' })).toBe(false);
    methods = createMediaMethods(mongoose, { ownerExists: async () => true });
    expect(await methods.recoverMediaAssetWrites({ scope, limit: 1 })).toBe(1);
    expect(await methods.getMediaAsset(scope, write.fileId)).toMatchObject({
      file_id: write.fileId,
    });
    expect(await methods.prepareMediaAccountDeletion({ scope, token: 'delete' })).toBe(true);
  });

  it('fences an old unpublished upload before authorizing byte deletion', async () => {
    const write = await methods.reserveMediaAssetWrite({
      scope,
      outputKey: 'old-upload',
      rendition: 'original',
      ingestToken: 'old',
      fingerprint: 'digest',
      storageKey: 'images/old.png',
    });
    const staleBefore = new Date(Date.now() + 60000).toISOString();
    expect(
      (await methods.listMediaAssetWritesForCleanup({ scope, limit: 1, staleBefore }))[0].writeId,
    ).toBe(write.writeId);
    expect(
      await methods.claimMediaAssetWriteDeletion({
        scope,
        writeId: write.writeId,
        token: 'cleanup',
        staleBefore,
      }),
    ).toMatchObject({ storageKey: write.storageKey, token: 'cleanup' });
    await expect(
      methods.commitMediaAssetWrite({
        scope,
        writeId: write.writeId,
        content: {
          file_id: write.fileId,
          filename: 'late.png',
          type: 'image/png',
          bytes: 2,
          filepath: '/images/old.png',
          source: 'local',
          storageKey: write.storageKey,
          contentDigest: 'digest',
        },
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(await mongoose.models.File.countDocuments()).toBe(0);
    expect(
      await methods.completeMediaAssetWriteDeletion({
        scope,
        writeId: write.writeId,
        token: 'wrong',
      }),
    ).toBe(false);
    expect(
      await methods.completeMediaAssetWriteDeletion({
        scope,
        writeId: write.writeId,
        token: 'cleanup',
      }),
    ).toBe(true);
  });

  it('never hands a canonical original path to staging cleanup even after a lost acknowledgement', async () => {
    const { write } = await original();
    await mongoose.models.MediaAssetWrite.updateOne(
      { writeId: write.writeId },
      { $set: { state: 'reserved' }, $unset: { asset: 1 } },
    );
    expect(
      await methods.claimMediaAssetWriteDeletion({
        scope,
        writeId: write.writeId,
        token: 'cleanup',
        staleBefore: new Date(Date.now() + 60000).toISOString(),
      }),
    ).toBeNull();
    expect(await methods.getMediaAsset(scope, write.fileId)).not.toBeNull();
  });

  it('allows explicit cleanup when a paused uploader writes after its receipt was deleted', async () => {
    const write = await methods.reserveMediaAssetWrite({
      scope,
      outputKey: 'paused-upload',
      rendition: 'original',
      ingestToken: 'paused',
      fingerprint: 'digest',
      storageKey: 'images/paused.png',
    });
    const staleBefore = new Date(Date.now() + 60000).toISOString();
    await methods.claimMediaAssetWriteDeletion({
      scope,
      writeId: write.writeId,
      token: 'first',
      staleBefore,
    });
    await methods.completeMediaAssetWriteDeletion({
      scope,
      writeId: write.writeId,
      token: 'first',
    });
    expect(await methods.listMediaAssetWritesForCleanup({ scope, limit: 1, staleBefore })).toEqual(
      [],
    );
    expect(await methods.prepareMediaAccountDeletion({ scope, token: 'delete-paused' })).toBe(true);
    await methods.completeMediaAccountDeletion({ scope, token: 'delete-paused' });
    await methods.reconcileMediaAccountDeletion({ scope, limit: 10 });
    // The uploader opens and finishes its private path after the first cleanup acknowledgement.
    await expect(
      methods.commitMediaAssetWrite({
        scope,
        writeId: write.writeId,
        content: {
          file_id: write.fileId,
          filename: 'paused.png',
          type: 'image/png',
          bytes: 2,
          filepath: '/images/paused.png',
          source: 'local',
          storageKey: write.storageKey,
          contentDigest: 'digest',
        },
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(
      await methods.claimMediaAssetWriteDeletion({
        scope,
        writeId: write.writeId,
        token: 'late',
        staleBefore,
      }),
    ).toMatchObject({ storageKey: write.storageKey, token: 'late' });
    expect(
      await methods.completeMediaAssetWriteDeletion({
        scope,
        writeId: write.writeId,
        token: 'first',
      }),
    ).toBe(false);
    expect(
      await methods.completeMediaAssetWriteDeletion({
        scope,
        writeId: write.writeId,
        token: 'late',
      }),
    ).toBe(true);
    expect(await mongoose.models.File.countDocuments()).toBe(0);
  });

  it('prevents legacy metadata mutation from moving original bytes or attaching a Mongo TTL', async () => {
    const { asset } = await original();
    await mongoose.models.File.updateOne(
      { file_id: asset.file_id },
      { $set: { source: 'firebase', storageKey: 'other-location', expiresAt: new Date(0) } },
    );
    const stored = await mongoose.models.File.findOne({ file_id: asset.file_id }).lean();
    expect(stored).toMatchObject({ source: 'local' });
    expect(stored).not.toHaveProperty('expiresAt');
    expect(stored).not.toMatchObject({ storageKey: 'other-location' });
  });

  it('pages distinct scopes before applying a bound so prolific owners cannot hide intermediate owners', async () => {
    const owners = [
      '100000000000000000000001',
      '100000000000000000000002',
      '100000000000000000000003',
    ];
    scope = { ownerId: owners[0], tenantId: null };
    await Promise.all(
      [1, 2, 3].map((index) => methods.stageMediaSubmission(submission(`many-${index}`))),
    );
    scope = { ownerId: owners[1], tenantId: null };
    await methods.stageMediaSubmission(submission('middle'));
    const tenantScope = { ...scope, tenantId: 'tenant-z' };
    await methods.stageMediaSubmission({ ...submission('middle-tenant'), scope: tenantScope });
    scope = { ownerId: owners[2], tenantId: null };
    await methods.stageMediaImport({
      scope,
      request: { schemaVersion: 1, clientRequestId: 'last-import', inputs: [] },
    });
    const found: MediaOwnerScope[] = [];
    let cursor: string | undefined;
    do {
      const page = await runAsSystem(() =>
        methods.listDueMediaScopes({ limit: 1, now: new Date().toISOString(), cursor }),
      );
      found.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    expect(found).toEqual([
      { ownerId: owners[0], tenantId: null },
      { ownerId: owners[1], tenantId: null },
      tenantScope,
      { ownerId: owners[2], tenantId: null },
    ]);
  });

  it.each(['media', 'chat'] as const)(
    'repairs a %s thread projection on detail read after a crash following terminal job CAS',
    async (executionOwner) => {
      const { asset } = await original();
      const receipt = await methods.stageMediaSubmission({
        ...submission('projection-crash'),
      });
      await methods.publishMediaSubmission(scope, receipt.jobId, options);
      if (executionOwner === 'chat') await markLegacyChatJob(receipt.jobId);
      await methods.retainMediaThreadAsset({
        scope,
        threadId: receipt.threadId,
        fileId: asset.file_id,
        maxRetainers: options.maxRetainers,
      });
      const before = (await methods.listMediaThreads({ scope, limit: 10 })).items[0];
      expect(before).toMatchObject({ pendingJobCount: 1, turnCount: 1 });
      await mongoose.models.MediaJob.updateOne(
        { ...scope, jobId: receipt.jobId },
        {
          $set: {
            phase: 'succeeded',
            provider: { certainty: 'terminal' },
            outputs: [
              {
                kind: 'image',
                outputId: 'ready-image',
                ordinal: 0,
                state: 'ready',
                asset,
              },
            ],
          },
          $inc: { version: 1 },
        },
      );
      // The completion was durable; its summary write never ran before the process stopped.
      methods = createMediaMethods(mongoose, { ownerExists: async () => true });
      const staleList = (await methods.listMediaThreads({ scope, limit: 10 })).items[0];
      expect(staleList).toMatchObject({ pendingJobCount: 1, version: before.version });
      expect(staleList.cover).toBeUndefined();
      const restored = await methods.getMediaThread(scope, receipt.threadId);
      expect(restored).toMatchObject({
        pendingJobCount: 0,
        turnCount: 1,
        cover: asset,
        version: before.version + 1,
      });
      expect(await methods.getMediaThread(scope, receipt.threadId)).toEqual(restored);
      expect((await methods.listMediaThreads({ scope, limit: 10 })).items[0]).toEqual(restored);
      expect(
        await methods.getMediaThread(
          { ...scope, ownerId: new mongoose.Types.ObjectId().toString() },
          receipt.threadId,
        ),
      ).toBeNull();
    },
  );

  it('preserves an explicitly cleared cover while repairing a missed completion projection', async () => {
    const { asset } = await original();
    const job = await accepted('explicit-cover-projection');
    const before = (await methods.getMediaThread(scope, job.threadId))!;
    await methods.updateMediaThread({
      scope,
      threadId: job.threadId,
      expectedVersion: before.version,
      coverFileId: null,
    });
    await mongoose.models.MediaJob.updateOne(
      { ...scope, jobId: job.jobId },
      {
        $set: {
          phase: 'succeeded',
          provider: { certainty: 'terminal' },
          outputs: [
            {
              kind: 'image',
              outputId: 'ready-image',
              ordinal: 0,
              state: 'ready',
              asset,
            },
          ],
        },
        $inc: { version: 1 },
      },
    );
    const repaired = await methods.getMediaThread(scope, job.threadId);
    expect(repaired?.pendingJobCount).toBe(0);
    expect(repaired?.cover).toBeUndefined();
  });

  it('hides a temporary creation from the library and retires it once its retention passes', async () => {
    const retention = 60_000;
    const receipt = await methods.stageMediaSubmission(
      submission('temporary', { temporary: true }),
    );
    const published = await methods.publishMediaSubmission(scope, receipt.jobId, {
      ...options,
      temporaryRetentionMs: retention,
    });
    expect(published?.phase).toBe('accepted');
    const thread = mediaThreadSchema.parse(await methods.getMediaThread(scope, receipt.threadId));
    expect(thread.temporary).toBe(true);
    expect(thread.expiresAt).toBe(
      new Date(new Date(thread.createdAt).getTime() + retention).toISOString(),
    );
    const followUp = await methods.stageMediaSubmission(
      submission('temporary-follow-up', {
        threadId: receipt.threadId,
        parentTurnId: receipt.turnId,
      }),
    );
    expect(
      (
        await methods.publishMediaSubmission(scope, followUp.jobId, {
          ...options,
          temporaryRetentionMs: 1,
        })
      )?.phase,
    ).toBe('accepted');
    expect((await methods.getMediaThread(scope, receipt.threadId))?.expiresAt).toBe(
      thread.expiresAt,
    );
    const durable = await accepted('durable');
    expect((await methods.getMediaThread(scope, durable.threadId))?.expiresAt).toBeUndefined();
    for (const include of [undefined, 'activity'] as const) {
      const listed = await methods.listMediaThreads({ scope, limit: 10, include });
      expect(listed.items.map((item) => item.threadId)).toEqual([durable.threadId]);
    }
    expect(
      await methods.retireExpiredMediaThreads({ scope, now: thread.createdAt, limit: 10 }),
    ).toBe(0);
    expect(
      (
        await runAsSystem(() =>
          methods.listMediaCleanupScopes({ limit: 10, now: thread.createdAt }),
        )
      ).items,
    ).toEqual([]);
    expect(
      (
        await runAsSystem(() =>
          methods.listMediaCleanupScopes({ limit: 10, now: thread.expiresAt! }),
        )
      ).items,
    ).toEqual([scope]);
    expect(
      await methods.retireExpiredMediaThreads({ scope, now: thread.expiresAt!, limit: 10 }),
    ).toBe(1);
    expect(await methods.getMediaThread(scope, receipt.threadId)).toBeNull();
    expect(
      await mongoose.models.MediaThread.findOne({ threadId: receipt.threadId }).lean(),
    ).toMatchObject({ status: 'retiring', epoch: 2 });
    expect((await methods.getMediaJob(scope, receipt.jobId))?.phase).toBe('cancelled');
    expect(
      await mongoose.models.MediaThread.findOne({ ...scope, threadId: durable.threadId }).lean(),
    ).not.toHaveProperty('retiredAt');
    expect(
      await methods.retireExpiredMediaThreads({ scope, now: thread.expiresAt!, limit: 10 }),
    ).toBe(0);
  });

  it('keeps temporary requests out of the library even without a configured retention window', async () => {
    const receipt = await methods.stageMediaSubmission(
      submission('temporary-unbounded', { temporary: true }),
    );
    await methods.publishMediaSubmission(scope, receipt.jobId, options);
    const thread = await methods.getMediaThread(scope, receipt.threadId);
    expect(thread?.temporary).toBe(true);
    expect(thread).not.toHaveProperty('expiresAt');
    expect((await methods.listMediaThreads({ scope, limit: 10 })).items).toHaveLength(0);
  });

  it('lists permanent creations with general retention deadlines and preserves legacy visibility', async () => {
    const deadline = new Date(Date.now() + 60_000).toISOString();
    const permanent = await methods.stageMediaSubmission({
      ...submission('retained-permanent'),
      publicationExpiresAt: deadline,
    });
    await methods.publishMediaSubmission(scope, permanent.jobId, options);
    expect(await methods.getMediaThread(scope, permanent.threadId)).toMatchObject({
      temporary: false,
      expiresAt: deadline,
    });
    const legacyPermanent = await accepted('legacy-permanent');
    const legacyTemporary = await accepted('legacy-temporary');
    const expired = await accepted('expired-permanent');
    await Promise.all([
      mongoose.models.MediaThread.updateOne(
        { threadId: legacyPermanent.threadId },
        { $unset: { temporary: 1 } },
      ),
      mongoose.models.MediaThread.updateOne(
        { threadId: legacyTemporary.threadId },
        { $unset: { temporary: 1 }, $set: { expiresAt: deadline } },
      ),
      mongoose.models.MediaThread.updateOne(
        { threadId: expired.threadId },
        { $set: { expiresAt: new Date(Date.now() - 1_000).toISOString() } },
      ),
    ]);
    for (const include of [undefined, 'activity'] as const) {
      const listed = await methods.listMediaThreads({ scope, limit: 10, include });
      expect(new Set(listed.items.map((item) => item.threadId))).toEqual(
        new Set([permanent.threadId, legacyPermanent.threadId]),
      );
    }
  });

  it('recovers a staged deadline without adopting a later retention policy', async () => {
    const deadline = new Date(Date.now() + 60_000).toISOString();
    const bounded = await methods.stageMediaSubmission({
      ...submission('staged-deadline', { temporary: true }),
      publicationExpiresAt: deadline,
    });
    const permanent = await methods.stageMediaSubmission({
      ...submission('staged-permanent', { temporary: true }),
      publicationExpiresAt: null,
    });
    const legacy = await methods.stageMediaSubmission(
      submission('legacy-temporary', { temporary: true }),
    );
    await createMediaMethods(mongoose, { ownerExists: async () => true }).recoverMediaPublications({
      scope,
      limit: 10,
      ...options,
      temporaryRetentionMs: 120_000,
    });
    expect((await methods.getMediaThread(scope, bounded.threadId))?.expiresAt).toBe(deadline);
    expect((await methods.getMediaThread(scope, permanent.threadId))?.expiresAt).toBeUndefined();
    const legacyThread = (await methods.getMediaThread(scope, legacy.threadId))!;
    expect(legacyThread.expiresAt).toBe(
      new Date(Date.parse(legacyThread.createdAt) + 120_000).toISOString(),
    );
    await methods.recoverMediaPublications({
      scope,
      limit: 10,
      ...options,
      temporaryRetentionMs: 1,
    });
    expect((await methods.getMediaThread(scope, bounded.threadId))?.expiresAt).toBe(deadline);
  });

  it.each(['bounded', 'permanent'] as const)(
    'preserves temporary tool privacy and its frozen %s deadline through an explicit retry',
    async (retention) => {
      const publicationExpiresAt =
        retention === 'bounded' ? new Date(Date.now() + 60_000).toISOString() : null;
      const input = { ...submission('temporary-tool'), publicationExpiresAt };
      // Host retention is frozen independently of the public command descriptor.
      const receipt = await methods.stageMediaSubmission({
        ...input,
        temporary: true,
      });
      expect(await methods.stageMediaSubmission({ ...input, temporary: true })).toEqual(receipt);
      await methods.publishMediaSubmission(scope, receipt.jobId, options);
      expect((await methods.getMediaJob(scope, receipt.jobId))?.request).not.toHaveProperty(
        'temporary',
      );
      expect((await methods.getMediaJob(scope, receipt.jobId))?.temporary).toBe(true);
      await expect(
        methods.stageMediaSubmission({ ...input, temporary: false }),
      ).rejects.toMatchObject({ code: 'conflict' });
      await methods.cancelMediaJob(scope, receipt.jobId);
      const retried = await methods.retryMediaJob({
        scope,
        jobId: receipt.jobId,
        clientRequestId: 'temporary-tool-retry',
        maxActiveJobs: 10,
        maxPendingTotal: 100,
      });
      expect(await methods.getMediaJob(scope, retried.jobId)).toMatchObject({
        temporary: true,
        publicationExpiresAt: publicationExpiresAt ? new Date(publicationExpiresAt) : null,
      });
      await methods.publishMediaSubmission(scope, retried.jobId, {
        ...options,
        temporaryRetentionMs: 1,
      });
      const thread = await methods.getMediaThread(scope, receipt.threadId);
      expect(thread?.temporary).toBe(true);
      expect(thread?.expiresAt).toBe(publicationExpiresAt ?? undefined);
      expect((await methods.listMediaThreads({ scope, limit: 10 })).items).toEqual([]);
    },
  );

  it('purges retired payloads only after financial obligations settle and preserves replay receipts', async () => {
    const input = submission('purge-after-settlement');
    const job = await accepted('purge-after-settlement');
    await mongoose.models.MediaJob.updateOne(
      { jobId: job.jobId },
      {
        $set: {
          phase: 'succeeded',
          provider: {
            certainty: 'terminal',
            recovery: {
              diagnostic: { status: 400, message: 'Private provider diagnostic.' },
              rejectedSubmission: true,
              parts: [
                {
                  kind: 'text',
                  text: 'private output',
                  thoughtSignature: 'private signature',
                  ordinal: 0,
                },
              ],
            },
          },
          outputs: [{ kind: 'text', outputId: 'text', ordinal: 0, text: 'private output' }],
          accounting: { phase: 'held', settlementId: 'receipt' },
        },
      },
    );
    expect(await methods.getMediaJobDiagnostics(scope, job.jobId)).toEqual({
      diagnostic: { status: 400, message: 'Private provider diagnostic.' },
    });
    await methods.retireMediaThread(scope, job.threadId);
    expect(await methods.getMediaJobDiagnostics(scope, job.jobId)).toBeNull();
    await methods.reconcileMediaRetirements({ scope, limit: 10 });
    expect((await methods.getMediaJob(scope, job.jobId))?.request.prompt).toBe(
      input.request.prompt,
    );
    await mongoose.models.MediaJob.updateOne(
      { jobId: job.jobId },
      { $set: { 'accounting.phase': 'settled' } },
    );
    await methods.reconcileMediaRetirements({ scope, limit: 10 });
    await methods.reconcileMediaRetirements({ scope, limit: 10 });
    const purged = (await methods.getMediaJob(scope, job.jobId))!;
    expect(purged.request.prompt).toBe('');
    expect(purged.outputs).toEqual([]);
    expect(purged.provider.recovery).toBeUndefined();
    expect(purged.accounting).toEqual({ phase: 'settled', settlementId: 'receipt' });
    expect(await methods.stageMediaSubmission(input)).toEqual(job.receipt);
    expect(
      await mongoose.models.MediaThread.findOne({ threadId: job.threadId }).lean(),
    ).toMatchObject({ status: 'retired', title: '' });
    expect(await mongoose.models.MediaTurn.findOne({ turnId: job.turnId }).lean()).toMatchObject({
      prompt: '',
      inputs: [],
    });
  });

  it('keeps internal media tombstones out of the public Files query', async () => {
    const { asset } = await original('public-tombstone');
    const files = createFileMethods(mongoose);
    expect(await files.getFiles({ user: scope.ownerId })).toHaveLength(1);
    expect(
      await methods.claimMediaAssetDeletion({ scope, fileId: asset.file_id, token: 'deletion' }),
    ).not.toBeNull();
    expect(await files.getFiles({ user: scope.ownerId })).toEqual([]);
    await methods.completeMediaAssetDeletion({ scope, fileId: asset.file_id, token: 'deletion' });
    expect(await files.getFiles({ user: scope.ownerId })).toEqual([]);
    expect(await mongoose.models.File.exists({ file_id: asset.file_id })).not.toBeNull();
  });

  it.each(['image', 'video'] as const)(
    'finds the latest live %s beyond a page of failed turns and includes imported originals',
    async (kind) => {
      const type = kind === 'image' ? 'image/png' : 'video/mp4';
      const latestContext =
        kind === 'image' ? methods.getMediaLatestImageContext : methods.getMediaLatestVideoContext;
      const job = await accepted('image-context', {
        operation: `${kind}.generate`,
        parameters: { count: 2 },
      });
      const { asset } = await original('context-asset', type);
      await mongoose.models.MediaJob.updateOne(
        { jobId: job.jobId },
        {
          $set: {
            phase: 'succeeded',
            provider: { certainty: 'terminal' },
            outputs: [{ kind, ordinal: 0, outputId: 'image', state: 'ready', asset }],
          },
          $unset: { activeSlot: 1 },
        },
      );
      for (let index = 0; index < 25; index++) {
        const failed = await accepted(`failed-image-${index}`, { threadId: job.threadId });
        await mongoose.models.MediaJob.updateOne(
          { jobId: failed.jobId },
          {
            $set: { phase: 'failed', provider: { certainty: 'terminal' } },
            $unset: { activeSlot: 1 },
          },
        );
      }
      const firstPage = await methods.listMediaTurns({
        scope,
        threadId: job.threadId,
        limit: 24,
        jobsPerTurn: 4,
      });
      expect(firstPage.items.map((turn) => turn.sequence)).toEqual(
        Array.from({ length: 24 }, (_, index) => 26 - index),
      );
      expect(firstPage.items.some((turn) => turn.turnId === job.turnId)).toBe(false);
      expect(await latestContext({ scope, threadId: job.threadId })).toEqual({
        turnId: job.turnId,
        asset,
      });
      const appended = await accepted('appended-during-pagination', { threadId: job.threadId });
      const secondPage = await methods.listMediaTurns({
        scope,
        threadId: job.threadId,
        limit: 24,
        jobsPerTurn: 4,
        cursor: firstPage.nextCursor,
      });
      expect(secondPage.items.map((turn) => turn.sequence)).toEqual([2, 1]);
      expect(secondPage.items[1]).toMatchObject({
        operation: `${kind}.generate`,
        parameters: { count: 2 },
      });
      expect(secondPage.items.some((turn) => turn.turnId === appended.turnId)).toBe(false);
      const imported = await original('context-import', type);
      const receipt = await methods.stageMediaImport({
        scope,
        request: {
          clientRequestId: 'context-import',
          schemaVersion: 1,
          threadId: job.threadId,
          inputs: [
            { role: kind === 'image' ? 'reference' : 'video', file_id: imported.asset.file_id },
          ],
        },
      });
      await methods.publishMediaImport(scope, receipt.turnId, options);
      expect(await latestContext({ scope, threadId: job.threadId })).toEqual({
        turnId: receipt.turnId,
        asset: imported.asset,
      });
      await mongoose.models.File.collection.updateOne(
        { file_id: imported.asset.file_id },
        { $set: { mediaHardExpiresAt: new Date(0) } },
      );
      expect(await latestContext({ scope, threadId: job.threadId })).toEqual({
        turnId: job.turnId,
        asset,
      });
      expect(
        await latestContext({
          scope: { ...scope, ownerId: new mongoose.Types.ObjectId().toString() },
          threadId: job.threadId,
        }),
      ).toBeNull();
      await methods.retireMediaThread(scope, job.threadId);
      expect(await latestContext({ scope, threadId: job.threadId })).toBeNull();
    },
  );

  it('shares expiry selection while separately repairing interrupted unexpired deletions', async () => {
    const expired = (await original('expired-shared')).asset;
    const interrupted = (await original('interrupted-explicit')).asset;
    const files = createFileMethods(mongoose);
    await methods.releaseMediaAsset({ scope, fileId: expired.file_id, retainer: 'unused' });
    await methods.claimMediaAssetDeletion({ scope, fileId: expired.file_id, token: 'expired' });
    await methods.claimMediaAssetDeletion({
      scope,
      fileId: interrupted.file_id,
      token: 'explicit',
    });
    const now = new Date(Date.now() + 1000);
    expect((await files.getExpiredFiles(10, { now })).map((file) => file.file_id)).toEqual([
      expired.file_id,
    ]);
    expect(
      (await methods.listMediaRetiringAssets({ scope, limit: 10, now })).map(
        (file) => file.file_id,
      ),
    ).toEqual([interrupted.file_id]);
    expect(
      await methods.listMediaRetiringAssets({
        scope: { ...scope, tenantId: 'foreign' },
        limit: 10,
        now,
      }),
    ).toEqual([]);
    expect(
      (await runAsSystem(() => methods.listMediaCleanupScopes({ limit: 10, now }))).items,
    ).toContainEqual(scope);
    await methods.completeMediaAssetDeletion({
      scope,
      fileId: interrupted.file_id,
      token: 'explicit',
    });
    // An expired original is exclusively owned by the shared sweep, not rediscovered by both workers.
    expect(
      (await runAsSystem(() => methods.listMediaCleanupScopes({ limit: 10, now }))).items,
    ).toEqual([]);
    await methods.completeMediaAssetDeletion({ scope, fileId: expired.file_id, token: 'expired' });
    expect(await files.getExpiredFiles(10, { now })).toEqual([]);
  });

  it('defers poisoned media originals and write cleanup using durable retry deadlines', async () => {
    const { asset } = await original('poisoned-original');
    await methods.releaseMediaAsset({ scope, fileId: asset.file_id, retainer: 'unused' });
    const now = new Date(Date.now() + 1_000).toISOString();
    const retryAt = new Date(Date.parse(now) + 60_000);
    const files = createFileMethods(mongoose);
    const ownerScope = { userId: scope.ownerId, tenantId: scope.tenantId };
    expect(
      await files.incrementFileDeletionAttempts(asset.file_id, {
        ...ownerScope,
        tenantId: 'foreign',
      }),
    ).toBe(0);
    expect(await files.incrementFileDeletionAttempts(asset.file_id, ownerScope)).toBe(1);
    await files.deferExpiredFile(asset.file_id, retryAt, ownerScope);
    await files.deferExpiredFile(asset.file_id, new Date(now), ownerScope);
    expect(await files.getExpiredFiles(10, { now: new Date(now) })).toEqual([]);
    expect(await files.getExpiredFiles(10, { now: retryAt })).toHaveLength(1);
    const write = await methods.reserveMediaAssetWrite({
      scope,
      outputKey: 'poisoned-write',
      rendition: 'original',
      ingestToken: 'attempt',
      fingerprint: 'digest',
      storageKey: 'poisoned-write.png',
    });
    expect(
      await methods.incrementMediaAssetWriteDeletionAttempts({ scope, writeId: write.writeId }),
    ).toBe(1);
    await methods.deferMediaAssetWriteCleanup({
      scope,
      writeId: write.writeId,
      retryAt: retryAt.toISOString(),
    });
    await methods.deferMediaAssetWriteCleanup({ scope, writeId: write.writeId, retryAt: now });
    expect(
      await methods.listMediaAssetWritesForCleanup({ scope, staleBefore: now, now, limit: 10 }),
    ).toEqual([]);
    expect(
      await methods.listMediaAssetWritesForCleanup({
        scope,
        staleBefore: now,
        now: retryAt.toISOString(),
        limit: 10,
      }),
    ).toHaveLength(1);
  });

  it('carries a comparison marker onto the published turn view', async () => {
    const compared = await accepted('compare-a', { comparisonId: 'comparison-1' });
    const plain = await accepted('plain');
    const [turn] = (
      await methods.listMediaTurns({
        scope,
        threadId: compared.threadId,
        limit: 10,
        jobsPerTurn: 10,
      })
    ).items;
    expect(mediaTurnSchema.parse(turn).comparisonId).toBe('comparison-1');
    const [plainTurn] = (
      await methods.listMediaTurns({ scope, threadId: plain.threadId, limit: 10, jobsPerTurn: 10 })
    ).items;
    expect(plainTurn).not.toHaveProperty('comparisonId');
  });

  it('keeps every image submission in the billed queue despite an unsupported caller lane', async () => {
    const input = submission('unsupported-lane');
    Object.assign(input, { executionOwner: 'chat', maxActiveJobs: 1, maxPendingTotal: 1 });
    const receipt = await methods.stageMediaSubmission(input);
    expect(await methods.getMediaJob(scope, receipt.jobId)).toMatchObject({
      executionOwner: 'media',
      activeSlot: 0,
      queueCapacity: 1,
    });
    await expect(
      methods.stageMediaSubmission({
        ...submission('billed-capacity'),
        maxActiveJobs: 1,
        maxPendingTotal: 1,
      }),
    ).rejects.toMatchObject({ code: 'capacity' });
  });

  it.each(['frozen', 'legacy', 'permanent'] as const)(
    'recovers and retries an old temporary request without an internal flag (%s deadline)',
    async (retention) => {
      const deadline = new Date(Date.now() + 60_000).toISOString();
      const input = {
        ...submission('old-temporary'),
        temporary: true,
        ...(retention === 'legacy'
          ? {}
          : { publicationExpiresAt: retention === 'frozen' ? deadline : null }),
      };
      const receipt = await methods.stageMediaSubmission(input);
      const legacyRequest = { ...input.request, temporary: true };
      const legacyFingerprint = digest({ request: legacyRequest });
      await mongoose.models.MediaJob.updateOne(
        { jobId: receipt.jobId },
        {
          $unset: { temporary: 1 },
          $set: { request: legacyRequest, fingerprint: legacyFingerprint },
        },
      );
      await expect(methods.stageMediaSubmission(input)).resolves.toEqual(receipt);
      await expect(
        methods.stageMediaSubmission({ ...input, temporary: false }),
      ).rejects.toMatchObject({ code: 'conflict' });
      await expect(
        methods.stageMediaSubmission({
          ...input,
          request: { ...input.request, prompt: 'Changed content' },
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
      await methods.recoverMediaPublications({
        scope,
        limit: 10,
        ...options,
        temporaryRetentionMs: 120_000,
      });
      const thread = (await methods.getMediaThread(scope, receipt.threadId))!;
      const expiresAt = {
        legacy: new Date(Date.parse(thread.createdAt) + 120_000).toISOString(),
        frozen: deadline,
        permanent: undefined,
      }[retention];
      expect(thread.temporary).toBe(true);
      expect(thread.expiresAt).toBe(expiresAt);
      expect((await methods.listMediaThreads({ scope, limit: 10 })).items).toEqual([]);
      expect((await methods.getMediaJob(scope, receipt.jobId))?.fingerprint).toBe(
        legacyFingerprint,
      );
      await methods.cancelMediaJob(scope, receipt.jobId);
      const retry = await methods.retryMediaJob({
        scope,
        jobId: receipt.jobId,
        clientRequestId: 'old-temporary-retry',
        maxActiveJobs: 10,
        maxPendingTotal: 100,
      });
      expect(await methods.getMediaJob(scope, retry.jobId)).toMatchObject({ temporary: true });
      await methods.publishMediaSubmission(scope, retry.jobId, {
        ...options,
        temporaryRetentionMs: 1,
      });
      expect((await methods.getMediaThread(scope, receipt.threadId))?.expiresAt).toBe(expiresAt);
    },
  );
});
