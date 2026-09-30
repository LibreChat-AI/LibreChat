import type { TenantScope } from '~/tenant/policy';
import { resolveTenantScope } from '~/tenant/policy';

/**
 * Escapes backslashes and double quotes in MeiliSearch string filter values.
 */
export const escapeMeiliFilterValue = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/**
 * Builds a MeiliSearch filter for the given user under the active tenant scope.
 *
 * Scoped tenants get `user = "..." AND tenantId = "..."` so cross-tenant hits
 * cannot fill the result budget. System and unscoped contexts keep the
 * user-only filter. Under `TENANT_ISOLATION_STRICT`, a missing tenant context
 * fails closed via `resolveTenantScope`.
 *
 * Active-tenant search matches only documents with that exact `tenantId`.
 * Legacy tenantless Meili documents are excluded until they are migrated into
 * a tenant context and reindexed at schema version 2+.
 */
export function buildMeiliUserTenantFilter(
  user: string,
  operation = 'MeiliSearch',
  scope: TenantScope = resolveTenantScope(operation),
): string {
  const userFilter = `user = "${escapeMeiliFilterValue(user)}"`;
  if (scope.kind !== 'scoped') {
    return userFilter;
  }
  return `${userFilter} AND tenantId = "${escapeMeiliFilterValue(scope.tenantId)}"`;
}
