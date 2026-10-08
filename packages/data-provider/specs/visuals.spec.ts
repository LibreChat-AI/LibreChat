import { configSchema, visualsConfigSchema, DEFAULT_VISUAL_SOURCES } from '../src';

describe('visualsConfigSchema', () => {
  it('defaults to the public package CDNs', () => {
    expect(visualsConfigSchema.parse({})).toEqual({ sources: DEFAULT_VISUAL_SOURCES });
    expect(configSchema.parse({ version: '1.0.0' }).visuals.sources).toEqual(
      DEFAULT_VISUAL_SOURCES,
    );
  });

  it('accepts https origins and an empty list', () => {
    expect(
      visualsConfigSchema.parse({ sources: ['https://cdn.example.com', 'https://a.b.io:8443'] })
        .sources,
    ).toEqual(['https://cdn.example.com', 'https://a.b.io:8443']);
    expect(visualsConfigSchema.parse({ sources: [] }).sources).toEqual([]);
  });

  it.each([
    'http://cdn.example.com',
    'https://cdn.example.com/path',
    "https://cdn.example.com 'unsafe-inline'",
    'https://cdn.example.com; connect-src *',
    '*',
    'https://localhost',
  ])('rejects %p', (source) => {
    expect(visualsConfigSchema.safeParse({ sources: [source] }).success).toBe(false);
  });
});
