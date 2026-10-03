import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { moveLocalFile, saveLocalBuffer, writeFileAtomic } from '../local';

describe('local storage writes', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-storage-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('leaves one whole payload when writers of different sizes race on one path', async () => {
    const target = path.join(dir, 'avatar.png');
    const large = Buffer.alloc(4 * 1024 * 1024, 'a');
    const small = Buffer.alloc(1024, 'b');

    await Promise.all([writeFileAtomic(target, large), writeFileAtomic(target, small)]);

    const written = await fs.readFile(target);
    expect(written.equals(large) || written.equals(small)).toBe(true);
    expect(await fs.readdir(dir)).toEqual(['avatar.png']);
  });

  it('removes its temp file and rethrows when the rename fails', async () => {
    const target = path.join(dir, 'occupied');
    await fs.mkdir(path.join(target, 'child'), { recursive: true });

    await expect(writeFileAtomic(target, 'data')).rejects.toThrow();
    expect(await fs.readdir(dir)).toEqual(['occupied']);
  });

  it('saves a buffer under the user directory and returns its URL path', async () => {
    const paths = { publicPath: path.join(dir, 'public'), uploads: path.join(dir, 'uploads') };

    const images = await saveLocalBuffer({
      paths,
      userId: 'user1',
      buffer: Buffer.from('png'),
      fileName: 'a.png',
    });
    const uploads = await saveLocalBuffer({
      paths,
      userId: 'user1',
      buffer: Buffer.from('doc'),
      fileName: 'b.txt',
      basePath: 'uploads',
    });

    expect(images).toBe('/images/user1/a.png');
    expect(uploads).toBe('/uploads/user1/b.txt');
    expect(await fs.readFile(path.join(paths.publicPath, 'images', 'user1', 'a.png'), 'utf8')).toBe(
      'png',
    );
    expect(await fs.readFile(path.join(paths.uploads, 'user1', 'b.txt'), 'utf8')).toBe('doc');
  });

  it('rejects a traversing file name without creating any directory', async () => {
    const paths = { publicPath: path.join(dir, 'public'), uploads: path.join(dir, 'uploads') };

    await expect(
      saveLocalBuffer({ paths, userId: 'user1', buffer: Buffer.from('x'), fileName: '../x' }),
    ).rejects.toThrow('Path traversal detected in filename');
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('moves a temp upload into a new directory', async () => {
    const source = path.join(dir, 'upload.tmp');
    await fs.writeFile(source, 'content');

    const target = await moveLocalFile(source, path.join(dir, 'out', 'user1'), 'file.txt');

    expect(target).toBe(path.join(dir, 'out', 'user1', 'file.txt'));
    expect(await fs.readFile(target, 'utf8')).toBe('content');
    await expect(fs.access(source)).rejects.toThrow();
  });
});
