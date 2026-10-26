import { oaiToolkit, IMAGE_SIZE_PATTERN, getImageGenClientOptions } from './oai';
import { getDirectDispatcher, getProxyDispatcher } from '~/utils/proxy';
import { DEFAULT_OUTBOUND_TIMEOUTS_MS } from '~/utils/timeouts';

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
  const transport = (ms: number) => ({ headersTimeout: ms, bodyTimeout: ms });
  const defaultMs = DEFAULT_OUTBOUND_TIMEOUTS_MS.imageGenMs;

  afterEach(() => {
    process.env = originalEnv;
  });

  it('defaults to the imageGenMs budget, with matching undici timeouts on the dispatcher', () => {
    process.env = {};
    const options = getImageGenClientOptions();
    expect(options.timeout).toBe(defaultMs);
    expect(options).not.toHaveProperty('maxRetries');
    expect(options.fetchOptions.dispatcher).toBe(getDirectDispatcher(transport(defaultMs)));
  });

  it('uses timeouts.imageGenMs and IMAGE_GEN_OAI_MAX_RETRIES when set', () => {
    process.env = { IMAGE_GEN_OAI_MAX_RETRIES: '0' };
    const options = getImageGenClientOptions({ timeouts: { imageGenMs: 1800000 } });
    expect(options).toMatchObject({ timeout: 1800000, maxRetries: 0 });
    expect(options.fetchOptions.dispatcher).toBe(getDirectDispatcher(transport(1800000)));
  });

  it('routes through the proxy dispatcher with the same timeouts', () => {
    process.env = { PROXY: 'http://proxy.test:8080' };
    expect(getImageGenClientOptions().fetchOptions.dispatcher).toBe(
      getProxyDispatcher(undefined, transport(defaultMs)),
    );
  });

  it.each(['', ' ', '-1', '1.5', 'two'])('ignores IMAGE_GEN_OAI_MAX_RETRIES=%j', (value) => {
    process.env = { IMAGE_GEN_OAI_MAX_RETRIES: value };
    expect(getImageGenClientOptions()).not.toHaveProperty('maxRetries');
  });
});
