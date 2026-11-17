import net from 'node:net';
import Redis from 'ioredis';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs/promises';
import childProcess from 'node:child_process';
import { startRedis } from './outage.helper';

describe.each([false, true])('Redis outage fixture startup (cluster=%s)', (cluster) => {
  let env: NodeJS.ProcessEnv;
  let dir: string;
  let servers: jest.SpiedFunction<typeof net.createServer>;
  let directories: jest.SpiedFunction<typeof fs.mkdtemp>;
  let disconnect: jest.SpiedFunction<typeof Redis.prototype.disconnect>;
  let spawned: jest.SpiedFunction<typeof childProcess.spawn>;

  beforeAll(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'redis-fixture-test-'));
    await fs.writeFile(
      join(dir, 'exits'),
      `#!${process.execPath}\nprocess.stderr.write('fixture startup refused\\n', () => process.exit(23));\n`,
      { mode: 0o755 },
    );
    await fs.writeFile(
      join(dir, 'idle'),
      `#!${process.execPath}\nsetInterval(() => undefined, 1000);\n`,
      { mode: 0o755 },
    );
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
    expect(servers).toHaveBeenCalledTimes(3);
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
    process.env.REDIS_SERVER_BIN = join(dir, 'exits');
    await expect(startRedis(cluster)).rejects.toThrow(
      'Redis exited before becoming ready (code=23, signal=null): fixture startup refused',
    );
    await expectCleanup();
  }, 3000);

  it('terminates a live child and removes its resources when readiness times out', async () => {
    process.env.REDIS_SERVER_BIN = join(dir, 'idle');
    await expect(startRedis(cluster)).rejects.toThrow('Timed out waiting for Redis state');
    expect(spawned).toHaveBeenCalledTimes(1);
    expect(spawned.mock.results[0].value.signalCode).toBe('SIGTERM');
    await expectCleanup();
  });

  it('closes the proxy if allocating the Redis directory fails', async () => {
    const error = new Error('fixture directory unavailable');
    directories.mockRejectedValueOnce(error);
    await expect(startRedis(cluster)).rejects.toBe(error);
    expectServersClosed();
    expect(disconnect).not.toHaveBeenCalled();
  });
});
