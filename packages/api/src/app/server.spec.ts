import { createServer } from 'node:http';
import { logger } from '@librechat/data-schemas';
import { configureServerTimeouts } from './server';

describe('configureServerTimeouts', () => {
  const NODE = {};
  const BUN = { bun: '1.3.13' };

  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('preserves Node.js defaults when variables are unset', () => {
    const server = createServer();
    const defaults = {
      keepAliveTimeout: server.keepAliveTimeout,
      keepAliveTimeoutBuffer: server.keepAliveTimeoutBuffer,
      headersTimeout: server.headersTimeout,
      requestTimeout: server.requestTimeout,
    };

    configureServerTimeouts(server, {});

    expect(server.keepAliveTimeout).toBe(defaults.keepAliveTimeout);
    expect(server.keepAliveTimeoutBuffer).toBe(defaults.keepAliveTimeoutBuffer);
    expect(server.headersTimeout).toBe(defaults.headersTimeout);
    expect(server.requestTimeout).toBe(defaults.requestTimeout);
  });

  it('applies configured timeout values', () => {
    const server = createServer();

    configureServerTimeouts(server, {
      HTTP_KEEP_ALIVE_TIMEOUT_MS: '70000',
      HTTP_KEEP_ALIVE_TIMEOUT_BUFFER_MS: '5000',
      HTTP_HEADERS_TIMEOUT_MS: '80000',
      HTTP_REQUEST_TIMEOUT_MS: '300000',
    });

    expect(server.keepAliveTimeout).toBe(70_000);
    expect(server.keepAliveTimeoutBuffer).toBe(5_000);
    expect(server.headersTimeout).toBe(80_000);
    expect(server.requestTimeout).toBe(300_000);
  });

  it('ignores invalid values and permits zero to disable a timeout', () => {
    const server = createServer();
    const defaultKeepAliveTimeout = server.keepAliveTimeout;
    const defaultHeadersTimeout = server.headersTimeout;

    configureServerTimeouts(server, {
      HTTP_KEEP_ALIVE_TIMEOUT_MS: '-1',
      HTTP_KEEP_ALIVE_TIMEOUT_BUFFER_MS: '0',
      HTTP_HEADERS_TIMEOUT_MS: 'not-a-number',
      HTTP_REQUEST_TIMEOUT_MS: '0',
    });

    expect(server.keepAliveTimeout).toBe(defaultKeepAliveTimeout);
    expect(server.keepAliveTimeoutBuffer).toBe(0);
    expect(server.headersTimeout).toBe(defaultHeadersTimeout);
    expect(server.requestTimeout).toBe(0);
  });

  it('clamps the headers timeout when only a lower request timeout is configured', () => {
    const server = createServer();

    configureServerTimeouts(server, { HTTP_REQUEST_TIMEOUT_MS: '45000' }, NODE);

    expect(server.requestTimeout).toBe(45_000);
    expect(server.headersTimeout).toBe(45_000);
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves the headers timeout alone when it already fits the request timeout', () => {
    const server = createServer();

    configureServerTimeouts(server, { HTTP_REQUEST_TIMEOUT_MS: '300000' }, NODE);

    expect(server.headersTimeout).toBe(60_000);
  });

  it('warns and clamps when both timeouts are configured in conflict', () => {
    const server = createServer();

    configureServerTimeouts(
      server,
      { HTTP_HEADERS_TIMEOUT_MS: '80000', HTTP_REQUEST_TIMEOUT_MS: '45000' },
      NODE,
    );

    expect(server.headersTimeout).toBe(45_000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('a pairing Node rejects'));
  });

  it('treats zero as disabled on either side rather than clamping', () => {
    const disabledRequest = createServer();
    configureServerTimeouts(
      disabledRequest,
      { HTTP_HEADERS_TIMEOUT_MS: '5000', HTTP_REQUEST_TIMEOUT_MS: '0' },
      NODE,
    );
    expect(disabledRequest.headersTimeout).toBe(5_000);

    const disabledHeaders = createServer();
    configureServerTimeouts(
      disabledHeaders,
      { HTTP_HEADERS_TIMEOUT_MS: '0', HTTP_REQUEST_TIMEOUT_MS: '10000' },
      NODE,
    );
    expect(disabledHeaders.headersTimeout).toBe(0);
  });

  it('produces a pairing Node itself accepts', () => {
    const server = createServer();

    configureServerTimeouts(server, { HTTP_REQUEST_TIMEOUT_MS: '45000' }, NODE);

    expect(() =>
      createServer({
        headersTimeout: server.headersTimeout,
        requestTimeout: server.requestTimeout,
      }).close(),
    ).not.toThrow();
  });

  it('warns that Bun does not enforce the configured timeouts', () => {
    configureServerTimeouts(createServer(), { HTTP_KEEP_ALIVE_TIMEOUT_MS: '70000' }, BUN);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Bun does not enforce them'));
  });

  it('stays quiet under Bun when no timeout is configured', () => {
    configureServerTimeouts(createServer(), {}, BUN);

    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn about the runtime under Node.js', () => {
    configureServerTimeouts(createServer(), { HTTP_KEEP_ALIVE_TIMEOUT_MS: '70000' }, NODE);

    expect(warn).not.toHaveBeenCalled();
  });

  it('warns when header or request timeouts fall below the connection sweep interval', () => {
    configureServerTimeouts(
      createServer(),
      { HTTP_HEADERS_TIMEOUT_MS: '5000', HTTP_REQUEST_TIMEOUT_MS: '10000' },
      NODE,
    );

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('HTTP_HEADERS_TIMEOUT_MS, HTTP_REQUEST_TIMEOUT_MS'),
    );
  });

  it('does not warn about sweep resolution for zero or above-interval timeouts', () => {
    configureServerTimeouts(
      createServer(),
      {
        HTTP_KEEP_ALIVE_TIMEOUT_MS: '1000',
        HTTP_HEADERS_TIMEOUT_MS: '80000',
        HTTP_REQUEST_TIMEOUT_MS: '0',
      },
      NODE,
    );

    expect(warn).not.toHaveBeenCalled();
  });
});
