import { z } from 'zod';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import { FakeChatModel } from '@langchain/core/utils/testing';
import { createHostModelService, HostModelAdmission } from '@librechat/agents';
import { AIMessage, AIMessageChunk, HumanMessage } from '@librechat/agents/langchain/messages';
import type { HostModelDescriptor, HostModelRequest } from '@librechat/agents';
import type { AddressInfo } from 'node:net';
import { createHostModelChannel, createWorkerModelChannel } from './model';
import { createPolicyReceiver, createPolicySender } from './sealed';
import { encodeSdkValue, decodeSdkValue } from './wire';
import { remoteSdkLimits } from './types';
import { createSdkPeer } from './peer';

const identity = {
  runtimeId: 'runtime',
  agentId: 'agent',
  runId: 'run',
  userId: 'user',
  tenantId: 'tenant',
};
const descriptor = {
  version: 1 as const,
  reference: 'primary',
  provider: 'openAI',
  model: 'host-model',
  streaming: true,
  tools: [],
};
const request: HostModelRequest = {
  version: 1,
  identity,
  reference: 'primary',
  messages: [new HumanMessage('hello')],
  toolNames: [],
};
const limits = remoteSdkLimits({ maxFrameBytes: 4096, maxBufferedBytes: 8192, maxRunMs: 2000 });
function binding(model = new FakeChatModel({}), tools: HostModelDescriptor['tools'] = []) {
  const admission = new HostModelAdmission({ maxConcurrentCalls: 4, maxRequestBytes: 65536 });
  return {
    admission,
    ...createHostModelService({
      identity,
      descriptor: { ...descriptor, tools },
      model,
      admission,
      limits: { timeoutMs: 2000, maxRequestBytes: 65536, maxResponseBytes: 1048576 },
      config: { metadata: { privateHostSetting: 'retained' } },
    }),
  };
}
async function fixture(model = new FakeChatModel({}), tools: HostModelDescriptor['tools'] = []) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const accepted = once(server, 'connection');
  const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
  await once(socket, 'open');
  const [hostSocket] = (await accepted) as [WebSocket];
  const wireFrames: string[] = [];
  socket.on('message', (data) => wireFrames.push(data.toString()));
  hostSocket.on('message', (data) => wireFrames.push(data.toString()));
  const controller = new AbortController();
  const host = binding(model, tools);
  let produced = 0;
  const hostPeer = createSdkPeer(hostSocket, {
    ...limits,
    timeoutMs: 2000,
    onCall: (method, data, _timeout, signal) => hostChannel.call(method, data, signal),
    onFrame: async () => {},
    onClose: () => controller.abort(),
  });
  const workerPeer = createSdkPeer(socket, {
    ...limits,
    timeoutMs: 2000,
    onCall: (_method, data, _timeout, signal) => {
      produced++;
      return worker.accept(data, signal);
    },
    onFrame: async () => {},
    onClose: () => controller.abort(),
  });
  const hostChannel = createHostModelChannel({
    model: host,
    peer: hostPeer,
    limits,
    signal: controller.signal,
  });
  const worker = createWorkerModelChannel({ peer: workerPeer, limits, signal: controller.signal });
  return {
    host,
    hostChannel,
    model: worker.bind(identity, hostChannel.descriptor),
    workerPeer,
    controller,
    wireFrames,
    produced: () => produced,
    close: async () => {
      controller.abort();
      hostChannel.dispose();
      socket.terminate();
      hostSocket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

it('preserves the strict older-host request shape without negotiated admission', async () => {
  const receiver = createPolicyReceiver(limits.maxFrameBytes, 'model');
  const controller = new AbortController();
  const call = jest.fn(async (_method: string, data: unknown) => {
    const operation = z
      .object({ id: z.string().uuid(), publicKey: z.string().length(60), request: z.unknown() })
      .strict()
      .parse(decodeSdkValue(JSON.parse(receiver.open(data))));
    const seal = createPolicySender(operation.publicKey, limits.maxFrameBytes, 'model');
    return {
      version: 1,
      ok: true,
      message: seal(
        JSON.stringify(
          encodeSdkValue({ id: operation.id, message: new AIMessage('legacy reply') }),
        ),
      ),
    };
  });
  const worker = createWorkerModelChannel({ peer: { call }, limits, signal: controller.signal });
  try {
    const model = worker.bind(identity, {
      version: 1,
      publicKey: receiver.publicKey,
      descriptor,
    });
    await expect(model.invoke([...request.messages])).resolves.toMatchObject({
      content: 'legacy reply',
    });
    expect(call).toHaveBeenCalledTimes(1);
  } finally {
    controller.abort();
    receiver.dispose();
  }
});

it('streams native tool fragments, rich content and typed metadata over a real socket', async () => {
  const native = new FakeChatModel({});
  native._streamResponseChunks = async function* () {
    for (const args of ['{"topic":', '"fixture"}']) {
      yield new ChatGenerationChunk({
        text: '',
        message: new AIMessageChunk({
          content: [{ type: 'text', text: 'hello' }],
          tool_call_chunks: [
            { index: 0, id: 'call', name: 'inspect', args, type: 'tool_call_chunk' },
          ],
          response_metadata: {
            binary: new Uint8Array([0, 255]),
            date: new Date('2026-01-01'),
            map: new Map([['value', new Set([1])]]),
            count: BigInt(2),
            literal: { $sdk: 'undefined' },
          },
        }),
      });
    }
  };
  const runtime = await fixture(native);
  try {
    const chunks: AIMessageChunk[] = [];
    for await (const chunk of await runtime.model.stream([...request.messages])) chunks.push(chunk);
    expect(runtime.wireFrames.join('')).not.toContain('hello');
    expect(runtime.wireFrames.join('')).not.toContain('fixture');
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBeInstanceOf(AIMessageChunk);
    expect(chunks[0].tool_call_chunks?.[0].args).toBe('{"topic":');
    expect(chunks[1].tool_call_chunks?.[0].args).toBe('"fixture"}');
    expect(chunks[0].response_metadata.binary).toEqual(new Uint8Array([0, 255]));
    expect(chunks[0].response_metadata.date).toEqual(new Date('2026-01-01'));
    expect(chunks[0].response_metadata.map).toEqual(new Map([['value', new Set([1])]]));
    expect(chunks[0].response_metadata.count).toBe(BigInt(2));
    expect(chunks[0].response_metadata.literal).toEqual({ $sdk: 'undefined' });
    expect(runtime.host.admission.snapshot().calls).toBe(0);
  } finally {
    await runtime.close();
  }
});

it('pipes multiple chunks before acknowledgement and bounds a stalled consumer', async () => {
  const native = new FakeChatModel({});
  let produced = 0;
  let closed = false;
  native._streamResponseChunks = async function* () {
    try {
      for (let i = 0; i < 1000; i++) {
        produced++;
        yield new ChatGenerationChunk({ text: 'x', message: new AIMessageChunk('x'.repeat(512)) });
      }
    } finally {
      closed = true;
    }
  };
  const runtime = await fixture(native);
  try {
    // Keep the SDK's native pull iterator: ReadableStream adds its own buffering.
    const stream = runtime.model._streamIterator([...request.messages], {})[Symbol.asyncIterator]();
    await stream.next();
    for (let i = 0; i < 20 && runtime.produced() < 3; i++) await tick();
    expect(runtime.produced()).toBeGreaterThan(2);
    expect(produced).toBeLessThan(30);
    for (let i = 0; i < 5; i++) await tick();
    const before = produced;
    await tick();
    expect(produced).toBe(before);
    await stream.return?.(undefined);
    for (let i = 0; i < 20 && !closed; i++) await tick();
    expect(closed).toBe(true);
    expect(runtime.host.admission.snapshot().calls).toBe(0);
  } finally {
    await runtime.close();
  }
});

it('rejects foreign identities and references before native invocation', async () => {
  const native = new FakeChatModel({});
  const invoke = jest.spyOn(native, 'invoke');
  const runtime = await fixture(native);
  try {
    for (const forged of [
      { ...request, reference: 'other' },
      { ...request, identity: { ...identity, tenantId: 'other' } },
    ]) {
      const recipient = createPolicyReceiver(limits.maxFrameBytes, 'model');
      const seal = createPolicySender(
        runtime.hostChannel.descriptor.publicKey,
        limits.maxFrameBytes,
        'model',
      );
      const result = await runtime.workerPeer.call(
        'model.invoke',
        seal(
          JSON.stringify(
            encodeSdkValue({ id: randomUUID(), publicKey: recipient.publicKey, request: forged }),
          ),
        ),
      );
      recipient.dispose();
      expect(result).toEqual({ version: 1, ok: false, code: 'forbidden' });
    }
    expect(invoke).not.toHaveBeenCalled();
  } finally {
    await runtime.close();
  }
});

it('sanitizes host exceptions and preserves invoke metadata', async () => {
  const native = new FakeChatModel({});
  native._generate = async () => ({
    generations: [
      {
        text: 'hello',
        message: new AIMessage({
          content: 'hello',
          response_metadata: { binary: new Uint8Array([1]) },
        }),
      },
    ],
  });
  const runtime = await fixture(native);
  try {
    const message = await runtime.model.invoke([...request.messages]);
    expect(message.content).toBe('hello');
    expect(message.response_metadata.binary).toEqual(new Uint8Array([1]));
    native._generate = async () => {
      throw new Error('SECRET provider credential');
    };
    await expect(runtime.model.invoke([...request.messages])).rejects.toThrow(
      'Host model service: unavailable',
    );
  } finally {
    await runtime.close();
  }
});

it('rejects a chunk larger than the frame budget and settles cleanup', async () => {
  const native = new FakeChatModel({});
  native._streamResponseChunks = async function* () {
    yield new ChatGenerationChunk({ text: '', message: new AIMessageChunk('x'.repeat(5000)) });
  };
  const runtime = await fixture(native);
  try {
    await expect(
      (async () => {
        for await (const _chunk of await runtime.model.stream([...request.messages])) {
          /* drain */
        }
      })(),
    ).rejects.toThrow('overflow');
    expect(runtime.host.admission.snapshot().calls).toBe(0);
  } finally {
    await runtime.close();
  }
});

it('cancels a pending provider read and retains native admission until cleanup settles', async () => {
  const native = new FakeChatModel({});
  let release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  native._streamResponseChunks = async function* () {
    entered();
    await blocked;
    yield new ChatGenerationChunk({ text: 'late', message: new AIMessageChunk('late') });
  };
  const runtime = await fixture(native);
  const cancellation = new AbortController();
  try {
    const stream = runtime.model
      ._streamIterator([...request.messages], { signal: cancellation.signal })
      [Symbol.asyncIterator]();
    const next = stream.next();
    await started;
    cancellation.abort();
    await expect(next).rejects.toThrow('cancelled');
    for (let i = 0; i < 20 && !runtime.host.admission.snapshot().retainedCalls; i++) await tick();
    expect(runtime.host.admission.snapshot().retainedCalls).toBe(1);
    release();
    for (let i = 0; i < 20 && runtime.host.admission.snapshot().calls; i++) await tick();
    expect(runtime.host.admission.snapshot().calls).toBe(0);
  } finally {
    release();
    await runtime.close();
  }
});

it('isolates concurrent model streams within the same bounded connection', async () => {
  const native = new FakeChatModel({});
  native._streamResponseChunks = async function* (messages) {
    const content = String(messages[0].content);
    for (let i = 0; i < 12; i++) {
      yield new ChatGenerationChunk({ text: content, message: new AIMessageChunk(content) });
      await tick();
    }
  };
  const runtime = await fixture(native);
  try {
    const collect = async (text: string) => {
      let result = '';
      for await (const chunk of await runtime.model.stream([new HumanMessage(text)]))
        result += chunk.content;
      return result;
    };
    expect(await Promise.all([collect('A'), collect('B')])).toEqual([
      'A'.repeat(12),
      'B'.repeat(12),
    ]);
    expect(runtime.host.admission.snapshot().calls).toBe(0);
  } finally {
    await runtime.close();
  }
});

it('rejects tampered ciphertext and policy envelopes before provider dispatch', async () => {
  const native = new FakeChatModel({});
  const invoke = jest.spyOn(native, 'invoke');
  const runtime = await fixture(native);
  const recipient = createPolicyReceiver(limits.maxFrameBytes, 'model');
  try {
    const text = JSON.stringify(
      encodeSdkValue({ id: randomUUID(), publicKey: recipient.publicKey, request }),
    );
    const seal = createPolicySender(
      runtime.hostChannel.descriptor.publicKey,
      limits.maxFrameBytes,
      'model',
    );
    const valid = seal(text);
    const tampered = {
      ...valid,
      ciphertext: (valid.ciphertext[0] === 'A' ? 'B' : 'A') + valid.ciphertext.slice(1),
    };
    const wrongPurpose = createPolicySender(
      runtime.hostChannel.descriptor.publicKey,
      limits.maxFrameBytes,
    )(text);
    for (const payload of [tampered, wrongPurpose]) {
      expect(await runtime.workerPeer.call('model.invoke', payload)).toEqual({
        version: 1,
        ok: false,
        code: 'unavailable',
      });
    }
    expect(invoke).not.toHaveBeenCalled();
  } finally {
    recipient.dispose();
    await runtime.close();
  }
});

it('binds the host-authorized tool schemas before installing the graph override', async () => {
  const tools = [
    {
      type: 'function' as const,
      function: {
        name: 'inspect',
        description: 'Inspect',
        parameters: { type: 'object', properties: {} },
      },
    },
  ];
  class ToolModel extends FakeChatModel {
    selected: unknown;
    bindTools(definitions: Parameters<NonNullable<FakeChatModel['bindTools']>>[0]) {
      this.selected = definitions;
      return this;
    }
  }
  const native = new ToolModel({});
  const runtime = await fixture(native, tools);
  try {
    await runtime.model.invoke([...request.messages]);
    expect(native.selected).toEqual(tools);
  } finally {
    await runtime.close();
  }
});
