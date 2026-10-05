import sharp from 'sharp';
import multer from 'multer';
import path from 'node:path';
import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { mkdtemp, rm, mkdir, writeFile, utimes, stat } from 'node:fs/promises';
import {
  FileSources,
  resolveMediaConfig,
  mediaCatalogSchema,
  mediaSubmissionReceiptSchema,
} from 'librechat-data-provider';
import {
  createModels,
  createMethods,
  createMediaMethods,
  createMediaNativeMethods,
  createMediaPresetMethods,
  createMediaTitleMethods,
  createMediaAccountingMethods,
  runAsSystem,
  tenantStorage,
} from '@librechat/data-schemas';
import type {
  AppConfig,
  MediaMethods,
  KeyMethods,
  MediaNativeMethods,
  MediaPresetMethods,
  MediaTitleMethods,
} from '@librechat/data-schemas';
import type { MediaLifecycleEvent } from './telemetry';
import type { MediaTransport } from './transport';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { createMediaAccounting } from './accounting';
import { createMediaRuntime } from './runtime';
import { MediaActivityStream } from './events';
import { MediaProviderError } from './errors';
import * as mediaTitle from './title';

interface HeldSubmission {
  release(): void;
  aborted: boolean;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('media worker admission with standalone MongoDB', () => {
  let mongo: MongoMemoryServer;
  let directory: string;
  let original: Buffer;
  let repository: Pick<KeyMethods, 'getUserKeySnapshot'> &
    MediaMethods &
    MediaNativeMethods &
    MediaPresetMethods &
    MediaTitleMethods;
  let config: AppConfig;
  let runtime: ReturnType<typeof createMediaRuntime>;
  let accounting: ReturnType<typeof createMediaAccounting>;
  let app: express.Express;
  let currentOwner: string;
  let logged: Error[] = [];
  let observations: MediaLifecycleEvent[] = [];
  let telemetryFailure = false;
  let clock: number | undefined;
  let onObservation: ((event: MediaLifecycleEvent) => void) | undefined;
  let submissionChanged = deferred();
  let leader = true;
  let submissions: HeldSubmission[] = [];
  let holdSubmissions = true;
  let restartRuntime: () => void;
  let eventTransport: InMemoryEventTransport | undefined;
  let remote:
    | {
        status: string;
        submissions: number;
        deletes: number;
        afterDelete?: string;
        deleteError?: boolean;
        diagnostic?: { code: string; message: string };
      }
    | undefined;

  const transport: MediaTransport = {
    async json(input, schema) {
      if (remote) {
        const runway = config.media!.integrations[0].api === 'runway.videos';
        if (input.method === 'POST') {
          remote.submissions++;
          return schema.parse(runway ? { id: 'remote-job' } : { job_id: 'remote-job' });
        }
        if (input.method === 'DELETE') {
          remote.deletes++;
          if (remote.status === 'missing') {
            throw new MediaProviderError('rejected', 404);
          }
          remote.status = remote.afterDelete ?? remote.status;
          if (remote.deleteError) {
            remote.deleteError = false;
            throw new MediaProviderError('uncertain', 503, 'lost_cancellation_acknowledgement');
          }
          return schema.parse({});
        }
        if (remote.status === 'missing') throw new MediaProviderError('rejected', 404);
        if (remote.status === 'unavailable') throw new MediaProviderError('uncertain', 503);
        return schema.parse(
          runway
            ? {
                id: 'remote-job',
                status: remote.status,
                ...(remote.diagnostic
                  ? {
                      failureCode: remote.diagnostic.code,
                      failure: remote.diagnostic.message,
                      cost: { credits: 0 },
                    }
                  : {}),
              }
            : {
                job_id: 'remote-job',
                status: remote.status,
                ...(remote.status === 'completed'
                  ? { result: { urls: ['https://cdn.example/image.png'] } }
                  : {}),
              },
        );
      }
      if (!input.url.endsWith('/images/generations')) {
        throw new MediaProviderError('rejected', 404, 'fixture_route');
      }
      const held: HeldSubmission = { release: () => undefined, aborted: false };
      submissions.push(held);
      submissionChanged.resolve();
      submissionChanged = deferred();
      if (holdSubmissions) {
        await new Promise<void>((resolve, reject) => {
          held.release = resolve;
          input.signal?.addEventListener(
            'abort',
            () => {
              held.aborted = true;
              reject(new Error('The fixture request was aborted.'));
            },
            { once: true },
          );
        });
      }
      return schema.parse({ data: [{ b64_json: original.toString('base64') }] });
    },
    async stream() {
      if (remote?.status === 'completed') return Readable.from([original]);
      throw new MediaProviderError('rejected', 404, 'fixture_route');
    },
  };

  const owner = () => new mongoose.Types.ObjectId().toString();
  const waitForSubmissions = async (count: number) => {
    while (submissions.length < count) await submissionChanged.promise;
  };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    createModels(mongoose);
    const mediaMethods = createMediaMethods(mongoose, { ownerExists: async () => true });
    repository = {
      getUserKeySnapshot: createMethods(mongoose).getUserKeySnapshot,
      ...mediaMethods,
      ...createMediaNativeMethods(mongoose, mediaMethods),
      ...createMediaPresetMethods(mongoose),
      ...createMediaTitleMethods(mongoose),
    };
    await repository.ensureMediaIndexes();
    await repository.ensureMediaPresetIndexes();
    directory = await mkdtemp(path.join(tmpdir(), 'librechat-media-worker-'));
    original = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#abc' } })
      .png()
      .toBuffer();
  }, 60000);

  afterAll(async () => {
    await runtime?.worker.stop();
    await mongoose.disconnect();
    await mongo.stop();
    await rm(directory, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await Promise.all(
      Object.values(mongoose.models).map((model) => model.collection.deleteMany({})),
    );
    logged = [];
    observations = [];
    telemetryFailure = false;
    leader = true;
    submissions = [];
    submissionChanged = deferred();
    clock = undefined;
    onObservation = undefined;
    holdSubmissions = true;
    remote = undefined;
    eventTransport = undefined;
    currentOwner = owner();
    config = {
      config: {},
      fileStrategy: FileSources.local,
      imageOutputType: 'png',
      transactions: { enabled: false },
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
            endpointRef: { kind: 'custom', name: 'Fixture' },
            catalog: { kind: 'configured', models: ['gpt-image-1'] },
            operations: ['image.generate'],
          },
        ],
      }),
      endpoints: {
        custom: [{ name: 'Fixture', apiKey: 'fixture-secret', baseURL: 'http://provider.test/v1' }],
      },
    };
    accounting = createMediaAccounting({
      repository: createMediaAccountingMethods(mongoose),
      now: Date.now,
    });
    restartRuntime = () => {
      runtime = createMediaRuntime({
        now: () => clock ?? Date.now(),
        eventTransport,
        isLeader: async () => leader,
        observer: (event) => {
          observations.push(event);
          onObservation?.(event);
          if (telemetryFailure) throw new Error('export unavailable');
        },
        appConfig: config,
        repository,
        getUserById: async () => ({ role: 'USER' }),
        getRoleByName: async () => ({ permissions: { MEDIA: { USE: true, CREATE: true } } }),
        getAppConfig: async () => config,
        tenantContext: tenantStorage,
        asSystem: runAsSystem,
        environment: {},
        decrypt: async (value) => value,
        transport,
        upload: multer,
        accounting,
        titles: {
          db: {
            getUserKey: async () => {
              throw new Error('Unexpected title key lookup');
            },
            getUserKeyValues: async () => {
              throw new Error('Unexpected title key lookup');
            },
          },
        },
        log: (message, error) => {
          logged.push(new Error(message, { cause: error }));
        },
      });
      app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.user = { id: currentOwner, role: 'USER' } as Express.User;
        next();
      });
      app.use('/api/media', runtime.router);
    };
    restartRuntime();
  });

  afterEach(() => {
    if (logged.length > 0) {
      throw new Error(
        `The media worker logged unexpected errors: ${logged.map((error) => error.message).join('; ')}`,
      );
    }
  });

  async function submitAs(ownerId: string, clientRequestId: string) {
    currentOwner = ownerId;
    const modelCatalog = config.media!.integrations[0].catalog;
    if (modelCatalog.kind !== 'configured') throw new Error('Expected configured fixture model');
    const catalog = mediaCatalogSchema.parse(
      (await request(app).get('/api/media/catalog').expect(200)).body,
    );
    const response = await request(app)
      .post('/api/media/submissions')
      .send({
        clientRequestId,
        prompt: `A study for ${clientRequestId}`,
        operation: config.media!.integrations[0].operations[0],
        selection: {
          connectionId: 'images',
          modelId: modelCatalog.models[0],
          catalogVersion: catalog.version,
        },
      })
      .expect(202);
    return mediaSubmissionReceiptSchema.parse(response.body);
  }

  async function run(ownerId: string, jobId: string, claimAt = Date.now() + 60_000) {
    const scope = { ownerId, tenantId: null };
    const job = await repository.claimMediaJob({
      scope,
      workerId: 'test-worker',
      now: new Date(claimAt).toISOString(),
      leaseMs: 120_000,
    });
    expect(job?.jobId).toBe(jobId);
    if (!job) {
      throw new Error('Expected claimable job');
    }
    await runtime.worker.runJob(job);
    return repository.getMediaJob(scope, jobId);
  }

  async function remoteJob(
    api: 'runway.videos' | 'krea.images',
    clientRequestId: string,
    runImmediately = true,
  ) {
    config.balance = { enabled: true };
    config.media!.integrations[0] = {
      ...config.media!.integrations[0],
      api,
      catalog: {
        kind: 'configured',
        models: [api === 'runway.videos' ? 'runway/gen-4.5' : 'krea/krea-2-large'],
      },
      operations: [api === 'runway.videos' ? 'video.generate' : 'image.generate'],
      billing: { estimatedCostUSD: 0.01, maxCostUSD: 0.02, creditsPerUSD: 1000 },
    };
    remote = {
      status: api === 'runway.videos' ? 'RUNNING' : 'processing',
      submissions: 0,
      deletes: 0,
    };
    await accounting.ensureReady();
    await mongoose.models.Balance.create({ user: currentOwner, tokenCredits: 1000 });
    const receipt = await submitAs(currentOwner, clientRequestId);
    if (runImmediately)
      expect(await run(currentOwner, receipt.jobId)).toMatchObject({
        phase: 'running',
        execution: { cancellation: 'best-effort' },
      });
    return receipt;
  }

  async function balance() {
    return mongoose.models.Balance.findOne({ user: currentOwner })
      .select('+reservedCredits')
      .lean();
  }

  it('stops polling a provider that never leaves running once the job needs attention', async () => {
    const receipt = await remoteJob('krea.images', 'never-finishes');
    const scope = { ownerId: currentOwner, tenantId: null };
    const created = (await repository.getMediaJob(scope, receipt.jobId))!.createdAt.getTime();
    clock = created + config.media!.recovery.attentionAfterMs;
    expect(await run(currentOwner, receipt.jobId, clock + 60_000)).toMatchObject({
      phase: 'requires_attention',
      error: { code: 'submission_uncertain' },
      provider: { certainty: 'submitted' },
    });
  });

  it('persists an HTTP rejection privately and logs only its redacted classification', async () => {
    const receipt = await submitAs(currentOwner, 'diagnostic-rejection');
    const json = jest.spyOn(transport, 'json').mockRejectedValueOnce(
      new MediaProviderError('rejected', 400, 'http_400', {
        status: 400,
        code: 'FAILED_PRECONDITION',
        message: 'The task field is not supported. fixture-secret',
        requestId: 'request-123',
      }),
    );
    try {
      expect(await run(currentOwner, receipt.jobId)).toMatchObject({
        phase: 'failed',
        error: { code: 'provider_rejected' },
        provider: {
          recovery: {
            diagnostic: {
              status: 400,
              code: 'FAILED_PRECONDITION',
              message: 'The task field is not supported. [redacted]',
              requestId: 'request-123',
            },
          },
        },
      });
      const failures = logged.splice(0);
      expect(failures).toHaveLength(1);
      expect(failures[0].message).toContain('http_400');
      expect(failures[0].cause).toMatchObject({ diagnostic: undefined });
      const publicJob = (await request(app).get(`/api/media/jobs/${receipt.jobId}`).expect(200))
        .body;
      expect(publicJob.error).toEqual({ code: 'provider_rejected' });
      expect(JSON.stringify(publicJob)).not.toMatch(
        /diagnostic|task field|fixture-secret|request-123/,
      );
    } finally {
      json.mockRestore();
    }
  });

  it.each(['before', 'after'] as const)(
    'recovers a definite submission rejection after a crash %s releasing its hold',
    async (crash) => {
      config.balance = { enabled: true };
      config.media!.integrations[0].billing = {
        estimatedCostUSD: 0.01,
        maxCostUSD: 0.02,
        creditsPerUSD: 1000,
      };
      await accounting.ensureReady();
      await mongoose.models.Balance.create({ user: currentOwner, tokenCredits: 1000 });
      const receipt = await submitAs(currentOwner, `rejection-release-${crash}`);
      const diagnostic = {
        status: 400,
        code: 'INVALID_ARGUMENT',
        message: 'Unsupported duration.',
      };
      const json = jest
        .spyOn(transport, 'json')
        .mockRejectedValueOnce(new MediaProviderError('rejected', 400, 'http_400', diagnostic));
      const release = accounting.release;
      const settle = jest.spyOn(accounting, 'settle');
      const interrupted = jest
        .spyOn(accounting, 'release')
        .mockImplementationOnce(async (...args) => {
          if (crash === 'after') await release(...args);
          throw new Error('Interrupted submission rejection release');
        });
      try {
        expect(await run(currentOwner, receipt.jobId)).toMatchObject({
          phase: 'reconciling',
          error: { code: 'provider_rejected' },
          provider: {
            certainty: 'terminal',
            recovery: { terminalStatus: 'failed', rejectedSubmission: true, diagnostic },
          },
        });
        expect(logged.splice(0)).toHaveLength(2);
        expect(await balance()).toMatchObject({
          tokenCredits: 1000,
          reservedCredits: crash === 'before' ? 20 : 0,
        });
        config.endpoints!.custom = [];
        config.media!.integrations = [];
        restartRuntime();
        expect(await run(currentOwner, receipt.jobId, Date.now() + 300_000)).toMatchObject({
          phase: 'failed',
          error: { code: 'provider_rejected' },
          provider: { recovery: { rejectedSubmission: true, diagnostic } },
        });
        expect(await balance()).toMatchObject({ tokenCredits: 1000, reservedCredits: 0 });
        expect(json).toHaveBeenCalledTimes(1);
        expect(settle).not.toHaveBeenCalled();
        expect(
          await mongoose.models.Transaction.countDocuments({ mediaJobId: receipt.jobId }),
        ).toBe(1);
        expect(
          await mongoose.models.Transaction.countDocuments({
            mediaJobId: receipt.jobId,
            tokenValue: { $lt: 0 },
          }),
        ).toBe(0);
      } finally {
        json.mockRestore();
        interrupted.mockRestore();
        settle.mockRestore();
      }
    },
  );

  it.each(['before', 'after'] as const)(
    'preserves terminal diagnostics across a crash %s settlement without polling again',
    async (crash) => {
      const receipt = await remoteJob('runway.videos', `diagnostic-recovery-${crash}`);
      remote!.status = 'FAILED';
      remote!.diagnostic = {
        code: 'INVALID_INPUT',
        message: 'Unsupported video duration. fixture-secret',
      };
      const diagnostic = {
        code: 'INVALID_INPUT',
        message: 'Unsupported video duration. [redacted]',
      };
      const settle = accounting.settle;
      const json = jest.spyOn(transport, 'json');
      const interrupted = jest
        .spyOn(accounting, 'settle')
        .mockImplementationOnce(async (...args) => {
          if (crash === 'after') await settle(...args);
          throw new Error('Interrupted provider failure settlement');
        });
      try {
        expect(await run(currentOwner, receipt.jobId)).toMatchObject({
          phase: 'ingesting',
          provider: { certainty: 'terminal', recovery: { terminalStatus: 'failed', diagnostic } },
        });
        expect(logged.splice(0)).toHaveLength(1);
        const requests = json.mock.calls.length;
        config.endpoints!.custom = [];
        config.media!.integrations = [];
        restartRuntime();
        expect(await run(currentOwner, receipt.jobId)).toMatchObject({
          phase: 'failed',
          error: { code: 'provider_rejected' },
          provider: { certainty: 'terminal', recovery: { terminalStatus: 'failed', diagnostic } },
        });
        expect(await balance()).toMatchObject({ tokenCredits: 1000, reservedCredits: 0 });
        expect(json).toHaveBeenCalledTimes(requests);
        expect(remote!.submissions).toBe(1);
        expect(await mongoose.models.MediaPermit.countDocuments({ jobId: receipt.jobId })).toBe(0);
      } finally {
        interrupted.mockRestore();
        json.mockRestore();
      }
    },
  );

  it('persists Krea cancellation across restarts and retains the hold until terminal confirmation', async () => {
    const receipt = await remoteJob('krea.images', 'cancel-krea');
    config.media!.cancellation.enabled = false;
    const response = await request(app).post(`/api/media/jobs/${receipt.jobId}/cancel`).expect(200);
    expect(response.body).toMatchObject({
      phase: 'running',
      cancellation: 'requested',
      allowedActions: { cancel: false, retry: false },
    });
    expect(await balance()).toMatchObject({ tokenCredits: 1000, reservedCredits: 20 });
    expect(await run(currentOwner, receipt.jobId)).toMatchObject({
      phase: 'running',
      provider: { cancellationAcknowledged: true },
    });
    expect(remote!.deletes).toBe(1);
    expect(await balance()).toMatchObject({ tokenCredits: 1000, reservedCredits: 20 });
    restartRuntime();
    await request(app).post(`/api/media/jobs/${receipt.jobId}/cancel`).expect(200);
    await run(currentOwner, receipt.jobId);
    expect(remote!.deletes).toBe(1);
    remote!.status = 'cancelled';
    expect(await run(currentOwner, receipt.jobId)).toMatchObject({
      phase: 'cancelled',
      provider: { recovery: { terminalStatus: 'cancelled', usage: { costUSD: 0 } } },
    });
    expect(
      (await request(app).get(`/api/media/jobs/${receipt.jobId}`).expect(200)).body,
    ).toMatchObject({
      cancellation: 'confirmed',
    });
    expect(await balance()).toMatchObject({ tokenCredits: 1000, reservedCredits: 0 });
    expect(await mongoose.models.MediaPermit.countDocuments({ jobId: receipt.jobId })).toBe(0);
    expect(remote!.submissions).toBe(1);
    expect(remote!.deletes).toBe(1);
    expect(observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'transition', phase: 'submitting', jobId: receipt.jobId }),
        expect.objectContaining({ kind: 'transition', phase: 'cancelled', jobId: receipt.jobId }),
        expect.objectContaining({ kind: 'settlement', result: 'completed', jobId: receipt.jobId }),
      ]),
    );
    expect(JSON.stringify(observations)).not.toMatch(
      /fixture-secret|A study for|thoughtSignature|base64/,
    );
  });

  it('completes provider work and settlement when every lifecycle observer throws', async () => {
    holdSubmissions = false;
    telemetryFailure = true;
    const receipt = await submitAs(currentOwner, 'observer-failure');
    expect(await run(currentOwner, receipt.jobId)).toMatchObject({ phase: 'succeeded' });
    expect(observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'attempt',
          result: 'started',
          queueWaitMs: expect.any(Number),
        }),
        expect.objectContaining({
          kind: 'transition',
          previousPhase: 'submitting',
          phase: 'ingesting',
        }),
        expect.objectContaining({ kind: 'settlement', result: 'completed' }),
        expect.objectContaining({ kind: 'attempt', result: 'completed', phase: 'succeeded' }),
      ]),
    );
  });

  it('preserves completed output and billing when provider completion wins cancellation', async () => {
    const receipt = await remoteJob('krea.images', 'completion-wins');
    await request(app).post(`/api/media/jobs/${receipt.jobId}/cancel`).expect(200);
    remote!.status = 'completed';
    const job = await run(currentOwner, receipt.jobId);
    expect(job).toMatchObject({ phase: 'succeeded', outputs: [{ kind: 'image', state: 'ready' }] });
    expect(
      (await request(app).get(`/api/media/jobs/${receipt.jobId}`).expect(200)).body.cancellation,
    ).toBeUndefined();
    expect(await balance()).toMatchObject({ tokenCredits: 990, reservedCredits: 0 });
    expect(remote!.deletes).toBe(0);
    expect(remote!.submissions).toBe(1);
  });

  it.each(['before', 'after'] as const)(
    'recovers durable outputs after a crash %s settlement without the revoked provider connection',
    async (crash) => {
      const receipt = await remoteJob('krea.images', `local-recovery-${crash}`);
      remote!.status = 'completed';
      const settle = accounting.settle;
      const json = jest.spyOn(transport, 'json');
      const stream = jest.spyOn(transport, 'stream');
      const interrupted = jest
        .spyOn(accounting, 'settle')
        .mockImplementationOnce(async (...args) => {
          if (crash === 'after') await settle(...args);
          throw new Error('Interrupted between output publication and final job acknowledgement');
        });
      try {
        expect(await run(currentOwner, receipt.jobId)).toMatchObject({
          phase: 'ingesting',
          provider: { certainty: 'terminal', recovery: { terminalStatus: 'completed' } },
          outputs: [{ kind: 'image', state: 'ready' }],
        });
        expect(logged.splice(0)).toHaveLength(1);
        const requests = json.mock.calls.length;
        const downloads = stream.mock.calls.length;
        config.endpoints!.custom = [];
        config.media!.integrations = [];
        restartRuntime();

        expect(await run(currentOwner, receipt.jobId)).toMatchObject({
          phase: 'succeeded',
          accounting: { phase: 'settled', credits: 10 },
          outputs: [{ kind: 'image', state: 'ready' }],
        });
        expect(await balance()).toMatchObject({ tokenCredits: 990, reservedCredits: 0 });
        expect(
          await mongoose.models.Transaction.countDocuments({ mediaJobId: receipt.jobId }),
        ).toBe(1);
        expect(await mongoose.models.MediaPermit.countDocuments({ jobId: receipt.jobId })).toBe(0);
        expect(
          await repository.prepareMediaAccountDeletion({
            scope: { ownerId: currentOwner, tenantId: null },
            token: 'delete-after-local-recovery',
          }),
        ).toBe(true);
        expect(json).toHaveBeenCalledTimes(requests);
        expect(stream).toHaveBeenCalledTimes(downloads);
        expect(remote!.submissions).toBe(1);
      } finally {
        interrupted.mockRestore();
        json.mockRestore();
        stream.mockRestore();
      }
    },
  );

  it('defers Krea mutation until the provider enters a cancellable lifecycle state', async () => {
    const receipt = await remoteJob('krea.images', 'deferred-krea');
    await request(app).post(`/api/media/jobs/${receipt.jobId}/cancel`).expect(200);
    remote!.status = 'backlogged';
    const deferred = await run(currentOwner, receipt.jobId);
    expect(deferred?.provider.cancellationAttemptedAt).toBeUndefined();
    expect(remote!.deletes).toBe(0);
    remote!.status = 'processing';
    expect((await run(currentOwner, receipt.jobId))?.provider.cancellationAcknowledged).toBe(true);
    expect(remote!.deletes).toBe(1);
    expect(await balance()).toMatchObject({ tokenCredits: 1000, reservedCredits: 20 });
  });

  it('polls Krea after an uncertain cancellation without repeating an unverified mutation', async () => {
    const receipt = await remoteJob('krea.images', 'uncertain-krea');
    await request(app).post(`/api/media/jobs/${receipt.jobId}/cancel`).expect(200);
    remote!.deleteError = true;
    const attempted = await run(currentOwner, receipt.jobId);
    expect(attempted?.provider.cancellationAttemptedAt).toBeDefined();
    expect(attempted?.provider.cancellationAcknowledged).toBeUndefined();
    expect(logged.splice(0)).toHaveLength(1);
    restartRuntime();
    await run(currentOwner, receipt.jobId);
    expect(remote!.deletes).toBe(1);
    expect(await balance()).toMatchObject({ tokenCredits: 1000, reservedCredits: 20 });
    remote!.status = 'cancelled';
    expect((await run(currentOwner, receipt.jobId))?.phase).toBe('cancelled');
    expect(await balance()).toMatchObject({ tokenCredits: 1000, reservedCredits: 0 });
    expect(remote!.submissions).toBe(1);
  });

  it('retries Runway cancellation idempotently after a lost acknowledgement and retains unknown liability', async () => {
    const receipt = await remoteJob('runway.videos', 'uncertain-runway');
    await request(app).post(`/api/media/jobs/${receipt.jobId}/cancel`).expect(200);
    remote!.deleteError = true;
    remote!.afterDelete = 'missing';
    await run(currentOwner, receipt.jobId);
    expect(logged.splice(0)).toHaveLength(1);
    restartRuntime();
    expect(await run(currentOwner, receipt.jobId)).toMatchObject({
      phase: 'requires_attention',
      provider: { certainty: 'terminal', recovery: { terminalStatus: 'cancelled' } },
      error: { code: 'not_ready' },
    });
    expect(
      (await request(app).get(`/api/media/jobs/${receipt.jobId}`).expect(200)).body,
    ).toMatchObject({
      cancellation: 'confirmed',
      allowedActions: { cancel: false, retry: false },
    });
    expect(await balance()).toMatchObject({ tokenCredits: 1000, reservedCredits: 20 });
    expect(remote!.deletes).toBe(2);
    expect(remote!.submissions).toBe(1);
  });

  it('lets a second owner dispatch while the first owner saturates its own concurrency', async () => {
    config.media!.execution = {
      maxActivePerUser: 1,
      maxActivePerIntegration: 2,
      maxActiveTotal: 2,
    };
    const ownerA = owner();
    const ownerB = owner();
    const [a1, a2, a3] = [
      await submitAs(ownerA, 'a-1'),
      await submitAs(ownerA, 'a-2'),
      await submitAs(ownerA, 'a-3'),
    ];
    const b1 = await submitAs(ownerB, 'b-1');

    const first = run(ownerA, a1.jobId);
    await waitForSubmissions(1);
    for (const waiting of [a2, a3]) {
      expect(await run(ownerA, waiting.jobId)).toMatchObject({
        phase: 'queued',
        provider: { certainty: 'unsubmitted' },
      });
    }
    const second = run(ownerB, b1.jobId);
    await waitForSubmissions(2);

    const executionPermits = async () =>
      mongoose.models.MediaPermit.find({ kind: { $ne: 'queue' } }).lean<
        Array<{ kind: string; jobId: string }>
      >();
    const permits = await executionPermits();
    expect(
      permits
        .filter((permit) => permit.kind === 'deployment')
        .map((permit) => permit.jobId)
        .sort(),
    ).toEqual([a1.jobId, b1.jobId].sort());
    expect(permits.some((permit) => [a2.jobId, a3.jobId].includes(permit.jobId))).toBe(false);

    for (const held of submissions) {
      held.release();
    }
    expect((await first)?.phase).toBe('succeeded');
    expect((await second)?.phase).toBe('succeeded');
    expect(await executionPermits()).toEqual([]);
  });

  it('fails work that outlived the queue with a code that names expiry', async () => {
    clock = Date.now();
    config.media!.queue.maxQueueAgeMs = 1;
    const receipt = await submitAs(currentOwner, 'expired');
    const queued = await repository.getMediaJob(
      { ownerId: currentOwner, tenantId: null },
      receipt.jobId,
    );
    clock = queued!.createdAt.getTime() + 2;
    expect(await run(currentOwner, receipt.jobId)).toMatchObject({
      phase: 'failed',
      error: { code: 'queue_expired' },
      provider: { certainty: 'unsubmitted' },
    });
    expect(submissions).toHaveLength(0);
  });

  it('reconciles a reserved balance without submitting when queued cancellation wins dispatch', async () => {
    config.balance = { enabled: true };
    config.media!.integrations[0].billing = {
      estimatedCostUSD: 0.01,
      maxCostUSD: 0.02,
      creditsPerUSD: 1000,
    };
    await accounting.ensureReady();
    await mongoose.models.Balance.create({ user: currentOwner, tokenCredits: 1000 });
    const receipt = await submitAs(currentOwner, 'cancel-reserved');
    const reserve = accounting.reserve;
    const reservation = jest.spyOn(accounting, 'reserve').mockImplementation(async (...args) => {
      await reserve(...args);
      const cancelled = await request(app)
        .post(`/api/media/jobs/${receipt.jobId}/cancel`)
        .expect(200);
      expect(cancelled.body).toMatchObject({ phase: 'cancelled' });
    });
    try {
      expect(await run(currentOwner, receipt.jobId)).toMatchObject({
        phase: 'cancelled',
        provider: { certainty: 'unsubmitted' },
      });
    } finally {
      reservation.mockRestore();
    }
    expect(submissions).toHaveLength(0);
    const scope = { ownerId: currentOwner, tenantId: null };
    await accounting.reconcile(scope, config.media!);
    expect(
      await mongoose.models.Balance.findOne({ user: currentOwner })
        .select('+reservedCredits')
        .lean(),
    ).toMatchObject({ tokenCredits: 1000, reservedCredits: 0 });
    expect(await mongoose.models.MediaPermit.countDocuments({ jobId: receipt.jobId })).toBe(0);
  });

  it('rejects cancellation after dispatch without recording unsupported provider intent', async () => {
    const receipt = await submitAs(currentOwner, 'cancel-dispatched');
    const pending = run(currentOwner, receipt.jobId);
    await waitForSubmissions(1);
    try {
      const response = await request(app)
        .post(`/api/media/jobs/${receipt.jobId}/cancel`)
        .expect(409);
      expect(response.body).toMatchObject({ error: { code: 'cancel_unsupported' } });
      const job = await repository.getMediaJob(
        { ownerId: currentOwner, tenantId: null },
        receipt.jobId,
      );
      expect(job).toMatchObject({ phase: 'submitting', provider: { certainty: 'unknown' } });
      expect(job?.cancelRequestedAt).toBeUndefined();
      expect(submissions[0].aborted).toBe(false);
    } finally {
      submissions[0].release();
    }
    expect((await pending)?.phase).toBe('succeeded');
  });

  it('aborts the in-flight provider request when the worker stops and keeps its capacity reserved', async () => {
    const receipt = await submitAs(currentOwner, 'stopped');
    const pending = run(currentOwner, receipt.jobId);
    await waitForSubmissions(1);
    await runtime.worker.stop();
    const job = await pending;
    expect(submissions[0].aborted).toBe(true);
    expect(job).toMatchObject({ phase: 'submitting', provider: { certainty: 'unknown' } });
    const retained = await mongoose.models.MediaPermit.find({ jobId: receipt.jobId }).lean<
      Array<{ kind: string }>
    >();
    expect(retained.map((permit) => permit.kind).sort()).toEqual([
      'deployment',
      'integration',
      'owner',
      'queue',
    ]);
  });

  it('publishes the running provider job immediately and keeps its lease until the concurrent title settles', async () => {
    const title = deferred();
    const started = deferred();
    const running = deferred();
    const generate = jest.fn(async () => {
      started.resolve();
      await title.promise;
      return undefined;
    });
    jest.spyOn(mediaTitle, 'createMediaTitleGenerator').mockReturnValue(generate);
    restartRuntime();
    onObservation = (event) => {
      if (event.kind === 'transition' && event.phase === 'running') running.resolve();
    };
    const receipt = await remoteJob('krea.images', 'pending-title', false);
    const pending = run(currentOwner, receipt.jobId);
    try {
      await started.promise;
      await running.promise;
      expect(remote!.submissions).toBe(1);
      const scope = { ownerId: currentOwner, tenantId: null };
      const job = await repository.getMediaJob(scope, receipt.jobId);
      expect(job).toMatchObject({ phase: 'running', leaseToken: expect.any(String) });
      expect(
        await repository.claimMediaJob({
          scope,
          workerId: 'other-worker',
          now: new Date().toISOString(),
          leaseMs: 120_000,
        }),
      ).toBeNull();
      title.resolve();
      expect(await pending).toMatchObject({ phase: 'running' });
      expect((await repository.getMediaJob(scope, receipt.jobId))?.leaseToken).toBeUndefined();
      expect(generate).toHaveBeenCalledTimes(1);
    } finally {
      title.resolve();
      await pending;
      await runtime.worker.stop();
    }
  });

  it('aborts a title and drains its cleanup within the shutdown budget', async () => {
    const started = deferred();
    const aborted = deferred();
    const cleanup = deferred();
    jest.spyOn(mediaTitle, 'createMediaTitleGenerator').mockReturnValue(async ({ signal }) => {
      started.resolve();
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted.resolve();
            resolve();
          },
          { once: true },
        );
      });
      await cleanup.promise;
      return undefined;
    });
    restartRuntime();
    const receipt = await submitAs(currentOwner, 'title-shutdown');
    const pending = run(currentOwner, receipt.jobId);
    await waitForSubmissions(1);
    await started.promise;
    let stopped = false;
    const stopping = runtime.worker.stop({ budgetMs: 1_000 }).then(() => {
      stopped = true;
    });
    try {
      await aborted.promise;
      submissions[0].release();
      expect(stopped).toBe(false);
    } finally {
      cleanup.resolve();
      await stopping;
      await pending;
    }
    expect(stopped).toBe(true);
  });

  it('keeps title cleanup rejection out of the generation result', async () => {
    const failure = new Error('Title reservation release failed');
    jest.spyOn(mediaTitle, 'createMediaTitleGenerator').mockReturnValue(async () => {
      throw failure;
    });
    restartRuntime();
    const receipt = await submitAs(currentOwner, 'title-failure');
    const pending = run(currentOwner, receipt.jobId);
    await waitForSubmissions(1);
    submissions[0].release();
    expect((await pending)?.phase).toBe('succeeded');
    await runtime.worker.stop();
    expect(logged).toEqual([
      expect.objectContaining({ message: '[media] Title generation failed.', cause: failure }),
    ]);
    logged = [];
  });

  it('hands off a running job after title completion without waiting for activity delivery', async () => {
    const delivery = deferred();
    eventTransport = new InMemoryEventTransport();
    const publish = jest
      .spyOn(MediaActivityStream.prototype, 'publish')
      .mockReturnValue(delivery.promise);
    jest
      .spyOn(mediaTitle, 'createMediaTitleGenerator')
      .mockReturnValue(async () => 'A generated title');
    restartRuntime();
    try {
      const receipt = await remoteJob('krea.images', 'delayed-title-activity');
      expect(publish).toHaveBeenCalled();
      expect(
        (await repository.getMediaJob({ ownerId: currentOwner, tenantId: null }, receipt.jobId))
          ?.leaseToken,
      ).toBeUndefined();
    } finally {
      delivery.resolve();
      await runtime.worker.stop();
      runtime.closeActivity();
    }
  });

  it('prevents a prepared title from starting a paid invocation after pre-drain', async () => {
    const resolving = deferred();
    const resolved = deferred();
    const invoke = jest.fn().mockResolvedValue({ text: 'A generated title' });
    const generate = mediaTitle.createMediaTitleGenerator({
      repository,
      resolveModel: async () => {
        resolving.resolve();
        await resolved.promise;
        return { provider: 'openAI', clientOptions: { model: 'fixture-title' } };
      },
      withScope: async (_scope, operation) => operation(),
      invoke,
      log: jest.fn(),
    });
    jest.spyOn(mediaTitle, 'createMediaTitleGenerator').mockReturnValue(generate);
    config.media!.titles.endpoint = 'Fixture';
    config.media!.titles.model = 'fixture-title';
    restartRuntime();
    const receipt = await submitAs(currentOwner, 'prepared-title');
    const pending = run(currentOwner, receipt.jobId);
    await waitForSubmissions(1);
    await resolving.promise;
    await runtime.worker.prepareForShutdown();
    try {
      resolved.resolve();
      submissions[0].release();
      expect((await pending)?.phase).toBe('succeeded');
      await runtime.worker.stop();
      expect(invoke).not.toHaveBeenCalled();
      expect(
        (
          await repository.getMediaThread(
            { ownerId: currentOwner, tenantId: null },
            receipt.threadId,
          )
        )?.title,
      ).toBe('A study for prepared-title');
    } finally {
      resolved.resolve();
      submissions[0].release();
      await runtime.worker.stop();
    }
  });

  it('cancels concurrent title work before releasing the lease for provider cancellation', async () => {
    const started = deferred();
    const aborted = deferred();
    const running = deferred();
    jest.spyOn(mediaTitle, 'createMediaTitleGenerator').mockReturnValue(async ({ signal }) => {
      started.resolve();
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted.resolve();
            resolve();
          },
          { once: true },
        );
      });
      return undefined;
    });
    config.media!.worker.renewEveryMs = 10;
    restartRuntime();
    onObservation = (event) => {
      if (event.kind === 'transition' && event.phase === 'running') running.resolve();
    };
    const receipt = await remoteJob('krea.images', 'title-following-cancellation', false);
    const pending = run(currentOwner, receipt.jobId);
    try {
      await started.promise;
      await running.promise;
      await request(app).post(`/api/media/jobs/${receipt.jobId}/cancel`).expect(200);
      await aborted.promise;
      await pending;
      await run(currentOwner, receipt.jobId);
      expect(remote!.submissions).toBe(1);
    } finally {
      await runtime.worker.stop({ budgetMs: 100 });
    }
  });

  it('keeps account deletion fenced until terminal title accounting cleanup has drained', async () => {
    const started = deferred();
    const aborted = deferred();
    const cleanup = deferred();
    let accounted = false;
    jest.spyOn(mediaTitle, 'createMediaTitleGenerator').mockReturnValue(async ({ signal }) => {
      started.resolve();
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted.resolve();
            resolve();
          },
          { once: true },
        );
      });
      await cleanup.promise;
      accounted = true;
      return undefined;
    });
    restartRuntime();
    const receipt = await submitAs(currentOwner, 'title-account-deletion');
    const pending = run(currentOwner, receipt.jobId);
    await waitForSubmissions(1);
    await started.promise;
    submissions[0].release();
    const deletion = { scope: { ownerId: currentOwner, tenantId: null }, token: 'after-title' };
    try {
      await aborted.promise;
      expect(accounted).toBe(false);
      expect(await repository.prepareMediaAccountDeletion(deletion)).toBe(false);
      expect((await repository.getMediaJob(deletion.scope, receipt.jobId))?.phase).toBe(
        'ingesting',
      );
      cleanup.resolve();
      expect((await pending)?.phase).toBe('succeeded');
      expect(accounted).toBe(true);
      expect(await repository.prepareMediaAccountDeletion(deletion)).toBe(true);
    } finally {
      cleanup.resolve();
      await pending;
      await runtime.worker.stop();
    }
  });

  it('rescans a saturated page instead of skipping the owners after the break', async () => {
    config.media!.execution.maxActiveTotal = 1;
    config.media!.limits.pageSize = 2;
    config.media!.limits.maxPageSize = 2;
    config.media!.worker.tickMs = 5;
    const owners = [owner(), owner(), owner(), owner()].sort();
    for (const [index, ownerId] of owners.entries()) await submitAs(ownerId, `saturated-${index}`);
    const cursors: Array<string | undefined> = [];
    const list = repository.listDueMediaScopes;
    const scans = jest.spyOn(repository, 'listDueMediaScopes').mockImplementation(async (input) => {
      cursors.push(input.cursor);
      return list(input);
    });
    try {
      await runtime.worker.start();
      await waitForSubmissions(1);
      const seen = cursors.length;
      while (cursors.length < seen + 4) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(new Set(cursors)).toEqual(new Set([undefined]));
    } finally {
      submissions.forEach((submission) => submission.release());
      await runtime.worker.stop();
      scans.mockRestore();
    }
  });

  it('stops admitting work before drain while an existing paid request completes', async () => {
    config.media!.execution.maxActiveTotal = 1;
    config.media!.worker.tickMs = 5;
    const first = await submitAs(currentOwner, 'draining-first');
    const queued = await submitAs(currentOwner, 'draining-queued');
    const claims = jest.spyOn(repository, 'claimMediaJob');
    try {
      await runtime.worker.start();
      await waitForSubmissions(1);
      await runtime.worker.prepareForShutdown();
      expect(runtime.worker.available).toBe(false);
      expect(submissions[0].aborted).toBe(false);
      submissions[0].release();
      await runtime.worker.stop();
      const scope = { ownerId: currentOwner, tenantId: null };
      expect(await repository.getMediaJob(scope, first.jobId)).toMatchObject({
        phase: 'succeeded',
      });
      const pending = await repository.getMediaJob(scope, queued.jobId);
      expect(pending).toMatchObject({ phase: 'queued', provider: { certainty: 'unsubmitted' } });
      expect(pending?.leaseToken).toBeUndefined();
      expect(claims).toHaveBeenCalledTimes(1);
      expect(submissions).toHaveLength(1);
    } finally {
      submissions[0]?.release();
      await runtime.worker.stop();
      claims.mockRestore();
    }
  });

  it('aborts an active request within the remaining shutdown budget', async () => {
    config.media!.worker.shutdownTimeoutMs = 5_000;
    const receipt = await submitAs(currentOwner, 'shutdown-budget');
    await runtime.worker.start();
    await waitForSubmissions(1);
    const started = Date.now();
    try {
      await runtime.worker.stop({ budgetMs: 0 });
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(submissions[0].aborted).toBe(true);
      await runtime.worker.stop();
      expect(
        await repository.getMediaJob({ ownerId: currentOwner, tenantId: null }, receipt.jobId),
      ).toMatchObject({ phase: 'submitting', provider: { certainty: 'unknown' } });
    } finally {
      submissions[0]?.release();
      await runtime.worker.stop();
    }
  });

  it('returns a prepared but unsubmitted job to the queue after drain starts', async () => {
    const receipt = await submitAs(currentOwner, 'prepared-during-drain');
    const entered = deferred();
    const resumed = deferred();
    const prepare = runtime.services.prepare;
    const held = jest.spyOn(runtime.services, 'prepare').mockImplementation(async (...args) => {
      const prepared = await prepare(...args);
      entered.resolve();
      await resumed.promise;
      return prepared;
    });
    try {
      const pending = run(currentOwner, receipt.jobId);
      await entered.promise;
      await runtime.worker.prepareForShutdown();
      resumed.resolve();
      expect(await pending).toMatchObject({
        phase: 'queued',
        provider: { certainty: 'unsubmitted' },
      });
      expect(submissions).toHaveLength(0);
      expect(
        await repository.getMediaJob({ ownerId: currentOwner, tenantId: null }, receipt.jobId),
      ).not.toHaveProperty('leaseToken');
    } finally {
      resumed.resolve();
      held.mockRestore();
    }
  });

  it('waits for an admitted dispatch handoff before drain preparation returns', async () => {
    const receipt = await submitAs(currentOwner, 'dispatch-during-drain');
    const entered = deferred();
    const resumed = deferred();
    const begin = repository.beginMediaSubmission;
    const held = jest
      .spyOn(repository, 'beginMediaSubmission')
      .mockImplementation(async (input) => {
        const job = await begin(input);
        entered.resolve();
        await resumed.promise;
        return job;
      });
    try {
      const pending = run(currentOwner, receipt.jobId);
      await entered.promise;
      let prepared = false;
      const preparing = runtime.worker.prepareForShutdown().then(() => {
        prepared = true;
      });
      await Promise.resolve();
      expect(prepared).toBe(false);
      resumed.resolve();
      await preparing;
      expect(submissions).toHaveLength(1);
      expect(submissions[0].aborted).toBe(false);
      submissions[0].release();
      expect(await pending).toMatchObject({ phase: 'succeeded' });
    } finally {
      resumed.resolve();
      submissions[0]?.release();
      held.mockRestore();
    }
  });

  it('waits for post-abort permit cleanup within its reserved shutdown budget', async () => {
    const receipt = await submitAs(currentOwner, 'abort-cleanup');
    const entered = deferred();
    const resumed = deferred();
    const release = repository.releaseMediaPermits;
    const held = jest.spyOn(repository, 'releaseMediaPermits').mockImplementation(async (input) => {
      if (input.jobId === receipt.jobId) {
        entered.resolve();
        await resumed.promise;
      }
      return release(input);
    });
    try {
      const pending = run(currentOwner, receipt.jobId);
      await waitForSubmissions(1);
      let stopped = false;
      const stopping = runtime.worker.stop({ budgetMs: 1_000 }).then(() => {
        stopped = true;
      });
      await entered.promise;
      expect(submissions[0].aborted).toBe(true);
      expect(stopped).toBe(false);
      resumed.resolve();
      await stopping;
      await pending;
      expect(stopped).toBe(true);
    } finally {
      resumed.resolve();
      submissions[0]?.release();
      held.mockRestore();
    }
  });

  it('does not dispatch a database claim that finishes after shutdown returns', async () => {
    const receipt = await submitAs(currentOwner, 'claim-during-stop');
    config.media!.worker.shutdownTimeoutMs = 20;
    let release: () => void = () => undefined;
    const entered = deferred();
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const claim = repository.claimMediaJob;
    const delayed = jest.spyOn(repository, 'claimMediaJob').mockImplementation(async (input) => {
      entered.resolve();
      await held;
      return claim(input);
    });
    try {
      await runtime.worker.start();
      await entered.promise;
      await runtime.worker.stop();
      expect(runtime.worker.available).toBe(false);
      release();
      await runtime.worker.stop();
      expect(submissions).toHaveLength(0);
      const scope = { ownerId: currentOwner, tenantId: null };
      const queued = await repository.getMediaJob(scope, receipt.jobId);
      expect(queued).toMatchObject({ phase: 'queued', provider: { certainty: 'unsubmitted' } });
      expect(queued?.leaseToken).toBeUndefined();
      expect(queued?.leaseUntil).toBeUndefined();
      expect(
        await repository.claimMediaJob({
          scope,
          workerId: 'replacement-worker',
          now: new Date().toISOString(),
          leaseMs: 10_000,
        }),
      ).toMatchObject({ jobId: receipt.jobId, leaseOwner: 'replacement-worker' });
    } finally {
      release();
      await runtime.worker.stop();
      delayed.mockRestore();
    }
  });

  it('continues dispatching while maintenance discovery fails repeatedly', async () => {
    holdSubmissions = false;
    config.media!.worker.tickMs = 5;
    const maintenance = jest
      .spyOn(repository, 'listMediaCleanupScopes')
      .mockRejectedValue(new Error('Injected cleanup database failure'));
    try {
      const first = await submitAs(currentOwner, 'maintenance-outage-first');
      await runtime.worker.start();
      await waitForSubmissions(1);
      const second = await submitAs(currentOwner, 'maintenance-outage-second');
      await waitForSubmissions(2);
      await runtime.worker.stop();
      const scope = { ownerId: currentOwner, tenantId: null };
      expect(await repository.getMediaJob(scope, first.jobId)).toMatchObject({
        phase: 'succeeded',
      });
      expect(await repository.getMediaJob(scope, second.jobId)).toMatchObject({
        phase: 'succeeded',
      });
      expect(logged.length).toBeGreaterThan(0);
      expect(
        logged.every(
          (error) => error.message === '[media] The media worker could not discover cleanup work.',
        ),
      ).toBe(true);
    } finally {
      await runtime.worker.stop();
      maintenance.mockRestore();
      logged = [];
    }
  });

  it('cleans process-local staging on a follower without running repository maintenance', async () => {
    leader = false;
    const stage = path.join(directory, 'uploads', 'media-staging', 'stale-upload');
    await mkdir(path.dirname(stage), { recursive: true });
    await writeFile(stage, 'abandoned upload');
    const old = new Date(Date.now() - config.media!.assets.orphanRetentionMs - 60_000);
    await utimes(stage, old, old);
    const discovery = jest.spyOn(repository, 'listMediaCleanupScopes');
    try {
      await runtime.worker.start();
      await runtime.worker.prepareForShutdown();
      await expect(stat(stage)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(discovery).not.toHaveBeenCalled();
    } finally {
      await runtime.worker.stop();
      discovery.mockRestore();
    }
  });

  it('backs off failed polls durably and stops at the configured recovery attempt cap', async () => {
    const receipt = await remoteJob('krea.images', 'poll-backoff');
    config.media!.polling.providerIntervalMs = 100;
    config.media!.recovery.maxRetryMs = 1_000;
    config.media!.recovery.maxAttempts = 3;
    remote!.status = 'unavailable';
    try {
      const firstStartedAt = Date.now();
      const first = await run(currentOwner, receipt.jobId);
      expect(first).toMatchObject({ phase: 'running', recoveryFailures: 1 });
      expect(first!.dueAt.getTime()).toBeGreaterThanOrEqual(firstStartedAt + 100);
      restartRuntime();
      const secondStartedAt = Date.now();
      const second = await run(currentOwner, receipt.jobId);
      expect(second).toMatchObject({ phase: 'running', recoveryFailures: 2 });
      expect(second!.dueAt.getTime()).toBeGreaterThanOrEqual(secondStartedAt + 200);
      expect(await run(currentOwner, receipt.jobId)).toMatchObject({
        phase: 'requires_attention',
        recoveryFailures: 3,
      });
      expect(remote!.submissions).toBe(1);
      expect(await balance()).toMatchObject({ reservedCredits: 20 });
    } finally {
      logged = [];
    }
  });

  it('does not let a pending startup restart a stopped worker', async () => {
    let release: () => void = () => undefined;
    const entered = deferred();
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ensure = repository.ensureMediaIndexes;
    const delayed = jest.spyOn(repository, 'ensureMediaIndexes').mockImplementation(async () => {
      entered.resolve();
      await held;
      return ensure();
    });
    config.media!.worker.shutdownTimeoutMs = 20;
    try {
      const starting = runtime.worker.start();
      await entered.promise;
      await runtime.worker.stop();
      release();
      await starting;
      expect(runtime.worker.available).toBe(false);
      expect(submissions).toHaveLength(0);
    } finally {
      release();
      await runtime.worker.stop();
      delayed.mockRestore();
    }
  });

  it('reports repeated scan failure, recovery and pre-drain without a request readiness gate', async () => {
    config.media!.worker.tickMs = 10;
    config.media!.worker.scanFailureThreshold = 2;
    restartRuntime();
    const unavailable = deferred();
    const recovered = deferred();
    let recover = false;
    const scan = repository.listDueMediaScopes;
    const failing = jest.spyOn(repository, 'listDueMediaScopes').mockImplementation((input) => {
      if (!recover) return Promise.reject(new Error('scan unavailable'));
      return scan(input);
    });
    onObservation = (event) => {
      if (event.worker?.state === 'unavailable' && event.worker.consecutiveScanFailures >= 2)
        unavailable.resolve();
      if (recover && event.worker?.state === 'armed') recovered.resolve();
    };
    try {
      await runtime.worker.start();
      await unavailable.promise;
      expect(runtime.worker.health).toMatchObject({
        state: 'unavailable',
        consecutiveScanFailures: 2,
      });
      expect(runtime.worker.available).toBe(false);
      recover = true;
      await recovered.promise;
      expect(runtime.worker.health).toMatchObject({
        state: 'armed',
        consecutiveScanFailures: 0,
        lastScanAt: expect.any(String),
      });
      await runtime.worker.prepareForShutdown();
      expect(runtime.worker.health.state).toBe('draining');
    } finally {
      await runtime.worker.stop();
      failing.mockRestore();
      logged = [];
    }
    expect(runtime.worker.health.state).toBe('unavailable');
  });
});
