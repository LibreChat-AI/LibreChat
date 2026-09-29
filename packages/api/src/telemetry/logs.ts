import winston from 'winston';
import { OpenTelemetryTransportV3 } from '@opentelemetry/winston-transport';
import { logger, baseLogFormat, jsonTruncateFormat } from '@librechat/data-schemas';
import type { TelemetryConfig } from './config';
import { emitTelemetryWarning } from './warnings';
import { DEFAULT_LOGS_LEVEL } from './config';

let activeTransport: OpenTelemetryTransportV3 | undefined;

/**
 * An unknown level name would resolve to `undefined` inside winston and silently
 * drop every record, so fall back and say so instead.
 */
function resolveLogsLevel(level: string): string {
  if (Object.prototype.hasOwnProperty.call(logger.levels, level)) {
    return level;
  }

  emitTelemetryWarning(
    `Ignoring unknown OTEL_LOGS_LEVEL "${level}"; using "${DEFAULT_LOGS_LEVEL}". ` +
      `Expected one of: ${Object.keys(logger.levels).join(', ')}.`,
  );
  return DEFAULT_LOGS_LEVEL;
}

/**
 * Bridges the shared winston logger into the OpenTelemetry logs pipeline. The
 * transport emits through the global LoggerProvider registered by the Node SDK,
 * and records created while a span is active inherit its trace context.
 * Records pass through the same redaction as file and JSON console output
 * before they leave the process.
 */
export function attachLogsTransport(config: TelemetryConfig): void {
  if (activeTransport) {
    return;
  }

  const transport = new OpenTelemetryTransportV3({
    level: resolveLogsLevel(config.logsLevel),
    format: winston.format.combine(baseLogFormat, jsonTruncateFormat()),
  });
  logger.add(transport);
  activeTransport = transport;
}

export function detachLogsTransport(): void {
  if (!activeTransport) {
    return;
  }

  logger.remove(activeTransport);
  activeTransport = undefined;
}

export function getLogsTransport(): OpenTelemetryTransportV3 | undefined {
  return activeTransport;
}
