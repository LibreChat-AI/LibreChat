import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { createSdkPeer } from './peer';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const limits = {
  maxFrameBytes: 65536,
  maxBufferedBytes: 131072,
  timeoutMs: 2000,
  onClose: () => undefined,
};
async function pair() {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const connected = once(server, 'connection');
  const worker = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
  await once(worker, 'open');
  const [host] = (await connected) as [WebSocket];
  return {
    host,
    worker,
    close: async () => {
      host.terminate();
      worker.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('remote SDK event and policy ordering', () => {
  it('applies preceding async events before a hook, then allows subsequent events', async () => {
    const sockets = await pair();
    const release = deferred();
    const started = deferred();
    const receivedHook = deferred();
    const lastEvent = deferred();
    const order: string[] = [];
    sockets.host.on('message', (raw) => {
      if (JSON.parse(raw.toString()).method === 'hook') receivedHook.resolve();
    });
    createSdkPeer(sockets.host, {
      ...limits,
      onCall: async () => {
        order.push('hook');
        return 'allowed';
      },
      onFrame: async (frame) => {
        if (frame.type !== 'event') throw new Error('Unexpected frame');
        if (frame.name === 'first') {
          order.push('first started');
          started.resolve();
          await release.promise;
          order.push('first finished');
        } else {
          order.push('second');
          lastEvent.resolve();
        }
      },
    });
    const worker = createSdkPeer(sockets.worker, {
      ...limits,
      onCall: async () => undefined,
      onFrame: async () => undefined,
    });
    try {
      worker.send({ type: 'event', name: 'first', data: {} });
      const hook = worker.call('hook', {});
      void hook.catch(() => undefined);
      worker.send({ type: 'event', name: 'second', data: {} });
      await Promise.all([started.promise, receivedHook.promise]);
      expect(order).toEqual(['first started']);
      release.resolve();
      await expect(hook).resolves.toBe('allowed');
      await lastEvent.promise;
      expect(order).toEqual(['first started', 'first finished', 'hook', 'second']);
    } finally {
      release.resolve();
      await sockets.close();
    }
  });
  it('processes reentrant RPC replies while an event and following hook are waiting', async () => {
    const sockets = await pair();
    const order: string[] = [];
    const host = createSdkPeer(sockets.host, {
      ...limits,
      onCall: async () => {
        order.push('hook');
        return 'allowed';
      },
      onFrame: async () => {
        order.push(String(await host.call('read', {})));
      },
    });
    const worker = createSdkPeer(sockets.worker, {
      ...limits,
      onCall: async () => 'reentrant result',
      onFrame: async () => undefined,
    });
    try {
      worker.send({ type: 'event', name: 'first', data: {} });
      await expect(worker.call('hook', {})).resolves.toBe('allowed');
      expect(order).toEqual(['reentrant result', 'hook']);
    } finally {
      await sockets.close();
    }
  });
});
