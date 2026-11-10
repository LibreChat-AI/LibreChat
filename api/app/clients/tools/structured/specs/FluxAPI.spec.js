jest.mock('axios');
jest.mock('node-fetch');
jest.mock('sharp');
jest.mock('uuid', () => ({ v4: jest.fn(() => 'flux-image-id') }));
jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), error: jest.fn() },
}));

const axios = require('axios');
const sharp = require('sharp');
const { fluxImageIdsSchema } = require('@librechat/api');
const FluxAPI = require('../FluxAPI');

describe('FluxAPI with Microsoft Foundry', () => {
  const originalEnv = { ...process.env };
  let processFileURL;
  let uploadImageBuffer;
  let flux;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      FLUX_API_PROVIDER: 'azure-foundry',
      FLUX_API_BASE_URL: 'https://resource.services.ai.azure.com',
      FLUX_API_MODEL_PATH: 'flux-2-pro',
      FLUX_API_MODEL: 'FLUX.2-pro',
      FLUX_API_VERSION: 'preview',
    };
    processFileURL = jest.fn().mockResolvedValue({ filepath: '/images/generated.png' });
    uploadImageBuffer = jest.fn().mockResolvedValue({ filepath: '/images/generated.png' });
    flux = new FluxAPI({
      FLUX_API_KEY: 'foundry-key',
      req: { user: { id: 'user-id' }, config: {} },
      processFileURL,
      uploadImageBuffer,
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('uses the Foundry provider endpoint and persists a returned image URL', async () => {
    axios.post.mockResolvedValue({
      data: { data: [{ url: 'https://example.com/generated.png' }] },
    });

    const result = await flux._call({
      prompt: 'A red fox in an autumn forest',
      width: 1024,
      height: 1024,
    });

    expect(axios.post).toHaveBeenCalledWith(
      'https://resource.services.ai.azure.com/providers/blackforestlabs/v1/flux-2-pro?api-version=preview',
      {
        model: 'FLUX.2-pro',
        prompt: 'A red fox in an autumn forest',
        num_images: 1,
        output_format: 'png',
        safety_tolerance: 6,
        width: 1024,
        height: 1024,
      },
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer foundry-key',
          'api-key': 'foundry-key',
          'Content-Type': 'application/json',
        }),
      }),
    );
    expect(processFileURL).toHaveBeenCalledWith(
      expect.objectContaining({
        URL: 'https://example.com/generated.png',
        context: 'image_generation',
      }),
    );
    expect(result).toContain('![generated image](http://localhost:3080/images/generated.png)');
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('uses the Foundry OpenAI Images API contract when explicitly configured', async () => {
    process.env.FLUX_API_PROVIDER = 'azure-foundry-images';
    process.env.FLUX_API_BASE_URL = 'https://resource.services.ai.azure.com';
    process.env.FLUX_API_MODEL = 'flux-kontext-pro-deployment';
    flux = new FluxAPI({
      FLUX_API_KEY: 'foundry-key',
      processFileURL,
    });
    axios.post.mockResolvedValue({
      data: { data: [{ url: 'https://example.com/generated.png' }] },
    });

    const result = await flux._call({ prompt: 'A red fox in an autumn forest' });

    expect(axios.post).toHaveBeenCalledWith(
      'https://resource.services.ai.azure.com/openai/v1/images/generations?api-version=preview',
      {
        model: 'flux-kontext-pro-deployment',
        prompt: 'A red fox in an autumn forest',
        n: 1,
        size: '1024x1024',
      },
      expect.objectContaining({
        headers: expect.objectContaining({
          'api-key': 'foundry-key',
          'Content-Type': 'application/json',
        }),
      }),
    );
    expect(flux.schema.properties.width).toBeUndefined();
    expect(result).toContain('![generated image](http://localhost:3080/images/generated.png)');
  });

  it('rejects a Microsoft Foundry endpoint when the provider is left at its BFL default', () => {
    delete process.env.FLUX_API_PROVIDER;
    process.env.FLUX_API_BASE_URL = 'https://resource.services.ai.azure.com';

    expect(() => new FluxAPI({ FLUX_API_KEY: 'foundry-key' })).toThrow(
      'FLUX_API_BASE_URL points to a Microsoft Foundry endpoint',
    );
  });

  it('rejects the BFL endpoint when a Foundry provider is configured', () => {
    process.env.FLUX_API_PROVIDER = 'azure-foundry';
    process.env.FLUX_API_BASE_URL = 'https://api.us1.bfl.ai';

    expect(() => new FluxAPI({ FLUX_API_KEY: 'foundry-key' })).toThrow(
      'points to the BFL endpoint',
    );
  });

  it('rejects a Foundry provider configured without a base URL', () => {
    process.env.FLUX_API_PROVIDER = 'azure-foundry-images';
    delete process.env.FLUX_API_BASE_URL;

    expect(() => new FluxAPI({ FLUX_API_KEY: 'foundry-key' })).toThrow(
      'requires FLUX_API_BASE_URL',
    );
  });

  it('returns a base64 image as an Agent image artifact', async () => {
    const imageBuffer = Buffer.from('generated-image');
    axios.post.mockResolvedValue({
      data: {
        data: [{ b64_json: imageBuffer.toString('base64'), mime_type: 'image/jpeg' }],
      },
    });
    flux.isAgent = true;

    const [messages, artifact] = await flux._call({ prompt: 'A mountain lake' });

    expect(messages[0].text).toContain('Flux displayed an image.');
    expect(artifact.content[0].image_url.url).toBe(
      `data:image/jpeg;base64,${imageBuffer.toString('base64')}`,
    );
    expect(processFileURL).not.toHaveBeenCalled();
    expect(uploadImageBuffer).not.toHaveBeenCalled();
  });

  it('persists a base64 image result through the existing image upload helper', async () => {
    const imageBuffer = Buffer.from('generated-image');
    axios.post.mockResolvedValue({
      data: { data: [{ b64_json: imageBuffer.toString('base64') }] },
    });
    sharp.mockReturnValue({
      metadata: jest.fn().mockResolvedValue({ width: 640, height: 480 }),
    });

    const result = await flux._call({ prompt: 'A forest at dawn' });

    expect(flux.req).toBeUndefined();
    expect(uploadImageBuffer).toHaveBeenCalledWith(
      expect.objectContaining({
        req: flux.imageUploadRequest,
        context: 'image_generation',
        resize: false,
        metadata: expect.objectContaining({
          buffer: imageBuffer,
          width: 640,
          height: 480,
          bytes: imageBuffer.length,
          filename: expect.stringMatching(/^img-.*\.png$/),
          type: 'image/png',
          file_id: expect.any(String),
        }),
      }),
    );
    expect(result).toContain('![generated image](http://localhost:3080/images/generated.png)');
  });

  it('exposes only supported Foundry actions and inputs', () => {
    expect(flux.schema.properties.action.enum).toEqual(['generate', 'image_edit']);
    expect(Object.keys(flux.schema.properties).sort()).toEqual([
      'action',
      'height',
      'image_ids',
      'prompt',
      'safety_tolerance',
      'seed',
      'width',
    ]);
    expect(flux.schema.properties.image_ids).toEqual(fluxImageIdsSchema);
    expect(flux.supportsEditing).toBe(true);
  });

  it('reports the provider route as edit-capable only where it is', () => {
    delete process.env.FLUX_API_PROVIDER;
    delete process.env.FLUX_API_BASE_URL;
    const bflFlux = new FluxAPI({ FLUX_API_KEY: 'bfl-key' });
    expect(bflFlux.supportsEditing).toBe(false);
  });
});

describe('FluxAPI image editing (Microsoft Foundry)', () => {
  const { Readable } = require('stream');
  const getFiles = jest.fn();
  const getStrategyFunctions = jest.fn();

  const foundryEnv = {
    FLUX_API_PROVIDER: 'azure-foundry',
    FLUX_API_BASE_URL: 'https://resource.services.ai.azure.com',
    FLUX_API_MODEL_PATH: 'flux-2-pro',
    FLUX_API_MODEL: 'FLUX.2-pro',
    FLUX_API_VERSION: 'preview',
    FLUX_API_KEY: 'foundry-key',
  };
  let savedEnv;

  beforeEach(() => {
    jest.clearAllMocks();
    savedEnv = { ...process.env };
    Object.assign(process.env, foundryEnv);
    getFiles.mockReset().mockResolvedValue([]);
    getStrategyFunctions.mockReset().mockReturnValue({
      getDownloadStream: jest.fn().mockResolvedValue(Readable.from([Buffer.from('image-bytes')])),
    });
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it('edits an attached image through the Foundry provider route', async () => {
    const flux = new FluxAPI({
      FLUX_API_KEY: 'foundry-key',
      isAgent: true,
      imageFiles: [
        { file_id: 'file-1', filepath: '/images/input.png', source: 'local', type: 'image/png' },
      ],
      getFiles,
      getStrategyFunctions,
    });
    axios.post.mockResolvedValue({
      data: {
        data: [
          { b64_json: Buffer.from('edited-image').toString('base64'), mime_type: 'image/png' },
        ],
      },
    });

    const result = await flux._call({
      action: 'image_edit',
      prompt: 'Add sunglasses to the cat',
      image_ids: ['file-1'],
    });

    expect(axios.post).toHaveBeenCalledWith(
      'https://resource.services.ai.azure.com/providers/blackforestlabs/v1/flux-2-pro?api-version=preview',
      expect.objectContaining({
        model: 'FLUX.2-pro',
        prompt: 'Add sunglasses to the cat',
        input_image: Buffer.from('image-bytes').toString('base64'),
      }),
      expect.anything(),
    );
    expect(result[0][0].text).toContain('generated_image_id: "flux-image-id"');
    expect(result[0][0].text).toContain('referenced_image_ids: ["file-1"]');
    expect(result[1].file_ids).toEqual(['flux-image-id']);
  });

  it('sends multiple attached images as ordered reference inputs', async () => {
    getStrategyFunctions.mockReturnValue({
      getDownloadStream: jest
        .fn()
        .mockImplementation(async (_retention, filepath) =>
          Readable.from([Buffer.from(`bytes:${filepath}`)]),
        ),
    });
    const flux = new FluxAPI({
      FLUX_API_KEY: 'foundry-key',
      isAgent: true,
      imageFiles: [
        { file_id: 'file-1', filepath: '/images/a.png', source: 'local', type: 'image/png' },
        { file_id: 'file-2', filepath: '/images/b.png', source: 'local', type: 'image/png' },
      ],
      getFiles,
      getStrategyFunctions,
    });
    axios.post.mockResolvedValue({ data: { data: [{ b64_json: 'abc' }] } });

    await flux._call({
      action: 'image_edit',
      prompt: 'Blend the two rooms',
      image_ids: ['file-2', 'file-1'],
    });

    const first = Buffer.from('bytes:/images/b.png').toString('base64');
    const second = Buffer.from('bytes:/images/a.png').toString('base64');
    expect(axios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ input_image: first, input_image_2: second }),
      expect.anything(),
    );
  });

  it('falls back to the user files for reference IDs not attached to the message', async () => {
    getFiles.mockResolvedValue([
      { file_id: 'stored-1', filepath: '/images/stored.png', source: 'local', type: 'image/png' },
    ]);
    const flux = new FluxAPI({
      FLUX_API_KEY: 'foundry-key',
      isAgent: true,
      userId: 'user-1',
      getFiles,
      getStrategyFunctions,
    });
    axios.post.mockResolvedValue({ data: { data: [{ b64_json: 'abc' }] } });

    await flux._call({ action: 'image_edit', prompt: 'Edit it', image_ids: ['stored-1'] });

    expect(getFiles).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'user-1', file_id: { $in: ['stored-1'] } }),
      {},
      {},
    );
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  it('tells the agent to attach a reference image when none was passed', async () => {
    const flux = new FluxAPI({ FLUX_API_KEY: 'foundry-key', isAgent: true });

    const result = await flux._call({ action: 'image_edit', prompt: 'Edit it' });

    expect(result[0]).toContain('No reference images were provided');
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('offers recent generated images when no reference ID was passed', async () => {
    getFiles.mockResolvedValue([
      { file_id: 'recent-1', filepath: '/images/a.png', source: 'local', type: 'image/png' },
      { file_id: 'recent-2', filepath: '/images/b.png', source: 'local', type: 'image/png' },
    ]);
    const flux = new FluxAPI({
      FLUX_API_KEY: 'foundry-key',
      isAgent: true,
      userId: 'user-1',
      getFiles,
    });

    const result = await flux._call({ action: 'image_edit', prompt: 'Edit it' });

    expect(result[0]).toContain('most recently generated images');
    expect(result[0]).toContain('"recent-1"');
    expect(result[0]).toContain('"recent-2"');
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('reports reference images that could not be resolved', async () => {
    const flux = new FluxAPI({
      FLUX_API_KEY: 'foundry-key',
      isAgent: true,
      userId: 'user-1',
      getFiles,
      getStrategyFunctions,
    });

    const result = await flux._call({
      action: 'image_edit',
      prompt: 'Edit it',
      image_ids: ['gone'],
    });

    expect(result[0]).toContain('could not be found');
    expect(result[0]).toContain('gone');
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('offers recent generated images when a reference ID cannot be resolved', async () => {
    getFiles.mockResolvedValue([
      { file_id: 'recent-1', filepath: '/images/a.png', source: 'local', type: 'image/png' },
    ]);
    const flux = new FluxAPI({
      FLUX_API_KEY: 'foundry-key',
      isAgent: true,
      userId: 'user-1',
      getFiles,
      getStrategyFunctions,
    });

    const result = await flux._call({
      action: 'image_edit',
      prompt: 'Edit it',
      image_ids: ['gone'],
    });

    expect(result[0]).toContain('could not be found');
    expect(result[0]).toContain('"recent-1"');
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('reports a storage download failure as a tool message', async () => {
    getStrategyFunctions.mockReturnValue({
      getDownloadStream: jest.fn().mockRejectedValue(new Error('storage unreachable')),
    });
    const flux = new FluxAPI({
      FLUX_API_KEY: 'foundry-key',
      isAgent: true,
      imageFiles: [
        { file_id: 'file-1', filepath: '/images/input.png', source: 'local', type: 'image/png' },
      ],
      getFiles,
      getStrategyFunctions,
    });

    const result = await flux._call({
      action: 'image_edit',
      prompt: 'Edit it',
      image_ids: ['file-1'],
    });

    expect(result[0]).toContain('Something went wrong when trying to edit the image');
    expect(result[0]).toContain('storage unreachable');
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('rejects more reference images than FLUX.2 supports', async () => {
    const flux = new FluxAPI({ FLUX_API_KEY: 'foundry-key', isAgent: true });

    const result = await flux._call({
      action: 'image_edit',
      prompt: 'Edit it',
      image_ids: Array.from({ length: 9 }, (_, i) => `file-${i}`),
    });

    expect(result[0]).toContain('at most 8 reference images');
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('rejects image_edit outside the provider route', async () => {
    process.env.FLUX_API_PROVIDER = 'bfl';
    delete process.env.FLUX_API_BASE_URL;
    const flux = new FluxAPI({ FLUX_API_KEY: 'bfl-key' });

    await expect(
      flux._call({ action: 'image_edit', prompt: 'Edit it', image_ids: ['x'] }),
    ).rejects.toThrow('image_edit action is only available');
  });
});
