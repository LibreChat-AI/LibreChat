import { isReservedTenantId, SYSTEM_TENANT_ID } from '@librechat/data-schemas';

/** Legacy persisted tenantless rows use missing, null or empty values. */
export function responseTenantId(value: string | null | undefined): string | undefined {
  return value || undefined;
}

/** Internal partition sentinels never acquire response execution authority. */
export function isResponseTenantId(value: unknown): value is string | null | undefined {
  return (
    value == null ||
    (typeof value === 'string' && value !== SYSTEM_TENANT_ID && !isReservedTenantId(value))
  );
}
