import { getTenantId, tenantStorage, SYSTEM_TENANT_ID } from '@librechat/data-schemas';
import type { ConfigRecord } from '@librechat/data-schemas';

/**
 * The tenant partitions the admin config API reads and judges in. The config store addresses
 * role documents (whose ids are names every tenant reuses) in the active partition, and group
 * and user documents by id, so an admin without a tenant reaches a tenant's group or user
 * profile. Such a profile merges in its own tenant: librechat.yaml as that tenant resolves it,
 * that tenant's `__base__`, and, for a user, that tenant's roles and groups. Reads and writes
 * of it run there (`runInPartition`); the partition rules themselves stay the store's.
 */

/** The tenant partition a stored document belongs to; `null` and `''` are tenantless. */
export function getConfigPartition(record: Pick<ConfigRecord, 'tenantId'>): string | undefined {
  return record.tenantId || undefined;
}

/**
 * The partition the config store reads and writes role documents in for this request
 * (`tenantPartition`): the active tenant's, or the deployment's own outside a tenant and under
 * the system context.
 */
export function getActivePartition(): string | undefined {
  const tenantId = getTenantId();
  return tenantId && tenantId !== SYSTEM_TENANT_ID ? tenantId : undefined;
}

/**
 * Runs `read` in tenant partition `tenantId` (`undefined`: the deployment's own): in the
 * request's own context when that is the partition, otherwise in that tenant's context, so every
 * store read it makes lands there. Only a request outside a tenant moves: inside one, leaving it
 * would read another tenant, or with `undefined` no tenant context at all, which the tenant plugin
 * scopes to nothing outside strict mode, so that rejects. Capability checks never run inside it:
 * they judge the caller, in the caller's own tenant.
 */
export function runInPartition<T>(
  tenantId: string | undefined,
  read: () => Promise<T>,
): Promise<T> {
  const active = getActivePartition();
  if (tenantId === active) {
    return read();
  }
  if (active !== undefined) {
    return Promise.reject(
      new Error('[runInPartition] A read cannot leave the active tenant partition'),
    );
  }
  return tenantStorage.run({ ...tenantStorage.getStore(), tenantId }, read);
}
