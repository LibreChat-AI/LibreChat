import { once } from 'node:events';
import { createHash } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { HumanMessage } from '@librechat/agents/langchain/messages';
import { Run, Providers, FakeChatModel, GraphEvents } from '@librechat/agents';
import { Annotation, StateGraph, START, END, messagesStateReducer } from '@langchain/langgraph';
import { createHostFileService, HostFileAdmission, HostFileServiceError } from '@librechat/agents';
import type { HostFileDescriptor, HostFileStore } from '@librechat/agents';
import type { RunConfig, RunStepResumeState } from '@librechat/agents';
import type { AddressInfo } from 'node:net';
import { createHostFileChannel, createWorkerFileChannel } from './files';
import { createPolicyReceiver, createPolicySender } from './sealed';
import { createRemoteSdkServer } from './server';
import { createRemoteSdkRun } from './client';
import { remoteSdkLimits } from './types';
import { encodeSdkValue } from './wire';
import { createSdkPeer } from './peer';

const identity = {
  runtimeId: 'runtime',
  agentId: 'agent',
  userId: 'user',
  tenantId: 'tenant',
  runId: 'run',
  conversationId: 'conversation',
};
const descriptor = {
  version: 1 as const,
  operations: ['read', 'stage', 'publish'] as const,
  maxFileBytes: 1024 * 1024,
  maxChunkBytes: 4,
};
const source: HostFileDescriptor = {
  reference: 'input',
  revision: 'v1',
  filename: 'input.txt',
  mediaType: 'text/plain',
  bytes: 8,
};
const bytes = Buffer.from('abcdefgh');
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const limits = remoteSdkLimits({ rpcTimeoutMs: 1000, maxRunMs: 5000 });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
async function collect(content: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of content) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function storage() {
  const records = new Map<string, { file: HostFileDescriptor; data: Uint8Array }>([
    [source.reference, { file: source, data: bytes }],
  ]);
  const publications = new Map<string, HostFileDescriptor>();
  let allowed = true;
  const resolve = (reference: string, revision: string) => {
    const row = records.get(reference);
    if (!allowed || !row) throw new HostFileServiceError('forbidden');
    if (row.file.revision !== revision) throw new HostFileServiceError('conflict');
    return row;
  };
  const store: HostFileStore = {
    read: jest.fn(async (request) => ({
      reference: request.reference,
      revision: request.revision,
      offset: request.offset,
      data: resolve(request.reference, request.revision).data.subarray(
        request.offset,
        request.offset + request.length,
      ),
    })),
    stage: jest.fn(async (request, content) => {
      const data = await collect(content);
      const file = {
        reference: request.operationId,
        revision: digest(data),
        filename: request.filename,
        mediaType: request.mediaType,
        bytes: data.length,
        sha256: digest(data),
      };
      const previous = records.get(file.reference);
      if (previous && previous.file.revision !== file.revision)
        throw new HostFileServiceError('conflict');
      records.set(file.reference, { file, data });
      return file;
    }),
    publish: jest.fn(async (request) => {
      const row = resolve(request.reference, request.revision);
      const previous = publications.get(request.operationId);
      if (previous && previous.reference !== row.file.reference)
        throw new HostFileServiceError('conflict');
      publications.set(request.operationId, row.file);
      return { operationId: request.operationId, file: row.file };
    }),
  };
  return {
    store,
    records,
    publications,
    revoke: () => {
      allowed = false;
    },
  };
}

async function fixture(overrides: Partial<HostFileStore> = {}, workerIdentity = identity) {
  const memory = storage();
  Object.assign(memory.store, overrides);
  const controller = new AbortController();
  const admission = new HostFileAdmission({ maxConcurrentOperations: 4, maxBufferedBytes: 32 });
  const files = createHostFileService({
    identity,
    descriptor,
    store: memory.store,
    admission,
    timeoutMs: 1000,
    signal: controller.signal,
  });
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const incoming = once(server, 'connection');
  const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
  await once(socket, 'open');
  const [hostSocket] = (await incoming) as [WebSocket];
  const frames: string[] = [];
  socket.on('message', (data) => frames.push(data.toString()));
  hostSocket.on('message', (data) => frames.push(data.toString()));
  const host = createHostFileChannel({
    files: { ...files, sources: [source] },
    identity,
    limits,
    signal: controller.signal,
    peer: { call: (...args) => hostPeer.call(...args) },
  });
  const worker = createWorkerFileChannel({
    limits,
    signal: controller.signal,
    peer: { call: (...args) => workerPeer.call(...args) },
  });
  const peerOptions = {
    ...limits,
    timeoutMs: limits.rpcTimeoutMs,
    onClose: () => controller.abort(),
    onFrame: async () => {
      throw new Error('Unexpected frame');
    },
  };
  const hostPeer = createSdkPeer(hostSocket, {
    ...peerOptions,
    onCall: (method, data, _timeout, signal) => host.call(method, data, signal),
  });
  const workerPeer = createSdkPeer(socket, {
    ...peerOptions,
    onCall: (method, data, _timeout, signal) => {
      if (method !== 'files.chunk') throw new Error('Unexpected method');
      return worker.accept(data, signal);
    },
  });
  return {
    ...memory,
    host,
    worker,
    binding: worker.bind(workerIdentity, host.descriptor),
    admission,
    frames,
    controller,
    hostPeer,
    workerPeer,
    close: async () => {
      controller.abort();
      hostPeer.close();
      workerPeer.close();
      socket.terminate();
      hostSocket.terminate();
      host.dispose();
      worker.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

it('round trips bounded bytes, private staging, and publication on real WebSockets without plaintext payloads', async () => {
  const f = await fixture();
  try {
    expect(f.binding.sources).toEqual([source]);
    expect(await collect(f.binding.read(source))).toEqual(bytes);
    const staged = await f.binding.stage(
      { operationId: 'upload', filename: 'report.txt', mediaType: 'text/plain', bytes: 8 },
      (async function* () {
        yield bytes.subarray(0, 4);
        yield bytes.subarray(4);
      })(),
    );
    expect(f.publications.size).toBe(0);
    expect(staged.sha256).toBe(digest(bytes));
    expect(await f.binding.publish(staged, 'publication')).toEqual({
      operationId: 'publication',
      file: staged,
    });
    expect(await f.binding.publish(staged, 'publication')).toEqual({
      operationId: 'publication',
      file: staged,
    });
    expect(f.publications.size).toBe(1);
    expect(f.frames.join('')).not.toContain('abcd');
    expect(f.frames.join('')).not.toContain(Buffer.from('abcd').toString('base64'));
    expect(f.admission.snapshot()).toEqual({ operations: 0, reservedBytes: 0 });
  } finally {
    await f.close();
  }
});

it('pulls reads on demand and rechecks canonical ACLs between ranges', async () => {
  const f = await fixture();
  try {
    const stream = f.binding.read(source)[Symbol.asyncIterator]();
    expect(f.store.read).not.toHaveBeenCalled();
    expect((await stream.next()).value).toEqual(bytes.subarray(0, 4));
    await tick();
    expect(f.store.read).toHaveBeenCalledTimes(1);
    f.revoke();
    await expect(stream.next()).rejects.toMatchObject({ code: 'forbidden' });
  } finally {
    await f.close();
  }
});

it.each(['runtimeId', 'agentId', 'runId', 'userId', 'tenantId', 'conversationId'] as const)(
  'rejects a foreign %s before touching storage',
  async (key) => {
    const f = await fixture({}, { ...identity, [key]: 'foreign' });
    try {
      await expect(collect(f.binding.read(source))).rejects.toMatchObject({ code: 'forbidden' });
      expect(f.store.read).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

it('does not pull upload bytes before host storage asks for them', async () => {
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const memory = storage();
  const f = await fixture({
    stage: async (...args) => {
      entered();
      await gate;
      return memory.store.stage(...args);
    },
  });
  const produced = jest.fn();
  try {
    const staging = f.binding.stage(
      { operationId: 'upload', filename: 'report', mediaType: 'text/plain', bytes: 8 },
      (async function* () {
        produced();
        yield bytes.subarray(0, 4);
        produced();
        yield bytes.subarray(4);
      })(),
    );
    await ready;
    expect(produced).not.toHaveBeenCalled();
    release();
    await staging;
    expect(produced).toHaveBeenCalledTimes(2);
  } finally {
    release();
    await f.close();
  }
});

it.each([3, 9])(
  'rejects an upload whose declared length is %s and never publishes it',
  async (length) => {
    const f = await fixture();
    try {
      await expect(
        f.binding.stage(
          { operationId: 'upload', filename: 'report', mediaType: 'text/plain', bytes: length },
          (async function* () {
            yield bytes.subarray(0, 4);
            yield bytes.subarray(4);
          })(),
        ),
      ).rejects.toMatchObject({ code: length < bytes.length ? 'overflow' : 'incompatible' });
      expect(f.store.publish).not.toHaveBeenCalled();
      expect(f.records.size).toBe(1);
    } finally {
      await f.close();
    }
  },
);

it('cancels a staged upload, runs source cleanup, and retains no publication', async () => {
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const cleaned = jest.fn();
  const f = await fixture({
    stage: async (_request, content, signal) => {
      for await (const _chunk of content) {
        entered();
        await new Promise<void>((resolve) => {
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        signal?.throwIfAborted();
      }
      throw new Error('Unexpected EOF');
    },
  });
  const cancel = new AbortController();
  try {
    const pending = f.binding.stage(
      { operationId: 'upload', filename: 'report', mediaType: 'text/plain', bytes: 8 },
      (async function* () {
        try {
          yield bytes.subarray(0, 4);
          yield bytes.subarray(4);
        } finally {
          cleaned();
        }
      })(),
      cancel.signal,
    );
    await ready;
    cancel.abort(new Error('private cancellation text'));
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    await tick();
    expect(cleaned).toHaveBeenCalledTimes(1);
    expect(f.admission.snapshot().operations).toBe(0);
    expect(f.publications.size).toBe(0);
    expect(f.frames.join('')).not.toContain('private cancellation text');
  } finally {
    await f.close();
  }
});

it('redacts storage errors and rejects stale revisions', async () => {
  const f = await fixture({
    read: async () => {
      throw new Error('/private/credentials secret');
    },
  });
  try {
    await expect(collect(f.binding.read(source))).rejects.toMatchObject({
      code: 'unavailable',
      message: 'Host file service: unavailable',
    });
    expect(f.frames.join('')).not.toContain('credentials');
  } finally {
    await f.close();
  }
  const other = await fixture();
  try {
    await expect(collect(other.binding.read({ ...source, revision: 'old' }))).rejects.toMatchObject(
      { code: 'conflict' },
    );
  } finally {
    await other.close();
  }
});

it('rejects oversized raw read requests before storage despite bypassing worker bindings', async () => {
  const f = await fixture();
  const receiver = createPolicyReceiver(limits.maxFrameBytes, 'files');
  try {
    const seal = createPolicySender(f.host.descriptor.publicKey, limits.maxFrameBytes, 'files');
    const request = {
      version: 1,
      identity,
      reference: source.reference,
      revision: source.revision,
      offset: 0,
      length: 5,
    };
    const result = await f.workerPeer.call(
      'files.read',
      seal(
        JSON.stringify(
          encodeSdkValue({
            id: '10101010-1010-4010-8010-101010101010',
            publicKey: receiver.publicKey,
            request,
          }),
        ),
      ),
    );
    expect(result).toEqual({ version: 1, ok: false, code: 'overflow' });
    expect(f.store.read).not.toHaveBeenCalled();
  } finally {
    receiver.dispose();
    await f.close();
  }
});

it('feeds file bindings into a custom graph and preserves native SDK message events', async () => {
  const memory = storage();
  const files = createHostFileService({
    identity,
    descriptor,
    store: memory.store,
    admission: new HostFileAdmission({ maxConcurrentOperations: 4, maxBufferedBytes: 32 }),
    timeoutMs: 1000,
  });
  const secret = 'file-bridge-test-secret-at-least-32-characters';
  const config: RunConfig = {
    runId: identity.runId,
    tokenCounter: () => 1,
    returnContent: true,
    graphConfig: {
      type: 'standard',
      agents: [
        {
          agentId: identity.agentId,
          provider: Providers.OPENAI,
          clientOptions: { model: 'test' },
          tools: [],
        },
      ],
    },
  };
  const observed = jest.fn();
  const runtime = createRemoteSdkServer({
    runtimeId: identity.runtimeId,
    secret,
    authorize: (who) => who.userId === identity.userId,
    createRun: async (input) => {
      const hostFiles = input.hostFiles;
      if (!hostFiles) throw new Error('Files not negotiated');
      const run = await Run.create({ ...config, ...input.config });
      if (!run.Graph) throw new Error('Missing graph');
      run.Graph.overrideModel = new FakeChatModel({ responses: ['Artifact published'], sleep: 1 });
      const agent = run.graphRunnable;
      if (!agent) throw new Error('Missing compiled agent');
      const state = Annotation.Root({
        messages: Annotation({ reducer: messagesStateReducer, default: () => [] }),
        runStepState: Annotation<RunStepResumeState | undefined>(),
      });
      run.graphRunnable = new StateGraph(state)
        .addNode('artifact', async () => {
          const staged = await hostFiles.stage(
            {
              operationId: 'graph-upload',
              filename: 'report.txt',
              mediaType: 'text/plain',
              bytes: source.bytes,
            },
            hostFiles.read(hostFiles.sources[0], input.signal),
            input.signal,
          );
          await hostFiles.publish(staged, 'graph-publication', input.signal);
          return {};
        })
        .addNode('reply', (state, config) => agent.invoke(state, config))
        .addEdge(START, 'artifact')
        .addEdge('artifact', 'reply')
        .addEdge('reply', END)
        .compile();
      return run;
    },
  });
  await new Promise<void>((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
  try {
    const run = await createRemoteSdkRun({
      config: {
        ...config,
        customHandlers: { [GraphEvents.ON_MESSAGE_DELTA]: { handle: observed } },
      },
      identity,
      remote: {
        url: `ws://127.0.0.1:${(runtime.server.address() as AddressInfo).port}/sdk`,
        secret,
      },
      hostServices: { files: { ...files, sources: [source] } },
    });
    const content = await run.processStream(
      { messages: [new HumanMessage('Publish the report')] },
      { version: 'v2', configurable: { thread_id: identity.conversationId } },
    );
    expect(memory.publications.size).toBe(1);
    expect(JSON.stringify(content)).toContain('Artifact published');
    expect(observed).toHaveBeenCalled();
  } finally {
    await runtime.close();
  }
});

it('fails before execution when an older worker does not advertise file support', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const executed = jest.fn();
  server.on('connection', (socket) => {
    createSdkPeer(socket, {
      ...limits,
      timeoutMs: limits.rpcTimeoutMs,
      onClose: () => undefined,
      onFrame: async () => undefined,
      onCall: async (method) => {
        if (method === 'capabilities') return { transportVersion: 2 };
        executed();
        return { accepted: true };
      },
    });
  });
  const memory = storage();
  const files = createHostFileService({
    identity,
    descriptor,
    store: memory.store,
    admission: new HostFileAdmission({ maxConcurrentOperations: 4, maxBufferedBytes: 32 }),
    timeoutMs: 1000,
  });
  try {
    const run = await createRemoteSdkRun({
      identity,
      config: {
        runId: identity.runId,
        tokenCounter: () => 1,
        graphConfig: {
          type: 'standard',
          agents: [
            {
              agentId: identity.agentId,
              provider: Providers.OPENAI,
              clientOptions: { model: 'test' },
              tools: [],
            },
          ],
        },
      },
      remote: {
        url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/sdk`,
        secret: 'older-file-worker-test-secret-at-least-32-characters',
      },
      hostServices: { files: { ...files, sources: [source] } },
    });
    await expect(
      run.processStream(
        { messages: [new HumanMessage('read')] },
        { version: 'v2', configurable: { thread_id: identity.conversationId } },
      ),
    ).rejects.toThrow('execution failed');
    expect(executed).not.toHaveBeenCalled();
    expect(memory.store.read).not.toHaveBeenCalled();
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
