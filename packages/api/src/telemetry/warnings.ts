const WARNING_CODE = 'LIBRECHAT_OTEL';

export function emitTelemetryWarning(message: string): void {
  process.emitWarning(message, { code: WARNING_CODE });
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
