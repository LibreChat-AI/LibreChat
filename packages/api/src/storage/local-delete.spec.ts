import fs from 'fs';
import os from 'os';
import path from 'path';
import { createLocalFileDeleter, saveLocalBuffer } from './local';

describe('local file deletion', () => {
  let root: string;
  let req: { user: { id: string }; config: { paths: { publicPath: string; uploads: string } } };
  const deleteRagFile = jest.fn().mockResolvedValue(undefined);
  const logger = { warn: jest.fn(), error: jest.fn() };
  const remove = createLocalFileDeleter({ deleteRagFile, logger });

  beforeEach(() => {
    jest.clearAllMocks();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-delete-'));
    req = {
      user: { id: 'user-1' },
      config: {
        paths: { publicPath: path.join(root, 'public'), uploads: path.join(root, 'uploads') },
      },
    };
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const uploadedFile = (name: string, owner = 'user-1') => {
    const dir = path.join(root, 'uploads', owner);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), 'contents');
    return { file_id: 'file-1', filepath: `/uploads/${owner}/${name}`, user: owner };
  };

  it('removes uploaded bytes and RAG data', async () => {
    const file = uploadedFile('knowledge.txt');
    await remove(req, file);
    expect(fs.existsSync(path.join(root, 'uploads', 'user-1', 'knowledge.txt'))).toBe(false);
    expect(deleteRagFile).toHaveBeenCalledWith({ userId: 'user-1', file });
  });

  it.each(['a#b.txt', 'what?.txt', '100%.txt', 'a%41.txt', 'my report.txt', '会社.txt'])(
    'removes the bytes saved as %s through the filepath returned at save time',
    async (name) => {
      const filepath = await saveLocalBuffer({
        paths: req.config.paths,
        userId: 'user-1',
        buffer: Buffer.from('contents'),
        fileName: name,
        basePath: 'uploads',
      });
      expect(fs.existsSync(path.join(root, 'uploads', 'user-1', name))).toBe(true);

      await remove(req, { file_id: 'file-1', filepath: `${filepath}?v=1789460622697` });

      expect(fs.existsSync(path.join(root, 'uploads', 'user-1', name))).toBe(false);
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );

  it('removes a nested file recorded with an encoded segment', async () => {
    const directory = path.join(root, 'uploads', 'user-1', 'dir');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'a#b.txt'), 'contents');

    await remove(req, { file_id: 'file-1', filepath: '/uploads/user-1/dir/a%23b.txt' });

    expect(fs.readdirSync(directory)).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('removes the public file behind an encoded images filepath', async () => {
    const filepath = await saveLocalBuffer({
      paths: req.config.paths,
      userId: 'user-1',
      buffer: Buffer.from('png'),
      fileName: 'chart #1.png',
    });
    const stored = path.join(root, 'public', 'images', 'user-1', 'chart #1.png');
    expect(fs.existsSync(stored)).toBe(true);

    await remove(req, { file_id: 'file-1', filepath });

    expect(fs.existsSync(stored)).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('removes a legacy record by its raw name and leaves the decoded lookalike alone', async () => {
    const escapedSpace = uploadedFile('a%20b.txt');
    const escapedLetter = uploadedFile('a%41.txt');
    const malformed = uploadedFile('50%.txt');
    uploadedFile('a b.txt');
    uploadedFile('aA.txt');

    await remove(req, escapedSpace);
    await remove(req, escapedLetter);
    await remove(req, malformed);

    const directory = path.join(root, 'uploads', 'user-1');
    expect(fs.readdirSync(directory).sort()).toEqual(['a b.txt', 'aA.txt']);
  });

  it('removes a legacy record named with a literal escape of a reserved character', async () => {
    const literal = uploadedFile('a%23.txt');

    await remove(req, literal);

    expect(fs.readdirSync(path.join(root, 'uploads', 'user-1'))).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each(['/uploads/user-1/..%2Fuser-2%2Fsecret.txt', '/uploads/user-1/../user-2/secret.txt'])(
    'does not follow %s into another owner directory',
    async (filepath) => {
      uploadedFile('secret.txt', 'user-2');

      await expect(remove(req, { file_id: 'file-1', filepath, user: 'user-1' })).rejects.toThrow(
        'Invalid file path',
      );

      expect(deleteRagFile).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(root, 'uploads', 'user-2', 'secret.txt'))).toBe(true);
    },
  );

  it('preserves bytes when vector cleanup returns false', async () => {
    const file = uploadedFile('retained.txt');
    deleteRagFile.mockResolvedValueOnce(false);
    await expect(remove(req, file)).rejects.toThrow('Vector deletion was not confirmed');
    expect(fs.existsSync(path.join(root, 'uploads', 'user-1', 'retained.txt'))).toBe(true);
  });

  it('accepts missing storage but rejects other unlink failures', async () => {
    const file = { file_id: 'file-1', filepath: '/uploads/user-1/missing.txt', user: 'user-1' };
    await expect(remove(req, file)).resolves.toBeUndefined();

    const directory = path.join(root, 'uploads', 'user-1', 'not-a-file');
    fs.mkdirSync(directory, { recursive: true });
    const existing = { file_id: 'file-2', filepath: '/uploads/user-1/not-a-file', user: 'user-1' };
    await expect(remove(req, existing)).rejects.toThrow();
    expect(fs.existsSync(directory)).toBe(true);
  });

  it('keeps deletion scoped to the request owner, not descriptor metadata', async () => {
    const file = uploadedFile('managed.txt', 'user-2');
    await expect(remove(req, file)).rejects.toThrow('Invalid file path');
    expect(deleteRagFile).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, 'uploads', 'user-2', 'managed.txt'))).toBe(true);

    req.user.id = 'user-2';
    await remove(req, file);
    expect(deleteRagFile).toHaveBeenCalledWith({ userId: 'user-2', file });

    const other = uploadedFile('protected.txt', 'user-2');
    req.user.id = 'user-3';
    deleteRagFile.mockClear();
    await expect(remove(req, other)).rejects.toThrow('Invalid file path');
    expect(deleteRagFile).not.toHaveBeenCalled();
  });

  it('cleans up RAG data for a legacy agent record without a disk path', async () => {
    const file = { file_id: 'file-1', filepath: 'agents', user: 'user-2' };
    await remove(req, file);
    expect(deleteRagFile).toHaveBeenCalledWith({ userId: 'user-1', file });
  });

  it('rejects an empty request owner before touching storage or RAG data', async () => {
    const file = uploadedFile('retained.txt');
    req.user.id = '';
    await expect(remove(req, file)).rejects.toThrow('Invalid file owner');
    expect(deleteRagFile).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, 'uploads', 'user-1', 'retained.txt'))).toBe(true);
  });
});
