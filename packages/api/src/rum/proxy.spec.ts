jest.mock('~/app/metrics', () => ({
  recordRumProxyRequest: jest.fn(),
}));

import express from 'express';
import request from 'supertest';
import { createServer } from 'node:http';
import { logger } from '@librechat/data-schemas';
import type { Server } from 'node:http';
import { recordRumProxyRequest } from '~/app/metrics';
import {
  getRumProxyBodyLimit,
  getRumProxyClientUrl,
  getRumProxyTimeoutMs,
  getRumProxyTargetBaseUrl,
  isRumProxyEnabled,
  proxyRumRequest,
  resolveRumProxyTarget,
} from './proxy';

const makeResponse = () => {
  const res = {
    set: jest.fn(),
    send: jest.fn(),
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
};

describe('RUM proxy configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    jest.mocked(recordRumProxyRequest).mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uses the fixed LibreChat RUM proxy URL and default body limit', () => {
    delete process.env.RUM_PROXY_BODY_LIMIT;
    delete process.env.RUM_PROXY_TIMEOUT_MS;

    expect(getRumProxyClientUrl()).toBe('/api/rum');
    expect(getRumProxyBodyLimit()).toBe('3mb');
    expect(getRumProxyTimeoutMs()).toBe(10000);
  });

  it('uses a positive custom collector timeout', () => {
    process.env.RUM_PROXY_TIMEOUT_MS = '2500';
    expect(getRumProxyTimeoutMs()).toBe(2500);

    process.env.RUM_PROXY_TIMEOUT_MS = '-1';
    expect(getRumProxyTimeoutMs()).toBe(10000);
  });

  it('resolves OTLP paths against the configured collector base URL', () => {
    process.env.RUM_ENABLED = 'true';
    process.env.RUM_AUTH_MODE = 'proxy';
    process.env.RUM_PROXY_TARGET_URL = 'http://otel-collector:4318';

    expect(isRumProxyEnabled()).toBe(true);
    expect(resolveRumProxyTarget('/v1/traces')).toBe('http://otel-collector:4318/v1/traces');
    expect(resolveRumProxyTarget('/v1/logs')).toBe('http://otel-collector:4318/v1/logs');
    expect(resolveRumProxyTarget('/v1/metrics')).toBeUndefined();
  });

  it('does not enable proxy mode when RUM is disabled', () => {
    process.env.RUM_ENABLED = 'false';
    process.env.RUM_AUTH_MODE = 'proxy';
    process.env.RUM_PROXY_TARGET_URL = 'http://otel-collector:4318';

    expect(isRumProxyEnabled()).toBe(false);

    delete process.env.RUM_ENABLED;
    expect(isRumProxyEnabled()).toBe(false);
  });

  it('rejects unsafe collector target URLs', () => {
    process.env.RUM_PROXY_TARGET_URL = 'https://user:pass@collector.example.com';
    expect(getRumProxyTargetBaseUrl()).toBeUndefined();

    process.env.RUM_PROXY_TARGET_URL = 'file:///tmp/collector';
    expect(getRumProxyTargetBaseUrl()).toBeUndefined();
  });

  it('forwards OTLP requests without forwarding app authorization', async () => {
    process.env.RUM_ENABLED = 'true';
    process.env.RUM_AUTH_MODE = 'proxy';
    process.env.RUM_PROXY_TARGET_URL = 'http://otel-collector:4318';
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response('ok', {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = makeResponse();

    await proxyRumRequest(
      {
        path: '/v1/traces',
        body: { resourceSpans: [] },
        headers: {
          accept: 'application/json',
          authorization: 'Bearer app-token',
          'content-type': 'application/json',
        },
      } as never,
      res as never,
    );

    expect(fetchMock).toHaveBeenCalledWith('http://otel-collector:4318/v1/traces', {
      method: 'POST',
      redirect: 'follow',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ resourceSpans: [] }),
      signal: expect.any(AbortSignal),
    });
    expect(res.set).toHaveBeenCalledWith('content-type', 'application/json');
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.send).toHaveBeenCalledWith(Buffer.from('ok'));
    expect(recordRumProxyRequest).toHaveBeenCalledWith('traces', 'success');

    fetchMock.mockRestore();
  });

  it('returns 400 for missing payloads and 404 for unsupported OTLP paths', async () => {
    process.env.RUM_ENABLED = 'true';
    process.env.RUM_AUTH_MODE = 'proxy';
    process.env.RUM_PROXY_TARGET_URL = 'http://otel-collector:4318';
    const missingBodyRes = makeResponse();
    const unsupportedPathRes = makeResponse();

    await proxyRumRequest({ path: '/v1/traces', headers: {} } as never, missingBodyRes as never);
    await proxyRumRequest(
      { path: '/v1/metrics', body: Buffer.from('payload'), headers: {} } as never,
      unsupportedPathRes as never,
    );

    expect(missingBodyRes.status).toHaveBeenCalledWith(400);
    expect(unsupportedPathRes.status).toHaveBeenCalledWith(404);
    expect(recordRumProxyRequest).toHaveBeenCalledWith('traces', 'bad_request');
    expect(recordRumProxyRequest).toHaveBeenCalledWith('unknown', 'not_configured');
  });

  it('returns 502 when the collector request fails', async () => {
    process.env.RUM_ENABLED = 'true';
    process.env.RUM_AUTH_MODE = 'proxy';
    process.env.RUM_PROXY_TARGET_URL = 'http://otel-collector:4318';
    const fetchMock = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('collector down'));
    const res = makeResponse();

    await proxyRumRequest(
      { path: '/v1/traces', body: Buffer.from('payload'), headers: {} } as never,
      res as never,
    );

    expect(res.status).toHaveBeenCalledWith(502);
    expect(recordRumProxyRequest).toHaveBeenCalledWith('traces', 'collector_error');
    fetchMock.mockRestore();
  });

  it('records collector error status classes', async () => {
    process.env.RUM_ENABLED = 'true';
    process.env.RUM_AUTH_MODE = 'proxy';
    process.env.RUM_PROXY_TARGET_URL = 'http://otel-collector:4318';
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('nope', { status: 503 }));
    const res = makeResponse();

    await proxyRumRequest(
      { path: '/v1/logs', body: Buffer.from('payload'), headers: {} } as never,
      res as never,
    );

    expect(res.status).toHaveBeenCalledWith(503);
    expect(recordRumProxyRequest).toHaveBeenCalledWith('logs', 'collector_5xx');
    fetchMock.mockRestore();
  });
});

describe('RUM proxy upstream HTTP contract', () => {
  const originalEnv = process.env;
  let collector: Server;
  let collectorUrl: string;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    jest.mocked(recordRumProxyRequest).mockClear();
    collector = createServer();
    await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));
    const address = collector.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP collector address');
    }
    collectorUrl = `http://127.0.0.1:${address.port}`;
    process.env.RUM_PROXY_TARGET_URL = collectorUrl;
  });

  afterEach(async () => {
    process.env = originalEnv;
    collector.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      collector.close((error) => (error ? reject(error) : resolve())),
    );
  });

  function createProxy(authorization?: string) {
    const app = express();
    app.use(express.raw({ type: '*/*' }));
    app.post('/v1/:signal', (req, res) => proxyRumRequest(req, res, authorization));
    return app;
  }

  it.each(['traces', 'logs'])(
    'sends only server credentials and intact %s payloads',
    async (signal) => {
      const payload = Buffer.from([0x0a, 0x02, 0x00, 0xff]);
      const received: {
        authorization?: string;
        cookie?: string;
        apiKey?: string;
        path?: string;
        body: Buffer;
      } = {
        body: Buffer.alloc(0),
      };
      collector.on('request', (req, res) => {
        received.authorization = req.headers.authorization;
        received.cookie = req.headers.cookie;
        received.apiKey = req.headers['x-api-key']?.toString();
        received.path = req.url;
        req.on('data', (chunk: Buffer) => {
          received.body = Buffer.concat([received.body, chunk]);
        });
        req.on('end', () => {
          res.writeHead(202, { 'content-type': 'application/x-protobuf' });
          res.end(Buffer.from([0x00]));
        });
      });

      const response = await request(createProxy('  clickstack-ingestion-key  '))
        .post(`/v1/${signal}`)
        .set('Content-Type', 'application/x-protobuf')
        .set('Authorization', 'Bearer librechat-session-token')
        .set('Cookie', 'refreshToken=private-cookie')
        .set('X-Api-Key', 'browser-supplied-key')
        .send(payload);

      expect(response.status).toBe(202);
      expect(received).toEqual({
        authorization: 'clickstack-ingestion-key',
        cookie: undefined,
        apiKey: undefined,
        path: `/v1/${signal}`,
        body: payload,
      });
      expect(recordRumProxyRequest).toHaveBeenCalledWith(signal, 'success');
    },
  );

  it.each([undefined, '', '   '])(
    'preserves unauthenticated collectors with authorization %p',
    async (authorization) => {
      let receivedAuthorization: string | undefined;
      collector.on('request', (req, res) => {
        receivedAuthorization = req.headers.authorization;
        req.resume();
        res.writeHead(200);
        res.end('{}');
      });
      const response = await request(createProxy(authorization))
        .post('/v1/logs')
        .set('Authorization', 'Bearer app-token')
        .set('Content-Type', 'application/json')
        .send('{}');

      expect(response.status).toBe(200);
      expect(receivedAuthorization).toBeUndefined();
    },
  );

  it.each([301, 302, 303, 307, 308])(
    'does not follow a credentialed %s redirect, even on the same origin',
    async (status) => {
      const paths: string[] = [];
      collector.on('request', (req, res) => {
        paths.push(req.url ?? '');
        req.resume();
        res.writeHead(status, { location: `${collectorUrl}/redirect-target` });
        res.end();
      });
      const response = await request(createProxy('clickstack-ingestion-key'))
        .post('/v1/traces')
        .set('Content-Type', 'application/json')
        .send('{}');

      expect(response.status).toBe(502);
      expect(paths).toEqual(['/v1/traces']);
      expect(response.headers.location).toBeUndefined();
      expect(recordRumProxyRequest).toHaveBeenCalledWith('traces', 'collector_error');
    },
  );

  it.each(['private-key\r\ninjected: value', 'private-key-😀'])(
    'rejects invalid credentials without leaking them',
    async (authorization) => {
      const fetchSpy = jest.spyOn(global, 'fetch');
      const logSpy = jest.spyOn(logger, 'warn');
      const response = await request(createProxy(authorization))
        .post('/v1/traces')
        .set('Content-Type', 'application/json')
        .send('{}');

      expect(response.status).toBe(502);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith('[rumProxy] Failed to proxy RUM telemetry', {
        error: 'Invalid RUM proxy authorization header',
        target: `${collectorUrl}/v1/traces`,
      });
      expect(response.text).not.toContain('private-key');
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain('private-key');
    },
  );
});
