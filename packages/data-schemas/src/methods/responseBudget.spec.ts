import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { ResponseReservation, StoredResponseRecord } from '~/models/response';
import { createManagedMessageId, createManagedConversationId } from '~/utils/managed';
import { responseUpdateFits, RESPONSE_BUDGET_FIELDS } from './responseBudget';
import { checkpointOwnerNamespacePrefix } from '~/utils/checkpoint';
import { tenantStorage } from '~/config/tenantContext';
import { createResponseStorage } from './response';
import { responseReference } from './responseRoot';
import { createModels } from '~/models';

const owner = { userId: 'budget-owner', tenantId: 'budget-tenant' };
const scope = <T>(work: () => Promise<T>) => tenantStorage.run(owner, work);
const engines = ['standalone', ...(process.env.FERRETDB_URI ? ['FerretDB'] : [])];
const MiB = 1024 * 1024;
const input = (fields: Partial<ResponseReservation> = {}): ResponseReservation => ({
  ...owner,
  responseId: createManagedMessageId(),
  conversationId: createManagedConversationId(),
  agentId: 'agent',
  requestKey: randomUUID(),
  fingerprint: randomUUID(),
  requestJSON: '{}',
  parentMessageId: 'root',
  ...fields,
});
describe.each(engines)('whole Response BSON budget on %s', (engine) => {
  let mongo: MongoMemoryServer | undefined;
  let storage: ReturnType<typeof createResponseStorage>;
  beforeAll(async () => {
    if (engine === 'standalone') mongo = await MongoMemoryServer.create();
    createModels(mongoose);
    await mongoose.connect(mongo?.getUri() ?? process.env.FERRETDB_URI!, {
      dbName: `budget_${randomUUID().replace(/-/g, '')}`,
    });
  });
  beforeEach(() => {
    storage = createResponseStorage(mongoose);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await mongoose.connection.db!.dropDatabase();
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
  });
  async function reserve(fields: Partial<ResponseReservation> = {}): Promise<StoredResponseRecord> {
    const saved = await storage.reserve(input(fields));
    if (!saved.ok) throw new Error(`Reservation failed: ${saved.code}`);
    return saved.record;
  }
  it('rejects oversized UTF-8 before allocation or discovery while accepting the same character count in ASCII', () =>
    scope(async () => {
      expect(
        await storage.reserve(
          input({ requestJSON: JSON.stringify({ input: 'é'.repeat(8 * MiB) }) }),
        ),
      ).toEqual({ ok: false, code: 'document_limit' });
      expect(await mongoose.models.StoredResponse.collection.countDocuments({})).toBe(0);
      expect(await mongoose.models.ResponseScope.collection.countDocuments({})).toBe(0);
      expect(
        (
          await storage.reserve(
            input({ requestJSON: JSON.stringify({ input: 'a'.repeat(8 * MiB) }) }),
          )
        ).ok,
      ).toBe(true);
    }));
  it('measures request plus proposed provider view together instead of independent JSON limits', () =>
    scope(async () => {
      const record = await reserve({ requestJSON: JSON.stringify({ input: 'x'.repeat(8 * MiB) }) });
      expect(
        await storage.enrollExecution(
          record,
          { generationCreatedAt: 1, providerExecutionId: randomUUID() },
          JSON.stringify({ view: 'x'.repeat(8 * MiB) }),
        ),
      ).toEqual({ ok: false, code: 'document_limit' });
      expect(await storage.read(record, record.responseId)).toMatchObject({ status: 'queued' });
      expect((await storage.read(record, record.responseId))?.generationCreatedAt).toBeUndefined();
    }));
  it('budgets the entire eventual selection map before accepting a receipt despite zero pending discovery', () =>
    scope(async () => {
      const record = await reserve();
      const binding = { generationCreatedAt: 1, providerExecutionId: randomUUID() };
      const enrolled = await storage.enrollExecution(record, binding, '{}');
      if (!enrolled.ok || !(await storage.bindExecution(enrolled.record, binding)))
        throw new Error('Enrollment failed');
      const receipt = {
        ...binding,
        status: 'completed' as const,
        responseJSON: JSON.stringify({ answer: 'x'.repeat(13 * MiB) }),
        turnJSON: JSON.stringify({
          version: 1,
          inputs: Array.from({ length: 10000 }, () => ({ messageId: createManagedMessageId() })),
        }),
      };
      expect(
        mongoose.mongo.BSON.calculateObjectSize({ ...enrolled.record, preparedTerminal: receipt }),
      ).toBeLessThan(16 * MiB);
      expect(
        await storage.prepareTerminal(
          enrolled.record,
          record.responseId,
          { execution: enrolled.record },
          receipt,
        ),
      ).toEqual({ ok: false, code: 'document_limit' });
      expect((await storage.read(record, record.responseId))?.preparedTerminal).toBeUndefined();
      const anchors = await mongoose.models.ResponseScope.find({}).lean<
        Array<{ pendingCount: number }>
      >();
      expect(anchors.every((anchor) => anchor.pendingCount === 0)).toBe(true);
    }));
  it('fences a stale preflight against concurrent growth and checks the new revision on retry', () =>
    scope(async () => {
      const record = await reserve({ requestJSON: JSON.stringify({ input: 'x'.repeat(8 * MiB) }) });
      const view = JSON.stringify({ progress: 'x'.repeat(5 * MiB) });
      let entered!: () => void;
      let resume!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const collection = mongoose.models.StoredResponse.collection;
      const original = collection.findOneAndUpdate.bind(collection);
      let held = false;
      jest.spyOn(collection, 'findOneAndUpdate').mockImplementation(async (...args) => {
        const update = args[1];
        if (!held && !Array.isArray(update) && update.$set?.responseJSON === view) {
          held = true;
          entered();
          await gate;
        }
        return original(...args);
      });
      const first = storage.publish(record, record.responseId, record.revision, {
        status: 'queued',
        responseJSON: view,
      });
      try {
        await ready;
        expect(
          (await storage.attachDelivery(record, record.responseId, 'k'.repeat(5 * MiB))).ok,
        ).toBe(true);
      } finally {
        resume();
      }
      expect(await first).toEqual({ ok: false, code: 'response_conflict' });
      const latest = (await storage.read(record, record.responseId))!;
      expect(
        await storage.publish(latest, latest.responseId, latest.revision, {
          status: 'queued',
          responseJSON: view,
        }),
      ).toEqual({ ok: false, code: 'document_limit' });
      const actual = await mongoose.models.StoredResponse.findById(record.storageTarget!.id)
        .select(RESPONSE_BUDGET_FIELDS)
        .lean<StoredResponseRecord>();
      expect(mongoose.mongo.BSON.calculateObjectSize(actual!)).toBeLessThan(16 * MiB);
      expect(actual?.responseJSON).toBeUndefined();
    }));
  it(
    'keeps enough physical headroom to settle an admitted saver after failure freezes a full Root',
    () =>
      scope(async () => {
        const record = await reserve();
        const binding = { generationCreatedAt: 1, providerExecutionId: randomUUID() };
        const enrolled = await storage.enrollExecution(record, binding, '{}');
        if (!enrolled.ok || !(await storage.bindExecution(enrolled.record, binding)))
          throw new Error('Enrollment failed');
        const seeded = await storage.prepareConversation(enrolled.record, binding, {
          context: { userId: owner.userId },
          conversation: {
            conversationId: record.conversationId,
            agent_id: record.agentId,
            endpoint: 'agents',
          },
          initialAgentId: record.agentId,
        });
        if (!seeded.ok) throw new Error('Conversation seeding failed');
        const writer = storage.createCheckpointWriter(responseReference(enrolled.record), {
          ...binding,
          writerId: randomUUID(),
          namespace: `${checkpointOwnerNamespacePrefix(owner.userId, owner.tenantId)}${randomUUID()}`,
          configJSON: JSON.stringify({
            type: 'mongo',
            checkpointCollectionName: 'budget_cp',
            checkpointWritesCollectionName: 'budget_cpw',
          }),
        });
        expect(await writer.open()).toBe(true);
        const snapshot = await mongoose.models.StoredResponse.findById(record.storageTarget!.id)
          .select(RESPONSE_BUDGET_FIELDS)
          .lean<StoredResponseRecord>();
        const body = (bytes: number) => JSON.stringify({ progress: 'x'.repeat(bytes) });
        let low = 0;
        let high = 16 * MiB;
        while (low + 1 < high) {
          const middle = Math.floor((low + high) / 2);
          if (responseUpdateFits(mongoose, snapshot!, { $set: { responseJSON: body(middle) } }))
            low = middle;
          else high = middle;
        }
        const published = await storage.publish(snapshot!, record.responseId, snapshot!.revision, {
          status: 'in_progress',
          responseJSON: body(low),
        });
        if (!published.ok) throw new Error('Boundary progress failed');
        const failed = await storage.recordPersistenceFailure(published.record, {
          ...binding,
          code: 'document_limit',
        });
        expect(failed.ok).toBe(true);
        expect(await writer.settle()).toBe(true);
        const physical = await mongoose.models.StoredResponse.findById(record.storageTarget!.id)
          .select(RESPONSE_BUDGET_FIELDS)
          .lean<StoredResponseRecord>();
        expect(mongoose.mongo.BSON.calculateObjectSize(physical!)).toBeLessThan(16 * MiB);
        expect(physical?.checkpoint?.state).toBe('settled');
        expect(
          await storage.settleExecution(responseReference(enrolled.record), binding, 'complete'),
        ).toBe(true);
        const proof = await storage.readExecutionProof(enrolled.record);
        if (!proof) throw new Error('Positive settlement proof missing');
        expect(await storage.acknowledgeCheckpointErasure(enrolled.record, proof)).toBe(true);
        const pending = (await storage.read(record, record.responseId))!;
        const finished = await storage.finishPersistenceFailure(
          pending,
          JSON.stringify({
            id: record.responseId,
            model: record.agentId,
            object: 'response',
            status: 'failed',
            background: true,
            store: true,
            output: [],
          }),
        );
        expect(finished).toMatchObject({
          ok: true,
          record: { status: 'failed', requestJSON: '{}', fingerprint: record.fingerprint },
        });
        expect(await storage.readReleaseAuthority(enrolled.record)).toMatchObject({
          kind: 'provider',
          proof: { releaseReady: true },
        });
      }),
    60000,
  );
  it('refuses a partial snapshot rather than undercounting hidden fields', () =>
    scope(async () => {
      const record = await reserve();
      const ordinary = await mongoose.models.StoredResponse.findById(
        record.storageTarget!.id,
      ).lean<StoredResponseRecord>();
      expect(() => responseUpdateFits(mongoose, ordinary!, {})).toThrow(
        'complete physical snapshot',
      );
      const complete = await mongoose.models.StoredResponse.findById(record.storageTarget!.id)
        .select(RESPONSE_BUDGET_FIELDS)
        .lean<StoredResponseRecord>();
      expect(responseUpdateFits(mongoose, complete!, {})).toBe(true);
    }));
});
