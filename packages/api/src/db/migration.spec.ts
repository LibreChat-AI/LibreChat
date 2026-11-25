import { getTenantId, runAsSystem, tenantStorage, SYSTEM_TENANT_ID } from '@librechat/data-schemas';
import { runResourceMigration } from './migration';

it.each([undefined, null, '', 'tenant-a'])(
  'writes in the resource partition and restores the outer context (%s)',
  async (tenantId) => {
    await runAsSystem(async () => {
      const result = await runResourceMigration({ tenantId }, async () => {
        await Promise.resolve();
        return getTenantId();
      });
      expect(result).toBe(tenantId || SYSTEM_TENANT_ID);
      expect(getTenantId()).toBe(SYSTEM_TENANT_ID);
    });
    expect(getTenantId()).toBeUndefined();
  },
);

it('preserves tracing metadata and restores context on failure', async () => {
  await tenantStorage.run({ tenantId: 'tenant-a', requestId: 'migration' }, async () => {
    await expect(
      runResourceMigration({ tenantId: 'tenant-b' }, async () => {
        expect(tenantStorage.getStore()).toEqual({ tenantId: 'tenant-b', requestId: 'migration' });
        throw new Error('Write failed');
      }),
    ).rejects.toThrow('Write failed');
    expect(getTenantId()).toBe('tenant-a');
  });
});
