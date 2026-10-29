jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import http from 'node:http';
import net from 'node:net';
import { logger } from '@librechat/data-schemas';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { JwtExtractor } from './jwt';
import { createJwtExtractor, resolveJwtAuthHeader } from './jwt';

const request = (headers: IncomingHttpHeaders) => ({ headers });

/** Sends raw header lines through a real HTTP server so Node's own duplicate handling applies. */
const receiveHeaders = (headerLines: string[]): Promise<IncomingHttpHeaders> =>
  new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      resolve(req.headers);
      res.end();
      server.close();
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.end(
          ['GET / HTTP/1.1', 'Host: localhost', ...headerLines, 'Connection: close', '', ''].join(
            '\r\n',
          ),
        );
      });
      socket.on('error', reject);
      socket.resume();
    });
  });

describe('createJwtExtractor', () => {
  let fallback: JwtExtractor;

  beforeEach(() => {
    fallback = jest.fn(() => 'from-authorization');
  });

  describe('when no header is configured', () => {
    it('returns the fallback unchanged', () => {
      expect(createJwtExtractor(undefined, fallback)).toBe(fallback);
      expect(createJwtExtractor('', fallback)).toBe(fallback);
      expect(createJwtExtractor('   ', fallback)).toBe(fallback);
    });
  });

  describe('when a header is configured', () => {
    it('reads a raw token from it', () => {
      const extract = createJwtExtractor('x-original-authorization', fallback);

      expect(extract(request({ 'x-original-authorization': 'raw.jwt.value' }))).toBe(
        'raw.jwt.value',
      );
      expect(fallback).not.toHaveBeenCalled();
    });

    it('accepts a value that still carries the Bearer scheme', () => {
      const extract = createJwtExtractor('x-original-authorization', fallback);

      expect(extract(request({ 'x-original-authorization': 'Bearer raw.jwt.value' }))).toBe(
        'raw.jwt.value',
      );
      expect(extract(request({ 'x-original-authorization': 'bearer   raw.jwt.value' }))).toBe(
        'raw.jwt.value',
      );
      expect(fallback).not.toHaveBeenCalled();
    });

    it('lowercases the configured name, since node lowercases incoming headers', () => {
      const extract = createJwtExtractor('X-Original-Authorization', fallback);

      expect(extract(request({ 'x-original-authorization': 'raw.jwt.value' }))).toBe(
        'raw.jwt.value',
      );
    });

    it('trims the configured name', () => {
      const extract = createJwtExtractor('  x-original-authorization  ', fallback);

      expect(extract(request({ 'x-original-authorization': 'raw.jwt.value' }))).toBe(
        'raw.jwt.value',
      );
    });

    it('falls back when the header is absent, empty or scheme-only', () => {
      const extract = createJwtExtractor('x-original-authorization', fallback);

      expect(extract(request({ authorization: 'Bearer other.jwt' }))).toBe('from-authorization');
      expect(extract(request({ 'x-original-authorization': '' }))).toBe('from-authorization');
      expect(extract(request({ 'x-original-authorization': '   ' }))).toBe('from-authorization');
      expect(extract(request({ 'x-original-authorization': 'Bearer ' }))).toBe(
        'from-authorization',
      );
      expect(fallback).toHaveBeenCalledTimes(4);
    });

    it('ignores a header sent more than once rather than guessing which value to trust', async () => {
      const extract = createJwtExtractor('x-original-authorization', fallback);
      const headers = await receiveHeaders([
        'X-Original-Authorization: Bearer first.jwt',
        'X-Original-Authorization: Bearer second.jwt',
      ]);

      expect(headers['x-original-authorization']).toBe('Bearer first.jwt, Bearer second.jwt');
      expect(extract(request(headers))).toBe('from-authorization');
      expect(fallback).toHaveBeenCalledTimes(1);
    });

    it('reads a header sent once through a real request', async () => {
      const extract = createJwtExtractor('X-Original-Authorization', fallback);
      const headers = await receiveHeaders(['X-Original-Authorization: Bearer raw.jwt.value']);

      expect(extract(request(headers))).toBe('raw.jwt.value');
      expect(fallback).not.toHaveBeenCalled();
    });

    it('passes the same request to the fallback', () => {
      const extract = createJwtExtractor('x-original-authorization', fallback);
      const req = request({ authorization: 'Bearer other.jwt' });

      extract(req);

      expect(fallback).toHaveBeenCalledWith(req);
    });
  });
});

describe('resolveJwtAuthHeader', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('prefers the yaml header over JWT_AUTH_HEADER', () => {
    expect(
      resolveJwtAuthHeader(
        { header: 'x-yaml-authorization' },
        { JWT_AUTH_HEADER: 'x-env-authorization' },
      ),
    ).toBe('x-yaml-authorization');
  });

  it('falls back to JWT_AUTH_HEADER when yaml leaves the header unset', () => {
    const env = { JWT_AUTH_HEADER: ' X-Env-Authorization ' };

    expect(resolveJwtAuthHeader(undefined, env)).toBe('X-Env-Authorization');
    expect(resolveJwtAuthHeader({}, env)).toBe('X-Env-Authorization');
  });

  it('configures no header when neither source sets one', () => {
    expect(resolveJwtAuthHeader(undefined, {})).toBeUndefined();
    expect(resolveJwtAuthHeader({}, { JWT_AUTH_HEADER: '   ' })).toBeUndefined();
  });

  it('ignores an invalid header name instead of reading an unreachable key', () => {
    expect(resolveJwtAuthHeader(undefined, { JWT_AUTH_HEADER: 'x-auth: value' })).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
