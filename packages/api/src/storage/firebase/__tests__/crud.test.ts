import fs from 'fs';
import os from 'os';
import path from 'path';
import type { FirebaseStorage } from 'firebase/storage';
import type { ServerRequest } from '~/types';

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

jest.mock('firebase/storage', () => ({
  ref: jest.fn((_storage: unknown, objectPath: string) => ({ objectPath })),
  uploadBytes: jest.fn(),
  deleteObject: jest.fn(),
  getDownloadURL: jest.fn(
    async ({ objectPath }: { objectPath: string }) =>
      `https://firebasestorage.googleapis.com/${objectPath}`,
  ),
}));

import { logger } from '@librechat/data-schemas';
import { ref, uploadBytes, deleteObject, getDownloadURL } from 'firebase/storage';
import { createFirebaseUploads } from '../crud';

const storage = { app: { name: 'test' } } as unknown as FirebaseStorage;
const req = { user: { id: 'user-1' } } as unknown as ServerRequest;
const { uploadFileToFirebase } = createFirebaseUploads({ getStorage: () => storage });

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

    expect(ref).toHaveBeenCalledWith(storage, 'uploads/user-1/file-1__report.pdf');
    expect(result).toEqual({
      filepath: 'https://firebasestorage.googleapis.com/uploads/user-1/file-1__report.pdf',
      bytes: Buffer.byteLength('pdf bytes'),
    });
  });

  it('falls back to images when no basePath is passed', async () => {
    await uploadFileToFirebase({ req, file, file_id: 'file-1' });

    expect(ref).toHaveBeenCalledWith(storage, 'images/user-1/file-1__report.pdf');
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
    expect(deleteObject).toHaveBeenCalledWith({
      objectPath: 'uploads/user-1/file-1__report.pdf',
    });
    await expect(fs.promises.access(file.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('still surfaces the missing URL when deleting the stored object fails', async () => {
    (getDownloadURL as jest.Mock).mockRejectedValueOnce(new Error('url lookup failed'));
    (deleteObject as jest.Mock).mockRejectedValueOnce(new Error('delete denied'));

    await expect(
      uploadFileToFirebase({ req, file, file_id: 'file-1', basePath: 'uploads' }),
    ).rejects.toThrow('Firebase returned no download URL');
    expect(logger.warn).toHaveBeenCalledWith(
      '[deleteFirebaseObject] Could not delete the unreferenced Firebase object',
      expect.any(Object),
    );
    expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).not.toContain('delete denied');
  });

  it('rejects without touching Firebase when storage is not configured', async () => {
    const uploads = createFirebaseUploads({ getStorage: () => null });

    await expect(
      uploads.uploadFileToFirebase({ req, file, file_id: 'file-1', basePath: 'uploads' }),
    ).rejects.toThrow('Firebase is not initialized');
    expect(uploadBytes).not.toHaveBeenCalled();
  });

  it('does not delete anything when the upload itself fails', async () => {
    (uploadBytes as jest.Mock).mockRejectedValueOnce(new Error('upload failed'));

    await expect(uploadFileToFirebase({ req, file, file_id: 'file-1' })).rejects.toThrow(
      'upload failed',
    );
    expect(deleteObject).not.toHaveBeenCalled();
  });
});

describe('deleteFirebaseObject', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes the object at basePath/userId/fileName', async () => {
    const { deleteFirebaseObject } = createFirebaseUploads({ getStorage: () => storage });

    await deleteFirebaseObject({ userId: 'user-1', fileName: 'a.png', basePath: 'images' });

    expect(ref).toHaveBeenCalledWith(storage, 'images/user-1/a.png');
    expect(deleteObject).toHaveBeenCalledWith({ objectPath: 'images/user-1/a.png' });
  });

  it('does nothing when Firebase is not configured', async () => {
    const { deleteFirebaseObject } = createFirebaseUploads({ getStorage: () => null });

    await deleteFirebaseObject({ userId: 'user-1', fileName: 'a.png' });

    expect(deleteObject).not.toHaveBeenCalled();
  });
});
