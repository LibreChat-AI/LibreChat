export interface SafeErrorMetadata {
  readonly type: string;
  readonly status?: number;
}

function readProperty(value: object, property: string): unknown {
  try {
    return (value as Record<string, unknown>)[property];
  } catch {
    return undefined;
  }
}

/**
 * Returns bounded diagnostic metadata without error messages, stacks, headers,
 * request bodies, or provider response data that may echo submitted content.
 */
export function getSafeErrorMetadata(error: unknown): SafeErrorMetadata {
  if (error == null || typeof error !== 'object') {
    return { type: 'UnknownError' };
  }

  const directStatus = readProperty(error, 'status') ?? readProperty(error, 'statusCode');
  const response = readProperty(error, 'response');
  const responseStatus =
    response != null && typeof response === 'object' ? readProperty(response, 'status') : undefined;
  const statusCandidate = directStatus ?? responseStatus;
  const status =
    typeof statusCandidate === 'number' &&
    Number.isInteger(statusCandidate) &&
    statusCandidate >= 100 &&
    statusCandidate <= 599
      ? statusCandidate
      : undefined;

  return {
    type: error instanceof Error ? 'Error' : 'UnknownError',
    ...(status !== undefined && { status }),
  };
}

const MAX_SAFE_ERROR_TEXT = 2000;

function redactUrl(match: string): string {
  try {
    const url = new URL(match);
    return `${url.protocol}//${url.host}/[redacted]`;
  } catch {
    return '[url]';
  }
}

function redactSecrets(value: string): string {
  return value
    .replace(/\b(?!file:)[a-z][a-z0-9+.-]*:\/\/\S+/gi, redactUrl)
    .replace(/\b(bearer|basic)\s+\S+/gi, '$1 [redacted]');
}

/**
 * The request-boundary counterpart to {@link getSafeErrorMetadata}: the error's own
 * description and stack, with every URL reduced to its origin and bearer credentials
 * removed. A signed storage URL carries the object path and signature in the parts
 * that are dropped, while the origin is what an operator needs to place the failure.
 *
 * Returned as text because the caller must log it inside the message and pass no
 * winston metadata: metadata arms `format.splat()` and promotes an SDK error's own
 * enumerable properties — `request.url`, `config`, `response.headers` — onto the
 * record, which is the wider leak an error object causes at a log site.
 *
 * Use this where a handler catches every failure on a route and the class of error is
 * not known ahead of time. Prefer `getSafeErrorMetadata` where the error may echo
 * submitted content, such as a provider response body.
 */
export function getSafeErrorText(error: unknown): string {
  if (typeof error === 'string') {
    return redactSecrets(error).slice(0, MAX_SAFE_ERROR_TEXT);
  }

  if (error == null || typeof error !== 'object') {
    return 'UnknownError';
  }

  const stack = readProperty(error, 'stack');
  if (typeof stack === 'string' && stack.length > 0) {
    return redactSecrets(stack).slice(0, MAX_SAFE_ERROR_TEXT);
  }

  const name = readProperty(error, 'name');
  const message = readProperty(error, 'message');
  const described = [
    typeof name === 'string' && name.length > 0 ? name : 'UnknownError',
    typeof message === 'string' && message.length > 0 ? message : undefined,
  ]
    .filter(Boolean)
    .join(': ');

  return redactSecrets(described).slice(0, MAX_SAFE_ERROR_TEXT);
}

/**
 * Whether a caught error is a cancellation rather than a genuine failure.
 *
 * An aborted signal on its own proves only that the run is over: a permission,
 * OAuth, or upstream error can reject in the same tick a user presses Stop, and
 * treating those as cancellations hides real faults from operational alerts.
 * Callers that want to quiet a cancellation should require this as well as the
 * signal state. Walks `cause` because intermediate layers rewrap the rejection.
 */
export function isAbortError(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current: unknown = error;

  while (current != null && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);

    const name = readProperty(current, 'name');
    const code = readProperty(current, 'code');
    const messageValue = readProperty(current, 'message');
    const message = typeof messageValue === 'string' ? messageValue : '';

    if (
      name === 'AbortError' ||
      code === 'ABORT_ERR' ||
      code === 'ERR_CANCELED' ||
      message.includes('AbortError') ||
      /(?:operation|request|stream) was aborted/i.test(message)
    ) {
      return true;
    }

    current = readProperty(current, 'cause');
  }

  return false;
}

/** Whether an error represents cancellation by this specific owning signal. */
export function isOwnedAbortError(error: unknown, signal?: AbortSignal | null): boolean {
  return signal?.aborted === true && (isAbortError(error) || error === signal.reason);
}
