const isDevelopment = process.env.NODE_ENV === 'development';
const isLoggerEnabled = process.env.VITE_ENABLE_LOGGER === 'true';
const loggerFilter = process.env.VITE_LOGGER_FILTER || '';

type LogFunction = (...args: unknown[]) => void;

const createLogFunction = (
  consoleMethod: LogFunction,
  type?: 'log' | 'warn' | 'error' | 'info' | 'debug' | 'dir',
): LogFunction => {
  return (...args: unknown[]) => {
    if (isDevelopment || isLoggerEnabled) {
      const tag = typeof args[0] === 'string' ? args[0] : '';
      if (shouldLog(tag)) {
        if (tag && typeof args[1] === 'string' && type === 'error') {
          consoleMethod(`[${tag}] ${args[1]}`, ...args.slice(2));
        } else if (tag && args.length > 1) {
          consoleMethod(`[${tag}]`, ...args.slice(1));
        } else {
          consoleMethod(...args);
        }
      }
    }
  };
};

const logger: {
  log: LogFunction;
  dir: LogFunction;
  warn: LogFunction;
  info: LogFunction;
  error: LogFunction;
  debug: LogFunction;
} = {
  log: createLogFunction(console.log, 'log'),
  dir: createLogFunction(console.dir, 'dir'),
  warn: createLogFunction(console.warn, 'warn'),
  info: createLogFunction(console.info, 'info'),
  error: createLogFunction(console.error, 'error'),
  debug: createLogFunction(console.debug, 'debug'),
};

function shouldLog(tag: string): boolean {
  if (!loggerFilter) {
    return true;
  }
  /* If no tag is provided, always log */
  if (!tag) {
    return true;
  }
  return loggerFilter
    .split(',')
    .some((filter) => tag.toLowerCase().includes(filter.trim().toLowerCase()));
}

export default logger;
