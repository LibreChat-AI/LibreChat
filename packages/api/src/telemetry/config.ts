const DEFAULT_SERVICE_NAME = 'librechat';
export const DEFAULT_HEALTH_PATH = '/health';
export const DEFAULT_LOGS_LEVEL = 'info';

export type TelemetryStatus = 'disabled' | 'failed' | 'started' | 'starting' | 'stopped';

export interface TelemetryConfig {
  enabled: boolean;
  healthPath: string;
  ioredisTracingEnabled: boolean;
  logsEnabled: boolean;
  logsLevel: string;
  sdkDisabled: boolean;
  serviceName: string;
  serviceVersion?: string;
  tracingEnabled: boolean;
}

function isTruthy(value?: string | boolean | null): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value.trim().toLowerCase() === 'true';
  }
  return false;
}

function normalizeEnvValue(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function getTelemetryConfig(env: NodeJS.ProcessEnv = process.env): TelemetryConfig {
  const sdkDisabled = isTruthy(env.OTEL_SDK_DISABLED);
  const tracingEnabled = isTruthy(env.OTEL_TRACING_ENABLED) && !sdkDisabled;
  const logsEnabled = isTruthy(env.OTEL_LOGS_ENABLED) && !sdkDisabled;
  const serviceName = normalizeEnvValue(env.OTEL_SERVICE_NAME) ?? DEFAULT_SERVICE_NAME;
  const serviceVersion =
    normalizeEnvValue(env.OTEL_SERVICE_VERSION) ?? normalizeEnvValue(env.npm_package_version);
  const ioredisTracingEnabled = isTruthy(env.OTEL_IOREDIS_TRACING_ENABLED);
  const logsLevel = normalizeEnvValue(env.OTEL_LOGS_LEVEL)?.toLowerCase() ?? DEFAULT_LOGS_LEVEL;

  return {
    enabled: tracingEnabled || logsEnabled,
    serviceName,
    ioredisTracingEnabled,
    logsEnabled,
    logsLevel,
    sdkDisabled,
    serviceVersion,
    tracingEnabled,
    healthPath: DEFAULT_HEALTH_PATH,
  };
}
