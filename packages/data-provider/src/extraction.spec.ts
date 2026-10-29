import { extractionServiceSchema, mergeFileConfig } from './file-config';
import { configSchema } from './config';

describe('mandatory semantic extraction configuration', () => {
  it('provides endpoint/credential/resource defaults without an enablement switch', () => {
    expect(extractionServiceSchema.parse({})).toEqual({
      url: 'http://extraction:8000',
      tokenFile: '/run/extraction/token',
      deadlineMs: 12000,
      maxInputBytes: 10485760,
      maxTextBytes: 1048576,
      maxResponseBytes: 3145728,
      maxSegments: 128,
    });
    expect(configSchema.parse({ version: '1.4.8' }).fileConfig?.extractionService).toBeUndefined();
  });
  it.each(['http://extraction:8000', 'https://processor.example/', 'http://[::1]:8000'])(
    'accepts configured origin %s',
    (url) => {
      expect(extractionServiceSchema.parse({ url }).url).toBe(url);
    },
  );
  it('loads adjustable limits through configSchema and fileConfig merging', () => {
    const config = configSchema.parse({
      version: '1.4.8',
      fileConfig: {
        extractionService: {
          url: 'https://processor.example',
          tokenFile: '/run/extraction/token',
          deadlineMs: 11000,
        },
      },
    });
    expect(mergeFileConfig(config.fileConfig).extractionService).toEqual({
      url: 'https://processor.example',
      tokenFile: '/run/extraction/token',
      deadlineMs: 11000,
      maxInputBytes: 10485760,
      maxTextBytes: 1048576,
      maxResponseBytes: 3145728,
      maxSegments: 128,
    });
  });
  it.each([
    { enabled: false },
    { enabled: true },
    { formats: ['pdf'] },
    { socketPath: '/socket/extraction.sock' },
    { url: 'http://processor.example' },
    { url: 'http://192.168.1.2:8000' },
    { url: 'http://extraction:9000' },
    { url: 'http://extraction' },
    { url: 'http://localhost.example' },
    { url: 'file:///run/extraction/token' },
    { url: 'ftp://processor' },
    { url: 'http://user:secret@processor' },
    { url: 'http://@processor' },
    { url: 'http://processor/path' },
    { url: 'http://processor/path/..' },
    { url: 'http://processor/?' },
    { url: 'http://processor/#' },
    { url: 'http://processor?secret' },
    { url: 'http://processor#secret' },
    { url: 'http://processor\\path' },
    { url: 'http://processor\n' },
    { url: ' http://processor' },
    { url: 'http://' },
    { tokenFile: 'token' },
    { tokenFile: '/run/\0bad' },
    { deadlineMs: 15001 },
    { maxInputBytes: 10485761 },
    { maxTextBytes: 1048577 },
    { maxResponseBytes: 3145729 },
    { maxSegments: 129 },
    { deadlineMs: 0 },
    { maxInputBytes: -1 },
    { maxSegments: 1.5 },
    { script: 'exec' },
  ])('rejects disablement and unsafe configuration %j', (config) => {
    expect(extractionServiceSchema.safeParse(config).success).toBe(false);
    expect(
      configSchema.safeParse({ version: '1.4.8', fileConfig: { extractionService: config } })
        .success,
    ).toBe(false);
  });
});
