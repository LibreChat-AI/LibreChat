import { responseReference, isReservedTenantId, SYSTEM_TENANT_ID } from '@librechat/data-schemas';
import type { StoredResponseRecord } from '@librechat/data-schemas';

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

/** Same metadata-only physical binding in worker tokens, queue fingerprints and jobs. */
export function responseRootBinding(
  record: Pick<StoredResponseRecord, 'userId' | 'tenantId' | 'responseId' | 'storageTarget'>,
): { responseRootId: string; responseRootIncarnation: string } {
  const { target } = responseReference(record);
  return { responseRootId: target.id, responseRootIncarnation: target.incarnation };
}
export function matchesResponseRoot(
  record: Pick<StoredResponseRecord, 'storageTarget'>,
  binding: { responseRootId?: string; responseRootIncarnation?: string },
): boolean {
  return (
    !!record.storageTarget &&
    record.storageTarget.id === binding.responseRootId &&
    record.storageTarget.incarnation === binding.responseRootIncarnation
  );
}
