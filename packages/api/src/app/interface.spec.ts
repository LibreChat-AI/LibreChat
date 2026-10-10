import { buildPreLoginInterface } from './interface';

describe('buildPreLoginInterface', () => {
  it('omits the interface when nothing public is configured', () => {
    expect(buildPreLoginInterface(undefined)).toBeUndefined();
    expect(buildPreLoginInterface({ modelSelect: true, buildInfo: true })).toBeUndefined();
  });

  it('keeps only the legal links and a disabled build-info flag', () => {
    expect(
      buildPreLoginInterface({
        privacyPolicy: { externalUrl: 'https://example.com/privacy' },
        termsOfService: { externalUrl: 'https://example.com/tos' },
        buildInfo: false,
        modelSelect: true,
        parameters: false,
      }),
    ).toEqual({
      privacyPolicy: { externalUrl: 'https://example.com/privacy' },
      termsOfService: { externalUrl: 'https://example.com/tos' },
      buildInfo: false,
    });
  });

  it('carries a bundled theme name', () => {
    expect(buildPreLoginInterface({ theme: 'clickhouse', modelSelect: true })).toEqual({
      theme: 'clickhouse',
    });
  });

  it('carries an inline theme definition unchanged', () => {
    const theme = {
      version: 1 as const,
      name: 'acme',
      modes: { light: { colors: { 'rgb-surface-primary': '255 255 255' } } },
    };
    expect(buildPreLoginInterface({ theme })).toEqual({ theme });
  });
});
