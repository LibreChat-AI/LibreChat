describe('violationCache TTL defaults', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.USE_REDIS;
    delete process.env.REDIS_URI;
    delete process.env.VIOLATION_SCORE_TTL;
    jest.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.resetModules();
  });

  test('applies the default violation score TTL when none is given', async () => {
    const { violationCache } = await import('../../cacheFactory');
    const cache = violationCache('logins');

    expect(cache.opts.ttl).toBe(3600000);
    expect(cache.opts.namespace).toBe('violations:logins');
  });

  test('an explicit TTL overrides the default', async () => {
    const { violationCache } = await import('../../cacheFactory');
    const cache = violationCache('logins', 60000);

    expect(cache.opts.ttl).toBe(60000);
  });

  test('honors VIOLATION_SCORE_TTL from the environment', async () => {
    process.env.VIOLATION_SCORE_TTL = '1000 * 60 * 5';

    const { violationCache } = await import('../../cacheFactory');
    expect(violationCache('concurrent').opts.ttl).toBe(300000);
  });

  test('VIOLATION_SCORE_TTL=0 disables expiry', async () => {
    process.env.VIOLATION_SCORE_TTL = '0';

    const { violationCache } = await import('../../cacheFactory');
    expect(violationCache('concurrent').opts.ttl).toBeUndefined();
  });

  test('expires violation entries once the TTL elapses', async () => {
    const { violationCache } = await import('../../cacheFactory');
    const cache = violationCache('expiry-check', 500);

    await cache.set('user-1', 3);
    await expect(cache.get('user-1')).resolves.toBe(3);

    await new Promise((resolve) => setTimeout(resolve, 800));
    await expect(cache.get('user-1')).resolves.toBeUndefined();
  });
});
