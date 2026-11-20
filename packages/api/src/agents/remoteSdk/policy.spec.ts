import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createHostProviderTextService, ProviderTextAdmission } from '@librechat/agents';
import type { ProviderTextProtection } from '@librechat/agents';
import type WebSocket from 'ws';
import { createHostPolicyChannel, createWorkerProviderTextPolicy } from './policy';
import { RecoverySocket, createMemoryRecoveryLog } from './recovery/socket';
import { createPolicyReceiver, createPolicySender } from './sealed';
import { remoteSdkLimits } from './types';

const identity = { runtimeId: 'runtime', agentId: 'agent', runId: 'run', userId: 'user' };
const limits = remoteSdkLimits({ maxFrameBytes: 8192 });
const request = { version: 1 as const, identity, content: 'PRIVATE candidate' };
function fixture(overrides: Partial<ProviderTextProtection> = {}) {
  const admission = new ProviderTextAdmission({
    maxConcurrentInspections: 1,
    maxBufferedBytes: 8192,
  });
  const bound = createHostProviderTextService({
    identity,
    admission,
    inspectionTimeoutMs: 100,
    policy: {
      version: 1,
      timeoutMs: 1000,
      maxAttemptBytes: 8192,
      maxBufferedBytes: 16384,
      classify: () => 'prose',
      inspect: () => ({
        version: 1,
        ok: true,
        value: { content: 'approved', replacements: 1, categories: [] },
      }),
      ...overrides,
    },
  });
  const host = createHostPolicyChannel(bound, limits);
  const call = jest.fn(async (_method, data, _timeoutMs, signal) => host.inspect(data, signal));
  const worker = createWorkerProviderTextPolicy({
    descriptor: host.descriptor,
    identity,
    peer: { call },
    limits,
  });
  const inspect = (content: string, signal = new AbortController().signal) =>
    worker.inspect({
      version: 1,
      content,
      target: { source: 'message', field: 'text', provenance: 'model' },
      signal,
    });
  return { host, worker, call, admission, inspect };
}

it('seals raw requests before RPC and returns only approved text', async () => {
  const f = fixture();
  try {
    expect(await f.inspect(request.content)).toMatchObject({
      ok: true,
      value: { content: 'approved' },
    });
    expect(f.call).toHaveBeenCalledTimes(1);
    expect(f.call.mock.calls[0][0]).toBe('policy.providerText');
    expect(JSON.stringify(f.call.mock.calls)).not.toContain('PRIVATE');
    expect(f.admission.snapshot()).toMatchObject({ inspections: 0, bufferedBytes: 0 });
  } finally {
    f.host.dispose();
  }
});

it('forwards cancellation and retains host admission until an ignoring inspector drains', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture({
    inspect: async () => {
      await held;
      return {
        version: 1,
        ok: true,
        value: { content: 'late PRIVATE', replacements: 0, categories: [] },
      };
    },
  });
  const controller = new AbortController();
  const result = Promise.resolve(f.inspect(request.content, controller.signal)).catch(
    (error: Error) => error,
  );
  try {
    controller.abort();
    expect(await result).toMatchObject({ code: 'cancelled' });
    expect(f.call.mock.calls[0][3]).toBe(controller.signal);
    expect(f.admission.snapshot().retainedInspections).toBe(1);
    await expect(f.inspect(request.content)).rejects.toMatchObject({ code: 'overflow' });
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.admission.snapshot().inspections).toBe(0);
  } finally {
    release();
    f.host.dispose();
  }
});

it('uses host deadlines without a worker cancellation and sanitizes inspector errors', async () => {
  const f = fixture({
    inspect: () => {
      throw new Error('PRIVATE credential');
    },
  });
  try {
    await expect(f.inspect(request.content)).rejects.toMatchObject({
      code: 'unavailable',
      message: 'Provider text protection: unavailable',
    });
  } finally {
    f.host.dispose();
  }
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const timed = fixture({
    inspect: async () => {
      await held;
      return { version: 1, ok: false, error: { code: 'blocked' } };
    },
  });
  try {
    await expect(timed.inspect(request.content)).rejects.toMatchObject({ code: 'timeout' });
    expect(timed.admission.snapshot().retainedInspections).toBe(1);
  } finally {
    release();
    timed.host.dispose();
  }
});

it('validates the authenticated identity after decryption, before policy inspection', async () => {
  const inspect = jest.fn<
    ReturnType<ProviderTextProtection['inspect']>,
    Parameters<ProviderTextProtection['inspect']>
  >(() => ({ version: 1, ok: false, error: { code: 'blocked' } }));
  const f = fixture({ inspect });
  const seal = createPolicySender(f.host.descriptor.publicKey, limits.maxFrameBytes);
  try {
    expect(
      await f.host.inspect(
        seal(JSON.stringify({ ...request, identity: { ...identity, userId: 'foreign' } })),
      ),
    ).toEqual({ version: 1, ok: false, error: { code: 'incompatible' } });
    expect(inspect).not.toHaveBeenCalled();
  } finally {
    f.host.dispose();
  }
});

it('rejects tampering, foreign run keys, malformed envelopes and disposed receivers', () => {
  const receiver = createPolicyReceiver(1024);
  const other = createPolicyReceiver(1024);
  const seal = createPolicySender(receiver.publicKey, 1024);
  const payload = seal(request.content);
  expect(receiver.open(payload)).toBe(request.content);
  expect(seal(request.content)).not.toEqual(payload);
  expect(() => other.open(payload)).toThrow();
  for (const changed of [
    null,
    {},
    { ...payload, version: 2 },
    { ...payload, tag: Buffer.alloc(16).toString('base64') },
    { ...payload, nonce: Buffer.alloc(12).toString('base64') },
    { ...payload, ciphertext: 'invalid' },
    { ...payload, publicKey: other.publicKey },
  ]) {
    expect(() => receiver.open(changed)).toThrow();
  }
  receiver.dispose();
  other.dispose();
  expect(() => receiver.open(payload)).toThrow();
});

it('bounds payloads before encryption/decryption and handles a large candidate without a regex stack overflow', () => {
  const receiver = createPolicyReceiver(4);
  const seal = createPolicySender(receiver.publicKey, 4);
  expect(() => seal('too large')).toThrow();
  const large = createPolicySender(receiver.publicKey, 262144)('x'.repeat(262144));
  expect(() => receiver.open(large)).toThrow();
  const largeReceiver = createPolicyReceiver(262144);
  expect(
    largeReceiver.open(createPolicySender(largeReceiver.publicKey, 262144)('x'.repeat(262144))),
  ).toHaveLength(262144);
  receiver.dispose();
  largeReceiver.dispose();
});

it('replays encrypted inspection frames without putting raw candidates or private keys in the recovery log', async () => {
  const receiver = createPolicyReceiver(8192);
  const seal = createPolicySender(receiver.publicKey, 8192);
  const log = createMemoryRecoveryLog(32768);
  const socket = new RecoverySocket({
    log,
    maxFrameBytes: 8192,
    maxBufferedBytes: 32768,
    onDisconnect: () => undefined,
    onFailure: (error) => {
      throw error;
    },
  });
  const payload = seal(JSON.stringify(request));
  try {
    socket.send(
      JSON.stringify({
        type: 'call',
        id: randomUUID(),
        method: 'policy.providerText',
        data: payload,
      }),
    );
    await socket.flush();
    const entries = await log.read(0);
    expect(JSON.stringify(entries)).not.toContain(request.content);
    expect(JSON.stringify(entries)).not.toContain('privateKey');
    const wire = Object.assign(new EventEmitter(), {
      readyState: 1,
      bufferedAmount: 0,
      send: jest.fn(),
      close: jest.fn(),
      terminate: jest.fn(),
    });
    socket.attach(wire as unknown as WebSocket, randomUUID(), 0);
    await socket.flush();
    const published = String(wire.send.mock.calls[0][0]);
    expect(published).not.toContain(request.content);
    const replay = JSON.parse(published.slice(published.indexOf('\n') + 1));
    expect(JSON.parse(receiver.open(replay.data))).toEqual(request);
    expect(replay.data).toEqual(payload);
  } finally {
    receiver.dispose();
    socket.terminate();
  }
});
