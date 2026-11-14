import net from 'node:net';
import Redis from 'ioredis';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Socket } from 'node:net';

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function waitUntil(predicate: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for Redis state');
    }
    await sleep(20);
  }
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP address');
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

/** Real Redis behind a TCP fault boundary, including the port advertised to Cluster clients. */
export async function startRedis(cluster: boolean) {
  const port = await freePort();
  let busPort = await freePort();
  while (busPort === port) {
    busPort = await freePort();
  }
  const sockets = new Set<Socket>();
  let blocked = false;
  let dropReplies = false;
  const proxy = net.createServer((socket) => {
    if (blocked) {
      socket.destroy();
      return;
    }
    const upstream = net.connect(port, '127.0.0.1');
    for (const connection of [socket, upstream]) {
      sockets.add(connection);
      connection.on('error', () => connection.destroy());
      connection.on('close', () => {
        sockets.delete(connection);
        socket.destroy();
        upstream.destroy();
      });
    }
    socket.pipe(upstream);
    upstream.on('data', (chunk) => {
      if (!dropReplies) {
        socket.write(chunk);
      }
    });
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const address = proxy.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP proxy address');
  }
  const dir = await mkdtemp(join(tmpdir(), 'redis-outage-'));
  const child = spawn(
    process.env.REDIS_SERVER_BIN ?? 'redis-server',
    [
      '--bind',
      '127.0.0.1',
      '--port',
      String(port),
      '--dir',
      dir,
      '--save',
      '',
      '--appendonly',
      'no',
      '--unixsocket',
      '',
      ...(cluster
        ? [
            '--cluster-enabled',
            'yes',
            '--cluster-config-file',
            'nodes.conf',
            '--cluster-port',
            String(busPort),
            '--cluster-announce-ip',
            '127.0.0.1',
            '--cluster-announce-port',
            String(address.port),
            '--cluster-announce-bus-port',
            String(busPort),
          ]
        : []),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const admin = new Redis(port, '127.0.0.1', {
    retryStrategy: () => 20,
    enableReadyCheck: false,
    maxRetriesPerRequest: 3,
    keyPrefix: '',
  });
  admin.on('error', () => undefined);
  await waitUntil(() => admin.status === 'ready');
  if (cluster) {
    await admin.cluster('ADDSLOTSRANGE', '0', '16383');
    const deadline = Date.now() + 5000;
    while (!((await admin.cluster('INFO')) as string).includes('cluster_state:ok')) {
      if (Date.now() > deadline) {
        throw new Error('Redis cluster did not become ready');
      }
      await sleep(50);
    }
  }
  return {
    url: `redis://127.0.0.1:${address.port}`,
    admin,
    dropReplies: () => {
      dropReplies = true;
    },
    block: () => {
      blocked = true;
      for (const socket of sockets) {
        socket.destroy();
      }
    },
    restore: () => {
      blocked = false;
      dropReplies = false;
    },
    close: async () => {
      admin.disconnect();
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, 'exit');
        child.kill('SIGTERM');
        await exit;
      }
      await rm(dir, { recursive: true });
    },
  };
}
