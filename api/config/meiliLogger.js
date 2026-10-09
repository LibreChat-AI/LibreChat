const path = require('path');
const fs = require('fs');
const winston = require('winston');
require('winston-daily-rotate-file');

/**
 * Determine the log directory.
 * Priority:
 * 1. LIBRECHAT_LOG_DIR environment variable (allows user override)
 * 2. /app/logs if running in Docker (bind-mounted with correct permissions)
 * 3. api/logs relative to this file (local development)
 */
const getLogDir = () => {
  if (process.env.LIBRECHAT_LOG_DIR) {
    return process.env.LIBRECHAT_LOG_DIR;
  }

  // Check if running in Docker container (cwd is /app)
  if (process.cwd() === '/app') {
    const dockerLogDir = '/app/logs';
    // Ensure the directory exists
    if (!fs.existsSync(dockerLogDir)) {
      fs.mkdirSync(dockerLogDir, { recursive: true });
    }
    return dockerLogDir;
  }

  // Local development: use api/logs relative to this file
  return path.join(__dirname, '..', 'logs');
};

const { NODE_ENV, DEBUG_LOGGING = false, LOG_TO_FILE = true } = process.env;

const useDebugLogging =
  (typeof DEBUG_LOGGING === 'string' && DEBUG_LOGGING?.toLowerCase() === 'true') ||
  DEBUG_LOGGING === true;

const useFileLogging =
  (typeof LOG_TO_FILE === 'string' && LOG_TO_FILE?.toLowerCase() !== 'false') ||
  LOG_TO_FILE === true;

const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  verbose: 4,
  debug: 5,
  activity: 6,
  silly: 7,
};

winston.addColors({
  info: 'green', // fontStyle color
  warn: 'italic yellow',
  error: 'red',
  debug: 'blue',
});

const level = () => {
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
const transports = [];

if (useFileLogging) {
  const logDir = getLogDir();

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

transports.push(
  new winston.transports.Console({
    level: 'info',
    format: consoleFormat,
  }),
);

const logger = winston.createLogger({
  level: level(),
  levels,
  transports,
});

module.exports = logger;
