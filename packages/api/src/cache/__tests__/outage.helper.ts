import net from 'node:net';
import Redis from 'ioredis';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
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
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP address');
    }
    return address.port;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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
  let interruptSubscription = false;
  let interruptedSubscriptions = 0;
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
    let replyTail = '';
    const subscribeReply = '$9\r\nsubscribe\r\n';
    upstream.on('data', (chunk: Buffer) => {
      const reply = replyTail + chunk.toString('latin1');
      replyTail = reply.slice(-subscribeReply.length);
      if (interruptSubscription && reply.includes(subscribeReply)) {
        interruptSubscription = false;
        interruptedSubscriptions++;
        socket.destroy();
        upstream.destroy();
        return;
      }
      if (!dropReplies) {
        socket.write(chunk);
      }
    });
  });
  let dir: string | undefined;
  let child: ChildProcess | undefined;
  let childClosed: Promise<void> | undefined;
  let admin: Redis | undefined;
  let startupError: Error | undefined;
  const close = async (): Promise<void> => {
    admin?.disconnect();
    for (const socket of sockets) {
      socket.destroy();
    }
    const proxyClosed = new Promise<void>((resolve) => proxy.close(() => resolve()));
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
    await Promise.all([proxyClosed, childClosed]);
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  };

  try {
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const address = proxy.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP proxy address');
    }
    dir = await mkdtemp(join(tmpdir(), 'redis-outage-'));
    const binary = process.env.REDIS_SERVER_BIN ?? 'redis-server';
    child = spawn(
      binary,
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
    let stderr = '';
    child.stdout?.resume();
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4096);
    });
    child.on('error', (error: Error) => {
      startupError = new Error(`Unable to start Redis (${binary}): ${error.message}`, {
        cause: error,
      });
    });
    childClosed = new Promise<void>((resolve) => {
      child!.once('close', (code, signal) => {
        startupError ??= new Error(
          `Redis exited before becoming ready (code=${code}, signal=${signal}): ${stderr.trim()}`,
        );
        resolve();
      });
    });
    admin = new Redis(port, '127.0.0.1', {
      retryStrategy: () => 20,
      enableReadyCheck: false,
      maxRetriesPerRequest: 3,
      keyPrefix: '',
    });
    admin.on('error', () => undefined);
    await waitUntil(() => {
      if (startupError) {
        throw startupError;
      }
      return admin?.status === 'ready';
    });
    if (cluster) {
      await admin.cluster('ADDSLOTSRANGE', '0', '16383');
      const deadline = Date.now() + 5000;
      while (!((await admin.cluster('INFO')) as string).includes('cluster_state:ok')) {
        if (startupError) {
          throw startupError;
        }
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
      interruptNextSubscription: () => {
        interruptSubscription = true;
      },
      get interruptedSubscriptions() {
        return interruptedSubscriptions;
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
      close,
    };
  } catch (error) {
    const failure = startupError ?? error;
    await close();
    throw failure;
  }
}
