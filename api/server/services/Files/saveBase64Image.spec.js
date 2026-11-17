const sharp = require('sharp');
const { resolveImageMimeType } = require('@librechat/api');

jest.mock('~/models', () => ({ createFile: jest.fn(async (doc) => doc) }));
jest.mock('~/server/utils/getFileStrategy', () => ({
  getFileStrategy: jest.fn(() => 'local'),
}));
jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(() => ({
    saveBuffer: jest.fn(async ({ fileName }) => `/images/user-1/${fileName}`),
  })),
}));
jest.mock('./retention', () => ({
  getRetentionExpiry: jest.fn(async () => ({})),
  getAgentFileRetentionExpiry: jest.fn(async () => ({})),
}));
jest.mock('./Audio/STTService', () => ({ STTService: class {} }));
jest.mock('~/server/controllers/assistants/v2', () => ({
  addResourceFileId: jest.fn(),
  deleteResourceFileId: jest.fn(),
}));
jest.mock('~/server/controllers/assistants/helpers', () => ({ getOpenAIClient: jest.fn() }));
jest.mock('~/server/services/Tools/credentials', () => ({ loadAuthValues: jest.fn() }));
jest.mock('~/server/services/Config', () => ({ checkCapability: jest.fn() }));
jest.mock('~/server/utils/queue', () => ({ LB_QueueAsyncCall: jest.fn() }));

const db = require('~/models');
const { saveBase64Image } = require('./process');

const req = {
  user: { id: 'user-1', tenantId: null },
  config: { fileConfig: { imageGeneration: 'high' }, paths: {} },
};

const dataUrl = (mimeType, buffer) => `data:${mimeType};base64,${buffer.toString('base64')}`;

const save = (url) =>
  saveBase64Image(url, {
    req,
    file_id: 'file-1',
    filename: 'tool_img_abc',
    endpoint: 'openAI',
    context: 'image_generation',
  });

describe('saveBase64Image records the media type of the bytes it saves', () => {
  it('records PNG for an SVG that sharp rasterizes', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40">' +
        '<rect width="80" height="40" fill="red"/></svg>',
    );

    const file = await save(dataUrl('image/svg+xml', svg));

    expect(file.type).toBe('image/png');
    expect(file.filename).toBe('file-1-tool_img_abc.png');
    expect(db.createFile).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'image/png' }),
      true,
    );
  });

  it('leaves a genuine PNG labeled as PNG', async () => {
    const png = await sharp({
      create: { width: 40, height: 20, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } },
    })
      .png()
      .toBuffer();

    const file = await save(dataUrl('image/png', png));

    expect(file.type).toBe('image/png');
    expect(file.filename).toBe('file-1-tool_img_abc.png');
  });

  it('corrects a WebP mislabeled by the producer as PNG', async () => {
    const webp = await sharp({
      create: { width: 40, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .webp()
      .toBuffer();

    const file = await save(dataUrl('image/png', webp));

    expect(file.type).toBe('image/webp');
    expect(file.filename).toBe('file-1-tool_img_abc.webp');
  });

  it('records a type that matches the bytes actually written to storage', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40">' +
        '<rect width="80" height="40" fill="blue"/></svg>',
    );

    const file = await save(dataUrl('image/svg+xml', svg));

    const { getStrategyFunctions } = require('~/server/services/Files/strategies');
    const { saveBuffer } = getStrategyFunctions.mock.results.at(-1).value;
    const savedBuffer = saveBuffer.mock.calls.at(-1)[0].buffer;

    expect(file.type).toBe(resolveImageMimeType(await sharp(savedBuffer).metadata()));
  });
});

describe('saveBase64Image with imageGeneration.keepOriginal', () => {
  const zlib = require('zlib');

  /** Inserts an ancillary chunk before IEND. C2PA signers store their manifest in `caBX`. */
  const withPngChunk = (png, chunkType, data) => {
    const iend = png.length - 12;
    const typeAndData = Buffer.concat([Buffer.from(chunkType, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(typeAndData));
    return Buffer.concat([png.subarray(0, iend), length, typeAndData, crc, png.subarray(iend)]);
  };

  const signedPng = async (width = 1024, height = 1024) => {
    const png = await sharp({
      create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();
    return withPngChunk(png, 'caBX', Buffer.from('c2pa manifest store'));
  };

  const saveWith = (imageGeneration, url) =>
    saveBase64Image(url, {
      req: { ...req, config: { fileConfig: { imageGeneration }, paths: {} } },
      file_id: 'file-1',
      filename: 'tool_img_abc',
      endpoint: 'openAI',
      context: 'image_generation',
    });

  const lastSavedBuffer = () => {
    const { getStrategyFunctions } = require('~/server/services/Files/strategies');
    const { saveBuffer } = getStrategyFunctions.mock.results.at(-1).value;
    return saveBuffer.mock.calls.at(-1)[0].buffer;
  };

  it('stores the bytes unchanged, so the C2PA manifest survives', async () => {
    const png = await signedPng();

    const file = await saveWith({ keepOriginal: true }, dataUrl('image/png', png));

    expect(lastSavedBuffer().equals(png)).toBe(true);
    expect(file).toMatchObject({ type: 'image/png', width: 1024, height: 1024 });
    expect(file.bytes).toBe(png.length);
    expect(file.filename).toBe('file-1-tool_img_abc.png');
  });

  it('takes precedence over percentage and px', async () => {
    const png = await signedPng();

    await saveWith({ keepOriginal: true, px: 256 }, dataUrl('image/png', png));

    expect(lastSavedBuffer().equals(png)).toBe(true);
  });

  it('without it, resizes and re-encodes, which drops the C2PA manifest', async () => {
    const png = await signedPng();

    const file = await saveWith(undefined, dataUrl('image/png', png));

    expect(lastSavedBuffer().includes(Buffer.from('caBX'))).toBe(false);
    expect(file).toMatchObject({ width: 768, height: 768 });
  });

  it('resizes like the default when set to false without percentage or px', async () => {
    const png = await signedPng();

    const file = await saveWith({ keepOriginal: false }, dataUrl('image/png', png));

    expect(file).toMatchObject({ type: 'image/png', width: 768, height: 768 });
  });

  it('records the type of the kept bytes, not the declared one', async () => {
    const webp = await sharp({
      create: { width: 1600, height: 1000, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .webp()
      .toBuffer();

    const file = await saveWith({ keepOriginal: true }, dataUrl('image/png', webp));

    expect(lastSavedBuffer().equals(webp)).toBe(true);
    expect(file.type).toBe('image/webp');
    expect(file.filename).toBe('file-1-tool_img_abc.webp');
  });

  it('still rasterizes an SVG', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40">' +
        '<rect width="80" height="40" fill="green"/></svg>',
    );

    const file = await saveWith({ keepOriginal: true }, dataUrl('image/svg+xml', svg));

    expect(file.type).toBe('image/png');
    expect(lastSavedBuffer().equals(svg)).toBe(false);
  });

  it('reports the displayed dimensions of a rotated JPEG', async () => {
    const jpeg = await sharp({
      create: { width: 60, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const file = await saveWith({ keepOriginal: true }, dataUrl('image/jpeg', jpeg));

    expect(lastSavedBuffer().equals(jpeg)).toBe(true);
    expect(file).toMatchObject({ type: 'image/jpeg', width: 20, height: 60 });
  });
});
