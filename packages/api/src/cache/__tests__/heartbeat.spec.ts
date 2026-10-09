import Redis from 'ioredis';
import type { HeartbeatClient } from '~/cache/heartbeat';
import type { RespServer } from './resp.helper';
import { startRedisHeartbeat, forceRedisReconnect } from '~/cache/heartbeat';
import { startRespServer, waitFor } from './resp.helper';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const countCommands = (server: RespServer, name: string): number =>
  server.commands.filter((frame) => frame[0]?.toUpperCase() === name).length;

describe('startRedisHeartbeat', () => {
  let server: RespServer;
  let client: Redis;
  let stop: () => void = () => undefined;

  beforeEach(async () => {
    server = await startRespServer();
    client = new Redis(server.url, {
      lazyConnect: true,
      maxRetriesPerRequest: null,
      retryStrategy: () => 10,
    });
    client.on('error', () => undefined);
    await client.connect();
  });

  afterEach(async () => {
    stop();
    client.disconnect();
    await server.close();
  });

  it('leaves an answering connection alone', async () => {
    stop = startRedisHeartbeat({ client, intervalMs: 20, timeoutMs: 200, label: 'test' });
    await waitFor(() => countCommands(server, 'PING') >= 3);
    expect(server.connections).toBe(1);
    expect(client.status).toBe('ready');
  });

  it('tears down a socket whose peer stops answering so ioredis reconnects and replays', async () => {
    stop = startRedisHeartbeat({ client, intervalMs: 20, timeoutMs: 60, label: 'test' });
    server.silent = true;
    const pending = client.get('key');

    await waitFor(() => client.status !== 'ready');
    server.silent = false;

    await expect(pending).resolves.toBeNull();
    await waitFor(() => client.status === 'ready');
    expect(server.connections).toBe(2);
  });

  it('sends one probe at a time while a reply is outstanding', async () => {
    stop = startRedisHeartbeat({ client, intervalMs: 20, timeoutMs: 5000, label: 'test' });
    server.silent = true;
    await waitFor(() => countCommands(server, 'PING') >= 1);
    await sleep(100);
    expect(countCommands(server, 'PING')).toBe(1);
    expect(server.connections).toBe(1);
  });

  it('re-subscribes a subscriber connection after forcing it to reconnect', async () => {
    await client.subscribe('events');
    stop = startRedisHeartbeat({ client, intervalMs: 20, timeoutMs: 60, label: 'test' });
    await waitFor(() => countCommands(server, 'PING') >= 2);
    expect(server.connections).toBe(1);

    server.silent = true;
    await waitFor(() => client.status !== 'ready');
    server.silent = false;

    await waitFor(() => countCommands(server, 'SUBSCRIBE') >= 2);
    await waitFor(() => client.status === 'ready');
    expect(server.connections).toBe(2);
  });

  it('stops probing once the client has ended', async () => {
    stop = startRedisHeartbeat({ client, intervalMs: 20, timeoutMs: 200, label: 'test' });
    await waitFor(() => countCommands(server, 'PING') >= 1);
    client.disconnect();
    await waitFor(() => client.status === 'end');
    const sent = countCommands(server, 'PING');
    await sleep(100);
    expect(countCommands(server, 'PING')).toBe(sent);
  });

  it('does nothing when the interval is not positive', () => {
    stop = startRedisHeartbeat({ client, intervalMs: 0, timeoutMs: 200, label: 'test' });
    expect(client.listenerCount('end')).toBe(0);
  });

  it('disables itself instead of reconnecting on every tick when the deadline is not positive', async () => {
    stop = startRedisHeartbeat({ client, intervalMs: 20, timeoutMs: 0, label: 'test' });
    expect(client.listenerCount('end')).toBe(0);
    await sleep(100);
    expect(countCommands(server, 'PING')).toBe(0);
    expect(server.connections).toBe(1);
  });
});

describe('startRedisHeartbeat on a cluster', () => {
  type FakeNode = HeartbeatClient & {
    destroy: jest.Mock;
    pings: number;
    pingsAtDestroy: number[];
  };

  const fakeNode = (host: string, answers: boolean, status = 'ready'): FakeNode => {
    const node: FakeNode = {
      status,
      options: { host, port: 6379 },
      pings: 0,
      pingsAtDestroy: [],
      destroy: jest.fn(() => {
        node.pingsAtDestroy.push(node.pings);
      }),
      ping: () => {
        node.pings += 1;
        return answers ? Promise.resolve('PONG') : new Promise(() => undefined);
      },
      on: () => undefined,
      off: () => undefined,
      disconnect: jest.fn(),
      stream: { destroyed: false, destroy: (error?: Error) => node.destroy(error) },
    };
    return node;
  };

  const fakeCluster = (nodes: FakeNode[]): HeartbeatClient & { ping: jest.Mock } => ({
    status: 'ready',
    ping: jest.fn(() => Promise.resolve('PONG')),
    on: () => undefined,
    off: () => undefined,
    disconnect: jest.fn(),
    nodes: () => nodes,
  });

  it('probes every node and tears down only the one that stops answering', async () => {
    const healthy = fakeNode('10.0.0.1', true);
    const dead = fakeNode('10.0.0.2', false);
    const cluster = fakeCluster([healthy, dead]);
    const stop = startRedisHeartbeat({
      client: cluster,
      intervalMs: 10,
      timeoutMs: 40,
      label: 'cluster',
    });

    await waitFor(() => dead.destroy.mock.calls.length >= 1);
    stop();

    expect(cluster.ping).not.toHaveBeenCalled();
    expect(healthy.pings).toBeGreaterThanOrEqual(2);
    expect(healthy.destroy).not.toHaveBeenCalled();
    expect(dead.pingsAtDestroy[0]).toBe(1);
    expect((dead.destroy.mock.calls[0][0] as Error).message).toContain('10.0.0.2:6379');
  });

  it('skips nodes that are not ready', async () => {
    const ready = fakeNode('10.0.0.1', true);
    const reconnecting = fakeNode('10.0.0.2', false, 'reconnecting');
    const stop = startRedisHeartbeat({
      client: fakeCluster([ready, reconnecting]),
      intervalMs: 10,
      timeoutMs: 40,
      label: 'cluster',
    });

    await waitFor(() => ready.pings >= 2);
    await sleep(60);
    stop();

    expect(reconnecting.pings).toBe(0);
    expect(reconnecting.destroy).not.toHaveBeenCalled();
  });
});

describe('forceRedisReconnect', () => {
  it('falls back to a regular reconnect when the client exposes no socket', () => {
    const disconnect = jest.fn();
    forceRedisReconnect(
      {
        status: 'ready',
        ping: () => Promise.resolve(),
        on: () => undefined,
        off: () => undefined,
        disconnect,
      },
      'test',
    );
    expect(disconnect).toHaveBeenCalledWith(true);
  });

  it('destroys the live socket with the reason instead of ending it', () => {
    const destroy = jest.fn();
    const disconnect = jest.fn();
    forceRedisReconnect(
      {
        status: 'ready',
        ping: () => Promise.resolve(),
        on: () => undefined,
        off: () => undefined,
        disconnect,
        stream: { destroyed: false, destroy },
      },
      'peer vanished',
    );
    expect(destroy).toHaveBeenCalledTimes(1);
    expect((destroy.mock.calls[0][0] as Error).message).toBe('peer vanished');
    expect(disconnect).not.toHaveBeenCalled();
  });
});
