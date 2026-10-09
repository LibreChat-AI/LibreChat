import { AsyncLocalStorage } from 'async_hooks';

export interface TenantContext {
  tenantId?: string;
  userId?: string;
  requestId?: string;
  requestMethod?: string;
  requestPath?: string;
}

/** Sentinel value for deliberate cross-tenant system operations */
export const SYSTEM_TENANT_ID = '__SYSTEM__';

/**
 * AsyncLocalStorage instance for propagating tenant context.
 * Callbacks passed to `tenantStorage.run()` must be `async` for the context to propagate
 * through Mongoose query execution. Sync callbacks returning a Mongoose thenable will lose context.
 */
export const tenantStorage: AsyncLocalStorage<TenantContext> =
  new AsyncLocalStorage<TenantContext>();

/** Returns the current tenant ID from async context, or undefined if none is set */
export function getTenantId(): string | undefined {
  return tenantStorage.getStore()?.tenantId;
}

/** Returns the current user ID from async context, or undefined if none is set */
export function getUserId(): string | undefined {
  return tenantStorage.getStore()?.userId;
}

/** Returns the current request ID from async context, or undefined if none is set */
export function getRequestId(): string | undefined {
  return tenantStorage.getStore()?.requestId;
}

/** Returns the safe request method from async context, or undefined if none is set */
export function getRequestMethod(): string | undefined {
  return tenantStorage.getStore()?.requestMethod;
}

/** Returns the safe request path from async context, or undefined if none is set */
export function getRequestPath(): string | undefined {
  return tenantStorage.getStore()?.requestPath;
}

/**
 * Runs a function in an explicit cross-tenant system context (bypasses tenant filtering).
 * The callback MUST be async — sync callbacks returning Mongoose thenables will lose context.
 */
export function runAsSystem<T>(fn: () => Promise<T>): Promise<T> {
  const { requestId, userId, requestMethod, requestPath } = tenantStorage.getStore() ?? {};
  return tenantStorage.run(
    { tenantId: SYSTEM_TENANT_ID, requestId, userId, requestMethod, requestPath },
    fn,
  );
}

/**
 * Appends `:${tenantId}` to a cache key when a non-system tenant context is active.
 * Returns the base key unchanged when no ALS context is set or when running
 * inside `runAsSystem()` (SYSTEM_TENANT_ID context).
 */
export function scopedCacheKey(baseKey: string): string {
  const tenantId = getTenantId();
  if (!tenantId || tenantId === SYSTEM_TENANT_ID) {
    return baseKey;
  }
  return `${baseKey}:${tenantId}`;
}
