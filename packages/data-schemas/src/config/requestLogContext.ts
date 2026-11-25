import type winston from 'winston';
import {
  getTenantId,
  getUserId,
  getRequestId,
  getRequestMethod,
  getRequestPath,
  SYSTEM_TENANT_ID,
} from './tenantContext';

const REQUEST_LOG_CONTEXT_KEYS = [
  'tenantId',
  'userId',
  'requestId',
  'request_id',
  'request_method',
  'request_path',
] as const;

const RESERVED_REQUEST_LOG_CONTEXT_KEYS = new Set<string>([
  'requestId',
  'request_id',
  'request_method',
  'request_path',
]);

const STRUCTURED_EVENT_LOG_CONTEXT_KEYS = [
  'event_name',
  'tenant_id',
  'configured',
  'enabled',
  'destination',
  'change',
  'changes',
  'verification_result',
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
  'token_provider',
  'token_source',
  'openid_reuse_enabled',
  'openid_jwt_available',
  'has_openid_reuse_user_id',
  'error_category',
  'error_signature',
] as const;

type LogContextKey =
  | (typeof REQUEST_LOG_CONTEXT_KEYS)[number]
  | (typeof STRUCTURED_EVENT_LOG_CONTEXT_KEYS)[number];

const LOG_CONTEXT_KEYS: readonly LogContextKey[] = [
  ...REQUEST_LOG_CONTEXT_KEYS,
  ...STRUCTURED_EVENT_LOG_CONTEXT_KEYS,
];

const IDENTITY_CONTEXT_KEYS = ['tenantId', 'tenant_id', 'userId', 'user_id'] as const;
const IDENTITY_FREE_EVENT_NAMES = new Set([
  'jwt_auth_fallback_attempt',
  'jwt_auth_rejected',
  'jwt_auth_recovered',
  'tenant_isolation_error',
]);
const STRUCTURED_EVENT_NAMES = new Set([
  ...IDENTITY_FREE_EVENT_NAMES,
  'librechat.langfuse.connection.changed',
]);
const STRUCTURED_EVENT_LOG_CONTEXT_KEY_SET = new Set<string>(STRUCTURED_EVENT_LOG_CONTEXT_KEYS);
const MAX_LOG_CONTEXT_ARRAY_LENGTH = 10;

type LogContextValue = string | number | boolean | readonly string[];
type LogContextInfo =
  | Partial<{ [Key in LogContextKey]: unknown }>
  | winston.Logform.TransformableInfo;

function isIdentityFreeEvent(eventName: unknown): boolean {
  return typeof eventName === 'string' && IDENTITY_FREE_EVENT_NAMES.has(eventName);
}

function isStructuredEvent(eventName: unknown): boolean {
  return typeof eventName === 'string' && STRUCTURED_EVENT_NAMES.has(eventName);
}

function getLogTenantId(): string | undefined {
  const tenantId = getTenantId();
  return tenantId === SYSTEM_TENANT_ID ? undefined : tenantId;
}

function normalizeLogContextValue(value: unknown): LogContextValue | undefined {
  if (typeof value === 'string') {
    return value || undefined;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }

  const values = value
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    .slice(0, MAX_LOG_CONTEXT_ARRAY_LENGTH);
  return values.length > 0 ? values : undefined;
}

/** Serializes the allowlisted context rendered by non-JSON log transports. */
export function formatLogContext(info: LogContextInfo): string {
  const context: Partial<Record<LogContextKey, LogContextValue>> = {};
  const omitIdentity = isIdentityFreeEvent(info.event_name);
  const includeStructuredEvent = isStructuredEvent(info.event_name);

  LOG_CONTEXT_KEYS.forEach((key) => {
    if (STRUCTURED_EVENT_LOG_CONTEXT_KEY_SET.has(key) && !includeStructuredEvent) {
      return;
    }
    if (omitIdentity && (key === 'tenantId' || key === 'userId')) {
      return;
    }
    if (key === 'tenantId' && info[key] === SYSTEM_TENANT_ID) {
      return;
    }
    const value = normalizeLogContextValue(info[key]);
    if (value !== undefined) {
      context[key] = value;
    }
  });

  return Object.keys(context).length > 0 ? JSON.stringify(context) : '';
}

export function appendLogContext(line: string, info: LogContextInfo): string {
  const context = formatLogContext(info);
  return context ? `${line} ${context}` : line;
}

/**
 * Adds request-scoped context to a log record. Authentication and tenant-isolation
 * events intentionally omit identity fields while retaining request correlation.
 */
export function attachRequestContext(
  info: winston.Logform.TransformableInfo,
): winston.Logform.TransformableInfo {
  const omitIdentity = isIdentityFreeEvent(info.event_name);
  if (omitIdentity) {
    IDENTITY_CONTEXT_KEYS.forEach((key) => delete info[key]);
  } else if (info.tenantId === SYSTEM_TENANT_ID) {
    delete info.tenantId;
  }

  const context = {
    tenantId: omitIdentity ? undefined : getLogTenantId(),
    userId: omitIdentity ? undefined : getUserId(),
    requestId: getRequestId(),
    request_id: getRequestId(),
    request_method: getRequestMethod(),
    request_path: getRequestPath(),
  };
  REQUEST_LOG_CONTEXT_KEYS.forEach((key) => {
    if (context[key] && (RESERVED_REQUEST_LOG_CONTEXT_KEYS.has(key) || info[key] == null)) {
      info[key] = context[key];
    }
  });
  return info;
}
