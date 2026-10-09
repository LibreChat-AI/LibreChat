import {
  tenantStorage,
  getUserId,
  getRequestId,
  runAsSystem,
  scopedCacheKey,
} from './tenantContext';

describe('scopedCacheKey', () => {
  it('returns base key when no ALS context is set', () => {
    expect(scopedCacheKey('MODELS_CONFIG')).toBe('MODELS_CONFIG');
  });

  it('returns base key in SYSTEM_TENANT_ID context', async () => {
    await runAsSystem(async () => {
      expect(scopedCacheKey('MODELS_CONFIG')).toBe('MODELS_CONFIG');
    });
  });

  it('appends tenantId when tenant context is active', async () => {
    await tenantStorage.run({ tenantId: 'acme' }, async () => {
      expect(scopedCacheKey('MODELS_CONFIG')).toBe('MODELS_CONFIG:acme');
    });
  });

  it('does not leak tenant context outside ALS scope', async () => {
    await tenantStorage.run({ tenantId: 'acme' }, async () => {
      expect(scopedCacheKey('KEY')).toBe('KEY:acme');
    });
    expect(scopedCacheKey('KEY')).toBe('KEY');
  });

  it('reads user and request IDs from ALS context', async () => {
    await tenantStorage.run({ userId: 'user-1', requestId: 'req-1' }, async () => {
      expect(getUserId()).toBe('user-1');
      expect(getRequestId()).toBe('req-1');
    });
  });

  it('preserves user and request context inside system tenant operations', async () => {
    await tenantStorage.run(
      { tenantId: 'acme', userId: 'user-1', requestId: 'req-1' },
      async () => {
        await runAsSystem(async () => {
          expect(getUserId()).toBe('user-1');
          expect(getRequestId()).toBe('req-1');
          expect(scopedCacheKey('KEY')).toBe('KEY');
        });
      },
    );
  });
});
