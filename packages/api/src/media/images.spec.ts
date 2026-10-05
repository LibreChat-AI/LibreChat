import sharp from 'sharp';
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
import type { AppConfig } from '@librechat/data-schemas';
import type { MediaRuntime } from './runtime';
import { createMediaAccounting } from './accounting';
import { createMediaRuntime } from './runtime';

/** First published-SDK consumer: HTTP/agent tools share billing, ownership and immutable File output. */
describe('image-and-tools vertical', () => {
  let mongo: MongoMemoryServer;
  let directory: string;
  let runtime: MediaRuntime;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    createModels(mongoose);
    directory = await mkdtemp(path.join(tmpdir(), 'media-images-tools-'));
  });
  afterAll(async () => {
    await runtime?.worker.stop();
    await mongoose.disconnect();
    await mongo.stop();
    await rm(directory, { recursive: true, force: true });
  });

  test('bills an image once, restores its tool receipt, and freezes the source chat deadline', async () => {
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
        queue: { maxQueueAgeMs: 7_200_000 },
        surfaces: { tools: true },
        tools: { imageTimeoutMs: 1 },
        integrations: [
          {
            id: 'images',
            api: 'openai.images',
            endpointRef: { kind: 'builtin', endpoint: EModelEndpoint.openAI },
            catalog: { kind: 'configured', models: ['gpt-image-1'] },
            operations: ['image.generate', 'image.edit'],
            billing: { maxCostUSD: 0.25 },
          },
        ],
      }),
    };
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'white' } })
      .png()
      .toBuffer();
    const clock: { now?: number } = {};
    let paidCalls = 0;
    let admissions = 0;
    const errors: string[] = [];
    runtime = createMediaRuntime({
      now: () => clock.now ?? Date.now(),
      appConfig: config,
      repository: db,
      getUserById: async () => ({ role: 'USER' }),
      getRoleByName: async () => ({ permissions: { MEDIA: { USE: true, CREATE: true } } }),
      getAppConfig: async () => config,
      tenantContext: tenantStorage,
      asSystem: runAsSystem,
      environment: { OPENAI_API_KEY: 'fixture-key' },
      decrypt: async (value) => value,
      transport: {
        async json(input, schema) {
          paidCalls++;
          expect(input.url).toBe('https://api.openai.com/v1/images/generations');
          expect(input.headers?.Authorization).toBe('Bearer fixture-key');
          return schema.parse({
            data: [{ b64_json: png.toString('base64') }],
            usage: {
              input_tokens: 10,
              input_tokens_details: { text_tokens: 10, image_tokens: 0 },
              output_tokens: 5,
            },
          });
        },
        async stream() {
          return Readable.from(png);
        },
      },
      upload: multer,
      accounting: createMediaAccounting({ repository: db, pricing: db, now: Date.now }),
      admission: {
        admitToolGeneration: async () => {
          admissions++;
        },
        checkBan: (_req, _res, next) => next(),
        generationLimiters: [],
        uploadLimiters: [],
      },
      log: (message) => {
        errors.push(message);
      },
    });
    const originalDeadline = new Date(Date.now() + 3_600_000);
    const origin = Object.assign(Object.create(express.request), {
      user: { id: ownerId, role: 'USER' },
      config,
      body: { isTemporary: false },
      _agentEventBindingRetention: { isTemporary: true, expiredAt: originalDeadline },
    });
    const [generate, status] = runtime.tools(origin);
    const call = {
      type: 'tool_call' as const,
      name: 'media_generate',
      id: 'image-call',
      args: {
        operation: 'image.generate',
        prompt: 'A small observatory',
        connectionId: 'images',
        modelId: 'gpt-image-1',
      },
    };
    const submitted = await generate.invoke(call, {
      metadata: { run_id: 'assistant-message', thread_id: 'conversation' },
    });
    const receipt = JSON.parse(String(submitted.content)).media as {
      jobId: string;
      threadId: string;
    };
    expect(admissions).toBe(1);
    const staged = await db.getMediaJob(scope, receipt.jobId);
    expect(staged).toMatchObject({
      temporary: true,
      publicationExpiresAt: originalDeadline,
      execution: {
        accountingMode: 'balance',
        tokenPricing: { source: 'imageTokenValues', prompt: 5, imagePrompt: 10, completion: 40 },
      },
    });
    const claimed = await db.claimMediaJob({
      scope,
      workerId: 'test-worker',
      now: new Date(Date.now() + 1000),
      leaseMs: 120_000,
    });
    expect(claimed?.jobId).toBe(receipt.jobId);
    if (!claimed) throw new Error('Expected claim');
    await runtime.worker.runJob(claimed);
    expect(await db.getMediaJob(scope, receipt.jobId)).toMatchObject({
      phase: 'succeeded',
      accounting: { phase: 'settled' },
    });
    const completed = await status.invoke({
      type: 'tool_call',
      name: 'media_status',
      id: 'status',
      args: { jobId: receipt.jobId },
    });
    const visible = JSON.parse(String(completed.content)) as {
      media: { phase: string };
      files: Array<{ file_id: string }>;
    };
    expect(visible.media.phase).toBe('succeeded');
    expect(visible.files).toHaveLength(1);
    const fileId = visible.files[0].file_id;
    expect(await mongoose.models.File.countDocuments({ file_id: fileId })).toBe(1);
    const file = await mongoose.models.File.collection.findOne({ file_id: fileId });
    expect(file?.expiresAt ?? file?.expiredAt).toEqual(originalDeadline);
    const balance = await mongoose.models.Balance.collection.findOne({
      user: new mongoose.Types.ObjectId(ownerId),
    });
    expect(balance?.tokenCredits).toBe(999_750);
    expect(balance?.mediaHeldCredits ?? 0).toBe(0);
    await generate.invoke(call, {
      metadata: { run_id: 'assistant-message', thread_id: 'conversation' },
    });
    expect(admissions).toBe(1);
    expect(paidCalls).toBe(1);
    expect((await db.getMediaThread(scope, receipt.threadId))?.temporary).toBe(true);
    const app = express();
    app.use((req, _res, next) => {
      req.user = { id: ownerId, role: 'USER' } as Express.User;
      next();
    });
    app.use('/api/media', runtime.router);
    app.use('/assets', runtime.contentRouter);
    const restored = await request(app).get(`/api/media/threads/${receipt.threadId}`).expect(200);
    expect(restored.body.thread.threadId).toBe(receipt.threadId);
    await request(app).get(`/assets/${fileId}/content`).expect(200);
    expect(
      await db.getMediaJobView(
        { ownerId: new mongoose.Types.ObjectId().toString(), tenantId: null },
        receipt.jobId,
      ),
    ).toBeNull();
    const queued = await generate.invoke(
      { ...call, id: 'expires-before-dispatch' },
      { metadata: { run_id: 'assistant-message', thread_id: 'conversation' } },
    );
    const queuedId = JSON.parse(String(queued.content)).media.jobId as string;
    clock.now = originalDeadline.getTime() + 1;
    const expired = await db.claimMediaJob({
      scope,
      workerId: 'expired-worker',
      now: new Date(clock.now),
      leaseMs: 120_000,
    });
    expect(expired?.jobId).toBe(queuedId);
    if (!expired) throw new Error('Expected expired queued job');
    await runtime.worker.runJob(expired);
    expect(await db.getMediaJob(scope, queuedId)).toMatchObject({
      phase: 'failed',
      error: { code: 'queue_expired' },
    });
    expect(paidCalls).toBe(1);
    expect(
      (
        await mongoose.models.Balance.collection.findOne({
          user: new mongoose.Types.ObjectId(ownerId),
        })
      )?.tokenCredits,
    ).toBe(999_750);
    expect(errors).toEqual([]);
  });
});
