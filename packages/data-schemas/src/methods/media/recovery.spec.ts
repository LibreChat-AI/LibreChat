import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { mediaSubmissionRequestSchema } from 'librechat-data-provider';
import type { MediaRecoveryRequest } from 'librechat-data-provider';
import type { MediaStoredJob, MediaOwnerScope } from '~/types/media';
import { createMediaRecoveryMethods } from './recovery';
import { tenantStorage } from '~/config/tenantContext';
import { createMediaNativeMethods } from './native';
import { createMediaMethods } from './index';

describe('operator media recovery on standalone MongoDB', () => {
  let mongo: MongoMemoryServer;
  let media: ReturnType<typeof createMediaMethods>;
  let native: ReturnType<typeof createMediaNativeMethods>;
  let recovery: ReturnType<typeof createMediaRecoveryMethods>;
  let scope: MediaOwnerScope;
  const now = () => new Date().toISOString();
  const execution = {
    api: 'google.generateContent' as const,
    connectionId: 'google',
    modelId: 'image-model',
    catalogVersion: 'v1',
    bindingRevision: 'original-binding',
  };
  const submission = (key: string) =>
    mediaSubmissionRequestSchema.parse({
      clientRequestId: key,
      operation: 'image.generate',
      prompt: 'Private prompt',
      selection: {
        connectionId: execution.connectionId,
        modelId: execution.modelId,
        catalogVersion: execution.catalogVersion,
      },
    });

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    media = createMediaMethods(mongoose, { ownerExists: async () => true });
    native = createMediaNativeMethods(mongoose, media);
    recovery = createMediaRecoveryMethods(mongoose);
    await media.ensureMediaIndexes();
    await native.ensureMediaNativeIndexes();
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
  });

  async function attention(
    key = 'job-one',
    certainty: 'unknown' | 'submitted' | 'unsubmitted' = 'submitted',
  ): Promise<MediaStoredJob> {
    const receipt = await media.stageMediaSubmission({
      scope,
      request: submission(key),
      execution: { ...execution, accountingMode: 'balance' },
      maxActiveJobs: 8,
      maxPendingTotal: 20,
    });
    await media.publishMediaSubmission(scope, receipt.jobId, {
      maxRetainers: 8,
      maxTitleChars: 30,
    });
    await mongoose.models.MediaJob.updateOne(
      { ...scope, jobId: receipt.jobId },
      {
        $set: {
          phase: 'requires_attention',
          provider: {
            certainty,
            ...(certainty === 'submitted' ? { operationId: `operation-${key}` } : {}),
          },
          accounting: { phase: 'held', credits: 10 },
        },
      },
    );
    return (await media.getMediaJob(scope, receipt.jobId))!;
  }
  const command = (job: MediaStoredJob, request: Partial<MediaRecoveryRequest> = {}) => ({
    scope,
    jobId: job.jobId,
    actorId: 'operator',
    request: {
      clientRequestId: 'recovery-one',
      expectedVersion: job.version,
      evidence: 'Provider case 124: terminal invoice verified',
      action: 'settle' as const,
      terminalStatus: 'failed' as const,
      costUSD: 0.25,
      ...request,
    } as MediaRecoveryRequest,
    maxEvidenceChars: 200,
    maxDecisions: 3,
    now: now(),
  });

  async function legacy(text: string, thoughtSignature: string) {
    const job = await attention('legacy-native');
    const part = { continuationRef: 'legacy-native-part' };
    await mongoose.models.MediaJob.updateOne(
      { jobId: job.jobId },
      {
        $set: {
          executionOwner: 'chat',
          provider: { certainty: 'unknown' },
          nativeSource: { conversationId: 'saved-chat', messageId: 'assistant', modelRunId: 'run' },
          nativeLimits: { maxParts: 10, maxPartBytes: 1024, maxRecordingBytes: 4096 },
          nativePartKeys: [{ key: '0:0', fingerprint: 'legacy-fixture', bytes: 1 }],
          nativePartBytes: 1,
          nativeConsumers: ['saved-chat'],
          nativeRetentionState: 'live',
        },
        $unset: { accounting: 1, activeSlot: 1 },
      },
    );
    await mongoose.models.MediaPermit.deleteMany({ jobId: job.jobId });
    await mongoose.models.MediaNativePart.create({
      ...scope,
      ...part,
      jobId: job.jobId,
      chunkIndex: 0,
      partIndex: 0,
      fingerprint: 'legacy-fixture',
      createdAt: new Date(),
      part: { kind: 'text', text, thoughtSignature },
    });
    return { job: (await media.getMediaJob(scope, job.jobId))!, part };
  }

  it('commits one decision under concurrent identical retries and preserves the financial obligation', async () => {
    const job = await attention();
    await media.acquireMediaPermit({ scope, jobId: job.jobId, kind: 'deployment', capacity: 1 });
    const permits = await mongoose.models.MediaPermit.countDocuments({ jobId: job.jobId });
    const input = command(job);
    const [first, duplicate] = await Promise.all([
      recovery.resolveMediaRecovery(input),
      recovery.resolveMediaRecovery(input),
    ]);
    expect(first.version).toBe(duplicate.version);
    expect(first).toMatchObject({
      phase: 'reconciling',
      accounting: { phase: 'held', credits: 10 },
    });
    expect(first.recoveryDecisions).toHaveLength(1);
    expect(
      (await recovery.resolveMediaRecovery({ ...input, maxEvidenceChars: 4 })).recoveryDecisions,
    ).toHaveLength(1);
    expect(await mongoose.models.MediaPermit.countDocuments({ jobId: job.jobId })).toBe(permits);
    await mongoose.models.MediaJob.updateOne(
      { ...scope, jobId: job.jobId },
      { $set: { phase: 'failed' }, $inc: { version: 1 } },
    );
    expect((await recovery.resolveMediaRecovery(input)).phase).toBe('failed');
    await expect(
      recovery.resolveMediaRecovery({
        ...input,
        request: { ...input.request, evidence: 'Different evidence' },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('rejects competing decisions and active leases without clearing held funds', async () => {
    const job = await attention();
    const results = await Promise.allSettled([
      recovery.resolveMediaRecovery(command(job)),
      recovery.resolveMediaRecovery(command(job, { clientRequestId: 'another-command' })),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'version_conflict' },
    });
    const leased = await attention('leased');
    await mongoose.models.MediaJob.updateOne(
      { ...scope, jobId: leased.jobId },
      { $set: { leaseUntil: new Date(Date.now() + 60000).toISOString() } },
    );
    await expect(recovery.resolveMediaRecovery(command(leased))).rejects.toMatchObject({
      code: 'version_conflict',
    });
    expect((await media.getMediaJob(scope, leased.jobId))?.phase).toBe('requires_attention');
  });

  it('never resumes an unknown submission without an operation and bounds decision history', async () => {
    const job = await attention('unknown', 'unknown');
    await expect(
      recovery.resolveMediaRecovery(command(job, { action: 'resume' })),
    ).rejects.toMatchObject({ code: 'unsafe_retry' });
    await expect(
      recovery.resolveMediaRecovery({ ...command(job), maxEvidenceChars: 4 }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    const resolved = await recovery.resolveMediaRecovery(command(job));
    await mongoose.models.MediaJob.updateOne(
      { ...scope, jobId: job.jobId },
      { $set: { phase: 'requires_attention' } },
    );
    await expect(
      recovery.resolveMediaRecovery({
        ...command(resolved, { clientRequestId: 'second' }),
        maxDecisions: 1,
      }),
    ).rejects.toMatchObject({ code: 'capacity' });
    expect((await recovery.resolveMediaRecovery(command(job))).recoveryDecisions).toHaveLength(1);
  });

  it.each(['submitted', 'unsubmitted'] as const)(
    'resumes %s work without replacing its execution identity',
    async (certainty) => {
      const job = await attention('resumable', certainty);
      const resolved = await recovery.resolveMediaRecovery({
        ...command(job),
        request: {
          clientRequestId: 'resume-one',
          expectedVersion: job.version,
          evidence: 'Original execution credentials restored',
          action: 'resume',
        },
      });
      expect(resolved.phase).toBe(certainty === 'unsubmitted' ? 'queued' : 'reconciling');
      expect(resolved.execution).toEqual(job.execution);
      expect(resolved.provider).toEqual(job.provider);
      expect(resolved.jobId).toBe(job.jobId);
      expect(resolved.accounting).toEqual(job.accounting);
    },
  );

  it('returns a bounded current-tenant queue with no raw requests or private provider parts', async () => {
    const first = await attention('first');
    await attention('second');
    await mongoose.models.MediaJob.updateOne(
      { ...scope, jobId: first.jobId },
      {
        $set: {
          'provider.recovery': {
            parts: [{ text: 'Private output', thoughtSignature: 'secret-signature' }],
          },
        },
      },
    );
    const ownScope = scope;
    scope = { ...scope, tenantId: 'another-tenant' };
    await attention('other-tenant');
    const page = await recovery.listMediaRecoveryJobs({ tenantId: null, limit: 1 });
    const second = await recovery.listMediaRecoveryJobs({
      tenantId: null,
      limit: 1,
      cursor: page.nextCursor,
    });
    expect(page.items).toHaveLength(1);
    expect(second.items).toHaveLength(1);
    expect(second.items[0].jobId).not.toBe(page.items[0].jobId);
    expect(JSON.stringify([page, second])).not.toMatch(
      /Private prompt|Private output|secret-signature/,
    );
    expect(page.items[0]).not.toHaveProperty('request');
    await expect(recovery.resolveMediaRecovery({ ...command(first), scope })).rejects.toMatchObject(
      { code: 'not_found' },
    );
    await expect(
      tenantStorage.run({ tenantId: 'another-tenant' }, () =>
        recovery.listMediaRecoveryJobs({ tenantId: ownScope.tenantId, limit: 1 }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('completes a legacy native acknowledgement after a process restart without replaying generation', async () => {
    const { job, part } = await legacy('Known partial output', 'private-signature');
    const request = {
      clientRequestId: 'acknowledge-one',
      expectedVersion: job.version + 1,
      evidence: 'Native invocation ended; keep received parts',
      action: 'acknowledge' as const,
    };
    const current = (await media.getMediaJob(scope, job.jobId))!;
    request.expectedVersion = current.version;
    await recovery.resolveMediaRecovery({ ...command(current), request });
    expect(
      await media.claimMediaJob({ scope, workerId: 'worker', now: now(), leaseMs: 1000 }),
    ).toBeNull();
    native = createMediaNativeMethods(mongoose, media);
    await native.reconcileMediaNativeRecordings({
      scope,
      now: now(),
      staleBefore: new Date(Date.now() - 60000).toISOString(),
      limit: 10,
    });
    const finished = await media.getMediaJob(scope, job.jobId);
    expect(finished).toMatchObject({
      phase: 'failed',
      executionOwner: 'chat',
      outputs: [{ kind: 'text', text: 'Known partial output' }],
    });
    expect(
      await native.getMediaNativeContinuations({
        scope,
        references: [part],
        limit: 1,
        execution,
        conversationId: 'saved-chat',
      }),
    ).toMatchObject([{ part: { thoughtSignature: 'private-signature' } }]);
    expect(await mongoose.models.MediaPermit.countDocuments()).toBe(0);
    await expect(
      native.failMediaNativeRecording({
        scope,
        jobId: job.jobId,
        reason: 'provider',
        resolutionId: 'wrong-command',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('requires the exact credential binding, owner, model, and consumer for native continuation', async () => {
    const { part } = await legacy('Signed output', 'signature');
    const input = {
      scope,
      references: [part],
      limit: 1,
      execution,
      conversationId: 'saved-chat',
    };
    expect(await native.getMediaNativeContinuations(input)).toMatchObject([
      {
        part: { thoughtSignature: 'signature' },
      },
    ]);
    expect(
      await native.getMediaNativeContinuations({
        ...input,
        execution: { ...execution, bindingRevision: 'different-binding' },
      }),
    ).toEqual([null]);
    expect(
      await native.getMediaNativeContinuations({
        ...input,
        execution: { ...input.execution, modelId: 'other-model' },
      }),
    ).toEqual([null]);
    expect(
      await native.getMediaNativeContinuations({
        ...input,
        scope: { ...scope, ownerId: 'other-owner' },
      }),
    ).toEqual([null]);
    expect(
      await native.getMediaNativeContinuations({ ...input, conversationId: 'unregistered-chat' }),
    ).toEqual([null]);
  });
});
