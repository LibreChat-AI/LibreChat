import net from 'node:net';
import Redis from 'ioredis';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs/promises';
import childProcess from 'node:child_process';
import { startRedis } from './outage.helper';

const { spawn } = childProcess;

describe.each([false, true])('Redis outage fixture startup (cluster=%s)', (cluster) => {
  let env: NodeJS.ProcessEnv;
  let dir: string;
  let servers: jest.SpiedFunction<typeof net.createServer>;
  let directories: jest.SpiedFunction<typeof fs.mkdtemp>;
  let disconnect: jest.SpiedFunction<typeof Redis.prototype.disconnect>;
  let spawned: jest.SpiedFunction<typeof childProcess.spawn>;

  beforeAll(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'redis-fixture-test-'));
  });

  beforeEach(() => {
    env = { ...process.env };
    servers = jest.spyOn(net, 'createServer');
    directories = jest.spyOn(fs, 'mkdtemp');
    disconnect = jest.spyOn(Redis.prototype, 'disconnect');
    spawned = jest.spyOn(childProcess, 'spawn');
  });

  afterEach(() => {
    process.env = env;
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const expectServersClosed = (): void => {
    expect(servers.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const result of servers.mock.results) {
      if (result.type === 'return') {
        expect(result.value.listening).toBe(false);
      }
    }
  };

  const expectCleanup = async (): Promise<void> => {
    expectServersClosed();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(directories).toHaveBeenCalledTimes(1);
    const directory: string = await directories.mock.results[0].value;
    await expect(fs.access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  };

  it('rejects a missing binary promptly and closes its proxy, admin, and directory', async () => {
    const binary = join(dir, 'missing-redis-server');
    process.env.REDIS_SERVER_BIN = binary;
    await expect(startRedis(cluster)).rejects.toThrow(
      `Unable to start Redis (${binary}): spawn ${binary} ENOENT`,
    );
    await expectCleanup();
  }, 3000);

  it('reports an early exit with its code and stderr, then cleans up', async () => {
    spawned.mockImplementationOnce((_file, _args, options) =>
      spawn(
        process.execPath,
        ['-e', 'process.stderr.write("fixture startup refused", () => process.exit(23))'],
        options,
      ),
    );
    await expect(startRedis(cluster)).rejects.toThrow(
      'Redis exited before becoming ready (code=23, signal=null): fixture startup refused',
    );
    await expectCleanup();
  }, 3000);

  it('terminates a live child and removes its resources when readiness times out', async () => {
    spawned.mockImplementationOnce((_file, _args, options) =>
      spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options),
    );
    await expect(startRedis(cluster)).rejects.toThrow('Timed out waiting for Redis state');
    expect(spawned).toHaveBeenCalledTimes(1);
    expect(spawned.mock.results[0].value.signalCode).toBe('SIGTERM');
    await expectCleanup();
  });

  it('closes the proxy and reused port reservations if allocating the Redis directory fails', async () => {
    const listen = net.Server.prototype.listen;
    const ports: number[] = [];
    const reservePort = function (this: net.Server): net.Server {
      this.once('listening', () => {
        const address = this.address();
        if (!address || typeof address === 'string') {
          throw new Error('Expected a TCP reservation address');
        }
        ports.push(address.port);
      });
      return listen.call(this, { port: ports[0] ?? 0, host: '127.0.0.1' });
    };
    // Rebind the first released port twice, then leave allocation to the OS.
    jest
      .spyOn(net.Server.prototype, 'listen')
      .mockImplementationOnce(reservePort)
      .mockImplementationOnce(reservePort)
      .mockImplementationOnce(reservePort);
    const error = new Error('fixture directory unavailable');
    directories.mockRejectedValueOnce(error);
    await expect(startRedis(cluster)).rejects.toBe(error);
    expect(ports[0]).toBeGreaterThan(0);
    expect(ports).toEqual([ports[0], ports[0], ports[0]]);
    expect(servers.mock.calls.length).toBeGreaterThanOrEqual(5);
    expectServersClosed();
    expect(directories).toHaveBeenCalledTimes(1);
    expect(spawned).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
  });
});
