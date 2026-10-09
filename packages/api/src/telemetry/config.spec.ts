import { getTelemetryConfig } from './config';

describe('getTelemetryConfig', () => {
  it('defaults tracing off', () => {
    const config = getTelemetryConfig({});

    expect(config.enabled).toBe(false);
    expect(config.tracingEnabled).toBe(false);
    expect(config.logsEnabled).toBe(false);
    expect(config.logsLevel).toBe('info');
    expect(config.sdkDisabled).toBe(false);
    expect(config.serviceName).toBe('librechat');
    expect(config.healthPath).toBe('/health');
    expect(config.ioredisTracingEnabled).toBe(false);
  });

  it('enables tracing only when OTEL_TRACING_ENABLED is true', () => {
    expect(getTelemetryConfig({ OTEL_TRACING_ENABLED: 'true' }).enabled).toBe(true);
    expect(getTelemetryConfig({ OTEL_TRACING_ENABLED: 'TRUE' }).enabled).toBe(true);
    expect(getTelemetryConfig({ OTEL_TRACING_ENABLED: 'false' }).enabled).toBe(false);
  });

  it('enables logs only when OTEL_LOGS_ENABLED is true', () => {
    const config = getTelemetryConfig({ OTEL_LOGS_ENABLED: 'true' });

    expect(config.enabled).toBe(true);
    expect(config.logsEnabled).toBe(true);
    expect(config.tracingEnabled).toBe(false);
    expect(getTelemetryConfig({ OTEL_LOGS_ENABLED: 'false' }).logsEnabled).toBe(false);
  });

  it('normalizes OTEL_LOGS_LEVEL', () => {
    expect(getTelemetryConfig({ OTEL_LOGS_LEVEL: ' Warn ' }).logsLevel).toBe('warn');
    expect(getTelemetryConfig({ OTEL_LOGS_LEVEL: '  ' }).logsLevel).toBe('info');
  });

  it('lets OTEL_SDK_DISABLED override tracing and logs enablement', () => {
    const config = getTelemetryConfig({
      OTEL_LOGS_ENABLED: 'true',
      OTEL_SDK_DISABLED: 'true',
      OTEL_TRACING_ENABLED: 'true',
    });

    expect(config.enabled).toBe(false);
    expect(config.tracingEnabled).toBe(false);
    expect(config.logsEnabled).toBe(false);
    expect(config.sdkDisabled).toBe(true);
  });

  it('uses standard service env vars when provided', () => {
    const config = getTelemetryConfig({
      OTEL_SERVICE_NAME: ' librechat-api ',
      OTEL_SERVICE_VERSION: ' 1.2.3 ',
    });

    expect(config.serviceName).toBe('librechat-api');
    expect(config.serviceVersion).toBe('1.2.3');
  });

  it('falls back to npm package version when service version is absent', () => {
    const config = getTelemetryConfig({
      npm_package_version: '0.8.5',
    });

    expect(config.serviceVersion).toBe('0.8.5');
  });

  it('enables ioredis instrumentation only when explicitly configured', () => {
    const config = getTelemetryConfig({
      OTEL_IOREDIS_TRACING_ENABLED: 'true',
    });

    expect(config.ioredisTracingEnabled).toBe(true);
  });
});
