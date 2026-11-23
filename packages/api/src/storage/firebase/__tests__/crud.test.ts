import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ServerRequest } from '~/types';

const mockStorage = { name: 'storage' };

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

jest.mock('~/cdn/firebase', () => ({
  getFirebaseStorage: jest.fn(() => mockStorage),
}));

jest.mock('firebase/storage', () => ({
  ref: jest.fn((_storage: unknown, objectPath: string) => ({ objectPath })),
  uploadBytes: jest.fn(),
  getDownloadURL: jest.fn(
    async ({ objectPath }: { objectPath: string }) =>
      `https://firebasestorage.googleapis.com/${objectPath}`,
  ),
}));

import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { uploadFileToFirebase } from '../crud';

const req = { user: { id: 'user-1' } } as unknown as ServerRequest;

describe('uploadFileToFirebase', () => {
  let dir: string;
  let file: Express.Multer.File;

  beforeEach(async () => {
    jest.clearAllMocks();
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'firebase-crud-'));
    const filePath = path.join(dir, 'report.pdf');
    await fs.promises.writeFile(filePath, 'pdf bytes');
    file = { path: filePath, originalname: 'report.pdf' } as Express.Multer.File;
  });

  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it('stores the object under the basePath the caller passes', async () => {
    const result = await uploadFileToFirebase({
      req,
      file,
      file_id: 'file-1',
      basePath: 'uploads',
    });

    expect(ref).toHaveBeenCalledWith(mockStorage, 'uploads/user-1/file-1__report.pdf');
    expect(result).toEqual({
      filepath: 'https://firebasestorage.googleapis.com/uploads/user-1/file-1__report.pdf',
      bytes: Buffer.byteLength('pdf bytes'),
    });
  });

  it('falls back to images when no basePath is passed', async () => {
    await uploadFileToFirebase({ req, file, file_id: 'file-1' });

    expect(ref).toHaveBeenCalledWith(mockStorage, 'images/user-1/file-1__report.pdf');
  });

  it('removes the temp file and rethrows when the upload fails', async () => {
    const error = new Error('upload failed');
    (uploadBytes as jest.Mock).mockRejectedValueOnce(error);

    await expect(
      uploadFileToFirebase({ req, file, file_id: 'file-1', basePath: 'uploads' }),
    ).rejects.toBe(error);
    await expect(fs.promises.access(file.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails instead of returning an empty filepath when no download URL comes back', async () => {
    (getDownloadURL as jest.Mock).mockRejectedValueOnce(new Error('url lookup failed'));

    await expect(
      uploadFileToFirebase({ req, file, file_id: 'file-1', basePath: 'uploads' }),
    ).rejects.toThrow('Firebase returned no download URL');
    await expect(fs.promises.access(file.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
