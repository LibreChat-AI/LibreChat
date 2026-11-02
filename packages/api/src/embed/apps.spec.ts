import { getEmbedFrameAncestors, resolveEmbedApps } from './apps';

const secret = 's'.repeat(40);

describe('resolveEmbedApps', () => {
  afterEach(() => {
    delete process.env.EMBED_TEST_SECRET;
  });

  it('returns nothing when embedding is disabled', () => {
    const apps = resolveEmbedApps({
      enabled: false,
      apps: [{ id: 'portal', secret, allowedOrigins: ['https://portal.example.com'] }],
    });
    expect(apps.size).toBe(0);
  });

  it('resolves a secret from the environment and applies defaults', () => {
    process.env.EMBED_TEST_SECRET = secret;
    const apps = resolveEmbedApps({
      enabled: true,
      apps: [
        {
          id: 'portal',
          secret: '${EMBED_TEST_SECRET}',
          allowedOrigins: ['https://portal.example.com'],
        },
      ],
    });
    expect(apps.get('portal')).toEqual({
      id: 'portal',
      secret,
      allowedOrigins: ['https://portal.example.com'],
      role: undefined,
      maxTokenAgeSeconds: 300,
      sessionSeconds: 900,
    });
  });

  it('disables an app whose secret is unset or too short', () => {
    const apps = resolveEmbedApps({
      enabled: true,
      apps: [
        { id: 'unset', secret: '${EMBED_TEST_SECRET}', allowedOrigins: ['https://a.example'] },
        { id: 'short', secret: 'short', allowedOrigins: ['https://b.example'] },
      ],
    });
    expect(apps.size).toBe(0);
  });

  it('keeps the first of two apps with the same id', () => {
    const apps = resolveEmbedApps({
      enabled: true,
      apps: [
        { id: 'portal', secret, allowedOrigins: ['https://a.example'] },
        { id: 'portal', secret, allowedOrigins: ['https://b.example'] },
      ],
    });
    expect(apps.get('portal')?.allowedOrigins).toEqual(['https://a.example']);
  });
});

describe('getEmbedFrameAncestors', () => {
  it('lists every allowed origin once', () => {
    const apps = resolveEmbedApps({
      enabled: true,
      apps: [
        { id: 'one', secret, allowedOrigins: ['https://a.example', 'https://b.example'] },
        { id: 'two', secret, allowedOrigins: ['https://b.example'] },
      ],
    });
    expect(getEmbedFrameAncestors(apps)).toEqual(['https://a.example', 'https://b.example']);
  });
});
