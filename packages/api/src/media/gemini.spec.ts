import sharp from 'sharp';
import multer from 'multer';
import path from 'node:path';
import mongoose from 'mongoose';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods, tenantStorage, runAsSystem } from '@librechat/data-schemas';
import {
  FileSources,
  EModelEndpoint,
  resolveMediaConfig,
  mediaSubmissionRequestSchema,
} from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { MediaContext } from './context';
import type { MediaRuntime } from './runtime';
import { createMediaAccounting } from './accounting';
import { createMediaRuntime } from './runtime';

describe('Gemini Studio continuation', () => {
  let mongo: MongoMemoryServer;
  let directory: string;
  let runtime: MediaRuntime;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    createModels(mongoose);
    directory = await mkdtemp(path.join(tmpdir(), 'media-gemini-studio-'));
  });
  afterAll(async () => {
    await runtime?.worker.stop();
    await mongoose.disconnect();
    await mongo.stop();
    await rm(directory, { recursive: true, force: true });
  });

  it('replays private provider signatures with owned original bytes while public views exclude them', async () => {
    const ownerId = new mongoose.Types.ObjectId().toString();
    const scope = { ownerId, tenantId: null };
    await mongoose.models.User.collection.insertOne({
      _id: new mongoose.Types.ObjectId(ownerId),
      role: 'USER',
    });
    const db = createMethods(mongoose);
    const media = resolveMediaConfig({
      enabled: true,
      integrations: [
        {
          id: 'gemini',
          api: 'google.generateContent',
          endpointRef: { kind: 'builtin', endpoint: EModelEndpoint.google },
          catalog: { kind: 'configured', models: ['gemini-3.1-flash-image'] },
          operations: ['image.generate', 'image.edit'],
        },
      ],
    });
    const appConfig: AppConfig = {
      config: {},
      fileStrategy: FileSources.local,
      imageOutputType: 'png',
      media,
      transactions: { enabled: false },
      balance: { enabled: false },
      paths: {
        uploads: path.join(directory, 'uploads'),
        imageOutput: path.join(directory, 'images'),
        publicPath: directory,
      },
    };
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'white' } })
      .png()
      .toBuffer();
    const sent: Array<{
      contents: Array<{
        role: string;
        parts: Array<{
          text?: string;
          thoughtSignature?: string;
          inlineData?: { mimeType: string; data: string };
        }>;
      }>;
    }> = [];
    const errors: string[] = [];
    runtime = createMediaRuntime({
      appConfig,
      repository: db,
      tenantContext: tenantStorage,
      asSystem: runAsSystem,
      getUserById: async () => ({ role: 'USER' }),
      getRoleByName: async () => ({ permissions: { MEDIA: { USE: true, CREATE: true } } }),
      getAppConfig: async () => appConfig,
      environment: { GOOGLE_KEY: 'fixture-key' },
      decrypt: async (value) => value,
      upload: multer,
      accounting: createMediaAccounting({ repository: db, pricing: db, now: Date.now }),
      transport: {
        async json(input, schema) {
          expect(input.headers?.['x-goog-api-key']).toBe('fixture-key');
          sent.push(JSON.parse(String(input.body)));
          return schema.parse({
            candidates: [
              {
                content: {
                  parts: [
                    { text: 'A bright observatory', thoughtSignature: 'private-text-signature' },
                    {
                      inlineData: { mimeType: 'image/png', data: png.toString('base64') },
                      thoughtSignature: 'private-image-signature',
                    },
                  ],
                },
              },
            ],
          });
        },
        async stream() {
          throw new Error('Inline output must retain the original bytes');
        },
      },
      log: (message) => {
        errors.push(message);
      },
    });
    const context: MediaContext = {
      scope,
      appConfig,
      config: media,
      canUse: true,
      canCreate: true,
    };
    const catalog = await runtime.services.queries.catalog(context);
    const submission = mediaSubmissionRequestSchema.parse({
      clientRequestId: 'initial',
      operation: 'image.generate',
      prompt: 'An observatory',
      selection: {
        connectionId: 'gemini',
        modelId: 'gemini-3.1-flash-image',
        catalogVersion: catalog.version,
      },
    });
    const first = await runtime.services.commands.submit(submission, context);
    async function run(jobId: string) {
      const claimed = await db.claimMediaJob({
        scope,
        workerId: 'gemini-fixture',
        now: new Date(Date.now() + 1000),
        leaseMs: 120_000,
      });
      expect(claimed?.jobId).toBe(jobId);
      if (!claimed) throw new Error('Expected queued Gemini job');
      await runtime.worker.runJob(claimed);
      expect(await db.getMediaJob(scope, jobId)).toMatchObject({ phase: 'succeeded' });
    }
    await run(first.jobId);
    expect((await db.getMediaJob(scope, first.jobId))?.provider.recovery?.parts).toEqual([
      {
        kind: 'text',
        ordinal: 0,
        text: 'A bright observatory',
        thoughtSignature: 'private-text-signature',
      },
      expect.objectContaining({
        kind: 'image',
        ordinal: 1,
        fileId: expect.any(String),
        thoughtSignature: 'private-image-signature',
      }),
    ]);
    const publicView = await db.getMediaJobView(scope, first.jobId);
    expect(JSON.stringify(publicView)).not.toContain('private-');
    const second = await runtime.services.commands.submit(
      {
        ...submission,
        clientRequestId: 'follow-up',
        threadId: first.threadId,
        parentTurnId: first.turnId,
        prompt: 'Make it blue',
      },
      context,
    );
    await run(second.jobId);
    expect(sent[1].contents).toEqual([
      { role: 'user', parts: [{ text: 'An observatory' }] },
      {
        role: 'model',
        parts: [
          { text: 'A bright observatory', thoughtSignature: 'private-text-signature' },
          {
            inlineData: { mimeType: 'image/png', data: png.toString('base64') },
            thoughtSignature: 'private-image-signature',
          },
        ],
      },
      { role: 'user', parts: [{ text: 'Make it blue' }] },
    ]);
    expect(
      await db.getMediaParentContext(
        { ownerId, tenantId: 'other-tenant' },
        first.threadId,
        first.turnId,
      ),
    ).toBeNull();
    expect(errors).toEqual([]);
  });
});
