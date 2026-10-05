export type MediaLog = (message: string, error?: Error) => void;

export interface MediaLogger {
  error: MediaLog;
  warn: MediaLog;
  info(message: string): void;
}

/** Keep the contextual message when Winston splats enumerable error metadata after formatting. */
export function createMediaLog(log: MediaLog): MediaLog {
  return (message, error) => {
    if (!error) {
      log(message);
      return;
    }
    const contextual = Object.assign(new Error(message, { cause: error }), error, {
      message,
      cause: error,
      stack: error.stack,
    });
    log(message, contextual);
  };
}

export function createMediaLogger(logger: MediaLogger): MediaLogger {
  return {
    error: createMediaLog(logger.error.bind(logger)),
    warn: createMediaLog(logger.warn.bind(logger)),
    info: logger.info.bind(logger),
  };
}
