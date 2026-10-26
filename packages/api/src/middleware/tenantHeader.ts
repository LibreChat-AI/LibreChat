import { SYSTEM_TENANT_ID } from '@librechat/data-schemas';

const MAX_TENANT_ID_LENGTH = 128;
const VALID_TENANT_ID = /^[-a-zA-Z0-9_.]+$/;

/**
 * Why a trusted `X-Tenant-Id` value names no tenant: the system sentinel, or a value that is
 * too long or carries characters outside the tenant id alphabet. `undefined` accepts it.
 */
export function rejectTenantHeader(tenantId: string): 'system' | 'malformed' | undefined {
  if (tenantId === SYSTEM_TENANT_ID) {
    return 'system';
  }
  if (tenantId.length > MAX_TENANT_ID_LENGTH || !VALID_TENANT_ID.test(tenantId)) {
    return 'malformed';
  }
  return undefined;
}
