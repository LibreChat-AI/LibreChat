import { logger } from '@librechat/data-schemas';
import { OpenTelemetryTransportV3 } from '@opentelemetry/winston-transport';
import { attachLogsTransport, detachLogsTransport, getLogsTransport } from './logs';
import { getTelemetryConfig } from './config';

function countOtelTransports(): number {
  return logger.transports.filter((transport) => transport instanceof OpenTelemetryTransportV3)
    .length;
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
    expect(getLogsTransport()?.level).toBe('warn');
    expect(emitWarningSpy).not.toHaveBeenCalled();
  });

  it('falls back to info and warns when OTEL_LOGS_LEVEL is unknown', () => {
    attachLogsTransport(getTelemetryConfig({ OTEL_LOGS_ENABLED: 'true', OTEL_LOGS_LEVEL: 'loud' }));

    expect(getLogsTransport()?.level).toBe('info');
    expect(emitWarningSpy).toHaveBeenCalledWith(
      expect.stringContaining('Ignoring unknown OTEL_LOGS_LEVEL "loud"; using "info"'),
      { code: 'LIBRECHAT_OTEL' },
    );
  });

  it('removes the transport from the shared logger on detach', () => {
    attachLogsTransport(getTelemetryConfig({ OTEL_LOGS_ENABLED: 'true' }));
    const transport = getLogsTransport();

    detachLogsTransport();
    detachLogsTransport();

    expect(transport).toBeDefined();
    expect(getLogsTransport()).toBeUndefined();
    expect(countOtelTransports()).toBe(0);
    expect(logger.transports).not.toContain(transport);
  });
});
