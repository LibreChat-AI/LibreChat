import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import logger from '~/config/winston';

/**
 * Engine-neutral tenant-isolation policy.
 *
 * Every rule that decides what tenant scoping means lives here as a pure
 * function over plain objects. Storage engines bind these rules to their own
 * query surface (see `~/models/plugins/tenantIsolation` for the Mongoose
 * binding); no rule in this module may reference an engine's types.
 */

/** Resolved tenant scope for the current async context. */
export type TenantScope =
  | { readonly kind: 'scoped'; readonly tenantId: string }
  | { readonly kind: 'system' }
  | { readonly kind: 'unscoped' };

/** A document-shaped payload the policy may stamp or inspect. */
export type TenantDocument = Record<string, unknown> & { tenantId?: unknown };

/** An update payload expressed with MongoDB-style mutation operators. */
export type TenantUpdate = Record<string, unknown>;

/**
 * How a payload carrying `tenantId` is handled.
 *
 * - `guard` — a cross-tenant value throws; a matching value is stripped.
 * - `strip` — every value is stripped silently, never throws.
 */
export type TenantMutationMode = 'guard' | 'strip';

export class TenantIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantIsolationError';
  }
}

const SYSTEM_SCOPE: TenantScope = { kind: 'system' };
const UNSCOPED: TenantScope = { kind: 'unscoped' };

const VALUE_OPERATORS = ['$set', '$setOnInsert'] as const;
const STRIP_OPERATORS = ['$unset', '$rename'] as const;

let strictMode: boolean | undefined;

/** True when `TENANT_ISOLATION_STRICT=true`, i.e. missing context fails closed. */
export function isTenantIsolationStrict(): boolean {
  return (strictMode ??= process.env.TENANT_ISOLATION_STRICT === 'true');
}

/** Resets the cached strict-mode flag. Exposed for test teardown only. */
export function resetTenantStrictCache(): void {
  strictMode = undefined;
}

export function warnOnInvalidStrictSetting(): void {
  const raw = process.env.TENANT_ISOLATION_STRICT;
  if (raw && raw !== 'true' && raw !== 'false') {
    logger.warn(
      `[TenantIsolation] TENANT_ISOLATION_STRICT="${raw}" ` +
        'is not "true" or "false"; defaulting to non-strict mode.',
    );
  }
}

/**
 * Reads the tenant scope without enforcing strict mode.
 * Use for guards that run after a scoping check has already fired.
 */
export function currentTenantScope(): TenantScope {
  const tenantId = getTenantId();
  if (!tenantId) {
    return UNSCOPED;
  }
  if (tenantId === SYSTEM_TENANT_ID) {
    return SYSTEM_SCOPE;
  }
  return { kind: 'scoped', tenantId };
}

/**
 * Reads the tenant scope, failing closed when strict mode is on and no
 * context is active. `operation` names the caller in the thrown message.
 */
export function resolveTenantScope(operation: string): TenantScope {
  const scope = currentTenantScope();
  if (scope.kind === 'unscoped' && isTenantIsolationStrict()) {
    throw new TenantIsolationError(
      `[TenantIsolation] ${operation} attempted without tenant context in strict mode`,
    );
  }
  return scope;
}

/** The filter fragment that restricts reads and writes to the active tenant. */
export function tenantFilter(scope: TenantScope): { tenantId: string } | undefined {
  return scope.kind === 'scoped' ? { tenantId: scope.tenantId } : undefined;
}

/** Result of sanitizing an update payload against the active scope. */
export interface TenantMutationResult {
  /** The payload to send to the engine — the input itself when nothing changed. */
  readonly update: TenantUpdate;
  /** True when sanitizing removed every remaining instruction. */
  readonly emptied: boolean;
  /** True when the payload differs from the input and must be written back. */
  readonly changed: boolean;
}

/**
 * Removes caller-supplied `tenantId` from an update payload — top level and
 * inside mutation operators. Application code never controls `tenantId`.
 *
 * `guard` mode leaves system-scoped payloads untouched: a deliberate
 * cross-tenant operation is the one caller allowed to set `tenantId`.
 * `strip` mode ignores the scope and always strips.
 *
 * Copy-on-write: the input is never mutated, and the same reference is
 * returned when there was nothing to strip.
 */
export function sanitizeTenantMutation(
  scope: TenantScope,
  update: TenantUpdate | null | undefined,
  mode: TenantMutationMode,
): TenantMutationResult {
  if (!update) {
    return { update: {}, emptied: false, changed: false };
  }

  if (mode === 'guard' && scope.kind === 'system') {
    return { update, emptied: false, changed: false };
  }

  let next: TenantUpdate | null = null;
  const draft = (): TenantUpdate => (next ??= { ...update });

  for (const operator of VALUE_OPERATORS) {
    const payload = update[operator] as Record<string, unknown> | undefined;
    if (!payload || !('tenantId' in payload)) {
      continue;
    }
    assertSameTenant(scope, payload.tenantId, mode);
    const { tenantId: _stripped, ...rest } = payload;
    writeOperator(draft(), operator, rest);
  }

  for (const operator of STRIP_OPERATORS) {
    const payload = update[operator] as Record<string, unknown> | undefined;
    if (!payload || !('tenantId' in payload)) {
      continue;
    }
    const { tenantId: _stripped, ...rest } = payload;
    writeOperator(draft(), operator, rest);
  }

  if ('tenantId' in update) {
    assertSameTenant(scope, update.tenantId, mode);
    delete draft().tenantId;
  }

  const result = next ?? update;
  return {
    update: result,
    emptied: Object.keys(result).length === 0,
    changed: next != null,
  };
}

function writeOperator(
  target: TenantUpdate,
  operator: string,
  rest: Record<string, unknown>,
): void {
  if (Object.keys(rest).length === 0) {
    delete target[operator];
    return;
  }
  target[operator] = rest;
}

function assertSameTenant(scope: TenantScope, value: unknown, mode: TenantMutationMode): void {
  if (mode === 'strip') {
    return;
  }
  if (scope.kind === 'scoped' && value !== scope.tenantId) {
    throw new TenantIsolationError(
      '[TenantIsolation] Cross-tenant tenantId mutation is not allowed',
    );
  }
}

/**
 * Validates a whole-document replacement and stamps the active tenant onto it.
 *
 * Copy-on-write, like `sanitizeTenantMutation`. A replacement that names any
 * tenant other than the active one is refused — including when no context is
 * active, where no `tenantId` may be asserted at all.
 */
export function scopeReplacement(
  scope: TenantScope,
  replacement: TenantDocument | null | undefined,
): { readonly replacement: TenantDocument | null; readonly changed: boolean } {
  if (!replacement || scope.kind === 'system') {
    return { replacement: replacement ?? null, changed: false };
  }

  const tenantId = scope.kind === 'scoped' ? scope.tenantId : undefined;

  if ('tenantId' in replacement && replacement.tenantId !== tenantId) {
    throw new TenantIsolationError(
      '[TenantIsolation] Modifying tenantId via replacement is not allowed',
    );
  }

  if (tenantId && !('tenantId' in replacement)) {
    return { replacement: { ...replacement, tenantId }, changed: true };
  }

  return { replacement, changed: false };
}

/**
 * The predicate a `save()` must carry for an already-persisted document, which
 * would otherwise be filtered on identity alone.
 *
 * The legacy alternatives make pre-tenancy rows claimable while keeping the
 * claim atomic: once one tenant stamps the row, another tenant's save no longer
 * matches. `tenantIdModified` reflects caller changes before the save hook
 * stamps a legacy row.
 */
export function tenantWritePredicate(
  scope: TenantScope,
  tenantIdModified: boolean,
  tenantId: unknown,
): { tenantId: { $in: [string, null, ''] } } | undefined {
  if (
    tenantIdModified &&
    scope.kind !== 'system' &&
    (scope.kind !== 'scoped' || tenantId !== scope.tenantId)
  ) {
    throw new TenantIsolationError(
      '[TenantIsolation] Cross-tenant tenantId mutation is not allowed',
    );
  }
  if (scope.kind !== 'scoped') {
    return undefined;
  }
  return { tenantId: { $in: [scope.tenantId, null, ''] } };
}

/**
 * Stamps the active tenant onto a document being inserted.
 *
 * A document that already names a different tenant is refused in strict mode
 * and passed through otherwise, preserving pre-tenancy backfill behaviour.
 * Mutates in place — insert paths own the documents they hand us.
 */
export function stampTenantOnDocument(scope: TenantScope, document: TenantDocument): void {
  if (scope.kind !== 'scoped') {
    return;
  }
  if (!document.tenantId) {
    document.tenantId = scope.tenantId;
    return;
  }
  if (isTenantIsolationStrict() && document.tenantId !== scope.tenantId) {
    throw new TenantIsolationError(
      '[TenantIsolation] Document tenantId does not match current tenant context',
    );
  }
}
