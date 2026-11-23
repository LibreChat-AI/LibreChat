const fs = require('fs');
const os = require('os');
const path = require('path');

const mockStorage = { name: 'storage' };
const mockRef = jest.fn((_storage, objectPath) => ({ objectPath }));
const mockUploadBytes = jest.fn();
const mockGetDownloadURL = jest.fn(
  async ({ objectPath }) => `https://firebasestorage.googleapis.com/${objectPath}`,
);

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), debug: jest.fn() },
}));

jest.mock('@librechat/api', () => ({
  getFirebaseStorage: jest.fn(() => mockStorage),
}));

jest.mock('firebase/storage', () => ({
  ref: (...args) => mockRef(...args),
  uploadBytes: (...args) => mockUploadBytes(...args),
  getDownloadURL: (...args) => mockGetDownloadURL(...args),
  deleteObject: jest.fn(),
}));

const { uploadFileToFirebase } = require('./crud');

describe('uploadFileToFirebase', () => {
  let dir;
  let file;
  const req = { user: { id: 'user-1' } };

  beforeEach(async () => {
    jest.clearAllMocks();
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'firebase-crud-'));
    const filePath = path.join(dir, 'report.pdf');
    await fs.promises.writeFile(filePath, 'pdf bytes');
    file = { path: filePath, originalname: 'report.pdf' };
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

    expect(mockRef).toHaveBeenCalledWith(mockStorage, 'uploads/user-1/file-1__report.pdf');
    expect(result).toEqual({
      filepath: 'https://firebasestorage.googleapis.com/uploads/user-1/file-1__report.pdf',
      bytes: Buffer.byteLength('pdf bytes'),
    });
  });

  it('falls back to images when no basePath is passed', async () => {
    await uploadFileToFirebase({ req, file, file_id: 'file-1' });

    expect(mockRef).toHaveBeenCalledWith(mockStorage, 'images/user-1/file-1__report.pdf');
  });

  it('removes the temp file and rethrows when the upload fails', async () => {
    const error = new Error('upload failed');
    mockUploadBytes.mockRejectedValueOnce(error);

    await expect(
      uploadFileToFirebase({ req, file, file_id: 'file-1', basePath: 'uploads' }),
    ).rejects.toBe(error);
    await expect(fs.promises.access(file.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
