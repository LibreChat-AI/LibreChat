import sharp from 'sharp';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import mongoose from 'mongoose';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMediaMethods } from '@librechat/data-schemas';
import { resolveMediaConfig } from 'librechat-data-provider';
import type { MediaAsset } from 'librechat-data-provider';
import { createFFmpegMediaProcessor, createMediaDerivativeProcessor } from './derivatives';
import { createOptionalCookieAuth } from '~/images/cookies';
import { createMediaContentRouter } from './stream';
import { createMediaStorage } from './storage';
import { MediaServiceError } from './errors';

describe('private native browser media streaming', () => {
  let mongo: MongoMemoryServer;
  let directory: string;
  let app: express.Express;
  let asset: MediaAsset;
  let original: Buffer;
  let revoked = false;
  const scope = { ownerId: new mongoose.Types.ObjectId().toString(), tenantId: null };
  const secret = 'media-stream-test-secret';
  const cookie = (id = scope.ownerId) =>
    `refreshToken=${jwt.sign({ id }, secret, { expiresIn: '1h' })}`;
  const log = jest.fn();
  let repository: ReturnType<typeof createMediaMethods>;
  let storage: ReturnType<typeof createMediaStorage>;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    directory = await mkdtemp(path.join(tmpdir(), 'media-stream-'));
    repository = createMediaMethods(mongoose, { ownerExists: async () => true });
    const config = resolveMediaConfig();
    storage = createMediaStorage({
      repository,
      imageDirectory: path.join(directory, 'images'),
      uploadDirectory: path.join(directory, 'uploads'),
      now: Date.now,
      derivatives: createMediaDerivativeProcessor({
        imageOutputType: 'png',
        video: createFFmpegMediaProcessor(),
        log,
      }),
    });
    original = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    asset = await storage.publish({
      scope,
      outputKey: 'stream-fixture',
      stream: Readable.from(original),
      type: 'image/png',
      filename: 'original.png',
      config,
    });
    app = express();
    app.use(
      createOptionalCookieAuth({
        parseCookies: (header) =>
          Object.fromEntries(
            header.split(';').map((entry) => {
              const [key, ...value] = entry.trim().split('=');
              return [key, value.join('=')];
            }),
          ),
        getSecret: () => secret,
        isOpenIdReuseEnabled: () => false,
        findSession: async () => (revoked ? null : {}),
        getUserById: async () => ({ role: 'USER' }),
        asSystem: (work) => work(),
        clearCloudFrontCookies: jest.fn(),
        log,
      }),
    );
    app.use(
      '/api/media/assets',
      createMediaContentRouter({
        repository,
        storage,
        log,
        resolveScope: (req) => {
          const user = req.user as { id?: string } | undefined;
          if (!user?.id) throw new MediaServiceError('forbidden', 403, 'Authentication required.');
          return { ...scope, ownerId: user.id };
        },
      }),
    );
  }, 60000);
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
    await rm(directory, { recursive: true, force: true });
  });
  beforeEach(() => {
    revoked = false;
    jest.clearAllMocks();
  });
  const url = () => `/api/media/assets/${asset.file_id}/content`;

  it('streams immutable original bytes with session cookies after Studio is disabled', async () => {
    const getContent = jest.spyOn(repository, 'getMediaAssetContent');
    const response = await request(app).get(url()).set('Cookie', cookie());
    expect(getContent).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(original);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
  it('serves a stored thumbnail through the same ownership check', async () => {
    expect(asset.renditions?.thumbnail).toBeDefined();
    const response = await request(app).get(`${url()}?rendition=thumbnail`).set('Cookie', cookie());
    expect(response.status).toBe(200);
    expect(response.body.length).toBe(asset.renditions?.thumbnail?.bytes);
    expect((await sharp(response.body).metadata()).width).toBe(16);
  });
  it('downloads SVG originals with an encoded filename and keeps raster previews inline', async () => {
    const svg = await storage.publish({
      scope,
      outputKey: 'svg-stream',
      type: 'image/svg+xml',
      filename: '日本語.svg',
      stream: Readable.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>',
      ),
      config: resolveMediaConfig(),
    });
    const response = await request(app)
      .get(`/api/media/assets/${svg.file_id}/content`)
      .set('Cookie', cookie());
    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toContain('attachment; filename="');
    expect(response.headers['content-disposition']).toContain(
      `filename*=UTF-8''${encodeURIComponent('日本語.svg')}`,
    );
    const thumbnail = await request(app)
      .get(`/api/media/assets/${svg.file_id}/content?rendition=thumbnail`)
      .set('Cookie', cookie());
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers['content-type']).toContain('image/png');
    expect(thumbnail.headers['content-disposition']).toMatch(/^inline;/);
  });
  it.each(['bytes=2-8', 'bytes=2-', 'bytes=-5'])(
    'supports browser seeking with %s',
    async (range) => {
      const response = await request(app).get(url()).set('Cookie', cookie()).set('Range', range);
      const start = range === 'bytes=-5' ? original.length - 5 : 2;
      const end = range === 'bytes=2-8' ? 8 : original.length - 1;
      expect(response.status).toBe(206);
      expect(response.headers['content-range']).toBe(`bytes ${start}-${end}/${original.length}`);
      expect(response.body).toEqual(original.subarray(start, end + 1));
    },
  );
  it.each(['bytes=999999-', 'bytes=5-2', 'bytes=-0', 'bytes=0-1,3-4', 'invalid'])(
    'rejects invalid ranges with the resource length: %s',
    async (range) => {
      const response = await request(app).get(url()).set('Cookie', cookie()).set('Range', range);
      expect(response.status).toBe(416);
      expect(response.headers['content-range']).toBe(`bytes */${original.length}`);
    },
  );
  it('answers HEAD without opening or reading the object', async () => {
    const openContent = jest.spyOn(storage, 'open');
    const response = await request(app).head(url()).set('Cookie', cookie());
    expect(response.status).toBe(200);
    expect(response.headers['content-length']).toBe(String(original.length));
    expect(openContent).not.toHaveBeenCalled();
  });
  it('rejects anonymous, revoked and other-owner requests and unavailable renditions', async () => {
    expect((await request(app).get(url())).status).toBe(403);
    expect(
      (
        await request(app)
          .get(url())
          .set('Cookie', cookie(new mongoose.Types.ObjectId().toString()))
      ).status,
    ).toBe(404);
    expect(
      (await request(app).get(`${url()}?rendition=poster`).set('Cookie', cookie())).status,
    ).toBe(404);
    expect(
      (await request(app).get(`${url()}?rendition=../../secret`).set('Cookie', cookie())).status,
    ).toBe(422);
    revoked = true;
    expect((await request(app).get(url()).set('Cookie', cookie())).status).toBe(403);
  });
  it('does not expose cookie-authenticated mutations', async () => {
    expect((await request(app).post(url()).set('Cookie', cookie())).status).toBe(404);
  });

  it('returns a recoverable storage error without stale content headers', async () => {
    jest
      .spyOn(storage, 'open')
      .mockRejectedValueOnce(new MediaServiceError('storage_failed', 503, 'Storage unavailable.'));
    const failed = await request(app).get(url()).set('Cookie', cookie()).set('Range', 'bytes=2-8');
    expect(failed.status).toBe(503);
    expect(failed.body).toEqual({ error: { code: 'storage_failed' } });
    expect(failed.headers['content-range']).toBeUndefined();
    expect(failed.headers['content-disposition']).toBeUndefined();
    expect(failed.headers['cache-control']).toBe('private, no-store');
    expect((await request(app).get(url()).set('Cookie', cookie())).body).toEqual(original);
  });

  it('aborts storage reads when the browser disconnects', async () => {
    const body = new Readable({
      read() {
        this.push(Buffer.from([0]));
        this._read = () => undefined;
      },
    });
    const closed = new Promise<void>((resolve) => body.once('close', resolve));
    let signal: AbortSignal | undefined;
    jest.spyOn(storage, 'open').mockImplementationOnce(async (_scope, _content, options) => {
      signal = options?.signal;
      return body;
    });
    const server = app.listen(0);
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture listener.');
      const response = await fetch(`http://127.0.0.1:${address.port}${url()}`, {
        headers: { Cookie: cookie() },
      });
      const reader = response.body!.getReader();
      await reader.read();
      await reader.cancel();
      await closed;
      expect(signal?.aborted).toBe(true);
      expect(body.destroyed).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      body.destroy();
    }
  });
});
