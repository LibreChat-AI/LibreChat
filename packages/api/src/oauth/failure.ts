import type { Request } from 'express';

const MAX_LOG_VALUE_LENGTH = 300;

type LogValue = string | boolean;

type FailureLike = {
  code?: unknown;
  error?: unknown;
  name?: unknown;
  message?: unknown;
  error_description?: unknown;
  cause?: unknown;
};

export type OAuthFailureRequest = Pick<
  Request,
  'headers' | 'method' | 'path' | 'originalUrl' | 'query'
> & {
  id?: string;
  requestId?: string;
  session?: {
    messages?: unknown[];
  };
};

export type OAuthFailureLog = {
  provider: string;
  code?: string;
  name?: string;
  message?: string;
  cause_code?: string;
  cause_name?: string;
  cause_message?: string;
  has_code: boolean;
  has_state: boolean;
  query_error?: string;
  query_error_description?: string;
  method?: string;
  path?: string;
  request_id?: string;
  host?: string;
  forwarded_host?: string;
  forwarded_proto?: string;
  forwarded_for?: string;
  real_ip?: string;
  user_agent?: string;
};

export type BuildOAuthFailureLogParams = {
  provider: string;
  req: OAuthFailureRequest;
  err?: unknown;
  info?: unknown;
  defaultMessage?: string;
};

function normalizeLogValue(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const normalized = normalizeLogValue(entry);
      if (normalized) {
        return normalized;
      }
    }
    return undefined;
  }

  if (typeof value === 'string') {
    const trimmed = value.replace(/\s+/g, ' ').trim();
    if (!trimmed) {
      return undefined;
    }
    if (trimmed.length <= MAX_LOG_VALUE_LENGTH) {
      return trimmed;
    }
    return `${trimmed.slice(0, MAX_LOG_VALUE_LENGTH)}... [truncated]`;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return undefined;
}

function compactLogObject(
  log: Partial<OAuthFailureLog> & Pick<OAuthFailureLog, 'provider' | 'has_code' | 'has_state'>,
): OAuthFailureLog {
  const compacted: Partial<OAuthFailureLog> = {};
  const keys = Object.keys(log) as Array<keyof OAuthFailureLog>;
  for (const key of keys) {
    const value = log[key];
    if (value !== undefined) {
      Object.assign(compacted, { [key]: value as LogValue });
    }
  }
  return compacted as OAuthFailureLog;
}

function getField(source: unknown, field: keyof FailureLike): unknown {
  if (!source) {
    return undefined;
  }
  if (typeof source === 'string') {
    return field === 'message' ? source : undefined;
  }
  if (typeof source === 'object') {
    return (source as FailureLike)[field];
  }
  return undefined;
}

function firstLogValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = normalizeLogValue(value);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function getCause(source: unknown): unknown {
  const cause = getField(source, 'cause');
  return cause && typeof cause === 'object' ? cause : undefined;
}

function getHeader(req: OAuthFailureRequest, headerName: string): string | undefined {
  return normalizeLogValue(req.headers?.[headerName]);
}

function getQueryValue(req: OAuthFailureRequest, queryName: string): string | undefined {
  return normalizeLogValue(req.query?.[queryName]);
}

function hasQueryValue(req: OAuthFailureRequest, queryName: string): boolean {
  return getQueryValue(req, queryName) !== undefined;
}

function getRequestPath(req: OAuthFailureRequest): string | undefined {
  return firstLogValue(req.path, req.originalUrl?.split('?')[0]);
}

function popSessionFailureMessage(req: OAuthFailureRequest): unknown {
  const messages = req.session?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return undefined;
  }
  return messages.pop();
}

export function getOAuthFailureMessage(
  req: OAuthFailureRequest,
  defaultMessage = 'OAuth authentication failed',
): string {
  return (
    firstLogValue(
      popSessionFailureMessage(req),
      getQueryValue(req, 'error_description'),
      getQueryValue(req, 'error'),
      defaultMessage,
    ) ?? defaultMessage
  );
}

export function buildOAuthFailureLog({
  provider,
  req,
  err,
  info,
  defaultMessage,
}: BuildOAuthFailureLogParams): OAuthFailureLog {
  const errCause = getCause(err);
  const infoCause = getCause(info);
  return compactLogObject({
    provider,
    code: firstLogValue(
      getField(err, 'code'),
      getField(err, 'error'),
      getField(errCause, 'code'),
      getField(errCause, 'error'),
      getField(info, 'code'),
      getField(info, 'error'),
      getField(infoCause, 'code'),
      getField(infoCause, 'error'),
      getQueryValue(req, 'error'),
    ),
    name: firstLogValue(getField(err, 'name'), getField(info, 'name')),
    message: firstLogValue(
      getField(err, 'message'),
      getField(err, 'error_description'),
      getField(info, 'message'),
      getField(info, 'error_description'),
      getQueryValue(req, 'error_description'),
      getQueryValue(req, 'error'),
      defaultMessage,
    ),
    cause_code: firstLogValue(getField(errCause, 'code'), getField(infoCause, 'code')),
    cause_name: firstLogValue(getField(errCause, 'name'), getField(infoCause, 'name')),
    cause_message: firstLogValue(getField(errCause, 'message'), getField(infoCause, 'message')),
    has_code: hasQueryValue(req, 'code'),
    has_state: hasQueryValue(req, 'state'),
    query_error: getQueryValue(req, 'error'),
    query_error_description: getQueryValue(req, 'error_description'),
    method: normalizeLogValue(req.method),
    path: getRequestPath(req),
    request_id: firstLogValue(req.requestId, req.id, getHeader(req, 'x-request-id')),
    host: getHeader(req, 'host'),
    forwarded_host: getHeader(req, 'x-forwarded-host'),
    forwarded_proto: getHeader(req, 'x-forwarded-proto'),
    forwarded_for: getHeader(req, 'x-forwarded-for'),
    real_ip: getHeader(req, 'x-real-ip'),
    user_agent: getHeader(req, 'user-agent'),
  });
}

export function isOAuthProtocolFailure(err?: unknown, info?: unknown): boolean {
  const errCause = getCause(err);
  const infoCause = getCause(info);
  const code = firstLogValue(
    getField(err, 'code'),
    getField(err, 'error'),
    getField(errCause, 'code'),
    getField(errCause, 'error'),
    getField(info, 'code'),
    getField(info, 'error'),
    getField(infoCause, 'code'),
    getField(infoCause, 'error'),
  );

  if (code?.startsWith('OAUTH_')) {
    return true;
  }

  const name = firstLogValue(
    getField(err, 'name'),
    getField(errCause, 'name'),
    getField(info, 'name'),
    getField(infoCause, 'name'),
  );
  if (name === 'AuthorizationResponseError') {
    return true;
  }

  const message = firstLogValue(
    getField(err, 'message'),
    getField(errCause, 'message'),
    getField(info, 'message'),
    getField(infoCause, 'message'),
  );

  return name === 'OperationProcessingError' && /invalid response/i.test(message ?? '');
}
