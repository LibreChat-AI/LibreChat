/**
 * ClickHouse scope rendering — the per-store half of PLAN "Multi-tenancy and
 * scope safety".
 *
 * The scope VALUE is resolved once, in `@librechat/data-schemas`
 * (`config/tenantContext.ts`), and is shared by every tier. This module renders
 * that value into ClickHouse `{name:Type}` bindings and does nothing else: it
 * performs no resolution, no normalization, and no validation of its own beyond
 * the brand gate the shared core provides. The PostgreSQL tier renders the same
 * value into `$n` predicates and RLS GUCs in `search/scope.ts`. Neither tier
 * re-derives scope, so the two cannot drift.
 *
 * What this file DOES own is the record `kind`, which is a chat-search concept
 * and a ClickHouse column rather than a property of the principal.
 *
 * ClickHouse has no row-level security. The predicate below is the entire fence.
 */
import { assertScope, UnscopedAccessError } from '@librechat/data-schemas';
import type { Scope } from '@librechat/data-schemas';
import type { ClickHouseParam, HistoryKind } from './types';

const VALID_KINDS: readonly HistoryKind[] = ['message', 'conversation', 'shared-link'];

/**
 * Every kind this tier serves is USER-scoped, not merely tenant-scoped.
 * Messages and conversations are content-bearing — leaking them exposes raw
 * text rather than metadata. Shared links are scoped to the OWNER because this
 * is the owner's management view; public share consumption is a separate route
 * that never reaches this module and must not be conflated with it.
 */
export const SCOPE_PREDICATE_SQL =
  'tenant_id = {tenant_id:String}\n    AND user_id = {user_id:String}\n    AND kind = {kind:String}';

export type ScopePredicate = Readonly<{
  predicateSql: string;
  params: Readonly<Record<string, ClickHouseParam>>;
  tenantId: string;
  userId: string;
  kind: HistoryKind;
}>;

/**
 * Renders the one predicate every arm shares. `assertScope` rejects an absent or
 * forged scope; an unknown kind is rejected here. Both throw rather than
 * widening, so a query builder cannot reach ClickHouse without a full predicate.
 */
export function renderScopePredicate(scope: Scope, kind: HistoryKind): ScopePredicate {
  const resolved = assertScope(scope);

  if (!VALID_KINDS.includes(kind)) {
    throw new UnscopedAccessError('kind is missing or not a searchable record kind');
  }

  return {
    predicateSql: SCOPE_PREDICATE_SQL,
    params: { tenant_id: resolved.tenantId, user_id: resolved.userId, kind },
    tenantId: resolved.tenantId,
    userId: resolved.userId,
    kind,
  };
}
