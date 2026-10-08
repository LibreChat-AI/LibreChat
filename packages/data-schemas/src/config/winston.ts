import winston from 'winston';
import 'winston-daily-rotate-file';
import {
  redactFormat,
  redactMessage,
  debugTraverse,
  jsonTruncateFormat,
  stripHeavyErrorFields,
} from './parsers';
import { appendLogContext, attachRequestContext } from './requestLogContext';
import { getLogDirectory, logLevels, resolveConsoleLevel } from './utils';

const { NODE_ENV, DEBUG_LOGGING, CONSOLE_JSON, DEBUG_CONSOLE, LOG_TO_FILE } = process.env;

const useConsoleJson = typeof CONSOLE_JSON === 'string' && CONSOLE_JSON.toLowerCase() === 'true';

const useDebugConsole = typeof DEBUG_CONSOLE === 'string' && DEBUG_CONSOLE.toLowerCase() === 'true';

const useDebugLogging = typeof DEBUG_LOGGING === 'string' && DEBUG_LOGGING.toLowerCase() === 'true';

const useFileLogging = typeof LOG_TO_FILE !== 'string' || LOG_TO_FILE.toLowerCase() !== 'false';

const requestContextFormat = winston.format(attachRequestContext);

winston.addColors({
  info: 'green',
  warn: 'italic yellow',
  error: 'red',
  debug: 'blue',
});

const level = (): string => {
  const env = NODE_ENV || 'development';
  return env === 'development' ? 'debug' : 'warn';
};

export const baseLogFormat: winston.Logform.Format = winston.format.combine(
  redactFormat(),
  winston.format.timestamp({ format: () => new Date().toISOString() }),
  winston.format.errors({ stack: true }),
  stripHeavyErrorFields(),
  winston.format.splat(),
  requestContextFormat(),
);

const transports: winston.transport[] = [];

if (useFileLogging) {
  const logDir = getLogDirectory();

  transports.push(
    new winston.transports.DailyRotateFile({
      level: 'error',
      filename: `${logDir}/error-%DATE%.log`,
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d',
      format: winston.format.combine(baseLogFormat, winston.format.json()),
    }),
  );

  if (useDebugLogging) {
    transports.push(
      new winston.transports.DailyRotateFile({
        level: 'debug',
        filename: `${logDir}/debug-%DATE%.log`,
        datePattern: 'YYYY-MM-DD',
        zippedArchive: true,
        maxSize: '20m',
        maxFiles: '14d',
        format: winston.format.combine(baseLogFormat, debugTraverse),
      }),
    );
  }
}

const consoleFormat = winston.format.combine(
  redactFormat(),
  requestContextFormat(),
  winston.format.colorize({ all: true }),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf((info) => {
    const message = `${info.timestamp} ${info.level}: ${info.message}`;
    const line = appendLogContext(message, info);
    return info.level.includes('error') ? redactMessage(line) : line;
  }),
);

/** `DEBUG_CONSOLE` still picks the debug *format* below; here it only moves the
 * default level, so an explicit `CONSOLE_LOG_LEVEL` stays in charge of verbosity. */
const { level: consoleLogLevel, silent: consoleSilent } = resolveConsoleLevel(
  useDebugConsole ? 'debug' : 'info',
);

// Add console transport
if (useDebugConsole) {
  transports.push(
    new winston.transports.Console({
      level: consoleLogLevel,
      silent: consoleSilent,
      format: useConsoleJson
        ? winston.format.combine(baseLogFormat, jsonTruncateFormat(), winston.format.json())
        : winston.format.combine(baseLogFormat, debugTraverse),
    }),
  );
} else if (useConsoleJson) {
  transports.push(
    new winston.transports.Console({
      level: consoleLogLevel,
      silent: consoleSilent,
      format: winston.format.combine(baseLogFormat, jsonTruncateFormat(), winston.format.json()),
    }),
  );
} else {
  transports.push(
    new winston.transports.Console({
      level: consoleLogLevel,
      silent: consoleSilent,
      format: consoleFormat,
    }),
  );
}

// Create logger
const logger: winston.Logger = winston.createLogger({
  level: level(),
  levels: logLevels,
  transports,
});

export default logger;
