import { FileSources } from 'librechat-data-provider';
import { getTenantId, SYSTEM_TENANT_ID } from '@librechat/data-schemas';
import type { AppConfig } from '@librechat/data-schemas';
import {
  resolveSharedLinkConfig,
  isFileSnapshotEnabled,
  buildSharedLinkStartupPayload,
  createSharedLinkConfigMiddleware,
} from './config';

const appConfig = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  config: {},
  fileStrategy: FileSources.local,
  imageOutputType: 'png',
  ...overrides,
});

const withSharedLinks = (
  sharedLinks: NonNullable<AppConfig['interfaceConfig']>['sharedLinks'],
): AppConfig => appConfig({ interfaceConfig: { sharedLinks } });

describe('shared-link config resolution', () => {
  const ownerConfig = appConfig({
    filters: { messages: { pii: { starterPatterns: ['sk_prefix'] } } },
  });
  const viewerConfig = appConfig();

  it('uses the share tenant policy instead of an authenticated viewer tenant policy', async () => {
    let resolvedTenantId: string | undefined;
    const getAppConfig = jest.fn(async () => {
      resolvedTenantId = getTenantId();
      return ownerConfig;
    });
    const middleware = createSharedLinkConfigMiddleware({ getAppConfig });
    const req = Object.assign({} as Parameters<typeof middleware>[0], {
      user: { id: 'viewer', tenantId: 'tenant-viewer' },
      shareTenantId: 'tenant-owner',
      config: viewerConfig,
    });
    const next = jest.fn();

    await middleware(req, {} as Parameters<typeof middleware>[1], next);

    expect(getAppConfig).toHaveBeenCalledWith({ tenantId: 'tenant-owner' });
    expect(resolvedTenantId).toBe('tenant-owner');
    expect(req.config).toBe(ownerConfig);
    expect(next).toHaveBeenCalledWith();
  });

  it.each([undefined, SYSTEM_TENANT_ID])(
    'uses base config when the share has no tenant scope (%s)',
    async (shareTenantId) => {
      const baseConfig = appConfig({
        filters: { messages: { pii: { starterPatterns: ['bearer_header'] } } },
      });
      const getAppConfig = jest.fn().mockResolvedValue(baseConfig);

      const result = await resolveSharedLinkConfig(getAppConfig, shareTenantId);

      expect(result).toBe(baseConfig);
      expect(getAppConfig).toHaveBeenCalledWith({ baseOnly: true });
    },
  );
});

describe('isFileSnapshotEnabled', () => {
  const original = process.env.SHARED_LINKS_SNAPSHOT_FILES;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.SHARED_LINKS_SNAPSHOT_FILES;
    } else {
      process.env.SHARED_LINKS_SNAPSHOT_FILES = original;
    }
  });

  it('defaults to enabled with no config or env', () => {
    delete process.env.SHARED_LINKS_SNAPSHOT_FILES;
    expect(isFileSnapshotEnabled()).toBe(true);
    expect(isFileSnapshotEnabled(appConfig())).toBe(true);
  });

  it('honors yaml snapshotFiles: false', () => {
    delete process.env.SHARED_LINKS_SNAPSHOT_FILES;
    expect(isFileSnapshotEnabled(withSharedLinks({ snapshotFiles: false }))).toBe(false);
  });

  it('defaults enabled when sharedLinks is a boolean', () => {
    delete process.env.SHARED_LINKS_SNAPSHOT_FILES;
    expect(isFileSnapshotEnabled(withSharedLinks(true))).toBe(true);
  });

  it('env override wins over yaml (env false beats yaml true)', () => {
    process.env.SHARED_LINKS_SNAPSHOT_FILES = 'false';
    expect(isFileSnapshotEnabled(withSharedLinks({ snapshotFiles: true }))).toBe(false);
  });

  it('env override wins over yaml (env true beats yaml false)', () => {
    process.env.SHARED_LINKS_SNAPSHOT_FILES = 'true';
    expect(isFileSnapshotEnabled(withSharedLinks({ snapshotFiles: false }))).toBe(true);
  });
});

describe('buildSharedLinkStartupPayload', () => {
  it.each([0, 100, 60000])(
    'includes the configured highlight cadence %i without other settings',
    (codeHighlightThrottleMs) => {
      expect(
        buildSharedLinkStartupPayload(
          appConfig({
            interfaceConfig: {
              codeHighlightThrottleMs,
              modelSelect: true,
            },
          }),
          {},
        ),
      ).toEqual({ appTitle: 'LibreChat', interface: { codeHighlightThrottleMs } });
    },
  );

  it('builds the share-view startup allowlist', () => {
    const payload = buildSharedLinkStartupPayload(
      appConfig({
        interfaceConfig: {
          privacyPolicy: { externalUrl: 'https://example.com/privacy' },
          termsOfService: { externalUrl: 'https://example.com/tos' },
          modelSelect: true,
        },
      }),
      {
        ANALYTICS_GTM_ID: 'GTM-XYZ',
        APP_TITLE: 'Test Chat',
        CUSTOM_FOOTER: 'Shared footer',
        SANDPACK_BUNDLER_URL: 'https://bundler.example.com',
        SANDPACK_STATIC_BUNDLER_URL: 'https://static-bundler.example.com',
      },
    );

    expect(payload).toEqual({
      appTitle: 'Test Chat',
      analyticsGtmId: 'GTM-XYZ',
      bundlerURL: 'https://bundler.example.com',
      staticBundlerURL: 'https://static-bundler.example.com',
      customFooter: 'Shared footer',
      interface: {
        privacyPolicy: { externalUrl: 'https://example.com/privacy' },
        termsOfService: { externalUrl: 'https://example.com/tos' },
      },
    });
  });

  it('defaults the app title and omits unrelated interface config', () => {
    const payload = buildSharedLinkStartupPayload(
      appConfig({ interfaceConfig: { modelSelect: true } }),
      {},
    );

    expect(payload).toEqual({ appTitle: 'LibreChat' });
  });
});
