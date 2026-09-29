jest.mock('@librechat/api', () => ({ encodeAndFormatImages: jest.fn() }));
jest.mock('~/server/services/Files/strategies', () => ({ getStrategyFunctions: jest.fn() }));

const axios = require('axios');
const { Readable } = require('node:stream');
const { encodeAndFormatImages } = require('@librechat/api');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { encodeAndFormat } = require('./encode');

beforeEach(() => jest.resetAllMocks());

it('wires the existing callers to the typed image encoder without interpreting its result', () => {
  const req = { body: {}, config: {} };
  const files = [];
  const params = { endpoint: 'openai', imageDetail: 'high' };
  const result = Promise.resolve({ files: [], image_urls: [] });
  encodeAndFormatImages.mockReturnValue(result);

  expect(encodeAndFormat(req, files, params, 'agents')).toBe(result);
  expect(encodeAndFormatImages).toHaveBeenCalledWith(
    req,
    files,
    params,
    { getStrategyFunctions, httpClient: axios },
    'agents',
  );
});

it('encodes canonical storage keys through the built package and the existing CJS entry point', async () => {
  encodeAndFormatImages.mockImplementation(
    jest.requireActual('@librechat/api').encodeAndFormatImages,
  );
  const bytes = Buffer.from('stored-image-bytes');
  const getDownloadStream = jest.fn().mockResolvedValue(Readable.from(bytes));
  const prepareImagePayload = jest.fn();
  getStrategyFunctions.mockReturnValue({ getDownloadStream, prepareImagePayload });
  const req = { body: {}, config: {} };
  const file = {
    source: 's3',
    file_id: 'image-1',
    filename: 'image.png',
    filepath: 'https://storage.example/image.png?signature=secret',
    storageKey: 'images/user/image.png',
    type: 'image/png',
    bytes: bytes.length,
    height: 10,
    width: 10,
  };

  const result = await encodeAndFormat(req, [file], { endpoint: 'openai' });

  expect(getDownloadStream).toHaveBeenCalledWith(req, file.storageKey);
  expect(prepareImagePayload).not.toHaveBeenCalled();
  expect(result.image_urls).toEqual([
    {
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${bytes.toString('base64')}`, detail: 'auto' },
    },
  ]);
});
