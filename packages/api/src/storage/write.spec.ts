import path from 'node:path';
import { tmpdir } from 'node:os';
import { ContainerClient } from '@azure/storage-blob';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import {
  createAzureStreamStorage,
  createBufferStreamStorage,
  createLocalStreamStorage,
} from './write';

let directory: string;
let source: string;
const bytes = Buffer.from('immutable input');
const params = { userId: 'owner', tenantId: 'tenant', fileName: 'chosen.png', basePath: 'images' };
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'stream-storage-'));
  source = path.join(directory, 'different-name.dat');
  await writeFile(source, bytes);
});
afterEach(async () => {
  jest.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

test('local plan and exclusive stream preserve filename, tenant and input bytes', async () => {
  const storage = createLocalStreamStorage({
    imageDirectory: path.join(directory, 'images'),
    uploadDirectory: path.join(directory, 'uploads'),
  });
  const planned = await storage.planFile(params);
  expect(planned.storageKey).toBe('images/t/tenant/owner/chosen.png');
  expect(await storage.saveStream({ ...params, path: source })).toMatchObject({
    ...planned,
    bytes: bytes.length,
  });
  expect(await readFile(path.join(directory, planned.storageKey))).toEqual(bytes);
  await expect(storage.saveStream({ ...params, path: source })).rejects.toThrow();
  expect(await readFile(source)).toEqual(bytes);
  await expect(storage.planFile({ ...params, tenantId: '../escape' })).rejects.toThrow();
});

test('buffer-backed strategy owns tenant placement and uses caller filename without upload prefixes', async () => {
  const saveBuffer = jest.fn(async () => 'https://storage/confirmed');
  const storage = createBufferStreamStorage({ saveBuffer });
  const planned = await storage.planFile(params);
  expect(planned.storageKey).toBe('t/tenant/images/owner/chosen.png');
  expect(await storage.saveStream({ ...params, path: source })).toMatchObject({
    storageKey: planned.storageKey,
    filepath: 'https://storage/confirmed',
    bytes: bytes.length,
  });
  expect(saveBuffer).toHaveBeenCalledWith(
    expect.objectContaining({
      userId: 'owner',
      basePath: 't/tenant/images',
      fileName: 'chosen.png',
      buffer: bytes,
    }),
  );
});

test('Azure plan and stream use the configured container and the same strategy-owned key', async () => {
  const container = new ContainerClient('https://account.blob.core.windows.net/files');
  const blob = container.getBlockBlobClient('t/tenant/images/owner/chosen.png');
  jest.spyOn(container, 'createIfNotExists').mockResolvedValue({
    succeeded: false,
  } as Awaited<ReturnType<typeof container.createIfNotExists>>);
  jest.spyOn(container, 'getBlockBlobClient').mockReturnValue(blob);
  const uploaded: Buffer[] = [];
  const upload = jest.spyOn(blob, 'uploadStream').mockImplementation(async (stream) => {
    for await (const chunk of stream) uploaded.push(Buffer.from(chunk));
    return {} as Awaited<ReturnType<typeof blob.uploadStream>>;
  });
  const storage = createAzureStreamStorage({
    getContainerClient: async () => container,
    getContentType: () => 'image/png',
    publicAccess: 'false',
  });
  const planned = await storage.planFile(params);
  expect(
    await storage.saveStream({ ...params, path: source, contentType: 'image/png' }),
  ).toMatchObject({ ...planned, bytes: bytes.length });
  expect(Buffer.concat(uploaded)).toEqual(bytes);
  expect(upload).toHaveBeenCalledWith(expect.anything(), undefined, undefined, {
    blobHTTPHeaders: { blobContentType: 'image/png' },
  });
});
