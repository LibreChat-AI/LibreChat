jest.mock('sharp', () => {
  const toBuffer = jest.fn(async () => Buffer.from('converted-bytes'));
  const sharpMock = jest.fn(() => ({ toFormat: jest.fn().mockReturnThis(), toBuffer }));
  return sharpMock;
});
jest.mock('@librechat/api', () => ({
  stripCacheBust: jest.fn((filepath) => filepath.split('?')[0]),
}));
jest.mock('../../images/resize', () => ({ resizeImageBuffer: jest.fn() }));
jest.mock('~/models', () => ({
  updateUser: jest.fn(),
  updateFile: jest.fn(async (doc) => doc),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { updateFile } = require('~/models');
const { resizeImageBuffer } = require('../../images/resize');
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
    jest.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-local-image-'));
    imageOutput = path.join(tmpDir, 'images');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const makeReq = (imageOutputType) => ({
    user: { id: 'user-1' },
    config: { paths: { imageOutput }, imageOutputType },
  });

  /** The caller records the upload as `image/${imageOutputType}`, so whatever this writes has to
   * be in that format — the type is handed to providers verbatim as `media_type`. */
  const upload = async (name, resized) => {
    const inputFilePath = path.join(tmpDir, name);
    fs.writeFileSync(inputFilePath, Buffer.from('uploaded-bytes'));
    resizeImageBuffer.mockResolvedValue({ width: 8, height: 8, ...resized });

    const { filepath } = await uploadLocalImage({
      req: makeReq('png'),
      file: { path: inputFilePath },
      file_id: 'file-1',
      endpoint: 'anthropic',
    });

    return fs.readFileSync(path.join(imageOutput, 'user-1', path.basename(filepath)));
  };

  it('converts a JPEG that was given a .png name', async () => {
    const written = await upload('fake.png', {
      buffer: Buffer.from('resized-jpeg-bytes'),
      type: 'image/jpeg',
    });

    expect(sharp).toHaveBeenCalledWith(Buffer.from('resized-jpeg-bytes'));
    expect(written).toEqual(Buffer.from('converted-bytes'));
  });

  it('writes the resized bytes untouched when the name and the bytes both match the target', async () => {
    const written = await upload('real.png', {
      buffer: Buffer.from('resized-png-bytes'),
      type: 'image/png',
    });

    expect(sharp).not.toHaveBeenCalled();
    expect(written).toEqual(Buffer.from('resized-png-bytes'));
  });

  it('converts when sharp named no format for the resized bytes', async () => {
    const written = await upload('unknown.png', {
      buffer: Buffer.from('resized-unknown-bytes'),
      type: undefined,
    });

    expect(sharp).toHaveBeenCalled();
    expect(written).toEqual(Buffer.from('converted-bytes'));
  });

  it('still converts a name that does not carry the target extension', async () => {
    const written = await upload('photo.jpg', {
      buffer: Buffer.from('resized-jpeg-bytes'),
      type: 'image/jpeg',
    });

    expect(sharp).toHaveBeenCalled();
    expect(written).toEqual(Buffer.from('converted-bytes'));
  });
});
