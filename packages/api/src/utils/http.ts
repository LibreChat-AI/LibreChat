/**
 * Normalizes an error-like object into an HTTP status and message.
 * Ensures we always respond with a valid numeric status to avoid UI hangs.
 */
export function normalizeHttpError(
  err: Error | { status?: number; message?: string } | unknown,
  fallbackStatus = 400,
): {
  status: number;
  message: string;
} {
  let status = fallbackStatus;
  if (err && typeof err === 'object' && 'status' in err && typeof err.status === 'number') {
    status = err.status;
  }

  let message = 'An error occurred.';
  if (
    err &&
    typeof err === 'object' &&
    'message' in err &&
    typeof err.message === 'string' &&
    err.message.length > 0
  ) {
    message = err.message;
  }

  return { status, message };
}
