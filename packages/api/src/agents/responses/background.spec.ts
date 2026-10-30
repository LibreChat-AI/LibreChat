import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createResponseStorage, tenantStorage, runAsSystem } from '@librechat/data-schemas';
import type {
  ResponseStorage,
  StoredResponseRecord,
  ResponseOwner,
  ResponseTerminalReceipt,
} from '@librechat/data-schemas';
import type { BackgroundResponseDependencies } from './background';
import type { ResponsesRunEnvelope } from '../envelope';
import type { Response } from './types';
import {
  buildAggregatedResponse,
  createResponseAggregator,
  createResponseContext,
} from './service';
import { createBackgroundResponseService, buildPendingBackgroundResponse } from './background';
import { createResponseCompletion } from './completion';
import { createAgentRunEnvelope } from '../envelope';

let mongo: MongoMemoryReplSet;
let storage: ResponseStorage;
const owner = { userId: 'owner', tenantId: 'tenant-a' };
const scope = <T>(work: () => Promise<T>) => tenantStorage.run({ tenantId: owner.tenantId }, work);
const envelope = (payload: Partial<ResponsesRunEnvelope['payload']> = {}) =>
  createAgentRunEnvelope({
    protocol: 'responses',
    requestId: 'request',
    receivedAt: 100,
    principal: { id: owner.userId, tenantId: owner.tenantId },
    payload: { model: 'agent', input: 'Hello', background: true, store: true, ...payload },
  });

function completed(record: StoredResponseRecord): Response {
  const aggregator = createResponseAggregator();
  aggregator.addText('# Persisted response\n\n**Full answer.**');
  return {
    ...buildAggregatedResponse(
      createResponseContext({ model: record.agentId, input: 'Hello' }, record.responseId),
      aggregator,
    ),
    background: true,
    store: true,
  };
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ args: ['--nounixsocket'] }],
  });
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  storage = createResponseStorage(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  await runAsSystem(async () => {
    await mongoose.models.StoredResponse.deleteMany({});
    await mongoose.models.ResponseScope?.deleteMany({});
  });
});

function fixture() {
  const deliveries = new Map<string, StoredResponseRecord>();
  const cleanupCheckpoint = jest.fn(async () => {});
  const releaseExecution = jest.fn(async () => {});
  const completion = createResponseCompletion({
    storage,
    cleanupCheckpoint,
    releaseExecution,
    confirmExecution: async () => null,
  });
  const deps: BackgroundResponseDependencies = {
    storage,
    authorize: async (principal, agentId) =>
      principal.userId === owner.userId && agentId === 'agent',
    resolveContinuation: async () => ({ conversationId: 'conversation', parentMessageId: 'root' }),
    enqueue: async (record) => {
      deliveries.set(record.deliveryKey!, record);
    },
    observe: async () => null,
    recoverTerminal: completion.finish,
    cancel: async () => {},
    now: () => 200,
  };
  return {
    deps,
    deliveries,
    completion,
    cleanupCheckpoint,
    releaseExecution,
    service: createBackgroundResponseService(deps),
  };
}

async function admit(record: StoredResponseRecord): Promise<StoredResponseRecord> {
  const result = await storage.publish(record, record.responseId, record.revision, {
    status: 'in_progress',
    generationCreatedAt: 10,
    responseJSON: JSON.stringify({
      ...completed(record),
      status: 'in_progress',
      completed_at: null,
      output: [],
    }),
  });
  if (!result.ok) throw new Error('Fixture admission failed');
  return result.record;
}

function terminalReceipt(
  record: StoredResponseRecord,
  status: ResponseTerminalReceipt['status'] = 'completed',
) {
  if (record.generationCreatedAt == null) throw new Error('Fixture generation missing');
  const response: Response = { ...completed(record), status };
  const receipt: ResponseTerminalReceipt = {
    generationCreatedAt: record.generationCreatedAt,
    providerExecutionId: 'provider',
    ownerId: 'worker',
    status,
    responseJSON: JSON.stringify(response),
    checkpointNamespace: 'checkpoint',
  };
  return { response, receipt };
}

it('reserves a generic response and preserves all validated execution settings', () =>
  scope(async () => {
    const { service, deliveries } = fixture();
    const request = envelope({
      instructions: 'Keep instructions',
      temperature: 0.4,
      manualSkills: ['skill'],
      max_output_tokens: 1234,
      metadata: { purpose: 'test' },
    });
    const result = await service.create(request, 'stable-key');
    expect(result).toMatchObject({
      ok: true,
      response: { status: 'queued', background: true, store: true, output: [] },
    });
    const record = [...deliveries.values()][0];
    expect(JSON.parse(record.requestJSON)).toEqual(request.payload);
    expect(record.agentId).toBe('agent');
  }));

it('replays the same identity, including after an uncertain queue publication', () =>
  scope(async () => {
    const { service, deps, deliveries } = fixture();
    const enqueue = deps.enqueue;
    let first = true;
    deps.enqueue = async (record) => {
      await enqueue(record);
      if (first) {
        first = false;
        throw new Error('queue response lost');
      }
    };
    await expect(service.create(envelope(), 'same')).rejects.toThrow('queue response lost');
    const result = await service.create(envelope(), 'same');
    expect(result.ok).toBe(true);
    expect(deliveries.size).toBe(1);
    const record = [...deliveries.values()][0];
    if (result.ok) expect(result.response.id).toBe(record.responseId);
  }));

it('canonicalizes nested request key order but rejects changed request values', () =>
  scope(async () => {
    const { service, deliveries } = fixture();
    const first = await service.create(envelope({ metadata: { a: '1', b: '2' } }), 'same');
    const second = await service.create(envelope({ metadata: { b: '2', a: '1' } }), 'same');
    expect(second).toEqual(first);
    expect(await service.create(envelope({ metadata: { a: 'changed', b: '2' } }), 'same')).toEqual({
      ok: false,
      status: 409,
      code: 'idempotency_conflict',
    });
    expect(deliveries.size).toBe(1);
  }));

it('denies revoked authority before reserve, observation or cancellation', () =>
  scope(async () => {
    const { service, deps, deliveries } = fixture();
    await service.create(envelope(), 'same');
    const record = [...deliveries.values()][0];
    deps.authorize = async () => false;
    const observe = jest.spyOn(deps, 'observe');
    const cancel = jest.spyOn(deps, 'cancel');
    expect(await service.retrieve(owner, record.responseId)).toEqual({
      ok: false,
      status: 404,
      code: 'response_not_found',
    });
    expect(await service.cancel(owner, record.responseId)).toEqual({
      ok: false,
      status: 404,
      code: 'response_not_found',
    });
    expect(await service.create(envelope(), 'different')).toEqual({
      ok: false,
      status: 403,
      code: 'permission_denied',
    });
    expect(observe).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(await mongoose.models.StoredResponse.countDocuments({})).toBe(1);
  }));

it.each(['completed', 'failed', 'incomplete', 'cancelled'] as const)(
  'defers an observed %s result until the terminal producer commits its journal',
  (status) =>
    scope(async () => {
      const f = fixture();
      await f.service.create(envelope(), 'same');
      const record = await admit([...f.deliveries.values()][0]);
      const { response, receipt } = terminalReceipt(record, status);
      const observe = jest
        .spyOn(f.deps, 'observe')
        .mockResolvedValue({ response, generationCreatedAt: 10 });
      const pending = await f.service.retrieve(owner, record.responseId);
      expect(pending).toMatchObject({ ok: true, response: { status: 'in_progress', output: [] } });
      expect((await storage.read(owner, record.responseId))?.status).toBe('in_progress');
      expect(f.cleanupCheckpoint).not.toHaveBeenCalled();
      expect(f.releaseExecution).not.toHaveBeenCalled();
      await f.completion.stageAndFinish(record, receipt);
      expect(await f.service.retrieve(owner, record.responseId)).toEqual({ ok: true, response });
      expect(await f.service.retrieve(owner, record.responseId)).toEqual({ ok: true, response });
      expect(observe).toHaveBeenCalledTimes(1);
      expect(f.cleanupCheckpoint).toHaveBeenCalledTimes(1);
      expect(f.releaseExecution).toHaveBeenCalled();
    }),
);

it('persists cancellation intent before signalling and waits for the cancelled journal', () =>
  scope(async () => {
    const f = fixture();
    await f.service.create(envelope(), 'same');
    const record = await admit([...f.deliveries.values()][0]);
    f.deps.cancel = async (current) => {
      expect((await storage.read(owner, current.responseId))?.cancellationRequestedAt).toBe(200);
    };
    expect(await f.service.cancel(owner, record.responseId)).toMatchObject({
      ok: true,
      response: { status: 'in_progress' },
    });
    const { response, receipt } = terminalReceipt(record, 'cancelled');
    f.deps.observe = async () => ({ response, generationCreatedAt: 10 });
    expect(await f.service.retrieve(owner, record.responseId)).toMatchObject({
      ok: true,
      response: { status: 'in_progress' },
    });
    await f.completion.stageAndFinish(record, receipt);
    expect(await f.service.retrieve(owner, record.responseId)).toEqual({ ok: true, response });
  }));

it.each(['retrieve', 'replay', 'cancel'] as const)(
  'routes %s of a pending receipt through completion without restarting or cancelling work',
  (entry) =>
    scope(async () => {
      const f = fixture();
      await f.service.create(envelope(), 'same');
      const record = await admit([...f.deliveries.values()][0]);
      const { response, receipt } = terminalReceipt(record);
      const staged = await storage.stageTerminal(
        owner,
        record.responseId,
        { execution: record },
        receipt,
      );
      if (!staged.ok) throw new Error('Fixture staging failed');
      const enqueue = jest.spyOn(f.deps, 'enqueue');
      const cancel = jest.spyOn(f.deps, 'cancel');
      const observe = jest.spyOn(f.deps, 'observe');
      const actions = {
        retrieve: () => f.service.retrieve(owner, record.responseId),
        replay: () => f.service.create(envelope(), 'same'),
        cancel: () => f.service.cancel(owner, record.responseId),
      };
      const result = await actions[entry]();
      expect(result).toEqual({ ok: true, response });
      expect(enqueue).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(observe).not.toHaveBeenCalled();
      expect(f.cleanupCheckpoint).toHaveBeenCalledTimes(1);
      expect(f.releaseExecution).toHaveBeenCalledTimes(1);
      expect(
        (await storage.read(owner, record.responseId))?.cancellationRequestedAt,
      ).toBeUndefined();
    }),
);

it('recovers a journal that wins a progress CAS race and waits for cleanup before returning its result', () =>
  scope(async () => {
    const f = fixture();
    await f.service.create(envelope(), 'same');
    const record = await admit([...f.deliveries.values()][0]);
    const { response, receipt } = terminalReceipt(record);
    f.deps.observe = async () => ({
      response: { ...response, status: 'in_progress' },
      generationCreatedAt: 10,
    });
    let releaseCleanup!: () => void;
    let enteredCleanup!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      enteredCleanup = resolve;
    });
    f.cleanupCheckpoint.mockImplementation(async () => {
      enteredCleanup();
      await gate;
    });
    const publish = storage.publish.bind(storage);
    const spy = jest.spyOn(storage, 'publish').mockImplementationOnce(async (...args) => {
      const staged = await storage.stageTerminal(
        owner,
        record.responseId,
        { execution: record },
        receipt,
      );
      if (!staged.ok) throw new Error('Fixture staging race failed');
      return publish(...args);
    });
    const read = f.service.retrieve(owner, record.responseId);
    let settled = false;
    void read.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await Promise.race([
        entered,
        read.then(() => {
          throw new Error('Read bypassed cleanup');
        }),
      ]);
      expect(settled).toBe(false);
      expect(f.releaseExecution).not.toHaveBeenCalled();
      expect((await storage.read(owner, record.responseId))?.pendingTerminal).toEqual(receipt);
      releaseCleanup();
      expect(await read).toEqual({ ok: true, response });
      expect(f.releaseExecution).toHaveBeenCalledTimes(1);
    } finally {
      releaseCleanup();
      await Promise.allSettled([read]);
      spy.mockRestore();
    }
  }));

it('withholds terminal output through checkpoint and execution-release failures', () =>
  scope(async () => {
    const f = fixture();
    await f.service.create(envelope(), 'same');
    const record = await admit([...f.deliveries.values()][0]);
    const { response, receipt } = terminalReceipt(record);
    const staged = await storage.stageTerminal(
      owner,
      record.responseId,
      { execution: record },
      receipt,
    );
    if (!staged.ok) throw new Error('Fixture staging failed');
    f.cleanupCheckpoint.mockRejectedValueOnce(new Error('checkpoint unavailable'));
    await expect(f.service.retrieve(owner, record.responseId)).rejects.toThrow(
      'checkpoint unavailable',
    );
    expect((await storage.read(owner, record.responseId))?.pendingTerminal).toEqual(receipt);
    expect(f.releaseExecution).not.toHaveBeenCalled();
    f.releaseExecution.mockRejectedValueOnce(new Error('release unavailable'));
    await expect(f.service.retrieve(owner, record.responseId)).rejects.toThrow(
      'release unavailable',
    );
    expect((await storage.read(owner, record.responseId))?.status).toBe('completed');
    expect(await f.service.retrieve(owner, record.responseId)).toEqual({ ok: true, response });
    expect(f.cleanupCheckpoint).toHaveBeenCalledTimes(2);
    expect(f.releaseExecution).toHaveBeenCalledTimes(2);
  }));

it('does not let a stale progress observation replace an enrolled generation or expose its output', () =>
  scope(async () => {
    const f = fixture();
    await f.service.create(envelope(), 'same');
    const record = await admit([...f.deliveries.values()][0]);
    f.deps.observe = async () => ({
      response: { ...completed(record), status: 'in_progress' },
      generationCreatedAt: 20,
    });
    expect(await f.service.retrieve(owner, record.responseId)).toMatchObject({
      ok: true,
      response: { output: [] },
    });
    expect((await storage.read(owner, record.responseId))?.generationCreatedAt).toBe(10);
  }));

it('rejects a runtime result carrying a different response identity', () =>
  scope(async () => {
    const { service, deps, deliveries } = fixture();
    await service.create(envelope(), 'same');
    const record = [...deliveries.values()][0];
    deps.observe = async () => ({ response: { ...completed(record), id: 'resp_other' } });
    await expect(service.retrieve(owner, record.responseId)).rejects.toThrow(
      'execution identity changed',
    );
    expect((await storage.read(owner, record.responseId))?.status).toBe('queued');
  }));

it.each([{ store: false }, { stream: true }, { background: false }])(
  'rejects unsupported background combinations before publication: %p',
  (payload) =>
    scope(async () => {
      const { service, deliveries } = fixture();
      expect(await service.create(envelope(payload), 'same')).toEqual({
        ok: false,
        status: 400,
        code: 'invalid_background_request',
      });
      expect(deliveries.size).toBe(0);
      expect(await mongoose.models.StoredResponse.countDocuments({})).toBe(0);
    }),
);

it.each(['queued', 'pending', 'completed'] as const)(
  'reauthorizes the original source key before replaying a %s record with a replacement key',
  (state) =>
    scope(async () => {
      const { deps, service, deliveries } = fixture();
      const allowed = new Set(['key-a', 'key-b']);
      const authorize = jest.fn(
        async (_owner: ResponseOwner, _agent: string, key?: string) =>
          key != null && allowed.has(key),
      );
      deps.authorize = authorize;
      expect((await service.create(envelope(), 'same-request', 'key-a')).ok).toBe(true);
      let record = [...deliveries.values()][0];
      const response = completed(record);
      if (state === 'completed') {
        expect(
          (
            await storage.publish(owner, record.responseId, record.revision, {
              status: 'completed',
              responseJSON: JSON.stringify(response),
            })
          ).ok,
        ).toBe(true);
      } else if (state === 'pending') {
        const running = await storage.publish(owner, record.responseId, record.revision, {
          status: 'in_progress',
          generationCreatedAt: 10,
          responseJSON: JSON.stringify({ ...response, status: 'in_progress' }),
        });
        if (!running.ok) throw new Error('Publication failed');
        record = running.record;
        expect(
          (
            await storage.stageTerminal(owner, record.responseId, record.revision, {
              generationCreatedAt: 10,
              providerExecutionId: 'provider',
              status: 'completed',
              responseJSON: JSON.stringify(response),
            })
          ).ok,
        ).toBe(true);
      }
      deliveries.clear();
      deps.enqueue = jest.fn();
      deps.observe = jest.fn();
      deps.recoverTerminal = jest.fn();
      allowed.delete('key-a');
      authorize.mockClear();
      expect(await service.create(envelope(), 'same-request', 'key-b')).toEqual({
        ok: false,
        status: 403,
        code: 'permission_denied',
      });
      expect(authorize.mock.calls.map((call) => call[2])).toEqual(['key-b', 'key-a']);
      expect(deps.enqueue).not.toHaveBeenCalled();
      expect(deps.observe).not.toHaveBeenCalled();
      expect(deps.recoverTerminal).not.toHaveBeenCalled();
      expect(deliveries.size).toBe(0);
    }),
);

it('does not add a second source-authority lookup for a newly reserved response', () =>
  scope(async () => {
    const { deps, service } = fixture();
    deps.authorize = jest.fn().mockResolvedValue(true);
    expect((await service.create(envelope(), 'new-request', 'key')).ok).toBe(true);
    expect(deps.authorize).toHaveBeenCalledTimes(1);
  }));

it('rejects JavaScript composition without a completion or execution-release owner before any reservation', async () => {
  const f = fixture();
  expect(() =>
    Reflect.apply(createBackgroundResponseService, undefined, [
      { ...f.deps, recoverTerminal: undefined },
    ]),
  ).toThrow('completion owner');
  expect(() =>
    Reflect.apply(createResponseCompletion, undefined, [
      { storage, cleanupCheckpoint: async () => {} },
    ]),
  ).toThrow('cleanup and release owners');
  expect(await runAsSystem(() => mongoose.models.StoredResponse.countDocuments({}))).toBe(0);
});

it('renders a private materialization phase without leaking its persisted status or intent', () => {
  const record = {
    responseId: 'resp_private',
    agentId: 'agent',
    status: 'materializing',
    requestJSON: JSON.stringify({ model: 'agent', input: 'Hello', background: true, store: true }),
    createdAt: new Date(),
    preparedTerminal: { responseJSON: 'private candidate', turnJSON: 'private history' },
  } as StoredResponseRecord;
  const response = buildPendingBackgroundResponse(record);
  expect(response).toMatchObject({
    status: 'in_progress',
    output: [],
    background: true,
    store: true,
  });
  expect(JSON.stringify(response)).not.toContain('materializing');
  expect(JSON.stringify(response)).not.toContain('private candidate');
  expect(JSON.stringify(response)).not.toContain('private history');
});
