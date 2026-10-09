/** Exactly what `deleteLocalFile` reaches for, so the double does not depend on a built package. */
jest.mock('@librechat/api', () => ({
  deleteRagFile: jest.fn().mockResolvedValue(undefined),
  stripCacheBust: (filepath) => String(filepath).split('?')[0],
}));
jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn() },
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { deleteLocalFile } = require('../crud');

/* The resolved promise of a delete is what `processDeleteRequest` reads to decide that a record may
   lose its metadata and its agent references, so this adapter may only resolve once the bytes are
   actually gone. Storage that was already missing is the one benign case. */
describe('deleteLocalFile failure reporting', () => {
  const userId = 'user-1';
  let tmpBase;
  let req;

  beforeEach(() => {
    jest.restoreAllMocks();
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'crud-delete-'));
    fs.mkdirSync(path.join(tmpBase, 'uploads', userId), { recursive: true });
    req = {
      user: { id: userId },
      config: {
        paths: {
          publicPath: path.join(tmpBase, 'public'),
          uploads: path.join(tmpBase, 'uploads'),
        },
      },
    };
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  const uploadedFile = (filename) => {
    const filepath = path.join(tmpBase, 'uploads', userId, filename);
    fs.writeFileSync(filepath, 'contents');
    return { file_id: 'file-1', filepath: `/uploads/${userId}/${filename}` };
  };

  it('removes the file and resolves', async () => {
    const file = uploadedFile('knowledge.txt');

    await expect(deleteLocalFile(req, file)).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(tmpBase, 'uploads', userId, 'knowledge.txt'))).toBe(false);
  });

  it('resolves when the file is already gone', async () => {
    await expect(
      deleteLocalFile(req, { file_id: 'file-1', filepath: `/uploads/${userId}/missing.txt` }),
    ).resolves.toBeUndefined();
  });

  it('rejects when the bytes survive the delete', async () => {
    const file = uploadedFile('locked.txt');
    jest
      .spyOn(fs.promises, 'unlink')
      .mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }));

    await expect(deleteLocalFile(req, file)).rejects.toThrow('permission denied');
    expect(fs.existsSync(path.join(tmpBase, 'uploads', userId, 'locked.txt'))).toBe(true);
  });

  it('deletes image files stored under /images/<userId>/ with POSIX path separators', async () => {
    const filename = 'avatar.png';
    const imageDir = path.join(tmpBase, 'public', 'images', userId);
    fs.mkdirSync(imageDir, { recursive: true });
    const absolutePath = path.join(imageDir, filename);
    fs.writeFileSync(absolutePath, 'img');

    // Stored paths always use forward slashes (path.posix.join). On Windows, splitting on
    // path.sep used to leave subfolder undefined and crash isValidPath (#16309).
    await expect(
      deleteLocalFile(req, { file_id: 'img-1', filepath: `/images/${userId}/${filename}` }),
    ).resolves.toBeUndefined();
    expect(fs.existsSync(absolutePath)).toBe(false);
  });
});
