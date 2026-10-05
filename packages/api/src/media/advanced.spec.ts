import sharp from 'sharp';
import multer from 'multer';
import path from 'node:path';
import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { FileSources, resolveMediaConfig, mediaPresetSchema } from 'librechat-data-provider';
import { createModels, createMethods, runAsSystem, tenantStorage } from '@librechat/data-schemas';
import type { AppConfig } from '@librechat/data-schemas';
import type { MediaRuntime } from './runtime';
import { createMediaAccounting } from './accounting';
import { createMediaRuntime } from './runtime';

const mockTitleInvoke = jest.fn(async () => ({
  content: 'A Quiet Observatory',
  usage_metadata: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
}));
jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  initializeModel: jest.fn(() => ({ invoke: mockTitleInvoke })),
}));

describe('advanced Studio on the published SDK image consumer', () => {
  let mongo: MongoMemoryServer;
  let directory: string;
  let png: Buffer;
  let db: ReturnType<typeof createMethods>;
  let runtime: MediaRuntime;
  let app: express.Express;
  let config: AppConfig;
  let scope: { ownerId: string; tenantId: null };
  let paidImages = 0;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    createModels(mongoose);
    db = createMethods(mongoose);
    directory = await mkdtemp(path.join(tmpdir(), 'media-advanced-'));
    png = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'white' } })
      .png()
      .toBuffer();
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
    await rm(directory, { recursive: true, force: true });
  });
  afterEach(async () => {
    await runtime?.worker.stop();
  });
  beforeEach(async () => {
    await Promise.all(
      Object.values(mongoose.models).map((model) => model.collection.deleteMany({})),
    );
    mockTitleInvoke.mockClear();
    paidImages = 0;
    scope = { ownerId: new mongoose.Types.ObjectId().toString(), tenantId: null };
    await mongoose.models.User.collection.insertOne({
      _id: new mongoose.Types.ObjectId(scope.ownerId),
      role: 'USER',
    });
    await mongoose.models.Balance.collection.insertOne({
      user: new mongoose.Types.ObjectId(scope.ownerId),
      tokenCredits: 1_000_000,
    });
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
      endpoints: {
        custom: [
          {
            name: 'Fixture',
            apiKey: 'fixture-key',
            baseURL: 'http://127.0.0.1:9/v1',
            tokenConfig: { 'fixture-title': { prompt: 2, completion: 4, context: 1000 } },
          },
        ],
      },
      media: resolveMediaConfig({
        enabled: true,
        titles: { endpoint: 'Fixture', model: 'fixture-title' },
        integrations: [
          {
            id: 'images',
            api: 'openai.images',
            endpointRef: { kind: 'custom', name: 'Fixture' },
            catalog: { kind: 'configured', models: ['gpt-image-1'] },
            operations: ['image.generate', 'image.edit'],
            billing: { maxCostUSD: 0.25 },
          },
        ],
      }),
    };
    runtime = createMediaRuntime({
      appConfig: config,
      repository: db,
      getUserById: async () => ({ role: 'USER' }),
      getRoleByName: async () => ({ permissions: { MEDIA: { USE: true, CREATE: true } } }),
      getAppConfig: async () => config,
      tenantContext: tenantStorage,
      asSystem: runAsSystem,
      environment: {},
      decrypt: async (value) => value,
      upload: multer,
      transport: {
        async json(_input, schema) {
          paidImages++;
          return schema.parse({
            data: [{ b64_json: png.toString('base64') }],
            usage: {
              input_tokens: 1,
              input_tokens_details: { text_tokens: 1, image_tokens: 0 },
              output_tokens: 1,
            },
          });
        },
        async stream() {
          return Readable.from(png);
        },
      },
      accounting: createMediaAccounting({ repository: db, pricing: db, now: Date.now }),
      titles: {
        db,
        admission: db,
        usage: {
          spendTokens: db.spendTokens,
          spendStructuredTokens: db.spendStructuredTokens,
          pricing: db,
          bulkWriteOps: { insertMany: db.bulkInsertTransactions, updateBalance: db.updateBalance },
        },
      },
      log: () => undefined,
    });
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: scope.ownerId, role: 'USER' } as Express.User;
      next();
    });
    app.use('/api/media/assets', runtime.contentRouter);
    app.use('/api/media', runtime.router);
  });

  async function submit(id: string, extra: Record<string, unknown> = {}) {
    const catalog = (await request(app).get('/api/media/catalog').expect(200)).body;
    return (
      await request(app)
        .post('/api/media/submissions')
        .send({
          clientRequestId: id,
          operation: 'image.generate',
          prompt: 'A quiet observatory',
          selection: {
            connectionId: 'images',
            modelId: 'gpt-image-1',
            catalogVersion: catalog.version,
          },
          ...extra,
        })
        .expect(202)
    ).body as { jobId: string; threadId: string; turnId: string };
  }
  async function run(jobId: string) {
    const job = await db.claimMediaJob({
      scope,
      workerId: 'advanced-worker',
      now: new Date(Date.now() + 1_000),
      leaseMs: 120_000,
    });
    expect(job?.jobId).toBe(jobId);
    if (!job) throw new Error('Expected queued job');
    await runtime.worker.runJob(job);
    const finished = await db.getMediaJob(scope, jobId);
    expect({ phase: finished?.phase, error: finished?.error }).toMatchObject({
      phase: 'succeeded',
    });
    return finished!;
  }
  async function preset(fileId: string) {
    return mediaPresetSchema.parse(
      (
        await request(app)
          .post('/api/media/presets')
          .send({
            title: 'Reference',
            settings: {
              operation: 'image.edit',
              connectionId: 'images',
              modelId: 'gpt-image-1',
              inputs: [{ role: 'reference', file_id: fileId }],
            },
          })
          .expect(201)
      ).body,
    );
  }

  it('saves uploaded references independently of a Studio thread and releases the last consumer', async () => {
    const fileId = (
      await request(app)
        .post('/api/media/uploads')
        .attach('file', png, { filename: 'reference.png', contentType: 'image/png' })
        .expect(201)
    ).body.file.file_id as string;
    const saved = await preset(fileId);
    expect(saved.assets).toEqual([expect.objectContaining({ file_id: fileId })]);
    const imported = (
      await request(app)
        .post('/api/media/imports')
        .send({ clientRequestId: 'import', inputs: [{ role: 'reference', file_id: fileId }] })
        .expect(202)
    ).body;
    await request(app).delete(`/api/media/threads/${imported.threadId}`).expect(202);
    await db.reconcileMediaRetirements({ scope, limit: 10 });
    await request(app).get(saved.assets[0].filepath).expect(200);
    expect(await db.listMediaPresets({ ...scope, tenantId: 'foreign' })).toEqual([]);
    expect(
      await db.listMediaPresets({ ...scope, ownerId: new mongoose.Types.ObjectId().toString() }),
    ).toEqual([]);
    await request(app).delete(`/api/media/presets/${saved.presetId}`).expect(200);
    expect(
      await db.claimMediaAssetDeletion({ scope, fileId, token: 'last-consumer' }),
    ).not.toBeNull();
    expect(paidImages).toBe(0);
  });

  it('persists comparison turns and chained input while charging only one paid title per thread', async () => {
    const first = await submit('compare-one', { comparisonId: 'comparison' });
    const second = await submit('compare-two', {
      comparisonId: 'comparison',
      threadId: first.threadId,
    });
    const generated = await run(first.jobId);
    await run(second.jobId);
    const output = generated.outputs[0];
    if (output.kind !== 'image' || !output.asset) throw new Error('Expected an image original');
    const asset = output.asset;
    const chained = await submit('chain', {
      threadId: first.threadId,
      parentTurnId: first.turnId,
      operation: 'image.edit',
      inputs: [{ role: 'reference', file_id: asset.file_id }],
    });
    await run(chained.jobId);
    const restored = (await request(app).get(`/api/media/threads/${first.threadId}`).expect(200))
      .body;
    expect(restored.thread.title).toBe('A Quiet Observatory');
    expect(
      restored.turns.items.filter(
        (turn: { comparisonId?: string }) => turn.comparisonId === 'comparison',
      ),
    ).toHaveLength(2);
    expect(
      restored.turns.items.find((turn: { turnId: string }) => turn.turnId === chained.turnId)
        .inputs,
    ).toEqual([{ role: 'reference', file_id: asset.file_id }]);
    expect(mockTitleInvoke).toHaveBeenCalledTimes(1);
    expect(
      await mongoose.models.Transaction.countDocuments({ context: 'title', user: scope.ownerId }),
    ).toBeGreaterThan(0);
    expect(
      await mongoose.models.Transaction.countDocuments({
        mediaJobId: { $in: [first.jobId, second.jobId, chained.jobId] },
        user: scope.ownerId,
      }),
    ).toBe(3);
    expect(paidImages).toBe(3);
  }, 45_000);

  it.each(['current', 'legacy'] as const)(
    'freezes a %s temporary deadline through retry, generated File retention and saved presets',
    async (version) => {
      const first = await submit('temporary', { temporary: true });
      const original = await db.getMediaJob(scope, first.jobId);
      expect(original?.temporary).toBe(true);
      expect(original?.publicationExpiresAt).toBeInstanceOf(Date);
      if (version === 'legacy') {
        await mongoose.models.MediaJob.updateOne(
          { jobId: first.jobId },
          { $unset: { temporary: 1 } },
        );
      }
      await request(app).post(`/api/media/jobs/${first.jobId}/cancel`).expect(200);
      const retried = (
        await request(app)
          .post(`/api/media/jobs/${first.jobId}/retry`)
          .send({ clientRequestId: 'temporary-retry' })
          .expect(202)
      ).body;
      expect((await db.getMediaJob(scope, retried.jobId))?.publicationExpiresAt).toEqual(
        original?.publicationExpiresAt,
      );
      if (version === 'legacy') {
        await mongoose.models.MediaJob.updateOne(
          { jobId: retried.jobId },
          { $unset: { temporary: 1 } },
        );
      }
      const generated = await run(retried.jobId);
      const output = generated.outputs[0];
      if (output.kind !== 'image' || !output.asset) throw new Error('Expected an image original');
      const fileId = output.asset.file_id;
      const saved = await preset(fileId);
      await request(app).delete(`/api/media/threads/${first.threadId}`).expect(202);
      await db.reconcileMediaRetirements({ scope, limit: 10 });
      const file = await mongoose.models.File.collection.findOne({ file_id: fileId });
      expect(file?.mediaHardExpiresAt).toEqual(original?.publicationExpiresAt);
      expect(file?.expiredAt).toEqual(original?.publicationExpiresAt);
      expect((await request(app).get('/api/media/threads').expect(200)).body.items).toEqual([]);
      expect(mockTitleInvoke).not.toHaveBeenCalled();
      await mongoose.models.File.collection.updateOne(
        { file_id: fileId },
        { $set: { mediaHardExpiresAt: new Date(0) } },
      );
      expect((await db.listMediaPresets(scope))[0]).toMatchObject({
        presetId: saved.presetId,
        assets: [],
      });
    },
  );
});
