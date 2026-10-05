import fs from 'node:fs';
import multer from 'multer';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { resolveMediaConfig } from 'librechat-data-provider';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import type { WriteStream } from 'node:fs';
import { createMediaStaging } from './staging';

describe('media upload staging', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'librechat-staging-'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('settles an interrupted multipart upload once, closes its file and removes partial bytes', async () => {
    const writes: WriteStream[] = [];
    let resolveWritten: () => void;
    const written = new Promise<void>((resolve) => {
      resolveWritten = resolve;
    });
    let resolveSettled: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    let resolveStored: () => void;
    const stored = new Promise<void>((resolve) => {
      resolveStored = resolve;
    });
    const createWriteStream = fs.createWriteStream;
    jest.spyOn(fs, 'createWriteStream').mockImplementation((...args) => {
      const stream = createWriteStream(...args);
      const writtenCallback =
        (callback: (error?: Error | null) => void) => (error?: Error | null) => {
          callback(error);
          if (!error && stream.bytesWritten === 65_536) resolveWritten();
        };
      const write = stream._write;
      stream._write = (chunk, encoding, callback) =>
        write.call(stream, chunk, encoding, writtenCallback(callback));
      const writev = stream._writev;
      if (writev)
        stream._writev = (chunks, callback) =>
          writev.call(stream, chunks, writtenCallback(callback));
      writes.push(stream);
      return stream;
    });
    const storage = createMediaStaging({ directory, id: () => 'interrupted' }).storage(
      resolveMediaConfig(),
    );
    let callbacks = 0;
    let failed = false;
    const app = express();
    app.use((req, _res, next) => {
      req.user = { id: 'owner' } as Express.User;
      next();
    });
    app.post('/', (req, res) =>
      multer({
        storage: {
          ...storage,
          _handleFile(incoming, file, callback) {
            storage._handleFile(incoming, file, (error, info) => {
              callbacks++;
              callback(error, info);
              resolveStored();
            });
          },
        },
      }).single('file')(req, res, (error) => {
        failed = !!error;
        if (!res.destroyed) res.sendStatus(error ? 400 : 204);
        resolveSettled();
      }),
    );
    const server = createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address');
    const client = httpRequest({
      host: '127.0.0.1',
      port: address.port,
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=staging-test' },
    });
    client.on('error', () => undefined);
    try {
      client.write(
        '--staging-test\r\nContent-Disposition: form-data; name="file"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n',
      );
      client.write(Buffer.alloc(65_536));
      await written;
      expect((await stat(path.join(directory, 'owner', 'media', 'interrupted'))).size).toBe(65_536);
      client.destroy();
      await Promise.all([settled, stored]);
      expect(failed).toBe(true);
      expect(await readdir(path.join(directory, 'owner', 'media'))).toEqual([]);
      expect(writes).toHaveLength(1);
      expect(writes[0].closed).toBe(true);
      expect(writes[0].destroyed).toBe(true);
      expect(callbacks).toBe(1);
    } finally {
      client.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('keeps completed files until removal and discards oversized uploads', async () => {
    let id = 0;
    const storage = createMediaStaging({ directory, id: () => `upload-${++id}` }).storage(
      resolveMediaConfig({ transfers: { maxImageBytes: 1024 } }),
    );
    const app = express();
    app.use((req, _res, next) => {
      req.user = { id: 'owner' } as Express.User;
      next();
    });
    app.post('/', (req, res) =>
      multer({ storage }).single('file')(req, res, (error) => {
        if (error) {
          res.sendStatus(413);
          return;
        }
        res.json({ size: req.file?.size });
      }),
    );
    await request(app)
      .post('/')
      .attach('file', Buffer.alloc(64), 'image.png')
      .expect(200, { size: 64 });
    await request(app).post('/').attach('file', Buffer.alloc(2048), 'image.png').expect(413);
    expect(await readdir(path.join(directory, 'owner', 'media'))).toEqual(['upload-1']);
  });

  it('does not delete an existing file when exclusive creation fails', async () => {
    await fs.promises.mkdir(path.join(directory, 'owner', 'media'), { recursive: true });
    await writeFile(path.join(directory, 'owner', 'media', 'existing'), 'preserved');
    const storage = createMediaStaging({ directory, id: () => 'existing' }).storage(
      resolveMediaConfig(),
    );
    const app = express();
    app.use((req, _res, next) => {
      req.user = { id: 'owner' } as Express.User;
      next();
    });
    app.post('/', (req, res) =>
      multer({ storage }).single('file')(req, res, (error) => {
        res.sendStatus(error ? 409 : 204);
      }),
    );
    await request(app).post('/').attach('file', Buffer.alloc(64), 'image.png').expect(409);
    expect(
      await fs.promises.readFile(path.join(directory, 'owner', 'media', 'existing'), 'utf8'),
    ).toBe('preserved');
  });
  it('sweeps only stale media staging inside owner temp folders', async () => {
    const staging = createMediaStaging({ directory, id: () => 'unused' });
    const owner = path.join(directory, 'owner');
    const media = path.join(owner, 'media');
    await fs.promises.mkdir(media, { recursive: true });
    await writeFile(path.join(owner, 'ordinary-upload'), 'keep');
    await writeFile(path.join(media, 'old-upload'), 'remove');
    await writeFile(path.join(media, 'fresh-upload'), 'keep');
    const cutoff = Date.now() - 1000;
    await fs.promises.utimes(path.join(media, 'old-upload'), new Date(0), new Date(0));
    expect(await staging.sweep(cutoff)).toBe(1);
    expect(await readdir(owner)).toEqual(expect.arrayContaining(['ordinary-upload', 'media']));
    expect(await readdir(media)).toEqual(['fresh-upload']);
  });
});
