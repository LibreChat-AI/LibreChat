/**
 * Wiring coverage: `stripCacheBust`'s own behavior is covered in
 * `packages/api/src/storage/__tests__/path.test.ts`. These tests assert that the local read paths
 * hand their raw filepath to it, so a reused code output resolves to the file that exists on disk.
 */
jest.mock('@librechat/api', () => ({
  deleteRagFile: jest.fn(),
  stripCacheBust: jest.fn((filepath) => filepath.split('?')[0]),
}));
jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn() },
}));

const mockTmpBase = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'local-cache-bust-'),
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
const { stripCacheBust } = require('@librechat/api');
const { getLocalFileStream } = require('../crud');

const imageOutput = path.join(mockTmpBase, 'public', 'images');
const uploads = path.join(mockTmpBase, 'uploads');

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

describe('getLocalFileStream cache-busted filepaths', () => {
  beforeAll(() => {
    fs.mkdirSync(path.join(imageOutput, 'user-1'), { recursive: true });
    fs.mkdirSync(path.join(uploads, 'user-1'), { recursive: true });
    fs.writeFileSync(path.join(imageOutput, 'user-1', 'chart.png'), 'image-bytes');
    fs.writeFileSync(path.join(uploads, 'user-1', 'doc.pdf'), 'upload-bytes');
  });

  afterAll(() => {
    fs.rmSync(mockTmpBase, { recursive: true, force: true });
  });

  it('streams a reused code-output image whose filepath carries `?v=`', async () => {
    const requested = '/images/user-1/chart.png?v=1789460622697';

    const stream = await getLocalFileStream(makeReq(), requested);

    await expect(readStream(stream)).resolves.toBe('image-bytes');
    expect(stripCacheBust).toHaveBeenCalledWith(requested);
  });

  it('streams an upload whose filepath carries a query string', async () => {
    const requested = '/uploads/user-1/doc.pdf?manual=true';

    const stream = await getLocalFileStream(makeReq(), requested);

    await expect(readStream(stream)).resolves.toBe('upload-bytes');
    expect(stripCacheBust).toHaveBeenCalledWith(requested);
  });

  it('still streams a filepath without a query string', async () => {
    const stream = await getLocalFileStream(makeReq(), '/images/user-1/chart.png');

    await expect(readStream(stream)).resolves.toBe('image-bytes');
  });

  it('still rejects traversal hidden behind a query string', async () => {
    await expect(getLocalFileStream(makeReq(), '/images/../../../etc/passwd?v=1')).rejects.toThrow(
      'Invalid file path',
    );
  });
});
