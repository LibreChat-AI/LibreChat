import type { AnyBulkWriteOperation, Model, MongooseBulkWriteOptions } from 'mongoose';
import type { BulkWriteResult } from 'mongodb';
import type { TenantScope, TenantUpdate } from '~/tenant/policy';
import {
  resolveTenantScope,
  resetTenantStrictCache,
  sanitizeTenantMutation,
  isTenantIsolationStrict,
} from '~/tenant/policy';
import logger from '~/config/winston';

/** Resets the cached strict-mode flag. Exposed for test teardown only. */
export function _resetBulkWriteStrictCache(): void {
  resetTenantStrictCache();
}

/**
 * Tenant-safe wrapper around Mongoose `Model.bulkWrite()`.
 *
 * Mongoose's `bulkWrite` does not trigger schema-level middleware hooks, so the
 * `applyTenantIsolation` plugin cannot intercept it. This wrapper:
 *
 * 1. **Sanitizes** every update document by stripping `tenantId` unconditionally
 *    (both top-level and inside `$set`/`$unset`/`$setOnInsert`/`$rename`).
 * 2. **Injects** `tenantId` into operation filters and insert documents when a
 *    tenant context is active.
 *
 * Unlike the query middleware, which throws on cross-tenant values, this wrapper
 * strips silently (`strip` mode). Throwing mid-batch would abort the entire write
 * for one bad field; the filter injection already scopes every operation to the
 * correct tenant.
 *
 * Behavior:
 * - **tenantId present** (normal request): sanitize + inject into filters/documents.
 * - **SYSTEM_TENANT_ID**: sanitize only, skip injection (cross-tenant system op).
 * - **No tenantId + strict mode**: throws (fail-closed, same as the plugin).
 * - **No tenantId + non-strict**: sanitize only, no injection (backward compat).
 */
export async function tenantSafeBulkWrite<T>(
  model: Model<T>,
  ops: AnyBulkWriteOperation[],
  options?: MongooseBulkWriteOptions,
): Promise<BulkWriteResult> {
  const scope = resolveTenantScope(`bulkWrite on ${model.modelName}`);

  // Strip tenantId from update documents unconditionally — application code
  // must never control tenantId via update payloads regardless of context.
  const sanitized = ops
    .map((op) => sanitizeBulkOp(op, scope))
    .filter((op): op is AnyBulkWriteOperation => op != null);

  const prepared =
    scope.kind === 'scoped' ? sanitized.map((op) => injectTenantId(op, scope.tenantId)) : sanitized;

  return prepared.length > 0 ? model.bulkWrite(prepared, options) : EMPTY_BULK_RESULT;
}

/** Returned when all ops are dropped after sanitization. Single shared instance. */
const EMPTY_BULK_RESULT = Object.freeze({
  insertedCount: 0,
  matchedCount: 0,
  modifiedCount: 0,
  deletedCount: 0,
  upsertedCount: 0,
  upsertedIds: {},
  insertedIds: {},
}) as unknown as BulkWriteResult;

/** Strips tenantId from update documents. Returns null if the op becomes empty. */
function sanitizeBulkOp(
  op: AnyBulkWriteOperation,
  scope: TenantScope,
): AnyBulkWriteOperation | null {
  if ('updateOne' in op) {
    const { update, ...rest } = op.updateOne;
    const result = sanitizeTenantMutation(scope, update as TenantUpdate, 'strip');
    return result.emptied ? null : { updateOne: { ...rest, update: result.update } };
  }

  if ('updateMany' in op) {
    const { update, ...rest } = op.updateMany;
    const result = sanitizeTenantMutation(scope, update as TenantUpdate, 'strip');
    return result.emptied ? null : { updateMany: { ...rest, update: result.update } };
  }

  return op;
}

/**
 * Injects tenantId into every operation's filter and document.
 * Assumes update payloads have already been sanitized by `sanitizeBulkOp`.
 * Returns a new operation object — does not mutate the original.
 */
function injectTenantId(op: AnyBulkWriteOperation, tenantId: string): AnyBulkWriteOperation {
  if ('insertOne' in op) {
    return { insertOne: { document: { ...op.insertOne.document, tenantId } } };
  }

  if ('updateOne' in op) {
    const { filter, ...rest } = op.updateOne;
    return { updateOne: { ...rest, filter: { ...filter, tenantId } } };
  }

  if ('updateMany' in op) {
    const { filter, ...rest } = op.updateMany;
    return { updateMany: { ...rest, filter: { ...filter, tenantId } } };
  }

  if ('deleteOne' in op) {
    const { filter, ...rest } = op.deleteOne;
    return { deleteOne: { ...rest, filter: { ...filter, tenantId } } };
  }

  if ('deleteMany' in op) {
    const { filter, ...rest } = op.deleteMany;
    return { deleteMany: { ...rest, filter: { ...filter, tenantId } } };
  }

  if ('replaceOne' in op) {
    const { filter, replacement, ...rest } = op.replaceOne;
    return {
      replaceOne: {
        ...rest,
        filter: { ...filter, tenantId },
        replacement: { ...replacement, tenantId },
      },
    };
  }

  if (isTenantIsolationStrict()) {
    throw new Error(
      '[TenantIsolation] Unknown bulkWrite operation type in strict mode — refusing to pass through without tenant injection',
    );
  }
  logger.warn(
    '[tenantSafeBulkWrite] Unknown bulk op type, passing through without tenant injection',
  );
  return op;
}
