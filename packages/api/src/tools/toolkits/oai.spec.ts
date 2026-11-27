import { oaiToolkit, IMAGE_SIZE_PATTERN } from './oai';

const sizeSchemas = [
  ['image_gen_oai', oaiToolkit.image_gen_oai.schema.properties?.size],
  ['image_edit_oai', oaiToolkit.image_edit_oai.schema.properties?.size],
] as const;

describe('OpenAI image toolkit size schema', () => {
  const pattern = new RegExp(IMAGE_SIZE_PATTERN);

  it.each(sizeSchemas)('%s accepts any WIDTHxHEIGHT instead of a fixed list', (_name, size) => {
    expect(size?.enum).toBeUndefined();
    expect(size?.pattern).toBe(IMAGE_SIZE_PATTERN);
  });

  it.each([
    'auto',
    '8x8',
    '100000x100000',
    '1024x1024',
    '1536x1024',
    '256x256',
    '2048x1152',
    '3840x2160',
    '2160x3840',
  ])('accepts %s', (value) => {
    expect(pattern.test(value)).toBe(true);
  });

  it.each(['', '4K', '3840', '3840X2160', '3840 x 2160', '0x1024', '1024x0', 'auto1024x1024'])(
    'rejects %s',
    (value) => {
      expect(pattern.test(value)).toBe(false);
    },
  );
});

describe('OpenAI image toolkit quality schema', () => {
  const standardQuality = ['auto', 'high', 'medium', 'low'];
  const extendedQuality = [...standardQuality, 'xhigh', 'max'];
  const originalModel = process.env.IMAGE_GEN_OAI_MODEL;

  afterEach(() => {
    if (originalModel === undefined) {
      delete process.env.IMAGE_GEN_OAI_MODEL;
    } else {
      process.env.IMAGE_GEN_OAI_MODEL = originalModel;
    }
  });

  it.each([
    [undefined, extendedQuality],
    ['', extendedQuality],
    ['gpt-image-2.5-flare', extendedQuality],
    ['gpt-image-2.5-flare-2026-09-08', extendedQuality],
    ['gpt-image-2.5-sunburst', extendedQuality],
    ['gpt-image-2.5-sunburst-2026-09-08', extendedQuality],
    ['gpt-image-2.6-sunburst', extendedQuality],
    ['gpt-image-2.6-flare', extendedQuality],
    ['gpt-image-1', standardQuality],
    ['gpt-image-1-mini', standardQuality],
    ['gpt-image-1.5', standardQuality],
    ['gpt-image-2', standardQuality],
    ['gpt-image-2-2026-04-21', standardQuality],
    ['gpt-image-2.5-flare-custom', standardQuality],
    ['custom-image-deployment', standardQuality],
    [' ', standardQuality],
  ])('exposes only the configured quality levels for %j', (model, qualities) => {
    if (model === undefined) {
      delete process.env.IMAGE_GEN_OAI_MODEL;
    } else {
      process.env.IMAGE_GEN_OAI_MODEL = model;
    }

    jest.isolateModules(() => {
      const { oaiToolkit: toolkit } = jest.requireActual<typeof import('./oai')>('./oai');
      for (const tool of [toolkit.image_gen_oai, toolkit.image_edit_oai]) {
        expect(tool.schema.properties?.quality?.enum).toEqual(qualities);
        expect(tool.schema.properties?.quality?.description).not.toContain('only supported');
        expect(tool.schema.properties?.size?.pattern).toBe(IMAGE_SIZE_PATTERN);
        expect(tool.schema.properties?.complexity).toBeUndefined();
        expect(tool.schema.properties?.output_format).toBeUndefined();
      }
    });
  });
});
