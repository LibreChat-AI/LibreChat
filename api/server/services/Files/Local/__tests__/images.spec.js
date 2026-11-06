jest.mock('~/models', () => ({
  updateUser: jest.fn(),
  updateFile: jest.fn(async (doc) => doc),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { updateFile } = require('~/models');
const { prepareImagesLocal, uploadLocalImage } = require('../images');

describe('prepareImagesLocal', () => {
  let tmpDir;
  let publicPath;
  let imageOutput;

  beforeEach(() => {
    jest.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-images-local-'));
    publicPath = path.join(tmpDir, 'public');
    imageOutput = path.join(tmpDir, 'images');
    fs.mkdirSync(path.join(publicPath, 'images', 'user-1'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const makeReq = () => ({
    user: { id: 'user-1' },
    config: { paths: { publicPath, imageOutput } },
  });

  it('strips a cache-busting query string before encoding from disk', async () => {
    const relativePath = '/images/user-1/chart.png';
    fs.writeFileSync(path.join(publicPath, relativePath), Buffer.from('fake-png-bytes'));

    const [updated, encoded] = await prepareImagesLocal(makeReq(), {
      file_id: 'file-1',
      filepath: `${relativePath}?v=1789460622697`,
    });

    expect(updateFile).toHaveBeenCalledWith({ file_id: 'file-1' });
    expect(updated).toEqual({ file_id: 'file-1' });
    expect(encoded).toBe(Buffer.from('fake-png-bytes').toString('base64'));
  });

  it('encodes a filepath without a query string', async () => {
    const relativePath = '/images/user-1/chart.png';
    fs.writeFileSync(path.join(publicPath, relativePath), Buffer.from('plain-png-bytes'));

    const [, encoded] = await prepareImagesLocal(makeReq(), {
      file_id: 'file-2',
      filepath: relativePath,
    });

    expect(encoded).toBe(Buffer.from('plain-png-bytes').toString('base64'));
  });
});

describe('uploadLocalImage', () => {
  let tmpDir;
  let imageOutput;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-local-image-'));
    imageOutput = path.join(tmpDir, 'images');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each(['jpeg', 'png'])(
    'stores %s bytes named .png in the configured PNG format',
    async (format) => {
      const inputFilePath = path.join(tmpDir, 'photo.png');
      await sharp({ create: { width: 8, height: 8, channels: 3, background: '#d22' } })
        .toFormat(format)
        .toFile(inputFilePath);

      const result = await uploadLocalImage({
        req: { user: { id: 'user-1' }, config: { paths: { imageOutput }, imageOutputType: 'png' } },
        file: { path: inputFilePath },
        file_id: 'file-1',
        endpoint: 'anthropic',
      });
      const stored = await fs.promises.readFile(
        path.join(imageOutput, 'user-1', 'file-1__photo.png'),
      );

      expect((await sharp(stored).metadata()).format).toBe('png');
      expect(result).toEqual({
        filepath: '/images/user-1/file-1__photo.png',
        bytes: stored.length,
        width: 8,
        height: 8,
      });
      expect(fs.existsSync(inputFilePath)).toBe(false);
    },
  );
});
