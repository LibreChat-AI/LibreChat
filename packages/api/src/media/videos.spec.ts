import multer from 'multer';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { FileSources, EModelEndpoint, resolveMediaConfig } from 'librechat-data-provider';
import { createModels, createMethods, tenantStorage, runAsSystem } from '@librechat/data-schemas';
import type { MediaToolArtifact } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { MediaRuntime, MediaRuntimeDependencies } from './runtime';
import { mp4ReferenceFixture, webmReferenceFixture } from './__fixtures__/reference-content';
import { createMediaAccounting } from './accounting';
import { createMediaRuntime } from './runtime';

describe('provider video lifecycle', () => {
  let mongo: MongoMemoryServer;
  let directory: string;
  const runtimes: MediaRuntime[] = [];
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    createModels(mongoose);
    directory = await mkdtemp(path.join(tmpdir(), 'media-provider-video-'));
  });
  afterAll(async () => {
    await Promise.all(runtimes.map((runtime) => runtime.worker.stop()));
    await mongoose.disconnect();
    await mongo.stop();
    await rm(directory, { recursive: true, force: true });
  });

  it('returns a durable receipt, resumes the stored provider operation on a new runtime, and settles one saved video', async () => {
    const ownerId = new mongoose.Types.ObjectId().toString();
    const scope = { ownerId, tenantId: null };
    await mongoose.models.User.collection.insertOne({
      _id: new mongoose.Types.ObjectId(ownerId),
      role: 'USER',
    });
    await mongoose.models.Balance.collection.insertOne({
      user: new mongoose.Types.ObjectId(ownerId),
      tokenCredits: 1_000_000,
    });
    const db = createMethods(mongoose);
    const config: AppConfig = {
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
        surfaces: { tools: true },
        integrations: [
          {
            id: 'videos',
            api: 'openai.videos',
            endpointRef: { kind: 'builtin', endpoint: EModelEndpoint.openAI },
            catalog: { kind: 'configured', models: ['sora-2'] },
            operations: ['video.generate'],
            billing: { estimatedCostUSD: 0.05, maxCostUSD: 0.25 },
          },
          {
            id: 'runway',
            api: 'runway.videos',
            endpointRef: { kind: 'direct', apiKey: 'fixture-key' },
            catalog: { kind: 'configured', models: ['runway/aleph-2'] },
            operations: ['video.generate'],
            billing: { estimatedCostUSD: 0.05, maxCostUSD: 0.25 },
          },
        ],
      }),
    };
    let now = Date.now();
    let submissions = 0;
    let polls = 0;
    let downloads = 0;
    let admissions = 0;
    const errors: string[] = [];
    const video = mp4ReferenceFixture();
    const dependencies: MediaRuntimeDependencies = {
      now: () => now,
      appConfig: config,
      repository: db,
      getUserById: async () => ({ role: 'USER' }),
      getRoleByName: async () => ({ permissions: { MEDIA: { USE: true, CREATE: true } } }),
      getAppConfig: async () => config,
      tenantContext: tenantStorage,
      asSystem: runAsSystem,
      environment: { OPENAI_API_KEY: 'fixture-key' },
      decrypt: async (value) => value,
      upload: multer,
      accounting: createMediaAccounting({ repository: db, pricing: db, now: () => now }),
      admission: {
        admitToolGeneration: async () => {
          admissions++;
        },
        checkBan: (_req, _res, next) => next(),
        generationLimiters: [],
        uploadLimiters: [],
      },
      transport: {
        async json(input, schema) {
          expect(input.headers?.Authorization).toBe('Bearer fixture-key');
          if (input.method === 'POST') {
            submissions++;
            expect(input.url).toBe('https://api.openai.com/v1/videos');
            expect(input.body).toBeInstanceOf(FormData);
            expect((input.body as FormData).get('model')).toBe('sora-2');
            expect((input.body as FormData).get('seconds')).toBe('4');
            return schema.parse({ id: 'provider-video', status: 'queued' });
          }
          polls++;
          expect(input.url).toBe('https://api.openai.com/v1/videos/provider-video');
          return schema.parse({ id: 'provider-video', status: 'completed' });
        },
        async stream(input) {
          if (input.publicOnly) {
            expect(input.headers).toEqual({});
            if (input.url === 'https://media.example/reference.webm')
              return Readable.from(webmReferenceFixture());
            expect(input.url).toBe('https://media.example/reference.mp4');
            return Readable.from(video);
          }
          downloads++;
          expect(input.url).toBe('https://api.openai.com/v1/videos/provider-video/content');
          expect(input.headers?.Authorization).toBe('Bearer fixture-key');
          return Readable.from(video);
        },
      },
      log: (message) => {
        errors.push(message);
      },
    };
    const first = createMediaRuntime(dependencies);
    runtimes.push(first);
    const origin = Object.assign(Object.create(express.request), {
      user: { id: ownerId, role: 'USER' },
      config,
      body: {},
    });
    const call = {
      type: 'tool_call' as const,
      name: 'media_generate',
      id: 'video-call',
      args: {
        operation: 'video.generate',
        prompt: 'An observatory under moving stars',
        connectionId: 'videos',
        modelId: 'sora-2',
        parameters: { durationSeconds: 4 },
      },
    };
    const metadata = { run_id: 'assistant-message', thread_id: 'conversation' };
    const [generate] = first.tools(origin);
    const response = await generate.invoke(call, { metadata });
    const artifact = response.artifact as MediaToolArtifact;
    expect(artifact).toMatchObject({
      media: { phase: 'queued', operation: 'video.generate' },
      files: [],
    });
    expect(submissions).toBe(0);
    expect(admissions).toBe(1);
    const receipt = artifact.media;
    async function claim(runtime: MediaRuntime) {
      const stored = await db.getMediaJob(scope, receipt.jobId);
      now = Math.max(now + 1, stored?.dueAt?.getTime() ?? now);
      const claimed = await db.claimMediaJob({
        scope,
        workerId: 'fixture-worker',
        now: new Date(now),
        leaseMs: 120_000,
      });
      expect(claimed?.jobId).toBe(receipt.jobId);
      if (!claimed) throw new Error('Expected a due job');
      await runtime.worker.runJob(claimed);
    }
    await claim(first);
    expect(await db.getMediaJob(scope, receipt.jobId)).toMatchObject({
      phase: 'running',
      provider: { certainty: 'submitted', operationId: 'provider-video' },
    });
    expect(submissions).toBe(1);
    expect(polls).toBe(0);

    const restored = createMediaRuntime(dependencies);
    runtimes.push(restored);
    await claim(restored);
    expect(await db.getMediaJob(scope, receipt.jobId)).toMatchObject({
      phase: 'succeeded',
      accounting: { phase: 'settled' },
    });
    const [restoredGenerate, status] = restored.tools(origin);
    const result = await status.invoke({
      type: 'tool_call',
      name: 'media_status',
      id: 'video-status',
      args: { jobId: receipt.jobId },
    });
    const completed = result.artifact as MediaToolArtifact;
    expect(completed).toMatchObject({
      media: { ...receipt, phase: 'succeeded' },
      files: [{ type: 'video/mp4', bytes: video.length }],
    });
    const fileId = completed.files[0].file_id;
    expect(await mongoose.models.File.countDocuments({ file_id: fileId })).toBe(1);
    expect(
      (
        await mongoose.models.Balance.collection.findOne({
          user: new mongoose.Types.ObjectId(ownerId),
        })
      )?.tokenCredits,
    ).toBe(950_000);
    await restoredGenerate.invoke(call, { metadata });
    expect(admissions).toBe(1);
    expect({ submissions, polls, downloads }).toEqual({ submissions: 1, polls: 1, downloads: 1 });

    let activeOwner = ownerId;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: activeOwner, role: 'USER' } as Express.User;
      next();
    });
    app.use('/api/media', restored.router);
    app.use('/assets', restored.contentRouter);
    await request(app).get(`/api/media/threads/${receipt.threadId}`).expect(200);
    const download = await request(app).get(`/assets/${fileId}/content`).expect(200);
    expect(download.headers['content-type']).toContain('video/mp4');
    const range = await request(app)
      .get(`/assets/${fileId}/content`)
      .set('Range', 'bytes=0-7')
      .expect(206);
    expect(range.headers['content-range']).toBe(`bytes 0-7/${video.length}`);
    const uploaded = await request(app)
      .post('/api/media/uploads/url')
      .send({
        url: 'https://media.example/reference.mp4',
        role: 'video',
      })
      .expect(201);
    expect(uploaded.body).toMatchObject({
      sourceURL: 'https://media.example/reference.mp4',
      file: { type: 'video/mp4', bytes: video.length },
    });
    expect(await db.getMediaAsset(scope, uploaded.body.file.file_id)).not.toBeNull();
    const webm = await request(app)
      .post('/api/media/uploads/url')
      .send({ url: 'https://media.example/reference.webm', role: 'video' })
      .expect(201);
    expect(webm.body.file.type).toBe('video/webm');
    const catalog = await request(app).get('/api/media/catalog').expect(200);
    const jobsBefore = await mongoose.models.MediaJob.countDocuments({ ownerId });
    await request(app)
      .post('/api/media/submissions')
      .send({
        clientRequestId: 'unsupported-webm',
        operation: 'video.generate',
        prompt: 'Edit this clip',
        inputs: [{ file_id: webm.body.file.file_id, role: 'video' }],
        parameters: { count: 1 },
        selection: {
          connectionId: 'runway',
          modelId: 'runway/aleph-2',
          catalogVersion: catalog.body.version,
        },
      })
      .expect(422);
    expect(await mongoose.models.MediaJob.countDocuments({ ownerId })).toBe(jobsBefore);
    expect(submissions).toBe(1);
    const queued = await restoredGenerate.invoke(
      { ...call, id: 'cancel-before-dispatch' },
      { metadata },
    );
    const queuedId = (queued.artifact as MediaToolArtifact).media.jobId;
    const cancelled = await request(app).post(`/api/media/jobs/${queuedId}/cancel`).expect(200);
    expect(cancelled.body.phase).toBe('cancelled');
    expect(submissions).toBe(1);
    activeOwner = new mongoose.Types.ObjectId().toString();
    await request(app).get(`/api/media/jobs/${receipt.jobId}`).expect(404);
    await request(app).get(`/assets/${fileId}/content`).expect(404);
    expect(
      await db.getMediaJobView({ ownerId, tenantId: 'other-tenant' }, receipt.jobId),
    ).toBeNull();
    expect(errors).toEqual([]);
  });
});
