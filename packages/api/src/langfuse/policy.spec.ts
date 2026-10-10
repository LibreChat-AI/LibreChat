const envKeys = [
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_TRACING_ENABLED',
  'LANGFUSE_SAMPLE_RATE',
  'LANGFUSE_FANOUT_ENABLED',
  'LANGFUSE_FANOUT_COLLECTOR_URL',
  'LANGFUSE_FANOUT_TENANT_EXPORT_DISABLED',
  'TENANT_ISOLATION_STRICT',
  'LANGFUSE_PROMPT_SYNC_AVAILABLE',
  'LANGFUSE_PROMPT_SYNC_TIMEOUT_MS',
];

function clearEnv() {
  for (const key of envKeys) {
    delete process.env[key];
  }
}

describe('Langfuse policy', () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it('offers connection settings by default in single-tenant deployments', async () => {
    const { isLangfuseConnectionAvailable } = await import('./policy');

    expect(isLangfuseConnectionAvailable()).toBe(true);
  });

  it('hides single-tenant settings when environment credentials own the connection', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-env';
    process.env.LANGFUSE_SECRET_KEY = 'sk-env';
    const { isLangfuseConnectionAvailable } = await import('./policy');

    expect(isLangfuseConnectionAvailable()).toBe(false);
  });

  it('does not hide settings for incomplete environment credentials', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-env';
    const { isLangfuseConnectionAvailable } = await import('./policy');

    expect(isLangfuseConnectionAvailable()).toBe(true);
  });

  it('requires fanout in strict multi-tenant deployments', async () => {
    process.env.TENANT_ISOLATION_STRICT = 'true';
    const { isLangfuseConnectionAvailable } = await import('./policy');

    expect(isLangfuseConnectionAvailable()).toBe(false);

    process.env.LANGFUSE_FANOUT_ENABLED = 'true';
    process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://collector:4318';
    expect(isLangfuseConnectionAvailable()).toBe(true);
  });

  it('uses explicit fanout routing without requiring strict tenant isolation', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-central';
    process.env.LANGFUSE_SECRET_KEY = 'sk-central';
    process.env.LANGFUSE_FANOUT_ENABLED = 'true';
    process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://collector:4318';
    const { isLangfuseConnectionAvailable, usesLangfuseMultiTenantRouting } = await import(
      './policy'
    );

    expect(usesLangfuseMultiTenantRouting()).toBe(true);
    expect(isLangfuseConnectionAvailable()).toBe(true);
  });

  it('hides fanout connection settings when tenant export is emergency-disabled', async () => {
    process.env.LANGFUSE_FANOUT_ENABLED = 'true';
    process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://collector:4318';
    process.env.LANGFUSE_FANOUT_TENANT_EXPORT_DISABLED = 'true';
    const { isLangfuseConnectionAvailable, isLangfuseFanoutEnabled } = await import('./policy');

    expect(isLangfuseFanoutEnabled()).toBe(true);
    expect(isLangfuseConnectionAvailable()).toBe(false);
  });

  it('does not apply the fanout emergency switch to single-tenant connections', async () => {
    process.env.LANGFUSE_FANOUT_TENANT_EXPORT_DISABLED = 'true';
    const { isLangfuseConnectionAvailable } = await import('./policy');

    expect(isLangfuseConnectionAvailable()).toBe(true);
  });

  it.each(['false', '0', 'no', 'off'])(
    'hides settings when tracing is disabled with %s',
    async (value) => {
      process.env.LANGFUSE_TRACING_ENABLED = value;
      const { isLangfuseConnectionAvailable } = await import('./policy');

      expect(isLangfuseConnectionAvailable()).toBe(false);
    },
  );

  it('hides settings when the sample rate is zero', async () => {
    process.env.LANGFUSE_SAMPLE_RATE = '0';
    const { isLangfuseConnectionAvailable } = await import('./policy');

    expect(isLangfuseConnectionAvailable()).toBe(false);
  });

  it('samples traces deterministically at fractional sample rates', async () => {
    process.env.LANGFUSE_SAMPLE_RATE = '0.5';
    const { isLangfuseTraceSampled } = await import('./policy');

    expect(isLangfuseTraceSampled('86d413435f8b0d7f32d4d010ce769e2e')).toBe(true);
    expect(isLangfuseTraceSampled('658f74b0a232417fc3e6e4d9ef5f563a')).toBe(false);
  });

  it('clamps numeric sample rates and preserves tracing for invalid values', async () => {
    const { getLangfuseSampleRate } = await import('./policy');

    process.env.LANGFUSE_SAMPLE_RATE = '-1';
    expect(getLangfuseSampleRate()).toBe(0);

    process.env.LANGFUSE_SAMPLE_RATE = '2';
    expect(getLangfuseSampleRate()).toBe(1);

    process.env.LANGFUSE_SAMPLE_RATE = 'invalid';
    expect(getLangfuseSampleRate()).toBe(1);
  });

  it('hides Langfuse prompt sync by default', async () => {
    const { isLangfusePromptSyncAvailable } = await import('./policy');

    expect(isLangfusePromptSyncAvailable()).toBe(false);
  });

  it('makes Langfuse prompt sync available when the environment switch is on', async () => {
    process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
    const { isLangfusePromptSyncAvailable } = await import('./policy');

    expect(isLangfusePromptSyncAvailable()).toBe(true);
  });

  it('hides Langfuse prompt sync when the environment switch is explicitly off', async () => {
    process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'false';
    const { isLangfusePromptSyncAvailable } = await import('./policy');

    expect(isLangfusePromptSyncAvailable()).toBe(false);
  });

  it('defaults the Langfuse prompt sync timeout to 10 seconds', async () => {
    const { getLangfusePromptSyncTimeoutMs } = await import('./policy');

    expect(getLangfusePromptSyncTimeoutMs()).toBe(10000);
  });

  it('uses a configured Langfuse prompt sync timeout', async () => {
    process.env.LANGFUSE_PROMPT_SYNC_TIMEOUT_MS = '5000';
    const { getLangfusePromptSyncTimeoutMs } = await import('./policy');

    expect(getLangfusePromptSyncTimeoutMs()).toBe(5000);
  });

  it('clamps the Langfuse prompt sync timeout to 1000-60000', async () => {
    const { getLangfusePromptSyncTimeoutMs } = await import('./policy');

    process.env.LANGFUSE_PROMPT_SYNC_TIMEOUT_MS = '1';
    expect(getLangfusePromptSyncTimeoutMs()).toBe(1000);

    process.env.LANGFUSE_PROMPT_SYNC_TIMEOUT_MS = '1000000';
    expect(getLangfusePromptSyncTimeoutMs()).toBe(60000);
  });

  it('falls back to the default Langfuse prompt sync timeout for non-numeric values', async () => {
    process.env.LANGFUSE_PROMPT_SYNC_TIMEOUT_MS = 'invalid';
    const { getLangfusePromptSyncTimeoutMs } = await import('./policy');

    expect(getLangfusePromptSyncTimeoutMs()).toBe(10000);
  });
});
