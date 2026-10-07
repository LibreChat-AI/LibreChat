import { oaiToolkit, IMAGE_SIZE_PATTERN, getImageGenClientOptions } from './oai';
import { getDirectDispatcher, getProxyDispatcher } from '~/utils/proxy';

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

describe('getImageGenClientOptions', () => {
  const originalEnv = process.env;
  const transport = { headersTimeout: 1800000, bodyTimeout: 1800000 };

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns no options when nothing is configured', () => {
    process.env = {};
    expect(getImageGenClientOptions()).toEqual({});
  });

  it('sets the timeout and retries, with matching undici timeouts on the dispatcher', () => {
    process.env = { IMAGE_GEN_OAI_TIMEOUT_MS: '1800000', IMAGE_GEN_OAI_MAX_RETRIES: '0' };
    const options = getImageGenClientOptions();
    expect(options).toMatchObject({ timeout: 1800000, maxRetries: 0 });
    expect(options.fetchOptions?.dispatcher).toBe(getDirectDispatcher(transport));
  });

  it('routes through the proxy dispatcher when a proxy is configured', () => {
    process.env = { PROXY: 'http://proxy.test:8080' };
    expect(getImageGenClientOptions().fetchOptions?.dispatcher).toBe(getProxyDispatcher());

    process.env.IMAGE_GEN_OAI_TIMEOUT_MS = '1800000';
    expect(getImageGenClientOptions().fetchOptions?.dispatcher).toBe(
      getProxyDispatcher(undefined, transport),
    );
  });

  it.each([
    ['IMAGE_GEN_OAI_TIMEOUT_MS', ''],
    ['IMAGE_GEN_OAI_TIMEOUT_MS', '0'],
    ['IMAGE_GEN_OAI_TIMEOUT_MS', '-1'],
    ['IMAGE_GEN_OAI_TIMEOUT_MS', '1.5'],
    ['IMAGE_GEN_OAI_TIMEOUT_MS', '10s'],
    ['IMAGE_GEN_OAI_MAX_RETRIES', ''],
    ['IMAGE_GEN_OAI_MAX_RETRIES', '-1'],
    ['IMAGE_GEN_OAI_MAX_RETRIES', 'two'],
  ])('ignores %s=%j', (key, value) => {
    process.env = { [key]: value };
    expect(getImageGenClientOptions()).toEqual({});
  });
});
