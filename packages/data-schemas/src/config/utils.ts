import path from 'path';

import type winston from 'winston';

/**
 * Determine the log directory in a cross-compatible way.
 * Priority:
 * 1. LIBRECHAT_LOG_DIR environment variable
 * 2. If running within LibreChat monorepo (when cwd ends with /api), use api/logs
 * 3. If api/logs exists relative to cwd, use that (for running from project root)
 * 4. Otherwise, use logs directory relative to process.cwd()
 *
 * This avoids using __dirname which is not available in ESM modules
 */
export const getLogDirectory = (): string => {
  if (process.env.LIBRECHAT_LOG_DIR) {
    return process.env.LIBRECHAT_LOG_DIR;
  }

  const cwd = process.cwd();

  // Check if we're running from within the api directory
  if (cwd.endsWith('/api') || cwd.endsWith('\\api')) {
    return path.join(cwd, 'logs');
  }

  // Check if api/logs exists relative to current directory (running from project root)
  // We'll just use the path and let the file system create it if needed
  const apiLogsPath = path.join(cwd, 'api', 'logs');

  // For LibreChat project structure, use api/logs
  // For external consumers, they should set LIBRECHAT_LOG_DIR
  if (cwd.includes('LibreChat')) {
    return apiLogsPath;
  }

  // Default to logs directory relative to current working directory
  return path.join(cwd, 'logs');
};

/**
 * The level set every logger in this package is built with. Winston resolves a
 * level name against this map, so a name outside it resolves to `undefined` and
 * the transport drops every message.
 */
export const logLevels: winston.config.AbstractConfigSetLevels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  verbose: 4,
  debug: 5,
  activity: 6,
  silly: 7,
};

/**
 * Console verbosity for every winston logger in this package.
 *
 * Each logger's Console transport used to hard-code `level: 'info'`, which
 * silently overrides the logger's own level — winston resolves a transport's
 * explicit level ahead of its parent's. `CONSOLE_LOG_LEVEL` makes that
 * verbosity configurable, and `silent` turns console output off entirely.
 *
 * An unrecognized name falls back rather than reaching winston: it would
 * resolve to `undefined` there and silently discard every console log, so a
 * typo would read as a dead deployment. Say so on the way past — the logger
 * cannot report its own misconfiguration.
 */
export const resolveConsoleLevel = (fallback = 'info'): { level: string; silent: boolean } => {
  const requested = process.env.CONSOLE_LOG_LEVEL?.trim().toLowerCase();

  if (!requested) {
    return { level: fallback, silent: false };
  }

  if (requested === 'silent') {
    return { level: fallback, silent: true };
  }

  if (Object.prototype.hasOwnProperty.call(logLevels, requested)) {
    return { level: requested, silent: false };
  }

  console.warn(
    `[logger] Ignoring unknown CONSOLE_LOG_LEVEL "${process.env.CONSOLE_LOG_LEVEL}"; using "${fallback}". ` +
      `Expected one of: ${Object.keys(logLevels).join(', ')}, silent.`,
  );
  return { level: fallback, silent: false };
};
