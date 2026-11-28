import { request } from 'undici';
import { createServer } from 'node:http';
import { connect, createServer as createTCPServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import type { Dispatcher } from 'undici';
import { getProxyDispatcher } from './proxy';

const proxyKeys = [
  'PROXY',
  'proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
];
const originalEnv = process.env;
const timeouts = { bodyTimeout: 0, headersTimeout: 500 };
/** Never contacted when the proxy is silent; the proxy only sees it as the CONNECT target. */
const target = 'https://model.example/v1/chat/completions';
const cleanups: Array<() => Promise<unknown> | unknown> = [];

beforeEach(() => {
  process.env = { ...originalEnv };
  for (const key of proxyKeys) delete process.env[key];
});
afterEach(async () => {
  process.env = originalEnv;
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function listen(server: Server): Promise<number> {
  const sockets = new Set<Socket>();
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined).on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return (server.address() as AddressInfo).port;
}

/** A proxy that accepts the TCP connection and never answers the CONNECT request. */
async function silentProxy(): Promise<string> {
  return `http://127.0.0.1:${await listen(createTCPServer())}`;
}

/** A working CONNECT proxy that records what it was asked to tunnel to. */
async function tunnelingProxy(): Promise<{ url: string; tunneled: string[] }> {
  const tunneled: string[] = [];
  const server = createServer();
  server.on('connect', (req, client, head) => {
    tunneled.push(req.url ?? '');
    const [host, port] = (req.url ?? '').split(':');
    const upstream = connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    for (const socket of [client, upstream]) {
      socket.on('error', () => undefined);
      cleanups.push(() => socket.destroy());
    }
  });
  return { url: `http://127.0.0.1:${await listen(server)}`, tunneled };
}

async function origin(): Promise<string> {
  const server = createServer((_req, res) => res.end('ok'));
  return `http://127.0.0.1:${await listen(server)}/`;
}

function own(dispatcher: Dispatcher | undefined): Dispatcher {
  if (!dispatcher) throw new Error('expected a proxy dispatcher');
  cleanups.push(() => dispatcher.destroy());
  return dispatcher;
}

/** What `promise` settled with (`resolved` or the error code), or `pending` if still waiting. */
async function settle(promise: Promise<unknown>, ms: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve('pending'), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => 'resolved',
        (error: { code?: string }) => error.code ?? String(error),
      ),
      pending,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Real sockets, no undici mock: the CONNECT handshake is made by a client undici builds itself, and
 * only a request that goes through a proxy can show which timeouts that client carries.
 */
describe('proxy CONNECT tunnel', () => {
  it.each(['explicit', 'environment'])(
    'gives up on a silent %s proxy at the configured headers timeout',
    async (source) => {
      const proxy = await silentProxy();
      if (source === 'environment') process.env.PROXY = proxy;
      const dispatcher = own(
        getProxyDispatcher(source === 'explicit' ? proxy : undefined, timeouts),
      );

      expect(await settle(request(target, { dispatcher }), 5_000)).toBe('UND_ERR_HEADERS_TIMEOUT');
    },
  );

  it('still tunnels a request through a proxy that answers', async () => {
    const proxy = await tunnelingProxy();
    const url = await origin();
    const dispatcher = own(getProxyDispatcher(proxy.url, timeouts));

    const response = await request(url, { dispatcher });

    expect(response.statusCode).toBe(200);
    expect(await response.body.text()).toBe('ok');
    expect(proxy.tunneled).toEqual([new URL(url).host]);
  });

  it('still sends NO_PROXY hosts direct', async () => {
    process.env.PROXY = await silentProxy();
    process.env.NO_PROXY = '127.0.0.1';
    const url = await origin();
    const dispatcher = own(getProxyDispatcher(undefined, timeouts));

    const response = await request(url, { dispatcher });

    expect(await response.body.text()).toBe('ok');
  });
});
