import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createResponseStorage, tenantStorage, runAsSystem } from '@librechat/data-schemas';
import type { ResponseStorage, StoredResponseRecord } from '@librechat/data-schemas';
import type { BackgroundResponseDependencies } from './background';
import type { ResponsesRunEnvelope } from '../envelope';
import type { Response } from './types';
import {
  buildAggregatedResponse,
  createResponseAggregator,
  createResponseContext,
} from './service';
import { createBackgroundResponseService } from './background';
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
  const deps: BackgroundResponseDependencies = {
    storage,
    authorize: async (principal, agentId) =>
      principal.userId === owner.userId && agentId === 'agent',
    resolveContinuation: async () => ({ conversationId: 'conversation', parentMessageId: 'root' }),
    enqueue: async (record) => {
      deliveries.set(record.deliveryKey!, record);
    },
    observe: async () => null,
    cancel: async () => {},
    now: () => 200,
  };
  return { deps, deliveries, service: createBackgroundResponseService(deps) };
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

it('returns exact terminal output and does not rerun or republish it on later reads', () =>
  scope(async () => {
    const { service, deps, deliveries } = fixture();
    await service.create(envelope(), 'same');
    const record = [...deliveries.values()][0];
    const response = completed(record);
    const observe = jest
      .spyOn(deps, 'observe')
      .mockResolvedValue({ response, generationCreatedAt: 10 });
    expect(await service.retrieve(owner, record.responseId)).toEqual({ ok: true, response });
    expect(await service.retrieve(owner, record.responseId)).toEqual({ ok: true, response });
    expect(observe).toHaveBeenCalledTimes(1);
  }));

it('persists cancellation intent before signalling and waits for actual provider completion', () =>
  scope(async () => {
    const { service, deps, deliveries } = fixture();
    await service.create(envelope(), 'same');
    const record = [...deliveries.values()][0];
    deps.cancel = async (current) => {
      expect((await storage.read(owner, current.responseId))?.cancellationRequestedAt).toBe(200);
    };
    const pending = await service.cancel(owner, record.responseId);
    expect(pending).toMatchObject({ ok: true, response: { status: 'queued' } });
    deps.observe = async () => ({
      response: { ...completed(record), status: 'cancelled', output: [] },
      generationCreatedAt: 10,
    });
    expect(await service.retrieve(owner, record.responseId)).toMatchObject({
      ok: true,
      response: { status: 'cancelled' },
    });
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
