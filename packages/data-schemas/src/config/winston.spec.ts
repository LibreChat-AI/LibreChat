import winston from 'winston';
import { stripHeavyErrorFields } from './parsers';

const SPLAT = Symbol.for('splat');

const buildAxiosErrorWithHeavyAgent = (): Error => {
  const sockets: Record<string, unknown> = {};
  for (let i = 0; i < 500; i++) {
    sockets[`socket-${i}`] = {
      _tlsOptions: { session: 'A'.repeat(1024) },
      bytesRead: i,
    };
  }
  const httpsAgent = {
    sockets,
    freeSockets: sockets,
    _tlsOptions: { session: 'B'.repeat(2048) },
    maxSockets: Infinity,
  };
  const config = {
    method: 'post',
    url: 'http://rag-api/query',
    httpsAgent,
    headers: { Authorization: 'Bearer secret' },
  };

  const error = new Error('Request failed with status code 404') as Error & {
    name: string;
    code: string;
    isAxiosError: boolean;
    config: unknown;
    request: unknown;
    response: unknown;
    httpsAgent: unknown;
  };
  error.name = 'AxiosError';
  error.code = 'ERR_BAD_REQUEST';
  error.isAxiosError = true;
  error.config = config;
  error.request = { socket: { _handle: {} }, agent: httpsAgent };
  error.response = {
    status: 404,
    statusText: 'Not Found',
    headers: { 'content-type': 'application/json' },
    data: { detail: 'not found' },
    config,
    request: { agent: httpsAgent },
  };
  error.httpsAgent = httpsAgent;
  return error;
};

describe('stripHeavyErrorFields', () => {
  const runTransform = (info: Record<string | symbol, unknown>) => {
    const format = stripHeavyErrorFields();
    return format.transform(
      info as unknown as import('winston').Logform.TransformableInfo,
      format.options,
    );
  };

  it('drops config/httpsAgent from a logged AxiosError while keeping message/stack/status', () => {
    const error = buildAxiosErrorWithHeavyAgent();
    const info = {
      level: 'error',
      message: 'Error encountered in `file_search` while querying file:',
      [SPLAT]: [error],
    } as Record<string | symbol, unknown>;

    const out = runTransform(info) as Record<string | symbol, unknown>;
    const sanitizedError = (out[SPLAT] as unknown[])[0];
    const serialized = JSON.stringify(sanitizedError);

    expect(serialized).not.toContain('httpsAgent');
    expect(serialized).not.toContain('_tlsOptions');
    expect(serialized).not.toContain('sockets');
    expect(serialized).not.toContain('freeSockets');
    expect(serialized).not.toMatch(/"config"/);

    const parsed = JSON.parse(serialized);
    expect(parsed.message).toBe('Request failed with status code 404');
    expect(typeof parsed.stack).toBe('string');
    expect(parsed.name).toBe('AxiosError');
    expect(parsed.code).toBe('ERR_BAD_REQUEST');
    expect(parsed.requestInfo).toEqual({ method: 'post', url: 'http://rag-api/query' });
    expect(parsed.response.status).toBe(404);
    expect(parsed.response.statusText).toBe('Not Found');
    expect(parsed.response.data).toEqual({ detail: 'not found' });

    // Everything except the (intentionally kept) stack trace is tiny: the heavy
    // object graph is gone.
    const { stack: _stack, ...withoutStack } = parsed;
    expect(JSON.stringify(withoutStack).length).toBeLessThan(1024);

    // The sanitized error is a tiny fraction of the raw object graph
    // (the raw AxiosError serializes its socket/TLS pool into hundreds of KB).
    const rawSize = JSON.stringify(error).length;
    expect(serialized.length).toBeLessThan(rawSize / 50);
  });

  it('does not mutate the caller-owned error object', () => {
    const error = buildAxiosErrorWithHeavyAgent();
    const info = {
      level: 'error',
      message: 'boom',
      [SPLAT]: [error],
    } as Record<string | symbol, unknown>;

    runTransform(info);

    // Original error is untouched (downstream code may still rethrow/read it).
    expect((error as unknown as { config: unknown }).config).toBeDefined();
    expect((error as unknown as { httpsAgent: unknown }).httpsAgent).toBeDefined();
  });

  it('leaves non-error levels untouched', () => {
    const info = { level: 'info', message: 'hello' } as Record<string | symbol, unknown>;
    const out = runTransform(info);
    expect(out).toBe(info);
  });

  it('strips heavy fields hoisted to top-level info by winston for `logger.error(msg, err)`', () => {
    // A token-less message makes winston merge the error's enumerable props
    // (config/httpsAgent/...) onto the top-level info object, not just into [splat].
    const captured: unknown[] = [];
    const capture = winston.format((info) => {
      captured.push(JSON.parse(JSON.stringify(info)));
      return info;
    });
    const logger = winston.createLogger({
      level: 'error',
      format: winston.format.combine(
        winston.format.errors({ stack: true }),
        stripHeavyErrorFields(),
        capture(),
        winston.format.splat(),
      ),
      transports: [new winston.transports.Console({ silent: true })],
    });

    logger.error(
      'Error encountered in `file_search` while querying file:',
      buildAxiosErrorWithHeavyAgent(),
    );

    const serialized = JSON.stringify(captured[0]);
    expect(serialized).not.toContain('httpsAgent');
    expect(serialized).not.toContain('_tlsOptions');
    expect(serialized).not.toContain('sockets');
    expect(serialized).not.toMatch(/"config"/);
    expect(serialized.length).toBeLessThan(4096);

    const record = captured[0] as Record<string, unknown>;
    expect(record.requestInfo).toEqual({ method: 'post', url: 'http://rag-api/query' });
    expect((record.response as Record<string, unknown>).status).toBe(404);
    expect(typeof record.message).toBe('string');
  });

  it('preserves config/request/response on a non-Axios error while still stripping agent internals', () => {
    const sockets: Record<string, unknown> = { s0: { _tlsOptions: { session: 'X'.repeat(2048) } } };
    const httpsAgent = {
      sockets,
      freeSockets: sockets,
      _tlsOptions: { session: 'Y'.repeat(2048) },
    };
    const error = new Error('ENOENT: no such file or directory') as Error & {
      httpsAgent: unknown;
      config: unknown;
      request: unknown;
      response: unknown;
    };
    error.httpsAgent = httpsAgent;
    error.config = { method: 'get', url: 'http://internal/resource' };
    error.request = { id: 'req-123' };
    error.response = { status: 503, statusText: 'Service Unavailable', traceId: 'trace-abc' };

    const info = {
      level: 'error',
      message: 'non-axios failure',
      [SPLAT]: [error],
    } as Record<string | symbol, unknown>;

    const out = runTransform(info) as Record<string | symbol, unknown>;
    const sanitizedError = (out[SPLAT] as unknown[])[0];
    const serialized = JSON.stringify(sanitizedError);

    expect(serialized).not.toContain('httpsAgent');
    expect(serialized).not.toContain('_tlsOptions');
    expect(serialized).not.toContain('freeSockets');

    const parsed = JSON.parse(serialized);
    expect(parsed.config).toEqual({ method: 'get', url: 'http://internal/resource' });
    expect(parsed.request).toEqual({ id: 'req-123' });
    expect(parsed.response).toEqual({
      status: 503,
      statusText: 'Service Unavailable',
      traceId: 'trace-abc',
    });
    expect(parsed.requestInfo).toBeUndefined();
    expect(parsed.message).toBe('ENOENT: no such file or directory');
  });

  it('still reduces a genuine AxiosError (config dropped, requestInfo derived, response compacted)', () => {
    const error = buildAxiosErrorWithHeavyAgent();
    const info = {
      level: 'error',
      message: 'axios failure',
      [SPLAT]: [error],
    } as Record<string | symbol, unknown>;

    const out = runTransform(info) as Record<string | symbol, unknown>;
    const sanitizedError = (out[SPLAT] as unknown[])[0];
    const serialized = JSON.stringify(sanitizedError);

    expect(serialized).not.toContain('httpsAgent');
    expect(serialized).not.toMatch(/"config"/);

    const parsed = JSON.parse(serialized);
    expect(parsed.config).toBeUndefined();
    expect(parsed.requestInfo).toEqual({ method: 'post', url: 'http://rag-api/query' });
    expect(parsed.response.status).toBe(404);
  });
});
