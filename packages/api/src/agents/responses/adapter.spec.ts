import express from 'express';
import { Socket } from 'node:net';
import { IncomingMessage } from 'node:http';
import { dispatchResponseHttp } from './adapter';

function source() {
  const request = new IncomingMessage(new Socket());
  request.headers = {
    authorization: 'Bearer test',
    'content-length': '999',
    'content-encoding': 'gzip',
    upgrade: 'websocket',
    connection: 'Upgrade',
    'sec-websocket-key': 'test',
    'idempotency-key': 'upgrade-key',
    'x-request-id': 'upgrade-id',
  };
  Object.assign(request, { user: { id: 'stale' }, config: { stale: true } });
  return request;
}
it('dispatches native requests through the full app without copying prior identity or HTTP request headers', async () => {
  const app = express();
  app.use(express.json());
  app.post('/response', (req, res) => {
    expect(req.headers.authorization).toBe('Bearer test');
    expect(req.headers.upgrade).toBeUndefined();
    expect(req.headers['idempotency-key']).toBeUndefined();
    expect(req.headers['x-request-id']).toBeUndefined();
    expect(Reflect.get(req, 'user')).toBeUndefined();
    expect(Reflect.get(req, 'config')).toBeUndefined();
    expect(req.body).toEqual({ input: 'héllo 🌎' });
    res.status(201).json({ value: 'résumé 🌎' });
  });
  const output: Buffer[] = [];
  const call = dispatchResponseHttp({
    application: app,
    source: source(),
    path: '/response',
    method: 'POST',
    body: { input: 'héllo 🌎' },
    maxBufferedBytes: 4096,
    onBody: (chunk) => {
      output.push(chunk);
    },
  });
  expect((await call.done).status).toBe(201);
  expect(JSON.parse(Buffer.concat(output).toString('utf8'))).toEqual({ value: 'résumé 🌎' });
});
it('bounds queued native output even when a producer ignores backpressure', async () => {
  const app = express();
  let closed = false;
  app.get('/response', (_req, res) => {
    res.on('close', () => {
      closed = true;
    });
    res.setHeader('content-type', 'text/plain');
    for (let i = 0; i < 100 && !res.destroyed; i++) res.write('x'.repeat(512));
    if (!res.destroyed) res.end();
  });
  let release!: () => void;
  const reading = new Promise<void>((resolve) => {
    release = resolve;
  });
  const call = dispatchResponseHttp({
    application: app,
    source: source(),
    path: '/response',
    method: 'GET',
    maxBufferedBytes: 1024,
    onBody: () => reading,
  });
  await expect(call.done).rejects.toThrow('buffer limit');
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(closed).toBe(true);
});
