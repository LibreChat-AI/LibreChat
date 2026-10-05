import axios from 'axios';
import sharp from 'sharp';
import multer from 'multer';
import path from 'node:path';
import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { createReadStream } from 'node:fs';
import { FileContext } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createNativeMessageMethods } from '@librechat/data-schemas';
import { CustomChatGoogleGenerativeAI } from '@librechat/agents/llm/google';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import {
  createModels,
  createMethods,
  createMediaMethods,
  createMediaNativeMethods,
  createMediaPresetMethods,
  createMediaAccountingMethods,
  createMediaTitleMethods,
  getTempChatRetentionHours,
  runAsSystem,
  tenantStorage,
} from '@librechat/data-schemas';
import {
  EModelEndpoint,
  FileSources,
  RetentionMode,
  resolveMediaConfig,
  mediaCatalogSchema,
  mediaPresetSchema,
  mediaPresetListSchema,
  mediaThreadSchema,
  mediaThreadDetailSchema,
  mediaAssetContextSchema,
  mediaSubmissionRequestSchema,
  mediaSubmissionReceiptSchema,
  mediaURLUploadResponseSchema,
  mediaJobSchema,
  mediaJobDiagnosticsResponseSchema,
} from 'librechat-data-provider';
import type {
  AppConfig,
  MediaMethods,
  KeyMethods,
  MediaNativeMethods,
  MediaPresetMethods,
  MediaOwnerScope,
  MediaTitleMethods,
} from '@librechat/data-schemas';
import type { NativeSignatures } from 'librechat-data-provider';
import type { Server } from 'node:http';
import type { MediaLifecycleEvent } from './telemetry';
import type { MediaFileStrategy } from './objects';
import { mp4ReferenceFixture } from './__fixtures__/reference-content';
import { createMediaStrategyObjectStores } from './objects';
import { saveGeneratedImage } from '~/files/generated';
import { createDeferredNativeMediaPort } from './sdk';
import { createMediaAccounting } from './accounting';
import { createMediaTransport } from './transport';
import { createMediaStorage } from './storage';
import { createMediaRuntime } from './runtime';

const fixtureEncryptionKey = randomBytes(32);
function encryptSavedCredential(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', fixtureEncryptionKey, iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `fixture:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')}`;
}
function decryptSavedCredential(value: string): string {
  if (!value.startsWith('fixture:')) return value;
  const data = Buffer.from(value.slice(8), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', fixtureEncryptionKey, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
}

describe('Media Studio HTTP and worker with standalone MongoDB', () => {
  let mongo: MongoMemoryServer;
  let provider: Server;
  let directory: string;
  let root: string;
  let original: Buffer;
  let posts = 0;
  let polls = 0;
  let providerHeaders: Array<{ authorization?: string; secret?: string }> = [];
  let routedBodies: string[] = [];
  let remoteReference: Buffer;
  let referenceReads = 0;
  let referenceHeaders: Array<{ authorization?: string; cookie?: string }> = [];
  let chatBodies: Array<{ model?: string; messages?: Array<{ content?: string }> }> = [];
  let chunkedReference = false;
  let referenceStatus = 200;
  let holdReference: ((response: express.Response) => void) | undefined;
  let holdGeneration: (() => Promise<void>) | undefined;
  const referenceURL = 'https://media-fixture.example/reference';
  let vertexToken = 'access-1';
  let vertexAuthorizations: Array<string | undefined> = [];
  let vertexBodies: unknown[] = [];
  const vertexApi = 'https://us-central1-aiplatform.googleapis.com/v1';
  const vertexModel = 'veo-3.1-fast-generate-001';
  const vertexOperation = `projects/test-project/locations/us-central1/publishers/google/models/${vertexModel}/operations/vertex-job-1`;
  let behavior: 'image' | 'uncertain' | 'rejected' | 'video' | 'unsafe-svg' | 'mislabeled' =
    'image';
  let accounting: ReturnType<typeof createMediaAccounting>;
  let nativeDownload: jest.MockedFunction<MediaFileStrategy['getDownloadStream']>;
  let repository: Pick<KeyMethods, 'getUserKeySnapshot'> &
    MediaMethods &
    MediaNativeMethods &
    ReturnType<typeof createNativeMessageMethods> &
    MediaPresetMethods &
    MediaTitleMethods;
  let scope: MediaOwnerScope;
  let config: AppConfig;
  let runtime: ReturnType<typeof createMediaRuntime>;
  let app: express.Express;
  let userRole = 'USER';
  let banned = false;
  let generationAdmissions = 0;
  let roleReads = 0;
  let uploadAdmissions = 0;
  let denyAdmission = false;
  const moderation = jest.fn(async (_inputs: readonly string[]) => false);
  let logged: Error[] = [];
  let lifecycleEvents: MediaLifecycleEvent[] = [];
  let storageState: object | null = null;
  let cloudStrategy: MediaFileStrategy;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    createModels(mongoose);
    const mediaMethods = createMediaMethods(mongoose, { ownerExists: async () => true });
    repository = {
      getUserKeySnapshot: createMethods(mongoose).getUserKeySnapshot,
      ...mediaMethods,
      ...createMediaNativeMethods(mongoose, mediaMethods),
      ...createNativeMessageMethods(mongoose),
      ...createMediaPresetMethods(mongoose),
      ...createMediaTitleMethods(mongoose),
    };
    await repository.ensureMediaIndexes();
    await repository.ensureMediaPresetIndexes();
    directory = await mkdtemp(path.join(tmpdir(), 'librechat-media-'));
    original = await sharp({ create: { width: 24, height: 16, channels: 4, background: '#cde' } })
      .png()
      .toBuffer();
    const api = express();
    api.use(express.json({ limit: '1mb' }));
    api.get('/v1/images/models', (_req, res) => {
      res.json({ data: [{ id: 'fixture/image', name: 'Fixture image' }] });
    });
    api.get('/v1/videos/models', (_req, res) => {
      res.json({ data: [{ id: 'bytedance/seedance-2.0', name: 'Hosted references' }] });
    });
    api.get('/v1/models', (_req, res) => {
      res.json({
        data: [
          {
            id: 'bytedance/seedance-2.0',
            architecture: { input_modalities: ['text', 'image', 'audio', 'video'] },
          },
        ],
      });
    });
    api.get('/v1/models/bytedance/seedance-2.0/endpoints', (_req, res) => {
      res.json({ data: { endpoints: [{ tag: 'seed' }] } });
    });
    api.get('/v1/reference', (req, res) => {
      referenceReads++;
      referenceHeaders.push({ authorization: req.get('authorization'), cookie: req.get('cookie') });
      if (referenceStatus !== 200) {
        res.status(referenceStatus).end();
        return;
      }
      // Type detection must rely on the bytes, even when the host declares an unrelated MIME type.
      res.type('text/plain');
      if (holdReference) {
        holdReference(res);
        return;
      }
      if (chunkedReference) {
        res.write(remoteReference);
        res.end();
      } else res.send(remoteReference);
    });
    api.get('/v1/images/models/fixture/image/endpoints', (_req, res) => {
      res.json({
        id: 'fixture/image',
        endpoints: ['provider-a', 'provider-b'].map((tag) => ({
          provider_tag: tag,
          provider_name: tag,
          supported_parameters: {
            n: { type: 'range', min: 1, max: 1 },
            input_references: { type: 'range', min: 0, max: 2 },
            quality: { type: 'enum', values: [tag === 'provider-a' ? 'draft' : 'high'] },
          },
          allowed_passthrough_parameters: ['strength'],
        })),
      });
    });
    api.post('/v1/images', (req, res) => {
      posts++;
      routedBodies.push(JSON.stringify(req.body));
      res.json({ data: [{ b64_json: original.toString('base64') }] });
    });
    api.post('/v1/images/generations', async (req, res) => {
      posts++;
      providerHeaders.push({
        authorization: req.get('authorization'),
        secret: req.get('x-extra-credential'),
      });
      if (behavior === 'uncertain') {
        res.status(503).json({ error: 'lost receipt' });
        return;
      }
      if (behavior === 'rejected') {
        res.status(400).json({ error: 'invalid request' });
        return;
      }
      if (behavior === 'unsafe-svg' || behavior === 'mislabeled') {
        const data =
          behavior === 'unsafe-svg'
            ? Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
            : original;
        res.json({
          data: [
            {
              b64_json: data.toString('base64'),
              media_type: behavior === 'unsafe-svg' ? 'image/svg+xml' : 'image/jpeg',
            },
          ],
          usage: { input_tokens: 3, output_tokens: 7 },
        });
        return;
      }
      await holdGeneration?.();
      res.json({ data: [{ b64_json: original.toString('base64') }] });
    });
    api.post('/v1/chat/completions', (req, res) => {
      chatBodies.push(req.body);
      res.json({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 0,
        model: req.body.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '"Small Observatory."' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      });
    });
    api.post('/v1/videos', (req, res) => {
      posts++;
      routedBodies.push(JSON.stringify(req.body));
      res.json({ id: 'operation-1', status: 'queued' });
    });
    api.get('/v1/videos/operation-1', (_req, res) => {
      polls++;
      res.json({ id: 'operation-1', status: 'completed' });
    });
    api.get('/v1/videos/operation-1/content', (_req, res) => {
      const header = Buffer.alloc(32);
      header.write('ftyp', 4);
      header.write('mp42', 8);
      res.type('video/mp4').send(header);
    });
    api.post(
      '/v1/projects/test-project/locations/us-central1/publishers/google/models/:action',
      (req, res) => {
        vertexAuthorizations.push(req.headers.authorization);
        if (req.params.action === `${vertexModel}:predictLongRunning`) {
          posts++;
          vertexBodies.push(req.body);
          res.json({
            name: vertexOperation.replace('vertex-job-1', `vertex-job-${vertexBodies.length}`),
          });
          return;
        }
        if (
          req.params.action !== `${vertexModel}:fetchPredictOperation` ||
          !vertexBodies.some(
            (_, index) =>
              req.body.operationName ===
              vertexOperation.replace('vertex-job-1', `vertex-job-${index + 1}`),
          )
        ) {
          res.status(400).json({ error: 'Unexpected Vertex operation' });
          return;
        }
        polls++;
        const bytes = Buffer.alloc(32);
        bytes.write('ftyp', 4);
        bytes.write('mp42', 8);
        res.json({
          name: req.body.operationName,
          done: true,
          response: {
            videos: [{ mimeType: 'video/mp4', bytesBase64Encoded: bytes.toString('base64') }],
          },
        });
      },
    );
    provider = await new Promise<Server>((resolve) => {
      const server = api.listen(0, '127.0.0.1', () => resolve(server));
    });
    const address = provider.address();
    if (!address || typeof address === 'string') {
      throw new Error('Provider listener unavailable');
    }
    root = `http://127.0.0.1:${address.port}/v1`;
  }, 60000);

  afterAll(async () => {
    await runtime?.worker.stop();
    await new Promise<void>((resolve, reject) =>
      provider.close((error) => (error ? reject(error) : resolve())),
    );
    await mongoose.disconnect();
    await mongo.stop();
    await rm(directory, { recursive: true, force: true });
  });

  afterEach(() => {
    if (logged.length > 0) {
      throw new Error(
        `The media runtime logged unexpected errors: ${logged.map((error) => error.message).join('; ')}`,
      );
    }
  });

  beforeEach(async () => {
    await Promise.all(
      Object.values(mongoose.models).map((model) => model.collection.deleteMany({})),
    );
    posts = 0;
    holdGeneration = undefined;
    polls = 0;
    providerHeaders = [];
    routedBodies = [];
    remoteReference = Buffer.alloc(46);
    remoteReference.write('RIFF');
    remoteReference.writeUInt32LE(38, 4);
    remoteReference.write('WAVEfmt ', 8);
    remoteReference.writeUInt32LE(16, 16);
    remoteReference.writeUInt16LE(1, 20);
    remoteReference.writeUInt16LE(1, 22);
    remoteReference.writeUInt32LE(8000, 24);
    remoteReference.writeUInt32LE(16000, 28);
    remoteReference.writeUInt16LE(2, 32);
    remoteReference.writeUInt16LE(16, 34);
    remoteReference.write('data', 36);
    remoteReference.writeUInt32LE(2, 40);
    referenceReads = 0;
    referenceHeaders = [];
    chatBodies = [];
    chunkedReference = false;
    referenceStatus = 200;
    holdReference = undefined;
    vertexToken = 'access-1';
    vertexAuthorizations = [];
    vertexBodies = [];
    behavior = 'image';
    userRole = 'USER';
    banned = false;
    generationAdmissions = 0;
    roleReads = 0;
    uploadAdmissions = 0;
    denyAdmission = false;
    moderation.mockReset().mockResolvedValue(false);
    logged = [];
    lifecycleEvents = [];
    storageState = null;
    cloudStrategy = {
      getStorageState: async () => storageState,
      planFile: jest.fn(),
      saveStream: jest.fn(),
      getDownloadStream: jest.fn(),
      deleteFile: jest.fn(),
    };
    scope = { ownerId: new mongoose.Types.ObjectId().toString(), tenantId: null };
    await mongoose.models.User.collection.insertOne({
      _id: new mongoose.Types.ObjectId(scope.ownerId),
      role: 'USER',
    });
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
            operations: ['image.generate', 'image.edit'],
          },
          {
            id: 'videos',
            api: 'openai.videos',
            endpointRef: { kind: 'custom', name: 'Fixture' },
            catalog: { kind: 'configured', models: ['sora-2'] },
            operations: ['video.generate'],
          },
          {
            id: 'vertex',
            api: 'google.vertex.videos',
            endpointRef: { kind: 'vertex', keyFile: 'fixture-auth.json' },
            catalog: { kind: 'configured', models: [vertexModel] },
            operations: ['video.generate'],
          },
        ],
      }),
      endpoints: {
        allowedAddresses: [new URL(root).host],
        custom: [{ name: 'Fixture', apiKey: 'fixture-secret', baseURL: root }],
      },
    };
    const providerTransport = createMediaTransport({
      http: axios.create({ proxy: false }),
      allowedAddresses: [new URL(root).host],
    });
    accounting = createMediaAccounting({
      repository: createMediaAccountingMethods(mongoose),
      now: Date.now,
      pricing: createMethods(mongoose),
    });
    nativeDownload = jest.fn(async (_request, filepath) => createReadStream(filepath));
    runtime = createMediaRuntime({
      saveNativeImage: (url, options) =>
        saveGeneratedImage(url, options, {
          getExtension: (type) => type.split('/')[1],
          getRetentionExpiry: async () => ({}),
          getStrategy: () => ({
            saveBuffer: async ({ buffer, fileName }) => {
              const filepath = path.join(directory, fileName);
              await writeFile(filepath, buffer);
              return filepath;
            },
          }),
          createFile: (file) =>
            createMethods(mongoose).createFile(
              { ...file, user: new mongoose.Types.ObjectId(file.user) },
              true,
            ),
        }),
      getNativeFileStrategy: () => ({
        ...cloudStrategy,
        getDownloadStream: nativeDownload,
      }),
      observer: (event) => {
        lifecycleEvents.push(event);
      },
      appConfig: config,
      repository,
      getUserById: async () => ({ role: 'USER' }),
      getRoleByName: async (role) => {
        roleReads++;
        return {
          permissions: { MEDIA: { USE: role !== 'NO_MEDIA', CREATE: role !== 'READ_ONLY' } },
        };
      },
      getAppConfig: async () => config,
      tenantContext: tenantStorage,
      asSystem: runAsSystem,
      environment: { GOOGLE_KEY: 'fixture-google', GOOGLE_REVERSE_PROXY: root },
      vertexCredentials: async () => ({
        projectId: 'test-project',
        accessToken: vertexToken,
        revision: 'original-service-account',
      }),
      decrypt: async (value) => decryptSavedCredential(value),
      transport: {
        json: (input, schema) =>
          providerTransport.json(
            {
              ...input,
              url: input.url.startsWith(`${vertexApi}/`)
                ? root + input.url.slice(vertexApi.length)
                : input.url,
            },
            schema,
          ),
        stream: (input) =>
          providerTransport.stream(
            new URL(input.url).origin === 'https://media-fixture.example'
              ? { ...input, url: root + new URL(input.url).pathname, publicOnly: false }
              : input,
          ),
      },
      upload: multer,
      moderate: moderation,
      admission: {
        admitToolGeneration: async () => {
          generationAdmissions++;
          if (denyAdmission) throw new Error('Media rate limit reached');
        },
        checkBan: (_req, res, next) => {
          if (banned) res.status(403).json({ error: { code: 'forbidden' } });
          else next();
        },
        generationLimiters: [
          (_req, res, next) => {
            generationAdmissions++;
            if (denyAdmission) res.status(429).json({ error: { code: 'quota_exceeded' } });
            else next();
          },
        ],
        uploadLimiters: [
          (_req, res, next) => {
            uploadAdmissions++;
            if (denyAdmission) res.status(429).json({ error: { code: 'quota_exceeded' } });
            else next();
          },
        ],
      },
      accounting,
      objectStores: createMediaStrategyObjectStores(() => cloudStrategy).filter(
        (store) => store.source === FileSources.firebase,
      ),
      titles: {
        db: {
          getUserKey: async () => {
            throw new Error('unexpected user key lookup');
          },
          getUserKeyValues: async () => {
            throw new Error('unexpected user key lookup');
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
      req.user = { id: scope.ownerId, role: userRole } as Express.User;
      next();
    });
    app.use('/api/media/assets', runtime.contentRouter);
    app.use('/api/media', runtime.router);
  });

  async function submit(clientRequestId: string, extra = {}) {
    const catalog = mediaCatalogSchema.parse(
      (await request(app).get('/api/media/catalog').expect(200)).body,
    );
    return request(app)
      .post('/api/media/submissions')
      .send({
        clientRequestId,
        prompt: 'A small observatory',
        operation: 'image.generate',
        selection: {
          connectionId: 'images',
          modelId: 'gpt-image-1',
          catalogVersion: catalog.version,
        },
        ...extra,
      });
  }
  it('denies banned users and generation quota violations before accepting work, without charging receipt replay', async () => {
    banned = true;
    await request(app).get('/api/media/catalog').expect(403);
    expect(generationAdmissions).toBe(0);
    banned = false;
    const first = await submit('admission-replay');
    expect(first.status).toBe(202);
    expect(generationAdmissions).toBe(1);
    denyAdmission = true;
    const replay = await submit('admission-replay');
    expect(replay.status).toBe(202);
    expect(replay.body.jobId).toBe(first.body.jobId);
    expect(generationAdmissions).toBe(1);
    expect((await submit('denied-admission')).status).toBe(429);
    expect(await repository.getMediaSubmission(scope, 'denied-admission')).toBeNull();
    expect(posts).toBe(0);
  });

  it('applies upload admission before multipart storage and hosted downloads', async () => {
    denyAdmission = true;
    await request(app)
      .post('/api/media/uploads')
      .attach('file', original, { filename: 'image.png', contentType: 'image/png' })
      .expect(429);
    await request(app)
      .post('/api/media/uploads/url')
      .send({ url: referenceURL, role: 'audio' })
      .expect(429);
    expect(uploadAdmissions).toBe(2);
    expect(referenceReads).toBe(0);
    expect(await mongoose.models.File.countDocuments({ user: scope.ownerId })).toBe(0);
  });

  it('rejects a new rate-limited request before loading effective config or role and reads replay only once', async () => {
    const accepted = mediaSubmissionReceiptSchema.parse(
      (await submit('cheap-admission-source')).body,
    );
    const job = (await repository.getMediaJob(scope, accepted.jobId))!;
    denyAdmission = true;
    const reads = roleReads;
    const replayRead = jest.spyOn(repository, 'getMediaSubmission');
    try {
      await request(app)
        .post('/api/media/submissions')
        .send({ ...job.request, clientRequestId: 'cheap-rejection' })
        .expect(429);
      expect(roleReads).toBe(reads);
      expect(replayRead).toHaveBeenCalledTimes(1);
    } finally {
      replayRead.mockRestore();
    }
  });

  it('filters saved preset parameters before create and update', async () => {
    config.filters = {
      modelParameters: {
        pii: {
          fields: ['request_fields'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
        },
      },
    };
    const settings = {
      operation: 'image.generate',
      connectionId: 'images',
      modelId: 'gpt-image-1',
      parameters: {},
    };
    const preset = (
      await request(app)
        .post('/api/media/presets')
        .send({ title: 'Safe preset', settings })
        .expect(201)
    ).body;
    const blocked = { ...settings, parameters: { negativePrompt: 'PRIVATE-DESIGN' } };
    await request(app)
      .post('/api/media/presets')
      .send({ title: 'Blocked preset', settings: blocked })
      .expect(403);
    await request(app)
      .patch(`/api/media/presets/${preset.presetId}`)
      .send({ settings: blocked })
      .expect(403);
    expect((await request(app).get('/api/media/presets').expect(200)).body.items).toHaveLength(1);
  });

  it('freezes explicit endpoint token prices when a creation is admitted', async () => {
    config.transactions = { enabled: true };
    const endpoint = config.endpoints!.custom![0];
    endpoint.tokenConfig = { 'gpt-image-1': { prompt: 2, completion: 4, context: 8192 } };
    const response = await submit('frozen-token-prices');
    expect(response.status).toBe(202);
    endpoint.tokenConfig['gpt-image-1'].prompt = 100;
    const job = await repository.getMediaJob(scope, response.body.jobId);
    expect(job?.execution.tokenPricing).toEqual({
      source: 'endpointTokenConfig',
      valueKey: 'gpt-image-1',
      prompt: 2,
      completion: 4,
      imagePrompt: 2,
      cacheRead: 2,
      imageCacheRead: 2,
    });
  });

  it('moderates each admission once and does not repeat the provider call at dispatch', async () => {
    moderation.mockResolvedValueOnce(true);
    expect((await submit('moderated-input')).status).toBe(403);
    expect(await repository.getMediaSubmission(scope, 'moderated-input')).toBeNull();
    moderation.mockResolvedValue(false);
    const accepted = await submit('moderated-at-dispatch');
    expect(accepted.status).toBe(202);
    moderation.mockResolvedValue(true);
    const job = await run(accepted.body.jobId);
    expect(job?.phase).toBe('succeeded');
    expect(posts).toBe(1);
    expect(moderation).toHaveBeenCalledTimes(2);
  });

  it('rechecks configured model parameter policy during preparation of previously accepted work', async () => {
    config.media!.integrations = [
      {
        id: 'images',
        api: 'alibaba.images',
        endpointRef: { kind: 'custom', name: 'Fixture' },
        catalog: { kind: 'configured', models: ['qwen/qwen-image-3'] },
        operations: ['image.generate'],
      },
    ];
    const submission = mediaSubmissionRequestSchema.parse({
      clientRequestId: 'parameter-policy',
      operation: 'image.generate',
      prompt: 'A sailboat',
      selection: {
        connectionId: 'images',
        modelId: 'qwen/qwen-image-3',
        catalogVersion: 'stored-catalog',
      },
      parameters: { negativePrompt: 'PRIVATE-DESIGN' },
    });
    const context = {
      scope,
      config: config.media!,
      appConfig: config,
      canUse: true,
      canCreate: true,
    };
    await expect(runtime.services.prepare(submission, context, false)).resolves.toBeDefined();
    config.filters = {
      modelParameters: {
        pii: {
          fields: ['request_fields'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
        },
      },
    };
    await expect(runtime.services.prepare(submission, context, false)).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(posts).toBe(0);
  });

  test('honors existing image storage policy before catalog availability, uploads or submission', async () => {
    config.fileStrategies = { image: FileSources.s3 };
    const unavailable = mediaCatalogSchema.parse(
      (await request(app).get('/api/media/catalog').expect(200)).body,
    );
    expect(unavailable.offerings.length).toBeGreaterThan(0);
    expect(unavailable.offerings.every((offering) => !offering.available)).toBe(true);
    expect(unavailable.integrations?.every((integration) => !integration.available)).toBe(true);
    expect((await submit('cloud-storage')).status).toBe(422);
    await request(app)
      .post('/api/media/uploads')
      .attach('file', original, { filename: 'reference.png', contentType: 'image/png' })
      .expect(422);
    await request(app)
      .post('/api/media/uploads/url')
      .send({ role: 'audio', url: referenceURL })
      .expect(422);
    expect(referenceReads).toBe(0);
    expect(posts).toBe(0);

    config.media!.assets.source = FileSources.local;
    const available = mediaCatalogSchema.parse(
      (await request(app).get('/api/media/catalog').expect(200)).body,
    );
    expect(available.version).not.toBe(unavailable.version);
    expect(available.offerings.some((offering) => offering.available)).toBe(true);
    await request(app)
      .post('/api/media/uploads')
      .attach('file', original, { filename: 'reference.png', contentType: 'image/png' })
      .expect(201);
    expect((await submit('explicit-local-storage')).status).toBe(202);
  });

  test('inherits fileStrategies.default and permits an existing local image override', async () => {
    config.fileStrategy = FileSources.local;
    config.fileStrategies = { default: FileSources.azure_blob };
    expect((await submit('default-cloud-storage')).status).toBe(422);
    config.fileStrategies.image = FileSources.local;
    expect((await submit('existing-local-image-storage')).status).toBe(202);
  });

  test('blocks unconfigured cloud storage before catalog, paid admission, upload or queued dispatch', async () => {
    config.media!.assets.source = FileSources.firebase;
    config.balance = { enabled: true, startBalance: 1_000_000 };
    config.media!.integrations[0].billing = { maxCostUSD: 0.1, creditsPerUSD: 1_000_000 };
    const unavailable = mediaCatalogSchema.parse(
      (await request(app).get('/api/media/catalog').expect(200)).body,
    );
    expect(unavailable.offerings.every((offering) => !offering.available)).toBe(true);
    expect(unavailable.integrations?.every((integration) => !integration.available)).toBe(true);
    expect((await submit('unconfigured-cloud')).status).toBe(503);
    await request(app)
      .post('/api/media/uploads')
      .attach('file', original, { filename: 'reference.png', contentType: 'image/png' })
      .expect(503);
    expect(await mongoose.models.MediaJob.countDocuments()).toBe(0);
    expect(posts).toBe(0);
    expect(cloudStrategy.planFile).not.toHaveBeenCalled();
    expect(cloudStrategy.saveStream).not.toHaveBeenCalled();

    storageState = {};
    const accepted = await submit('configured-cloud');
    expect(accepted.status).toBe(202);
    storageState = null;
    const reserve = jest.spyOn(accounting, 'reserve');
    const completed = await run(mediaSubmissionReceiptSchema.parse(accepted.body).jobId);
    expect(completed).toMatchObject({ phase: 'failed', error: { code: 'not_ready' } });
    expect(reserve).not.toHaveBeenCalled();
    reserve.mockRestore();
    expect(posts).toBe(0);
  });

  test('keeps billed connections unavailable until a cost reservation is configured', async () => {
    config.balance = { enabled: true, startBalance: 1_000_000 };
    const unavailable = mediaCatalogSchema.parse(
      (await request(app).get('/api/media/catalog').expect(200)).body,
    );
    expect(unavailable.integrations?.every((integration) => !integration.available)).toBe(true);
    expect((await submit('missing-cost-policy')).status).toBe(422);
    expect(posts).toBe(0);
    expect(await mongoose.models.MediaJob.countDocuments()).toBe(0);

    config.media!.integrations[0].billing = { creditsPerUSD: 1_000_000, maxCostUSD: 0.25 };
    const available = mediaCatalogSchema.parse(
      (await request(app).get('/api/media/catalog').expect(200)).body,
    );
    expect(available.version).not.toBe(unavailable.version);
    expect(
      available.integrations?.find((integration) => integration.connectionId === 'images'),
    ).toMatchObject({ available: true });
    expect((await submit('configured-cost-policy')).status).toBe(202);
  });

  async function run(jobId: string) {
    const job = await repository.claimMediaJob({
      scope,
      workerId: 'test-worker',
      now: new Date(Date.now() + 60_000).toISOString(),
      leaseMs: 120_000,
    });
    expect(job?.jobId).toBe(jobId);
    if (!job) {
      throw new Error('Expected claimable job');
    }
    await runtime.worker.runJob(job);
    return repository.getMediaJob(scope, jobId);
  }

  async function hostedSubmission(clientRequestId: string, inputs: object[]) {
    if (!config.media!.integrations.some((entry) => entry.id === 'hosted')) {
      config.media!.integrations.push({
        id: 'hosted',
        api: 'openrouter.videos',
        endpointRef: { kind: 'custom', name: 'Fixture' },
        catalog: {
          kind: 'discovered',
          allowModels: ['bytedance/seedance-2.0'],
          excludeModels: [],
          allModels: false,
        },
        operations: ['video.generate'],
      });
    }
    const catalog = mediaCatalogSchema.parse(
      (await request(app).get('/api/media/catalog').expect(200)).body,
    );
    const offering = catalog.offerings.find((entry) => entry.connectionId === 'hosted');
    expect(offering?.capabilities[0].inputs.hostedRoles).toEqual(['video', 'audio']);
    return submit(clientRequestId, {
      operation: 'video.generate',
      inputs,
      selection: {
        connectionId: 'hosted',
        modelId: 'bytedance/seedance-2.0',
        catalogVersion: catalog.version,
      },
    });
  }

  it('queues idempotently, stores original bytes, and iterates in the same tile', async () => {
    const first = await submit('stable-request');
    expect(first.status).toBe(202);
    const receipt = mediaSubmissionReceiptSchema.parse(first.body);
    expect(receipt.phase).toBe('accepted');
    expect(posts).toBe(0);
    const replay = await submit('stable-request');
    expect(replay.body.jobId).toBe(receipt.jobId);
    const completed = await run(receipt.jobId);
    expect(completed?.phase).toBe('succeeded');
    expect(posts).toBe(1);
    const output = completed?.outputs[0];
    if (!output || output.kind === 'text' || !output.asset) {
      throw new Error('Expected image');
    }
    expect(
      await readFile(
        path.join(
          directory,
          (await repository.getMediaAssetContent(scope, output.asset.file_id))!.filepath,
        ),
      ),
    ).toEqual(original);
    expect(output.asset).toMatchObject({ width: 24, height: 16, bytes: original.length });
    const next = await submit('iteration', {
      threadId: receipt.threadId,
      parentTurnId: receipt.turnId,
      operation: 'image.edit',
      inputs: [{ role: 'reference', file_id: output.asset.file_id }],
    });
    expect(next.status).toBe(202);
    expect(next.body.threadId).toBe(receipt.threadId);
    const threads = await request(app).get('/api/media/threads').expect(200);
    expect(threads.body.items).toHaveLength(1);
    expect(
      await repository.claimMediaAssetDeletion({
        scope,
        fileId: output.asset.file_id,
        token: 'delete',
      }),
    ).toBeNull();
  });

  it.each([undefined, 1000])(
    'freezes the transaction conversion rate %s before provider dispatch',
    async (creditsPerUSD) => {
      config.transactions = { enabled: true };
      if (creditsPerUSD !== undefined) {
        config.media!.integrations.find((entry) => entry.id === 'images')!.billing = {
          creditsPerUSD,
        };
      }
      const response = await submit('transaction-rate');
      expect(response.status).toBe(202);
      expect((await repository.getMediaJob(scope, response.body.jobId))?.execution).toMatchObject({
        accountingMode: 'transactions',
        billing: { creditsPerUSD: creditsPerUSD ?? 1_000_000 },
      });
      expect(posts).toBe(0);
    },
  );

  it('preserves legacy transaction snapshots on replay and freezes the current rate for an explicit retry', async () => {
    config.transactions = { enabled: true };
    const original = await submit('legacy-transaction-rate');
    expect(original.status).toBe(202);
    await mongoose.models.MediaJob.updateOne(
      { ...scope, jobId: original.body.jobId },
      { $unset: { 'execution.billing': 1 } },
    );
    const replay = await submit('legacy-transaction-rate');
    expect(replay.status).toBe(202);
    expect(replay.body.jobId).toBe(original.body.jobId);
    expect(
      (await repository.getMediaJob(scope, replay.body.jobId))?.execution.billing,
    ).toBeUndefined();
    await request(app).post(`/api/media/jobs/${original.body.jobId}/cancel`).expect(200);
    const retried = await request(app)
      .post(`/api/media/jobs/${original.body.jobId}/retry`)
      .send({ clientRequestId: 'new-transaction-rate' })
      .expect(202);
    expect((await repository.getMediaJob(scope, retried.body.jobId))?.execution).toMatchObject({
      accountingMode: 'transactions',
      billing: { creditsPerUSD: 1_000_000 },
    });
    expect(posts).toBe(0);
  });

  it('names a new thread with the configured title model after the receipt, never on replay or follow-up', async () => {
    config.media!.titles.endpoint = 'Fixture';
    config.media!.titles.model = 'fixture-title';
    const response = await submit('generated-title');
    expect(response.status).toBe(202);
    const receipt = mediaSubmissionReceiptSchema.parse(response.body);
    expect(chatBodies).toHaveLength(0);
    let releaseGeneration!: () => void;
    const generation = new Promise<void>((resolve) => {
      releaseGeneration = resolve;
    });
    holdGeneration = () => generation;
    const running = run(receipt.jobId);
    try {
      const titleDeadline = Date.now() + 10_000;
      while (
        (await repository.getMediaThread(scope, receipt.threadId))?.title !== 'Small Observatory' &&
        Date.now() < titleDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(posts).toBe(1);
      expect((await repository.getMediaThread(scope, receipt.threadId))?.title).toBe(
        'Small Observatory',
      );
    } finally {
      releaseGeneration();
      await running;
      holdGeneration = undefined;
    }
    expect((await repository.getMediaThread(scope, receipt.threadId))?.title).toBe(
      'Small Observatory',
    );
    expect(chatBodies).toHaveLength(1);
    expect(chatBodies[0].model).toBe('fixture-title');
    expect(JSON.stringify(chatBodies[0].messages)).toContain('A small observatory');
    const replay = await submit('generated-title');
    expect(replay.body.threadId).toBe(receipt.threadId);
    const followUp = await submit('generated-title-follow-up', {
      threadId: receipt.threadId,
      parentTurnId: receipt.turnId,
    });
    expect(followUp.status).toBe(202);
    await run(followUp.body.jobId);
    expect(chatBodies).toHaveLength(1);
    expect((await repository.getMediaThread(scope, receipt.threadId))?.title).toBe(
      'Small Observatory',
    );
  });

  it('uploads a safe SVG original and prepares a raster reference for the selected image API', async () => {
    const source = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"><rect width="24" height="16" fill="red"/></svg>',
    );
    const response = await request(app)
      .post('/api/media/uploads')
      .attach('file', source, { filename: 'original.svg', contentType: 'image/svg+xml' })
      .expect(201);
    const asset = response.body.file;
    const catalog = mediaCatalogSchema.parse((await request(app).get('/api/media/catalog')).body);
    const prepared = await runtime.services.prepare(
      mediaSubmissionRequestSchema.parse({
        clientRequestId: 'edit-svg',
        operation: 'image.edit',
        prompt: 'Make the rectangle blue',
        selection: {
          connectionId: 'images',
          modelId: 'gpt-image-1',
          catalogVersion: catalog.version,
        },
        inputs: [{ role: 'reference', file_id: asset.file_id }],
      }),
      { scope, appConfig: config, config: config.media!, canUse: true, canCreate: true },
      true,
    );
    expect(prepared.inputs[0]).toMatchObject({ type: 'image/png', role: 'reference' });
    expect(await sharp(prepared.inputs[0].data).metadata()).toMatchObject({
      width: 24,
      height: 16,
    });
    expect(
      await readFile(
        path.join(
          directory,
          (await repository.getMediaAssetContent(scope, asset.file_id))!.filepath,
        ),
      ),
    ).toEqual(source);
    expect(await readdir(path.join(directory, 'uploads', 'temp', scope.ownerId, 'media'))).toEqual(
      [],
    );
    expect(posts).toBe(0);
  });

  it('uploads video and audio using their own limits and rejects assigning audio to an image role', async () => {
    config.media!.transfers.maxImageBytes = 32;
    config.media!.transfers.maxAudioBytes = 64;
    config.media!.transfers.maxVideoBytes = 128;
    const wave = Buffer.alloc(46);
    wave.write('RIFF');
    wave.writeUInt32LE(38, 4);
    wave.write('WAVEfmt ', 8);
    wave.writeUInt32LE(16, 16);
    wave.writeUInt16LE(1, 20);
    wave.writeUInt16LE(1, 22);
    wave.writeUInt32LE(8000, 24);
    wave.writeUInt32LE(16000, 28);
    wave.writeUInt16LE(2, 32);
    wave.writeUInt16LE(16, 34);
    wave.write('data', 36);
    wave.writeUInt32LE(2, 40);
    const audio = await request(app)
      .post('/api/media/uploads')
      .attach('file', wave, { filename: 'reference.wav', contentType: 'audio/x-wav' })
      .expect(201);
    expect(audio.body.file).toMatchObject({ type: 'audio/wav', bytes: 46 });
    const video = Buffer.alloc(80);
    video.write('ftyp', 4);
    video.write('mp42', 8);
    await request(app)
      .post('/api/media/uploads')
      .attach('file', video, { filename: 'reference.mp4', contentType: 'video/mp4' })
      .expect(201);
    await request(app)
      .post('/api/media/uploads')
      .attach('file', Buffer.concat([wave, wave]), {
        filename: 'too-large.wav',
        contentType: 'audio/wav',
      })
      .expect(413);
    config.media!.transfers.maxImageBytes = 64;
    const response = await submit('wrong-input-role', {
      operation: 'image.edit',
      inputs: [{ role: 'reference', file_id: audio.body.file.file_id }],
    });
    expect(response.status).toBe(422);
    expect(posts).toBe(0);
    expect(await readdir(path.join(directory, 'uploads', 'temp', scope.ownerId, 'media'))).toEqual(
      [],
    );
  });

  it.each(['audio', 'video'] as const)(
    'imports an HTTPS %s reference and preserves its verified URL through the queue',
    async (role) => {
      if (role === 'video') remoteReference = mp4ReferenceFixture();
      const archived = Buffer.from(remoteReference);
      const response = await request(app)
        .post('/api/media/uploads/url')
        .set('Authorization', 'Bearer browser-credential')
        .set('Cookie', 'session=browser-cookie')
        .send({ url: referenceURL, role })
        .expect(201);
      const imported = mediaURLUploadResponseSchema.parse(response.body);
      expect(imported.file.type).toBe(role === 'video' ? 'video/mp4' : 'audio/wav');
      expect(imported.sourceURL).toBe(referenceURL);
      expect(
        await readFile(
          path.join(
            directory,
            (await repository.getMediaAssetContent(scope, imported.file.file_id))!.filepath,
          ),
        ),
      ).toEqual(archived);
      const submission = await hostedSubmission(`hosted-${role}`, [
        {
          role,
          file_id: imported.file.file_id,
          sourceURL: imported.sourceURL,
        },
      ]);
      expect(submission.status).toBe(202);
      const queued = await repository.getMediaJob(scope, submission.body.jobId);
      expect(queued?.request.inputs[0].sourceURL).toBe(referenceURL);
      expect((await run(submission.body.jobId))?.phase).toBe('running');
      expect(referenceReads).toBe(3);
      expect(referenceHeaders).toEqual(
        Array.from({ length: 3 }, () => ({ authorization: undefined, cookie: undefined })),
      );
      expect(JSON.parse(routedBodies[0]).input_references).toEqual([
        role === 'video'
          ? { type: 'video_url', video_url: { url: referenceURL } }
          : { type: 'audio_url', audio_url: { url: referenceURL } },
      ]);
      expect((await run(submission.body.jobId))?.phase).toBe('succeeded');
      expect(posts).toBe(1);
    },
  );

  it('rejects changed hosted bytes before admission and again immediately before paid dispatch', async () => {
    const imported = mediaURLUploadResponseSchema.parse(
      (
        await request(app)
          .post('/api/media/uploads/url')
          .send({ url: referenceURL, role: 'audio' })
          .expect(201)
      ).body,
    );
    const input = { role: 'audio', file_id: imported.file.file_id, sourceURL: referenceURL };
    const archived = Buffer.from(remoteReference);
    remoteReference[45] = 1;
    const rejected = await hostedSubmission('changed-before-queue', [input]);
    expect(rejected.status).toBe(422);
    expect(rejected.body).toEqual({ error: { code: 'reference_changed' } });
    expect(posts).toBe(0);
    remoteReference = Buffer.from(archived);
    const queued = await hostedSubmission('changed-before-dispatch', [input]);
    expect(queued.status).toBe(202);
    remoteReference[45] = 2;
    const settled = await run(queued.body.jobId);
    expect(settled).toMatchObject({
      phase: 'failed',
      error: { code: 'reference_changed' },
      provider: { certainty: 'unsubmitted' },
    });
    expect(posts).toBe(0);
    expect(
      await readFile(
        path.join(
          directory,
          (await repository.getMediaAssetContent(scope, imported.file.file_id))!.filepath,
        ),
      ),
    ).toEqual(archived);
  });

  it('gives up on a hosted reference that drips bytes past the download deadline', async () => {
    config.media!.timeouts.downloadMs = 300;
    let drip: ReturnType<typeof setInterval> | undefined;
    holdReference = (response) => {
      response.write(remoteReference.subarray(0, 8));
      drip = setInterval(() => response.write(Buffer.alloc(1)), 50);
      response.once('close', () => clearInterval(drip));
    };
    const publication = jest.spyOn(repository, 'reserveMediaAssetWrite');
    try {
      const started = Date.now();
      const response = await request(app)
        .post('/api/media/uploads/url')
        .send({ url: referenceURL, role: 'audio' })
        .timeout(5_000);
      expect(response.status).toBe(422);
      expect(response.body).toEqual({ error: { code: 'reference_unavailable' } });
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(publication).not.toHaveBeenCalled();
    } finally {
      clearInterval(drip);
      holdReference = undefined;
    }
  });

  it.each([401, 403, 404, 410])(
    'reports an unavailable hosted reference for HTTP %s without publishing a file',
    async (status) => {
      referenceStatus = status;
      const publication = jest.spyOn(repository, 'reserveMediaAssetWrite');
      const response = await request(app)
        .post('/api/media/uploads/url')
        .send({ url: referenceURL, role: 'audio' })
        .expect(422);
      expect(response.body).toEqual({ error: { code: 'reference_unavailable' } });
      expect(publication).not.toHaveBeenCalled();
      expect(posts).toBe(0);
    },
  );

  it.each(['deployment', 'integration', 'owner'] as const)(
    'does not download queued hosted references while %s execution capacity is saturated',
    async (kind) => {
      config.media!.execution.maxActiveTotal = 1;
      config.media!.execution.maxActivePerIntegration = 1;
      config.media!.execution.maxActivePerUser = 1;
      const imported = mediaURLUploadResponseSchema.parse(
        (
          await request(app)
            .post('/api/media/uploads/url')
            .send({ url: referenceURL, role: 'audio' })
            .expect(201)
        ).body,
      );
      const inputs = [{ role: 'audio', file_id: imported.file.file_id, sourceURL: referenceURL }];
      const first = await hostedSubmission(`occupy-${kind}`, inputs);
      expect(first.status).toBe(202);
      const claimed = await repository.claimMediaJob({
        scope,
        workerId: 'other-worker',
        now: new Date().toISOString(),
        leaseMs: 300_000,
      });
      expect(claimed?.jobId).toBe(first.body.jobId);
      expect(
        await repository.acquireMediaPermit({
          scope,
          jobId: first.body.jobId,
          kind,
          key: kind === 'integration' ? 'hosted' : undefined,
          capacity: 1,
        }),
      ).toBe(true);
      const waiting = await hostedSubmission(`waiting-${kind}`, inputs);
      expect(waiting.status).toBe(202);
      const readsBeforeDispatch = referenceReads;
      const reservation = jest.spyOn(accounting, 'reserve');
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await run(waiting.body.jobId)).toMatchObject({
          phase: 'queued',
          provider: { certainty: 'unsubmitted' },
        });
      }
      expect(referenceReads).toBe(readsBeforeDispatch);
      expect(reservation).not.toHaveBeenCalled();
      expect(posts).toBe(0);
    },
  );

  it('aborts hosted reference revalidation when the worker stops before dispatch', async () => {
    const imported = mediaURLUploadResponseSchema.parse(
      (
        await request(app)
          .post('/api/media/uploads/url')
          .send({ url: referenceURL, role: 'audio' })
          .expect(201)
      ).body,
    );
    const queued = await hostedSubmission('stop-during-reference-download', [
      { role: 'audio', file_id: imported.file.file_id, sourceURL: referenceURL },
    ]);
    expect(queued.status).toBe(202);
    let heldResponse: express.Response | undefined;
    let releaseDownload: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const received = new Promise<void>((resolve) => {
      holdReference = (response) => {
        heldResponse = response;
        response.once('close', () => releaseDownload?.());
        response.write(remoteReference.subarray(0, 8));
        resolve();
      };
    });
    const reservation = jest.spyOn(accounting, 'reserve');
    try {
      const pending = run(queued.body.jobId);
      await received;
      await runtime.worker.stop();
      const job = await pending;
      await closed;
      expect(job).toMatchObject({ phase: 'queued', provider: { certainty: 'unsubmitted' } });
      expect(reservation).not.toHaveBeenCalled();
      expect(posts).toBe(0);
    } finally {
      holdReference = undefined;
      heldResponse?.destroy();
    }
  });

  it('requires a hosted source and checks file ownership before downloading a submitted URL', async () => {
    const imported = mediaURLUploadResponseSchema.parse(
      (
        await request(app)
          .post('/api/media/uploads/url')
          .send({ url: referenceURL, role: 'audio' })
          .expect(201)
      ).body,
    );
    expect(
      (
        await hostedSubmission('missing-hosted-url', [
          { role: 'audio', file_id: imported.file.file_id },
        ])
      ).status,
    ).toBe(422);
    expect(referenceReads).toBe(1);
    scope = { ...scope, ownerId: new mongoose.Types.ObjectId().toString() };
    expect(
      (
        await hostedSubmission('another-owner-url', [
          {
            role: 'audio',
            file_id: imported.file.file_id,
            sourceURL: referenceURL,
          },
        ])
      ).status,
    ).toBe(404);
    expect(referenceReads).toBe(1);
    expect(posts).toBe(0);
  });

  it.each([
    'https://127.0.0.1/reference',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/reference',
    'https://localhost/reference',
    'http://media-fixture.example/reference',
    'https://user:secret@media-fixture.example/reference',
    'https://media-fixture.example/reference#fragment',
    'file:///local-reference.mp4',
    'not-a-url',
  ])('rejects an unsafe URL without accessing the reference or provider: %s', async (url) => {
    const response = await request(app)
      .post('/api/media/uploads/url')
      .send({ url, role: 'video' })
      .expect(422);
    expect(response.body).toEqual({ error: { code: 'reference_unavailable' } });
    expect(referenceReads).toBe(0);
    expect(posts).toBe(0);
  });

  it('enforces reference byte limits, role detection, permissions and upload policy before publication', async () => {
    const publication = jest.spyOn(repository, 'reserveMediaAssetWrite');
    try {
      userRole = 'READ_ONLY';
      await request(app)
        .post('/api/media/uploads/url')
        .send({ url: referenceURL, role: 'audio' })
        .expect(403);
      expect(referenceReads).toBe(0);
      userRole = 'USER';
      config.media!.transfers.maxAudioBytes = 32;
      chunkedReference = true;
      await request(app)
        .post('/api/media/uploads/url')
        .send({ url: referenceURL, role: 'audio' })
        .expect(413);
      config.media!.transfers.maxAudioBytes = 1024;
      await request(app)
        .post('/api/media/uploads/url')
        .send({ url: referenceURL, role: 'video' })
        .expect(422);
      config.filters = {
        files: {
          pii: {
            fields: ['content'],
            starterPatterns: [],
            customPatterns: [{ id: 'private', label: 'Private value', regex: 'PRIVATE-[A-Z]+' }],
            uninspectable: 'block',
          },
        },
      };
      await request(app)
        .post('/api/media/uploads/url')
        .send({ url: referenceURL, role: 'audio' })
        .expect(403);
      const rejectedUpload = await request(app)
        .post('/api/media/uploads')
        .attach('file', original, { filename: 'reference.png', contentType: 'image/png' })
        .expect(403);
      expect(rejectedUpload.body).toEqual({ error: { code: 'forbidden' } });
      expect(publication).not.toHaveBeenCalled();
      expect(posts).toBe(0);
    } finally {
      publication.mockRestore();
    }
  });

  it('keeps uncertain provider acceptance out of automatic and user retry', async () => {
    behavior = 'uncertain';
    const response = await submit('uncertain');
    expect(response.status).toBe(202);
    const job = await run(response.body.jobId);
    expect(job?.phase).toBe('requires_attention');
    expect(posts).toBe(1);
    expect(logged.splice(0).map((error) => error.message)).toEqual([
      `[media] Job ${response.body.jobId} provider request uncertain (http_503).`,
    ]);
    await request(app)
      .post(`/api/media/jobs/${response.body.jobId}/retry`)
      .send({ clientRequestId: 'unsafe-retry' })
      .expect(409);
    expect(posts).toBe(1);
  });

  it('allows a new attempt after a definitive provider rejection and cancels queued work', async () => {
    behavior = 'rejected';
    const response = await submit('rejected');
    expect((await run(response.body.jobId))?.phase).toBe('failed');
    expect(logged.splice(0).map((error) => error.message)).toEqual([
      `[media] Job ${response.body.jobId} provider request rejected (http_400).`,
    ]);
    const retried = await request(app)
      .post(`/api/media/jobs/${response.body.jobId}/retry`)
      .send({ clientRequestId: 'safe-retry' })
      .expect(202);
    expect(retried.body.jobId).not.toBe(response.body.jobId);
    expect(retried.body.turnId).toBe(response.body.turnId);
    config.media!.integrations.find((entry) => entry.id === 'images')!.enabled = false;
    const excludedReplay = await request(app)
      .post(`/api/media/jobs/${response.body.jobId}/retry`)
      .send({ clientRequestId: 'safe-retry' })
      .expect(202);
    expect(excludedReplay.body.jobId).toBe(retried.body.jobId);
    config.media!.integrations = [];
    const replay = await request(app)
      .post(`/api/media/jobs/${response.body.jobId}/retry`)
      .send({ clientRequestId: 'safe-retry' })
      .expect(202);
    expect(replay.body.jobId).toBe(retried.body.jobId);
    await request(app).post(`/api/media/jobs/${retried.body.jobId}/cancel`).expect(200);
    expect(posts).toBe(1);
  });

  it('loads bounded provider diagnostics only through the owner-scoped diagnostics endpoint', async () => {
    const response = await submit('private-diagnostics');
    const diagnostic = {
      status: 400,
      code: 'INVALID_ARGUMENT',
      message: 'The reference video must use a supported resolution.',
      requestId: 'provider-request-1',
    };
    await mongoose.models.MediaJob.updateOne(
      { ...scope, jobId: response.body.jobId },
      {
        $set: {
          phase: 'failed',
          error: { code: 'provider_rejected' },
          'provider.certainty': 'terminal',
          'provider.recovery.diagnostic': diagnostic,
        },
      },
    );
    const read = jest.spyOn(repository, 'getMediaJobDiagnostics');
    const publicJob = await request(app).get(`/api/media/jobs/${response.body.jobId}`).expect(200);
    expect(mediaJobSchema.safeParse(publicJob.body).success).toBe(true);
    expect(publicJob.body.error).toEqual({ code: 'provider_rejected' });
    expect(JSON.stringify(publicJob.body)).not.toContain(diagnostic.message);
    const thread = await request(app)
      .get(`/api/media/threads/${response.body.threadId}`)
      .expect(200);
    expect(mediaThreadDetailSchema.safeParse(thread.body).success).toBe(true);
    expect(JSON.stringify(thread.body)).not.toContain(diagnostic.message);
    expect(read).not.toHaveBeenCalled();
    const details = await request(app)
      .get(`/api/media/jobs/${response.body.jobId}/diagnostics`)
      .expect(200);
    expect(mediaJobDiagnosticsResponseSchema.parse(details.body)).toEqual({ diagnostic });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenLastCalledWith(scope, response.body.jobId);
    expect(posts).toBe(0);

    const actors = [
      { actor: undefined, status: 403 },
      { actor: { id: scope.ownerId, role: 'NO_MEDIA' }, status: 403 },
      { actor: { id: new mongoose.Types.ObjectId().toString(), role: 'USER' }, status: 404 },
      { actor: { id: scope.ownerId, role: 'USER', tenantId: 'foreign-tenant' }, status: 404 },
    ];
    for (const { actor, status } of actors) {
      const other = express();
      other.use((req, _res, next) => {
        if (actor) req.user = actor as Express.User;
        next();
      });
      other.use('/api/media', runtime.router);
      await request(other).get(`/api/media/jobs/${response.body.jobId}/diagnostics`).expect(status);
    }
    banned = true;
    await request(app).get(`/api/media/jobs/${response.body.jobId}/diagnostics`).expect(403);
    banned = false;
    await repository.retireMediaThread(scope, response.body.threadId);
    await request(app).get(`/api/media/jobs/${response.body.jobId}/diagnostics`).expect(404);
  });

  it('returns no provider diagnostics for legacy jobs or invalid stored details', async () => {
    const response = await submit('legacy-diagnostics');
    const endpoint = `/api/media/jobs/${response.body.jobId}/diagnostics`;
    expect((await request(app).get(endpoint).expect(200)).body).toEqual({});
    await mongoose.models.MediaJob.updateOne(
      { ...scope, jobId: response.body.jobId },
      { $set: { 'provider.recovery.diagnostic': { message: 'x'.repeat(8_193) } } },
    );
    expect((await request(app).get(endpoint).expect(200)).body).toEqual({});
    await request(app).get('/api/media/jobs/missing/diagnostics').expect(404);
  });

  it('polls an existing video after repository recreation and media config removal without resubmission', async () => {
    behavior = 'video';
    const catalog = mediaCatalogSchema.parse((await request(app).get('/api/media/catalog')).body);
    const response = await submit('video', {
      operation: 'video.generate',
      selection: { connectionId: 'videos', modelId: 'sora-2', catalogVersion: catalog.version },
      parameters: { durationSeconds: 4, resolution: '1280x720' },
    });
    expect(response.status).toBe(202);
    expect((await run(response.body.jobId))?.phase).toBe('running');
    config.media = resolveMediaConfig();
    const mediaMethods = createMediaMethods(mongoose, { ownerExists: async () => true });
    repository = {
      getUserKeySnapshot: createMethods(mongoose).getUserKeySnapshot,
      ...mediaMethods,
      ...createMediaNativeMethods(mongoose, mediaMethods),
      ...createNativeMessageMethods(mongoose),
      ...createMediaPresetMethods(mongoose),
      ...createMediaTitleMethods(mongoose),
    };
    expect((await run(response.body.jobId))?.phase).toBe('succeeded');
    expect(posts).toBe(1);
    expect(polls).toBe(1);
  });

  it('hides an excluded connection and blocks fresh, retry and queued requests while preserving replay and cancellation', async () => {
    config.media!.execution.maxActiveTotal = 1;
    const first = await submit('before-provider-exclusion');
    const cancellable = await submit('cancel-after-provider-exclusion');
    expect(first.status).toBe(202);
    expect(cancellable.status).toBe(202);
    const queued = await repository.getMediaJob(scope, first.body.jobId);
    if (!queued) throw new Error('Expected queued media request');
    expect(
      await repository.acquireMediaPermit({
        scope,
        jobId: first.body.jobId,
        kind: 'deployment',
        capacity: 1,
      }),
    ).toBe(true);
    config.media!.integrations.find((entry) => entry.id === 'images')!.enabled = false;
    const catalog = mediaCatalogSchema.parse((await request(app).get('/api/media/catalog')).body);
    expect(catalog.integrations?.some((entry) => entry.connectionId === 'images')).toBe(false);
    expect(catalog.offerings.some((entry) => entry.connectionId === 'images')).toBe(false);
    await request(app)
      .post('/api/media/submissions')
      .send({ ...queued.request, clientRequestId: 'forbidden-provider-request' })
      .expect(403);
    const replay = await request(app)
      .post('/api/media/submissions')
      .send(queued.request)
      .expect(202);
    expect(replay.body.jobId).toBe(first.body.jobId);
    await request(app).post(`/api/media/jobs/${cancellable.body.jobId}/cancel`).expect(200);
    expect(await run(first.body.jobId)).toMatchObject({
      phase: 'failed',
      error: { code: 'forbidden' },
      provider: { certainty: 'unsubmitted' },
    });
    await request(app)
      .post(`/api/media/jobs/${first.body.jobId}/retry`)
      .send({ clientRequestId: 'forbidden-provider-retry' })
      .expect(403);
    await request(app).get(`/api/media/threads/${first.body.threadId}`).expect(200);
    await request(app).get(`/api/media/jobs/${first.body.jobId}`).expect(200);
    expect(posts).toBe(0);
    config.media!.integrations.find((entry) => entry.id === 'images')!.enabled = true;
    const next = await submit('after-provider-reenabled');
    expect(next.status).toBe(202);
    expect((await run(next.body.jobId))?.phase).toBe('succeeded');
    expect(posts).toBe(1);
  });

  it('finishes an accepted direct video after its connection is excluded without another submission', async () => {
    const integration = config.media!.integrations.find((entry) => entry.id === 'videos')!;
    integration.endpointRef = { kind: 'direct', baseURL: root, apiKey: 'direct-video-fixture' };
    const catalog = mediaCatalogSchema.parse((await request(app).get('/api/media/catalog')).body);
    const response = await submit('video-before-provider-exclusion', {
      operation: 'video.generate',
      selection: { connectionId: 'videos', modelId: 'sora-2', catalogVersion: catalog.version },
      parameters: { durationSeconds: 4, resolution: '1280x720' },
    });
    expect(response.status).toBe(202);
    expect((await run(response.body.jobId))?.phase).toBe('running');
    integration.enabled = false;
    expect((await run(response.body.jobId))?.phase).toBe('succeeded');
    await request(app).get(`/api/media/threads/${response.body.threadId}`).expect(200);
    expect(posts).toBe(1);
    expect(polls).toBe(1);
  });

  it('shares saved provider keys through the HTTP catalog with strict owner and tenant isolation', async () => {
    const integration = config.media!.integrations.find((entry) => entry.id === 'images')!;
    integration.endpointRef = {
      kind: 'direct',
      apiKey: 'user_provided',
      baseURL: root,
      credentialName: 'My Image Account',
    };
    const readCatalog = async () =>
      mediaCatalogSchema.parse((await request(app).get('/api/media/catalog').expect(200)).body);
    const absent = await readCatalog();
    expect(absent.integrations?.find((entry) => entry.connectionId === 'images')).toMatchObject({
      available: false,
      unavailableReason: 'credentials_required',
      userKey: { keyName: 'My Image Account', encoding: 'apiKey', userProvideURL: false },
    });
    const plaintext = JSON.stringify({
      apiKey: 'saved-owner-key',
      baseURL: 'https://unused.example',
    });
    const value = encryptSavedCredential(plaintext);
    expect(value).not.toContain('saved-owner-key');
    await mongoose.models.Key.create([
      { userId: new mongoose.Types.ObjectId(), tenantId: null, name: 'My Image Account', value },
      { userId: scope.ownerId, tenantId: 'other-tenant', name: 'My Image Account', value },
    ]);
    expect(
      (await readCatalog()).offerings.find((entry) => entry.connectionId === 'images')?.available,
    ).toBe(false);
    await mongoose.models.Key.create({
      userId: scope.ownerId,
      tenantId: null,
      name: 'My Image Account',
      value,
    });
    const ready = await readCatalog();
    expect(ready.offerings.find((entry) => entry.connectionId === 'images')?.available).toBe(true);
    expect(ready.version).not.toBe(absent.version);
    expect(JSON.stringify(ready)).not.toMatch(/saved-owner-key|unused\.example|fixture:/);
    const submitted = await submit('saved-owner-credential');
    expect(submitted.status).toBe(202);
    expect((await run(submitted.body.jobId))?.phase).toBe('succeeded');
    expect(providerHeaders).toEqual([{ authorization: 'Bearer saved-owner-key' }]);
    const stored = await repository.getMediaJob(scope, submitted.body.jobId);
    expect(JSON.stringify(stored)).not.toContain('saved-owner-key');
  });

  it('revokes an accepted video credential without polling with another account or repeating submission', async () => {
    const integration = config.media!.integrations.find((entry) => entry.id === 'videos')!;
    integration.endpointRef = {
      kind: 'direct',
      apiKey: 'user_provided',
      baseURL: root,
      credentialName: 'My Video Account',
    };
    await mongoose.models.Key.create({
      userId: scope.ownerId,
      tenantId: null,
      name: 'My Video Account',
      value: encryptSavedCredential(JSON.stringify({ apiKey: 'saved-video-key' })),
    });
    const catalog = mediaCatalogSchema.parse((await request(app).get('/api/media/catalog')).body);
    const response = await submit('saved-video-credential', {
      operation: 'video.generate',
      selection: { connectionId: 'videos', modelId: 'sora-2', catalogVersion: catalog.version },
      parameters: { durationSeconds: 4, resolution: '1280x720' },
    });
    expect(response.status).toBe(202);
    expect((await run(response.body.jobId))?.phase).toBe('running');
    await mongoose.models.Key.deleteOne({
      userId: scope.ownerId,
      tenantId: null,
      name: 'My Video Account',
    });
    expect(await run(response.body.jobId)).toMatchObject({
      phase: 'requires_attention',
      error: { code: 'credentials_required' },
    });
    expect(posts).toBe(1);
    expect(polls).toBe(0);
  });

  it.each(['expiry', 'rotation'] as const)(
    'rechecks saved key %s before dispatching a queued job',
    async (change) => {
      const integration = config.media!.integrations.find((entry) => entry.id === 'images')!;
      integration.endpointRef = {
        kind: 'direct',
        apiKey: 'user_provided',
        baseURL: root,
        credentialName: 'My Image Account',
      };
      const key = await mongoose.models.Key.create({
        userId: scope.ownerId,
        tenantId: null,
        name: 'My Image Account',
        value: encryptSavedCredential(JSON.stringify({ apiKey: 'first-user-key' })),
      });
      const response = await submit(`saved-key-${change}`);
      expect(response.status).toBe(202);
      await mongoose.models.Key.updateOne(
        { _id: key._id },
        {
          $set:
            change === 'expiry'
              ? { expiresAt: new Date(Date.now() + 500) }
              : { value: encryptSavedCredential(JSON.stringify({ apiKey: 'second-user-key' })) },
        },
      );
      expect(await run(response.body.jobId)).toMatchObject({
        phase: 'failed',
        error: { code: change === 'expiry' ? 'credentials_expired' : 'credentials_required' },
      });
      expect(posts).toBe(0);
      if (change !== 'rotation') {
        return;
      }
      const retried = await request(app)
        .post(`/api/media/jobs/${response.body.jobId}/retry`)
        .send({ clientRequestId: 'saved-key-rotation-retry' })
        .expect(202);
      expect(retried.body.jobId).not.toBe(response.body.jobId);
      expect((await run(retried.body.jobId))?.phase).toBe('succeeded');
      expect(posts).toBe(1);
      expect(providerHeaders).toEqual([{ authorization: 'Bearer second-user-key' }]);
    },
  );

  it('uses direct provider credentials without copying literal keys or secret headers into persisted jobs', async () => {
    const integration = config.media!.integrations.find((entry) => entry.id === 'images');
    if (!integration) throw new Error('Missing images integration');
    integration.endpointRef = {
      kind: 'direct',
      baseURL: root,
      apiKey: 'literal-direct-key',
      headers: { 'X-Extra-Credential': 'literal-direct-header' },
    };
    const response = await submit('direct-credentials');
    expect(response.status).toBe(202);
    const queued = await repository.getMediaJob(scope, response.body.jobId);
    expect(queued?.execution).not.toHaveProperty('endpointRef');
    expect(JSON.stringify(queued)).not.toMatch(/literal-direct-key|literal-direct-header/);
    const completed = await run(response.body.jobId);
    expect(completed?.phase).toBe('succeeded');
    expect(JSON.stringify(completed)).not.toMatch(/literal-direct-key|literal-direct-header/);
    expect(providerHeaders).toEqual([
      { authorization: 'Bearer literal-direct-key', secret: 'literal-direct-header' },
    ]);
    expect(posts).toBe(1);
  });

  it('preserves the chosen image provider, validated options, and owned reference through the persisted queue', async () => {
    const integration = config.media!.integrations.find((entry) => entry.id === 'images');
    if (!integration) throw new Error('Missing images integration');
    integration.api = 'openrouter.images';
    integration.catalog = { kind: 'configured', models: ['fixture/image'] };
    const upload = await request(app)
      .post('/api/media/uploads')
      .attach('file', original, { filename: 'reference.png', contentType: 'image/png' })
      .expect(201);
    const catalog = mediaCatalogSchema.parse((await request(app).get('/api/media/catalog')).body);
    const submission = {
      operation: 'image.edit',
      selection: {
        connectionId: 'images',
        modelId: 'fixture/image',
        catalogVersion: catalog.version,
        providerTag: 'provider-b',
      },
      inputs: [{ role: 'reference', file_id: upload.body.file.file_id }],
      parameters: { count: 1, quality: 'high', providerOptions: { strength: 0.5 } },
    };
    const response = await submit('routed-image', submission);
    expect(response.status).toBe(202);
    const queued = await repository.getMediaJob(scope, response.body.jobId);
    expect(queued).toMatchObject({
      execution: { providerTag: 'provider-b' },
      request: {
        selection: { providerTag: 'provider-b' },
        parameters: { providerOptions: { strength: 0.5 } },
      },
    });
    expect((await submit('routed-image', submission)).body.jobId).toBe(response.body.jobId);
    expect(posts).toBe(0);
    expect((await run(response.body.jobId))?.phase).toBe('succeeded');
    expect(routedBodies).toHaveLength(1);
    expect(JSON.parse(routedBodies[0])).toMatchObject({
      quality: 'high',
      provider: {
        only: ['provider-b'],
        allow_fallbacks: false,
        options: { 'provider-b': { strength: 0.5 } },
      },
      input_references: [
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${original.toString('base64')}` },
        },
      ],
    });
    expect(posts).toBe(1);
  });

  it('requires the configured direct connection to recover an accepted video without replaying generation', async () => {
    const integration = config.media!.integrations.find((entry) => entry.id === 'videos');
    if (!integration) throw new Error('Missing video integration');
    integration.endpointRef = { kind: 'direct', baseURL: root, apiKey: 'literal-video-key' };
    const catalog = mediaCatalogSchema.parse((await request(app).get('/api/media/catalog')).body);
    const response = await submit('direct-video', {
      operation: 'video.generate',
      selection: { connectionId: 'videos', modelId: 'sora-2', catalogVersion: catalog.version },
      parameters: { durationSeconds: 4, resolution: '1280x720' },
    });
    expect(response.status).toBe(202);
    const running = await run(response.body.jobId);
    expect(running?.phase).toBe('running');
    expect(running?.execution).not.toHaveProperty('endpointRef');
    config.media!.integrations = config.media!.integrations.filter(
      (entry) => entry.id !== 'videos',
    );
    const paused = await run(response.body.jobId);
    expect(paused).toMatchObject({
      phase: 'requires_attention',
      error: { code: 'not_ready' },
      provider: { operationId: 'operation-1', certainty: 'submitted' },
    });
    await request(app)
      .post(`/api/media/jobs/${response.body.jobId}/retry`)
      .send({ clientRequestId: 'unsafe-direct-retry' })
      .expect(422);
    expect(posts).toBe(1);
    expect(polls).toBe(0);
  });

  it('resumes Vertex polling after token refresh and lost storage acknowledgment without a second generation', async () => {
    const catalog = mediaCatalogSchema.parse((await request(app).get('/api/media/catalog')).body);
    const response = await submit('vertex-video', {
      operation: 'video.generate',
      selection: { connectionId: 'vertex', modelId: vertexModel, catalogVersion: catalog.version },
      parameters: { count: 1, durationSeconds: 4, resolution: '720p', audio: false },
    });
    expect(response.status).toBe(202);
    const running = await run(response.body.jobId);
    expect(running?.phase).toBe('running');
    expect(running?.provider.operationId).toBe(vertexOperation);
    vertexToken = 'renewed-access-2';
    const commit = repository.commitMediaAssetWrite.bind(repository);
    jest.spyOn(repository, 'commitMediaAssetWrite').mockImplementationOnce(async (input) => {
      await commit(input);
      throw new Error('Lost Vertex video storage acknowledgment');
    });
    expect((await run(response.body.jobId))?.phase).toBe('ingesting');
    expect(logged.splice(0).map((error) => error.message)).toEqual([
      `[media] Job ${response.body.jobId} failed unexpectedly.`,
    ]);
    config.media = resolveMediaConfig();
    const completed = await run(response.body.jobId);
    expect(completed?.phase).toBe('succeeded');
    const output = completed?.outputs[0];
    expect(output).toMatchObject({
      kind: 'video',
      state: 'ready',
      asset: { type: 'video/mp4', bytes: 32 },
    });
    expect(posts).toBe(1);
    expect(polls).toBe(1);
    expect(vertexAuthorizations).toEqual(['Bearer access-1', 'Bearer renewed-access-2']);
    expect(
      JSON.stringify(
        (await request(app).get(`/api/media/jobs/${response.body.jobId}`).expect(200)).body,
      ),
    ).not.toMatch(/Bearer|fixture-auth|original-service-account/);
  });

  it('restores a video reference for an opted-in client and sends its original bytes in a follow-up', async () => {
    const catalog = mediaCatalogSchema.parse((await request(app).get('/api/media/catalog')).body);
    const selection = {
      connectionId: 'vertex',
      modelId: vertexModel,
      catalogVersion: catalog.version,
    };
    const first = await submit('initial-video', { operation: 'video.generate', selection });
    expect(first.status).toBe(202);
    await run(first.body.jobId);
    const completed = await run(first.body.jobId);
    expect(completed?.phase).toBe('succeeded');
    const output = completed!.outputs[0];
    if (output.kind !== 'video' || output.state !== 'ready') throw new Error('Missing video');
    const legacy = await request(app).get(`/api/media/threads/${first.body.threadId}`).expect(200);
    expect(
      mediaThreadDetailSchema.omit({ latestVideoContext: true }).safeParse(legacy.body).success,
    ).toBe(true);
    expect(legacy.body).not.toHaveProperty('latestVideoContext');
    const restored = await request(app)
      .get(`/api/media/threads/${first.body.threadId}`)
      .query({ include: 'videoContext' })
      .expect(200);
    const context = mediaThreadDetailSchema.parse(restored.body).latestVideoContext!;
    expect(
      mediaThreadDetailSchema
        .extend({ latestVideoContext: mediaAssetContextSchema.optional() })
        .safeParse(restored.body).success,
    ).toBe(true);
    expect(context).toEqual({ turnId: first.body.turnId, asset: output.asset });
    const versioned = await request(app)
      .get(`/api/media/threads/${first.body.threadId}`)
      .query({ include: 'videoContext', videoContextVersion: '2' })
      .expect(200);
    expect(mediaThreadDetailSchema.parse(versioned.body).latestVideoContext).toEqual(context);
    const followUp = await submit('follow-up-video', {
      operation: 'video.generate',
      selection,
      threadId: first.body.threadId,
      parentTurnId: context.turnId,
      prompt: 'Continue following the boat',
      inputs: [{ role: 'video', file_id: context.asset.file_id }],
    });
    expect(followUp.status).toBe(202);
    const runningFollowUp = await run(followUp.body.jobId);
    expect({
      phase: runningFollowUp?.phase,
      errors: logged.map((error) =>
        error.cause instanceof Error ? error.cause.message : error.message,
      ),
    }).toEqual({ phase: 'running', errors: [] });
    const bytes = Buffer.alloc(32);
    bytes.write('ftyp', 4);
    bytes.write('mp42', 8);
    expect(vertexBodies[1]).toMatchObject({
      instances: [
        {
          prompt: 'Continue following the boat',
          video: { mimeType: 'video/mp4', bytesBase64Encoded: bytes.toString('base64') },
        },
      ],
      parameters: {
        aspectRatio: '16:9',
        generateAudio: false,
        resolution: '720p',
        sampleCount: 1,
      },
    });
    expect(vertexBodies[1]).not.toHaveProperty('parameters.task');
    expect(posts).toBe(2);
  });

  it.each(['expired', 'deleted'] as const)(
    'returns authoritative null video context for a %s original without serializing thread reads',
    async (unavailable) => {
      const catalog = mediaCatalogSchema.parse((await request(app).get('/api/media/catalog')).body);
      const first = await submit(`unavailable-video-${unavailable}`, {
        operation: 'video.generate',
        selection: {
          connectionId: 'vertex',
          modelId: vertexModel,
          catalogVersion: catalog.version,
        },
      });
      expect(first.status).toBe(202);
      await run(first.body.jobId);
      const completed = await run(first.body.jobId);
      expect(completed?.phase).toBe('succeeded');
      const output = completed!.outputs[0];
      if (output.kind !== 'video' || output.state !== 'ready' || !output.asset)
        throw new Error('Missing video');
      const asset = output.asset;
      const url = `/api/media/threads/${first.body.threadId}`;
      const live = await request(app).get(url).query({ include: 'videoContext' }).expect(200);
      expect(mediaThreadDetailSchema.parse(live.body).latestVideoContext?.asset).toEqual(asset);
      const file = {
        user: new mongoose.Types.ObjectId(scope.ownerId),
        tenantId: scope.tenantId,
        file_id: asset.file_id,
      };
      // Simulate external expiry or deletion beyond the immutable-original write guard.
      if (unavailable === 'expired') {
        const expired = await mongoose.models.File.collection.updateOne(file, {
          $set: { mediaHardExpiresAt: new Date(Date.now() - 1000) },
        });
        expect(expired.matchedCount).toBe(1);
      } else {
        const deleted = await mongoose.models.File.collection.deleteOne(file);
        expect(deleted.deletedCount).toBe(1);
      }
      const readThread = repository.getMediaThread.bind(repository);
      let releaseThread!: () => void;
      let enterThread!: () => void;
      const released = new Promise<void>((resolve) => {
        releaseThread = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        enterThread = resolve;
      });
      jest.spyOn(repository, 'getMediaThread').mockImplementationOnce(async (...args) => {
        enterThread();
        await released;
        return readThread(...args);
      });
      const turnsRead = jest.spyOn(repository, 'listMediaTurns');
      const imageRead = jest.spyOn(repository, 'getMediaLatestImageContext');
      const videoRead = jest.spyOn(repository, 'getMediaLatestVideoContext');
      const restored = request(app)
        .get(url)
        .query({ include: 'videoContext', videoContextVersion: '2' })
        .expect(200)
        .then((response) => response);
      try {
        await entered;
        expect(turnsRead).toHaveBeenCalledTimes(1);
        expect(imageRead).toHaveBeenCalledTimes(1);
        expect(videoRead).toHaveBeenCalledTimes(1);
      } finally {
        releaseThread();
        await restored;
      }
      const detail = mediaThreadDetailSchema.parse((await restored).body);
      expect(detail.latestVideoContext).toBeNull();
      expect(detail.turns.items[0].jobs[0].outputs).toContainEqual(output);
      const legacy = await request(app).get(url).expect(200);
      expect(legacy.body).not.toHaveProperty('latestVideoContext');
      expect(
        mediaThreadDetailSchema.omit({ latestVideoContext: true }).safeParse(legacy.body).success,
      ).toBe(true);
      expect(videoRead).toHaveBeenCalledTimes(1);
      const previous = await request(app).get(url).query({ include: 'videoContext' }).expect(200);
      expect(previous.body).not.toHaveProperty('latestVideoContext');
      expect(
        mediaThreadDetailSchema
          .extend({ latestVideoContext: mediaAssetContextSchema.optional() })
          .safeParse(previous.body).success,
      ).toBe(true);
      expect(videoRead).toHaveBeenCalledTimes(2);
      const excluded = await request(app).get(url).query({ videoContextVersion: '2' }).expect(200);
      expect(excluded.body).not.toHaveProperty('latestVideoContext');
      expect(videoRead).toHaveBeenCalledTimes(2);
    },
  );

  it('recovers a direct original committed before its acknowledgment without a second inference', async () => {
    const commit = repository.commitMediaAssetWrite.bind(repository);
    jest.spyOn(repository, 'commitMediaAssetWrite').mockImplementationOnce(async (input) => {
      await commit(input);
      throw new Error('Lost storage publication acknowledgment');
    });
    const response = await submit('lost-storage-ack');
    expect((await run(response.body.jobId))?.phase).toBe('ingesting');
    expect(logged.splice(0).map((error) => error.message)).toEqual([
      `[media] Job ${response.body.jobId} failed unexpectedly.`,
    ]);
    const recovered = await run(response.body.jobId);
    expect(recovered?.phase).toBe('succeeded');
    expect(recovered?.outputs[0]).toMatchObject({ kind: 'image', state: 'ready' });
    expect(posts).toBe(1);
  });

  it('recovers an already generated image after its media connection is excluded', async () => {
    const commit = repository.commitMediaAssetWrite.bind(repository);
    jest.spyOn(repository, 'commitMediaAssetWrite').mockImplementationOnce(async (input) => {
      await commit(input);
      throw new Error('Lost storage publication acknowledgment');
    });
    const response = await submit('image-before-provider-exclusion');
    expect((await run(response.body.jobId))?.phase).toBe('ingesting');
    expect(logged.splice(0).map((error) => error.message)).toEqual([
      `[media] Job ${response.body.jobId} failed unexpectedly.`,
    ]);
    config.media!.integrations.find((entry) => entry.id === 'images')!.enabled = false;
    const recovered = await run(response.body.jobId);
    expect(recovered?.phase).toBe('succeeded');
    expect(recovered?.outputs[0]).toMatchObject({ kind: 'image', state: 'ready' });
    expect(posts).toBe(1);
  });

  it.each([
    ['unsafe-svg', 'unsupported'],
    ['mislabeled', 'invalid_request'],
  ] as const)(
    'settles a permanently invalid %s output and releases execution capacity',
    async (mode, code) => {
      config.media!.execution = {
        maxActiveTotal: 1,
        maxActivePerIntegration: 1,
        maxActivePerUser: 1,
      };
      const settle = jest.spyOn(accounting, 'settle');
      behavior = mode;
      const response = await submit(`invalid-${mode}`);
      expect(response.status).toBe(202);
      const failed = await run(response.body.jobId);
      expect(failed).toMatchObject({
        phase: 'failed',
        error: { code },
        provider: { certainty: 'terminal' },
      });
      expect(settle).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: response.body.jobId }),
        { inputTokens: 3, outputTokens: 7 },
        expect.anything(),
      );
      expect(posts).toBe(1);
      behavior = 'image';
      const next = await submit(`after-invalid-${mode}`);
      expect(next.status).toBe(202);
      expect((await run(next.body.jobId))?.phase).toBe('succeeded');
      expect(posts).toBe(2);
    },
  );

  it('fails a lost inline output on recovery without replaying inference or blocking the next job', async () => {
    config.media!.execution = {
      maxActiveTotal: 1,
      maxActivePerIntegration: 1,
      maxActivePerUser: 1,
    };
    const settle = jest.spyOn(accounting, 'settle');
    jest
      .spyOn(repository, 'reserveMediaAssetWrite')
      .mockRejectedValueOnce(new Error('Storage temporarily unavailable'));
    const response = await submit('lost-inline-output');
    expect((await run(response.body.jobId))?.phase).toBe('ingesting');
    expect(logged.splice(0).map((error) => error.message)).toEqual([
      `[media] Job ${response.body.jobId} failed unexpectedly.`,
    ]);
    expect(settle).not.toHaveBeenCalled();
    const failed = await run(response.body.jobId);
    expect(failed).toMatchObject({
      phase: 'failed',
      error: { code: 'output_expired' },
      provider: { certainty: 'terminal' },
    });
    expect(settle).toHaveBeenCalledTimes(1);
    expect(posts).toBe(1);
    const next = await submit('after-lost-inline');
    expect((await run(next.body.jobId))?.phase).toBe('succeeded');
    expect(posts).toBe(2);
  });

  it('runs the media agent toolkit through durable submission and reuses its saved File', async () => {
    config.media!.surfaces.tools = true;
    config.media!.tools.imageTimeoutMs = 1;
    const [generate, status] = runtime.tools(
      Object.assign(Object.create(express.request), {
        user: { id: scope.ownerId, role: 'USER' },
        config,
      }),
    );
    const submitted = await generate.invoke(
      {
        type: 'tool_call',
        name: 'media_generate',
        id: 'generate-image',
        args: {
          operation: 'image.generate',
          prompt: 'A small observatory',
          connectionId: 'images',
          modelId: 'gpt-image-1',
        },
      },
      { metadata: { run_id: 'message', thread_id: 'chat' } },
    );
    const receipt = JSON.parse(String(submitted.content)).media as { jobId: string };
    expect(generationAdmissions).toBe(1);
    expect((await run(receipt.jobId))?.phase).toBe('succeeded');
    const completed = await status.invoke({
      type: 'tool_call',
      name: 'media_status',
      id: 'read-image',
      args: { jobId: receipt.jobId },
    });
    const visible = JSON.parse(String(completed.content)) as {
      media: { phase: string };
      files: Array<{ file_id: string }>;
    };
    expect(visible.media.phase).toBe('succeeded');
    expect(visible.files).toHaveLength(1);
    expect(await mongoose.models.File.countDocuments({ file_id: visible.files[0].file_id })).toBe(
      1,
    );
    expect(posts).toBe(1);
  });

  it('leaves plain Google text admission with the existing model credential policy', async () => {
    const factory = await runtime.nativeFactory(
      Object.assign(Object.create(express.request), {
        user: { id: scope.ownerId, role: 'USER' },
      }),
      {
        conversationId: 'plain-chat',
        messageId: 'plain-message',
        prompt: 'Hello',
        temporary: false,
      },
    );
    const port = await factory?.({
      provider: 'google',
      model: 'text-only-model',
      apiKey: 'sdk-specific-key',
      baseURL: 'https://another-sdk-proxy.example',
    });
    await expect(
      port?.start({ modelRunId: 'plain-run', model: 'text-only-model' }),
    ).resolves.toBeUndefined();
    expect(await repository.listMediaThreads({ scope, limit: 10 })).toMatchObject({ items: [] });
  });

  it.each(['MALFORMED_FUNCTION_CALL', 'SAFETY'])(
    'preserves ordinary Google %s responses without role or storage reads',
    async (finishReason) => {
      config.media!.assets.source = FileSources.firebase;
      const storageProbe = jest.spyOn(cloudStrategy, 'getStorageState');
      const factory = await runtime.nativeFactory(
        Object.assign(Object.create(express.request), {
          user: { id: scope.ownerId, role: 'USER' },
          config,
        }),
        {
          conversationId: 'text-chat',
          messageId: 'text-message',
          prompt: 'Hello',
          temporary: false,
        },
      );
      if (!factory) throw new Error('Missing native factory');
      const bodies: Array<{ generationConfig?: { responseModalities?: string[] } }> = [];
      const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        bodies.push(JSON.parse(await request.text()));
        return new Response(
          JSON.stringify({
            candidates: [{ index: 0, finishReason, content: { role: 'model', parts: [] } }],
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      });
      try {
        const model = new CustomChatGoogleGenerativeAI({
          model: 'gemini-text',
          apiKey: 'fixture',
          maxRetries: 0,
          nativeMedia: createDeferredNativeMediaPort(factory, {
            provider: 'google',
            model: 'gemini-text',
          }),
        });
        await expect(model.invoke('Hello')).resolves.toBeDefined();
        expect(bodies).toHaveLength(1);
        expect(bodies[0].generationConfig?.responseModalities).toBeUndefined();
        expect(roleReads).toBe(0);
        expect(storageProbe).not.toHaveBeenCalled();
      } finally {
        fetch.mockRestore();
        storageProbe.mockRestore();
      }
    },
  );

  it('restores a 24-part native transcript in one authorized database batch', async () => {
    const model = 'gemini-2.5-flash-image';
    const nativeSignatures: NativeSignatures = {};
    const contentParts: unknown[] = [];
    config.media!.integrations.push({
      id: 'google-images',
      api: 'google.generateContent',
      endpointRef: { kind: 'builtin', endpoint: EModelEndpoint.google },
      catalog: { kind: 'configured', models: [model] },
      operations: ['image.generate'],
    });
    const factory = await runtime.nativeFactory(
      Object.assign(Object.create(express.request), {
        user: { id: scope.ownerId, role: 'USER' },
      }),
      {
        conversationId: 'batch-chat',
        messageId: 'batch-message',
        nativeSignatures,
        prompt: 'Explain',
        temporary: false,
      },
    );
    const port = await factory?.({
      provider: 'google',
      model,
      apiKey: 'fixture-google',
      baseURL: root,
    });
    if (!port?.restoreBatch) throw new Error('Missing batched native port');
    await port.start({ modelRunId: 'batch-run', model });
    const parts: Array<{ continuationRef: string }> = [];
    for (let index = 0; index < 24; index++) {
      const content = await port.part({
        modelRunId: 'batch-run',
        chunkIndex: index,
        partIndex: 0,
        part: { kind: 'text', text: `Caption ${index}`, thoughtSignature: `signature-${index}` },
      });
      parts.push(content.native_media!);
      contentParts.push(content);
    }
    await port.complete({ modelRunId: 'batch-run' });
    await mongoose.models.Message.create({
      user: scope.ownerId,
      conversationId: 'batch-chat',
      messageId: 'batch-message',
      isCreatedByUser: false,
      content: contentParts,
      metadata: { nativeSignatures },
    });
    expect(await mongoose.models.MediaJob.countDocuments()).toBe(0);
    const batch = jest.spyOn(repository, 'getNativeMessageParts');
    const legacy = jest.spyOn(repository, 'getMediaNativeContinuations');
    const reloadFactory = await runtime.nativeFactory(
      Object.assign(Object.create(express.request), { user: { id: scope.ownerId, role: 'USER' } }),
      {
        conversationId: 'batch-chat',
        messageId: 'next-message',
        prompt: 'Continue',
        temporary: false,
      },
    );
    const reload = await reloadFactory?.({
      provider: 'google',
      model: 'another-google-model',
      apiKey: 'rotated-key',
      responseModalities: ['TEXT'],
    });
    if (!reload?.restoreBatch) throw new Error('Missing replay port');
    const restored = await reload.restoreBatch({ parts });
    expect(restored).toEqual(
      parts.map((_part, index) => ({
        kind: 'text',
        text: `Caption ${index}`,
        thoughtSignature: `signature-${index}`,
      })),
    );
    expect(batch).toHaveBeenCalledTimes(1);
    expect(legacy).not.toHaveBeenCalled();
    const resumedSignatures: NativeSignatures = {};
    await runtime.nativeFactory(
      Object.assign(Object.create(express.request), { user: { id: scope.ownerId, role: 'USER' } }),
      {
        conversationId: 'batch-chat',
        messageId: 'batch-message',
        prompt: 'Resume',
        temporary: false,
        nativeSignatures: resumedSignatures,
        previousContent: [
          { type: 'text', text: 'Earlier', native_media: { continuationRef: 'another-message:0' } },
          contentParts[23],
        ],
      },
    );
    expect(resumedSignatures).toEqual({
      '23': { text: 'Caption 23', thoughtSignature: 'signature-23' },
    });
  });

  it('saves native Gemini originals as ordinary Files and restores owned Message metadata across model and key changes', async () => {
    const nativeSignatures: NativeSignatures = {};
    config.media!.integrations.push({
      id: 'google-images',
      api: 'google.generateContent',
      endpointRef: { kind: 'builtin', endpoint: EModelEndpoint.google },
      catalog: { kind: 'configured', models: ['gemini-2.5-flash-image'] },
      operations: ['image.generate', 'image.edit'],
    });
    const factory = await runtime.nativeFactory(
      Object.assign(Object.create(express.request) as express.Request, {
        user: { id: scope.ownerId, role: 'USER' },
      }),
      {
        conversationId: 'chat-one',
        messageId: 'assistant-one',
        nativeSignatures,
        prompt: 'Draw an observatory',
        temporary: false,
      },
    );
    const port = await factory?.({
      provider: 'google',
      model: 'gemini-2.5-flash-image',
      apiKey: 'fixture-google',
      baseURL: root,
    });
    if (!port) {
      throw new Error('Native recording port is unavailable');
    }
    expect(await port.start({ modelRunId: 'native-run', model: 'gemini-2.5-flash-image' })).toEqual(
      { responseModalities: ['TEXT', 'IMAGE'] },
    );
    const text = await port.part({
      modelRunId: 'native-run',
      chunkIndex: 0,
      partIndex: 0,
      part: {
        kind: 'text',
        text: 'Here is the observatory.',
        thoughtSignature: 'private-text-signature',
      },
    });
    const image = await port.part({
      modelRunId: 'native-run',
      chunkIndex: 1,
      partIndex: 0,
      part: {
        kind: 'image',
        mimeType: 'image/png',
        data: original.toString('base64'),
        thoughtSignature: 'private-image-signature',
      },
    });
    expect(JSON.stringify([text, image])).not.toContain('private-');
    expect(JSON.stringify(image)).not.toContain(original.toString('base64'));
    if (image.type !== 'image_file') {
      throw new Error('Expected a durable image part');
    }
    config.media!.integrations.find((entry) => entry.id === 'google-images')!.enabled = false;
    const selection = {
      provider: 'google',
      model: 'gemini-2.5-flash-image',
      apiKey: 'fixture-google',
      baseURL: root,
    };
    const textPort = await factory?.(selection);
    expect(
      await textPort?.start({ modelRunId: 'text-after-exclusion', model: selection.model }),
    ).toBeUndefined();
    const excludedImagePort = await factory?.({
      ...selection,
      responseModalities: ['TEXT', 'IMAGE'],
    });
    await expect(
      excludedImagePort?.start({ modelRunId: 'image-after-exclusion', model: selection.model }),
    ).rejects.toMatchObject({ code: 'unsupported' });
    await expect(
      textPort?.restore({
        file_id: image.image_file.file_id,
        continuationRef: image.native_media?.continuationRef,
      }),
    ).resolves.toMatchObject({
      kind: 'image',
      data: original.toString('base64'),
      thoughtSignature: 'private-image-signature',
    });
    await port.complete({ modelRunId: 'native-run' });
    await mongoose.models.Message.create({
      user: scope.ownerId,
      conversationId: 'chat-one',
      messageId: 'assistant-one',
      isCreatedByUser: false,
      content: [text, image],
      metadata: { nativeSignatures },
    });
    expect(await mongoose.models.MediaJob.countDocuments()).toBe(0);
    expect(await mongoose.models.MediaThread.countDocuments()).toBe(0);
    expect(await mongoose.models.MediaNativePart.countDocuments()).toBe(0);
    expect(
      await mongoose.models.File.findOne({ file_id: image.image_file.file_id }).lean(),
    ).toMatchObject({ context: FileContext.image_generation });
    expect(
      await mongoose.models.File.findOne({ file_id: image.image_file.file_id }).lean(),
    ).not.toHaveProperty('mediaLifecycle');
    const makeReplay = async (ownerId: string, tenantId?: string, requestConfig?: AppConfig) => {
      const loaded = await runtime.nativeFactory(
        Object.assign(Object.create(express.request), {
          user: { id: ownerId, role: 'USER', tenantId },
          config: requestConfig,
        }),
        { conversationId: 'chat-one', messageId: 'next', prompt: 'Continue', temporary: false },
      );
      return loaded?.({
        provider: 'google',
        model: 'different-model',
        apiKey: 'rotated-key',
        responseModalities: ['TEXT'],
      });
    };
    const reference = {
      file_id: image.image_file.file_id,
      continuationRef: image.native_media?.continuationRef,
    };
    await expect((await makeReplay(scope.ownerId))?.restore(reference)).resolves.toMatchObject({
      kind: 'image',
      data: original.toString('base64'),
      thoughtSignature: 'private-image-signature',
    });
    expect(nativeDownload).toHaveBeenLastCalledWith(
      expect.objectContaining({ config, user: expect.objectContaining({ id: scope.ownerId }) }),
      image.image_file.filepath,
    );
    const requestConfig = { ...config, config: { ...config.config, version: 'request-config' } };
    await expect(
      (await makeReplay(scope.ownerId, undefined, requestConfig))?.restore(reference),
    ).resolves.toMatchObject({ data: original.toString('base64') });
    expect(nativeDownload.mock.lastCall?.[0]).toHaveProperty('config', requestConfig);
    await expect(
      (await makeReplay(new mongoose.Types.ObjectId().toString()))?.restore(reference),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      (await makeReplay(scope.ownerId, 'foreign-tenant'))?.restore(reference),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(posts).toBe(0);
    expect(await mongoose.connection.collection('transactions').countDocuments()).toBe(0);
  });

  it.each([false, true])(
    'awaits native failure billing without creating Studio bookkeeping when billing rejects: %s',
    async (rejectBilling) => {
      const model = 'gemini-2.5-flash-image';
      config.media!.integrations.push({
        id: 'google-images',
        api: 'google.generateContent',
        endpointRef: { kind: 'builtin', endpoint: EModelEndpoint.google },
        catalog: { kind: 'configured', models: [model] },
        operations: ['image.generate'],
      });
      let release!: () => void;
      const billing = new Promise<void>((resolve) => {
        release = resolve;
      });
      const onUsage = jest.fn(async () => {
        await billing;
        if (rejectBilling) throw new Error('Billing unavailable');
      });
      const factory = await runtime.nativeFactory(
        Object.assign(Object.create(express.request), {
          user: { id: scope.ownerId, role: 'USER' },
        }),
        {
          conversationId: 'native-failure-chat',
          messageId: 'native-failure-message',
          prompt: 'Draw',
          temporary: false,
        },
        onUsage,
      );
      const port = await factory?.({
        provider: 'google',
        model,
        apiKey: 'fixture-google',
        baseURL: root,
        agentId: 'child',
        usageType: 'subagent',
      });
      if (!port) throw new Error('Missing native port');
      await port.start({ modelRunId: 'native-failed-call', model });
      let settled = false;
      const failure = port
        .fail({
          modelRunId: 'native-failed-call',
          reason: 'storage',
          usage: { input_tokens: 30, output_tokens: 8, total_tokens: 38 },
        })
        .finally(() => {
          settled = true;
        });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(onUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          modelRunId: 'native-failed-call',
          usageType: 'subagent',
          agentId: 'child',
        }),
      );
      release();
      if (rejectBilling) await expect(failure).rejects.toThrow('Billing unavailable');
      else await failure;
      expect(await mongoose.models.MediaJob.countDocuments()).toBe(0);
    },
  );

  it('keeps a configured Google image model text-only when chat cannot record images', async () => {
    config.media!.integrations.push({
      id: 'google-images',
      api: 'google.generateContent',
      endpointRef: { kind: 'builtin', endpoint: EModelEndpoint.google },
      catalog: { kind: 'configured', models: ['gemini-2.5-flash-image'] },
      operations: ['image.generate'],
    });
    config.media!.surfaces.chat = false;
    const factory = await runtime.nativeFactory(
      Object.assign(Object.create(express.request) as express.Request, {
        user: { id: scope.ownerId, role: 'USER' },
      }),
      { conversationId: 'chat-text', messageId: 'assistant-text', prompt: 'Hi', temporary: false },
    );
    const selection = {
      provider: 'google',
      model: 'gemini-2.5-flash-image',
      apiKey: 'fixture-google',
      baseURL: root,
    };
    const port = await factory?.(selection);
    await expect(port?.start({ modelRunId: 'text-run', model: selection.model })).resolves.toEqual({
      responseModalities: ['TEXT'],
    });
    await expect(
      port?.part({
        modelRunId: 'text-run',
        chunkIndex: 0,
        partIndex: 0,
        part: { kind: 'text', text: 'Hello.' },
      }),
    ).resolves.toEqual({ type: 'text', text: 'Hello.' });
    const explicit = await factory?.({ ...selection, responseModalities: ['TEXT', 'IMAGE'] });
    await expect(
      explicit?.start({ modelRunId: 'image-run', model: selection.model }),
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(await mongoose.models.File.countDocuments()).toBe(0);
  });

  it('removes late upload bytes when cleanup retired its reservation before the stream opened', async () => {
    const storage = createMediaStorage({
      repository,
      imageDirectory: path.join(directory, 'images'),
      uploadDirectory: path.join(directory, 'uploads'),
      now: Date.now,
    });
    const reserve = repository.reserveMediaAssetWrite.bind(repository);
    jest.spyOn(repository, 'reserveMediaAssetWrite').mockImplementationOnce(async (input) => {
      const receipt = await reserve(input);
      expect(
        await storage.discardWrite(
          scope,
          receipt.writeId,
          new Date(Date.now() + 60_000).toISOString(),
        ),
      ).toBe(true);
      return receipt;
    });
    await expect(
      storage.publish({
        scope,
        outputKey: 'paused-upload',
        stream: Readable.from(original),
        type: 'image/png',
        filename: 'original.png',
        config: config.media!,
      }),
    ).rejects.toThrow('Media asset write not found');
    expect(await readdir(path.join(directory, 'images', scope.ownerId))).toEqual([]);
  });

  it('rejects oversized and unsupported uploads before they reach staging or storage', async () => {
    config.media!.transfers.maxImageBytes = 16;
    const staging = path.join(directory, 'uploads', 'temp', scope.ownerId, 'media');
    const reservation = jest.spyOn(repository, 'reserveMediaAssetWrite');
    const oversized = await request(app)
      .post('/api/media/uploads')
      .attach('file', original, { filename: 'big.png', contentType: 'image/png' })
      .expect(413);
    expect(oversized.body).toEqual({ error: { code: 'invalid_request' } });
    const unsupported = await request(app)
      .post('/api/media/uploads')
      .attach('file', Buffer.from('%PDF-1.4'), {
        filename: 'notes.pdf',
        contentType: 'application/pdf',
      })
      .expect(422);
    expect(unsupported.body).toEqual({ error: { code: 'unsupported' } });
    expect(await readdir(staging).catch(() => [])).toEqual([]);
    expect(reservation).not.toHaveBeenCalled();
  });

  it('denies mutations for a read-only role and isolates another owner', async () => {
    const response = await submit('private');
    userRole = 'READ_ONLY';
    expect((await submit('forbidden')).status).toBe(403);
    scope = { ...scope, ownerId: new mongoose.Types.ObjectId().toString() };
    await request(app).get(`/api/media/jobs/${response.body.jobId}`).expect(404);
    await request(app).get(`/api/media/threads/${response.body.threadId}`).expect(404);
  });

  it('lists saved creations until expiry when retention applies to every thread', async () => {
    config.interfaceConfig = {
      ...config.interfaceConfig,
      retentionMode: RetentionMode.ALL,
      generalChatRetention: 24,
    };
    const response = await submit('saved-retention');
    expect(response.status).toBe(202);
    await run(response.body.jobId);
    const thread = await request(app)
      .get(`/api/media/threads/${response.body.threadId}`)
      .expect(200);
    expect(thread.body.thread).toMatchObject({ temporary: false, expiresAt: expect.any(String) });
    for (const query of ['', '?include=activity']) {
      const listing = await request(app).get(`/api/media/threads${query}`).expect(200);
      expect(listing.body.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ threadId: response.body.threadId, temporary: false }),
        ]),
      );
    }
  });

  it('searches titles and bulk retires selected or all creations through the owned HTTP surface', async () => {
    const first = await submit('bulk-first', { prompt: 'A [moon] rises' });
    const second = await submit('bulk-second', { prompt: 'A sun rises' });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const search = await request(app)
      .get('/api/media/threads')
      .query({ search: '[MOON]', include: 'activity' })
      .expect(200);
    expect(search.body.items.map((thread: { threadId: string }) => thread.threadId)).toEqual([
      first.body.threadId,
    ]);
    await request(app)
      .get('/api/media/threads')
      .query({ search: 'x'.repeat(config.media!.limits.maxTitleChars + 1) })
      .expect(422);
    const selected = await request(app)
      .delete('/api/media/threads')
      .send({ mode: 'selected', threadIds: [first.body.threadId, 'missing'] })
      .expect(202);
    expect(selected.body).toEqual({
      retired: 1,
      failures: [{ threadId: 'missing', error: { code: 'not_found' } }],
    });
    await request(app)
      .delete('/api/media/threads')
      .send({
        mode: 'selected',
        threadIds: Array.from(
          { length: config.media!.limits.maxPageSize + 1 },
          (_, index) => `id-${index}`,
        ),
      })
      .expect(422);
    const cleared = await request(app)
      .delete('/api/media/threads')
      .send({ mode: 'all' })
      .expect(202);
    expect(cleared.body).toEqual({ retired: 1, failures: [] });
    expect((await request(app).get('/api/media/threads').expect(200)).body.items).toEqual([]);
    expect((await submit('after-clear')).status).toBe(202);
  });

  it('keeps a temporary creation out of the library and never asks the title model to name it', async () => {
    config.media!.titles.endpoint = 'Fixture';
    config.media!.titles.model = 'fixture-title';
    const admittedAt = Date.now();
    const response = await submit('temporary-creation', { temporary: true });
    expect(response.status).toBe(202);
    const receipt = mediaSubmissionReceiptSchema.parse(response.body);
    expect(receipt.phase).toBe('accepted');
    await request(app).get(`/api/media/threads/${receipt.threadId}`).expect(200);
    const opened = await request(app).get(`/api/media/threads/${receipt.threadId}`).expect(200);
    expect(mediaThreadDetailSchema.parse(opened.body).latestImageContext).toBeUndefined();
    const thread = mediaThreadSchema.parse(opened.body.thread);
    const retentionMs = getTempChatRetentionHours(config.interfaceConfig) * 3_600_000;
    expect(thread.expiresAt).toBe(
      (await repository.getMediaJob(scope, receipt.jobId))?.publicationExpiresAt?.toISOString(),
    );
    expect(Date.parse(thread.expiresAt!)).toBeGreaterThanOrEqual(admittedAt + retentionMs);
    expect(Date.parse(thread.expiresAt!)).toBeLessThanOrEqual(Date.now() + retentionMs);
    for (const query of ['', '?include=activity']) {
      const listed = await request(app).get(`/api/media/threads${query}`).expect(200);
      expect(listed.body.items).toEqual([]);
    }
    await run(receipt.jobId);
    expect(chatBodies).toHaveLength(0);

    const durable = mediaSubmissionReceiptSchema.parse((await submit('durable-creation')).body);
    await run(durable.jobId);
    expect(chatBodies).toHaveLength(1);
    expect(JSON.stringify(chatBodies[0].messages)).not.toContain('temporary');
    const listed = await request(app).get('/api/media/threads').expect(200);
    expect(listed.body.items.map((item: { threadId: string }) => item.threadId)).toEqual([
      durable.threadId,
    ]);
    expect(listed.body.items[0]).not.toHaveProperty('expiresAt');
    await request(app)
      .post('/api/media/submissions')
      .send({
        clientRequestId: 'temporary-follow-up',
        prompt: 'A small observatory',
        operation: 'image.generate',
        temporary: true,
        threadId: durable.threadId,
        selection: { connectionId: 'images', modelId: 'gpt-image-1', catalogVersion: 'v1' },
      })
      .expect(422);
  });

  it('saves owned uploaded preset references, restores scoped previews and releases the last consumer', async () => {
    const uploaded = await request(app)
      .post('/api/media/uploads')
      .attach('file', original, { filename: 'preset-reference.png', contentType: 'image/png' })
      .expect(201);
    const fileId = uploaded.body.file.file_id as string;
    const settings = {
      operation: 'image.edit',
      connectionId: 'images',
      modelId: 'gpt-image-1',
      parameters: { quality: 'high' },
      inputs: [{ file_id: fileId, role: 'reference' }],
    };
    const created = mediaPresetSchema.parse(
      (
        await request(app)
          .post('/api/media/presets')
          .send({ title: 'Reference', settings })
          .expect(201)
      ).body,
    );
    expect(created.settings.inputs).toEqual(settings.inputs);
    expect(created.assets).toEqual([
      expect.objectContaining({ file_id: fileId, filepath: `/api/media/assets/${fileId}/content` }),
    ]);
    expect(created.assets[0]).not.toHaveProperty('source');
    const stored = await mongoose.models.File.findOne({ file_id: fileId }).lean<{
      mediaRetainers: string[];
      expiredAt?: Date;
    }>();
    expect(stored?.mediaRetainers).toEqual([`preset:${created.presetId}`]);
    expect(stored?.expiredAt).toBeUndefined();
    expect(
      mediaPresetListSchema.parse((await request(app).get('/api/media/presets').expect(200)).body)
        .items,
    ).toEqual([created]);
    await request(app).get(created.assets[0].filepath).expect(200);
    const stranger = { ...scope, ownerId: new mongoose.Types.ObjectId().toString() };
    expect(await repository.listMediaPresets(stranger)).toEqual([]);
    expect(await repository.listMediaPresets({ ...scope, tenantId: 'other' })).toEqual([]);
    await request(app)
      .post('/api/media/presets')
      .send({
        title: 'Hosted',
        settings: {
          ...settings,
          inputs: [{ ...settings.inputs[0], sourceURL: 'https://example.com/reference.png' }],
        },
      })
      .expect(422);
    config.media!.limits.maxInputs = 1;
    await request(app)
      .patch(`/api/media/presets/${created.presetId}`)
      .send({ settings: { ...settings, inputs: [...settings.inputs, ...settings.inputs] } })
      .expect(422);
    await request(app).delete(`/api/media/presets/${created.presetId}`).expect(200);
    expect(
      (await mongoose.models.File.findOne({ file_id: fileId }).lean<{ mediaRetainers: string[] }>())
        ?.mediaRetainers,
    ).toEqual([]);
    expect(
      await repository.claimMediaAssetDeletion({ scope, fileId, token: 'preset-deleted' }),
    ).not.toBeNull();
    expect(posts).toBe(0);
  });

  it('saves, lists, promotes and deletes Studio presets over HTTP with role and limit guards', async () => {
    const settings = {
      operation: 'image.generate',
      connectionId: 'images',
      modelId: 'gpt-image-1',
      parameters: { quality: 'high' },
    };
    const first = mediaPresetSchema.parse(
      (
        await request(app)
          .post('/api/media/presets')
          .send({ title: 'Bright', settings })
          .expect(201)
      ).body,
    );
    expect(first).toMatchObject({ title: 'Bright', isDefault: false });
    expect(first.settings).toMatchObject(settings);
    const second = mediaPresetSchema.parse(
      (
        await request(app)
          .post('/api/media/presets')
          .send({ title: 'Alpha', isDefault: true, settings })
          .expect(201)
      ).body,
    );
    const ids = async () =>
      mediaPresetListSchema
        .parse((await request(app).get('/api/media/presets').expect(200)).body)
        .items.map((preset) => [preset.presetId, preset.isDefault]);
    expect(await ids()).toEqual([
      [second.presetId, true],
      [first.presetId, false],
    ]);
    const promoted = mediaPresetSchema.parse(
      (
        await request(app)
          .patch(`/api/media/presets/${first.presetId}`)
          .send({ isDefault: true })
          .expect(200)
      ).body,
    );
    expect(promoted).toMatchObject({ presetId: first.presetId, isDefault: true, title: 'Bright' });
    expect(await ids()).toEqual([
      [first.presetId, true],
      [second.presetId, false],
    ]);
    await request(app).patch(`/api/media/presets/${first.presetId}`).send({}).expect(422);
    await request(app)
      .patch(`/api/media/presets/${first.presetId}`)
      .send({ title: 'x'.repeat(config.media!.limits.maxTitleChars + 1) })
      .expect(422);
    await request(app).patch('/api/media/presets/missing').send({ title: 'Ghost' }).expect(404);
    expect(
      (await request(app).delete(`/api/media/presets/${first.presetId}`).expect(200)).body,
    ).toEqual({ presetId: first.presetId });
    await request(app).delete(`/api/media/presets/${first.presetId}`).expect(404);
    expect(await ids()).toEqual([[second.presetId, false]]);

    config.media!.limits.maxPresets = 1;
    const over = await request(app).post('/api/media/presets').send({ title: 'Over', settings });
    expect(over.status).toBe(429);
    expect(over.body).toEqual({ error: { code: 'quota_exceeded' } });

    const stranger = { ...scope, ownerId: new mongoose.Types.ObjectId().toString() };
    expect(await repository.listMediaPresets(stranger)).toEqual([]);

    userRole = 'READ_ONLY';
    await request(app).post('/api/media/presets').send({ title: 'Nope', settings }).expect(403);
    await request(app)
      .patch(`/api/media/presets/${second.presetId}`)
      .send({ title: 'Nope' })
      .expect(403);
    await request(app).delete(`/api/media/presets/${second.presetId}`).expect(403);
    expect(await ids()).toEqual([[second.presetId, false]]);
  });
});
