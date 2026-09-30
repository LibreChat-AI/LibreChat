import {
  TenantIsolationError,
  resetTenantStrictCache,
} from '~/tenant/policy';
import {
  escapeMeiliFilterValue,
  buildMeiliUserTenantFilter,
} from './search';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';

describe('escapeMeiliFilterValue', () => {
  it('escapes quotes and backslashes in filter values', () => {
    expect(escapeMeiliFilterValue('user123')).toBe('user123');
    expect(escapeMeiliFilterValue('user"123')).toBe('user\\"123');
    expect(escapeMeiliFilterValue('user\\123')).toBe('user\\\\123');
    expect(escapeMeiliFilterValue('user\\"123')).toBe('user\\\\\\"123');
  });
});

describe('buildMeiliUserTenantFilter', () => {
  const originalStrict = process.env.TENANT_ISOLATION_STRICT;

  afterEach(() => {
    if (originalStrict === undefined) {
      delete process.env.TENANT_ISOLATION_STRICT;
    } else {
      process.env.TENANT_ISOLATION_STRICT = originalStrict;
    }
    resetTenantStrictCache();
  });

  it('scopes the filter to the active tenant and escapes values', async () => {
    await tenantStorage.run({ tenantId: 'tenant"\\id' }, () => {
      expect(buildMeiliUserTenantFilter('user"\\id')).toBe(
        'user = "user\\"\\\\id" AND tenantId = "tenant\\"\\\\id"',
      );
    });
  });

  it('keeps the user-only filter in system and tenantless contexts', async () => {
    await runAsSystem(async () => {
      expect(buildMeiliUserTenantFilter('user123')).toBe('user = "user123"');
    });
    expect(buildMeiliUserTenantFilter('user123')).toBe('user = "user123"');
  });

  it('fails closed under TENANT_ISOLATION_STRICT without tenant context', () => {
    process.env.TENANT_ISOLATION_STRICT = 'true';
    resetTenantStrictCache();
    expect(() => buildMeiliUserTenantFilter('user123')).toThrow(TenantIsolationError);
  });
});
