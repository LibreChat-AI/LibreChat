import express from 'express';
import request from 'supertest';
import { Readable } from 'stream';
import { tenantStorage } from '@librechat/data-schemas';
import type { StoredFileSource, StoredFileViewer, StoredObject } from '../handler';
import type { ViewerAuthResult } from '~/images/authorization';
import { getStoredFileURL, STORED_FILES_ROUTE } from '../link';
import { createStoredFileHandler } from '../handler';

jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  tenantStorage: { run: jest.fn((_context: unknown, fn: () => unknown) => fn()) },
}));

const owner = 'a1b2c3d4e5f6a1b2c3d4e5f6';
const viewer = 'ffffffffffffffffffffffff';
const key = `images/${owner}/file-1__photo.png`;

/** A storage source whose keys are `[t/<tenant>/]<basePath>/<userId>/<fileName>`, avatars under `avatars/`. */
function createSource(): StoredFileSource & {
  read: jest.Mock<Promise<StoredObject>, [string, { head: boolean; signal: AbortSignal }]>;
} {
  return {
    parseKey: (value) => {
      const parts = value.split('/');
      const tenantId = parts[0] === 't' ? parts[1] : undefined;
      const [basePath, userId, ...rest] = tenantId ? parts.slice(2) : parts;
      return basePath && userId && rest.length
        ? { userId, fileName: rest.join('/'), tenantId, avatar: basePath === 'avatars' }
        : null;
    },
    read: jest.fn(async (_key: string, { head }: { head: boolean; signal: AbortSignal }) => ({
      contentLength: 5,
      body: head ? undefined : Readable.from([Buffer.from('image')]),
    })),
    isNotFound: (error) => (error as { name?: string })?.name === 'NotFound',
  };
}

describe('createStoredFileHandler', () => {
  let auth: ViewerAuthResult;
  let source: ReturnType<typeof createSource>;
  let canViewFile: jest.Mock<
    Promise<boolean>,
    [StoredFileViewer, { source: string; key: string; ownerId: string }]
  >;

  const app = () => {
    const server = express();
    server.use(
      STORED_FILES_ROUTE,
      createStoredFileHandler({
        authenticate: async () => auth,
        sources: { s3: source },
        canViewFile,
      }),
    );
    return server;
  };
  const link = (value = key, from = 's3') => getStoredFileURL(from, value);

  beforeEach(() => {
    jest.clearAllMocks();
    auth = { status: 'authenticated', userId: owner };
    source = createSource();
    canViewFile = jest.fn(
      async (_viewer: StoredFileViewer, _file: { source: string; key: string; ownerId: string }) =>
        false,
    );
  });

  it('serves an image inline to its owner', async () => {
    const res = await request(app()).get(link());
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('image');
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toBe('inline');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('private, max-age=3600');
    expect(source.read).toHaveBeenCalledWith(key, expect.objectContaining({ head: false }));
  });

  it('answers HEAD with the size and no body', async () => {
    const res = await request(app()).head(link());
    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe('5');
    expect(source.read).toHaveBeenCalledWith(key, expect.objectContaining({ head: true }));
  });

  it('sends documents as attachments', async () => {
    const res = await request(app()).get(link(`uploads/${owner}/file-2__notes.html`));
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toBe('attachment; filename="file-2__notes.html"');
  });

  it('refuses requests without a valid session', async () => {
    auth = { status: 'missing' };
    expect((await request(app()).get(link())).status).toBe(401);
    auth = { status: 'invalid' };
    expect((await request(app()).get(link())).status).toBe(403);
    expect(source.read).not.toHaveBeenCalled();
  });

  it("hides other users' files unless the file's own access rules admit the viewer", async () => {
    auth = { status: 'authenticated', userId: viewer, role: 'USER' };
    expect((await request(app()).get(link())).status).toBe(404);
    expect(source.read).not.toHaveBeenCalled();
    expect(canViewFile).toHaveBeenCalledWith(
      { userId: viewer, role: 'USER', tenantId: undefined },
      { source: 's3', key, ownerId: owner },
    );

    canViewFile.mockResolvedValueOnce(true);
    expect((await request(app()).get(link())).status).toBe(200);
  });

  it('shows avatars to any signed-in user without a file lookup', async () => {
    auth = { status: 'authenticated', userId: viewer };
    expect((await request(app()).get(link(`avatars/${owner}/avatar-1.png`))).status).toBe(200);
    expect(canViewFile).not.toHaveBeenCalled();
  });

  it("keeps other tenants' files and avatars out of reach", async () => {
    canViewFile.mockResolvedValue(true);
    const avatar = link(`t/tenant-a/avatars/${owner}/avatar-1.png`);
    const image = link(`t/tenant-a/images/${owner}/file-1__a.png`);

    auth = { status: 'authenticated', userId: viewer, tenantId: 'tenant-b' };
    expect((await request(app()).get(avatar)).status).toBe(404);
    expect((await request(app()).get(image)).status).toBe(404);
    expect(canViewFile).not.toHaveBeenCalled();

    auth = { status: 'authenticated', userId: viewer, tenantId: 'tenant-a' };
    expect((await request(app()).get(avatar)).status).toBe(200);
    expect((await request(app()).get(image)).status).toBe(200);
    expect(tenantStorage.run).toHaveBeenCalledWith(
      { tenantId: 'tenant-a', userId: viewer },
      expect.any(Function),
    );
  });

  it('serves only configured sources and keys that name an owner', async () => {
    expect((await request(app()).get(link(key, 'azure_blob'))).status).toBe(404);
    expect((await request(app()).get(`${STORED_FILES_ROUTE}/s3/${owner}`)).status).toBe(404);
    expect((await request(app()).get(`${STORED_FILES_ROUTE}/s3`)).status).toBe(404);
    expect(source.read).not.toHaveBeenCalled();
  });

  it('maps a missing object to 404 and other failures to a bare 500', async () => {
    source.read.mockRejectedValueOnce(Object.assign(new Error('gone'), { name: 'NotFound' }));
    expect((await request(app()).get(link())).status).toBe(404);

    source.read.mockRejectedValueOnce(new Error('secret detail'));
    const res = await request(app()).get(link());
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('secret');
  });

  it('allows only reads', async () => {
    expect((await request(app()).delete(link())).status).toBe(405);
  });
});
