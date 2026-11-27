import winston from 'winston';
import 'winston-daily-rotate-file';
import { getLogDirectory, logLevels, resolveConsoleLevel } from './utils';

const { NODE_ENV, DEBUG_LOGGING = 'false', LOG_TO_FILE } = process.env;

const useDebugLogging =
  (typeof DEBUG_LOGGING === 'string' && DEBUG_LOGGING.toLowerCase() === 'true') ||
  DEBUG_LOGGING === 'true';

const useFileLogging = typeof LOG_TO_FILE !== 'string' || LOG_TO_FILE.toLowerCase() !== 'false';

winston.addColors({
  info: 'green',
  warn: 'italic yellow',
  error: 'red',
  debug: 'blue',
});

const level = (): string => {
  const env = NODE_ENV || 'development';
  const isDevelopment = env === 'development';
  return isDevelopment ? 'debug' : 'warn';
};

const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
);

const logLevel = useDebugLogging ? 'debug' : 'error';
const transports: winston.transport[] = [];

if (useFileLogging) {
  const logDir = getLogDirectory();

  transports.push(
    new winston.transports.DailyRotateFile({
      level: logLevel,
      filename: `${logDir}/meiliSync-%DATE%.log`,
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d',
      format: fileFormat,
    }),
  );
}

const consoleFormat = winston.format.combine(
  winston.format.colorize({ all: true }),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf((info) => `${info.timestamp} ${info.level}: ${info.message}`),
);

const { level: consoleLevel, silent: consoleSilent } = resolveConsoleLevel();

transports.push(
  new winston.transports.Console({
    level: consoleLevel,
    silent: consoleSilent,
    format: consoleFormat,
  }),
);

const logger: winston.Logger = winston.createLogger({
  level: level(),
  levels: logLevels,
  transports,
});

export default logger;
