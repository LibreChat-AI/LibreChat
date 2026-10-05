import axios from 'axios';
import sharp from 'sharp';
import multer from 'multer';
import { Keyv } from 'keyv';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { FileSources, EModelEndpoint, resolveMediaConfig } from 'librechat-data-provider';
import { createModels, createMethods, tenantStorage, runAsSystem } from '@librechat/data-schemas';
import type { AppConfig } from '@librechat/data-schemas';
import type { RequestHandler } from 'express';
import type { registerShutdownTask } from '~/app/shutdown';
import type { MediaRuntime } from './runtime';
import { createMediaApplication } from './application';

describe('shared Media application composition', () => {
  let mongo: MongoMemoryServer;
  let directory: string;
  let runtime: MediaRuntime;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    createModels(mongoose);
    directory = await mkdtemp(path.join(tmpdir(), 'media-application-'));
  });
  afterAll(async () => {
    await runtime?.worker.stop();
    await mongoose.disconnect();
    await mongo.stop();
    await rm(directory, { recursive: true, force: true });
  });

  it('mounts an enabled host with owner/tenant content authorization, shared bans, and host deadline cleanup', async () => {
    const ownerId = new mongoose.Types.ObjectId().toString();
    await mongoose.models.User.collection.insertOne({
      _id: new mongoose.Types.ObjectId(ownerId),
      tenantId: 'tenant-a',
      role: 'USER',
    });
    const db = createMethods(mongoose);
    const appConfig: AppConfig = {
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
            endpointRef: { kind: 'builtin', endpoint: EModelEndpoint.openAI },
            catalog: { kind: 'configured', models: ['gpt-image-1'] },
            operations: ['image.generate'],
          },
        ],
      }),
    };
    const auth: RequestHandler = (req, res, next) => {
      if (!req.headers['x-owner']) {
        res.sendStatus(401);
        return;
      }
      req.user = {
        id: req.headers['x-owner'],
        role: 'USER',
        tenantId: req.headers['x-tenant'],
      } as Express.User;
      next();
    };
    const ban: RequestHandler = (req, res, next) => {
      if (req.headers['x-banned']) {
        res.sendStatus(403);
        return;
      }
      next();
    };
    const pass: RequestHandler = (_req, _res, next) => next();
    const tasks: Parameters<typeof registerShutdownTask>[] = [];
    const errors: string[] = [];
    let canUse = true;
    const application = createMediaApplication({
      activityTransport: { useRedis: false },
      host: {
        db,
        getRoleByName: async () => ({ permissions: { MEDIA: { USE: canUse, CREATE: true } } }),
        getAppConfig: async () => appConfig,
        tenantContext: tenantStorage,
        asSystem: runAsSystem,
        environment: { OPENAI_API_KEY: 'fixture-key' },
        http: axios.create({
          adapter: async () => {
            throw new Error('No provider request expected');
          },
        }),
        upload: multer,
        loadServiceKey: async () => null,
        decrypt: async (value) => value,
        logger: {
          error: (message) => {
            errors.push(message);
          },
          warn: () => undefined,
          info: () => undefined,
        },
      },
      createCache: () => new Keyv(),
      registerShutdownTask: (...args) => {
        tasks.push(args);
      },
      getRemainingShutdownMs: () => 500,
      requireJwtAuth: auth,
      optionalJwtAuth: auth,
      checkBan: ban,
      optionalShareFileAuth: pass,
      tenantContextMiddleware: (req, _res, next) =>
        tenantStorage.run({ tenantId: req.headers['x-tenant'] as string }, next),
    });
    const app = express();
    app.use(express.json());
    runtime = application.initialize({
      app,
      appConfig,
      isLeader: async () => false,
      externalDeadlineAt: () => Date.now(),
    });
    application.mount(app, runtime);
    expect(app.locals.mediaRuntime).toBe(runtime);
    expect(tasks.map(([name, , options]) => [name, options])).toEqual([
      ['media activity', { phase: 'pre-drain' }],
      ['media activity transport', { priority: 90 }],
      ['media admission', { phase: 'pre-drain' }],
      ['media worker', { priority: 100 }],
    ]);
    const client = () => request(app);
    await client().get('/api/media/events').expect(401);
    canUse = false;
    await client()
      .get('/api/media/events')
      .set('x-owner', ownerId)
      .set('x-tenant', 'tenant-a')
      .expect(403);
    canUse = true;
    await client().get('/api/media/catalog').expect(401);
    await client()
      .get('/api/media/catalog')
      .set('x-owner', ownerId)
      .set('x-tenant', 'tenant-a')
      .expect(200);
    const server = app.listen(0);
    const controller = new AbortController();
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP fixture');
      const response = await fetch(`http://127.0.0.1:${address.port}/api/media/events`, {
        headers: { 'x-owner': ownerId, 'x-tenant': 'tenant-a' },
        signal: controller.signal,
      });
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const first = await response.body!.getReader().read();
      expect(new TextDecoder().decode(first.value)).toContain('"ready":true');
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'white' } })
      .png()
      .toBuffer();
    const uploaded = await client()
      .post('/api/media/uploads')
      .set('x-owner', ownerId)
      .set('x-tenant', 'tenant-a')
      .attach('file', png, { filename: 'reference.png', contentType: 'image/png' })
      .expect(201);
    const content = `/api/media/assets/${uploaded.body.file.file_id}/content`;
    await client()
      .get(content)
      .set('x-owner', ownerId)
      .set('x-tenant', 'tenant-a')
      .set('Range', 'bytes=0-3')
      .expect(206);
    await client().get(content).set('x-owner', ownerId).set('x-tenant', 'tenant-b').expect(404);
    await client()
      .get(content)
      .set('x-owner', new mongoose.Types.ObjectId().toString())
      .set('x-tenant', 'tenant-a')
      .expect(404);
    await client()
      .get(content)
      .set('x-owner', ownerId)
      .set('x-tenant', 'tenant-a')
      .set('x-banned', '1')
      .expect(403);
    for (const name of [
      'media activity',
      'media admission',
      'media worker',
      'media activity transport',
    ])
      await tasks.find(([task]) => task === name)![1]();
    expect(errors).toEqual([]);
  });
});
