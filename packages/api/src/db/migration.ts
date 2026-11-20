import { tenantStorage, SYSTEM_TENANT_ID } from '@librechat/data-schemas';

/** Deploy-wide migrations read as system but write in each resource's partition. */
export function runResourceMigration<T>(
  resource: { tenantId?: string | null },
  migrate: () => Promise<T>,
): Promise<T> {
  return tenantStorage.run(
    { ...tenantStorage.getStore(), tenantId: resource.tenantId || SYSTEM_TENANT_ID },
    async () => migrate(),
  );
}
