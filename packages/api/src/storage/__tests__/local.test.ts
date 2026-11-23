import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import {
  moveLocalFile,
  writeLocalFile,
  saveLocalBuffer,
  resolveLocalFile,
  writeFileAtomic,
} from '../local';

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

  it('returns a URL that addresses the stored file when the name has reserved characters', async () => {
    const paths = { publicPath: path.join(dir, 'public'), uploads: path.join(dir, 'uploads') };
    const fileName = 'q#1 100%25?x=1.png';

    const url = await saveLocalBuffer({
      paths,
      userId: 'user1',
      buffer: Buffer.from('png'),
      fileName,
    });

    expect(url).toBe('/images/user1/q%231%20100%2525%3Fx%3D1.png');
    const parsed = new URL(url, 'http://localhost');
    expect(parsed.pathname).toBe(url);
    expect(parsed.search).toBe('');
    expect(parsed.hash).toBe('');
    const stored = path.join(paths.publicPath, 'images', 'user1', fileName);
    expect(decodeURIComponent(parsed.pathname.slice('/images/user1/'.length))).toBe(fileName);
    expect(await fs.readFile(stored, 'utf8')).toBe('png');
  });

  it('rejects a nested name before creating any directory', async () => {
    const paths = { publicPath: path.join(dir, 'public'), uploads: path.join(dir, 'uploads') };

    await expect(
      saveLocalBuffer({
        paths,
        userId: 'user1',
        buffer: Buffer.from('nested'),
        fileName: 'nested dir/avatar#1.png',
        basePath: 'uploads',
      }),
    ).rejects.toThrow('Nested path detected in filename');
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('rejects a nested name in the write and move helpers and keeps the source', async () => {
    const source = path.join(dir, 'upload.tmp');
    await fs.writeFile(source, 'moved');
    const target = path.join(dir, 'target');

    await expect(writeLocalFile(target, 'a/b/avatar.png', 'written')).rejects.toThrow(
      'Nested path detected in filename',
    );
    await expect(moveLocalFile(source, target, 'a/b/avatar.png')).rejects.toThrow(
      'Nested path detected in filename',
    );

    expect(await fs.readdir(dir)).toEqual(['upload.tmp']);
    expect(await fs.readFile(source, 'utf8')).toBe('moved');
  });

  it('still accepts a name that normalizes to a file directly inside the directory', async () => {
    const written = await writeLocalFile(path.join(dir, 'out'), 'a/../avatar.png', 'flat');

    expect(await fs.readFile(path.join(dir, 'out', 'avatar.png'), 'utf8')).toBe('flat');
    expect(written).toBe(path.join(dir, 'out', 'avatar.png'));
  });

  it('records a name without reserved characters exactly as it is', async () => {
    const paths = { publicPath: path.join(dir, 'public'), uploads: path.join(dir, 'uploads') };

    const url = await saveLocalBuffer({
      paths,
      userId: 'user1',
      buffer: Buffer.from('png'),
      fileName: '会社 1.png',
    });

    expect(url).toBe('/images/user1/会社 1.png');
    expect(
      await fs.readFile(path.join(paths.publicPath, 'images', 'user1', '会社 1.png'), 'utf8'),
    ).toBe('png');
  });

  it('rejects a name that cannot be encoded before creating any directory', async () => {
    const paths = { publicPath: path.join(dir, 'public'), uploads: path.join(dir, 'uploads') };

    await expect(
      saveLocalBuffer({
        paths,
        userId: 'user1',
        buffer: Buffer.from('x'),
        fileName: 'broken#\uD800.png',
      }),
    ).rejects.toThrow(URIError);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('rejects a traversing file name without creating any directory', async () => {
    const paths = { publicPath: path.join(dir, 'public'), uploads: path.join(dir, 'uploads') };

    await expect(
      saveLocalBuffer({ paths, userId: 'user1', buffer: Buffer.from('x'), fileName: '../x' }),
    ).rejects.toThrow('Path traversal detected in filename');
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('leaves one whole file when two uploads move to one path at once', async () => {
    const large = path.join(dir, 'large.tmp');
    const small = path.join(dir, 'small.tmp');
    const largeData = Buffer.alloc(4 * 1024 * 1024, 'a');
    const smallData = Buffer.alloc(1024, 'b');
    await fs.writeFile(large, largeData);
    await fs.writeFile(small, smallData);

    const out = path.join(dir, 'out');
    await Promise.all([
      moveLocalFile(large, out, 'image.png'),
      moveLocalFile(small, out, 'image.png'),
    ]);

    const written = await fs.readFile(path.join(out, 'image.png'));
    expect(written.equals(largeData) || written.equals(smallData)).toBe(true);
    expect(await fs.readdir(out)).toEqual(['image.png']);
  });

  it('rejects a traversing name in the write and move helpers', async () => {
    const source = path.join(dir, 'upload.tmp');
    await fs.writeFile(source, 'content');
    const target = path.join(dir, 'target');

    await expect(writeLocalFile(target, '../escaped', 'x')).rejects.toThrow(
      'Path traversal detected in filename',
    );
    await expect(moveLocalFile(source, target, '../escaped')).rejects.toThrow(
      'Path traversal detected in filename',
    );
    expect(await fs.readdir(dir)).toEqual(['upload.tmp']);
  });

  it('writes and moves to a name near NAME_MAX', async () => {
    const longName = `${'n'.repeat(250)}.png`;
    const source = path.join(dir, 'upload.tmp');
    await fs.writeFile(source, 'moved');

    await writeLocalFile(path.join(dir, 'written'), longName, 'written');
    await moveLocalFile(source, path.join(dir, 'moved'), longName);

    expect(await fs.readFile(path.join(dir, 'written', longName), 'utf8')).toBe('written');
    expect(await fs.readFile(path.join(dir, 'moved', longName), 'utf8')).toBe('moved');
    expect(await fs.readdir(path.join(dir, 'moved'))).toEqual([longName]);
  });

  describe('resolveLocalFile', () => {
    beforeEach(() => fs.mkdir(path.join(dir, 'u'), { recursive: true }));

    it('resolves an encoded record to the decoded file', async () => {
      await fs.writeFile(path.join(dir, 'u', 'a#b.txt'), 'decoded');

      expect(await resolveLocalFile(dir, 'u/a%23b.txt')).toBe(path.join(dir, 'u', 'a#b.txt'));
    });

    it('resolves a legacy record to the file named by the text as recorded', async () => {
      await fs.writeFile(path.join(dir, 'u', 'a%23b.txt'), 'legacy');

      expect(await resolveLocalFile(dir, 'u/a%23b.txt')).toBe(path.join(dir, 'u', 'a%23b.txt'));
    });

    it('prefers the decoded file when both exist, and names it when neither does', async () => {
      await fs.writeFile(path.join(dir, 'u', 'a%23b.txt'), 'legacy');
      await fs.writeFile(path.join(dir, 'u', 'a#b.txt'), 'decoded');

      expect(await resolveLocalFile(dir, 'u/a%23b.txt')).toBe(path.join(dir, 'u', 'a#b.txt'));
      expect(await resolveLocalFile(dir, 'u/gone%23.txt')).toBe(path.join(dir, 'u', 'gone#.txt'));
    });

    it('leaves a plain path as it is and does not probe outside the root', async () => {
      expect(await resolveLocalFile(dir, 'u/plain.txt')).toBe(path.join(dir, 'u', 'plain.txt'));
      expect(await resolveLocalFile(dir, '../a%23.txt')).toBe(path.join(dir, '..', 'a#.txt'));
    });
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
