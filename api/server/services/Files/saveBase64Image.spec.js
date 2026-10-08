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
