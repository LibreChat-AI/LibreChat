const isDevelopment = import.meta.env.MODE === 'development';
const isLoggerEnabled = import.meta.env.VITE_ENABLE_LOGGER === 'true';
const loggerFilter = import.meta.env.VITE_LOGGER_FILTER || '';

type LogFunction = (...args: unknown[]) => void;
type RemoteLogLevel = 'warn' | 'error';
export type RemoteLogSink = (level: RemoteLogLevel, args: unknown[]) => void;

let remoteLogSink: RemoteLogSink | undefined;

/**
 * Routes `warn`/`error` calls to a telemetry sink (RUM client logs) independently of console
 * output. The sink owns redaction; it receives the raw arguments and must never throw.
 */
export function setRemoteLogSink(sink: RemoteLogSink | undefined): void {
  remoteLogSink = sink;
}

function forwardToRemote(type: string | undefined, args: unknown[]): void {
  if (!remoteLogSink || (type !== 'warn' && type !== 'error')) {
    return;
  }
  try {
    remoteLogSink(type, args);
  } catch {
    /* Telemetry must never affect the caller. */
  }
}

const createLogFunction = (
  consoleMethod: LogFunction,
  type?: 'log' | 'warn' | 'error' | 'info' | 'debug' | 'dir',
): LogFunction => {
  return (...args: unknown[]) => {
    forwardToRemote(type, args);
    if (isLoggerEnabled || (import.meta.env.VITE_ENABLE_LOGGER == null && isDevelopment)) {
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

const logger = {
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
