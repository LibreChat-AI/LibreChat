import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { run, repoRoot, inOneProject } from './lint.helpers';

/**
 * `/readyz` tells an orchestrator whether to route traffic to a pod. With
 * USE_REDIS on, a pod whose Redis connection dropped after startup cannot sign
 * anyone in, so it must report not ready until the connection returns, while
 * `/livez` stays green so a Redis blip never triggers a liveness restart loop.
 *
 * The outage half runs in a subprocess against a throwaway RESP server it owns:
 * the lab Redis is shared by every worktree and must never be stopped.
 */

const OUTAGE_PROBE = `
const net = require('node:net');
const http = require('node:http');

function parseFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length && buffer[offset] === 0x2a) {
    const headerEnd = buffer.indexOf('\\r\\n', offset);
    if (headerEnd === -1) break;
    const count = Number(buffer.subarray(offset + 1, headerEnd).toString());
    let cursor = headerEnd + 2;
    const args = [];
    for (let i = 0; i < count; i++) {
      const lengthEnd = buffer.indexOf('\\r\\n', cursor);
      if (lengthEnd === -1) return { frames, rest: buffer.subarray(offset) };
      const length = Number(buffer.subarray(cursor + 1, lengthEnd).toString());
      const end = lengthEnd + 2 + length;
      if (buffer.length < end + 2) return { frames, rest: buffer.subarray(offset) };
      args.push(buffer.subarray(lengthEnd + 2, end).toString());
      cursor = end + 2;
    }
    frames.push(args);
    offset = cursor;
  }
  return { frames, rest: buffer.subarray(offset) };
}

function reply([command = '']) {
  switch (command.toUpperCase()) {
    case 'PING':
      return '+PONG\\r\\n';
    case 'INFO': {
      const info = '# Server\\r\\nredis_version:7.2.4\\r\\nloading:0\\r\\n';
      return '$' + Buffer.byteLength(info) + '\\r\\n' + info + '\\r\\n';
    }
    default:
      return '+OK\\r\\n';
  }
}

function startRedis(port) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      const { frames, rest } = parseFrames(Buffer.concat([pending, chunk]));
      pending = rest;
      frames.forEach((frame) => socket.write(reply(frame)));
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
  });
  return new Promise((done) =>
    server.listen(port, '127.0.0.1', () =>
      done({
        port: server.address().port,
        stop: () =>
          new Promise((closed) => {
            sockets.forEach((socket) => socket.destroy());
            server.close(() => closed());
          }),
      }),
    ),
  );
}

const get = (port, path) =>
  new Promise((done, fail) =>
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => done(res.statusCode + ' ' + body));
    }).on('error', fail),
  );

async function until(check, expected, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last === expected) return last;
    await new Promise((wait) => setTimeout(wait, 50));
  }
  return last;
}

(async () => {
  let redis = await startRedis(0);
  process.env.USE_REDIS = 'true';
  process.env.REDIS_URI = 'redis://127.0.0.1:' + redis.port;
  process.env.REDIS_PING_INTERVAL = '0';
  process.env.REDIS_RETRY_MAX_DELAY = '100';

  const express = require('express');
  const { logger } = require('@librechat/data-schemas');
  logger.silent = true;
  const {
    cacheConfig,
    ioredisClient,
    keyvRedisClient,
    createReadinessHandler,
  } = require('@librechat/api');

  const app = express();
  app.get('/livez', (_req, res) => res.status(200).send('OK'));
  app.get(
    '/readyz',
    createReadinessHandler(() => true, {
      useRedis: cacheConfig.USE_REDIS,
      ioredis: ioredisClient,
      keyv: keyvRedisClient,
    }),
  );
  const listener = app.listen(0, '127.0.0.1');
  await new Promise((ready) => listener.once('listening', ready));
  const appPort = listener.address().port;
  const readyz = () => get(appPort, '/readyz');

  const observed = {};
  observed.connected = await until(readyz, '200 OK');
  await redis.stop();
  observed.down = await until(readyz, '503 NOT_READY');
  observed.liveWhileDown = await get(appPort, '/livez');
  redis = await startRedis(redis.port);
  observed.recovered = await until(readyz, '200 OK');

  process.stdout.write('RESULT' + JSON.stringify(observed));
  process.exit(0);
})().catch((error) => {
  process.stdout.write('ERROR' + (error && error.stack ? error.stack : String(error)));
  process.exit(1);
});
`;

test.describe('readiness probes', () => {
  test('a started pod reports ready and live while its dependencies are up @scenario:readyz-reports-ready-when-started-and-redis-connected', async ({
    request,
  }) => {
    const ready = await request.get('/readyz');
    expect(ready.status()).toBe(200);
    expect(await ready.text()).toBe('OK');

    const live = await request.get('/livez');
    expect(live.status()).toBe(200);
  });

  test('a pod whose Redis drops reports not ready but stays live, then recovers @scenario:readyz-reports-not-ready-while-redis-is-disconnected', () => {
    inOneProject();
    test.setTimeout(120_000);
    const result = run('node', ['-e', OUTAGE_PROBE], {
      cwd: resolve(repoRoot, 'packages/api'),
    });
    expect(result.status, result.output).toBe(0);

    const marker = result.stdout.lastIndexOf('RESULT');
    expect(marker, result.output).toBeGreaterThan(-1);
    const observed = JSON.parse(result.stdout.slice(marker + 'RESULT'.length));
    expect(observed).toEqual({
      connected: '200 OK',
      down: '503 NOT_READY',
      liveWhileDown: '200 OK',
      recovered: '200 OK',
    });
  });
});
