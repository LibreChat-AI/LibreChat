import { logger } from '@librechat/data-schemas';
import { OpenTelemetryTransportV3 } from '@opentelemetry/winston-transport';
import { attachLogsTransport, detachLogsTransport } from './logs';
import { getTelemetryConfig } from './config';

function getOtelTransports(): OpenTelemetryTransportV3[] {
  return logger.transports.filter(
    (transport): transport is OpenTelemetryTransportV3 =>
      transport instanceof OpenTelemetryTransportV3,
  );
}

function countOtelTransports(): number {
  return getOtelTransports().length;
}

describe('logs transport lifecycle', () => {
  let emitWarningSpy: jest.SpyInstance;

  beforeEach(() => {
    emitWarningSpy = jest.spyOn(process, 'emitWarning').mockImplementation(() => true);
  });

  afterEach(() => {
    detachLogsTransport();
    emitWarningSpy.mockRestore();
  });

  it('adds one OpenTelemetry transport to the shared logger at the configured level', () => {
    const config = getTelemetryConfig({ OTEL_LOGS_ENABLED: 'true', OTEL_LOGS_LEVEL: 'warn' });

    attachLogsTransport(config);
    attachLogsTransport(config);

    expect(countOtelTransports()).toBe(1);
    expect(getOtelTransports()[0]?.level).toBe('warn');
    expect(emitWarningSpy).not.toHaveBeenCalled();
  });

  it('falls back to info and warns when OTEL_LOGS_LEVEL is unknown', () => {
    attachLogsTransport(getTelemetryConfig({ OTEL_LOGS_ENABLED: 'true', OTEL_LOGS_LEVEL: 'loud' }));

    expect(getOtelTransports()[0]?.level).toBe('info');
    expect(emitWarningSpy).toHaveBeenCalledWith(
      expect.stringContaining('Ignoring unknown OTEL_LOGS_LEVEL "loud"; using "info"'),
      { code: 'LIBRECHAT_OTEL' },
    );
  });

  it('removes the transport from the shared logger on detach', () => {
    attachLogsTransport(getTelemetryConfig({ OTEL_LOGS_ENABLED: 'true' }));
    const transport = getOtelTransports()[0];

    detachLogsTransport();
    detachLogsTransport();

    expect(transport).toBeDefined();
    expect(countOtelTransports()).toBe(0);
    expect(logger.transports).not.toContain(transport);
  });
});
