import multer from 'multer';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createModels,
  createMethods,
  tenantStorage,
  runAsSystem,
  SystemCapabilities,
} from '@librechat/data-schemas';
import {
  FileSources,
  resolveMediaConfig,
  mediaRecoveryPageSchema,
  mediaRecoveryJobSchema,
  mediaSubmissionRequestSchema,
} from 'librechat-data-provider';
import type {
  AppConfig,
  MediaStoredJob,
  IBalance,
  SystemCapability,
} from '@librechat/data-schemas';
import type { MediaRecoveryRequest } from 'librechat-data-provider';
import { generateCapabilityCheck } from '~/middleware/capabilities';
import { createAdminMediaRouter } from '~/admin/media';
import { createMediaAccounting } from './accounting';
import { createMediaRuntime } from './runtime';

describe('administrative media recovery through the API and worker', () => {
  let mongo: MongoMemoryServer;
  let directory: string;
  let repository: ReturnType<typeof createMethods>;
  let runtime: ReturnType<typeof createMediaRuntime>;
  let config: AppConfig;
  let ownerId: string;
  let app: express.Express;
  let grants: SystemCapability[];
  let tenantId: string | undefined;
  let auditFailure: 'pending' | 'success' | undefined;
  let recoveryFailure = false;
  const logs: Error[] = [];
  const network = jest.fn(async (): Promise<never> => {
    throw new Error('No provider requests are permitted in recovery fixtures');
  });
  const scope = () => ({ ownerId, tenantId: null });
  const billing = { creditsPerUSD: 1000, estimatedCostUSD: 0.2, maxCostUSD: 0.4 };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    createModels(mongoose);
    repository = createMethods(mongoose);
    await repository.ensureMediaIndexes();
    await repository.ensureMediaAccountingIndexes();
    directory = await mkdtemp(path.join(tmpdir(), 'librechat-media-recovery-'));
  }, 60000);
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
    await rm(directory, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await Promise.all(
      Object.values(mongoose.models).map((model) => model.collection.deleteMany({})),
    );
    ownerId = new mongoose.Types.ObjectId().toString();
    await mongoose.models.User.collection.insertOne({
      _id: new mongoose.Types.ObjectId(ownerId),
      tenantId: null,
      role: 'USER',
    });
    tenantId = undefined;
    grants = [SystemCapabilities.ACCESS_ADMIN, SystemCapabilities.MANAGE_MEDIA];
    logs.length = 0;
    auditFailure = undefined;
    recoveryFailure = false;
    network.mockClear();
    config = {
      config: {},
      fileStrategy: FileSources.local,
      imageOutputType: 'png',
      balance: { enabled: true },
      transactions: { enabled: true },
      paths: {
        uploads: path.join(directory, 'uploads'),
        imageOutput: path.join(directory, 'images'),
        publicPath: directory,
      },
      media: resolveMediaConfig({
        enabled: true,
        integrations: [
          {
            id: 'images',
            api: 'openai.images',
            endpointRef: { kind: 'custom', name: 'Removed credential' },
            catalog: { kind: 'configured', models: ['image-model'] },
            operations: ['image.generate'],
            billing,
          },
        ],
      }),
    };
    runtime = createMediaRuntime({
      appConfig: config,
      repository: {
        ...repository,
        resolveMediaRecovery: (...args) => {
          if (recoveryFailure) return Promise.reject(new Error('private database detail'));
          return repository.resolveMediaRecovery(...args);
        },
      },
      getUserById: async () => ({ role: 'USER' }),
      getRoleByName: async () => ({ permissions: { MEDIA: { USE: true, CREATE: true } } }),
      getAppConfig: async () => config,
      tenantContext: tenantStorage,
      asSystem: runAsSystem,
      environment: {},
      decrypt: async (value) => value,
      transport: { json: network, stream: network },
      upload: multer,
      accounting: createMediaAccounting({ repository, now: Date.now }),
      log: (message, error) => logs.push(new Error(message, { cause: error })),
    });
    app = express();
    app.use(express.json());
    app.use(
      '/api/admin/media',
      createAdminMediaRouter({
        services: runtime.recovery,
        requireJwtAuth(req, _res, next) {
          req.user = { id: 'operator', role: 'ADMIN', tenantId } as Express.User;
          next();
        },
        ...generateCapabilityCheck({
          getUserPrincipals: async () => [],
          hasCapabilityForPrincipals: async ({ capability }) =>
            grants.includes(capability) ||
            (capability === SystemCapabilities.READ_MEDIA &&
              grants.includes(SystemCapabilities.MANAGE_MEDIA)),
          getHeldCapabilities: async () => new Set(grants),
        }),
        recordAuditEntry: async (input, options) => {
          if (input.outcome === auditFailure) throw new Error('Audit store unavailable');
          return repository.recordAuditEntry(input, options);
        },
        log: (message, error) => logs.push(new Error(message, { cause: error })),
      }),
    );
    await mongoose.models.Balance.create({ user: ownerId, tokenCredits: 1000 });
  });
  afterEach(async () => {
    await runtime.worker.stop();
  });

  async function attention(): Promise<MediaStoredJob> {
    const submission = mediaSubmissionRequestSchema.parse({
      clientRequestId: 'one',
      prompt: 'Private unrecoverable prompt',
      operation: 'image.generate',
      selection: { connectionId: 'images', modelId: 'image-model', catalogVersion: 'v1' },
    });
    const receipt = await repository.stageMediaSubmission({
      scope: scope(),
      request: submission,
      execution: {
        ...submission.selection,
        api: 'openai.images',
        bindingRevision: 'unavailable-original-binding',
        accountingMode: 'balance',
        billing,
      },
      maxActiveJobs: 4,
      maxPendingTotal: 20,
    });
    await repository.publishMediaSubmission(scope(), receipt.jobId, {
      maxRetainers: 4,
      maxTitleChars: 30,
    });
    await repository.acquireMediaHold({
      scope: scope(),
      jobId: receipt.jobId,
      estimatedCredits: 200,
      maxCredits: 400,
      now: new Date().toISOString(),
      reviewAt: new Date(Date.now() + 60000).toISOString(),
      policy: config.media!.accounting,
    });
    await mongoose.models.MediaJob.updateOne(
      { ownerId, jobId: receipt.jobId },
      {
        $set: {
          phase: 'requires_attention',
          provider: {
            certainty: 'unknown',
            requestId: 'provider-receipt',
            recovery: {
              parts: [
                {
                  kind: 'text',
                  text: 'Private generated output',
                  thoughtSignature: 'secret-signature',
                },
              ],
            },
          },
        },
      },
    );
    return (await repository.getMediaJob(scope(), receipt.jobId))!;
  }
  const body = (job: MediaStoredJob, costUSD = 0.25): MediaRecoveryRequest => ({
    clientRequestId: 'operator-command',
    expectedVersion: job.version,
    action: 'settle',
    costUSD,
    terminalStatus: 'failed',
    evidence: 'Provider invoice case-124 confirms this exact final cost',
  });
  const post = (job: MediaStoredJob, command: MediaRecoveryRequest) =>
    request(app).post(`/api/admin/media/jobs/${ownerId}/${job.jobId}/recovery`).send(command);
  const balance = () =>
    mongoose.models.Balance.findOne({ user: ownerId })
      .select('+reservedCredits +mediaHolds')
      .lean<IBalance>();
  async function run(job: MediaStoredJob) {
    const claimed = await repository.claimMediaJob({
      scope: scope(),
      workerId: 'recovery-worker',
      now: new Date().toISOString(),
      leaseMs: 30000,
    });
    expect(claimed?.jobId).toBe(job.jobId);
    await runtime.worker.runJob(claimed!);
  }

  async function rejectedSubmission(): Promise<MediaStoredJob> {
    const job = await attention();
    await mongoose.models.MediaJob.updateOne(
      { ...scope(), jobId: job.jobId },
      {
        $set: {
          error: { code: 'provider_rejected' },
          provider: {
            certainty: 'terminal',
            recovery: {
              terminalStatus: 'failed',
              rejectedSubmission: true,
              diagnostic: { status: 400, message: 'Private provider rejection details.' },
            },
          },
        },
      },
    );
    return (await repository.getMediaJob(scope(), job.jobId))!;
  }

  it.each([false, true])(
    'resumes a rejected submission without credentials or charging after retirement=%s',
    async (retired) => {
      let job = await rejectedSubmission();
      config.media!.integrations = [];
      if (retired) {
        await repository.retireMediaThread(scope(), job.threadId);
        job = (await repository.getMediaJob(scope(), job.jobId))!;
      }
      const page = (await request(app).get('/api/admin/media/jobs').expect(200)).body;
      expect(mediaRecoveryPageSchema.parse(page).items[0].allowedActions.resume).toBe(true);
      expect(JSON.stringify(page)).not.toMatch(/rejectedSubmission|diagnostic|Private provider/);
      await post(job, {
        clientRequestId: 'resume-rejected-submission',
        expectedVersion: job.version,
        action: 'resume',
        evidence: 'The provider rejected submission; finish releasing the held credits.',
      }).expect(200);
      await run(job);
      expect(await repository.getMediaJob(scope(), job.jobId)).toMatchObject({
        phase: 'failed',
        error: { code: 'provider_rejected' },
        provider: { recovery: { rejectedSubmission: true } },
      });
      expect(await balance()).toMatchObject({ tokenCredits: 1000, reservedCredits: 0 });
      expect(
        await mongoose.models.Transaction.countDocuments({
          mediaJobId: job.jobId,
          tokenValue: { $ne: 0 },
        }),
      ).toBe(0);
      expect(network).not.toHaveBeenCalled();
      expect(logs).toEqual([]);
    },
  );

  it.each([false, true])(
    'honors an explicit cost override for a rejected submission across a later resume=%s',
    async (resume) => {
      const job = await rejectedSubmission();
      config.media!.integrations = [];
      await post(job, body(job, 0.25)).expect(200);
      if (resume) {
        jest
          .spyOn(repository, 'settleMediaJob')
          .mockResolvedValueOnce({ status: 'pending', settlementId: 'pending-fixture' });
        await run(job);
        expect(logs.splice(0)).toHaveLength(0);
        const pending = (await repository.getMediaJob(scope(), job.jobId))!;
        expect(pending.phase).toBe('requires_attention');
        await post(pending, {
          clientRequestId: 'resume-overridden-rejection',
          expectedVersion: pending.version,
          action: 'resume',
          evidence: 'The final cost is already recorded; complete its interrupted settlement.',
        }).expect(200);
      }
      await run(job);
      expect(await repository.getMediaJob(scope(), job.jobId)).toMatchObject({
        phase: 'failed',
        accounting: { phase: 'settled', credits: 250 },
      });
      expect(await balance()).toMatchObject({ tokenCredits: 750, reservedCredits: 0 });
      expect(await mongoose.models.Transaction.countDocuments({ mediaJobId: job.jobId })).toBe(1);
      expect(network).not.toHaveBeenCalled();
      expect(logs).toEqual([]);
    },
  );

  it.each([0, 0.25])(
    'settles a confirmed cost of %s exactly once without provider credentials and keeps a verifiable audit chain',
    async (costUSD) => {
      const job = await attention();
      const command = body(job, costUSD);
      expect(mediaRecoveryJobSchema.parse((await post(job, command).expect(200)).body).phase).toBe(
        'reconciling',
      );
      expect(await balance()).toMatchObject({ tokenCredits: 1000, reservedCredits: 400 });
      await run(job);
      expect(await repository.getMediaJob(scope(), job.jobId)).toMatchObject({
        phase: 'failed',
        accounting: { phase: 'settled', credits: costUSD * billing.creditsPerUSD },
      });
      expect(await balance()).toMatchObject({
        tokenCredits: 1000 - costUSD * billing.creditsPerUSD,
        reservedCredits: 0,
        mediaHolds: [],
      });
      expect(await mongoose.models.MediaPermit.countDocuments({ jobId: job.jobId })).toBe(0);
      expect(await mongoose.models.Transaction.countDocuments({ mediaJobId: job.jobId })).toBe(1);
      expect(mediaRecoveryJobSchema.parse((await post(job, command).expect(200)).body).phase).toBe(
        'failed',
      );
      expect(await mongoose.models.Transaction.countDocuments({ mediaJobId: job.jobId })).toBe(1);
      expect((await repository.getMediaJob(scope(), job.jobId))?.recoveryDecisions).toHaveLength(1);
      expect(await repository.verifyAuditChain(undefined)).toMatchObject({ ok: true });
      const audit = await repository.listAuditLogPage(undefined, { limit: 10 });
      expect(audit.entries.map((entry) => entry.outcome)).toEqual([
        'success',
        'success',
        'pending',
      ]);
      expect(JSON.stringify(audit)).not.toMatch(
        /Private unrecoverable|Private generated|secret-signature|unavailable-original-binding/,
      );
      expect(network).not.toHaveBeenCalled();
      expect(logs).toEqual([]);
    },
  );

  it('requires both capabilities before exposing job rows or accepting a command', async () => {
    const job = await attention();
    for (const held of [[SystemCapabilities.ACCESS_ADMIN], [SystemCapabilities.MANAGE_USERS], []]) {
      grants = held;
      await request(app).get('/api/admin/media/jobs').expect(403, { message: 'Forbidden' });
      await post(job, body(job)).expect(403, { message: 'Forbidden' });
    }
    const denied = (await repository.listAuditLogPage(undefined, { limit: 10 })).entries;
    expect(denied).toHaveLength(6);
    expect(denied.every((entry) => entry.outcome === 'denied')).toBe(true);
    expect((await repository.getMediaJob(scope(), job.jobId))?.phase).toBe('requires_attention');
  });

  it('recovers a lost accounting acknowledgement without charging twice or reacquiring credentials', async () => {
    const job = await attention();
    await post(job, body(job)).expect(200);
    const settle = repository.settleMediaJob;
    jest.spyOn(repository, 'settleMediaJob').mockImplementationOnce(async (input) => {
      await settle(input);
      throw new Error('Simulated disconnect after the settlement committed');
    });
    await run(job);
    expect(await balance()).toMatchObject({ tokenCredits: 750, reservedCredits: 0 });
    expect((await repository.getMediaJob(scope(), job.jobId))?.phase).toBe('ingesting');
    await mongoose.models.MediaJob.updateOne(
      { ...scope(), jobId: job.jobId },
      { $set: { dueAt: new Date().toISOString() } },
    );
    await run(job);
    expect((await repository.getMediaJob(scope(), job.jobId))?.phase).toBe('failed');
    expect(await balance()).toMatchObject({ tokenCredits: 750, reservedCredits: 0 });
    expect(await mongoose.models.Transaction.countDocuments({ mediaJobId: job.jobId })).toBe(1);
    expect(network).not.toHaveBeenCalled();
  });

  it('allows recovery readers to inspect jobs but requires manage:media for changes', async () => {
    const job = await attention();
    grants = [SystemCapabilities.ACCESS_ADMIN, SystemCapabilities.READ_MEDIA];
    await request(app)
      .get('/api/admin/media/capabilities')
      .expect(200, { canRead: true, canManage: false });
    await request(app).get('/api/admin/media/jobs').expect(200);
    await post(job, body(job)).expect(403);
    grants = [SystemCapabilities.ACCESS_ADMIN, SystemCapabilities.MANAGE_USERS];
    await request(app)
      .get('/api/admin/media/capabilities')
      .expect(200, { canRead: false, canManage: false });
    expect((await repository.getMediaJob(scope(), job.jobId))?.phase).toBe('requires_attention');
  });

  it('records a failed durable recovery write without exposing its exception text', async () => {
    const job = await attention();
    recoveryFailure = true;
    await post(job, body(job)).expect(500);
    const audit = await repository.listAuditLogPage(undefined, { limit: 10 });
    expect(audit.entries.map((entry) => entry.outcome)).toEqual(['failure', 'pending']);
    expect(JSON.stringify(audit)).not.toContain('private database detail');
  });

  it('resumes a completed local publication after its provider credential was removed', async () => {
    const job = await attention();
    const write = await repository.reserveMediaAssetWrite({
      scope: scope(),
      outputKey: `${job.jobId}:0`,
      rendition: 'original',
      ingestToken: 'completed-ingest',
      fingerprint: 'completed-output-digest',
      storageKey: `images/${ownerId}/completed.png`,
    });
    const asset = await repository.commitMediaAssetWrite({
      scope: scope(),
      writeId: write.writeId,
      content: {
        file_id: write.fileId,
        filename: 'completed.png',
        type: 'image/png',
        bytes: 32,
        filepath: `/${write.storageKey}`,
        source: FileSources.local,
        storageKey: write.storageKey,
        contentDigest: 'completed-output-digest',
      },
    });
    expect(asset).not.toBeNull();
    await repository.retainMediaThreadAsset({
      scope: scope(),
      threadId: job.threadId,
      fileId: write.fileId,
      maxRetainers: config.media!.limits.maxAssetRetainers,
    });
    await mongoose.models.MediaJob.updateOne(
      { ...scope(), jobId: job.jobId },
      {
        $set: {
          provider: {
            certainty: 'terminal',
            recovery: {
              terminalStatus: 'completed',
              usage: { costUSD: 0.25 },
              parts: [{ kind: 'image', ordinal: 0, type: 'image/png', fileId: write.fileId }],
            },
          },
          outputs: [
            { kind: 'image', outputId: `${job.jobId}:0`, ordinal: 0, state: 'ready', asset },
          ],
        },
      },
    );
    await repository.settleMediaJob({
      scope: scope(),
      jobId: job.jobId,
      effect: {
        kind: 'charge',
        credits: 250,
        costUSD: 0.25,
        creditsPerUSD: 1000,
        model: job.execution.modelId,
      },
      policy: config.media!.accounting,
    });
    const command: MediaRecoveryRequest = {
      clientRequestId: 'resume-local-publication',
      action: 'resume',
      evidence:
        'Provider completed and original is durably published; the provider key was revoked',
      expectedVersion: job.version,
    };
    await post(job, command).expect(200);
    await run(job);
    expect(await repository.getMediaJob(scope(), job.jobId)).toMatchObject({
      phase: 'succeeded',
      accounting: { phase: 'settled', credits: 250 },
      outputs: [{ kind: 'image', state: 'ready', asset: { file_id: write.fileId } }],
    });
    expect(await balance()).toMatchObject({ tokenCredits: 750, reservedCredits: 0 });
    expect(await mongoose.models.Transaction.countDocuments({ mediaJobId: job.jobId })).toBe(1);
    expect(network).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });

  it('still requires the original connection when a completed output needs downloading', async () => {
    const job = await attention();
    await mongoose.models.MediaJob.updateOne(
      { ...scope(), jobId: job.jobId },
      {
        $set: {
          provider: {
            certainty: 'terminal',
            recovery: {
              terminalStatus: 'completed',
              usage: { costUSD: 0.25 },
              parts: [
                {
                  kind: 'image',
                  ordinal: 0,
                  type: 'image/png',
                  url: 'https://provider.test/output.png',
                },
              ],
            },
          },
        },
      },
    );
    await post(job, {
      clientRequestId: 'missing-original',
      action: 'resume',
      expectedVersion: job.version,
      evidence: 'Original download has not been published',
    }).expect(422, { error: { code: 'not_ready' } });
    expect((await repository.getMediaJob(scope(), job.jobId))?.phase).toBe('requires_attention');
    expect(await balance()).toMatchObject({ tokenCredits: 1000, reservedCredits: 400 });
    expect(await mongoose.models.Transaction.countDocuments({ mediaJobId: job.jobId })).toBe(0);
    expect(network).not.toHaveBeenCalled();
  });

  it('returns only current-tenant safe rows and rejects cross-tenant commands', async () => {
    const job = await attention();
    const list = mediaRecoveryPageSchema.parse(
      (await request(app).get('/api/admin/media/jobs').expect(200)).body,
    );
    expect(list.items).toHaveLength(1);
    expect(list.items[0].allowedActions).toEqual({
      resume: false,
      settle: true,
      acknowledge: false,
    });
    expect(JSON.stringify(list)).not.toMatch(
      /Private unrecoverable|Private generated|secret-signature|unavailable-original-binding/,
    );
    tenantId = 'other-tenant';
    expect((await request(app).get('/api/admin/media/jobs').expect(200)).body.items).toEqual([]);
    await post(job, body(job)).expect(404, { error: { code: 'not_found' } });
  });

  it('fails closed before the transition when the pending audit cannot be recorded', async () => {
    const job = await attention();
    auditFailure = 'pending';
    await post(job, body(job)).expect(500);
    expect((await repository.getMediaJob(scope(), job.jobId))?.phase).toBe('requires_attention');
    expect((await repository.getMediaJob(scope(), job.jobId))?.recoveryDecisions).toBeUndefined();
    expect(await balance()).toMatchObject({ tokenCredits: 1000, reservedCredits: 400 });
  });

  it('replays a committed decision after success-audit failure and distinguishes changed bodies from stale versions', async () => {
    const job = await attention();
    const command = body(job);
    auditFailure = 'success';
    await post(job, command).expect(500);
    expect((await repository.getMediaJob(scope(), job.jobId))?.phase).toBe('reconciling');
    auditFailure = undefined;
    await post(job, command).expect(200);
    await post(job, { ...command, evidence: 'Changed reference' }).expect(409, {
      error: { code: 'request_conflict' },
    });
    await post(job, { ...command, clientRequestId: 'different-command' }).expect(409, {
      error: { code: 'version_conflict' },
    });
    expect((await repository.getMediaJob(scope(), job.jobId))?.recoveryDecisions).toHaveLength(1);
    await run(job);
    expect(await mongoose.models.Transaction.countDocuments({ mediaJobId: job.jobId })).toBe(1);
  });

  it('requires explicit supported cost and evidence and cannot resume an unknown provider attempt', async () => {
    const job = await attention();
    const command = body(job);
    await post(job, { ...command, evidence: '' }).expect(422);
    await post(job, {
      ...command,
      evidence: 'a'.repeat(config.media!.recovery.maxEvidenceChars + 1),
    }).expect(422);
    await post(job, body(job, Number.MAX_VALUE)).expect(422);
    await post(job, {
      clientRequestId: 'resume',
      expectedVersion: job.version,
      evidence: 'No durable operation identity',
      action: 'resume',
    }).expect(409, { error: { code: 'not_ready' } });
    expect((await repository.getMediaJob(scope(), job.jobId))?.phase).toBe('requires_attention');
    expect(network).not.toHaveBeenCalled();
  });
});
