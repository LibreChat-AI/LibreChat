import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import type { DeadLetter, DeadLetterPage } from 'librechat-data-provider';
import type { Response as ExpressResponse } from 'express';
import type {
  AgentTriggerDeliveryPersistence,
  AgentTriggerService,
} from '~/agents/triggers/service';
import type { AgentTriggerFetch } from '~/agents/triggers/host';
import type { ServerRequest } from '~/types/http';
import { createAgentTriggerEnvelope } from '~/agents/triggers/envelope';
import { createAgentTriggerService } from '~/agents/triggers/service';
import { __resetShutdownStateForTests } from '~/app/shutdown';
import { createDeadLetters } from '~/agents/triggers/dead';
import { createAdminDeadLetterHandlers } from './dead';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const DB_SETUP_TIMEOUT_MS = 60_000;
const MARKER = 'MARKER-41c9';
const TENANT = 'tenant-a';
let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;
let service: AgentTriggerService;
let handlers: ReturnType<typeof createAdminDeadLetterHandlers>;
let reply: () => globalThis.Response;
let fetcher: jest.Mock<ReturnType<AgentTriggerFetch>, Parameters<AgentTriggerFetch>>;
let counter = 0;

const rejected = () =>
  new Response(JSON.stringify({ error: `the prompt was ${MARKER}`, code: `bad ${MARKER}` }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });

const started = () =>
  new Response(
    JSON.stringify({
      status: 'started',
      streamId: 'conversation-1',
      conversationId: 'conversation-1',
      generationCreatedAt: 25,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  await mongoose.models.AuditLog.createIndexes();
}, DB_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
}, DB_SETUP_TIMEOUT_MS);

beforeEach(async () => {
  reply = rejected;
  fetcher = jest.fn<ReturnType<AgentTriggerFetch>, Parameters<AgentTriggerFetch>>(async () =>
    reply(),
  );
  methods = createMethods(mongoose);
  service = createAgentTriggerService({
    methods: methods as typeof methods & AgentTriggerDeliveryPersistence,
    fetch: fetcher,
    mintToken: () => 'trigger-token',
    deliveryOptions: { concurrency: 2, tickMs: 5, retryBaseMs: 5 },
  });
  await service.initialize({ address: { address: '127.0.0.1', family: 'IPv4', port: 3080 } });
  handlers = createAdminDeadLetterHandlers({
    letters: createDeadLetters({ methods, requeue: service.requeue }),
    recordAuditEntry: methods.recordAuditEntry,
    auditFailClosed: true,
  });
});

afterEach(async () => {
  await service.stop();
  __resetShutdownStateForTests();
  await mongoose.models.AgentTriggerDelivery.deleteMany({});
});

type Handler = (req: ServerRequest, res: ExpressResponse) => Promise<ExpressResponse>;

async function call(
  handler: Handler,
  input: { tenantId?: string; id?: string; query?: Record<string, string> } = {},
): Promise<{ status: number; body: unknown }> {
  const userId = new mongoose.Types.ObjectId();
  const req = {
    params: input.id == null ? {} : { id: input.id },
    query: input.query ?? {},
    body: {},
    headers: {},
    user: {
      _id: userId,
      id: String(userId),
      role: 'ADMIN',
      name: 'Ada Admin',
      ...(input.tenantId != null && { tenantId: input.tenantId }),
    },
  } as unknown as ServerRequest;
  const sent = { status: 0, body: undefined as unknown };
  const res = {
    status(code: number) {
      sent.status = code;
      return res;
    },
    json(body: unknown) {
      sent.body = body;
      return res;
    },
  } as unknown as ExpressResponse;
  await handler(req, res);
  return sent;
}

async function until(condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for the delivery queue');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Enqueues an event that the host rejects, and waits for it to dead-letter. */
async function kill(tenantId: string | null = TENANT, source = 'webhook'): Promise<string> {
  counter += 1;
  const receipt = await service.enqueue(
    createAgentTriggerEnvelope({
      mode: 'fire',
      requestId: `request-${counter}`,
      deliveryId: `delivery-${counter}`,
      receivedAt: Date.now(),
      principal: {
        id: new mongoose.Types.ObjectId().toString(),
        ...(tenantId != null && { tenantId }),
      },
      target: { agentId: 'agent_reports' },
      event: {
        id: `event-${counter}`,
        type: 'resource.ready',
        occurredAt: Date.now(),
        payload: { note: MARKER },
        source: { id: `source-${counter}`, type: source },
      },
      input: `Summarize ${MARKER}`,
    }),
    { orderingKey: `lane-${counter}` },
  );
  await until(async () => (await service.getDelivery(receipt.deliveryKey))?.status === 'dead');
  return receipt.id;
}

const list = (tenantId?: string, query?: Record<string, string>) =>
  call(handlers.list, { tenantId, query }) as Promise<{ status: number; body: DeadLetterPage }>;

/** The audit log is append-only, so each test reads the entries of its own deliveries. */
const audit = (...ids: string[]) =>
  mongoose.models.AuditLog.find({ 'target.id': { $in: ids } })
    .sort({ 'integrity.seq': 1 })
    .lean<
      Array<{
        action: string;
        outcome: string;
        category: string;
        tenantId?: string;
        target: { type: string; id: string };
        metadata?: Record<string, unknown>;
      }>
    >();

describe('admin dead letters over a real queue', () => {
  it('lists a real dead letter as metadata, without what it carried or why it failed', async () => {
    const id = await kill();

    const { status, body } = await list(TENANT);

    expect(status).toBe(200);
    expect(body).toMatchObject({ total: 1, limit: 50, offset: 0 });
    const expected: DeadLetter = {
      id,
      key: expect.stringMatching(/^trigger_[a-f0-9]{64}$/),
      userId: expect.stringMatching(/^[a-f0-9]{24}$/),
      source: 'webhook',
      event: 'resource.ready',
      agentId: 'agent_reports',
      attempts: 1,
      requeues: 0,
      code: 'UNCLASSIFIED',
      requeueable: true,
      dismissable: true,
      createdAt: expect.any(String),
      diedAt: expect.any(String),
    };
    expect(body.letters).toEqual([expected]);
    const stored = await mongoose.models.AgentTriggerDelivery.findById(id).lean();
    expect(JSON.stringify(stored)).toContain(MARKER);
    expect(JSON.stringify(body)).not.toContain(MARKER);
  });

  it('keeps one tenant from listing, requeueing or dismissing another tenant’s delivery', async () => {
    const id = await kill();
    const tenantless = await kill(null);

    await expect(list('tenant-b')).resolves.toMatchObject({ body: { letters: [], total: 0 } });
    await expect(list()).resolves.toMatchObject({
      body: { letters: [{ id: tenantless }], total: 1 },
    });
    for (const tenantId of ['tenant-b', undefined]) {
      await expect(call(handlers.requeue, { tenantId, id })).resolves.toEqual({
        status: 404,
        body: { error: 'Dead letter not found', code: 'DEAD_LETTER_NOT_FOUND' },
      });
      await expect(call(handlers.dismiss, { tenantId, id })).resolves.toEqual({
        status: 404,
        body: { error: 'Dead letter not found', code: 'DEAD_LETTER_NOT_FOUND' },
      });
    }
    await expect(call(handlers.dismiss, { tenantId: TENANT, id: tenantless })).resolves.toEqual({
      status: 404,
      body: { error: 'Dead letter not found', code: 'DEAD_LETTER_NOT_FOUND' },
    });

    await expect(mongoose.models.AgentTriggerDelivery.find({}).distinct('status')).resolves.toEqual(
      ['dead'],
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(audit(id, tenantless)).resolves.toEqual([]);
  });

  it('requeues a dead letter once, runs it again and records both audit entries', async () => {
    const id = await kill();
    reply = started;

    const first = await call(handlers.requeue, { tenantId: TENANT, id });

    expect(first).toEqual({ status: 200, body: { id, requeued: true } });
    await until(
      async () =>
        (await mongoose.models.AgentTriggerDelivery.findById(id).lean<{ status: string }>())
          ?.status === 'succeeded',
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(call(handlers.requeue, { tenantId: TENANT, id })).resolves.toMatchObject({
      status: 404,
    });
    await expect(list(TENANT)).resolves.toMatchObject({ body: { letters: [], total: 0 } });

    const entries = await audit(id);
    expect(entries.map(({ action, outcome }) => [action, outcome])).toEqual([
      ['dead_letter.requeued', 'pending'],
      ['dead_letter.requeued', 'success'],
    ]);
    expect(entries[0]).toMatchObject({
      category: 'agent_run',
      tenantId: TENANT,
      target: { type: 'dead_letter', id },
      metadata: { source: 'webhook', agentId: 'agent_reports', failure: 'UNCLASSIFIED' },
    });
    expect(JSON.stringify(entries)).not.toContain(MARKER);
  });

  it('dismisses a dead letter for good and records both audit entries', async () => {
    const id = await kill();

    const dismissed = await call(handlers.dismiss, { tenantId: TENANT, id });

    expect(dismissed).toEqual({ status: 200, body: { id, dismissed: true } });
    await expect(mongoose.models.AgentTriggerDelivery.countDocuments({})).resolves.toBe(0);
    await expect(call(handlers.dismiss, { tenantId: TENANT, id })).resolves.toMatchObject({
      status: 404,
    });
    await expect(call(handlers.requeue, { tenantId: TENANT, id })).resolves.toMatchObject({
      status: 404,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const entries = await audit(id);
    expect(entries.map(({ action, outcome }) => [action, outcome])).toEqual([
      ['dead_letter.dismissed', 'pending'],
      ['dead_letter.dismissed', 'success'],
    ]);
  });

  it('refuses to requeue a delivery that already reached a generation', async () => {
    const id = await kill();
    await mongoose.models.AgentTriggerDelivery.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      {
        $set: {
          handling: {
            status: 'failed',
            conversationId: 'conversation-1',
            streamId: 'stream-1',
            generationCreatedAt: 25,
            startedAt: new Date(),
          },
        },
      },
    );

    await expect(list(TENANT)).resolves.toMatchObject({
      body: { letters: [{ id, requeueable: false, dismissable: true }] },
    });
    await expect(call(handlers.requeue, { tenantId: TENANT, id })).resolves.toEqual({
      status: 409,
      body: { error: 'Dead letter cannot be requeued', code: 'DEAD_LETTER_NOT_REQUEUEABLE' },
    });
    const entries = await audit(id);
    expect(entries.map(({ outcome, metadata }) => [outcome, metadata?.reason])).toEqual([
      ['pending', undefined],
      ['failure', 'conflict'],
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refuses to requeue a schedule occurrence, whose run its schedule has already ended', async () => {
    const id = await kill(TENANT, 'schedule');
    reply = started;

    await expect(list(TENANT)).resolves.toMatchObject({
      body: { letters: [{ id, source: 'schedule', requeueable: false, dismissable: true }] },
    });
    await expect(call(handlers.requeue, { tenantId: TENANT, id })).resolves.toEqual({
      status: 409,
      body: { error: 'Dead letter cannot be requeued', code: 'DEAD_LETTER_NOT_REQUEUEABLE' },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(
      mongoose.models.AgentTriggerDelivery.findById(id).lean<{ status: string }>(),
    ).resolves.toMatchObject({ status: 'dead', requeueCount: 0 });
    await expect(call(handlers.dismiss, { tenantId: TENANT, id })).resolves.toMatchObject({
      status: 200,
    });
  });

  it('answers a stopped queue with 503 on requeue and still lists and dismisses', async () => {
    const id = await kill();
    await service.stop();

    await expect(call(handlers.requeue, { tenantId: TENANT, id })).resolves.toEqual({
      status: 503,
      body: { error: 'Delivery queue is not available', code: 'DEAD_LETTER_UNAVAILABLE' },
    });
    await expect(list(TENANT)).resolves.toMatchObject({ body: { letters: [{ id }], total: 1 } });
    await expect(call(handlers.dismiss, { tenantId: TENANT, id })).resolves.toMatchObject({
      status: 200,
    });
  });
});
