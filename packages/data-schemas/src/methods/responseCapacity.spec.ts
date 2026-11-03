import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { ResponseReservation, StoredResponseRecord } from '~/models/response';
import type { ResponseTerminalReceipt } from './response';
import { createManagedMessageId, createManagedConversationId } from '~/utils/managed';
import { tenantStorage } from '~/config/tenantContext';
import { createResponseStorage } from './response';
import { responseReference } from './responseRoot';
import { createModels } from '~/models';

const engines = ['standalone', ...(process.env.FERRETDB_URI ? ['FerretDB'] : [])];
const owner = { userId: 'capacity-owner', tenantId: 'capacity-tenant' };
const scope = <T>(work: () => Promise<T>) => tenantStorage.run(owner, work);
const input = (): ResponseReservation => ({
  ...owner,
  responseId: createManagedMessageId(),
  conversationId: createManagedConversationId(),
  requestKey: randomUUID(),
  fingerprint: randomUUID(),
  agentId: 'agent',
  requestJSON: '{}',
  parentMessageId: 'root',
});

describe.each(engines)('Response configured capacity on %s', (engine) => {
  let mongo: MongoMemoryServer | undefined;
  let maximum = 2;
  const getConfig = jest.fn(async () => ({ maxPendingTargetsPerScope: maximum }));
  let storage: ReturnType<typeof createResponseStorage>;
  beforeAll(async () => {
    if (engine === 'standalone') mongo = await MongoMemoryServer.create();
    createModels(mongoose);
    await mongoose.connect(mongo?.getUri() ?? process.env.FERRETDB_URI!, {
      dbName: `capacity_${randomUUID().replace(/-/g, '')}`,
    });
  }, 60000);
  beforeEach(() => {
    maximum = 2;
    getConfig.mockClear();
    storage = createResponseStorage(mongoose, { getDurableStorageConfig: getConfig });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await mongoose.connection.db!.dropDatabase();
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
  });

  async function reserve(): Promise<StoredResponseRecord> {
    const result = await storage.reserve(input());
    if (!result.ok) throw new Error('Reservation failed');
    return result.record;
  }
  async function pendingRoot() {
    let ready!: () => void;
    let release!: () => void;
    const described = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const allowed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const collection = mongoose.models.StoredResponse.collection;
    const publish = collection.findOneAndUpdate.bind(collection);
    let paused = false;
    jest.spyOn(collection, 'findOneAndUpdate').mockImplementation(async (...args) => {
      const mutation = args[1];
      if (
        !paused &&
        !Array.isArray(mutation) &&
        mutation.$set?.['_managed.phase'] === 'published'
      ) {
        paused = true;
        ready();
        await allowed;
      }
      return publish(...args);
    });
    const pending = reserve();
    await described;
    return { release, pending };
  }
  it('uses live capacity for Root admission and reads config once per operation', () =>
    scope(async () => {
      const held = await pendingRoot();
      try {
        maximum = 1;
        expect(await storage.reserve(input())).toEqual({ ok: false, code: 'response_unavailable' });
        expect(getConfig).toHaveBeenCalledTimes(2);
        maximum = 2;
        expect((await storage.reserve(input())).ok).toBe(true);
        expect(getConfig).toHaveBeenCalledTimes(3);
      } finally {
        held.release();
        await held.pending;
      }
    }));
  it('applies the same live bound to Conversation seeding and confirmed Message publication', () =>
    scope(async () => {
      const record = await reserve();
      const binding = { generationCreatedAt: Date.now(), providerExecutionId: randomUUID() };
      const enrolled = await storage.enrollExecution(record, binding, '{}');
      if (!enrolled.ok || !(await storage.bindExecution(enrolled.record, binding)))
        throw new Error('Enrollment failed');
      const held = await pendingRoot();
      const writes = {
        context: { userId: owner.userId },
        conversation: {
          conversationId: record.conversationId,
          agent_id: record.agentId,
          endpoint: 'agents',
        },
        initialAgentId: record.agentId,
      };
      try {
        maximum = 1;
        expect(await storage.prepareConversation(enrolled.record, binding, writes)).toEqual({
          ok: false,
          code: 'response_conflict',
        });
        expect(await mongoose.models.Conversation.countDocuments({ user: owner.userId })).toBe(0);
        maximum = 2;
        const seeded = await storage.prepareConversation(enrolled.record, binding, writes);
        if (!seeded.ok) throw new Error('Seeding failed');
        const inputId = createManagedMessageId();
        const receipt: ResponseTerminalReceipt = {
          ...binding,
          status: 'completed',
          responseJSON: '{}',
          turnJSON: JSON.stringify({ version: 1, inputs: [{ messageId: inputId }] }),
        };
        expect(
          await storage.settleExecution(responseReference(seeded.record), binding, 'complete'),
        ).toBe(true);
        const staged = await storage.stageTerminal(
          seeded.record,
          record.responseId,
          { execution: seeded.record },
          receipt,
        );
        if (!staged.ok) throw new Error('Staging failed');
        const turn = {
          ...writes,
          intentJSON: receipt.turnJSON!,
          messages: [
            {
              messageId: inputId,
              conversationId: record.conversationId,
              parentMessageId: 'root',
              text: 'User input',
              isCreatedByUser: true,
              isUserSubmitted: true,
              sender: 'User',
              endpoint: 'agents',
            },
            {
              messageId: record.responseId,
              conversationId: record.conversationId,
              parentMessageId: 'root',
              text: 'Confirmed answer',
              isCreatedByUser: false,
              sender: 'Assistant',
              endpoint: 'agents',
            },
          ],
        };
        maximum = 1;
        getConfig.mockClear();
        expect(
          await storage.finishTerminal(
            staged.record,
            record.responseId,
            staged.record.revision,
            receipt,
            turn,
          ),
        ).toEqual({ ok: false, code: 'response_conflict' });
        expect(getConfig).toHaveBeenCalledTimes(1);
        expect(await mongoose.models.Message.countDocuments({ user: owner.userId })).toBe(0);
        maximum = 2;
        const current = await storage.read(record, record.responseId);
        if (!current) throw new Error('Root unavailable');
        const completed = await storage.finishTerminal(
          current,
          record.responseId,
          current.revision,
          receipt,
          turn,
        );
        expect(completed).toMatchObject({ ok: true, record: { status: 'completed' } });
        expect(getConfig).toHaveBeenCalledTimes(2);
        expect(await mongoose.models.Message.countDocuments({ user: owner.userId })).toBe(2);
      } finally {
        held.release();
        await held.pending;
      }
    }));
  it('propagates a configuration outage before allocating or publishing a new Root', () =>
    scope(async () => {
      const failure = new Error('base config unavailable');
      const unavailable = createResponseStorage(mongoose, {
        getDurableStorageConfig: async () => {
          throw failure;
        },
      });
      await expect(unavailable.reserve(input())).rejects.toBe(failure);
      expect(await mongoose.models.StoredResponse.countDocuments()).toBe(0);
    }));
});
