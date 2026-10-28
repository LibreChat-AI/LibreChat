import { RE2JS } from 're2js';
import {
  fileConfigSchema,
  mergeFileConfig,
  convertStringsToRegex,
  setFileConfigRegexCompiler,
} from './file-config';
import { configSchema } from './config';

describe('MIME pattern config validation', () => {
  afterEach(() => {
    setFileConfigRegexCompiler((pattern) => new RegExp(pattern));
    jest.restoreAllMocks();
  });

  it('uses the active compiler at parse time, including schemas created before startup', () => {
    const config = { endpoints: { default: { supportedMimeTypes: ['^text/(?=plain$)plain$'] } } };
    expect(fileConfigSchema.safeParse(config).success).toBe(true);
    setFileConfigRegexCompiler((pattern) => RE2JS.compile(pattern));
    expect(fileConfigSchema.safeParse(config).success).toBe(false);
  });

  it.each(['(?=text)', '(?!image)', '(?<=text)/plain', '(text)/\\1', '['])(
    'reports the full config path for an unsupported pattern: %s',
    (pattern) => {
      setFileConfigRegexCompiler((value) => RE2JS.compile(value));
      const result = configSchema.safeParse({
        version: '1.3.16',
        fileConfig: {
          endpoints: { default: { supportedMimeTypes: ['application/pdf', pattern] } },
        },
      });
      expect(result.success).toBe(false);
      if (result.success) {
        throw new Error('Expected an invalid MIME pattern to fail config validation');
      }
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['fileConfig', 'endpoints', 'default', 'supportedMimeTypes', 1],
            message: 'Invalid MIME type regex: not supported by the configured regex engine',
          }),
        ]),
      );
    },
  );

  it.each(['ocr', 'text'])('validates %s MIME lists too', (section) => {
    setFileConfigRegexCompiler((pattern) => RE2JS.compile(pattern));
    const result = fileConfigSchema.safeParse({ [section]: { supportedMimeTypes: ['(?=text)'] } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual([section, 'supportedMimeTypes', 0]);
    }
  });

  it('preserves supported patterns, empty lists, and omitted configuration', () => {
    setFileConfigRegexCompiler((pattern) => RE2JS.compile(pattern));
    expect(fileConfigSchema.safeParse({}).success).toBe(true);
    expect(
      fileConfigSchema.safeParse({ endpoints: { default: { supportedMimeTypes: [] } } }).success,
    ).toBe(true);
    const config = {
      endpoints: { default: { supportedMimeTypes: ['^text/plain$', 'application/pdf'] } },
    };
    expect(fileConfigSchema.parse(config)).toEqual(config);
    const matchers = mergeFileConfig(config).endpoints.default.supportedMimeTypes;
    expect(matchers?.some((matcher) => matcher.test('text/plain'))).toBe(true);
    expect(matchers?.some((matcher) => matcher.test('image/png'))).toBe(false);
  });

  it('still fails closed if a caller bypasses schema validation', () => {
    setFileConfigRegexCompiler((pattern) => RE2JS.compile(pattern));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const matchers = convertStringsToRegex(['(?=text)']);
    expect(matchers).toHaveLength(1);
    expect(matchers[0].test('text/plain')).toBe(false);
  });
});
