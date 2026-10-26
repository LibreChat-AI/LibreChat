/**
 * Unit tests for the RESP Sentinel discovery parser.
 *
 * These tests exercise `querySentinelMaster` over a real TCP server
 * (127.0.0.1 listener) that emulates the minimal Sentinel protocol responses,
 * covering: normal discovery, AUTH, error replies, timeouts, and fallback
 * through multiple Sentinel nodes.
 */

import net from 'net';

type SentinelModule = typeof import('./sentinel');

const loadSentinel = (): SentinelModule => {
  let mod: SentinelModule | undefined;
  jest.isolateModules(() => {
    mod = jest.requireActual<SentinelModule>('./sentinel');
  });
  if (!mod) {
    throw new Error('sentinel module failed to load');
  }
  return mod;
};

/** RESP encode helpers for the mock server. */
function respBulk(s: string): string {
  return `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
}
function respArray(items: string[]): string {
  return `*${items.length}\r\n${items.map(respBulk).join('')}`;
}

describe('querySentinelMaster (mock TCP server)', () => {
  const { querySentinelMaster, discoverSentinelMaster } = loadSentinel();

  /** Starts a one-shot mock Sentinel listener on a random localhost port. */
  const startMockSentinel = (
    handler: (data: Buffer, conn: net.Socket) => void,
  ): Promise<{ port: number; close: () => void }> => {
    return new Promise((resolve) => {
      const server = net.createServer((conn) => {
        conn.on('data', (data) => handler(data, conn));
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        resolve({
          port: addr.port,
          close: () => server.close(),
        });
      });
    });
  };

  it('discovers master ip/port from a SENTINEL MASTER reply', async () => {
    const { port, close } = await startMockSentinel((data, conn) => {
      const s = data.toString();
      if (s.includes('SENTINEL')) {
        const reply = respArray([
          'name',
          'mymaster',
          'ip',
          '10.0.0.5',
          'port',
          '6379',
          'flags',
          'master',
        ]);
        conn.write(reply);
      }
    });
    try {
      const master = await querySentinelMaster({ host: '127.0.0.1', port }, 'mymaster', {
        timeoutMs: 2000,
      });
      expect(master).toEqual({ host: '10.0.0.5', port: 6379 });
    } finally {
      close();
    }
  }, 5000);

  it('authenticates with password before querying when provided', async () => {
    let authReceived = false;
    const { port, close } = await startMockSentinel((data, conn) => {
      const s = data.toString();
      if (s.includes('AUTH')) {
        authReceived = true;
        conn.write(respBulk('OK'));
      }
      if (s.includes('SENTINEL')) {
        if (!authReceived) {
          conn.write(`-ERR unauthenticated\r\n`);
          return;
        }
        const reply = respArray(['ip', '10.0.0.6', 'port', '6380']);
        conn.write(reply);
      }
    });
    try {
      const master = await querySentinelMaster({ host: '127.0.0.1', port }, 'mymaster', {
        password: 'secret',
        timeoutMs: 2000,
      });
      expect(authReceived).toBe(true);
      expect(master).toEqual({ host: '10.0.0.6', port: 6380 });
    } finally {
      close();
    }
  }, 5000);

  it('rejects on SENTINEL error reply', async () => {
    const { port, close } = await startMockSentinel((_data, conn) => {
      conn.write(`-ERR unknown master\r\n`);
    });
    try {
      await expect(
        querySentinelMaster({ host: '127.0.0.1', port }, 'nonexistent', { timeoutMs: 2000 }),
      ).rejects.toThrow('Sentinel error');
    } finally {
      close();
    }
  }, 5000);

  it('rejects on connection refused', async () => {
    // Find a free port by opening and immediately closing a listener.
    const tmp = net.createServer();
    const freePort: number = await new Promise((resolve) => {
      tmp.listen(0, '127.0.0.1', () => {
        const addr = tmp.address() as net.AddressInfo;
        tmp.close(() => resolve(addr.port));
      });
    });
    await expect(
      querySentinelMaster({ host: '127.0.0.1', port: freePort }, 'mymaster', { timeoutMs: 2000 }),
    ).rejects.toThrow('connection');
  }, 5000);

  it('times out on an unresponsive Sentinel', async () => {
    const { port, close } = await startMockSentinel(() => {
      // accept the connection but never reply
    });
    try {
      await expect(
        querySentinelMaster({ host: '127.0.0.1', port }, 'mymaster', { timeoutMs: 300 }),
      ).rejects.toThrow('timed out');
    } finally {
      close();
    }
  }, 5000);

  it('falls back to the next Sentinel node when the first fails', async () => {
    // First sentinel: always unresponsive (accepts but never replies)
    const deadSentinel = await startMockSentinel(() => {});
    // Second sentinel: healthy
    let sentinelQueried = false;
    const goodSentinel = await startMockSentinel((data, conn) => {
      const s = data.toString();
      if (s.includes('SENTINEL')) {
        sentinelQueried = true;
        conn.write(respArray(['ip', '10.0.0.7', 'port', '6379']));
      }
    });
    try {
      const master = await discoverSentinelMaster(
        [
          { host: '127.0.0.1', port: deadSentinel.port },
          { host: '127.0.0.1', port: goodSentinel.port },
        ],
        'mymaster',
        { timeoutMs: 500 },
      );
      expect(master).toEqual({ host: '10.0.0.7', port: 6379 });
      expect(sentinelQueried).toBe(true);
    } finally {
      deadSentinel.close();
      goodSentinel.close();
    }
  }, 10000);

  it('rejects with all node errors when every Sentinel is unreachable', async () => {
    const unreachableHost = '127.0.0.1';
    // Use an impossible-to-connect port (1 is never a listener)
    const nodes = [1, 2, 3].map((p) => ({ host: unreachableHost, port: p }));
    await expect(discoverSentinelMaster(nodes, 'mymaster', { timeoutMs: 500 })).rejects.toThrow(
      'Failed to discover master',
    );
  }, 10000);
});
