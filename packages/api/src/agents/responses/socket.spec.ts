import { z } from 'zod';
import WebSocket from 'ws';
import express from 'express';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  responseSocketToolNames,
  installResponseSockets,
  admitResponseSocket,
  acceptResponseSocket,
  RESPONSE_SOCKET_PATH,
} from './socket';

async function fixture(
  options: {
    enabled?: boolean;
    maxConnectionMs?: number;
    maxMessageBytes?: number;
    maxConnections?: number;
    maxCacheBytes?: number;
    maxQueuedTurns?: number;
    tenantMaxQueuedTurns?: number;
    tenantMaxMessageBytes?: number;
  } = {},
) {
  const app = express();
  let authorized = true;
  let admissions = 0;
  let owner = 'owner';
  let tenantId = 'tenant';
  const replayNames: string[][] = [];
  const predecessors: unknown[] = [];
  const receivedHeaders: import('node:http').IncomingHttpHeaders[] = [];
  let cancelled!: () => void;
  const cancellation = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  const inputs: unknown[] = [];
  let seq = 0;
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.headers.authorization !== 'Bearer fixture' || !authorized) {
      res.status(401).json({ error: { code: 'unauthorized', message: 'Unauthorized' } });
      return;
    }
    admissions++;
    Object.assign(req, {
      user: { id: owner, tenantId },
      config: {
        endpoints: {
          agents: {
            responses: {
              websocket: {
                enabled: options.enabled ?? true,
                maxQueuedTurns: options.tenantMaxQueuedTurns,
                maxMessageBytes: options.tenantMaxMessageBytes,
              },
            },
          },
        },
      },
    });
    next();
  });
  app.get(RESPONSE_SOCKET_PATH, admitResponseSocket, acceptResponseSocket);
  app.post(RESPONSE_SOCKET_PATH, admitResponseSocket, async (req, res) => {
    if (req.body.previous_response_id === 'storage-outage') {
      res
        .status(503)
        .json({ error: { code: 'response_storage_unavailable', message: 'Unavailable' } });
      return;
    }
    if (
      req.body.previous_response_id != null &&
      req.body.previous_response_id !== 'stored-response'
    ) {
      res.status(404).json({ error: { code: 'response_not_found', message: 'Not found' } });
      return;
    }
    inputs.push(req.body.input);
    predecessors.push(req.body.previous_response_id);
    replayNames.push([...responseSocketToolNames(req)]);
    receivedHeaders.push(req.headers);
    if (JSON.stringify(req.body).includes('bad-output')) {
      res.status(400).json({ error: { code: 'bad_input', message: 'Invalid input' } });
      return;
    }
    res.setHeader('content-type', 'text/event-stream');
    res.write(
      `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: `r${seq + 1}`, status: 'in_progress', output: [] } })}\n\n`,
    );
    if (req.body.input === 'wait') {
      res.once('close', cancelled);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (res.destroyed) return;
    res.end(
      `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: `r${++seq}`, status: 'completed', output: req.body.tools ? [{ type: 'function_call', name: 'client_tool', call_id: 'call1', arguments: '{}' }] : [{ type: 'message', role: 'assistant', content: 'hello' }], tools: req.body.tools } })}\n\n`,
    );
  });
  const server = createServer(app);
  const stop = installResponseSockets({
    server,
    application: app,
    limits: {
      maxConnectionMs: options.maxConnectionMs ?? 60000,
      maxMessageBytes: options.maxMessageBytes ?? 1024,
      maxConnections: options.maxConnections ?? 256,
      maxQueuedTurns: options.maxQueuedTurns ?? 4,
      maxCacheBytes: options.maxCacheBytes ?? 4194304,
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${RESPONSE_SOCKET_PATH}`;
  const connect = async () => {
    const ws = new WebSocket(url, {
      headers: {
        Authorization: 'Bearer fixture',
        'Idempotency-Key': 'handshake-only',
        'X-Request-Id': 'handshake-id',
      },
    });
    await once(ws, 'open');
    return ws;
  };
  return {
    connect,
    url,
    inputs,
    replayNames,
    predecessors,
    receivedHeaders,
    changeTenant: () => {
      tenantId = 'other';
    },
    get admissions() {
      return admissions;
    },
    cancellation,
    changeOwner: () => {
      owner = 'other';
    },
    revoke: () => {
      authorized = false;
    },
    stop: async () => {
      await stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
const replySchema = z.object({
  type: z.string(),
  status: z.number().optional(),
  response: z
    .object({ id: z.string(), previous_response_id: z.string().nullable().optional() })
    .passthrough()
    .optional(),
  error: z.object({ code: z.string() }).passthrough().optional(),
});
type Reply = z.infer<typeof replySchema>;
function response(ws: WebSocket, body: object): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData) => {
      const event = replySchema.parse(JSON.parse(raw.toString()));
      if (['response.completed', 'error'].includes(event.type)) {
        ws.off('message', onMessage);
        ws.off('error', reject);
        resolve(event);
      }
    };
    ws.on('message', onMessage);
    ws.once('error', reject);
    ws.send(JSON.stringify({ type: 'response.create', model: 'agent', store: false, ...body }));
  });
}

it('authenticates the upgrade and each turn, retaining history only on that connection', async () => {
  const f = await fixture();
  try {
    const ws = await f.connect();
    const first = await response(ws, { input: 'first' });
    const second = await response(ws, {
      previous_response_id: first.response?.id,
      input: 'second',
    });
    expect(second.response?.previous_response_id).toBe(first.response?.id);
    expect(f.inputs[1]).toEqual([
      { type: 'message', role: 'user', content: 'first' },
      { type: 'message', role: 'assistant', content: 'hello' },
      { type: 'message', role: 'user', content: 'second' },
    ]);
    expect(f.admissions).toBe(3);
    const other = await f.connect();
    expect(
      (await response(other, { previous_response_id: first.response?.id, input: 'foreign' })).error
        ?.code,
    ).toBe('previous_response_not_found');
    f.revoke();
    expect((await response(ws, { input: 'revoked' })).status).toBe(401);
    expect(f.inputs).toHaveLength(2);
  } finally {
    await f.stop();
  }
});
it('evicts the referenced state after a failed continuation', async () => {
  const f = await fixture();
  try {
    const ws = await f.connect();
    const first = await response(ws, { input: 'first' });
    expect(
      (await response(ws, { previous_response_id: first.response?.id, input: 'bad-output' }))
        .status,
    ).toBe(400);
    expect(
      (await response(ws, { previous_response_id: first.response?.id, input: 'retry' })).error
        ?.code,
    ).toBe('previous_response_not_found');
  } finally {
    await f.stop();
  }
});
it('does not upgrade a disabled transport', async () => {
  const f = await fixture({ enabled: false });
  try {
    const ws = new WebSocket(f.url, { headers: { Authorization: 'Bearer fixture' } });
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => {
        resolve(res.statusCode!);
        res.resume();
        ws.terminate();
      });
      ws.on('error', () => {});
    });
    expect(status).toBe(404);
  } finally {
    await f.stop();
  }
});
it('serializes turns on one connection and enforces the lifetime', async () => {
  const f = await fixture({ maxConnectionMs: 1000 });
  try {
    const ws = await f.connect();
    const ids: string[] = [];
    ws.on('message', (raw) => {
      const e = replySchema.parse(JSON.parse(raw.toString()));
      if (e.type === 'response.completed') ids.push(e.response!.id);
    });
    ws.send(JSON.stringify({ type: 'response.create', model: 'agent', input: 'one' }));
    ws.send(JSON.stringify({ type: 'response.create', model: 'agent', input: 'two' }));
    const final = await new Promise<Reply>((resolve) =>
      ws.on('message', (raw) => {
        const e = replySchema.parse(JSON.parse(raw.toString()));
        if (e.type === 'error') resolve(e);
      }),
    );
    expect(ids).toEqual(['r1', 'r2']);
    expect(final.error?.code).toBe('websocket_connection_limit_reached');
  } finally {
    await f.stop();
  }
});

it('aborts the in-flight HTTP execution when the client disconnects', async () => {
  const f = await fixture();
  try {
    const ws = await f.connect();
    const first = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'response.create', model: 'agent', input: 'wait' }));
    await first;
    ws.terminate();
    await expect(f.cancellation).resolves.toBeUndefined();
  } finally {
    await f.stop();
  }
});
it.each(['owner', 'tenant', 'model'])(
  'does not reuse cached history after %s changes',
  async (kind) => {
    const f = await fixture();
    try {
      const ws = await f.connect();
      const first = await response(ws, { input: 'first' });
      if (kind === 'owner') f.changeOwner();
      if (kind === 'tenant') f.changeTenant();
      const next = await response(ws, {
        model: kind === 'model' ? 'other' : 'agent',
        previous_response_id: first.response?.id,
        input: 'next',
      });
      expect(next.error?.code).toBe('previous_response_not_found');
      expect(f.inputs).toHaveLength(1);
    } finally {
      await f.stop();
    }
  },
);
it('bounds queued turns without running an overlapping request', async () => {
  const f = await fixture({ maxQueuedTurns: 1 });
  try {
    const ws = await f.connect();
    const first = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'response.create', model: 'agent', input: 'wait' }));
    await first;
    const closed = once(ws, 'close');
    ws.send(JSON.stringify({ type: 'response.create', model: 'agent', input: 'overlap' }));
    expect((await closed)[0]).toBe(1008);
    await expect(f.cancellation).resolves.toBeUndefined();
    expect(f.inputs).toHaveLength(1);
  } finally {
    await f.stop();
  }
});
it('bounds the upgraded payload before it reaches the HTTP application', async () => {
  const f = await fixture();
  try {
    const ws = await f.connect();
    const closed = once(ws, 'close');
    ws.send('x'.repeat(2048));
    expect((await closed)[0]).toBe(1009);
    expect(f.inputs).toHaveLength(0);
  } finally {
    await f.stop();
  }
});
it('caps upgraded connections without affecting existing sessions', async () => {
  const f = await fixture({ maxConnections: 1 });
  try {
    const ws = await f.connect();
    const rejected = new WebSocket(f.url, { headers: { Authorization: 'Bearer fixture' } });
    const status = await new Promise<number>((resolve) => {
      rejected.on('unexpected-response', (_request, res) => {
        resolve(res.statusCode!);
        res.resume();
        rejected.terminate();
      });
      rejected.on('error', () => {});
    });
    expect(status).toBe(503);
    expect((await response(ws, { input: 'still works' })).type).toBe('response.completed');
  } finally {
    await f.stop();
  }
});

it('orders invalid frames after the active turn instead of interleaving errors', async () => {
  const f = await fixture();
  try {
    const ws = await f.connect();
    const events: string[] = [];
    const invalid = new Promise<void>((resolve) =>
      ws.on('message', (raw) => {
        const event = replySchema.parse(JSON.parse(raw.toString()));
        events.push(event.type);
        if (event.type === 'error') resolve();
      }),
    );
    ws.send(JSON.stringify({ type: 'response.create', model: 'agent', input: 'first' }));
    ws.send('{malformed');
    await invalid;
    expect(events).toEqual(['response.created', 'response.completed', 'error']);
    expect(f.inputs).toHaveLength(1);
  } finally {
    await f.stop();
  }
});
it('retains only bounded history and drops handshake request identifiers', async () => {
  const f = await fixture({ maxCacheBytes: 1024 });
  try {
    const ws = await f.connect();
    const first = await response(ws, { input: 'a'.repeat(900) });
    // Input fits admission but its completed history exceeds the cache budget.
    expect(
      (await response(ws, { previous_response_id: first.response?.id, input: 'next' })).error?.code,
    ).toBe('previous_response_not_found');
    expect(f.receivedHeaders[0]['idempotency-key']).toBeUndefined();
    expect(f.receivedHeaders[0]['x-request-id']).toBeUndefined();
  } finally {
    await f.stop();
  }
});
it('retains client tool replay names without adding executors to later requests', async () => {
  const f = await fixture();
  try {
    const ws = await f.connect();
    const first = await response(ws, {
      input: 'tool',
      tools: [
        { type: 'function', name: 'client_tool' },
        { type: 'function', name: 'unused' },
      ],
    });
    await response(ws, {
      previous_response_id: first.response?.id,
      input: [{ type: 'function_call_output', call_id: 'call1', output: 'ok' }],
    });
    expect(f.replayNames).toEqual([[], ['client_tool']]);
  } finally {
    await f.stop();
  }
});
it('cancels active execution and closes clients during server shutdown', async () => {
  const f = await fixture();
  const ws = await f.connect();
  const first = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'response.create', model: 'agent', input: 'wait' }));
  await first;
  const closed = once(ws, 'close');
  await f.stop();
  expect((await closed)[0]).toBe(1006);
  await expect(f.cancellation).resolves.toBeUndefined();
});

it('applies stricter tenant queue limits at authenticated upgrade', async () => {
  const f = await fixture({ maxQueuedTurns: 4, tenantMaxQueuedTurns: 1 });
  try {
    const ws = await f.connect();
    const first = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'response.create', model: 'agent', input: 'wait' }));
    await first;
    const closed = once(ws, 'close');
    ws.send(JSON.stringify({ type: 'response.create', model: 'agent', input: 'queued' }));
    expect((await closed)[0]).toBe(1008);
    await expect(f.cancellation).resolves.toBeUndefined();
  } finally {
    await f.stop();
  }
});
it('applies a stricter tenant payload limit before queueing a turn', async () => {
  const f = await fixture({ maxMessageBytes: 4096, tenantMaxMessageBytes: 1024 });
  try {
    const ws = await f.connect();
    const closed = once(ws, 'close');
    ws.send('x'.repeat(2048));
    expect((await closed)[0]).toBe(1009);
    expect(f.inputs).toHaveLength(0);
  } finally {
    await f.stop();
  }
});

it('refuses persisted fallback with store:false and allows ordinary lookup with store:true', async () => {
  const f = await fixture();
  try {
    const ws = await f.connect();
    expect(
      (
        await response(ws, {
          previous_response_id: 'stored-response',
          store: false,
          input: 'must not read',
        })
      ).error?.code,
    ).toBe('previous_response_not_found');
    expect(f.inputs).toHaveLength(0);
    expect(
      (
        await response(ws, {
          previous_response_id: 'stored-response',
          store: true,
          input: 'continue stored',
        })
      ).type,
    ).toBe('response.completed');
    expect(
      (
        await response(ws, {
          previous_response_id: 'storage-outage',
          store: true,
          input: 'continue',
        })
      ).error?.code,
    ).toBe('response_storage_unavailable');
    expect(f.predecessors).toEqual(['stored-response']);
  } finally {
    await f.stop();
  }
});
