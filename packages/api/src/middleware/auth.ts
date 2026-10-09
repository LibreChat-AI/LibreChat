type AuthFailureLike = {
  message?: unknown;
  name?: unknown;
};

type AuthLogValue = string | number | boolean | readonly string[];
type AuthLogHeaderValue = string | string[] | undefined;
type AuthRoutePath = string | RegExp | readonly (string | RegExp)[];

const COMPACT_JWT_VALUE =
  /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*){2}$|^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*){4}$/;
const MAX_REQUEST_ID_LENGTH = 128;
const SAFE_REQUEST_METHODS = new Set([
  'CONNECT',
  'DELETE',
  'GET',
  'HEAD',
  'OPTIONS',
  'PATCH',
  'POST',
  'PUT',
  'TRACE',
]);
const AUTH_LOG_EXTRA_KEYS = new Set([
  'event_name',
  'auth_strategy',
  'primary_strategy',
  'fallback_strategy',
  'fallback_attempted',
  'fallback_succeeded',
  'attempted_strategies',
  'final_strategy',
  'primary_failure_reason_category',
  'reason_category',
  'recovery_classification',
  'response_status',
  'strategy_status',
]);

export type AuthLogRequest = {
  headers?: Record<string, AuthLogHeaderValue>;
  method?: string;
  path?: string;
  originalUrl?: string;
  url?: string;
  baseUrl?: string;
  route?: {
    path?: AuthRoutePath;
  };
  id?: string;
  requestId?: string;
};

export type AuthLogState = {
  tokenProvider?: string | null;
  tokenSource?: string | null;
  openidReuseEnabled: boolean;
  openidJwtAvailable: boolean;
  hasOpenIdReuseUserId: boolean;
};

export type RequestLogContext = {
  request_id?: string;
  request_method?: string;
  request_path?: string;
};

export type AuthLogContext = RequestLogContext & Record<string, AuthLogValue>;

export type AuthFailureReasonCategory =
  | 'expired_jwt'
  | 'malformed_jwt'
  | 'principal_mismatch'
  | 'missing_or_unrecognized_token'
  | 'authentication_error';

function normalizeAuthLogValue(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const normalized = normalizeAuthLogValue(entry);
      if (normalized) {
        return normalized;
      }
    }
    return undefined;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return undefined;
}

function normalizeAuthLogContextValue(value: unknown): AuthLogValue | undefined {
  if (value == null) {
    return undefined;
  }

  if (Array.isArray(value)) {
    const values = value
      .map((entry) => normalizeAuthLogValue(entry))
      .filter((entry): entry is string => entry !== undefined);
    return values.length > 0 ? values : undefined;
  }

  if (typeof value === 'string') {
    return normalizeAuthLogValue(value);
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  return undefined;
}

function getRequestId(req: AuthLogRequest): string | undefined {
  const candidates = [
    req.requestId,
    req.id,
    req.headers?.['x-request-id'],
    req.headers?.['x-correlation-id'],
  ];

  for (const candidate of candidates) {
    const requestId = normalizeAuthLogValue(candidate);
    if (
      requestId &&
      requestId.length <= MAX_REQUEST_ID_LENGTH &&
      !COMPACT_JWT_VALUE.test(requestId) &&
      /^[A-Za-z0-9_.:-]+$/.test(requestId)
    ) {
      return requestId;
    }
  }

  return undefined;
}

function getRequestMethod(method: unknown): string | undefined {
  const normalized = normalizeAuthLogValue(method)?.toUpperCase();
  if (!normalized) {
    return undefined;
  }
  return SAFE_REQUEST_METHODS.has(normalized) ? normalized : 'OTHER';
}

function normalizeRoutePath(path: AuthRoutePath | undefined): string | undefined {
  if (typeof path === 'string') {
    return normalizeAuthLogValue(path);
  }

  if (Array.isArray(path)) {
    for (const entry of path) {
      const normalized = normalizeRoutePath(entry);
      if (normalized) {
        return normalized;
      }
    }
  }

  return undefined;
}

function joinRoutePath(baseUrl: string | undefined, routePath: string): string {
  const normalizedRoute = routePath === '/' ? '' : routePath;
  if (!baseUrl) {
    return normalizedRoute || '/';
  }
  if (!normalizedRoute) {
    return baseUrl;
  }
  return `${baseUrl.replace(/\/$/, '')}/${normalizedRoute.replace(/^\//, '')}`;
}

function bucketConcretePath(path: string | undefined): string | undefined {
  const queryless = path?.split('?')[0];
  if (!queryless) {
    return undefined;
  }

  const segments = queryless.split('/').filter(Boolean);
  if (segments.length === 0) {
    return '/';
  }
  if (segments[0] === 'api' && segments[1]) {
    return `/${segments.slice(0, 2).join('/')}`;
  }
  return `/${segments[0]}`;
}

function getRequestPath(req: AuthLogRequest): string | undefined {
  const baseUrl = bucketConcretePath(normalizeAuthLogValue(req.baseUrl));
  const routePath = normalizeRoutePath(req.route?.path);
  if (routePath && baseUrl) {
    return joinRoutePath(baseUrl, routePath);
  }
  if (baseUrl) {
    return baseUrl;
  }

  const path =
    normalizeAuthLogValue(req.originalUrl) ??
    normalizeAuthLogValue(req.path) ??
    normalizeAuthLogValue(req.url);
  return bucketConcretePath(path);
}

export function buildSafeRequestLogContext(req: AuthLogRequest): RequestLogContext {
  const requestId = getRequestId(req);
  const requestMethod = getRequestMethod(req.method);
  const requestPath = getRequestPath(req);

  return {
    ...(requestId && { request_id: requestId }),
    ...(requestMethod && { request_method: requestMethod }),
    ...(requestPath && { request_path: requestPath }),
  };
}

function getAuthFailureField(source: unknown, field: keyof AuthFailureLike): unknown {
  if (!source) {
    return undefined;
  }
  if (typeof source === 'string') {
    return field === 'message' ? source : undefined;
  }
  if (typeof source === 'object') {
    try {
      return (source as AuthFailureLike)[field];
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function compactAuthLogContext(log: object): AuthLogContext {
  const compacted: Partial<AuthLogContext> = {};
  for (const [key, rawValue] of Object.entries(log)) {
    const value = normalizeAuthLogContextValue(rawValue);
    if (value !== undefined) {
      Object.assign(compacted, { [key]: value });
    }
  }
  return compacted as AuthLogContext;
}

function selectAuthLogExtra(extra: object): object {
  return Object.fromEntries(Object.entries(extra).filter(([key]) => AUTH_LOG_EXTRA_KEYS.has(key)));
}

export function getAuthFailureReason(
  err: unknown,
  info: unknown,
  fallback = 'Unauthorized',
): string {
  return (
    normalizeAuthLogValue(getAuthFailureField(info, 'message')) ??
    normalizeAuthLogValue(getAuthFailureField(err, 'message')) ??
    fallback
  );
}

export function getAuthFailureErrorName(err: unknown, info: unknown): string | undefined {
  return (
    normalizeAuthLogValue(getAuthFailureField(info, 'name')) ??
    normalizeAuthLogValue(getAuthFailureField(err, 'name'))
  );
}

export function getAuthFailureReasonCategory(
  err: unknown,
  info: unknown,
): AuthFailureReasonCategory {
  const reason = getAuthFailureReason(err, info).toLowerCase();
  const errorName = getAuthFailureErrorName(err, info)?.toLowerCase();

  if (reason.includes('expired') || errorName === 'tokenexpirederror') {
    return 'expired_jwt';
  }

  if (reason.includes('user-id mismatch') || reason.includes('principal mismatch')) {
    return 'principal_mismatch';
  }

  if (
    errorName === 'jsonwebtokenerror' ||
    reason.includes('jwt malformed') ||
    reason.includes('invalid signature') ||
    reason.includes('invalid algorithm') ||
    reason.includes('invalid token') ||
    reason.includes('invalid key')
  ) {
    return 'malformed_jwt';
  }

  if (reason === 'unauthorized' || reason.includes('no auth token')) {
    return 'missing_or_unrecognized_token';
  }

  return 'authentication_error';
}

function getSafeTokenProvider(tokenProvider: unknown): string | undefined {
  const normalized = normalizeAuthLogValue(tokenProvider);
  if (!normalized) {
    return undefined;
  }
  return normalized === 'openid' || normalized === 'librechat' ? normalized : 'other';
}

function getSafeTokenSource(tokenSource: unknown): string | undefined {
  const normalized = normalizeAuthLogValue(tokenSource);
  if (!normalized) {
    return undefined;
  }

  return ['bearer', 'none'].includes(normalized) ? normalized : 'other';
}

export function buildSafeAuthLogContext(
  req: AuthLogRequest,
  authState: AuthLogState,
  extra: object = {},
): AuthLogContext {
  return {
    ...compactAuthLogContext({
      ...selectAuthLogExtra(extra),
      token_provider: getSafeTokenProvider(authState.tokenProvider),
      token_source: getSafeTokenSource(authState.tokenSource),
      openid_reuse_enabled: authState.openidReuseEnabled,
      openid_jwt_available: authState.openidJwtAvailable,
      has_openid_reuse_user_id: authState.hasOpenIdReuseUserId,
    }),
    ...buildSafeRequestLogContext(req),
  };
}

/**
 * @deprecated Pass `{ message, ...context }` to the logger so structured fields
 * survive JSON message truncation. Retained for package API compatibility only.
 */
export function formatAuthLogMessage(message: string, context: AuthLogContext): string {
  return `${message} ${JSON.stringify(context)}`;
}

function getTenantIsolationSignature(message: string): string {
  if (message.includes('bulkWrite on') && message.includes('without tenant context')) {
    return 'missing_bulk_write_context';
  }
  if (message.includes('Unknown bulkWrite operation type')) {
    return 'unsupported_bulk_write_operation';
  }
  if (message.includes('Query attempted without tenant context')) {
    return 'missing_query_context';
  }
  if (message.includes('Aggregate attempted without tenant context')) {
    return 'missing_aggregate_context';
  }
  if (message.includes('Save attempted without tenant context')) {
    return 'missing_save_context';
  }
  if (message.includes('insertMany attempted without tenant context')) {
    return 'missing_insert_many_context';
  }
  if (message.includes('Cross-tenant')) {
    return 'cross_tenant_mutation';
  }
  if (message.includes('does not match current tenant context')) {
    return 'tenant_mismatch';
  }
  if (message.includes('Modifying tenantId via replacement')) {
    return 'replacement_tenant_mutation';
  }
  return 'tenant_isolation_error';
}

export function buildTenantIsolationErrorLogContext(
  req: AuthLogRequest,
  err: unknown,
): AuthLogContext | undefined {
  const message = normalizeAuthLogValue(getAuthFailureField(err, 'message'));
  if (!message?.startsWith('[TenantIsolation]')) {
    return undefined;
  }

  return {
    event_name: 'tenant_isolation_error',
    error_category: 'tenant_isolation',
    error_signature: getTenantIsolationSignature(message),
    response_status: 500,
    ...buildSafeRequestLogContext(req),
  };
}
