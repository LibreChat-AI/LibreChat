const winston = require('winston');

const useFileLogging =
  typeof process.env.LOG_TO_FILE !== 'string' || process.env.LOG_TO_FILE.toLowerCase() !== 'false';

const transports = [new winston.transports.Console()];

if (useFileLogging) {
  transports.push(new winston.transports.File({ filename: 'login-logs.log' }));
}

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports,
});

module.exports = logger;
