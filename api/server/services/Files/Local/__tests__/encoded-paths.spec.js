/**
 * Wiring coverage: the encode and decode rules live in `packages/api/src/storage/path.ts` and are
 * covered in `path.test.ts`. These tests assert that the local producers record an encoded URL for
 * a name a URL cannot carry and that `getLocalFileStream` reads it back, including records written
 * before names were encoded.
 */
jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn() },
}));

const mockTmpBase = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'local-encoded-paths-'),
);

jest.mock('~/config/paths', () => {
  const path = require('path');
  return {
    publicPath: path.join(mockTmpBase, 'public'),
    uploads: path.join(mockTmpBase, 'uploads'),
    imageOutput: path.join(mockTmpBase, 'public', 'images'),
  };
});

const fs = require('fs');
const path = require('path');
const {
  saveLocalBuffer,
  getLocalFileURL,
  uploadLocalFile,
  getLocalFileStream,
} = require('../crud');

const uploads = path.join(mockTmpBase, 'uploads');
const imageOutput = path.join(mockTmpBase, 'public', 'images');

const makeReq = () => ({
  user: { id: 'user-1' },
  config: { paths: { publicPath: path.join(mockTmpBase, 'public'), uploads, imageOutput } },
});

const readStream = (stream) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });

describe('local storage filepaths for names that change under encoding', () => {
  afterAll(() => {
    fs.rmSync(mockTmpBase, { recursive: true, force: true });
  });

  it.each([
    ['uploads', 'q#1?x 100%.txt'],
    ['images', 'q#1?x 100%.png'],
    ['images', '会社 1.png'],
  ])('streams back what saveLocalBuffer stored under %s as %s', async (basePath, fileName) => {
    const url = await saveLocalBuffer({
      userId: 'user-1',
      buffer: Buffer.from(`bytes of ${fileName}`),
      fileName,
      basePath,
    });

    const stream = await getLocalFileStream(makeReq(), `${url}?v=1789460622697`);

    const parsed = new URL(url, 'http://localhost');
    expect([parsed.search, parsed.hash]).toEqual(['', '']);
    await expect(readStream(stream)).resolves.toBe(`bytes of ${fileName}`);
  });

  it('rejects a nested name instead of writing below the owner directory', async () => {
    await expect(
      saveLocalBuffer({
        userId: 'user-1',
        buffer: Buffer.from('nested'),
        fileName: 'nested/q#1.png',
        basePath: 'images',
      }),
    ).rejects.toThrow('Nested path detected in filename');
  });

  it('streams a legacy record by its raw name, never a decoded lookalike', async () => {
    fs.mkdirSync(path.join(uploads, 'user-1'), { recursive: true });
    fs.writeFileSync(path.join(uploads, 'user-1', 'a%41.txt'), 'literal escape');
    fs.writeFileSync(path.join(uploads, 'user-1', 'aA.txt'), 'lookalike');
    fs.writeFileSync(path.join(uploads, 'user-1', 'a%20b.txt'), 'literal space escape');
    fs.writeFileSync(path.join(uploads, 'user-1', 'a b.txt'), 'spaced lookalike');
    fs.writeFileSync(path.join(uploads, 'user-1', '50%.txt'), 'malformed escape');
    fs.writeFileSync(path.join(uploads, 'user-1', 'a%23.txt'), 'literal reserved escape');

    const literal = await getLocalFileStream(makeReq(), '/uploads/user-1/a%41.txt');
    const space = await getLocalFileStream(makeReq(), '/uploads/user-1/a%20b.txt');
    const malformed = await getLocalFileStream(makeReq(), '/uploads/user-1/50%.txt');
    const reserved = await getLocalFileStream(makeReq(), '/uploads/user-1/a%23.txt');

    await expect(readStream(literal)).resolves.toBe('literal escape');
    await expect(readStream(space)).resolves.toBe('literal space escape');
    await expect(readStream(malformed)).resolves.toBe('malformed escape');
    await expect(readStream(reserved)).resolves.toBe('literal reserved escape');
  });

  it('does not decode an encoded traversal into another directory', async () => {
    fs.mkdirSync(path.join(uploads, 'user-2'), { recursive: true });
    fs.writeFileSync(path.join(uploads, 'user-2', 'secret.txt'), 'secret');

    const stream = await getLocalFileStream(makeReq(), '/uploads/user-1/..%2Fuser-2%2Fsecret.txt');

    await expect(readStream(stream)).rejects.toThrow('ENOENT');
  });

  it('builds the URL of a name with a separator and reserved characters', async () => {
    await expect(getLocalFileURL({ fileName: 'user-1/q#1?.png' })).resolves.toBe(
      '/images/user-1/q%231%3F.png',
    );
    await expect(
      getLocalFileURL({ fileName: 'user-1/a b.pdf', basePath: 'uploads' }),
    ).resolves.toBe('/uploads/user-1/a b.pdf');
  });

  it('records an upload under an encoded filepath that streams back', async () => {
    const tempDir = path.join(mockTmpBase, 'temp');
    fs.mkdirSync(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, 'report #1.csv');
    fs.writeFileSync(tempPath, 'a,b');

    const { filepath, bytes } = await uploadLocalFile({
      req: makeReq(),
      file: { path: tempPath, mimetype: 'text/csv' },
      file_id: 'file-1',
    });

    expect(filepath).toBe('/uploads/user-1/file-1__report%20%231.csv');
    expect(bytes).toBe(3);
    await expect(readStream(await getLocalFileStream(makeReq(), filepath))).resolves.toBe('a,b');
  });
});
