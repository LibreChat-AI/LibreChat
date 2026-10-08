import type { AppConfig } from '@librechat/data-schemas';

process.env.CREDS_KEY =
  process.env.CREDS_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const CENTRAL_EXPORT_ATTRIBUTE = 'librechat.langfuse.central_export.enabled';
const exportTelemetry = (plan: string, reason: string) => ({
  'librechat.langfuse.export_plan': plan,
  'librechat.langfuse.export_reason': reason,
  'librechat.tenant.id': 'tenant-1',
});
const envKeys = [
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_BASE_URL',
  'LANGFUSE_HOST',
  'LANGFUSE_BASEURL',
  'LANGFUSE_FANOUT_ENABLED',
  'LANGFUSE_FANOUT_COLLECTOR_URL',
  'LANGFUSE_FANOUT_CENTRAL_MEDIA_UPLOAD_DISABLED',
  'LANGFUSE_FANOUT_TENANT_DESTINATIONS',
  'LANGFUSE_FANOUT_TENANT_EXPORT_DISABLED',
  'LANGFUSE_TRACING_ENABLED',
  'LANGFUSE_SAMPLE_RATE',
  'TENANT_ISOLATION_STRICT',
];

function clearEnv() {
  for (const key of envKeys) {
    delete process.env[key];
  }
}

describe('buildLangfuseConfig', () => {
  beforeEach(() => {
    clearEnv();
    process.env.TENANT_ISOLATION_STRICT = 'true';
  });

  afterEach(() => {
    clearEnv();
  });

  it('enables fanout only when both the toggle and collector URL are configured', async () => {
    const { isLangfuseFanoutEnabled } = await import('./config');

    process.env.LANGFUSE_FANOUT_ENABLED = 'true';
    expect(isLangfuseFanoutEnabled()).toBe(false);

    process.env.LANGFUSE_FANOUT_COLLECTOR_URL = '   ';
    expect(isLangfuseFanoutEnabled()).toBe(false);

    process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://langfuse-fanout:4318';
    expect(isLangfuseFanoutEnabled()).toBe(true);
  });

  it('uses a stored connection directly for every run in single-tenant mode', async () => {
    delete process.env.TENANT_ISOLATION_STRICT;
    const { encryptV3 } = await import('@librechat/data-schemas');
    const { buildLangfuseConfig } = await import('./config');

    expect(
      buildLangfuseConfig({
        runId: 'run-1',
        appConfig: {
          langfuse: {
            enabled: true,
            publicKey: 'pk-stored',
            secretKey: encryptV3('sk-stored'),
            destination: 'us',
          },
        } as unknown as AppConfig,
      }),
    ).toEqual({
      deterministicTraceId: true,
      publicKey: 'pk-stored',
      secretKey: 'sk-stored',
      baseUrl: 'https://us.cloud.langfuse.com',
    });
  });

  it('stamps the configured trace identity and allowlisted metadata on the run config', async () => {
    delete process.env.TENANT_ISOLATION_STRICT;
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-env';
    process.env.LANGFUSE_SECRET_KEY = 'sk-env';
    const { buildLangfuseConfig } = await import('./config');

    expect(
      buildLangfuseConfig({
        runId: 'run-1',
        tenantId: 'tenant-1',
        appConfig: {
          langfuse: {
            trace: {
              userIdField: 'email',
              userMetadataFields: ['email', 'role', 'samlId'],
              conversationMetadataFields: ['conversationId', 'model', 'spec'],
            },
          },
        } as unknown as AppConfig,
        user: { id: 'user-1', email: 'alice@example.com', role: 'USER', username: 'alice' },
        traceContext: {
          conversationId: 'convo-1',
          model: 'gpt-5',
          modelLabel: 'Helper',
          spec: 'support',
        },
      }),
    ).toEqual({
      deterministicTraceId: true,
      userId: 'alice@example.com',
      metadata: {
        'librechat.user.email': 'alice@example.com',
        'librechat.user.role': 'USER',
        'librechat.conversation.id': 'convo-1',
        'librechat.model': 'gpt-5',
        'librechat.spec': 'support',
        'librechat.tenant.id': 'tenant-1',
      },
      tags: ['tenant:tenant-1'],
      publicKey: 'pk-env',
      secretKey: 'sk-env',
      baseUrl: 'https://cloud.langfuse.com',
    });
  });

  it('exports neither user identity nor metadata until trace fields are configured', async () => {
    delete process.env.TENANT_ISOLATION_STRICT;
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-env';
    process.env.LANGFUSE_SECRET_KEY = 'sk-env';
    const { buildLangfuseConfig } = await import('./config');

    expect(
      buildLangfuseConfig({
        runId: 'run-1',
        user: { id: 'user-1', email: 'alice@example.com', role: 'USER' },
        traceContext: { conversationId: 'convo-1', model: 'gpt-5', endpoint: 'agents' },
      }),
    ).toEqual({
      deterministicTraceId: true,
      publicKey: 'pk-env',
      secretKey: 'sk-env',
      baseUrl: 'https://cloud.langfuse.com',
    });
  });

  it('prefers environment credentials in single-tenant mode', async () => {
    delete process.env.TENANT_ISOLATION_STRICT;
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-env';
    process.env.LANGFUSE_SECRET_KEY = 'sk-env';
    process.env.LANGFUSE_BASE_URL = 'https://env.langfuse.example';
    const { encryptV3 } = await import('@librechat/data-schemas');
    const { buildLangfuseConfig } = await import('./config');

    expect(
      buildLangfuseConfig({
        runId: 'run-1',
        appConfig: {
          langfuse: {
            enabled: true,
            publicKey: 'pk-stored',
            secretKey: encryptV3('sk-stored'),
            destination: 'us',
          },
        } as unknown as AppConfig,
      }),
    ).toEqual({
      deterministicTraceId: true,
      publicKey: 'pk-env',
      secretKey: 'sk-env',
      baseUrl: 'https://env.langfuse.example',
    });
  });

  it('does not trace a disabled stored connection in single-tenant mode', async () => {
    delete process.env.TENANT_ISOLATION_STRICT;
    const { encryptV3 } = await import('@librechat/data-schemas');
    const { buildLangfuseConfig } = await import('./config');

    expect(
      buildLangfuseConfig({
        runId: 'run-1',
        appConfig: {
          langfuse: {
            enabled: false,
            publicKey: 'pk-stored',
            secretKey: encryptV3('sk-stored'),
            destination: 'us',
          },
        } as unknown as AppConfig,
      }),
    ).toEqual({
      deterministicTraceId: true,
      enabled: false,
    });
  });

  it.each(['false', '0', 'no', 'off'])(
    'disables traces when LANGFUSE_TRACING_ENABLED is %s',
    async (value) => {
      process.env.LANGFUSE_TRACING_ENABLED = value;
      process.env.LANGFUSE_PUBLIC_KEY = 'pk-central';
      process.env.LANGFUSE_SECRET_KEY = 'sk-central';
      const { buildLangfuseConfig } = await import('./config');

      expect(buildLangfuseConfig({ runId: 'run-1' })).toEqual({
        deterministicTraceId: true,
        enabled: false,
      });
    },
  );

  it('applies fractional sampling to deterministic run trace IDs', async () => {
    process.env.LANGFUSE_SAMPLE_RATE = '0.5';
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-central';
    process.env.LANGFUSE_SECRET_KEY = 'sk-central';
    const { buildLangfuseConfig } = await import('./config');

    expect(buildLangfuseConfig({ runId: 'sampled-run' })).toEqual({
      deterministicTraceId: true,
      enabled: false,
    });
    expect(buildLangfuseConfig({ runId: 'unsampled-run' })).toMatchObject({
      deterministicTraceId: true,
      publicKey: 'pk-central',
      secretKey: 'sk-central',
    });
  });

  it('decrypts encrypted tenant secrets for tenant trace export', async () => {
    delete process.env.TENANT_ISOLATION_STRICT;
    process.env.LANGFUSE_FANOUT_ENABLED = 'true';
    process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://langfuse-fanout-collector:4318';
    const { encryptV3 } = await import('@librechat/data-schemas');
    const { buildLangfuseConfig } = await import('./config');

    const config = buildLangfuseConfig({
      tenantId: 'tenant-1',
      appConfig: {
        langfuse: {
          enabled: true,
          publicKey: 'pk-tenant-1',
          secretKey: encryptV3('sk-tenant-1'),
          destination: 'eu',
        },
      } as unknown as AppConfig,
    });

    expect(config).toMatchObject({
      publicKey: 'pk-tenant-1',
      secretKey: 'sk-tenant-1',
      baseUrl: 'http://langfuse-fanout-collector:4318/tenant/eu',
      librechatTraceAttributes: {
        ...exportTelemetry('tenant_fanout', 'configured'),
        'librechat.langfuse.tenant_export.enabled': 'true',
        'librechat.langfuse.destination': 'eu',
      },
    });
    expect(config).not.toHaveProperty('mediaUploadEnabled');
  });

  it('fails closed to central-only export when tenant secret decryption fails', async () => {
    process.env.LANGFUSE_FANOUT_ENABLED = 'true';
    process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://langfuse-fanout-collector:4318';
    const { buildLangfuseConfig } = await import('./config');

    const config = buildLangfuseConfig({
      tenantId: 'tenant-1',
      appConfig: {
        langfuse: {
          enabled: true,
          publicKey: 'pk-tenant-1',
          secretKey: 'v3:not-valid-ciphertext',
          destination: 'eu',
        },
      } as unknown as AppConfig,
    });

    expect(config).toEqual({
      deterministicTraceId: true,
      baseUrl: 'http://langfuse-fanout-collector:4318',
      librechatTraceAttributes: exportTelemetry('central_only', 'missing_credentials'),
      metadata: { 'librechat.tenant.id': 'tenant-1' },
      tags: ['tenant:tenant-1'],
    });
  });

  it('fails closed to central-only export when tenant secret is plaintext at runtime', async () => {
    process.env.LANGFUSE_FANOUT_ENABLED = 'true';
    process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://langfuse-fanout-collector:4318';
    const { buildLangfuseConfig } = await import('./config');

    const config = buildLangfuseConfig({
      tenantId: 'tenant-1',
      appConfig: {
        langfuse: {
          enabled: true,
          publicKey: 'pk-tenant-1',
          secretKey: 'sk-tenant-1',
          destination: 'eu',
        },
      } as unknown as AppConfig,
    });

    expect(config).toEqual({
      deterministicTraceId: true,
      baseUrl: 'http://langfuse-fanout-collector:4318',
      librechatTraceAttributes: exportTelemetry('central_only', 'missing_credentials'),
      metadata: { 'librechat.tenant.id': 'tenant-1' },
      tags: ['tenant:tenant-1'],
    });
  });

  it('keeps central export enabled by default', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-central';
    process.env.LANGFUSE_SECRET_KEY = 'sk-central';
    process.env.LANGFUSE_BASE_URL = 'https://central.langfuse.example';
    const { buildLangfuseConfig } = await import('./config');

    expect(buildLangfuseConfig({ tenantId: 'tenant-1' })).toEqual({
      deterministicTraceId: true,
      publicKey: 'pk-central',
      secretKey: 'sk-central',
      baseUrl: 'https://central.langfuse.example',
      librechatTraceAttributes: exportTelemetry('central_only', 'fanout_disabled'),
      metadata: { 'librechat.tenant.id': 'tenant-1' },
      tags: ['tenant:tenant-1'],
    });
  });

  it('records when fanout is enabled without a collector URL', async () => {
    process.env.LANGFUSE_FANOUT_ENABLED = 'true';
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-central';
    process.env.LANGFUSE_SECRET_KEY = 'sk-central';
    const { buildLangfuseConfig } = await import('./config');

    expect(buildLangfuseConfig({ tenantId: 'tenant-1' })).toMatchObject({
      publicKey: 'pk-central',
      secretKey: 'sk-central',
      librechatTraceAttributes: exportTelemetry('central_only', 'collector_unconfigured'),
    });
  });

  it('records when an enabled tenant connection has an unknown destination', async () => {
    process.env.LANGFUSE_FANOUT_ENABLED = 'true';
    process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://collector-from-env:4318';
    const { encryptV3 } = await import('@librechat/data-schemas');
    const { buildLangfuseConfig } = await import('./config');

    expect(
      buildLangfuseConfig({
        tenantId: 'tenant-1',
        appConfig: {
          langfuse: {
            enabled: true,
            publicKey: 'pk-tenant-1',
            secretKey: encryptV3('sk-tenant-1'),
            destination: 'unknown-destination',
          },
        } as unknown as AppConfig,
      }),
    ).toMatchObject({
      baseUrl: 'http://collector-from-env:4318',
      librechatTraceAttributes: exportTelemetry('central_only', 'destination_unconfigured'),
    });
  });

  it('disables direct central tracing when central export is disabled', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-central';
    process.env.LANGFUSE_SECRET_KEY = 'sk-central';
    process.env.LANGFUSE_BASE_URL = 'https://central.langfuse.example';
    const { buildLangfuseConfig } = await import('./config');

    expect(
      buildLangfuseConfig({
        tenantId: 'tenant-1',
        centralTraceExportEnabled: false,
      }),
    ).toEqual({
      deterministicTraceId: true,
      metadata: { 'librechat.tenant.id': 'tenant-1' },
      enabled: false,
      librechatTraceAttributes: {
        [CENTRAL_EXPORT_ATTRIBUTE]: 'false',
        ...exportTelemetry('disabled', 'fanout_disabled'),
      },
      tags: ['tenant:tenant-1'],
    });
  });

  it('does not emit central-suppressed traces when there is no tenant fanout route', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-central';
    process.env.LANGFUSE_SECRET_KEY = 'sk-central';
    process.env.LANGFUSE_FANOUT_ENABLED = 'true';
    process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://collector-from-env:4318';
    const { buildLangfuseConfig } = await import('./config');

    expect(
      buildLangfuseConfig({
        tenantId: 'tenant-1',
        centralTraceExportEnabled: false,
      }),
    ).toEqual({
      deterministicTraceId: true,
      metadata: { 'librechat.tenant.id': 'tenant-1' },
      enabled: false,
      librechatTraceAttributes: {
        [CENTRAL_EXPORT_ATTRIBUTE]: 'false',
        ...exportTelemetry('disabled', 'tenant_disabled'),
      },
      tags: ['tenant:tenant-1'],
    });
  });

  it('routes encrypted tenant credentials while marking central export disabled', async () => {
    process.env.LANGFUSE_FANOUT_ENABLED = 'true';
    process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://collector-from-env:4318';
    const { encryptV3 } = await import('@librechat/data-schemas');
    const { buildLangfuseConfig } = await import('./config');

    expect(
      buildLangfuseConfig({
        tenantId: 'tenant-1',
        centralTraceExportEnabled: false,
        appConfig: {
          langfuse: {
            enabled: true,
            publicKey: 'pk-tenant-1',
            secretKey: encryptV3('sk-tenant-1'),
            destination: 'us',
          },
        } as unknown as AppConfig,
      }),
    ).toMatchObject({
      deterministicTraceId: true,
      publicKey: 'pk-tenant-1',
      secretKey: 'sk-tenant-1',
      baseUrl: 'http://collector-from-env:4318/tenant/us/central-media-disabled',
      metadata: { 'librechat.tenant.id': 'tenant-1' },
      librechatTraceAttributes: {
        [CENTRAL_EXPORT_ATTRIBUTE]: 'false',
        ...exportTelemetry('tenant_fanout', 'configured'),
        'librechat.langfuse.tenant_export.enabled': 'true',
        'librechat.langfuse.destination': 'us',
      },
      tags: ['tenant:tenant-1'],
    });
  });

  it('does not emit central-suppressed traces when tenant fanout is emergency-disabled', async () => {
    process.env.LANGFUSE_FANOUT_ENABLED = 'true';
    process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://collector-from-env:4318';
    process.env.LANGFUSE_FANOUT_TENANT_EXPORT_DISABLED = 'true';
    const { encryptV3 } = await import('@librechat/data-schemas');
    const { buildLangfuseConfig } = await import('./config');

    expect(
      buildLangfuseConfig({
        tenantId: 'tenant-1',
        centralTraceExportEnabled: false,
        appConfig: {
          langfuse: {
            enabled: true,
            publicKey: 'pk-tenant-1',
            secretKey: encryptV3('sk-tenant-1'),
            destination: 'us',
          },
        } as unknown as AppConfig,
      }),
    ).toEqual({
      deterministicTraceId: true,
      metadata: { 'librechat.tenant.id': 'tenant-1' },
      enabled: false,
      librechatTraceAttributes: {
        [CENTRAL_EXPORT_ATTRIBUTE]: 'false',
        ...exportTelemetry('disabled', 'emergency_disabled'),
      },
      tags: ['tenant:tenant-1'],
    });
  });

  it('keeps central collector export when the tenant connection is disabled', async () => {
    process.env.LANGFUSE_FANOUT_ENABLED = 'true';
    process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://collector-from-env:4318';
    const { encryptV3 } = await import('@librechat/data-schemas');
    const { buildLangfuseConfig } = await import('./config');

    expect(
      buildLangfuseConfig({
        tenantId: 'tenant-1',
        appConfig: {
          langfuse: {
            enabled: false,
            publicKey: 'pk-tenant-1',
            secretKey: encryptV3('sk-tenant-1'),
            destination: 'us',
          },
        } as unknown as AppConfig,
      }),
    ).toEqual({
      deterministicTraceId: true,
      baseUrl: 'http://collector-from-env:4318',
      librechatTraceAttributes: exportTelemetry('central_only', 'tenant_disabled'),
      metadata: { 'librechat.tenant.id': 'tenant-1' },
      tags: ['tenant:tenant-1'],
    });
  });

  it('keeps central collector export when tenant enabled is missing', async () => {
    process.env.LANGFUSE_FANOUT_ENABLED = 'true';
    process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://collector-from-env:4318';
    const { encryptV3 } = await import('@librechat/data-schemas');
    const { buildLangfuseConfig } = await import('./config');

    expect(
      buildLangfuseConfig({
        tenantId: 'tenant-1',
        appConfig: {
          langfuse: {
            publicKey: 'pk-tenant-1',
            secretKey: encryptV3('sk-tenant-1'),
            destination: 'us',
          },
        } as unknown as AppConfig,
      }),
    ).toEqual({
      deterministicTraceId: true,
      baseUrl: 'http://collector-from-env:4318',
      librechatTraceAttributes: exportTelemetry('central_only', 'tenant_disabled'),
      metadata: { 'librechat.tenant.id': 'tenant-1' },
      tags: ['tenant:tenant-1'],
    });
  });

  it('does not emit central-suppressed traces when the tenant connection is disabled', async () => {
    process.env.LANGFUSE_FANOUT_ENABLED = 'true';
    process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://collector-from-env:4318';
    const { buildLangfuseConfig } = await import('./config');

    expect(
      buildLangfuseConfig({
        tenantId: 'tenant-1',
        centralTraceExportEnabled: false,
        appConfig: {
          langfuse: {
            enabled: false,
          },
        } as AppConfig,
      }),
    ).toEqual({
      deterministicTraceId: true,
      metadata: { 'librechat.tenant.id': 'tenant-1' },
      enabled: false,
      librechatTraceAttributes: {
        [CENTRAL_EXPORT_ATTRIBUTE]: 'false',
        ...exportTelemetry('disabled', 'tenant_disabled'),
      },
      tags: ['tenant:tenant-1'],
    });
  });

  it.each(['true', '1', 'yes', 'on'])(
    'disables central collector media uploads when LANGFUSE_FANOUT_CENTRAL_MEDIA_UPLOAD_DISABLED is %s',
    async (value) => {
      process.env.LANGFUSE_FANOUT_ENABLED = 'true';
      process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://collector-from-env:4318';
      process.env.LANGFUSE_FANOUT_CENTRAL_MEDIA_UPLOAD_DISABLED = value;
      const { buildLangfuseConfig } = await import('./config');

      expect(buildLangfuseConfig({ tenantId: 'tenant-1' })).toEqual({
        deterministicTraceId: true,
        baseUrl: 'http://collector-from-env:4318',
        mediaUploadEnabled: false,
        librechatTraceAttributes: exportTelemetry('central_only', 'tenant_disabled'),
        metadata: { 'librechat.tenant.id': 'tenant-1' },
        tags: ['tenant:tenant-1'],
      });
    },
  );

  it.each(['false', '0', 'no', 'off', ''])(
    'keeps central collector media uploads at the SDK default when LANGFUSE_FANOUT_CENTRAL_MEDIA_UPLOAD_DISABLED is %s',
    async (value) => {
      process.env.LANGFUSE_FANOUT_ENABLED = 'true';
      process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://collector-from-env:4318';
      process.env.LANGFUSE_FANOUT_CENTRAL_MEDIA_UPLOAD_DISABLED = value;
      const { buildLangfuseConfig } = await import('./config');

      expect(buildLangfuseConfig({ tenantId: 'tenant-1' })).toEqual({
        deterministicTraceId: true,
        baseUrl: 'http://collector-from-env:4318',
        librechatTraceAttributes: exportTelemetry('central_only', 'tenant_disabled'),
        metadata: { 'librechat.tenant.id': 'tenant-1' },
        tags: ['tenant:tenant-1'],
      });
    },
  );

  it('sends configured headers with env-credential central export', async () => {
    delete process.env.TENANT_ISOLATION_STRICT;
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-env';
    process.env.LANGFUSE_SECRET_KEY = 'sk-env';
    process.env.LANGFUSE_BASE_URL = 'https://langfuse.internal';
    const { buildLangfuseConfig } = await import('./config');

    expect(
      buildLangfuseConfig({
        runId: 'run-1',
        appConfig: {
          langfuse: { headers: { 'CF-Access-Client-Id': 'proxy-client' } },
        } as unknown as AppConfig,
      }),
    ).toEqual({
      deterministicTraceId: true,
      publicKey: 'pk-env',
      secretKey: 'sk-env',
      baseUrl: 'https://langfuse.internal',
      additionalHeaders: { 'CF-Access-Client-Id': 'proxy-client' },
    });
  });

  it('sends configured headers with a stored tenant connection', async () => {
    delete process.env.TENANT_ISOLATION_STRICT;
    process.env.LANGFUSE_FANOUT_TENANT_US_BASE_URL = 'https://us.langfuse.internal';
    const { encryptV3 } = await import('@librechat/data-schemas');
    const { buildLangfuseConfig } = await import('./config');

    expect(
      buildLangfuseConfig({
        runId: 'run-1',
        appConfig: {
          langfuse: {
            enabled: true,
            publicKey: 'pk-stored',
            secretKey: encryptV3('sk-stored'),
            destination: 'us',
            headers: { 'X-Proxy-Token': 'tenant-token' },
          },
        } as unknown as AppConfig,
      }),
    ).toEqual({
      deterministicTraceId: true,
      publicKey: 'pk-stored',
      secretKey: 'sk-stored',
      baseUrl: 'https://us.langfuse.internal',
      additionalHeaders: { 'X-Proxy-Token': 'tenant-token' },
    });
    delete process.env.LANGFUSE_FANOUT_TENANT_US_BASE_URL;
  });

  it('withholds headers from an origin the deployment never configured', async () => {
    delete process.env.TENANT_ISOLATION_STRICT;
    const { encryptV3 } = await import('@librechat/data-schemas');
    const { buildLangfuseConfig } = await import('./config');

    /** The destination here is the built-in Langfuse Cloud default. A proxy
     *  credential meant for an internal gateway must not be disclosed to a
     *  third-party origin the operator never pointed at. */
    const built = buildLangfuseConfig({
      runId: 'run-1',
      appConfig: {
        langfuse: {
          enabled: true,
          publicKey: 'pk-stored',
          secretKey: encryptV3('sk-stored'),
          destination: 'us',
          headers: { 'X-Proxy-Token': 'internal-gateway-token' },
        },
      } as unknown as AppConfig,
    });

    expect(built).not.toHaveProperty('additionalHeaders');
    expect(JSON.stringify(built)).not.toContain('internal-gateway-token');
  });

  it('withholds headers from central cloud export while the collector still receives them', async () => {
    process.env.LANGFUSE_FANOUT_ENABLED = 'true';
    process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://collector:4318';
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-env';
    process.env.LANGFUSE_SECRET_KEY = 'sk-env';
    const { buildLangfuseConfig } = await import('./config');

    const appConfig = {
      langfuse: { headers: { 'X-Gateway-Key': 'gateway' } },
    } as unknown as AppConfig;

    expect(buildLangfuseConfig({ tenantId: 'tenant-1', appConfig })).toMatchObject({
      baseUrl: 'http://collector:4318',
      additionalHeaders: { 'X-Gateway-Key': 'gateway' },
    });

    /** Without fanout the same config exports straight to Langfuse Cloud, which
     *  must not receive the collector's credential. */
    delete process.env.LANGFUSE_FANOUT_ENABLED;
    delete process.env.LANGFUSE_FANOUT_COLLECTOR_URL;
    delete process.env.TENANT_ISOLATION_STRICT;
    const direct = buildLangfuseConfig({ runId: 'run-1', appConfig });
    expect(direct).toMatchObject({ baseUrl: 'https://cloud.langfuse.com' });
    expect(direct).not.toHaveProperty('additionalHeaders');
  });

  it('sends configured headers to the fanout collector', async () => {
    process.env.LANGFUSE_FANOUT_ENABLED = 'true';
    process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://collector:4318';
    const { buildLangfuseConfig } = await import('./config');

    expect(
      buildLangfuseConfig({
        tenantId: 'tenant-1',
        appConfig: {
          langfuse: { headers: { 'X-Gateway-Key': 'gateway' } },
        } as unknown as AppConfig,
      }),
    ).toMatchObject({
      baseUrl: 'http://collector:4318',
      additionalHeaders: { 'X-Gateway-Key': 'gateway' },
    });
  });

  it('interpolates env vars in headers and drops the unresolved', async () => {
    delete process.env.TENANT_ISOLATION_STRICT;
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-env';
    process.env.LANGFUSE_SECRET_KEY = 'sk-env';
    process.env.LANGFUSE_BASE_URL = 'https://langfuse.internal';
    process.env.LANGFUSE_PROXY_TOKEN = 'resolved-token';
    const { buildLangfuseConfig } = await import('./config');

    const built = buildLangfuseConfig({
      runId: 'run-1',
      appConfig: {
        langfuse: {
          headers: {
            'X-Proxy-Token': '${LANGFUSE_PROXY_TOKEN}',
            'X-Missing': '${LANGFUSE_HEADER_NOT_SET}',
            'X-Blank': '   ',
          },
        },
      } as unknown as AppConfig,
    }) as { additionalHeaders?: Record<string, string> };

    expect(built.additionalHeaders).toEqual({ 'X-Proxy-Token': 'resolved-token' });
    delete process.env.LANGFUSE_PROXY_TOKEN;
  });

  it('collapses case-variant header names to a single spelling', async () => {
    delete process.env.TENANT_ISOLATION_STRICT;
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-env';
    process.env.LANGFUSE_SECRET_KEY = 'sk-env';
    process.env.LANGFUSE_BASE_URL = 'https://langfuse.internal';
    const { buildLangfuseConfig } = await import('./config');

    const built = buildLangfuseConfig({
      runId: 'run-1',
      appConfig: {
        langfuse: {
          headers: {
            authorization: 'Bearer first',
            AUTHORIZATION: 'Bearer second',
            'X-Other': 'kept',
          },
        },
      } as unknown as AppConfig,
    }) as { additionalHeaders?: Record<string, string> };

    /** Two spellings surviving would let one slip past the single-key
     *  displacement in `mergeHeaders` and be appended by fetch. */
    expect(
      Object.keys(built.additionalHeaders ?? {}).filter(
        (key) => key.toLowerCase() === 'authorization',
      ),
    ).toHaveLength(1);
    expect(built.additionalHeaders?.['X-Other']).toBe('kept');
  });

  it('encodes header values that fetch cannot transmit verbatim', async () => {
    delete process.env.TENANT_ISOLATION_STRICT;
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-env';
    process.env.LANGFUSE_SECRET_KEY = 'sk-env';
    process.env.LANGFUSE_BASE_URL = 'https://langfuse.internal';
    process.env.LANGFUSE_TEAM_HEADER = 'Marić';
    const { buildLangfuseConfig } = await import('./config');

    const built = buildLangfuseConfig({
      runId: 'run-1',
      appConfig: {
        langfuse: {
          headers: {
            'X-Latin1': 'José',
            'X-Extended': 'Marić',
            'X-FromEnv': '${LANGFUSE_TEAM_HEADER}',
          },
        },
      } as unknown as AppConfig,
    }) as { additionalHeaders?: Record<string, string> };

    /** Characters above U+00FF throw in the `Headers` constructor, so they must
     *  be encoded before they reach any request. Latin-1 passes through. */
    expect(built.additionalHeaders?.['X-Latin1']).toBe('José');
    expect(built.additionalHeaders?.['X-Extended']).toBe('b64:TWFyacSH');
    expect(built.additionalHeaders?.['X-FromEnv']).toBe('b64:TWFyacSH');
    expect(() => new Headers(built.additionalHeaders)).not.toThrow();
    delete process.env.LANGFUSE_TEAM_HEADER;
  });

  it('drops header names that are not valid HTTP tokens', async () => {
    delete process.env.TENANT_ISOLATION_STRICT;
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-env';
    process.env.LANGFUSE_SECRET_KEY = 'sk-env';
    process.env.LANGFUSE_BASE_URL = 'https://langfuse.internal';
    const { buildLangfuseConfig } = await import('./config');

    const built = buildLangfuseConfig({
      runId: 'run-1',
      appConfig: {
        langfuse: {
          headers: {
            'X Proxy Token': 'spaces',
            'X-Proxy-Token:': 'colon',
            '  X-Padded  ': 'trimmed-to-valid',
            'X-Valid': 'kept',
          },
        },
      } as unknown as AppConfig,
    }) as { additionalHeaders?: Record<string, string> };

    /** An invalid name throws in the `Headers` constructor, which would take
     *  down every request rather than just this header. */
    expect(built.additionalHeaders).toEqual({
      'X-Padded': 'trimmed-to-valid',
      'X-Valid': 'kept',
    });
    expect(() => new Headers(built.additionalHeaders)).not.toThrow();
  });

  it('keeps a resolved credential that itself contains ${...}', async () => {
    delete process.env.TENANT_ISOLATION_STRICT;
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-env';
    process.env.LANGFUSE_SECRET_KEY = 'sk-env';
    process.env.LANGFUSE_BASE_URL = 'https://langfuse.internal';
    process.env.LANGFUSE_PROXY_TOKEN = 'abc${def}ghi';
    const { buildLangfuseConfig } = await import('./config');

    const built = buildLangfuseConfig({
      runId: 'run-1',
      appConfig: {
        langfuse: {
          headers: {
            'X-Proxy-Token': '${LANGFUSE_PROXY_TOKEN}',
            'X-Missing': '${LANGFUSE_HEADER_NOT_SET}',
          },
        },
      } as unknown as AppConfig,
    }) as { additionalHeaders?: Record<string, string> };

    /** Gateway tokens are arbitrary strings; testing the *resolved* text for
     *  `${...}` cannot distinguish a failed substitution from a credential
     *  that merely contains those characters. */
    expect(built.additionalHeaders).toEqual({ 'X-Proxy-Token': 'abc${def}ghi' });
    delete process.env.LANGFUSE_PROXY_TOKEN;
  });

  it('does not strip a user placeholder that a resolved credential contains', async () => {
    delete process.env.TENANT_ISOLATION_STRICT;
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-env';
    process.env.LANGFUSE_SECRET_KEY = 'sk-env';
    process.env.LANGFUSE_BASE_URL = 'https://langfuse.internal';
    process.env.LANGFUSE_PROXY_TOKEN = 'abc{{LIBRECHAT_USER_ID}}ghi';
    const { buildLangfuseConfig } = await import('./config');

    const built = buildLangfuseConfig({
      runId: 'run-1',
      appConfig: {
        langfuse: {
          headers: {
            'X-Proxy-Token': '${LANGFUSE_PROXY_TOKEN}',
            'X-Templated': 'keep{{LIBRECHAT_USER_ID}}me',
          },
        },
      } as unknown as AppConfig,
    }) as { additionalHeaders?: Record<string, string> };

    /** The placeholder in the *configured* value is stripped; an identical span
     *  that arrives inside the resolved credential is data, not syntax. */
    expect(built.additionalHeaders).toEqual({
      'X-Proxy-Token': 'abc{{LIBRECHAT_USER_ID}}ghi',
      'X-Templated': 'keepme',
    });
    delete process.env.LANGFUSE_PROXY_TOKEN;
  });

  it('does not re-expand a placeholder that a resolved credential contains', async () => {
    delete process.env.TENANT_ISOLATION_STRICT;
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-env';
    process.env.LANGFUSE_SECRET_KEY = 'sk-env';
    process.env.LANGFUSE_BASE_URL = 'https://langfuse.internal';
    process.env.LANGFUSE_EMBEDDED_NAME = 'SHOULD-NOT-APPEAR';
    process.env.LANGFUSE_PROXY_TOKEN = 'abc${LANGFUSE_EMBEDDED_NAME}ghi';
    const { buildLangfuseConfig } = await import('./config');

    const built = buildLangfuseConfig({
      runId: 'run-1',
      appConfig: {
        langfuse: { headers: { 'X-Proxy-Token': '${LANGFUSE_PROXY_TOKEN}' } },
      } as unknown as AppConfig,
    }) as { additionalHeaders?: Record<string, string> };

    /** The embedded name is *set* here, so a second expansion pass would
     *  rewrite the credential rather than leave it — the earlier test only
     *  covered an unset name and could not catch that. */
    expect(built.additionalHeaders).toEqual({
      'X-Proxy-Token': 'abc${LANGFUSE_EMBEDDED_NAME}ghi',
    });
    delete process.env.LANGFUSE_EMBEDDED_NAME;
    delete process.env.LANGFUSE_PROXY_TOKEN;
  });

  it('drops headers referencing infrastructure secrets', async () => {
    delete process.env.TENANT_ISOLATION_STRICT;
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-env';
    process.env.LANGFUSE_SECRET_KEY = 'sk-env';
    process.env.JWT_SECRET = 'super-secret-jwt';
    const { buildLangfuseConfig } = await import('./config');

    const built = buildLangfuseConfig({
      runId: 'run-1',
      appConfig: {
        langfuse: { headers: { 'X-Leak': '${JWT_SECRET}' } },
      } as unknown as AppConfig,
    }) as { additionalHeaders?: Record<string, string> };

    expect(built).not.toHaveProperty('additionalHeaders');
    expect(JSON.stringify(built)).not.toContain('super-secret-jwt');
  });

  it('drops header values carrying bytes illegal in an HTTP header', async () => {
    delete process.env.TENANT_ISOLATION_STRICT;
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-env';
    process.env.LANGFUSE_SECRET_KEY = 'sk-env';
    process.env.LANGFUSE_BASE_URL = 'https://langfuse.internal';
    const { buildLangfuseConfig } = await import('./config');

    const built = buildLangfuseConfig({
      runId: 'run-1',
      appConfig: {
        langfuse: {
          headers: {
            'X-Injected': 'token\r\nX-Evil: injected',
            'X-Nul': 'tok en',
            'X-Trailing-Newline': 'token\n',
            'X-Clean': 'token',
          },
        },
      } as unknown as AppConfig,
    }) as { additionalHeaders?: Record<string, string> };

    /** A trailing newline is the common `$(cat secret)` case and is trimmed;
     *  an embedded CRLF is a request-splitting attempt and is dropped. */
    expect(built.additionalHeaders).toEqual({
      'X-Trailing-Newline': 'token',
      'X-Clean': 'token',
    });
    expect(() => new Headers(built.additionalHeaders)).not.toThrow();
  });

  it('expands a value built from several env references', async () => {
    delete process.env.TENANT_ISOLATION_STRICT;
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-env';
    process.env.LANGFUSE_SECRET_KEY = 'sk-env';
    process.env.LANGFUSE_BASE_URL = 'https://langfuse.internal';
    process.env.LANGFUSE_CLIENT_ID = 'client-id';
    process.env.LANGFUSE_CLIENT_SECRET = 'client-secret';
    const { buildLangfuseConfig } = await import('./config');

    const built = buildLangfuseConfig({
      runId: 'run-1',
      appConfig: {
        langfuse: {
          headers: {
            'X-Pair': '${LANGFUSE_CLIENT_ID}:${LANGFUSE_CLIENT_SECRET}',
            'X-Suffixed': 'Bearer ${LANGFUSE_CLIENT_SECRET}',
          },
        },
      } as unknown as AppConfig,
    }) as { additionalHeaders?: Record<string, string> };

    /** `extractEnvVariable`'s anchored branch is greedy, so a value that both
     *  starts and ends with a reference parses as one variable named
     *  `LANGFUSE_CLIENT_ID}:${LANGFUSE_CLIENT_SECRET` and is sent raw. */
    expect(built.additionalHeaders).toEqual({
      'X-Pair': 'client-id:client-secret',
      'X-Suffixed': 'Bearer client-secret',
    });
    delete process.env.LANGFUSE_CLIENT_ID;
    delete process.env.LANGFUSE_CLIENT_SECRET;
  });

  it('drops headers that control request framing', async () => {
    delete process.env.TENANT_ISOLATION_STRICT;
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-env';
    process.env.LANGFUSE_SECRET_KEY = 'sk-env';
    process.env.LANGFUSE_BASE_URL = 'https://langfuse.internal';
    const { buildLangfuseConfig } = await import('./config');

    const built = buildLangfuseConfig({
      runId: 'run-1',
      appConfig: {
        langfuse: {
          headers: {
            'Transfer-Encoding': 'chunked',
            'content-length': '42',
            Host: 'elsewhere.example',
            'X-Valid': 'kept',
          },
        },
      } as unknown as AppConfig,
    }) as { additionalHeaders?: Record<string, string> };

    /** One of these on the shared map breaks every request the map is attached
     *  to, rather than being ignored for that header. */
    expect(built.additionalHeaders).toEqual({ 'X-Valid': 'kept' });
  });

  it('omits headers entirely when none are configured', async () => {
    delete process.env.TENANT_ISOLATION_STRICT;
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-env';
    process.env.LANGFUSE_SECRET_KEY = 'sk-env';
    const { buildLangfuseConfig } = await import('./config');

    expect(
      buildLangfuseConfig({
        runId: 'run-1',
        appConfig: { langfuse: { headers: {} } } as unknown as AppConfig,
      }),
    ).not.toHaveProperty('additionalHeaders');
  });
});
