import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createModels,
  createResponseStorage,
  tenantStorage,
  runAsSystem,
} from '@librechat/data-schemas';
import type { ResponseStorage, StoredResponseRecord } from '@librechat/data-schemas';
import type { BackgroundResponseTransportDependencies } from './transport';
import { createBackgroundResponseTransport } from './transport';

let mongo: MongoMemoryReplSet;
let storage: ResponseStorage;
let record: StoredResponseRecord;
const owner = { userId: '000000000000000000000001', tenantId: 'transport-test' };
type Fetch = NonNullable<BackgroundResponseTransportDependencies['fetch']>;
const scoped = <T>(work: () => Promise<T>) => tenantStorage.run(owner, work);
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ args: ['--nounixsocket'] }],
  });
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  createModels(mongoose);
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
  const saved = await scoped(() =>
    storage.reserve({
      ...owner,
      responseId: 'resp_test',
      agentId: 'agent',
      sourceKeyId: 'original-key',
      requestKey: 'request',
      fingerprint: 'fingerprint',
      requestJSON: JSON.stringify({
        model: 'agent',
        input: 'Private input',
        background: true,
        store: true,
      }),
      conversationId: 'conversation',
      parentMessageId: 'root',
    }),
  );
  if (!saved.ok) throw new Error('Reservation failed');
  record = saved.record;
});
async function enroll() {
  const result = await scoped(() =>
    storage.publish(owner, record.responseId, record.revision, {
      status: 'in_progress',
      responseJSON: JSON.stringify(ack),
      generationCreatedAt: 1234,
    }),
  );
  if (!result.ok) throw new Error('Enrollment failed');
}
function transport(fetch: Fetch, origin = 'http://127.0.0.1:3088') {
  return createBackgroundResponseTransport({
    storage,
    fetch,
    getOrigin: () => origin,
    signingSecret: () => 'transport-test-secret',
    acknowledgementTimeoutMs: async () => 1000,
  });
}
const ack = {
  id: 'resp_test',
  object: 'response',
  model: 'agent',
  status: 'in_progress',
  background: true,
  store: true,
};

it('sends only a server-purpose credential and saved reference through Responses ingress', async () => {
  const fetch: Fetch = async (url, init) => {
    expect(String(url)).toBe('http://127.0.0.1:3088/api/agents/v1/responses');
    expect(init?.body).toBe('{}');
    expect(init?.headers).toMatchObject({ 'x-lc-response-worker': '1' });
    expect(JSON.stringify(init)).not.toContain('Private input');
    await enroll();
    return Response.json(ack, { status: 202 });
  };
  await expect(scoped(() => transport(fetch)(record))).resolves.toEqual({
    status: 'started',
    generationCreatedAt: 1234,
  });
});

it('recovers a lost acknowledgement only when durable enrollment proves execution', async () => {
  const fetch: Fetch = async () => {
    await enroll();
    throw new Error('lost ACK');
  };
  await expect(scoped(() => transport(fetch)(record))).resolves.toEqual({
    status: 'resumed',
    generationCreatedAt: 1234,
  });
});

it('does not treat a network timeout without enrollment as successful dispatch', async () => {
  const fetch: Fetch = async () => {
    throw new Error('timeout');
  };
  await expect(scoped(() => transport(fetch)(record))).rejects.toMatchObject({
    code: 'response_acknowledgement_unavailable',
    certainty: 'ambiguous',
  });
});

it('attaches duplicate admission to the same enrolled generation', async () => {
  const fetch: Fetch = async () => {
    await enroll();
    return new Response('', { status: 409 });
  };
  await expect(scoped(() => transport(fetch)(record))).resolves.toEqual({
    status: 'resumed',
    generationCreatedAt: 1234,
  });
});

it.each([401, 403, 429, 503])(
  'classifies admission HTTP %s without exposing its body',
  async (status) => {
    const fetch: Fetch = async () => new Response('PRIVATE upstream failure', { status });
    await expect(scoped(() => transport(fetch)(record))).rejects.toMatchObject({
      message: 'Background response admission rejected',
      status,
      retryable: status === 429 || status >= 500,
      certainty: status >= 500 ? 'ambiguous' : 'definite',
    });
  },
);

it.each(['not JSON', JSON.stringify({ ...ack, id: 'other-response' }), JSON.stringify(ack)])(
  'does not accept an unproved or mismatched acknowledgement',
  async (body) => {
    const fetch: Fetch = async () => new Response(body, { status: 202 });
    await expect(scoped(() => transport(fetch)(record))).rejects.toMatchObject({
      code: 'response_acknowledgement_invalid',
    });
  },
);

it('refuses remote or credential-bearing worker origins before making a request', async () => {
  let calls = 0;
  const fetch: Fetch = async () => {
    calls++;
    return Response.json(ack);
  };
  for (const origin of [
    'https://example.com',
    'http://user:secret@127.0.0.1:3088',
    'file:///tmp/test',
  ]) {
    await expect(scoped(() => transport(fetch, origin)(record))).rejects.toThrow(
      'capable local listener',
    );
  }
  expect(calls).toBe(0);
});
