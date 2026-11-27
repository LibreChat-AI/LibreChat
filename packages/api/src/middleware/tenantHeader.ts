import { tenantIdSchema } from 'librechat-data-provider';
import { SYSTEM_TENANT_ID, isReservedTenantId } from '@librechat/data-schemas';

/**
 * Why a trusted `X-Tenant-Id` value names no tenant: a reserved persistence/system sentinel, or a value that is
 * too long or carries characters outside the tenant id alphabet. `undefined` accepts it.
 */
export function rejectTenantHeader(
  tenantId: string,
): 'system' | 'reserved' | 'malformed' | undefined {
  if (tenantId === SYSTEM_TENANT_ID) {
    return 'system';
  }
  if (isReservedTenantId(tenantId)) return 'reserved';
  if (!tenantIdSchema.safeParse(tenantId).success) {
    return 'malformed';
  }
  return undefined;
}
