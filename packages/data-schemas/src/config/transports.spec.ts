import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import type winston from 'winston';

const LEVEL = Symbol.for('level');
const MESSAGE = Symbol.for('message');
const SPLAT = Symbol.for('splat');

type Env = Record<string, string | undefined>;

/** Loggers build their transports from the environment at import, so each case re-imports. */
async function loadTransports(module: 'winston' | 'meiliLogger', env: Env) {
  const previous: Env = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    jest.resetModules();
    const { default: logger } =
      module === 'winston' ? await import('./winston') : await import('./meiliLogger');
    return logger;
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/** One record per level, carrying an address in the message, a field, splat metadata and a URL. */
function record(level: string): winston.Logform.TransformableInfo {
  return {
    level,
    [LEVEL]: level,
    message: 'login failed for jane.doe@example.com',
    contact: '"jane doe"@example.com',
    url: '/v1?e=jane%2540example.com&x=1',
    auth: 'Bearer secretcanary',
    [SPLAT]: [{ contact: 'jane.doe@example.com' }],
  };
}

/** A file transport opens its stream asynchronously; wait until each has ended before cleanup. */
function close(logger: winston.Logger): Promise<unknown[]> {
  return Promise.all(
    logger.transports
      .filter((transport) => transport.constructor.name === 'DailyRotateFile')
      .map(
        (transport) =>
          new Promise((resolve) => {
            transport.once('finish', resolve);
            transport.close?.();
          }),
      ),
  );
}

function written(logger: winston.Logger, level: string): string[] {
  return logger.transports.map((transport) => {
    const output = transport.format?.transform(record(level), transport.format.options ?? {});
    if (!output || output === true) {
      return '';
    }
    const line = (output as Record<symbol, unknown>)[MESSAGE];
    return typeof line === 'string' ? line : JSON.stringify(output);
  });
}

describe('every log transport redacts before it writes', () => {
  let directory: string;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'librechat-transports-'));
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const base: Env = {
    LOG_TO_FILE: 'false',
    CONSOLE_JSON: undefined,
    DEBUG_CONSOLE: undefined,
    DEBUG_LOGGING: undefined,
  };

  it.each<[string, Env]>([
    ['the plain console', {}],
    ['the JSON console', { CONSOLE_JSON: 'true' }],
    ['the debug console', { DEBUG_CONSOLE: 'true' }],
    ['the JSON debug console', { DEBUG_CONSOLE: 'true', CONSOLE_JSON: 'true' }],
    ['the error and debug files', { LOG_TO_FILE: 'true', DEBUG_LOGGING: 'true' }],
  ])('masks addresses and tokens on %s', async (_name, env) => {
    const logger = await loadTransports('winston', {
      ...base,
      LIBRECHAT_LOG_DIR: directory,
      ...env,
    });
    try {
      for (const level of ['error', 'debug']) {
        const lines = written(logger, level);
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
          expect(line).not.toMatch(/jane|secretcanary/);
        }
        expect(lines.join('\n')).toContain('[REDACTED_EMAIL]');
      }
    } finally {
      await close(logger);
    }
  });

  it('masks addresses and tokens on the Meili sync logger', async () => {
    const logger = await loadTransports('meiliLogger', {
      ...base,
      LIBRECHAT_LOG_DIR: directory,
      LOG_TO_FILE: 'true',
      DEBUG_LOGGING: 'true',
    });
    try {
      const lines = written(logger, 'error');
      expect(lines.length).toBe(2);
      for (const line of lines) {
        expect(line).not.toMatch(/jane|secretcanary/);
      }
    } finally {
      await close(logger);
    }
  });
});
