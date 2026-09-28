import { v4 as uuidv4 } from 'uuid';
import mongoose, { type FilterQuery } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { EModelEndpoint, RetentionMode } from 'librechat-data-provider';
import type {
  Document,
  Filter,
  FindOneAndUpdateOptions,
  UpdateFilter,
  UpdateResult,
} from 'mongodb';
import type {
  IAgentEventActorReconciliation,
  IAgentEventActorSuspensionEvidence,
  IChatProject,
  IConversation,
  AppConfig,
} from '../types';
import { ConversationMethods, createConversationMethods } from './conversation';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createModels } from '../models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

const MEILI_SEARCH_LIMIT = 1000;
let mongoServer: InstanceType<typeof MongoMemoryServer>;
let Conversation: mongoose.Model<IConversation>;
let ChatProject: mongoose.Model<IChatProject>;
let ConversationTag: mongoose.Model<{
  user: string;
  tag: string;
  count: number;
  position: number;
}>;
let modelsToCleanup: string[] = [];

// Mock message methods (same as original test mocking ./Message)
const getMessages = jest.fn().mockResolvedValue([]);
const deleteMessages = jest.fn().mockResolvedValue({ deletedCount: 0 });
const searchMessages = jest.fn().mockResolvedValue({ hits: [] });

let methods: ConversationMethods;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();

  const models = createModels(mongoose);
  modelsToCleanup = Object.keys(models);
  Object.assign(mongoose.models, models);
  Conversation = mongoose.models.Conversation as mongoose.Model<IConversation>;
  ChatProject = mongoose.models.ChatProject as mongoose.Model<IChatProject>;
  ConversationTag = mongoose.models.ConversationTag as mongoose.Model<{
    user: string;
    tag: string;
    count: number;
    position: number;
  }>;

  methods = createConversationMethods(mongoose, { getMessages, deleteMessages, searchMessages });

  await mongoose.connect(mongoUri);
});

afterAll(async () => {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }

  for (const modelName of modelsToCleanup) {
    if (mongoose.models[modelName]) {
      delete mongoose.models[modelName];
    }
  }

  await mongoose.disconnect();
  await mongoServer.stop();
});

const saveConvo = (...args: Parameters<ConversationMethods['saveConvo']>) =>
  methods.saveConvo(...args) as Promise<IConversation | null>;
const setConvoPinned = (...args: Parameters<ConversationMethods['setConvoPinned']>) =>
  methods.setConvoPinned(...args);
const getConvo = (...args: Parameters<ConversationMethods['getConvo']>) =>
  methods.getConvo(...args);
const getConvoRetention = (...args: Parameters<ConversationMethods['getConvoRetention']>) =>
  methods.getConvoRetention(...args);
const getConvoTitle = (...args: Parameters<ConversationMethods['getConvoTitle']>) =>
  methods.getConvoTitle(...args);
const getConvoFiles = (...args: Parameters<ConversationMethods['getConvoFiles']>) =>
  methods.getConvoFiles(...args);
const deleteConvos = (...args: Parameters<ConversationMethods['deleteConvos']>) =>
  methods.deleteConvos(...args);
const archiveAllConvos = (...args: Parameters<ConversationMethods['archiveAllConvos']>) =>
  methods.archiveAllConvos(...args);
const getConvosByCursor = (...args: Parameters<ConversationMethods['getConvosByCursor']>) =>
  methods.getConvosByCursor(...args);
const getConvosQueried = (...args: Parameters<ConversationMethods['getConvosQueried']>) =>
  methods.getConvosQueried(...args);
const deleteNullOrEmptyConversations = (
  ...args: Parameters<ConversationMethods['deleteNullOrEmptyConversations']>
) => methods.deleteNullOrEmptyConversations(...args);
const searchConversation = (...args: Parameters<ConversationMethods['searchConversation']>) =>
  methods.searchConversation(...args);

/** The archive sweep discovers projects either by a bounded id list or by its own
 * `archivedAt` marker, and the tests below assert which of the two a call used. */
type ArchiveDistinctFilter = {
  _id?: { $in?: unknown[] };
  user?: string;
  isArchived?: boolean;
  archivedAt?: Date;
};

describe('Conversation Operations', () => {
  let mockCtx: {
    userId: string;
    isTemporary?: boolean;
    expiredAt?: Date;
    interfaceConfig?: AppConfig['interfaceConfig'];
  };
  let mockConversationData: {
    conversationId: string;
    title: string;
    endpoint: string;
  };

  beforeEach(async () => {
    // Clear database
    await Conversation.deleteMany({});
    await ChatProject.deleteMany({});
    await ConversationTag.deleteMany({});

    // Reset mocks
    jest.clearAllMocks();
    getMessages.mockResolvedValue([]);
    deleteMessages.mockResolvedValue({ deletedCount: 0 });
    searchMessages.mockResolvedValue({ hits: [] });

    mockCtx = {
      userId: 'user123',
      interfaceConfig: {
        temporaryChatRetention: 24, // Default 24 hours
      },
    };

    mockConversationData = {
      conversationId: uuidv4(),
      title: 'Test Conversation',
      endpoint: EModelEndpoint.openAI,
    };
  });

  describe('saveConvo', () => {
    it('should save a conversation for an authenticated user', async () => {
      const result = await saveConvo(mockCtx, mockConversationData);

      expect(result?.conversationId).toBe(mockConversationData.conversationId);
      expect(result?.user).toBe('user123');
      expect(result?.title).toBe('Test Conversation');
      expect(result?.endpoint).toBe(EModelEndpoint.openAI);

      // Verify the conversation was actually saved to the database
      const savedConvo = await Conversation.findOne<IConversation>({
        conversationId: mockConversationData.conversationId,
        user: 'user123',
      });
      expect(savedConvo).toBeTruthy();
      expect(savedConvo?.title).toBe('Test Conversation');
    });

    it('rejects actor checkpoint ownership evidence through ordinary saves and imports', async () => {
      const forged = {
        agentEventActor: {
          generation: 1,
          checkpoint: {
            threadId: 'other',
            checkpointNs: 'event-actor/other',
            checkpointId: 'other',
          },
        },
        agentEventActorCleanup: [
          { threadId: 'other', checkpointNs: 'event-actor/other', checkpointId: 'other' },
        ],
        agentEventActorReconciliations: [
          {
            checkpoint: {
              threadId: 'other',
              checkpointNs: 'event-actor/other',
              checkpointId: 'other',
            },
          },
        ],
        agentEventActorSuspension: { status: 'closed' },
        'agentEventActor.checkpoint': {
          threadId: 'other',
          checkpointNs: 'event-actor/other',
          checkpointId: 'other',
        },
        'agentEventActorCleanup.0': {
          threadId: 'other',
          checkpointNs: 'event-actor/other',
          checkpointId: 'other',
        },
      };
      await saveConvo(mockCtx, { ...mockConversationData, ...forged });
      await methods.bulkSaveConvos([{ ...mockConversationData, user: mockCtx.userId, ...forged }]);
      const saved = await Conversation.findOne({
        conversationId: mockConversationData.conversationId,
        user: mockCtx.userId,
      })
        .select(
          '+agentEventActor +agentEventActorCleanup +agentEventActorReconciliations +agentEventActorSuspension',
        )
        .lean();
      for (const field of Object.keys(forged)) {
        expect(saved).not.toHaveProperty(field);
      }
    });

    it('sets immutable agent attribution from server metadata only on insert', async () => {
      await saveConvo(
        mockCtx,
        {
          ...mockConversationData,
          agent_id: 'agent-a',
          initial_agent_id: 'forged-agent',
        },
        { initialAgentId: 'agent-a' },
      );
      await saveConvo(
        mockCtx,
        {
          conversationId: mockConversationData.conversationId,
          agent_id: 'agent-b',
          initial_agent_id: 'forged-agent-b',
        },
        { initialAgentId: 'agent-b' },
      );

      const saved = await Conversation.findOne({
        conversationId: mockConversationData.conversationId,
        user: mockCtx.userId,
      })
        .select('+initial_agent_id')
        .lean();
      expect(saved?.initial_agent_id).toBe('agent-a');
      expect(saved?.agent_id).toBe('agent-b');
    });

    it('stores explicit null attribution for a new non-agent conversation', async () => {
      await saveConvo(mockCtx, mockConversationData);

      const saved = await Conversation.findOne({
        conversationId: mockConversationData.conversationId,
        user: mockCtx.userId,
      })
        .select('+initial_agent_id')
        .lean();
      expect(saved).toHaveProperty('initial_agent_id', null);
    });

    it('should query messages when saving a conversation', async () => {
      // Mock messages as ObjectIds
      const mockMessages = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
      getMessages.mockResolvedValue(mockMessages);

      await saveConvo(mockCtx, mockConversationData);

      // Verify that getMessages was called with correct parameters
      expect(getMessages).toHaveBeenCalledWith(
        { conversationId: mockConversationData.conversationId, user: mockCtx.userId },
        '_id',
      );
    });

    it('should handle newConversationId when provided', async () => {
      const newConversationId = uuidv4();
      const result = await saveConvo(mockCtx, {
        ...mockConversationData,
        newConversationId,
      });

      expect(result?.conversationId).toBe(newConversationId);
    });

    it('refreshes project stats when archiving a project conversation', async () => {
      const project = await ChatProject.create({
        user: mockCtx.userId,
        name: 'Project Stats',
        conversationCount: 0,
        lastConversationAt: null,
        lastConversationId: null,
      });
      const firstConversationId = uuidv4();
      const secondConversationId = uuidv4();
      const chatProjectId = project._id!.toString();

      await saveConvo(mockCtx, {
        conversationId: firstConversationId,
        title: 'First',
        endpoint: EModelEndpoint.openAI,
        chatProjectId,
      });
      await saveConvo(mockCtx, {
        conversationId: secondConversationId,
        title: 'Second',
        endpoint: EModelEndpoint.openAI,
        chatProjectId,
      });

      await saveConvo(mockCtx, {
        conversationId: secondConversationId,
        isArchived: true,
      });

      const refreshedProject = await ChatProject.findById(project._id).lean<IChatProject>();
      expect(refreshedProject?.conversationCount).toBe(1);
      expect(refreshedProject?.lastConversationId).toBe(firstConversationId);
    });

    it('bulkSaveConvos keeps owned project ids and strips orphan ones', async () => {
      const project = await ChatProject.create({
        user: mockCtx.userId,
        name: 'Bulk Project',
        conversationCount: 0,
        lastConversationAt: null,
        lastConversationId: null,
      });
      const ownedId = project._id!.toString();
      const orphanId = new mongoose.Types.ObjectId().toString();
      const ownedConvoId = uuidv4();
      const orphanConvoId = uuidv4();

      await methods.bulkSaveConvos([
        {
          conversationId: ownedConvoId,
          user: mockCtx.userId,
          endpoint: EModelEndpoint.openAI,
          chatProjectId: ownedId,
        },
        {
          conversationId: orphanConvoId,
          user: mockCtx.userId,
          endpoint: EModelEndpoint.openAI,
          chatProjectId: orphanId,
        },
      ]);

      const ownedConvo = await Conversation.findOne({
        conversationId: ownedConvoId,
      }).lean<IConversation>();
      const orphanConvo = await Conversation.findOne({
        conversationId: orphanConvoId,
      }).lean<IConversation>();

      expect(ownedConvo?.chatProjectId).toBe(ownedId);
      expect(orphanConvo?.chatProjectId == null).toBe(true);

      const refreshedProject = await ChatProject.findById(project._id).lean<IChatProject>();
      expect(refreshedProject?.conversationCount).toBe(1);
    });

    it('bulkSaveConvos strips supplied attribution and stores explicit null on insert', async () => {
      const conversationId = uuidv4();

      await methods.bulkSaveConvos([
        {
          conversationId,
          user: mockCtx.userId,
          endpoint: EModelEndpoint.openAI,
          initial_agent_id: 'forged-agent',
        },
      ]);

      const saved = await Conversation.findOne({ conversationId, user: mockCtx.userId })
        .select('+initial_agent_id')
        .lean();
      expect(saved).toHaveProperty('initial_agent_id', null);
    });

    it('refreshes both projects when a save moves a conversation between them', async () => {
      const projectA = await ChatProject.create({
        user: mockCtx.userId,
        name: 'Project A',
        conversationCount: 0,
      });
      const projectB = await ChatProject.create({
        user: mockCtx.userId,
        name: 'Project B',
        conversationCount: 0,
      });
      const conversationId = uuidv4();
      const projectAId = projectA._id!.toString();
      const projectBId = projectB._id!.toString();

      await saveConvo(mockCtx, {
        conversationId,
        title: 'Moving',
        endpoint: EModelEndpoint.openAI,
        chatProjectId: projectAId,
      });
      // A stale tab re-submits with the new project id, moving the chat A -> B.
      await saveConvo(mockCtx, {
        conversationId,
        endpoint: EModelEndpoint.openAI,
        chatProjectId: projectBId,
      });

      const refreshedA = await ChatProject.findById(projectA._id).lean<IChatProject>();
      const refreshedB = await ChatProject.findById(projectB._id).lean<IChatProject>();
      expect(refreshedA?.conversationCount).toBe(0);
      expect(refreshedA?.lastConversationId == null).toBe(true);
      expect(refreshedB?.conversationCount).toBe(1);
      expect(refreshedB?.lastConversationId).toBe(conversationId);
    });

    it('bulkSaveConvos refreshes the project a conversation leaves', async () => {
      const projectA = await ChatProject.create({
        user: mockCtx.userId,
        name: 'Bulk Project A',
        conversationCount: 0,
      });
      const projectB = await ChatProject.create({
        user: mockCtx.userId,
        name: 'Bulk Project B',
        conversationCount: 0,
      });
      const conversationId = uuidv4();
      const projectAId = projectA._id!.toString();
      const projectBId = projectB._id!.toString();

      await saveConvo(mockCtx, {
        conversationId,
        title: 'Bulk Moving',
        endpoint: EModelEndpoint.openAI,
        chatProjectId: projectAId,
      });
      await methods.bulkSaveConvos([
        {
          conversationId,
          user: mockCtx.userId,
          endpoint: EModelEndpoint.openAI,
          chatProjectId: projectBId,
        },
      ]);

      const refreshedA = await ChatProject.findById(projectA._id).lean<IChatProject>();
      const refreshedB = await ChatProject.findById(projectB._id).lean<IChatProject>();
      expect(refreshedA?.conversationCount).toBe(0);
      expect(refreshedB?.conversationCount).toBe(1);
    });

    it('should not create a conversation when noUpsert is true and conversation does not exist', async () => {
      const nonExistentId = uuidv4();
      const result = await saveConvo(
        mockCtx,
        { conversationId: nonExistentId, title: 'Ghost Title' },
        { noUpsert: true },
      );

      expect(result).toBeNull();

      const dbConvo = await Conversation.findOne({ conversationId: nonExistentId });
      expect(dbConvo).toBeNull();
    });

    it('should update an existing conversation when noUpsert is true', async () => {
      await saveConvo(mockCtx, mockConversationData);

      const result = await saveConvo(
        mockCtx,
        { conversationId: mockConversationData.conversationId, title: 'Updated Title' },
        { noUpsert: true },
      );

      expect(result).not.toBeNull();
      expect(result?.title).toBe('Updated Title');
      expect(result?.conversationId).toBe(mockConversationData.conversationId);
    });

    it('should still upsert by default when noUpsert is not provided', async () => {
      const newId = uuidv4();
      const result = await saveConvo(mockCtx, {
        conversationId: newId,
        title: 'New Conversation',
        endpoint: EModelEndpoint.openAI,
      });

      expect(result).not.toBeNull();
      expect(result?.conversationId).toBe(newId);
      expect(result?.title).toBe('New Conversation');
    });

    it('should handle unsetFields metadata', async () => {
      const metadata = {
        unsetFields: { someField: 1 },
      };

      await saveConvo(mockCtx, mockConversationData, metadata);

      const savedConvo = await Conversation.findOne<IConversation & { someField?: string }>({
        conversationId: mockConversationData.conversationId,
      });
      expect(savedConvo?.someField).toBeUndefined();
    });

    it('should set createdAt from metadata only on insert', async () => {
      const firstAnchor = new Date('2024-02-03T04:05:06.000Z');
      const secondAnchor = new Date('2025-02-03T04:05:06.000Z');

      const firstSave = await saveConvo(mockCtx, mockConversationData, {
        createdAtOnInsert: firstAnchor,
      });
      const secondSave = await saveConvo(
        mockCtx,
        { ...mockConversationData, title: 'Updated title' },
        { createdAtOnInsert: secondAnchor },
      );

      expect(new Date(firstSave?.createdAt ?? 0).toISOString()).toBe(firstAnchor.toISOString());
      expect(new Date(secondSave?.createdAt ?? 0).toISOString()).toBe(firstAnchor.toISOString());
      expect(secondSave?.title).toBe('Updated title');
    });

    it('preserves insert defaults and suppressed timestamps for an archive pipeline upsert', async () => {
      const conversationId = uuidv4();
      const firstAnchor = new Date('2024-02-03T04:05:06.000Z');
      const secondAnchor = new Date('2025-02-03T04:05:06.000Z');

      const firstSave = await saveConvo(
        { userId: 'user123' },
        { conversationId, isArchived: true },
        { createdAtOnInsert: firstAnchor, preserveUpdatedAt: true },
      );
      const secondSave = await saveConvo(
        { userId: 'user123' },
        { conversationId, isArchived: true },
        { createdAtOnInsert: secondAnchor, preserveUpdatedAt: true },
      );

      expect(firstSave?.title).toBe('New Chat');
      expect(firstSave?.isTemporary).toBe(false);
      expect(firstSave?.updatedAt ?? null).toBeNull();
      expect(new Date(firstSave?.createdAt ?? 0).toISOString()).toBe(firstAnchor.toISOString());
      expect(secondSave?.updatedAt ?? null).toBeNull();
      expect(new Date(secondSave?.createdAt ?? 0).toISOString()).toBe(firstAnchor.toISOString());
      expect(secondSave?.archivedAt).toEqual(firstSave?.archivedAt);
    });

    describe('preserveUpdatedAt', () => {
      const anchor = new Date('2026-02-11T15:28:18.561Z');

      const seedAgedConvo = async () => {
        const conversationId = uuidv4();
        await Conversation.collection.insertOne({
          conversationId,
          user: 'user123',
          title: 'Date And Time Test',
          endpoint: EModelEndpoint.openAI,
          expiredAt: null,
          isArchived: false,
          createdAt: anchor,
          updatedAt: anchor,
        });
        return conversationId;
      };

      /** Archiving files a chat away rather than touching it, and unarchiving has to
       * restore it to its real place in the date groups. */
      it('leaves updatedAt untouched across an archive and unarchive round trip', async () => {
        const conversationId = await seedAgedConvo();

        const archived = await saveConvo(
          { userId: 'user123' },
          { conversationId, isArchived: true },
          { preserveUpdatedAt: true, noUpsert: true },
        );
        const unarchived = await saveConvo(
          { userId: 'user123' },
          { conversationId, isArchived: false },
          { preserveUpdatedAt: true, noUpsert: true },
        );

        expect(archived?.isArchived).toBe(true);
        expect(unarchived?.isArchived).toBe(false);
        expect(new Date(archived?.updatedAt ?? 0).toISOString()).toBe(anchor.toISOString());
        expect(new Date(unarchived?.updatedAt ?? 0).toISOString()).toBe(anchor.toISOString());
      });

      /** Opening an archived chat and hitting the archive shortcut (or a retried
       * POST) sends isArchived: true again. That must not move Date Archived. */
      it('keeps the original archivedAt when the chat is already archived', async () => {
        const conversationId = uuidv4();
        const original = new Date('2026-03-01T12:00:00.000Z');
        await Conversation.collection.insertOne({
          conversationId,
          user: 'user123',
          title: 'Already filed away',
          endpoint: EModelEndpoint.openAI,
          expiredAt: null,
          isArchived: true,
          archivedAt: original,
          createdAt: original,
          updatedAt: original,
        });

        const again = await saveConvo(
          { userId: 'user123' },
          {
            conversationId,
            isArchived: true,
            archivedAt: new Date('2026-08-15T21:00:00.000Z'),
          },
          { preserveUpdatedAt: true, noUpsert: true },
        );

        expect(new Date(again?.archivedAt ?? 0).toISOString()).toBe(original.toISOString());
      });

      /** DocumentDB documents no support for pipeline-form updates on any engine
       * version (`misc/documentdb/documentdb-compat.md`), so both archive transitions
       * have to stay on plain update operators. */
      it('archives with plain update operators rather than an aggregation pipeline', async () => {
        const conversationId = uuidv4();
        const original = new Date('2026-03-01T12:00:00.000Z');
        await Conversation.collection.insertOne({
          conversationId,
          user: 'user123',
          title: 'Plain operators only',
          endpoint: EModelEndpoint.openAI,
          expiredAt: null,
          isArchived: false,
          createdAt: original,
          updatedAt: original,
        });

        const findOneAndUpdate = Conversation.collection.findOneAndUpdate.bind(
          Conversation.collection,
        );
        const updates: Array<UpdateFilter<Document> | Document[]> = [];
        const writeSpy = jest
          .spyOn(Conversation.collection, 'findOneAndUpdate')
          .mockImplementation(
            async (
              filter: Filter<Document>,
              update: UpdateFilter<Document> | Document[],
              options?: FindOneAndUpdateOptions,
            ) => {
              updates.push(update);
              return findOneAndUpdate(filter, update, options ?? {});
            },
          );

        try {
          const archived = await saveConvo(
            { userId: 'user123' },
            { conversationId, isArchived: true },
            { preserveUpdatedAt: true, noUpsert: true },
          );
          const unarchived = await saveConvo(
            { userId: 'user123' },
            { conversationId, isArchived: false },
            { preserveUpdatedAt: true, noUpsert: true },
          );

          expect(archived?.archivedAt).toBeInstanceOf(Date);
          expect(unarchived?.archivedAt ?? null).toBeNull();
          expect(updates.length).toBeGreaterThan(0);
          for (const update of updates) {
            expect(Array.isArray(update)).toBe(false);
          }
        } finally {
          writeSpy.mockRestore();
        }
      });

      /** Both conditional writes of the compare-and-set miss when an unarchive lands
       * between them. The conversation still exists, so the route must not 404. */
      it('does not report a missing chat when an unarchive splits the archive writes', async () => {
        const conversationId = uuidv4();
        const original = new Date('2026-03-01T12:00:00.000Z');
        await Conversation.collection.insertOne({
          conversationId,
          user: 'user123',
          title: 'Split archive',
          endpoint: EModelEndpoint.openAI,
          expiredAt: null,
          isArchived: true,
          archivedAt: original,
          createdAt: original,
          updatedAt: original,
        });

        const findOneAndUpdate = Conversation.collection.findOneAndUpdate.bind(
          Conversation.collection,
        );
        let writeCount = 0;
        const writeSpy = jest
          .spyOn(Conversation.collection, 'findOneAndUpdate')
          .mockImplementation(
            async (
              filter: Filter<Document>,
              update: UpdateFilter<Document> | Document[],
              options?: FindOneAndUpdateOptions,
            ) => {
              writeCount += 1;
              const result = await findOneAndUpdate(filter, update, options ?? {});
              /** The transition write has just missed on an already archived chat.
               * Unarchive it now so the already-archived write misses too. */
              if (writeCount === 1) {
                await Conversation.collection.updateOne(
                  { conversationId },
                  { $set: { isArchived: false, archivedAt: null } },
                );
              }
              return result;
            },
          );

        try {
          const archived = await saveConvo(
            { userId: 'user123' },
            { conversationId, isArchived: true },
            { preserveUpdatedAt: true, noUpsert: true },
          );

          expect(archived).not.toBeNull();
          expect(archived?.isArchived).toBe(true);
          expect(archived?.archivedAt).toBeInstanceOf(Date);
        } finally {
          writeSpy.mockRestore();
        }
      });

      /** Alternating requests can split every retry, and exhausting them still proves
       * nothing about whether the chat exists, so it must not become a 404 either. */
      it('does not report a missing chat when every archive retry is split', async () => {
        const conversationId = uuidv4();
        const original = new Date('2026-03-01T12:00:00.000Z');
        await Conversation.collection.insertOne({
          conversationId,
          user: 'user123',
          title: 'Perpetually split',
          endpoint: EModelEndpoint.openAI,
          expiredAt: null,
          isArchived: true,
          archivedAt: original,
          createdAt: original,
          updatedAt: original,
        });

        const findOneAndUpdate = Conversation.collection.findOneAndUpdate.bind(
          Conversation.collection,
        );
        const writeSpy = jest
          .spyOn(Conversation.collection, 'findOneAndUpdate')
          .mockImplementation(
            async (
              filter: Filter<Document>,
              update: UpdateFilter<Document> | Document[],
              options?: FindOneAndUpdateOptions,
            ) => {
              const result = await findOneAndUpdate(filter, update, options ?? {});
              /** Flip the flag after every write so no transition write and no
               * already-archived write can ever match. */
              const archived = await Conversation.collection.findOne({ conversationId });
              await Conversation.collection.updateOne(
                { conversationId },
                { $set: { isArchived: archived?.isArchived !== true } },
              );
              return result;
            },
          );

        try {
          const archived = await saveConvo(
            { userId: 'user123' },
            { conversationId, isArchived: true },
            { preserveUpdatedAt: true, noUpsert: true },
          );

          expect(archived).not.toBeNull();
          expect(archived?.conversationId).toBe(conversationId);
        } finally {
          writeSpy.mockRestore();
        }
      });

      it('stamps again when unarchive lands before a pending repeated archive write', async () => {
        const conversationId = uuidv4();
        const original = new Date('2026-03-01T12:00:00.000Z');
        await Conversation.collection.insertOne({
          conversationId,
          user: 'user123',
          title: 'Archive race',
          endpoint: EModelEndpoint.openAI,
          expiredAt: null,
          isArchived: true,
          archivedAt: original,
          createdAt: original,
          updatedAt: original,
        });

        let markArchiveWriteReached = () => {};
        const archiveWriteReached = new Promise<void>((resolve) => {
          markArchiveWriteReached = resolve;
        });
        let releaseArchiveWrite = () => {};
        const archiveWriteBlocked = new Promise<void>((resolve) => {
          releaseArchiveWrite = resolve;
        });
        const findOneAndUpdate = Conversation.collection.findOneAndUpdate.bind(
          Conversation.collection,
        );
        let writeCount = 0;
        const writeSpy = jest
          .spyOn(Conversation.collection, 'findOneAndUpdate')
          .mockImplementation(
            async (
              filter: Filter<Document>,
              update: UpdateFilter<Document> | Document[],
              options?: FindOneAndUpdateOptions,
            ) => {
              writeCount += 1;
              if (writeCount === 1) {
                markArchiveWriteReached();
                await archiveWriteBlocked;
              }
              return findOneAndUpdate(filter, update, options ?? {});
            },
          );

        try {
          const archive = saveConvo(
            { userId: 'user123' },
            { conversationId, isArchived: true },
            { preserveUpdatedAt: true, noUpsert: true },
          );
          await archiveWriteReached;

          const unarchived = await saveConvo(
            { userId: 'user123' },
            { conversationId, isArchived: false },
            { preserveUpdatedAt: true, noUpsert: true },
          );
          releaseArchiveWrite();
          const archived = await archive;

          expect(unarchived?.isArchived).toBe(false);
          expect(archived?.isArchived).toBe(true);
          expect(archived?.archivedAt).toBeInstanceOf(Date);
          expect(new Date(archived?.archivedAt ?? 0).toISOString()).not.toBe(
            original.toISOString(),
          );
        } finally {
          releaseArchiveWrite();
          writeSpy.mockRestore();
        }
      });

      it('stamps archivedAt on the first archive when the caller omits it', async () => {
        const conversationId = await seedAgedConvo();
        const before = Date.now();

        const archived = await saveConvo(
          { userId: 'user123' },
          { conversationId, isArchived: true },
          { preserveUpdatedAt: true, noUpsert: true },
        );

        expect(archived?.archivedAt).toBeInstanceOf(Date);
        expect(new Date(archived?.archivedAt ?? 0).getTime()).toBeGreaterThanOrEqual(before);
      });

      it('clears archivedAt on unarchive when the caller omits it', async () => {
        const conversationId = uuidv4();
        const original = new Date('2026-03-01T12:00:00.000Z');
        await Conversation.collection.insertOne({
          conversationId,
          user: 'user123',
          title: 'To restore',
          endpoint: EModelEndpoint.openAI,
          expiredAt: null,
          isArchived: true,
          archivedAt: original,
          createdAt: original,
          updatedAt: original,
        });

        const unarchived = await saveConvo(
          { userId: 'user123' },
          { conversationId, isArchived: false },
          { preserveUpdatedAt: true, noUpsert: true },
        );

        expect(unarchived?.archivedAt ?? null).toBeNull();
      });

      /** A pin carries a preserved older timestamp, so the project it belongs to must
       * not be dragged back to it while the project holds newer conversations. */
      it('does not drag a project pointer back when only metadata changes', async () => {
        const project = await ChatProject.create({
          user: 'user123',
          name: 'Pinned project',
          conversationCount: 0,
          lastConversationAt: null,
          lastConversationId: null,
        });
        const newer = uuidv4();
        const older = uuidv4();
        const newerAt = new Date('2026-08-01T00:00:00.000Z');
        for (const [id, when] of [
          [newer, newerAt],
          [older, anchor],
        ] as Array<[string, Date]>) {
          await Conversation.collection.insertOne({
            conversationId: id,
            user: 'user123',
            title: id,
            endpoint: EModelEndpoint.openAI,
            expiredAt: null,
            isArchived: false,
            chatProjectId: String(project._id),
            createdAt: when,
            updatedAt: when,
          });
        }

        await saveConvo(
          { userId: 'user123' },
          { conversationId: older, pinned: true },
          { preserveUpdatedAt: true, noUpsert: true },
        );

        const after = await ChatProject.findById(project._id).lean<{
          lastConversationAt: Date;
          lastConversationId: string;
        }>();
        expect(new Date(after?.lastConversationAt ?? 0).toISOString()).toBe(newerAt.toISOString());
        expect(after?.lastConversationId).toBe(newer);
      });

      /** Under RetentionMode.ALL a legacy chat also gets an isTemporary backfill after
       * the main write; that second update has to stay silent too. */
      it('keeps updatedAt through the retention backfill', async () => {
        const conversationId = uuidv4();
        await Conversation.collection.insertOne({
          conversationId,
          user: 'user123',
          title: 'legacy chat with no isTemporary',
          endpoint: EModelEndpoint.openAI,
          expiredAt: null,
          isArchived: false,
          createdAt: anchor,
          updatedAt: anchor,
        });

        const result = await saveConvo(
          {
            userId: 'user123',
            interfaceConfig: { retentionMode: RetentionMode.ALL, temporaryChatRetention: 24 },
          },
          { conversationId, isArchived: true },
          { preserveUpdatedAt: true, noUpsert: true },
        );

        expect(result?.isArchived).toBe(true);
        const stored = await Conversation.findOne({ conversationId }).lean<IConversation>();
        expect(new Date(stored?.updatedAt ?? 0).toISOString()).toBe(anchor.toISOString());
      });

      it('still bumps updatedAt for an ordinary save', async () => {
        const conversationId = await seedAgedConvo();

        const result = await saveConvo({ userId: 'user123' }, { conversationId, title: 'Renamed' });

        expect(new Date(result?.updatedAt ?? 0).getTime()).toBeGreaterThan(anchor.getTime());
      });

      it('does not insert a timestampless conversation for an unknown id', async () => {
        const result = await saveConvo(
          { userId: 'user123' },
          { conversationId: uuidv4(), isArchived: true },
          { preserveUpdatedAt: true, noUpsert: true },
        );

        expect(result).toBeNull();
      });
    });

    describe('setConvoPinned', () => {
      const anchor = new Date('2026-03-05T22:17:14.997Z');

      const seedAgedConvo = async (user = 'user123') => {
        const conversationId = uuidv4();
        await Conversation.collection.insertOne({
          conversationId,
          user,
          title: 'Living Room Light And Temperature',
          endpoint: EModelEndpoint.openAI,
          expiredAt: null,
          isArchived: false,
          messages: [],
          createdAt: anchor,
          updatedAt: anchor,
        });
        return conversationId;
      };

      it('pins a conversation without disturbing its timestamps', async () => {
        const conversationId = await seedAgedConvo();

        const result = await setConvoPinned('user123', conversationId, true);

        expect(result?.pinned).toBe(true);
        expect(result?.title).toBe('Living Room Light And Temperature');
        expect(new Date(result?.updatedAt ?? 0).toISOString()).toBe(anchor.toISOString());
        expect(new Date(result?.createdAt ?? 0).toISOString()).toBe(anchor.toISOString());
      });

      it('unpins a conversation without disturbing its timestamps', async () => {
        const conversationId = await seedAgedConvo();
        await setConvoPinned('user123', conversationId, true);

        const result = await setConvoPinned('user123', conversationId, false);

        expect(result?.pinned).toBe(false);
        expect(new Date(result?.updatedAt ?? 0).toISOString()).toBe(anchor.toISOString());
      });

      /** The whole point of the dedicated method: a one-field toggle should not pay for
       * `saveConvo`'s message-id read, nor rewrite the array it returns. */
      it('does not read the conversation messages', async () => {
        const conversationId = await seedAgedConvo();

        await setConvoPinned('user123', conversationId, true);

        expect(getMessages).not.toHaveBeenCalled();
      });

      it('leaves the stored message list alone', async () => {
        const conversationId = await seedAgedConvo();
        await Conversation.collection.updateOne(
          { conversationId },
          { $set: { messages: ['message-a', 'message-b'] } },
        );

        await setConvoPinned('user123', conversationId, true);

        const stored = await Conversation.findOne({ conversationId }).lean<IConversation>();
        expect(stored?.messages).toEqual(['message-a', 'message-b']);
      });

      it('returns null for an unknown id rather than inserting one', async () => {
        const conversationId = uuidv4();

        const result = await setConvoPinned('user123', conversationId, true);

        expect(result).toBeNull();
        expect(await Conversation.countDocuments({ conversationId })).toBe(0);
      });

      it('cannot pin another user’s conversation', async () => {
        const conversationId = await seedAgedConvo('other-user');

        const result = await setConvoPinned('user123', conversationId, true);

        expect(result).toBeNull();
        const stored = await Conversation.findOne({ conversationId }).lean<IConversation>();
        expect(stored?.pinned).toBeUndefined();
      });
    });
  });

  describe('code environment persistence during ordinary saves', () => {
    const mac = { environmentId: 'code-mac', workspaceId: 'primary' };
    const vm = { environmentId: 'code-vm', workspaceId: 'primary' };
    const userId = 'user123';
    const unsetFields = { codeEnvironmentMode: 1, codeWorkspaces: 1 };

    it.each([
      { codeEnvironmentMode: 'attached', codeWorkspaces: [mac] },
      { codeEnvironmentMode: 'without_attached' },
    ])(
      'preserves $codeEnvironmentMode through an approval pause and later saves',
      async (decision) => {
        const conversationId = uuidv4();
        await saveConvo({ userId }, { conversationId, ...decision });

        for (const title of ['Approval required', 'Resumed', 'Completed']) {
          await saveConvo({ userId }, { conversationId, title }, { unsetFields });
          const stored = await getConvo(userId, conversationId);
          expect(stored?.codeEnvironmentMode).toBe(decision.codeEnvironmentMode);
          expect(stored?.codeWorkspaces).toEqual(decision.codeWorkspaces);
          expect(stored?.title).toBe(title);
        }
      },
    );

    it('cannot overwrite an explicit move with a stale turn-start snapshot', async () => {
      const conversationId = uuidv4();
      const decision = { codeEnvironmentMode: 'attached' as const, codeWorkspaces: [mac] };
      await saveConvo({ userId }, { conversationId, ...decision });
      await methods.replaceConvoCodeEnvironmentDecision({
        user: userId,
        conversationId,
        expected: decision,
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [vm],
      });

      await saveConvo({ userId }, { conversationId, ...decision });
      expect((await getConvo(userId, conversationId))?.codeWorkspaces).toEqual([vm]);
      await saveConvo(
        { userId },
        { conversationId, codeEnvironmentMode: null, codeWorkspaces: [] },
      );
      const stored = await getConvo(userId, conversationId);
      expect(stored?.codeEnvironmentMode).toBe('attached');
      expect(stored?.codeWorkspaces).toEqual([vm]);
    });

    it('seeds imported decisions without letting repeated imports undo a move', async () => {
      const conversationId = uuidv4();
      const decision = { codeEnvironmentMode: 'attached' as const, codeWorkspaces: [mac] };
      const imported = { conversationId, user: userId, ...decision };
      await methods.bulkSaveConvos([imported]);
      expect((await getConvo(userId, conversationId))?.codeWorkspaces).toEqual([mac]);
      await methods.replaceConvoCodeEnvironmentDecision({
        user: userId,
        conversationId,
        expected: decision,
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [vm],
      });
      await methods.bulkSaveConvos([imported]);
      const stored = await getConvo(userId, conversationId);
      expect(stored?.codeEnvironmentMode).toBe('attached');
      expect(stored?.codeWorkspaces).toEqual([vm]);
    });

    it('preserves a legacy decision', async () => {
      const conversationId = uuidv4();
      await Conversation.collection.insertOne({
        conversationId,
        user: userId,
        codeWorkspaces: [mac],
      });
      await saveConvo(
        { userId },
        { conversationId, codeEnvironmentMode: 'attached', codeWorkspaces: [vm] },
        { unsetFields },
      );
      const stored = await getConvo(userId, conversationId);
      expect(stored?.codeEnvironmentMode).toBeUndefined();
      expect(stored?.codeWorkspaces).toEqual([mac]);
    });

    it('records the first decision of a saved chat that holds none', async () => {
      const conversationId = uuidv4();
      await Conversation.collection.insertOne({ conversationId, user: userId, title: 'Saved' });

      const saved = await saveConvo(
        { userId },
        { conversationId, codeEnvironmentMode: 'attached', codeWorkspaces: [mac] },
        { unsetFields },
      );

      expect(saved?.codeEnvironmentMode).toBe('attached');
      expect(saved?.codeWorkspaces).toEqual([mac]);
      const stored = await getConvo(userId, conversationId);
      expect(stored?.codeEnvironmentMode).toBe('attached');
      expect(stored?.codeWorkspaces).toEqual([mac]);
    });

    it('keeps the decision it recorded when a later turn resolves another', async () => {
      const conversationId = uuidv4();
      await Conversation.collection.insertOne({ conversationId, user: userId, title: 'Saved' });
      await saveConvo(
        { userId },
        { conversationId, codeEnvironmentMode: 'attached', codeWorkspaces: [mac] },
        { unsetFields },
      );

      await saveConvo(
        { userId },
        { conversationId, codeEnvironmentMode: 'without_attached', codeWorkspaces: [vm] },
        { unsetFields },
      );

      const stored = await getConvo(userId, conversationId);
      expect(stored?.codeEnvironmentMode).toBe('attached');
      expect(stored?.codeWorkspaces).toEqual([mac]);
    });

    it('leaves a chat undecided when a save carries selections without a mode', async () => {
      const conversationId = uuidv4();
      await Conversation.collection.insertOne({ conversationId, user: userId, title: 'Saved' });

      await saveConvo({ userId }, { conversationId, codeWorkspaces: [vm] }, { unsetFields });

      const stored = await getConvo(userId, conversationId);
      expect(stored?.codeEnvironmentMode).toBeUndefined();
      expect(stored?.codeWorkspaces).toBeUndefined();
    });
  });

  describe('replaceConvoCodeEnvironmentDecision', () => {
    const anchor = new Date('2026-09-12T11:22:22.976Z');
    const mac = { environmentId: 'code-mac', workspaceId: 'primary' };
    const team = { environmentId: 'code-team', workspaceId: 'shared' };
    const vm = { environmentId: 'code-vm', workspaceId: 'projects' };

    /** Raw inserts bypass Mongoose casting, the way legacy rows and operator repairs are stored. */
    const seedDecision = async (decision: Record<string, unknown>, user = 'user123') => {
      const conversationId = uuidv4();
      await Conversation.collection.insertOne({
        conversationId,
        user,
        title: 'Mortgage analysis',
        endpoint: EModelEndpoint.agents,
        messages: [],
        createdAt: anchor,
        updatedAt: anchor,
        ...decision,
      });
      return conversationId;
    };

    const moveFromStored = async (
      conversationId: string,
      codeWorkspaces: NonNullable<IConversation['codeWorkspaces']>,
      user = 'user123',
    ) => {
      const stored = await methods.getConvoCodeEnvironmentDecision('user123', conversationId);
      return methods.replaceConvoCodeEnvironmentDecision({
        user,
        conversationId,
        expected: {
          codeEnvironmentMode: stored?.codeEnvironmentMode,
          codeWorkspaces: stored?.codeWorkspaces,
          codeEnvironmentRevision: stored?.codeEnvironmentRevision,
        },
        codeEnvironmentMode: 'attached',
        codeWorkspaces,
      });
    };

    it('replaces the decision it read without disturbing timestamps', async () => {
      const conversationId = await seedDecision({
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [mac, team],
      });

      const result = await moveFromStored(conversationId, [team, vm]);

      expect(result?.codeEnvironmentMode).toBe('attached');
      expect(result?.codeWorkspaces).toEqual([team, vm]);
      expect(new Date(result?.updatedAt ?? 0).toISOString()).toBe(anchor.toISOString());
    });

    it('replaces a legacy decision stored without a mode', async () => {
      const conversationId = await seedDecision({ codeWorkspaces: [mac] });

      const result = await moveFromStored(conversationId, [vm]);

      expect(result?.codeEnvironmentMode).toBe('attached');
      expect(result?.codeWorkspaces).toEqual([vm]);
    });

    it('replaces a decision that saveConvo persisted', async () => {
      const conversationId = uuidv4();
      await saveConvo(
        { userId: 'user123' },
        {
          conversationId,
          endpoint: EModelEndpoint.agents,
          codeEnvironmentMode: 'attached',
          codeWorkspaces: [mac, team],
        },
      );
      expect((await getConvo('user123', conversationId))?.codeWorkspaces).toEqual([mac, team]);

      const result = await moveFromStored(conversationId, [vm]);

      expect(result?.codeWorkspaces).toEqual([vm]);
    });

    it('advances the revision and returns the snapshot in one database round trip', async () => {
      const conversationId = await seedDecision({
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [mac],
      });
      const update = jest.spyOn(Conversation.collection, 'findOneAndUpdate');
      const read = jest.spyOn(Conversation.collection, 'findOne');
      try {
        const result = await methods.readAdmittedConvoCodeEnvironmentDecision(
          'user123',
          conversationId,
        );
        expect(result?.codeWorkspaces).toEqual([mac]);
        expect(update).toHaveBeenCalledTimes(1);
        expect(read).not.toHaveBeenCalled();
      } finally {
        update.mockRestore();
        read.mockRestore();
      }
    });

    it('rejects a transition when an admitted run reads after the idle check', async () => {
      const conversationId = await seedDecision({
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [mac],
      });
      const snapshot = await methods.getConvoCodeEnvironmentDecision('user123', conversationId);
      const admitted = await methods.readAdmittedConvoCodeEnvironmentDecision(
        'user123',
        conversationId,
      );
      expect(admitted?.codeWorkspaces).toEqual([mac]);
      expect(
        await methods.replaceConvoCodeEnvironmentDecision({
          user: 'user123',
          conversationId,
          expected: snapshot!,
          codeEnvironmentMode: 'attached',
          codeWorkspaces: [vm],
        }),
      ).toBeNull();
      expect((await getConvo('user123', conversationId))?.codeWorkspaces).toEqual([mac]);
    });

    it('gives an admitted run the new decision when the transition wins first', async () => {
      const conversationId = await seedDecision({
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [mac],
      });
      const snapshot = await methods.getConvoCodeEnvironmentDecision('user123', conversationId);
      expect(
        await methods.replaceConvoCodeEnvironmentDecision({
          user: 'user123',
          conversationId,
          expected: snapshot!,
          codeEnvironmentMode: 'attached',
          codeWorkspaces: [vm],
        }),
      ).not.toBeNull();
      const admitted = await methods.readAdmittedConvoCodeEnvironmentDecision(
        'user123',
        conversationId,
      );
      expect(admitted?.codeWorkspaces).toEqual([vm]);
      expect(admitted).not.toHaveProperty('codeEnvironmentRevision');
      const current = await getConvo('user123', conversationId);
      expect(current).not.toHaveProperty('codeEnvironmentRevision');
      expect(new Date(current?.updatedAt ?? 0).toISOString()).toBe(anchor.toISOString());
    });

    it("does not advance another tenant's decision revision", async () => {
      const conversationId = await seedDecision({
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [mac],
        tenantId: 'tenant-a',
      });
      const other = await tenantStorage.run({ tenantId: 'tenant-b' }, () =>
        methods.readAdmittedConvoCodeEnvironmentDecision('user123', conversationId),
      );
      expect(other).toBeNull();
      const own = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
        methods.readAdmittedConvoCodeEnvironmentDecision('user123', conversationId),
      );
      expect(own?.codeWorkspaces).toEqual([mac]);
      const raw = await Conversation.collection.findOne({ conversationId });
      expect(raw?.codeEnvironmentRevision).toBe(1);
    });

    it('protects the revision from ordinary saves, imports and other users', async () => {
      const conversationId = await seedDecision({
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [mac],
      });
      await methods.readAdmittedConvoCodeEnvironmentDecision('user123', conversationId);
      const before = await methods.getConvoCodeEnvironmentDecision('user123', conversationId);
      await saveConvo(
        { userId: 'user123' },
        { conversationId, codeEnvironmentRevision: 999 },
        { unsetFields: { codeEnvironmentRevision: 1 } },
      );
      await methods.bulkSaveConvos([
        { conversationId, user: 'user123', codeEnvironmentRevision: 0 },
      ]);
      expect(
        (await methods.getConvoCodeEnvironmentDecision('user123', conversationId))
          ?.codeEnvironmentRevision,
      ).toBe(before?.codeEnvironmentRevision);
      expect(
        await methods.readAdmittedConvoCodeEnvironmentDecision('someone-else', conversationId),
      ).toBeNull();
    });

    it('attaches an environment to a chat stored without one', async () => {
      const conversationId = await seedDecision({ codeEnvironmentMode: 'without_attached' });

      const result = await methods.replaceConvoCodeEnvironmentDecision({
        user: 'user123',
        conversationId,
        expected: { codeEnvironmentMode: 'without_attached' },
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [vm],
      });

      expect(result?.codeEnvironmentMode).toBe('attached');
      expect(result?.codeWorkspaces).toEqual([vm]);
    });

    it('clears the selections when a chat leaves attached execution', async () => {
      const conversationId = await seedDecision({
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [mac, team],
      });

      const result = await methods.replaceConvoCodeEnvironmentDecision({
        user: 'user123',
        conversationId,
        expected: { codeEnvironmentMode: 'attached', codeWorkspaces: [mac, team] },
        codeEnvironmentMode: 'without_attached',
      });

      expect(result?.codeEnvironmentMode).toBe('without_attached');
      /** Keeping them would read as an attached decision again on the next turn. */
      expect(result?.codeWorkspaces).toBeUndefined();
      const stored = await getConvo('user123', conversationId);
      expect(stored?.codeWorkspaces).toBeUndefined();
      expect(new Date(stored?.updatedAt ?? 0).toISOString()).toBe(anchor.toISOString());
    });

    it('leaves a decision that changed after it was read untouched', async () => {
      const conversationId = await seedDecision({
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [mac],
      });
      const stored = await getConvo('user123', conversationId);
      await Conversation.collection.updateOne(
        { conversationId },
        { $set: { codeWorkspaces: [team] } },
      );

      const result = await methods.replaceConvoCodeEnvironmentDecision({
        user: 'user123',
        conversationId,
        expected: {
          codeEnvironmentMode: stored?.codeEnvironmentMode,
          codeWorkspaces: stored?.codeWorkspaces,
          codeEnvironmentRevision: stored?.codeEnvironmentRevision,
        },
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [vm],
      });

      expect(result).toBeNull();
      const current = await getConvo('user123', conversationId);
      expect(current?.codeWorkspaces).toEqual([team]);
    });

    it('does not treat a reordered selection list as the decision it read', async () => {
      const conversationId = await seedDecision({
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [mac, team],
      });

      const result = await methods.replaceConvoCodeEnvironmentDecision({
        user: 'user123',
        conversationId,
        expected: { codeEnvironmentMode: 'attached', codeWorkspaces: [team, mac] },
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [vm],
      });

      expect(result).toBeNull();
    });

    it('cannot move another user’s conversation', async () => {
      const conversationId = await seedDecision(
        { codeEnvironmentMode: 'attached', codeWorkspaces: [mac] },
        'other-user',
      );

      const result = await methods.replaceConvoCodeEnvironmentDecision({
        user: 'user123',
        conversationId,
        expected: { codeEnvironmentMode: 'attached', codeWorkspaces: [mac] },
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [vm],
      });

      expect(result).toBeNull();
      const stored = await Conversation.findOne({ conversationId }).lean<IConversation>();
      expect(stored?.codeWorkspaces).toEqual([mac]);
    });
  });

  describe('saveConvo appendMessageIds', () => {
    const ctx = { userId: 'append-user' };
    const conversationId = 'append-conversation';

    beforeEach(async () => {
      await Conversation.deleteMany({ user: ctx.userId });
      getMessages.mockClear();
    });

    it('appends the provided ids without reading the messages collection', async () => {
      const seeded = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
      getMessages.mockResolvedValueOnce(seeded.map((_id) => ({ _id })));
      await saveConvo(ctx, { conversationId, title: 'seeded' });
      expect(getMessages).toHaveBeenCalledTimes(1);

      const appended = new mongoose.Types.ObjectId();
      const result = await saveConvo(
        ctx,
        { conversationId, title: 'appended' },
        { appendMessageIds: [appended] },
      );

      expect(getMessages).toHaveBeenCalledTimes(1);
      expect(result?.title).toBe('appended');
      const stored = await Conversation.findOne({ conversationId }).lean();
      expect(stored?.messages?.map(String)).toEqual([...seeded, appended].map(String));
    });

    it('does not duplicate an id that is already recorded', async () => {
      const id = new mongoose.Types.ObjectId();
      await saveConvo(ctx, { conversationId }, { appendMessageIds: [id] });
      await saveConvo(ctx, { conversationId }, { appendMessageIds: [id] });

      const stored = await Conversation.findOne({ conversationId }).lean();
      expect(stored?.messages?.map(String)).toEqual([String(id)]);
      expect(getMessages).not.toHaveBeenCalled();
    });

    it('creates the conversation with the appended id when it does not exist yet', async () => {
      const id = new mongoose.Types.ObjectId();
      const result = await saveConvo(
        ctx,
        { conversationId, title: 'first turn' },
        { appendMessageIds: [id] },
      );

      expect(result?.conversationId).toBe(conversationId);
      const stored = await Conversation.findOne({ conversationId }).lean();
      expect(stored?.messages?.map(String)).toEqual([String(id)]);
      expect(getMessages).not.toHaveBeenCalled();
    });

    it('ignores a caller-supplied messages field so $set cannot conflict with the append', async () => {
      const kept = new mongoose.Types.ObjectId();
      await saveConvo(ctx, { conversationId }, { appendMessageIds: [kept] });

      const appended = new mongoose.Types.ObjectId();
      await saveConvo(
        ctx,
        { conversationId, messages: [new mongoose.Types.ObjectId()] },
        { appendMessageIds: [appended] },
      );

      const stored = await Conversation.findOne({ conversationId }).lean();
      expect(stored?.messages?.map(String)).toEqual([kept, appended].map(String));
    });

    it('still rebuilds the array from the database when the option is absent', async () => {
      const rebuilt = [new mongoose.Types.ObjectId()];
      getMessages.mockResolvedValueOnce(rebuilt.map((_id) => ({ _id })));

      await saveConvo(ctx, { conversationId, title: 'rebuild' });

      expect(getMessages).toHaveBeenCalledWith({ conversationId, user: ctx.userId }, '_id');
      const stored = await Conversation.findOne({ conversationId }).lean();
      expect(stored?.messages?.map(String)).toEqual(rebuilt.map(String));
    });

    /** An empty append is how a metadata-only write asks for the title (or any other
     *  field) to land without the array being rebuilt underneath it. */
    it('leaves the array untouched when the append is empty', async () => {
      const existing = new mongoose.Types.ObjectId();
      await saveConvo(ctx, { conversationId }, { appendMessageIds: [existing] });
      getMessages.mockClear();

      await saveConvo(ctx, { conversationId, title: 'metadata only' }, { appendMessageIds: [] });

      expect(getMessages).not.toHaveBeenCalled();
      const stored = await Conversation.findOne({ conversationId }).lean();
      expect(stored?.title).toBe('metadata only');
      expect(stored?.messages?.map(String)).toEqual([String(existing)]);
    });

    /** The concurrency an immediate-mode title introduced: it saves while the turn is
     *  still running, so its write and the response's own append overlap. A title that
     *  rebuilt the array from a snapshot taken before the response existed erased the
     *  response's id permanently — nothing later re-adds it. Asking for no messages at
     *  all is what makes the interleaving irrelevant. */
    it('keeps a concurrently appended id when a metadata-only write overlaps it', async () => {
      const userMessage = new mongoose.Types.ObjectId();
      await saveConvo(ctx, { conversationId }, { appendMessageIds: [userMessage] });
      /** What a rebuilding write would have read: the turn before the response. The
       *  outer `beforeEach` restores the default, so this cannot leak. */
      getMessages.mockResolvedValue([{ _id: userMessage }]);
      getMessages.mockClear();

      const responseMessage = new mongoose.Types.ObjectId();
      await Promise.all([
        saveConvo(ctx, { conversationId, title: 'generated mid-turn' }, { appendMessageIds: [] }),
        saveConvo(ctx, { conversationId }, { appendMessageIds: [responseMessage] }),
      ]);

      const stored = await Conversation.findOne({ conversationId }).lean();
      expect(stored?.title).toBe('generated mid-turn');
      expect(stored?.messages?.map(String)).toEqual([userMessage, responseMessage].map(String));
      /** No snapshot was taken, so there was no window to lose the append in. */
      expect(getMessages).not.toHaveBeenCalled();
    });
  });

  describe('appendConvoMessageReference', () => {
    const ctx = { userId: 'append-ref-user' };
    const conversationId = 'append-ref-conversation';

    const appendConvoMessageReference = (
      ...args: Parameters<ConversationMethods['appendConvoMessageReference']>
    ) => methods.appendConvoMessageReference(...args);

    beforeEach(async () => {
      await Conversation.deleteMany({});
      getMessages.mockClear();
    });

    it('appends the id without reading or rewriting the message array', async () => {
      const existing = new mongoose.Types.ObjectId();
      await saveConvo(ctx, { conversationId, title: 'seeded' }, { appendMessageIds: [existing] });
      getMessages.mockClear();

      const recovered = new mongoose.Types.ObjectId();
      const row = await appendConvoMessageReference(ctx.userId, conversationId, String(recovered));

      expect(row?.messages?.map(String)).toEqual([existing, recovered].map(String));
      expect(getMessages).not.toHaveBeenCalled();
    });

    it('does not duplicate an id the conversation already references', async () => {
      const id = new mongoose.Types.ObjectId();
      await saveConvo(ctx, { conversationId }, { appendMessageIds: [id] });

      await appendConvoMessageReference(ctx.userId, conversationId, String(id));
      await appendConvoMessageReference(ctx.userId, conversationId, String(id));

      const stored = await Conversation.findOne({ conversationId }).lean();
      expect(stored?.messages?.map(String)).toEqual([String(id)]);
    });

    /** Repairing a reference is not activity: the sidebar orders by `updatedAt`, and
     *  hoisting an untouched chat to Today would be a visible lie. */
    it('leaves updatedAt alone', async () => {
      await saveConvo(ctx, { conversationId }, { appendMessageIds: [] });
      const before = await Conversation.findOne({ conversationId }).lean();

      await appendConvoMessageReference(
        ctx.userId,
        conversationId,
        String(new mongoose.Types.ObjectId()),
      );

      const after = await Conversation.findOne({ conversationId }).lean();
      expect(after?.updatedAt?.getTime()).toBe(before?.updatedAt?.getTime());
    });

    it('never inserts a conversation that does not exist', async () => {
      const row = await appendConvoMessageReference(
        ctx.userId,
        'no-such-conversation',
        String(new mongoose.Types.ObjectId()),
      );

      expect(row).toBeNull();
      expect(
        await Conversation.findOne({ conversationId: 'no-such-conversation' }).lean(),
      ).toBeNull();
    });

    /** The repair runs on a turn's own behalf, so it must never reach another owner's row. */
    it("cannot touch another owner's conversation", async () => {
      const owner = new mongoose.Types.ObjectId();
      await saveConvo(ctx, { conversationId }, { appendMessageIds: [owner] });

      const row = await appendConvoMessageReference(
        'someone-else',
        conversationId,
        String(new mongoose.Types.ObjectId()),
      );

      expect(row).toBeNull();
      const stored = await Conversation.findOne({ conversationId }).lean();
      expect(stored?.messages?.map(String)).toEqual([String(owner)]);
    });

    it('ignores an id the store could never hold', async () => {
      await saveConvo(ctx, { conversationId }, { appendMessageIds: [] });

      const row = await appendConvoMessageReference(ctx.userId, conversationId, 'not-an-id');

      expect(row).toBeNull();
      const stored = await Conversation.findOne({ conversationId }).lean();
      expect(stored?.messages ?? []).toEqual([]);
    });
  });

  describe('isTemporary conversation handling', () => {
    it('should save a conversation with expiredAt when isTemporary is true', async () => {
      mockCtx.interfaceConfig = { temporaryChatRetention: 24 };
      mockCtx.isTemporary = true;

      const beforeSave = new Date();
      const result = await saveConvo(mockCtx, mockConversationData);
      const afterSave = new Date();

      expect(result?.conversationId).toBe(mockConversationData.conversationId);
      expect(result?.expiredAt).toBeDefined();
      expect(result?.expiredAt).toBeInstanceOf(Date);

      const expectedExpirationTime = new Date(beforeSave.getTime() + 24 * 60 * 60 * 1000);
      const actualExpirationTime = new Date(result?.expiredAt ?? 0);

      expect(actualExpirationTime.getTime()).toBeGreaterThanOrEqual(
        expectedExpirationTime.getTime() - 1000,
      );
      expect(actualExpirationTime.getTime()).toBeLessThanOrEqual(
        new Date(afterSave.getTime() + 24 * 60 * 60 * 1000 + 1000).getTime(),
      );
    });

    it('preserves an exact inherited expiration instead of recomputing retention', async () => {
      const inheritedExpiration = new Date('2026-08-22T03:04:05.000Z');
      mockCtx.isTemporary = true;
      mockCtx.expiredAt = inheritedExpiration;
      mockCtx.interfaceConfig = { temporaryChatRetention: 48 };

      const result = await saveConvo(mockCtx, mockConversationData);

      expect(result?.isTemporary).toBe(true);
      expect(result?.expiredAt).toEqual(inheritedExpiration);
    });

    it('should save a conversation without expiredAt when isTemporary is false', async () => {
      mockCtx.isTemporary = false;

      const result = await saveConvo(mockCtx, mockConversationData);

      expect(result?.conversationId).toBe(mockConversationData.conversationId);
      expect(result?.expiredAt).toBeNull();
    });

    it('should save a conversation without expiredAt when isTemporary is not provided', async () => {
      mockCtx.isTemporary = undefined;

      const result = await saveConvo(mockCtx, mockConversationData);

      expect(result?.conversationId).toBe(mockConversationData.conversationId);
      expect(result?.expiredAt).toBeUndefined();
    });

    it('should use custom retention period from config', async () => {
      mockCtx.interfaceConfig = { temporaryChatRetention: 48 };
      mockCtx.isTemporary = true;

      const beforeSave = new Date();
      const result = await saveConvo(mockCtx, mockConversationData);

      expect(result?.expiredAt).toBeDefined();

      // Verify expiredAt is approximately 48 hours in the future
      const expectedExpirationTime = new Date(beforeSave.getTime() + 48 * 60 * 60 * 1000);
      const actualExpirationTime = new Date(result?.expiredAt ?? 0);

      expect(actualExpirationTime.getTime()).toBeGreaterThanOrEqual(
        expectedExpirationTime.getTime() - 1000,
      );
      expect(actualExpirationTime.getTime()).toBeLessThanOrEqual(
        expectedExpirationTime.getTime() + 1000,
      );
    });

    it('should handle minimum retention period (1 hour)', async () => {
      // Mock app config with less than minimum retention
      mockCtx.interfaceConfig = { temporaryChatRetention: 0.5 }; // Half hour - should be clamped to 1 hour
      mockCtx.isTemporary = true;

      const beforeSave = new Date();
      const result = await saveConvo(mockCtx, mockConversationData);

      expect(result?.expiredAt).toBeDefined();

      // Verify expiredAt is approximately 1 hour in the future (minimum)
      const expectedExpirationTime = new Date(beforeSave.getTime() + 1 * 60 * 60 * 1000);
      const actualExpirationTime = new Date(result?.expiredAt ?? 0);

      expect(actualExpirationTime.getTime()).toBeGreaterThanOrEqual(
        expectedExpirationTime.getTime() - 1000,
      );
      expect(actualExpirationTime.getTime()).toBeLessThanOrEqual(
        expectedExpirationTime.getTime() + 1000,
      );
    });

    it('should handle maximum retention period (8760 hours)', async () => {
      // Mock app config with more than maximum retention
      mockCtx.interfaceConfig = { temporaryChatRetention: 10000 }; // Should be clamped to 8760 hours
      mockCtx.isTemporary = true;

      const beforeSave = new Date();
      const result = await saveConvo(mockCtx, mockConversationData);

      expect(result?.expiredAt).toBeDefined();

      // Verify expiredAt is approximately 8760 hours (1 year) in the future
      const expectedExpirationTime = new Date(beforeSave.getTime() + 8760 * 60 * 60 * 1000);
      const actualExpirationTime = new Date(result?.expiredAt ?? 0);

      expect(actualExpirationTime.getTime()).toBeGreaterThanOrEqual(
        expectedExpirationTime.getTime() - 1000,
      );
      expect(actualExpirationTime.getTime()).toBeLessThanOrEqual(
        expectedExpirationTime.getTime() + 1000,
      );
    });

    it('should handle missing config gracefully', async () => {
      // Simulate missing config - should use default retention period
      mockCtx.interfaceConfig = undefined;
      mockCtx.isTemporary = true;

      const beforeSave = new Date();
      const result = await saveConvo(mockCtx, mockConversationData);
      const afterSave = new Date();

      // Should still save the conversation with default retention period (30 days)
      expect(result?.conversationId).toBe(mockConversationData.conversationId);
      expect(result?.expiredAt).toBeDefined();
      expect(result?.expiredAt).toBeInstanceOf(Date);

      // Verify expiredAt is approximately 30 days in the future (720 hours)
      const expectedExpirationTime = new Date(beforeSave.getTime() + 720 * 60 * 60 * 1000);
      const actualExpirationTime = new Date(result?.expiredAt ?? 0);

      expect(actualExpirationTime.getTime()).toBeGreaterThanOrEqual(
        expectedExpirationTime.getTime() - 1000,
      );
      expect(actualExpirationTime.getTime()).toBeLessThanOrEqual(
        new Date(afterSave.getTime() + 720 * 60 * 60 * 1000 + 1000).getTime(),
      );
    });

    it('should use default retention when config is not provided', async () => {
      // Mock getAppConfig to return empty config
      mockCtx.interfaceConfig = undefined; // Empty config
      mockCtx.isTemporary = true;

      const beforeSave = new Date();
      const result = await saveConvo(mockCtx, mockConversationData);

      expect(result?.expiredAt).toBeDefined();

      // Default retention is 30 days (720 hours)
      const expectedExpirationTime = new Date(beforeSave.getTime() + 30 * 24 * 60 * 60 * 1000);
      const actualExpirationTime = new Date(result?.expiredAt ?? 0);

      expect(actualExpirationTime.getTime()).toBeGreaterThanOrEqual(
        expectedExpirationTime.getTime() - 1000,
      );
      expect(actualExpirationTime.getTime()).toBeLessThanOrEqual(
        expectedExpirationTime.getTime() + 1000,
      );
    });

    it('should update expiredAt when saving existing temporary conversation', async () => {
      // First save a temporary conversation
      mockCtx.interfaceConfig = { temporaryChatRetention: 24 };
      mockCtx.isTemporary = true;
      const firstSave = await saveConvo(mockCtx, mockConversationData);
      const originalExpiredAt = firstSave?.expiredAt ?? new Date(0);

      // Wait a bit to ensure time difference
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Save again with same conversationId but different title
      const updatedData = { ...mockConversationData, title: 'Updated Title' };
      const secondSave = await saveConvo(mockCtx, updatedData);

      // Should update title and create new expiredAt
      expect(secondSave?.title).toBe('Updated Title');
      expect(secondSave?.expiredAt).toBeDefined();
      expect(new Date(secondSave?.expiredAt ?? 0).getTime()).toBeGreaterThan(
        new Date(originalExpiredAt).getTime(),
      );
    });

    it('should preserve temporary retention when saving without isTemporary', async () => {
      mockCtx.interfaceConfig = { temporaryChatRetention: 24 };
      mockCtx.isTemporary = true;
      const firstSave = await saveConvo(mockCtx, mockConversationData);
      const originalExpiredAt = firstSave?.expiredAt;

      mockCtx.isTemporary = undefined;
      const updatedData = { ...mockConversationData, title: 'Updated Title' };
      const secondSave = await saveConvo(mockCtx, updatedData);

      expect(secondSave?.title).toBe('Updated Title');
      expect(secondSave?.isTemporary).toBe(true);
      expect(secondSave?.expiredAt).toEqual(originalExpiredAt);
    });

    it('should not set expiredAt when updating non-temporary conversation', async () => {
      // First save a non-temporary conversation
      mockCtx.isTemporary = false;
      const firstSave = await saveConvo(mockCtx, mockConversationData);
      expect(firstSave?.expiredAt).toBeNull();

      // Update without isTemporary flag
      mockCtx.isTemporary = undefined;
      const updatedData = { ...mockConversationData, title: 'Updated Title' };
      const secondSave = await saveConvo(mockCtx, updatedData);

      expect(secondSave?.title).toBe('Updated Title');
      expect(secondSave?.expiredAt).toBeNull();
    });

    it.each([true, false, undefined])(
      'uses the independent retention period for isTemporary=%s',
      async (isTemporary) => {
        mockCtx.isTemporary = isTemporary;
        mockCtx.interfaceConfig = {
          temporaryChatRetention: 1,
          generalChatRetention: 2160,
          retentionMode: RetentionMode.ALL,
        };
        const now = Date.now();
        const result = await saveConvo(mockCtx, mockConversationData);
        const expectedHours = isTemporary === true ? 1 : 2160;

        expect(result?.isTemporary).toBe(isTemporary === true);
        expect(result?.expiredAt?.getTime()).toBeGreaterThanOrEqual(now + expectedHours * 3600000);
        expect(result?.expiredAt?.getTime()).toBeLessThan(now + expectedHours * 3600000 + 5000);
      },
    );

    it('ignores caller-supplied retention fields', async () => {
      mockCtx.isTemporary = undefined;
      mockCtx.interfaceConfig = {
        temporaryChatRetention: 1,
        generalChatRetention: 2160,
        retentionMode: RetentionMode.ALL,
      };
      const suppliedExpiration = new Date('2099-01-01T00:00:00.000Z');

      const result = await saveConvo(mockCtx, {
        ...mockConversationData,
        isTemporary: true,
        expiredAt: suppliedExpiration,
      });

      expect(result?.isTemporary).toBe(false);
      expect(result?.expiredAt).not.toEqual(suppliedExpiration);
    });

    it.each([true, false])(
      'preserves the stored deadline when chat type %s is omitted',
      async (isTemporary) => {
        mockCtx.isTemporary = isTemporary;
        mockCtx.interfaceConfig = {
          temporaryChatRetention: 1,
          generalChatRetention: 2160,
          retentionMode: RetentionMode.ALL,
        };
        const first = await saveConvo(mockCtx, mockConversationData);
        mockCtx.isTemporary = undefined;
        const second = await saveConvo(mockCtx, { ...mockConversationData });
        expect(second?.isTemporary).toBe(isTemporary);
        expect(second?.expiredAt).toEqual(first?.expiredAt);
      },
    );

    it('preserves an explicitly inherited deadline with separate retention periods', async () => {
      mockCtx.isTemporary = false;
      mockCtx.expiredAt = new Date(Date.now() + 60000);
      mockCtx.interfaceConfig = {
        temporaryChatRetention: 1,
        generalChatRetention: 2160,
        retentionMode: RetentionMode.ALL,
      };
      const result = await saveConvo(mockCtx, mockConversationData);
      expect(result?.expiredAt).toEqual(mockCtx.expiredAt);
    });

    it('should set expiredAt for non-temporary conversation when retentionMode is ALL', async () => {
      mockCtx.isTemporary = false;
      mockCtx.interfaceConfig = {
        temporaryChatRetention: 24,
        retentionMode: RetentionMode.ALL,
      };
      const result = await saveConvo(mockCtx, mockConversationData);
      expect(result?.expiredAt).toBeDefined();
      expect(result?.isTemporary).toBe(false);
    });

    it('should mark retained conversation non-temporary when retentionMode is ALL and isTemporary is omitted', async () => {
      mockCtx.isTemporary = undefined;
      mockCtx.interfaceConfig = {
        temporaryChatRetention: 24,
        retentionMode: RetentionMode.ALL,
      };

      const result = await saveConvo(mockCtx, mockConversationData);

      expect(result?.expiredAt).toBeDefined();
      expect(result?.isTemporary).toBe(false);
    });

    it('should preserve existing temporary flag when retentionMode is ALL and isTemporary is omitted', async () => {
      mockCtx.isTemporary = true;
      mockCtx.interfaceConfig = {
        temporaryChatRetention: 24,
        retentionMode: RetentionMode.ALL,
      };

      const firstSave = await saveConvo(mockCtx, mockConversationData);

      mockCtx.isTemporary = undefined;
      const secondSave = await saveConvo(mockCtx, {
        ...mockConversationData,
        title: 'Updated Title',
      });

      expect(firstSave?.isTemporary).toBe(true);
      expect(secondSave?.title).toBe('Updated Title');
      expect(secondSave?.isTemporary).toBe(true);
      expect(secondSave?.expiredAt).toBeDefined();
    });

    it('should not set expiredAt when retentionMode is temporary and not isTemporary', async () => {
      mockCtx.isTemporary = false;
      mockCtx.interfaceConfig = {
        temporaryChatRetention: 24,
        retentionMode: RetentionMode.TEMPORARY,
      };
      const result = await saveConvo(mockCtx, mockConversationData);
      expect(result?.expiredAt).toBeNull();
      expect(result?.isTemporary).toBe(false);
    });

    it('should filter out temporary conversations in getConvosByCursor', async () => {
      // Create some test conversations
      const newNonTemporaryConvo = await Conversation.create({
        conversationId: uuidv4(),
        user: 'user123',
        title: 'New Non-temporary Conversation',
        endpoint: EModelEndpoint.openAI,
        isTemporary: false,
        expiredAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
      });

      const oldNonTemporaryConvo = await Conversation.create({
        conversationId: uuidv4(),
        user: 'user123',
        title: 'Old Non-Temporary Conversation',
        endpoint: EModelEndpoint.openAI,
        isTemporary: undefined,
        expiredAt: null,
        updatedAt: new Date(),
      });

      const legacyNullNonTemporaryConvoId = uuidv4();
      await Conversation.collection.insertOne({
        conversationId: legacyNullNonTemporaryConvoId,
        user: 'user123',
        title: 'Legacy Null Non-Temporary Conversation',
        endpoint: EModelEndpoint.openAI,
        isTemporary: null,
        expiredAt: null,
        updatedAt: new Date(),
        createdAt: new Date(),
      });

      const legacyTemporaryConvoId = uuidv4();
      await Conversation.collection.insertOne({
        conversationId: legacyTemporaryConvoId,
        user: 'user123',
        title: 'Legacy Temporary Conversation',
        endpoint: EModelEndpoint.openAI,
        expiredAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
        createdAt: new Date(),
      });

      const expiredRetainedConvo = await Conversation.create({
        conversationId: uuidv4(),
        user: 'user123',
        title: 'Expired Retained Conversation',
        endpoint: EModelEndpoint.openAI,
        isTemporary: false,
        expiredAt: new Date(Date.now() - 60 * 60 * 1000),
        updatedAt: new Date(),
      });

      await Conversation.create({
        conversationId: uuidv4(),
        user: 'user123',
        title: 'Temporary conversation',
        endpoint: EModelEndpoint.openAI,
        isTemporary: true,
        expiredAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
      });

      // Mock Meili search
      Object.assign(Conversation, { meiliSearch: jest.fn().mockResolvedValue({ hits: [] }) });

      const result = await getConvosByCursor('user123');

      // Should return both non-temporary conversations, not the temporary one
      expect(result?.conversations).toHaveLength(3);
      const convoIds = result?.conversations.map((c) => c.conversationId);
      expect(convoIds).toContain(newNonTemporaryConvo.conversationId);
      expect(convoIds).toContain(oldNonTemporaryConvo.conversationId);
      expect(convoIds).toContain(legacyNullNonTemporaryConvoId);
      expect(convoIds).not.toContain(legacyTemporaryConvoId);
      expect(convoIds).not.toContain(expiredRetainedConvo.conversationId);
    });

    it('should filter out temporary conversations in getConvosQueried', async () => {
      const newNonTemporaryConvo = await Conversation.create({
        conversationId: uuidv4(),
        user: 'user123',
        title: 'New Non-temporary Conversation',
        endpoint: EModelEndpoint.openAI,
        isTemporary: false,
        expiredAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
      });

      const oldNonTemporaryConvo = await Conversation.create({
        conversationId: uuidv4(),
        user: 'user123',
        title: 'Old Non-Temporary Conversation',
        endpoint: EModelEndpoint.openAI,
        isTemporary: undefined,
        expiredAt: null,
        updatedAt: new Date(),
      });

      const legacyNullNonTemporaryConvoId = uuidv4();
      await Conversation.collection.insertOne({
        conversationId: legacyNullNonTemporaryConvoId,
        user: 'user123',
        title: 'Legacy Null Non-Temporary Conversation',
        endpoint: EModelEndpoint.openAI,
        isTemporary: null,
        expiredAt: null,
        updatedAt: new Date(),
        createdAt: new Date(),
      });

      const legacyTemporaryConvoId = uuidv4();
      await Conversation.collection.insertOne({
        conversationId: legacyTemporaryConvoId,
        user: 'user123',
        title: 'Legacy Temporary Conversation',
        endpoint: EModelEndpoint.openAI,
        expiredAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
        createdAt: new Date(),
      });

      const expiredRetainedConvo = await Conversation.create({
        conversationId: uuidv4(),
        user: 'user123',
        title: 'Expired Retained Conversation',
        endpoint: EModelEndpoint.openAI,
        isTemporary: false,
        expiredAt: new Date(Date.now() - 60 * 60 * 1000),
        updatedAt: new Date(),
      });

      const tempConvo = await Conversation.create({
        conversationId: uuidv4(),
        user: 'user123',
        title: 'Temporary conversation',
        endpoint: EModelEndpoint.openAI,
        isTemporary: true,
        expiredAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
      });

      const convoIds = [
        { conversationId: newNonTemporaryConvo.conversationId },
        { conversationId: oldNonTemporaryConvo.conversationId },
        { conversationId: legacyNullNonTemporaryConvoId },
        { conversationId: legacyTemporaryConvoId },
        { conversationId: expiredRetainedConvo.conversationId },
        { conversationId: tempConvo.conversationId },
      ];

      const result = await getConvosQueried('user123', convoIds);

      // Should only return the non-temporary conversations
      expect(result?.conversations).toHaveLength(3);

      const resultIds = result?.conversations.map((c) => c.conversationId);
      expect(resultIds).toContain(newNonTemporaryConvo.conversationId);
      expect(resultIds).toContain(oldNonTemporaryConvo.conversationId);
      expect(resultIds).toContain(legacyNullNonTemporaryConvoId);
      expect(result?.convoMap[newNonTemporaryConvo.conversationId]).toBeDefined();
      expect(result?.convoMap[oldNonTemporaryConvo.conversationId]).toBeDefined();
      expect(result?.convoMap[legacyNullNonTemporaryConvoId]).toBeDefined();
      expect(result?.convoMap[legacyTemporaryConvoId]).toBeUndefined();
      expect(result?.convoMap[expiredRetainedConvo.conversationId]).toBeUndefined();
      expect(result?.convoMap[tempConvo.conversationId]).toBeUndefined();
    });

    it('hides durable subagent threads from conversation lists and search results', async () => {
      const parentId = uuidv4();
      const childId = uuidv4();
      const messageId = 'message-1';
      const normalConversation = await Conversation.create({
        conversationId: parentId,
        user: 'user123',
        endpoint: EModelEndpoint.agents,
        title: 'Parent conversation',
      });
      await Conversation.create({
        conversationId: childId,
        user: 'user123',
        endpoint: EModelEndpoint.agents,
        title: 'Subagent: implementation',
        subagentThread: {
          rootConversationId: parentId,
          parentConversationId: parentId,
          parentMessageId: messageId,
          parentToolCallId: 'tool-1',
          subagentType: 'agent-child',
          subagentKind: 'agent',
          depth: 1,
        },
      });
      Object.assign(Conversation, {
        meiliSearch: jest.fn().mockResolvedValue({
          hits: [{ conversationId: parentId }, { conversationId: childId }],
        }),
      });

      const listed = await getConvosByCursor('user123', { search: 'implementation' });
      const queried = await getConvosQueried('user123', [
        { conversationId: parentId },
        { conversationId: childId },
      ]);

      expect(listed.conversations.map((convo) => convo.conversationId)).toEqual([
        normalConversation.conversationId,
      ]);
      expect(queried.conversations.map((convo) => convo.conversationId)).toEqual([
        normalConversation.conversationId,
      ]);
      expect(queried.convoMap[childId]).toBeUndefined();
    });
  });

  describe('searchConversation', () => {
    it('should find a conversation by conversationId', async () => {
      await Conversation.create({
        conversationId: mockConversationData.conversationId,
        user: 'user123',
        title: 'Test',
        endpoint: EModelEndpoint.openAI,
      });

      const result = await searchConversation(mockConversationData.conversationId);

      expect(result).toBeTruthy();
      expect(result!.conversationId).toBe(mockConversationData.conversationId);
      expect(result!.user).toBe('user123');
      expect((result as unknown as { title?: string }).title).toBeUndefined(); // Only returns conversationId and user
    });

    it('should return null if conversation not found', async () => {
      const result = await searchConversation('non-existent-id');
      expect(result).toBeNull();
    });
  });

  describe('getConvo', () => {
    it('should retrieve a conversation for a user', async () => {
      await Conversation.create({
        conversationId: mockConversationData.conversationId,
        user: 'user123',
        title: 'Test Conversation',
        endpoint: EModelEndpoint.openAI,
      });

      const result = await getConvo('user123', mockConversationData.conversationId);

      expect(result!.conversationId).toBe(mockConversationData.conversationId);
      expect(result!.user).toBe('user123');
      expect(result!.title).toBe('Test Conversation');
    });

    it('should return null if conversation not found', async () => {
      const result = await getConvo('user123', 'non-existent-id');
      expect(result).toBeNull();
    });
  });

  describe('getConvoOwnership', () => {
    it('resolves only the owning user id, without the preset or message list', async () => {
      await Conversation.create({
        conversationId: mockConversationData.conversationId,
        user: 'user123',
        tenantId: 'tenant-a',
        title: 'Test Conversation',
        endpoint: EModelEndpoint.openAI,
      });

      const result = await methods.getConvoOwnership(
        'user123',
        mockConversationData.conversationId,
      );

      expect(result?.user).toBe('user123');
      expect(result?.tenantId).toBe('tenant-a');
      expect(result).not.toHaveProperty('title');
      expect(result).not.toHaveProperty('messages');
      expect(result).not.toHaveProperty('endpoint');
    });

    it('returns null for another user or a missing conversation', async () => {
      await Conversation.create({
        conversationId: mockConversationData.conversationId,
        user: 'user123',
        title: 'Test Conversation',
        endpoint: EModelEndpoint.openAI,
      });

      expect(
        await methods.getConvoOwnership('someone-else', mockConversationData.conversationId),
      ).toBeNull();
      expect(await methods.getConvoOwnership('user123', 'non-existent-id')).toBeNull();
    });

    it('hides retention-expired conversations before TTL cleanup', async () => {
      await Conversation.create({
        conversationId: 'expired-owner',
        user: 'user123',
        endpoint: EModelEndpoint.agents,
        expiredAt: new Date(Date.now() - 60_000),
      });

      await expect(methods.getConvoOwnership('user123', 'expired-owner')).resolves.toBeNull();
    });

    it('includes child-thread identity without materializing conversation content', async () => {
      await Conversation.create({
        conversationId: 'child-conversation',
        user: 'user123',
        title: 'Internal child',
        endpoint: EModelEndpoint.agents,
        subagentThread: {
          rootConversationId: 'root-conversation',
          parentConversationId: 'parent-conversation',
          parentMessageId: 'parent-message',
          parentToolCallId: 'parent-tool-call',
          subagentType: 'child-agent',
          subagentKind: 'agent',
          depth: 1,
        },
      });

      const result = await methods.getConvoOwnership('user123', 'child-conversation');

      expect(result).toMatchObject({
        user: 'user123',
        subagentThread: { parentConversationId: 'parent-conversation' },
      });
      expect(result).not.toHaveProperty('title');
    });

    it('selects the exact tenant when conversation identifiers collide', async () => {
      await runAsSystem(async () => {
        await Conversation.create([
          {
            conversationId: 'shared-conversation-id',
            user: 'user123',
            title: 'Tenantless parent',
            endpoint: EModelEndpoint.agents,
          },
          {
            conversationId: 'shared-conversation-id',
            user: 'user123',
            tenantId: 'tenant-a',
            title: 'Tenant parent',
            endpoint: EModelEndpoint.agents,
          },
        ]);
      });

      const tenantless = await methods.getConvoOwnership('user123', 'shared-conversation-id', null);
      const tenant = await methods.getConvoOwnership(
        'user123',
        'shared-conversation-id',
        'tenant-a',
      );

      expect(tenantless?.tenantId).toBeUndefined();
      expect(tenant?.tenantId).toBe('tenant-a');
    });
  });

  describe('getConvoRetention', () => {
    it('should retrieve only retention fields for a user conversation', async () => {
      await Conversation.create({
        conversationId: mockConversationData.conversationId,
        user: 'user123',
        title: 'Test Conversation',
        endpoint: EModelEndpoint.openAI,
        expiredAt: new Date('2030-01-01T00:00:00.000Z'),
      });

      const result = await getConvoRetention('user123', mockConversationData.conversationId);

      expect(result?.expiredAt).toEqual(new Date('2030-01-01T00:00:00.000Z'));
      expect(result).not.toHaveProperty('title');
      expect(result).not.toHaveProperty('messages');
    });
  });

  describe('getConvoTitle', () => {
    it('should return the conversation title', async () => {
      await Conversation.create({
        conversationId: mockConversationData.conversationId,
        user: 'user123',
        title: 'Test Title',
        endpoint: EModelEndpoint.openAI,
      });

      const result = await getConvoTitle('user123', mockConversationData.conversationId);
      expect(result).toBe('Test Title');
    });

    it('should return null if conversation has no title', async () => {
      await Conversation.create({
        conversationId: mockConversationData.conversationId,
        user: 'user123',
        title: null,
        endpoint: EModelEndpoint.openAI,
      });

      const result = await getConvoTitle('user123', mockConversationData.conversationId);
      expect(result).toBeNull();
    });

    it('should return "New Chat" if conversation not found', async () => {
      const result = await getConvoTitle('user123', 'non-existent-id');
      expect(result).toBe('New Chat');
    });
  });

  describe('getConvoFiles', () => {
    it('should return conversation files', async () => {
      const files = ['file1', 'file2'];
      await Conversation.create({
        conversationId: mockConversationData.conversationId,
        user: 'user123',
        endpoint: EModelEndpoint.openAI,
        files,
      });

      const result = await getConvoFiles(mockConversationData.conversationId);
      expect(result).toEqual(files);
    });

    it('should return empty array if no files', async () => {
      await Conversation.create({
        conversationId: mockConversationData.conversationId,
        user: 'user123',
        endpoint: EModelEndpoint.openAI,
      });

      const result = await getConvoFiles(mockConversationData.conversationId);
      expect(result).toEqual([]);
    });

    it('should return empty array if conversation not found', async () => {
      const result = await getConvoFiles('non-existent-id');
      expect(result).toEqual([]);
    });
  });

  describe('deleteConvos', () => {
    it('retires queued-turn work before each conversation deletion wave', async () => {
      const conversationId = uuidv4();
      await Conversation.create({
        conversationId,
        user: 'user123',
        tenantId: 'tenant-1',
        endpoint: EModelEndpoint.agents,
      });
      const transitions: string[] = [];
      const deleteAgentQueuedTurns = jest.fn(async () => {
        transitions.push('queue-retired');
      });
      const eraseAgentTriggerDeliveryConversationResults = jest.fn(async () => {
        transitions.push('trigger-results-erased');
      });
      const scopedMethods = createConversationMethods(mongoose, {
        getMessages,
        deleteMessages,
        deleteAgentQueuedTurns,
        eraseAgentTriggerDeliveryConversationResults,
      });

      await scopedMethods.deleteConvos(
        'user123',
        { conversationId },
        {
          beforeDelete: async () => {
            transitions.push('generation-drained');
          },
        },
      );

      expect(deleteAgentQueuedTurns).toHaveBeenCalledWith('user123', [
        { conversationId, tenantId: 'tenant-1' },
      ]);
      expect(eraseAgentTriggerDeliveryConversationResults).toHaveBeenCalledWith('user123', [
        conversationId,
      ]);
      expect(transitions).toEqual([
        'queue-retired',
        'generation-drained',
        'trigger-results-erased',
      ]);
    });

    it('preserves background receipts when a pre-delete drain fails', async () => {
      const conversationId = uuidv4();
      await Conversation.create({
        conversationId,
        user: 'user123',
        endpoint: EModelEndpoint.agents,
      });
      const eraseAgentTriggerDeliveryConversationResults = jest.fn(async () => undefined);
      const scopedMethods = createConversationMethods(mongoose, {
        getMessages,
        deleteMessages,
        eraseAgentTriggerDeliveryConversationResults,
      });

      await expect(
        scopedMethods.deleteConvos(
          'user123',
          { conversationId },
          { beforeDelete: async () => Promise.reject(new Error('drain unavailable')) },
        ),
      ).rejects.toThrow('drain unavailable');

      expect(await Conversation.findOne({ conversationId })).not.toBeNull();
      expect(eraseAgentTriggerDeliveryConversationResults).not.toHaveBeenCalled();
    });

    it('finishes descendant bookkeeping and message cleanup when receipt erasure fails', async () => {
      const parentId = uuidv4();
      const childId = uuidv4();
      const grandchildId = uuidv4();
      const ids = [parentId, childId, grandchildId];
      const project = await ChatProject.create({ user: 'user123', name: 'Receipt cleanup' });
      await ConversationTag.create({ user: 'user123', tag: 'work', count: 3, position: 0 });
      await Conversation.create(
        ids.map((conversationId, depth) => ({
          conversationId,
          user: 'user123',
          endpoint: EModelEndpoint.agents,
          tags: ['work'],
          chatProjectId: project._id.toString(),
          ...(depth === 0
            ? {}
            : {
                subagentThread: {
                  rootConversationId: parentId,
                  parentConversationId: ids[depth - 1],
                  parentMessageId: `message-${depth}`,
                  parentToolCallId: `call-${depth}`,
                  subagentType: 'agent-child',
                  subagentKind: 'agent',
                  depth,
                },
              }),
        })),
      );
      const prepare = jest.fn(async () => undefined);
      const erase = jest.fn(async () => {
        throw new Error('receipt storage unavailable');
      });
      const scopedMethods = createConversationMethods(mongoose, {
        getMessages,
        deleteMessages,
        prepareAgentTriggerConversationResultErasure: prepare,
        eraseAgentTriggerDeliveryConversationResults: erase,
      });

      const result = await scopedMethods.deleteConvos('user123', { conversationId: parentId });
      expect(result).toMatchObject({ deletedCount: 3, conversationIds: ids });
      expect(prepare.mock.calls).toHaveLength(3);
      expect(erase.mock.calls).toHaveLength(3);
      expect(await Conversation.countDocuments({ user: 'user123' })).toBe(0);
      expect((await ConversationTag.findOne({ user: 'user123', tag: 'work' }).lean())?.count).toBe(
        0,
      );
      expect((await ChatProject.findById(project._id).lean())?.conversationCount).toBe(0);
      expect(deleteMessages).toHaveBeenCalledWith({
        user: 'user123',
        conversationId: { $in: ids },
      });

      await expect(
        scopedMethods.deleteConvos('user123', { conversationId: parentId }, { allowEmpty: true }),
      ).resolves.toMatchObject({ deletedCount: 0, conversationIds: [parentId] });
    });

    it('fails closed before deleting a conversation when queued-turn retirement fails', async () => {
      const conversationId = uuidv4();
      await Conversation.create({
        conversationId,
        user: 'user123',
        endpoint: EModelEndpoint.agents,
      });
      const scopedMethods = createConversationMethods(mongoose, {
        getMessages,
        deleteMessages,
        deleteAgentQueuedTurns: async () => Promise.reject(new Error('retirement unavailable')),
      });

      await expect(scopedMethods.deleteConvos('user123', { conversationId })).rejects.toThrow(
        'retirement unavailable',
      );
      expect(await Conversation.findOne({ conversationId })).not.toBeNull();
    });

    it('should delete conversations and associated messages', async () => {
      await Conversation.create({
        conversationId: mockConversationData.conversationId,
        user: 'user123',
        title: 'To Delete',
        endpoint: EModelEndpoint.openAI,
      });

      deleteMessages.mockResolvedValue({ deletedCount: 5 });

      const result = await deleteConvos('user123', {
        conversationId: mockConversationData.conversationId,
      });

      expect(result?.deletedCount).toBe(1);
      expect(result?.messages.deletedCount).toBe(5);
      expect(deleteMessages).toHaveBeenCalledWith({
        conversationId: { $in: [mockConversationData.conversationId] },
        user: 'user123',
      });

      // Verify conversation was deleted
      const deletedConvo = await Conversation.findOne({
        conversationId: mockConversationData.conversationId,
      });
      expect(deletedConvo).toBeNull();
    });

    it('cascades parent deletion through owner-scoped child-thread lineage', async () => {
      const parentId = uuidv4();
      const childId = uuidv4();
      const grandchildId = uuidv4();
      const otherUsersChildId = uuidv4();
      const lineage = (
        parentConversationId: string,
        rootConversationId: string,
        depth: number,
      ) => ({
        rootConversationId,
        parentConversationId,
        parentMessageId: `message-${depth}`,
        parentToolCallId: `tool-${depth}`,
        subagentType: 'agent-child',
        subagentKind: 'agent',
        depth,
      });
      await Conversation.create([
        { conversationId: parentId, user: 'user123', endpoint: EModelEndpoint.agents },
        {
          conversationId: childId,
          user: 'user123',
          endpoint: EModelEndpoint.agents,
          subagentThread: lineage(parentId, parentId, 1),
        },
        {
          conversationId: grandchildId,
          user: 'user123',
          endpoint: EModelEndpoint.agents,
          subagentThread: lineage(childId, parentId, 2),
        },
        {
          conversationId: otherUsersChildId,
          user: 'other-user',
          endpoint: EModelEndpoint.agents,
          subagentThread: lineage(parentId, parentId, 1),
        },
      ]);
      deleteMessages.mockResolvedValue({ acknowledged: true, deletedCount: 3 });
      const beforeDelete = jest.fn(async (conversationIds: string[]) => {
        expect(
          await Conversation.countDocuments({ conversationId: { $in: conversationIds } }),
        ).toBe(conversationIds.length);
      });

      const result = await deleteConvos('user123', { conversationId: parentId }, { beforeDelete });

      expect(result.deletedCount).toBe(3);
      expect(result.conversationIds).toEqual([parentId, childId, grandchildId]);
      expect(beforeDelete.mock.calls).toEqual([[[parentId]], [[childId]], [[grandchildId]]]);
      expect(deleteMessages).toHaveBeenCalledWith({
        conversationId: { $in: [parentId, childId, grandchildId] },
        user: 'user123',
      });
      expect(await Conversation.find({ user: 'user123' })).toHaveLength(0);
      expect(await Conversation.findOne({ conversationId: otherUsersChildId })).not.toBeNull();
    });

    it('reports a partial cascade failure instead of silently succeeding', async () => {
      const parentId = uuidv4();
      const childId = uuidv4();
      const project = await ChatProject.create({
        user: 'user123',
        name: 'Partial Cascade',
        conversationCount: 1,
        lastConversationId: parentId,
      });
      await ConversationTag.create({ user: 'user123', tag: 'work', count: 1, position: 1 });
      await Conversation.create([
        {
          conversationId: parentId,
          user: 'user123',
          endpoint: EModelEndpoint.agents,
          chatProjectId: project._id!.toString(),
          tags: ['work'],
        },
        {
          conversationId: childId,
          user: 'user123',
          endpoint: EModelEndpoint.agents,
          subagentThread: {
            rootConversationId: parentId,
            parentConversationId: parentId,
            parentMessageId: 'message-1',
            parentToolCallId: 'tool-1',
            subagentType: 'agent-child',
            subagentKind: 'agent',
            depth: 1,
          },
        },
      ]);
      const realFind = Conversation.find.bind(Conversation);
      const findSpy = jest.spyOn(Conversation, 'find').mockImplementation(((filter) => {
        if (
          filter != null &&
          Object.prototype.hasOwnProperty.call(filter, 'subagentThread.parentConversationId')
        ) {
          return {
            select: () => ({ lean: () => Promise.reject(new Error('stepdown')) }),
          };
        }
        return realFind(filter as FilterQuery<IConversation>);
      }) as typeof Conversation.find);

      await expect(deleteConvos('user123', { conversationId: parentId })).rejects.toThrow(
        'stepdown',
      );
      expect(findSpy).toHaveBeenCalledTimes(4);
      expect(await Conversation.findOne({ conversationId: parentId })).toBeNull();
      expect(await Conversation.findOne({ conversationId: childId })).not.toBeNull();
      expect(deleteMessages).not.toHaveBeenCalled();
      expect((await ConversationTag.findOne({ user: 'user123', tag: 'work' }).lean())?.count).toBe(
        0,
      );
      expect(
        (await ChatProject.findById(project._id).lean<IChatProject>())?.conversationCount,
      ).toBe(0);

      findSpy.mockRestore();
      deleteMessages.mockResolvedValue({ acknowledged: true, deletedCount: 2 });
      const recovered = await deleteConvos('user123', { conversationId: parentId });

      expect(recovered.conversationIds).toEqual([parentId, childId]);
      expect(await Conversation.findOne({ conversationId: childId })).toBeNull();
      expect(deleteMessages).toHaveBeenCalledWith({
        conversationId: { $in: [parentId, childId] },
        user: 'user123',
      });
      expect((await ConversationTag.findOne({ user: 'user123', tag: 'work' }).lean())?.count).toBe(
        0,
      );
      findSpy.mockRestore();
    });

    it('does not delete a parent when deleting one child thread', async () => {
      const parentId = uuidv4();
      const childId = uuidv4();
      await Conversation.create([
        { conversationId: parentId, user: 'user123', endpoint: EModelEndpoint.agents },
        {
          conversationId: childId,
          user: 'user123',
          endpoint: EModelEndpoint.agents,
          subagentThread: {
            rootConversationId: parentId,
            parentConversationId: parentId,
            parentMessageId: 'message-1',
            parentToolCallId: 'tool-1',
            subagentType: 'agent-child',
            subagentKind: 'agent',
            depth: 1,
          },
        },
      ]);

      const result = await deleteConvos('user123', { conversationId: childId });

      expect(result.conversationIds).toEqual([childId]);
      expect(await Conversation.findOne({ conversationId: parentId })).not.toBeNull();
    });

    it('should throw error if no conversations found', async () => {
      await expect(deleteConvos('user123', { conversationId: 'non-existent' })).rejects.toThrow(
        'Conversation not found or already deleted.',
      );
    });

    it('allows a single-conversation cleanup retry after topology and messages are gone', async () => {
      const eraseAgentTriggerDeliveryConversationResults = jest.fn(async () => undefined);
      const scopedMethods = createConversationMethods(mongoose, {
        getMessages,
        deleteMessages,
        eraseAgentTriggerDeliveryConversationResults,
      });
      const result = await scopedMethods.deleteConvos(
        'user123',
        { conversationId: 'already-absent' },
        { allowEmpty: true },
      );
      expect(result.deletedCount).toBe(0);
      expect(result.conversationIds).toEqual(['already-absent']);
      expect(eraseAgentTriggerDeliveryConversationResults).toHaveBeenCalledWith('user123', [
        'already-absent',
      ]);
    });

    it('supports an idempotent empty recovery sweep without hiding storage failures', async () => {
      await expect(
        deleteConvos(
          'user123',
          { conversationId: { $in: ['already-absent'] } },
          { allowEmpty: true },
        ),
      ).resolves.toEqual({
        acknowledged: true,
        deletedCount: 0,
        messages: { acknowledged: true, deletedCount: 0 },
        conversationIds: [],
      });

      const find = jest.spyOn(Conversation, 'find').mockImplementationOnce(() => {
        throw new Error('database unavailable');
      });
      await expect(deleteConvos('user123', {}, { allowEmpty: true })).rejects.toThrow(
        'database unavailable',
      );
      find.mockRestore();
    });

    it('should decrement tag counts for a deleted bookmarked conversation', async () => {
      await ConversationTag.create({ user: 'user123', tag: 'work', count: 2, position: 1 });
      const convoId = uuidv4();
      await Conversation.create({
        conversationId: convoId,
        user: 'user123',
        endpoint: EModelEndpoint.openAI,
        tags: ['work'],
      });

      await deleteConvos('user123', { conversationId: convoId });

      const tag = await ConversationTag.findOne({ user: 'user123', tag: 'work' }).lean();
      expect(tag?.count).toBe(1);
    });

    it('should decrement counts for every tag on the deleted conversation', async () => {
      await ConversationTag.create({ user: 'user123', tag: 'work', count: 3, position: 1 });
      await ConversationTag.create({ user: 'user123', tag: 'personal', count: 1, position: 2 });
      const convoId = uuidv4();
      await Conversation.create({
        conversationId: convoId,
        user: 'user123',
        endpoint: EModelEndpoint.openAI,
        tags: ['work', 'personal'],
      });

      await deleteConvos('user123', { conversationId: convoId });

      const work = await ConversationTag.findOne({ user: 'user123', tag: 'work' }).lean();
      const personal = await ConversationTag.findOne({ user: 'user123', tag: 'personal' }).lean();
      expect(work?.count).toBe(2);
      expect(personal?.count).toBe(0);
    });

    it('should decrement a shared tag once per deleted conversation when clearing all', async () => {
      await ConversationTag.create({ user: 'user123', tag: 'work', count: 2, position: 1 });
      await Conversation.create({
        conversationId: uuidv4(),
        user: 'user123',
        endpoint: EModelEndpoint.openAI,
        tags: ['work'],
      });
      await Conversation.create({
        conversationId: uuidv4(),
        user: 'user123',
        endpoint: EModelEndpoint.openAI,
        tags: ['work'],
      });

      await deleteConvos('user123', {});

      const tag = await ConversationTag.findOne({ user: 'user123', tag: 'work' }).lean();
      expect(tag?.count).toBe(0);
    });

    it('should not double-decrement duplicate tag entries within one conversation', async () => {
      await ConversationTag.create({ user: 'user123', tag: 'work', count: 2, position: 1 });
      const convoId = uuidv4();
      await Conversation.create({
        conversationId: convoId,
        user: 'user123',
        endpoint: EModelEndpoint.openAI,
        tags: ['work', 'work'],
      });

      await deleteConvos('user123', { conversationId: convoId });

      const tag = await ConversationTag.findOne({ user: 'user123', tag: 'work' }).lean();
      expect(tag?.count).toBe(1);
    });

    it('should clamp tag counts at zero and never go negative', async () => {
      await ConversationTag.create({ user: 'user123', tag: 'work', count: 0, position: 1 });
      const convoId = uuidv4();
      await Conversation.create({
        conversationId: convoId,
        user: 'user123',
        endpoint: EModelEndpoint.openAI,
        tags: ['work'],
      });

      await deleteConvos('user123', { conversationId: convoId });

      const tag = await ConversationTag.findOne({ user: 'user123', tag: 'work' }).lean();
      expect(tag?.count).toBe(0);
    });

    it('should not touch tags belonging to another user', async () => {
      await ConversationTag.create({ user: 'other', tag: 'work', count: 5, position: 1 });
      const convoId = uuidv4();
      await Conversation.create({
        conversationId: convoId,
        user: 'user123',
        endpoint: EModelEndpoint.openAI,
        tags: ['work'],
      });

      await deleteConvos('user123', { conversationId: convoId });

      const tag = await ConversationTag.findOne({ user: 'other', tag: 'work' }).lean();
      expect(tag?.count).toBe(5);
    });

    it('should not decrement tag counts when the delete removed nothing (lost race)', async () => {
      await ConversationTag.create({ user: 'user123', tag: 'work', count: 2, position: 1 });
      const convoId = uuidv4();
      await Conversation.create({
        conversationId: convoId,
        user: 'user123',
        endpoint: EModelEndpoint.openAI,
        tags: ['work'],
      });

      const deleteSpy = jest
        .spyOn(Conversation, 'deleteMany')
        .mockResolvedValueOnce({ acknowledged: true, deletedCount: 0 } as never);

      await deleteConvos('user123', { conversationId: convoId });

      deleteSpy.mockRestore();
      const tag = await ConversationTag.findOne({ user: 'user123', tag: 'work' }).lean();
      expect(tag?.count).toBe(2);
    });

    it('still decrements tag counts AND returns the deleted ids when message deletion fails', async () => {
      await ConversationTag.create({ user: 'user123', tag: 'work', count: 2, position: 1 });
      const convoId = uuidv4();
      await Conversation.create({
        conversationId: convoId,
        user: 'user123',
        endpoint: EModelEndpoint.openAI,
        tags: ['work'],
      });

      deleteMessages.mockRejectedValueOnce(new Error('message cleanup failed'));

      // Post-delete cleanup is best-effort: the conversations are already gone, so the
      // caller must still receive the deleted ids (downstream cleanup — e.g. agent
      // checkpoint pruning — depends on them, and a retry would find nothing).
      const result = await deleteConvos('user123', { conversationId: convoId });
      expect(result.deletedCount).toBe(1);
      expect(result.conversationIds).toEqual([convoId]);
      expect(result.messages.deletedCount).toBe(0);

      const tag = await ConversationTag.findOne({ user: 'user123', tag: 'work' }).lean();
      expect(tag?.count).toBe(1);
      const convo = await Conversation.findOne({ conversationId: convoId });
      expect(convo).toBeNull();
    });
  });

  describe('archiveAllConvos', () => {
    it('defines an index for the user-scoped ObjectId batch scan', () => {
      const indexFields = Conversation.schema.indexes().map(([fields]) => fields);

      expect(indexFields).toContainEqual({ user: 1, _id: 1 });
    });

    it('archives every unarchived conversation for the user only', async () => {
      const first = uuidv4();
      const second = uuidv4();
      const otherUsers = uuidv4();
      const childThread = uuidv4();
      await Conversation.create([
        { conversationId: first, user: 'user123', endpoint: EModelEndpoint.openAI },
        { conversationId: second, user: 'user123', endpoint: EModelEndpoint.openAI },
        { conversationId: otherUsers, user: 'user456', endpoint: EModelEndpoint.openAI },
        {
          conversationId: childThread,
          user: 'user123',
          endpoint: EModelEndpoint.agents,
          subagentThread: {
            rootConversationId: first,
            parentConversationId: first,
            parentMessageId: 'parent-message',
            parentToolCallId: 'parent-tool-call',
            subagentType: 'agent-child',
            subagentKind: 'agent',
            depth: 1,
          },
        },
      ]);

      const result = await archiveAllConvos('user123');

      expect(result.archivedCount).toBe(2);
      const archived = await Conversation.find({
        user: 'user123',
        conversationId: { $in: [first, second] },
      }).lean<IConversation[]>();
      expect(archived.every((convo) => convo.isArchived === true)).toBe(true);
      const untouched = await Conversation.findOne({
        conversationId: otherUsers,
      }).lean<IConversation>();
      expect(untouched?.isArchived).not.toBe(true);
      const child = await Conversation.findOne({
        conversationId: childThread,
      }).lean<IConversation>();
      expect(child?.isArchived).not.toBe(true);
    });

    it('archives large snapshots in bounded batches', async () => {
      const conversations = Array.from({ length: 501 }, (_, index) => ({
        conversationId: `archive-batch-${index}`,
        user: 'user123',
        endpoint: EModelEndpoint.openAI,
      }));
      await Conversation.insertMany(conversations);
      const updateManySpy = jest.spyOn(Conversation, 'updateMany');

      try {
        const result = await archiveAllConvos('user123');
        expect(result.archivedCount).toBe(conversations.length);
        expect(updateManySpy).toHaveBeenCalledTimes(2);
      } finally {
        updateManySpy.mockRestore();
      }

      const unarchivedCount = await Conversation.countDocuments({
        user: 'user123',
        isArchived: { $ne: true },
      });
      expect(unarchivedCount).toBe(0);
    });

    it('recovers destination projects from the sweep marker, not a per-conversation id list', async () => {
      const conversations = Array.from({ length: 501 }, (_, index) => ({
        conversationId: `archive-recovery-batch-${index}`,
        user: 'user123',
        endpoint: EModelEndpoint.openAI,
      }));
      await Conversation.insertMany(conversations);

      const distinct = Conversation.distinct.bind(Conversation);
      const distinctFilters: ArchiveDistinctFilter[] = [];
      const distinctSpy = jest.spyOn(Conversation, 'distinct').mockImplementation(((
        field,
        filter,
      ) => {
        distinctFilters.push((filter ?? {}) as ArchiveDistinctFilter);
        return distinct(field, filter);
      }) as typeof Conversation.distinct);

      try {
        const result = await archiveAllConvos('user123');
        expect(result.archivedCount).toBe(conversations.length);
      } finally {
        distinctSpy.mockRestore();
      }

      /** Every id list stays within one batch, so nothing accumulates across the sweep. */
      const idListSizes = distinctFilters
        .map((filter) => filter._id?.$in?.length)
        .filter((size): size is number => size !== undefined);
      expect(idListSizes.length).toBeGreaterThan(0);
      expect(Math.max(...idListSizes)).toBeLessThanOrEqual(500);

      const recoveryFilters = distinctFilters.filter((filter) => filter.archivedAt instanceof Date);
      expect(recoveryFilters).toHaveLength(1);
      expect(recoveryFilters[0]._id).toBeUndefined();
      expect(recoveryFilters[0]).toMatchObject({ user: 'user123', isArchived: true });
    });

    it('recovers a batch-sized destination move from the marker alone', async () => {
      const destinationProject = await ChatProject.create({ user: 'user123', name: 'Destination' });
      const conversations = Array.from({ length: 501 }, (_, index) => ({
        conversationId: `archive-recovery-scale-${index}`,
        user: 'user123',
        endpoint: EModelEndpoint.openAI,
      }));
      await Conversation.insertMany(conversations);

      /** The chats carry no project when the sweep captures them, so the destination is
       * reachable only through the marker: nothing in the loop ever saw it. */
      const updateMany = Conversation.updateMany.bind(Conversation);
      const updateManySpy = jest.spyOn(Conversation, 'updateMany').mockImplementationOnce((async (
        filter,
        update,
        options,
      ) => {
        const result = await updateMany(filter, update, options);
        await Conversation.updateMany(
          { user: 'user123' },
          { $set: { chatProjectId: destinationProject._id!.toString() } },
          { timestamps: false },
        );
        await ChatProject.findByIdAndUpdate(destinationProject._id, {
          conversationCount: conversations.length,
          lastConversationId: conversations[conversations.length - 1].conversationId,
        });
        return result;
      }) as typeof Conversation.updateMany);
      const distinct = Conversation.distinct.bind(Conversation);
      const distinctSpy = jest
        .spyOn(Conversation, 'distinct')
        .mockRejectedValueOnce(new Error('project discovery failed'))
        .mockRejectedValueOnce(new Error('project discovery failed'))
        .mockRejectedValueOnce(new Error('project discovery failed'))
        .mockImplementation(((...args) => distinct(...args)) as typeof Conversation.distinct);

      try {
        await expect(archiveAllConvos('user123')).rejects.toThrow('project discovery failed');
      } finally {
        updateManySpy.mockRestore();
        distinctSpy.mockRestore();
      }

      const archived = await Conversation.countDocuments({ user: 'user123', isArchived: true });
      expect(archived).toBe(500);
      const refreshed = await ChatProject.findById(destinationProject._id).lean<IChatProject>();
      expect(refreshed?.conversationCount).toBe(1);
    });

    it('replays a failed project refresh without abandoning the rest of the run', async () => {
      const projects = await ChatProject.insertMany(
        Array.from({ length: 11 }, (_, index) => ({
          user: 'user123',
          name: `Project ${index}`,
          conversationCount: 1,
          lastConversationId: `project-conversation-${index}`,
        })),
      );
      await Conversation.insertMany(
        projects.map((project, index) => ({
          conversationId: `project-conversation-${index}`,
          user: 'user123',
          endpoint: EModelEndpoint.openAI,
          chatProjectId: project._id!.toString(),
        })),
      );
      const countDocumentsSpy = jest
        .spyOn(Conversation, 'countDocuments')
        .mockRejectedValueOnce(new Error('transient project refresh failure'));

      try {
        const result = await archiveAllConvos('user123');
        expect(result.archivedCount).toBe(projects.length);
        /** Ten in the first batch and one in the second, then a replay of the one that
         * failed: nothing else in the run is still competing with it by then. */
        expect(countDocumentsSpy).toHaveBeenCalledTimes(projects.length + 1);
      } finally {
        countDocumentsSpy.mockRestore();
      }

      const refreshed = await ChatProject.find({ user: 'user123' }).lean<IChatProject[]>();
      expect(refreshed).toHaveLength(projects.length);
      for (const project of refreshed) {
        expect(project.conversationCount).toBe(0);
        expect(project.lastConversationId).toBeNull();
      }
    });

    it('leaves already-archived conversations untouched', async () => {
      const alreadyArchived = uuidv4();
      await Conversation.create({
        conversationId: alreadyArchived,
        user: 'user123',
        endpoint: EModelEndpoint.openAI,
        isArchived: true,
      });

      const result = await archiveAllConvos('user123');

      expect(result.archivedCount).toBe(0);
    });

    it('skips temporary and retention-expired conversations', async () => {
      const temporary = uuidv4();
      const expired = uuidv4();
      const visible = uuidv4();
      await Conversation.create([
        {
          conversationId: temporary,
          user: 'user123',
          endpoint: EModelEndpoint.openAI,
          isTemporary: true,
          expiredAt: new Date(Date.now() + 60 * 60 * 1000),
        },
        {
          conversationId: expired,
          user: 'user123',
          endpoint: EModelEndpoint.openAI,
          expiredAt: new Date(Date.now() - 60 * 60 * 1000),
        },
        { conversationId: visible, user: 'user123', endpoint: EModelEndpoint.openAI },
      ]);

      const result = await archiveAllConvos('user123');

      expect(result.archivedCount).toBe(1);
      const temporaryConvo = await Conversation.findOne({
        conversationId: temporary,
      }).lean<IConversation>();
      const expiredConvo = await Conversation.findOne({
        conversationId: expired,
      }).lean<IConversation>();
      expect(temporaryConvo?.isArchived).not.toBe(true);
      expect(expiredConvo?.isArchived).not.toBe(true);
    });

    it('preserves each conversation updatedAt so the archived view keeps its order', async () => {
      const convoId = uuidv4();
      const updatedAt = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      await Conversation.create({
        conversationId: convoId,
        user: 'user123',
        endpoint: EModelEndpoint.openAI,
        createdAt: updatedAt,
        updatedAt,
      });

      await archiveAllConvos('user123');

      const archived = await Conversation.findOne({
        conversationId: convoId,
      }).lean<IConversation>();
      expect(archived?.updatedAt?.toISOString()).toBe(updatedAt.toISOString());
    });

    it('stamps archivedAt so the sweep is dated and sorted as archived now', async () => {
      const before = Date.now();
      const convoIds = [uuidv4(), uuidv4()];
      await Conversation.insertMany(
        convoIds.map((conversationId) => ({
          conversationId,
          user: 'user123',
          endpoint: EModelEndpoint.openAI,
          createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        })),
      );

      await archiveAllConvos('user123');

      const archived = await Conversation.find({ conversationId: { $in: convoIds } }).lean<
        IConversation[]
      >();
      expect(archived).toHaveLength(2);
      for (const conversation of archived) {
        expect(conversation.archivedAt).toBeInstanceOf(Date);
        expect(new Date(conversation.archivedAt ?? 0).getTime()).toBeGreaterThanOrEqual(before);
      }
      expect(new Date(archived[0].archivedAt ?? 0).toISOString()).toBe(
        new Date(archived[1].archivedAt ?? 0).toISOString(),
      );
    });

    it('leaves the archivedAt of an already-archived chat alone', async () => {
      const original = new Date('2026-01-01T00:00:00.000Z');
      const archivedId = uuidv4();
      await Conversation.create({
        conversationId: archivedId,
        user: 'user123',
        endpoint: EModelEndpoint.openAI,
        isArchived: true,
        archivedAt: original,
      });

      await archiveAllConvos('user123');

      const untouched = await Conversation.findOne({
        conversationId: archivedId,
      }).lean<IConversation>();
      expect(new Date(untouched?.archivedAt ?? 0).toISOString()).toBe(original.toISOString());
    });

    it('refreshes stats for every project the archived conversations belonged to', async () => {
      const project = await ChatProject.create({ user: 'user123', name: 'Project' });
      const projectId = project._id!.toString();
      const convoId = uuidv4();
      await Conversation.create({
        conversationId: convoId,
        user: 'user123',
        endpoint: EModelEndpoint.openAI,
        chatProjectId: projectId,
      });
      await ChatProject.findByIdAndUpdate(project._id, {
        conversationCount: 1,
        lastConversationId: convoId,
      });

      await archiveAllConvos('user123');

      const refreshed = await ChatProject.findById(project._id).lean<IChatProject>();
      expect(refreshed?.conversationCount).toBe(0);
      expect(refreshed?.lastConversationId).toBeNull();
    });

    it('does not archive a project conversation created after the initial snapshot', async () => {
      const project = await ChatProject.create({ user: 'user123', name: 'Project' });
      const projectId = project._id!.toString();
      const initialConversationId = uuidv4();
      const concurrentConversationId = uuidv4();
      await Conversation.create({
        conversationId: initialConversationId,
        user: 'user123',
        endpoint: EModelEndpoint.openAI,
      });

      const updateMany = Conversation.updateMany.bind(Conversation);
      const updateManySpy = jest.spyOn(Conversation, 'updateMany').mockImplementationOnce((async (
        filter,
        update,
        options,
      ) => {
        await Conversation.create({
          conversationId: concurrentConversationId,
          user: 'user123',
          endpoint: EModelEndpoint.openAI,
          chatProjectId: projectId,
        });
        await ChatProject.findByIdAndUpdate(project._id, {
          conversationCount: 1,
          lastConversationId: concurrentConversationId,
        });
        return await updateMany(filter, update, options);
      }) as typeof Conversation.updateMany);

      try {
        const result = await archiveAllConvos('user123');
        expect(result.archivedCount).toBe(1);
      } finally {
        updateManySpy.mockRestore();
      }

      const concurrentConversation = await Conversation.findOne({
        conversationId: concurrentConversationId,
      }).lean<IConversation>();
      const refreshed = await ChatProject.findById(project._id).lean<IChatProject>();
      expect(concurrentConversation?.isArchived).not.toBe(true);
      expect(refreshed?.conversationCount).toBe(1);
      expect(refreshed?.lastConversationId).toBe(concurrentConversationId);
    });

    it('retries destination-project discovery after a transient distinct failure', async () => {
      const sourceProject = await ChatProject.create({ user: 'user123', name: 'Source' });
      const destinationProject = await ChatProject.create({ user: 'user123', name: 'Destination' });
      const conversationId = uuidv4();
      await Conversation.create({
        conversationId,
        user: 'user123',
        endpoint: EModelEndpoint.openAI,
        chatProjectId: sourceProject._id!.toString(),
      });
      await ChatProject.findByIdAndUpdate(sourceProject._id, {
        conversationCount: 1,
        lastConversationId: conversationId,
      });

      const updateMany = Conversation.updateMany.bind(Conversation);
      const updateManySpy = jest.spyOn(Conversation, 'updateMany').mockImplementationOnce((async (
        filter,
        update,
        options,
      ) => {
        await Conversation.updateOne(
          { conversationId },
          { $set: { chatProjectId: destinationProject._id!.toString() } },
        );
        await ChatProject.findByIdAndUpdate(sourceProject._id, {
          conversationCount: 0,
          lastConversationId: null,
        });
        await ChatProject.findByIdAndUpdate(destinationProject._id, {
          conversationCount: 1,
          lastConversationId: conversationId,
        });
        return await updateMany(filter, update, options);
      }) as typeof Conversation.updateMany);
      const distinct = Conversation.distinct.bind(Conversation);
      const distinctSpy = jest
        .spyOn(Conversation, 'distinct')
        .mockRejectedValueOnce(new Error('transient project discovery failure'))
        .mockImplementation(((...args) => distinct(...args)) as typeof Conversation.distinct);

      try {
        const result = await archiveAllConvos('user123');
        expect(result.archivedCount).toBe(1);
      } finally {
        updateManySpy.mockRestore();
        distinctSpy.mockRestore();
      }

      const refreshed = await ChatProject.findById(destinationProject._id).lean<IChatProject>();
      expect(refreshed?.conversationCount).toBe(0);
      expect(refreshed?.lastConversationId).toBeNull();
    });

    it('reconciles the destination project when discovery retries exhaust after a move', async () => {
      const sourceProject = await ChatProject.create({ user: 'user123', name: 'Source' });
      const destinationProject = await ChatProject.create({ user: 'user123', name: 'Destination' });
      const conversationId = uuidv4();
      await Conversation.create({
        conversationId,
        user: 'user123',
        endpoint: EModelEndpoint.openAI,
        chatProjectId: sourceProject._id!.toString(),
      });
      await ChatProject.findByIdAndUpdate(sourceProject._id, {
        conversationCount: 1,
        lastConversationId: conversationId,
      });

      const updateMany = Conversation.updateMany.bind(Conversation);
      const updateManySpy = jest.spyOn(Conversation, 'updateMany').mockImplementationOnce((async (
        filter,
        update,
        options,
      ) => {
        await Conversation.updateOne(
          { conversationId },
          { $set: { chatProjectId: destinationProject._id!.toString() } },
        );
        await ChatProject.findByIdAndUpdate(sourceProject._id, {
          conversationCount: 0,
          lastConversationId: null,
        });
        await ChatProject.findByIdAndUpdate(destinationProject._id, {
          conversationCount: 1,
          lastConversationId: conversationId,
        });
        return await updateMany(filter, update, options);
      }) as typeof Conversation.updateMany);
      const distinct = Conversation.distinct.bind(Conversation);
      const distinctSpy = jest
        .spyOn(Conversation, 'distinct')
        .mockRejectedValueOnce(new Error('project discovery failed'))
        .mockRejectedValueOnce(new Error('project discovery failed'))
        .mockRejectedValueOnce(new Error('project discovery failed'))
        .mockImplementation(((...args) => distinct(...args)) as typeof Conversation.distinct);

      try {
        await expect(archiveAllConvos('user123')).rejects.toThrow('project discovery failed');
      } finally {
        updateManySpy.mockRestore();
        distinctSpy.mockRestore();
      }

      const archived = await Conversation.findOne({ conversationId }).lean<IConversation>();
      const refreshed = await ChatProject.findById(destinationProject._id).lean<IChatProject>();
      expect(archived?.isArchived).toBe(true);
      expect(refreshed?.conversationCount).toBe(0);
      expect(refreshed?.lastConversationId).toBeNull();
    });

    it('refreshes the destination project when a captured conversation moves before archiving', async () => {
      const sourceProject = await ChatProject.create({ user: 'user123', name: 'Source' });
      const destinationProject = await ChatProject.create({ user: 'user123', name: 'Destination' });
      const conversationId = uuidv4();
      await Conversation.create({
        conversationId,
        user: 'user123',
        endpoint: EModelEndpoint.openAI,
        chatProjectId: sourceProject._id!.toString(),
      });
      await ChatProject.findByIdAndUpdate(sourceProject._id, {
        conversationCount: 1,
        lastConversationId: conversationId,
      });

      const updateMany = Conversation.updateMany.bind(Conversation);
      const updateManySpy = jest.spyOn(Conversation, 'updateMany').mockImplementationOnce((async (
        filter,
        update,
        options,
      ) => {
        await Conversation.updateOne(
          { conversationId },
          { $set: { chatProjectId: destinationProject._id!.toString() } },
        );
        await ChatProject.findByIdAndUpdate(sourceProject._id, {
          conversationCount: 0,
          lastConversationId: null,
        });
        await ChatProject.findByIdAndUpdate(destinationProject._id, {
          conversationCount: 1,
          lastConversationId: conversationId,
        });
        return await updateMany(filter, update, options);
      }) as typeof Conversation.updateMany);

      try {
        const result = await archiveAllConvos('user123');
        expect(result.archivedCount).toBe(1);
      } finally {
        updateManySpy.mockRestore();
      }

      const refreshed = await ChatProject.findById(destinationProject._id).lean<IChatProject>();
      expect(refreshed?.conversationCount).toBe(0);
      expect(refreshed?.lastConversationId).toBeNull();
    });

    it('refreshes project stats for committed batches when a later batch fails', async () => {
      const project = await ChatProject.create({ user: 'user123', name: 'Project' });
      const projectId = project._id!.toString();
      const conversations = Array.from({ length: 501 }, (_, index) => ({
        conversationId: `archive-partial-fail-${index}`,
        user: 'user123',
        endpoint: EModelEndpoint.openAI,
        chatProjectId: projectId,
      }));
      await Conversation.insertMany(conversations);
      await ChatProject.findByIdAndUpdate(project._id, {
        conversationCount: conversations.length,
        lastConversationId: conversations[conversations.length - 1].conversationId,
      });

      const updateMany = Conversation.updateMany.bind(Conversation);
      const updateManySpy = jest
        .spyOn(Conversation, 'updateMany')
        .mockImplementationOnce(((...args) =>
          updateMany(...args)) as typeof Conversation.updateMany)
        .mockImplementationOnce(() => {
          throw new Error('later batch update failed');
        });

      try {
        await expect(archiveAllConvos('user123')).rejects.toThrow('later batch update failed');
      } finally {
        updateManySpy.mockRestore();
      }

      const archivedCount = await Conversation.countDocuments({
        user: 'user123',
        isArchived: true,
      });
      expect(archivedCount).toBe(500);

      const remaining = await Conversation.findOne({
        user: 'user123',
        isArchived: { $ne: true },
      }).lean<IConversation>();
      const refreshed = await ChatProject.findById(project._id).lean<IChatProject>();
      expect(refreshed?.conversationCount).toBe(1);
      expect(refreshed?.lastConversationId).toBe(remaining?.conversationId);
    });

    it('reconciles projects when an archive write commits but its result is lost', async () => {
      const destinationProject = await ChatProject.create({ user: 'user123', name: 'Destination' });
      const conversationId = uuidv4();
      await Conversation.create({
        conversationId,
        user: 'user123',
        endpoint: EModelEndpoint.openAI,
      });

      /** The chat carries no project when the sweep captures it and the write never
       * reports a modified count, so the marker is the only thing left that knows the
       * archive happened at all. */
      const updateMany = Conversation.updateMany.bind(Conversation);
      const updateManySpy = jest.spyOn(Conversation, 'updateMany').mockImplementationOnce((async (
        filter,
        update,
        options,
        /** Annotated because a mock that only ever throws infers `Promise<never>`, which
         * the cast back to the real signature rejects. */
      ): Promise<UpdateResult> => {
        await updateMany(filter, update, options);
        await Conversation.updateOne(
          { conversationId },
          { $set: { chatProjectId: destinationProject._id!.toString() } },
        );
        await ChatProject.findByIdAndUpdate(destinationProject._id, {
          conversationCount: 1,
          lastConversationId: conversationId,
        });
        throw new Error('connection reset before the write acknowledged');
      }) as typeof Conversation.updateMany);

      try {
        await expect(archiveAllConvos('user123')).rejects.toThrow(
          'connection reset before the write acknowledged',
        );
      } finally {
        updateManySpy.mockRestore();
      }

      const archived = await Conversation.findOne({ conversationId }).lean<IConversation>();
      expect(archived?.isArchived).toBe(true);
      const refreshed = await ChatProject.findById(destinationProject._id).lean<IChatProject>();
      expect(refreshed?.conversationCount).toBe(0);
      expect(refreshed?.lastConversationId).toBeNull();
    });

    it('does not let a save in flight restore the project pointer it just cleared', async () => {
      const project = await ChatProject.create({ user: 'user123', name: 'Project' });
      const projectId = project._id!.toString();
      const conversationId = uuidv4();
      const anchor = new Date('2026-01-01T00:00:00.000Z');
      await Conversation.collection.insertOne({
        conversationId,
        user: 'user123',
        title: 'legacy chat with no isTemporary',
        endpoint: EModelEndpoint.openAI,
        chatProjectId: projectId,
        expiredAt: null,
        isArchived: false,
        createdAt: anchor,
        updatedAt: anchor,
      });
      await ChatProject.findByIdAndUpdate(project._id, {
        conversationCount: 1,
        lastConversationAt: anchor,
        lastConversationId: conversationId,
      });

      /** The sweep lands after the save's own write has returned, so the save carries a
       * document that still says the chat is visible. Re-sending the unchanged
       * `chatProjectId`, as a client saving into an open project chat does, is what puts
       * the tail on the pointer branch instead of the recompute one. */
      const findOneAndUpdate = Conversation.findOneAndUpdate.bind(Conversation);
      const findOneAndUpdateSpy = jest
        .spyOn(Conversation, 'findOneAndUpdate')
        .mockImplementationOnce((async (filter, update, options) => {
          const result = await findOneAndUpdate(filter, update, options);
          await archiveAllConvos('user123');
          return result;
        }) as typeof Conversation.findOneAndUpdate);

      try {
        await saveConvo(
          { userId: 'user123' },
          { conversationId, chatProjectId: projectId, title: 'Renamed while the sweep ran' },
          { noUpsert: true },
        );
      } finally {
        findOneAndUpdateSpy.mockRestore();
      }

      const archived = await Conversation.findOne({ conversationId }).lean<IConversation>();
      expect(archived?.isArchived).toBe(true);
      const refreshed = await ChatProject.findById(project._id).lean<IChatProject>();
      expect(refreshed?.lastConversationId).toBeNull();
      expect(refreshed?.lastConversationAt).toBeNull();
      expect(refreshed?.conversationCount).toBe(0);
    });

    it('repairs the project when the sweep lands while the pointer write is in flight', async () => {
      const project = await ChatProject.create({ user: 'user123', name: 'Project' });
      const projectId = project._id!.toString();
      const conversationId = uuidv4();
      const anchor = new Date('2026-01-01T00:00:00.000Z');
      await Conversation.collection.insertOne({
        conversationId,
        user: 'user123',
        title: 'chat being saved',
        endpoint: EModelEndpoint.openAI,
        chatProjectId: projectId,
        expiredAt: null,
        isArchived: false,
        createdAt: anchor,
        updatedAt: anchor,
      });
      await ChatProject.findByIdAndUpdate(project._id, {
        conversationCount: 1,
        lastConversationAt: anchor,
        lastConversationId: conversationId,
      });

      /** The sweep runs after the save has decided the chat is visible and immediately
       * before its pointer write commits, which is the one window a check taken before
       * that write cannot cover. */
      const updateOne = ChatProject.updateOne.bind(ChatProject);
      const updateOneSpy = jest.spyOn(ChatProject, 'updateOne').mockImplementationOnce((async (
        filter,
        update,
        options,
      ) => {
        await archiveAllConvos('user123');
        return await updateOne(filter, update, options);
      }) as typeof ChatProject.updateOne);

      try {
        await saveConvo(
          { userId: 'user123' },
          { conversationId, chatProjectId: projectId, title: 'Renamed while the sweep ran' },
          { noUpsert: true },
        );
      } finally {
        updateOneSpy.mockRestore();
      }

      const archived = await Conversation.findOne({ conversationId }).lean<IConversation>();
      expect(archived?.isArchived).toBe(true);
      const refreshed = await ChatProject.findById(project._id).lean<IChatProject>();
      expect(refreshed?.lastConversationId).toBeNull();
      expect(refreshed?.lastConversationAt).toBeNull();
      expect(refreshed?.conversationCount).toBe(0);
    });

    it('returns zero when the user has no conversations', async () => {
      const result = await archiveAllConvos('user123');
      expect(result.archivedCount).toBe(0);
    });
  });

  describe('deleteNullOrEmptyConversations', () => {
    it('should delete conversations with null, empty, or missing conversationIds', async () => {
      // Since conversationId is required by the schema, we can't create documents with null/missing IDs
      // This test should verify the function works when such documents exist (e.g., from data corruption)

      // For this test, let's create a valid conversation and verify the function doesn't delete it
      await Conversation.create({
        conversationId: mockConversationData.conversationId,
        user: 'user4',
        endpoint: EModelEndpoint.openAI,
      });

      deleteMessages.mockResolvedValue({ deletedCount: 0 });

      const result = await deleteNullOrEmptyConversations();

      expect(result?.conversations.deletedCount).toBe(0); // No invalid conversations to delete
      expect(result?.messages.deletedCount).toBe(0);

      // Verify valid conversation remains
      const remainingConvos = await Conversation.find({});
      expect(remainingConvos).toHaveLength(1);
      expect(remainingConvos[0].conversationId).toBe(mockConversationData.conversationId);
    });
  });

  describe('Error Handling', () => {
    it('should handle database errors in saveConvo', async () => {
      // Force a database error by disconnecting
      await mongoose.disconnect();

      const result = await saveConvo(mockCtx, mockConversationData);

      expect(result).toEqual({ message: 'Error saving conversation' });

      // Reconnect for other tests
      await mongoose.connect(mongoServer.getUri());
    });
  });

  describe('getConvosByCursor pagination', () => {
    /**
     * Helper to create conversations with specific timestamps
     * Uses collection.insertOne to bypass Mongoose timestamps entirely
     */
    const createConvoWithTimestamps = async (index: number, createdAt: Date, updatedAt: Date) => {
      const conversationId = uuidv4();
      // Use collection-level insert to bypass Mongoose timestamps
      await Conversation.collection.insertOne({
        conversationId,
        user: 'user123',
        title: `Conversation ${index}`,
        endpoint: EModelEndpoint.openAI,
        expiredAt: null,
        isArchived: false,
        createdAt,
        updatedAt,
      });
      return Conversation.findOne({ conversationId }).lean<IConversation>();
    };

    it('should flag conversations that have an active shared link', async () => {
      const SharedLink = mongoose.models.SharedLink as mongoose.Model<{
        conversationId: string;
        user: string;
        shareId: string;
        expiredAt?: Date | null;
      }>;
      const baseTime = new Date('2026-03-01T00:00:00.000Z');
      const shared = await createConvoWithTimestamps(1, baseTime, baseTime);
      const unshared = await createConvoWithTimestamps(2, baseTime, baseTime);
      const expiredShare = await createConvoWithTimestamps(3, baseTime, baseTime);

      await SharedLink.create([
        {
          conversationId: shared!.conversationId,
          user: 'user123',
          shareId: `share-${uuidv4()}`,
        },
        {
          conversationId: expiredShare!.conversationId,
          user: 'user123',
          shareId: `share-${uuidv4()}`,
          expiredAt: new Date('2020-01-01T00:00:00.000Z'),
        },
      ]);

      const result = await methods.getConvosByCursor('user123', { limit: 25 });
      const byId = new Map(result.conversations.map((convo) => [convo.conversationId, convo]));

      expect(byId.get(shared!.conversationId)?.isShared).toBe(true);
      expect(byId.get(unshared!.conversationId)?.isShared).toBe(false);
      expect(byId.get(expiredShare!.conversationId)?.isShared).toBe(false);

      await SharedLink.deleteMany({ user: 'user123' });
      await Conversation.deleteMany({ user: 'user123' });
    });

    it('should skip the shared lookup when shared links are disabled', async () => {
      const SharedLink = mongoose.models.SharedLink as mongoose.Model<{
        conversationId: string;
        user: string;
        shareId: string;
      }>;
      const baseTime = new Date('2026-03-02T00:00:00.000Z');
      const shared = await createConvoWithTimestamps(1, baseTime, baseTime);
      await SharedLink.create({
        conversationId: shared!.conversationId,
        user: 'user123',
        shareId: `share-${uuidv4()}`,
      });

      process.env.ALLOW_SHARED_LINKS = 'false';
      try {
        const result = await methods.getConvosByCursor('user123', { limit: 25 });
        expect(result.conversations[0].isShared).toBeUndefined();
      } finally {
        delete process.env.ALLOW_SHARED_LINKS;
      }

      await SharedLink.deleteMany({ user: 'user123' });
      await Conversation.deleteMany({ user: 'user123' });
    });

    it('should page through titles that share a timestamp', async () => {
      // Imports land with identical titles and timestamps, so (title, updatedAt)
      // alone cannot mark where the previous page stopped.
      const sameTime = new Date('2026-04-01T00:00:00.000Z');
      for (let index = 0; index < 6; index++) {
        await Conversation.collection.insertOne({
          conversationId: uuidv4(),
          user: 'user123',
          title: 'Imported chat',
          endpoint: EModelEndpoint.openAI,
          expiredAt: null,
          isArchived: false,
          createdAt: sameTime,
          updatedAt: sameTime,
        });
      }

      const seen = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < 6; page++) {
        const result = await methods.getConvosByCursor('user123', {
          limit: 2,
          sortBy: 'title',
          sortDirection: 'asc',
          cursor,
        });
        result.conversations.forEach((convo) => seen.add(convo.conversationId));
        cursor = result.nextCursor;
        if (!cursor) {
          break;
        }
      }

      expect(seen.size).toBe(6);

      await Conversation.deleteMany({ user: 'user123' });
    });

    it('should page past conversations that have no title', async () => {
      const sameTime = new Date('2026-04-15T00:00:00.000Z');
      for (let index = 0; index < 3; index++) {
        await Conversation.collection.insertOne({
          conversationId: uuidv4(),
          user: 'user123',
          endpoint: EModelEndpoint.openAI,
          expiredAt: null,
          isArchived: false,
          createdAt: sameTime,
          updatedAt: sameTime,
        });
        await Conversation.collection.insertOne({
          conversationId: uuidv4(),
          user: 'user123',
          title: `Named ${index}`,
          endpoint: EModelEndpoint.openAI,
          expiredAt: null,
          isArchived: false,
          createdAt: sameTime,
          updatedAt: sameTime,
        });
      }

      // Missing titles sort before every string, and comparison operators never cross
      // that type boundary, so the group needs cursor clauses of its own.
      for (const sortDirection of ['asc', 'desc']) {
        const seen = new Set<string>();
        let cursor: string | null = null;
        for (let page = 0; page < 6; page++) {
          const result = await methods.getConvosByCursor('user123', {
            limit: 2,
            sortBy: 'title',
            sortDirection,
            cursor,
          });
          result.conversations.forEach((convo) => seen.add(convo.conversationId));
          cursor = result.nextCursor;
          if (!cursor) {
            break;
          }
        }

        expect(seen.size).toBe(6);
      }

      await Conversation.deleteMany({ user: 'user123' });
    });

    it('should not skip conversations at page boundaries', async () => {
      // Create 30 conversations to ensure pagination (limit is 25)
      const baseTime = new Date('2026-01-01T00:00:00.000Z');
      const convos: unknown[] = [];

      for (let i = 0; i < 30; i++) {
        const updatedAt = new Date(baseTime.getTime() - i * 60000); // Each 1 minute apart
        const convo = await createConvoWithTimestamps(i, updatedAt, updatedAt);
        convos.push(convo);
      }

      // Fetch first page
      const page1 = await getConvosByCursor('user123', { limit: 25 });

      expect(page1.conversations).toHaveLength(25);
      expect(page1.nextCursor).toBeTruthy();

      // Fetch second page using cursor
      const page2 = await getConvosByCursor('user123', {
        limit: 25,
        cursor: page1.nextCursor,
      });

      // Should get remaining 5 conversations
      expect(page2.conversations).toHaveLength(5);
      expect(page2.nextCursor).toBeNull();

      // Verify no duplicates and no gaps
      const allIds = [
        ...page1.conversations.map((c: IConversation) => c.conversationId),
        ...page2.conversations.map((c: IConversation) => c.conversationId),
      ];
      const uniqueIds = new Set(allIds);

      expect(uniqueIds.size).toBe(30); // All 30 conversations accounted for
      expect(allIds.length).toBe(30); // No duplicates
    });

    it('should include conversation at exact page boundary (item 26 bug fix)', async () => {
      // This test specifically verifies the fix for the bug where item 26
      // (the first item that should appear on page 2) was being skipped

      const baseTime = new Date('2026-01-01T12:00:00.000Z');

      // Create exactly 26 conversations
      const convos: (IConversation | null)[] = [];
      for (let i = 0; i < 26; i++) {
        const updatedAt = new Date(baseTime.getTime() - i * 60000);
        const convo = await createConvoWithTimestamps(i, updatedAt, updatedAt);
        convos.push(convo);
      }

      // The 26th conversation (index 25) should be on page 2
      const item26 = convos[25];

      // Fetch first page with limit 25
      const page1 = await getConvosByCursor('user123', { limit: 25 });

      expect(page1.conversations).toHaveLength(25);
      expect(page1.nextCursor).toBeTruthy();

      // Item 26 should NOT be in page 1
      const page1Ids = page1.conversations.map((c: IConversation) => c.conversationId);
      expect(page1Ids).not.toContain(item26!.conversationId);

      // Fetch second page
      const page2 = await getConvosByCursor('user123', {
        limit: 25,
        cursor: page1.nextCursor,
      });

      // Item 26 MUST be in page 2 (this was the bug - it was being skipped)
      expect(page2.conversations).toHaveLength(1);
      expect(page2.conversations[0].conversationId).toBe(item26!.conversationId);
    });

    it('should sort by updatedAt DESC by default', async () => {
      // Create conversations with different updatedAt times
      // Note: createdAt is older but updatedAt varies
      const convo1 = await createConvoWithTimestamps(
        1,
        new Date('2026-01-01T00:00:00.000Z'), // oldest created
        new Date('2026-01-03T00:00:00.000Z'), // most recently updated
      );

      const convo2 = await createConvoWithTimestamps(
        2,
        new Date('2026-01-02T00:00:00.000Z'), // middle created
        new Date('2026-01-02T00:00:00.000Z'), // middle updated
      );

      const convo3 = await createConvoWithTimestamps(
        3,
        new Date('2026-01-03T00:00:00.000Z'), // newest created
        new Date('2026-01-01T00:00:00.000Z'), // oldest updated
      );

      const result = await getConvosByCursor('user123');

      // Should be sorted by updatedAt DESC (most recent first)
      expect(result?.conversations).toHaveLength(3);
      expect(result?.conversations[0].conversationId).toBe(convo1!.conversationId); // Jan 3 updatedAt
      expect(result?.conversations[1].conversationId).toBe(convo2!.conversationId); // Jan 2 updatedAt
      expect(result?.conversations[2].conversationId).toBe(convo3!.conversationId); // Jan 1 updatedAt
    });

    it('should handle conversations with same updatedAt (tie-breaker)', async () => {
      const sameTime = new Date('2026-01-01T12:00:00.000Z');

      // Create 3 conversations with exact same updatedAt
      const convo1 = await createConvoWithTimestamps(1, sameTime, sameTime);
      const convo2 = await createConvoWithTimestamps(2, sameTime, sameTime);
      const convo3 = await createConvoWithTimestamps(3, sameTime, sameTime);

      const result = await getConvosByCursor('user123');

      // All 3 should be returned (no skipping due to same timestamps)
      expect(result?.conversations).toHaveLength(3);

      const returnedIds = result?.conversations.map((c: IConversation) => c.conversationId);
      expect(returnedIds).toContain(convo1!.conversationId);
      expect(returnedIds).toContain(convo2!.conversationId);
      expect(returnedIds).toContain(convo3!.conversationId);
    });

    it('should handle cursor pagination with conversations updated during pagination', async () => {
      // Simulate the scenario where a conversation is updated between page fetches
      const baseTime = new Date('2026-01-01T00:00:00.000Z');

      // Create 30 conversations
      for (let i = 0; i < 30; i++) {
        const updatedAt = new Date(baseTime.getTime() - i * 60000);
        await createConvoWithTimestamps(i, updatedAt, updatedAt);
      }

      // Fetch first page
      const page1 = await getConvosByCursor('user123', { limit: 25 });
      expect(page1.conversations).toHaveLength(25);

      // Now update one of the conversations that should be on page 2
      // to have a newer updatedAt (simulating user activity during pagination)
      const convosOnPage2 = await Conversation.find({ user: 'user123' })
        .sort({ updatedAt: -1 })
        .skip(25)
        .limit(5);

      if (convosOnPage2.length > 0) {
        const updatedConvo = convosOnPage2[0];
        await Conversation.updateOne(
          { _id: updatedConvo._id },
          { updatedAt: new Date('2026-01-02T00:00:00.000Z') }, // Much newer
        );
      }

      // Fetch second page with original cursor
      const page2 = await getConvosByCursor('user123', {
        limit: 25,
        cursor: page1.nextCursor,
      });

      // The updated conversation might not be in page 2 anymore
      // (it moved to the front), but we should still get remaining items
      // without errors and without infinite loops
      expect(page2.conversations.length).toBeGreaterThanOrEqual(0);
    });

    it('should correctly decode and use cursor for pagination', async () => {
      const baseTime = new Date('2026-01-01T00:00:00.000Z');

      // Create 30 conversations
      for (let i = 0; i < 30; i++) {
        const updatedAt = new Date(baseTime.getTime() - i * 60000);
        await createConvoWithTimestamps(i, updatedAt, updatedAt);
      }

      // Fetch first page
      const page1 = await getConvosByCursor('user123', { limit: 25 });

      // Decode the cursor to verify it's based on the last RETURNED item
      const decodedCursor = JSON.parse(
        Buffer.from(page1.nextCursor as string, 'base64').toString(),
      );

      // The cursor should match the last item in page1 (item at index 24)
      const lastReturnedItem = page1.conversations[24] as IConversation;

      expect(new Date(decodedCursor.primary).getTime()).toBe(
        new Date(lastReturnedItem.updatedAt ?? 0).getTime(),
      );
    });

    it('should support sortBy createdAt when explicitly requested', async () => {
      // Create conversations with different timestamps
      const convo1 = await createConvoWithTimestamps(
        1,
        new Date('2026-01-03T00:00:00.000Z'), // newest created
        new Date('2026-01-01T00:00:00.000Z'), // oldest updated
      );

      const convo2 = await createConvoWithTimestamps(
        2,
        new Date('2026-01-01T00:00:00.000Z'), // oldest created
        new Date('2026-01-03T00:00:00.000Z'), // newest updated
      );

      // Verify timestamps were set correctly
      expect(new Date(convo1!.createdAt ?? 0).getTime()).toBe(
        new Date('2026-01-03T00:00:00.000Z').getTime(),
      );
      expect(new Date(convo2!.createdAt ?? 0).getTime()).toBe(
        new Date('2026-01-01T00:00:00.000Z').getTime(),
      );

      const result = await getConvosByCursor('user123', { sortBy: 'createdAt' });

      // Should be sorted by createdAt DESC
      expect(result?.conversations).toHaveLength(2);
      expect(result?.conversations[0].conversationId).toBe(convo1!.conversationId); // Jan 3 createdAt
      expect(result?.conversations[1].conversationId).toBe(convo2!.conversationId); // Jan 1 createdAt
    });

    it('should handle empty result set gracefully', async () => {
      const result = await getConvosByCursor('user123');

      expect(result?.conversations).toHaveLength(0);
      expect(result?.nextCursor).toBeNull();
    });

    it('should handle exactly limit number of conversations (no next page)', async () => {
      const baseTime = new Date('2026-01-01T00:00:00.000Z');

      // Create exactly 25 conversations (equal to default limit)
      for (let i = 0; i < 25; i++) {
        const updatedAt = new Date(baseTime.getTime() - i * 60000);
        await createConvoWithTimestamps(i, updatedAt, updatedAt);
      }

      const result = await getConvosByCursor('user123', { limit: 25 });

      expect(result?.conversations).toHaveLength(25);
      expect(result?.nextCursor).toBeNull(); // No next page
    });
  });

  describe('getConvosByCursor archivedAt sorting', () => {
    const insertArchived = async (title: string, archivedAt: Date | null, updatedAt: Date) => {
      const conversationId = uuidv4();
      await Conversation.collection.insertOne({
        conversationId,
        user: 'user123',
        title,
        endpoint: EModelEndpoint.openAI,
        expiredAt: null,
        isArchived: true,
        createdAt: updatedAt,
        updatedAt,
        ...(archivedAt === null ? {} : { archivedAt }),
      });
      return conversationId;
    };

    it('accepts archivedAt as a sort field', async () => {
      const base = new Date('2026-06-01T00:00:00.000Z');
      const older = await insertArchived('older', new Date(base.getTime() - 60000), base);
      const newer = await insertArchived('newer', new Date(base.getTime() + 60000), base);

      const result = await getConvosByCursor('user123', {
        isArchived: true,
        sortBy: 'archivedAt',
        sortDirection: 'desc',
      });

      expect(result.conversations.map((convo) => convo.conversationId)).toEqual([newer, older]);
    });

    /* Everything archived before the field existed has no stamp, so the missing-value
       group is the common case here, not an edge case. A cursor that collapsed a null
       stamp to the epoch would restart paging from 1970 and replay the whole archive. */
    it('pages across stamped and unstamped chats without repeating or dropping any', async () => {
      const base = new Date('2026-06-01T00:00:00.000Z');
      const expected = new Set<string>();
      for (let index = 0; index < 4; index++) {
        expected.add(
          await insertArchived(`stamped ${index}`, new Date(base.getTime() + index * 60000), base),
        );
      }
      for (let index = 0; index < 4; index++) {
        expected.add(
          await insertArchived(`legacy ${index}`, null, new Date(base.getTime() + index * 60000)),
        );
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const result = await getConvosByCursor('user123', {
          isArchived: true,
          sortBy: 'archivedAt',
          sortDirection: 'desc',
          limit: 3,
          cursor,
        });
        seen.push(...result.conversations.map((convo) => convo.conversationId));
        cursor = result.nextCursor;
        if (!cursor) {
          break;
        }
      }

      expect(new Set(seen)).toEqual(expected);
      expect(seen.length).toBe(expected.size);
    });

    it('orders unstamped chats last when sorting newest first', async () => {
      const base = new Date('2026-06-01T00:00:00.000Z');
      const stamped = await insertArchived('stamped', base, base);
      const legacy = await insertArchived('legacy', null, base);

      const result = await getConvosByCursor('user123', {
        isArchived: true,
        sortBy: 'archivedAt',
        sortDirection: 'desc',
      });

      expect(result.conversations.map((convo) => convo.conversationId)).toEqual([stamped, legacy]);
    });

    /** Ascending takes the other null branch: the unstamped group comes first and the
     * page that leaves it has to pick up every stamped chat behind it. */
    it('pages across stamped and unstamped chats when sorting oldest first', async () => {
      const base = new Date('2026-06-01T00:00:00.000Z');
      const expected = new Set<string>();
      for (let index = 0; index < 3; index++) {
        expected.add(
          await insertArchived(`stamped ${index}`, new Date(base.getTime() + index * 60000), base),
        );
      }
      for (let index = 0; index < 3; index++) {
        expected.add(
          await insertArchived(`legacy ${index}`, null, new Date(base.getTime() + index * 60000)),
        );
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const result = await getConvosByCursor('user123', {
          isArchived: true,
          sortBy: 'archivedAt',
          sortDirection: 'asc',
          limit: 2,
          cursor,
        });
        seen.push(...result.conversations.map((convo) => convo.conversationId));
        cursor = result.nextCursor;
        if (!cursor) {
          break;
        }
      }

      expect(new Set(seen)).toEqual(expected);
      expect(seen.length).toBe(expected.size);
    });

    /** The cell renders `archivedAt ?? createdAt`, so the legacy group has to come back
     * in that same createdAt order; ordering it by last activity read out of order. */
    it('orders the legacy group by the createdAt it displays, not last activity', async () => {
      const base = new Date('2026-06-01T00:00:00.000Z');
      const olderCreated = uuidv4();
      const newerCreated = uuidv4();
      /* createdAt and updatedAt deliberately disagree: ordering by activity would
         invert these two relative to the dates the dialog shows. */
      await Conversation.collection.insertOne({
        conversationId: olderCreated,
        user: 'user123',
        title: 'created first, touched last',
        endpoint: EModelEndpoint.openAI,
        expiredAt: null,
        isArchived: true,
        createdAt: new Date(base.getTime() - 60000),
        updatedAt: new Date(base.getTime() + 60000),
      });
      await Conversation.collection.insertOne({
        conversationId: newerCreated,
        user: 'user123',
        title: 'created last, touched first',
        endpoint: EModelEndpoint.openAI,
        expiredAt: null,
        isArchived: true,
        createdAt: new Date(base.getTime() + 60000),
        updatedAt: new Date(base.getTime() - 60000),
      });

      const result = await getConvosByCursor('user123', {
        isArchived: true,
        sortBy: 'archivedAt',
        sortDirection: 'desc',
      });

      expect(result.conversations.map((convo) => convo.conversationId)).toEqual([
        newerCreated,
        olderCreated,
      ]);
    });

    it('still rejects a sort field that is not allowed', async () => {
      await expect(getConvosByCursor('user123', { sortBy: 'pinned' })).rejects.toThrow(
        /Invalid sortBy field/,
      );
    });
  });

  describe('getConvosByCursor pinned filter', () => {
    const insertConvo = async ({
      user = 'user123',
      title,
      updatedAt,
      pinned,
      isArchived = false,
    }: {
      user?: string;
      title: string;
      updatedAt: Date;
      pinned?: boolean;
      isArchived?: boolean;
    }) => {
      const conversationId = uuidv4();
      await Conversation.collection.insertOne({
        conversationId,
        user,
        title,
        endpoint: EModelEndpoint.openAI,
        expiredAt: null,
        isArchived,
        createdAt: updatedAt,
        updatedAt,
        ...(pinned === undefined ? {} : { pinned }),
      });
      return conversationId;
    };

    it('returns only pinned conversations when pinned is requested', async () => {
      const baseTime = new Date('2026-05-01T00:00:00.000Z');
      const pinnedId = await insertConvo({
        title: 'Pinned chat',
        updatedAt: baseTime,
        pinned: true,
      });
      await insertConvo({ title: 'Unpinned chat', updatedAt: baseTime, pinned: false });
      await insertConvo({ title: 'Never pinned chat', updatedAt: baseTime });

      const result = await getConvosByCursor('user123', { pinned: true });

      expect(result.conversations.map((convo) => convo.conversationId)).toEqual([pinnedId]);
    });

    /** The sidebar's pinned section used to filter the paginated chats list, so a pin
     * older than the first page stayed hidden until that list scrolled far enough. */
    it('returns a pin that falls outside the first page of the unfiltered list', async () => {
      const baseTime = new Date('2026-05-01T00:00:00.000Z');
      const pinnedId = await insertConvo({
        title: 'Initial Greeting',
        updatedAt: baseTime,
        pinned: true,
      });
      for (let index = 0; index < 30; index++) {
        await insertConvo({
          title: `Newer chat ${index}`,
          updatedAt: new Date(baseTime.getTime() + (index + 1) * 60000),
        });
      }

      const firstPage = await getConvosByCursor('user123', { limit: 25 });
      expect(firstPage.conversations.map((convo) => convo.conversationId)).not.toContain(pinnedId);

      const pinnedResult = await getConvosByCursor('user123', { pinned: true });
      expect(pinnedResult.conversations.map((convo) => convo.conversationId)).toEqual([pinnedId]);
    });

    it('excludes archived pins and other users’ pins', async () => {
      const baseTime = new Date('2026-05-01T00:00:00.000Z');
      const visibleId = await insertConvo({
        title: 'Visible pin',
        updatedAt: baseTime,
        pinned: true,
      });
      await insertConvo({
        title: 'Archived pin',
        updatedAt: baseTime,
        pinned: true,
        isArchived: true,
      });
      await insertConvo({
        user: 'other-user',
        title: 'Someone else’s pin',
        updatedAt: baseTime,
        pinned: true,
      });

      const result = await getConvosByCursor('user123', { pinned: true });

      expect(result.conversations.map((convo) => convo.conversationId)).toEqual([visibleId]);
    });

    it('leaves the list unfiltered when pinned is not requested', async () => {
      const baseTime = new Date('2026-05-01T00:00:00.000Z');
      await insertConvo({ title: 'Pinned chat', updatedAt: baseTime, pinned: true });
      await insertConvo({ title: 'Unpinned chat', updatedAt: baseTime });

      const result = await getConvosByCursor('user123', {});

      expect(result.conversations).toHaveLength(2);
    });
  });

  describe('getConvosByCursor page size bounds', () => {
    const TOTAL = 105;
    const user = 'page-size-user';

    beforeEach(async () => {
      const baseTime = new Date('2026-06-01T00:00:00.000Z').getTime();
      await Conversation.collection.insertMany(
        Array.from({ length: TOTAL }, (_, index) => ({
          conversationId: uuidv4(),
          user,
          title: `Conversation ${index}`,
          endpoint: EModelEndpoint.openAI,
          expiredAt: null,
          isArchived: false,
          createdAt: new Date(baseTime + index * 1000),
          updatedAt: new Date(baseTime + index * 1000),
        })),
      );
    });

    afterEach(async () => {
      await Conversation.deleteMany({ user });
    });

    /** `.limit(limit + 1)` turned a -1 page size into `.limit(0)`, which MongoDB reads as
     * "no limit" — the query returned the caller's entire collection in one response. */
    it.each([
      ['negative', -1],
      ['zero', 0],
      ['oversized', 999999999],
    ])('bounds a %s page size', async (_label, limit) => {
      const result = await getConvosByCursor(user, { limit });

      expect(result.conversations.length).toBeLessThanOrEqual(100);
      expect(result.conversations.length).toBeGreaterThan(0);
      expect(result.nextCursor).not.toBeNull();
    });

    it('caps an oversized page size at the ceiling and still pages the remainder', async () => {
      const first = await getConvosByCursor(user, { limit: Number.MAX_SAFE_INTEGER });

      expect(first.conversations).toHaveLength(100);
      expect(first.nextCursor).not.toBeNull();

      const second = await getConvosByCursor(user, {
        limit: Number.MAX_SAFE_INTEGER,
        cursor: first.nextCursor,
      });

      expect(second.conversations).toHaveLength(TOTAL - 100);
      expect(second.nextCursor).toBeNull();

      const ids = new Set(
        [...first.conversations, ...second.conversations].map((convo) => convo.conversationId),
      );
      expect(ids.size).toBe(TOTAL);
    });

    it('serves a page size inside the range unchanged', async () => {
      const result = await getConvosByCursor(user, { limit: 10 });

      expect(result.conversations).toHaveLength(10);
      expect(result.nextCursor).not.toBeNull();
    });
  });

  describe('subagent thread leases', () => {
    it('reserves child lineage once without overwriting a concurrent winner', async () => {
      await Conversation.init();
      const conversationId = uuidv4();
      const lineage = {
        rootConversationId: 'root',
        parentConversationId: 'parent',
        parentMessageId: 'parent-message',
        parentToolCallId: 'parent-tool',
        parentAgentId: 'parent-agent',
        subagentType: 'researcher',
        subagentKind: 'agent' as const,
        depth: 1,
      };
      const reservations = await Promise.all(
        ['First title', 'Second title'].map((title) =>
          methods.reserveSubagentThread({
            user: 'reservation-user',
            conversationId,
            conversation: { endpoint: EModelEndpoint.agents, title, subagentThread: lineage },
          }),
        ),
      );

      expect(reservations.filter((reservation) => reservation.created)).toHaveLength(1);
      const saved = await methods.getConvo('reservation-user', conversationId);
      expect(saved?.title).toBe(
        reservations.find((reservation) => reservation.created)?.conversation.title,
      );
      expect(saved?.subagentThread).toEqual(lineage);
    });

    it('reads a child only through its exact parent and tenant with the private lease', async () => {
      const parentConversationId = uuidv4();
      const conversationId = uuidv4();
      await Conversation.create([
        {
          conversationId: parentConversationId,
          user: 'view-user',
          tenantId: 'tenant-a',
          endpoint: EModelEndpoint.agents,
        },
        {
          conversationId,
          user: 'view-user',
          tenantId: 'tenant-a',
          endpoint: EModelEndpoint.agents,
          subagentThread: {
            rootConversationId: parentConversationId,
            parentConversationId,
            parentMessageId: 'parent-message',
            parentToolCallId: 'parent-tool',
            subagentType: 'researcher',
            subagentKind: 'agent',
            depth: 1,
          },
          subagentThreadLease: {
            token: 'private-token',
            taskId: 'task-1',
            expiresAt: new Date('2099-08-21T12:00:00.000Z'),
          },
        },
      ]);

      await expect(
        methods.getSubagentThreadForParent({
          user: 'view-user',
          parentConversationId,
          conversationId,
          tenantId: 'tenant-a',
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          conversationId,
          subagentThreadLease: expect.objectContaining({ taskId: 'task-1' }),
        }),
      );
      await expect(
        methods.getSubagentThreadForParent({
          user: 'view-user',
          parentConversationId: 'another-parent',
          conversationId,
          tenantId: 'tenant-a',
        }),
      ).resolves.toBeNull();
      await expect(
        methods.getSubagentThreadForParent({
          user: 'view-user',
          parentConversationId,
          conversationId,
          tenantId: 'tenant-b',
        }),
      ).resolves.toBeNull();
      expect(await methods.getConvo('view-user', conversationId)).not.toHaveProperty(
        'subagentThreadLease',
      );
    });

    it('lists bounded child metadata while collapsing private event bindings to actor identity', async () => {
      const parentConversationId = uuidv4();
      const eventThreadId = uuidv4();
      const toolThreadId = uuidv4();
      const lineage = (parentToolCallId: string) => ({
        rootConversationId: parentConversationId,
        parentConversationId,
        parentMessageId: 'parent-message',
        parentToolCallId,
        subagentType: 'researcher',
        subagentKind: 'agent' as const,
        depth: 1,
      });
      await Conversation.create([
        {
          conversationId: eventThreadId,
          user: 'index-user',
          tenantId: 'tenant-a',
          endpoint: EModelEndpoint.agents,
          agent_id: 'agent-event',
          subagentThread: lineage('event-binding:private'),
          subagentThreadLease: {
            token: 'private-token',
            taskId: 'task-live',
            expiresAt: new Date('2099-08-21T12:00:00.000Z'),
          },
          agentEventBinding: {
            bindingId: `evtbind_${'b'.repeat(48)}`,
            sourceKeyId: 'private-key',
            actorId: 'actor-a',
          },
        },
        {
          conversationId: toolThreadId,
          user: 'index-user',
          tenantId: 'tenant-a',
          endpoint: EModelEndpoint.agents,
          subagentThread: lineage('tool-call-a'),
        },
        {
          conversationId: uuidv4(),
          user: 'index-user',
          tenantId: 'tenant-b',
          endpoint: EModelEndpoint.agents,
          subagentThread: lineage('wrong-tenant'),
        },
        {
          conversationId: uuidv4(),
          user: 'different-user',
          tenantId: 'tenant-a',
          endpoint: EModelEndpoint.agents,
          subagentThread: lineage('wrong-user'),
        },
        {
          conversationId: uuidv4(),
          user: 'index-user',
          tenantId: 'tenant-a',
          endpoint: EModelEndpoint.agents,
          subagentThread: {
            ...lineage('wrong-parent'),
            parentConversationId: uuidv4(),
          },
        },
      ]);

      const records = await methods.listSubagentThreadsForParent({
        user: 'index-user',
        tenantId: 'tenant-a',
        parentConversationId,
        limit: 10,
      });

      expect(records.map((record) => record.conversationId).sort()).toEqual(
        [eventThreadId, toolThreadId].sort(),
      );
      expect(records.find((record) => record.conversationId === eventThreadId)).toEqual(
        expect.objectContaining({
          actorId: 'actor-a',
          subagentThreadLease: expect.objectContaining({ taskId: 'task-live' }),
        }),
      );
      expect(records).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ agentEventBinding: expect.anything() })]),
      );
      expect(JSON.stringify(records)).not.toContain('private-key');
      expect(JSON.stringify(records)).not.toContain(`evtbind_${'b'.repeat(48)}`);
    });

    it('hides retention-expired children before TTL cleanup', async () => {
      const parentConversationId = uuidv4();
      const expiredThreadId = uuidv4();
      await Conversation.create({
        conversationId: expiredThreadId,
        user: 'expired-child-user',
        endpoint: EModelEndpoint.agents,
        expiredAt: new Date(Date.now() - 60_000),
        subagentThread: {
          rootConversationId: parentConversationId,
          parentConversationId,
          parentMessageId: 'parent-message',
          parentToolCallId: 'parent-tool',
          subagentType: 'researcher',
          subagentKind: 'agent',
          depth: 1,
        },
      });

      await expect(
        methods.getSubagentThreadForParent({
          user: 'expired-child-user',
          parentConversationId,
          conversationId: expiredThreadId,
        }),
      ).resolves.toBeNull();
      await expect(
        methods.listSubagentThreadsForParent({
          user: 'expired-child-user',
          parentConversationId,
          limit: 10,
        }),
      ).resolves.toEqual([]);
    });

    it('keeps an older child with a live lease inside the bounded parent index', async () => {
      const parentConversationId = uuidv4();
      const activeThreadId = uuidv4();
      const recentThreadId = uuidv4();
      const lineage = (parentToolCallId: string) => ({
        rootConversationId: parentConversationId,
        parentConversationId,
        parentMessageId: 'parent-message',
        parentToolCallId,
        subagentType: 'researcher',
        subagentKind: 'agent' as const,
        depth: 1,
      });
      await Conversation.create([
        {
          conversationId: activeThreadId,
          user: 'active-index-user',
          endpoint: EModelEndpoint.agents,
          subagentThread: lineage('active-tool'),
        },
        {
          conversationId: recentThreadId,
          user: 'active-index-user',
          endpoint: EModelEndpoint.agents,
          subagentThread: lineage('recent-tool'),
        },
      ]);
      await Conversation.updateOne(
        { conversationId: activeThreadId },
        { $set: { updatedAt: new Date('2026-08-20T10:00:00.000Z') } },
        { timestamps: false },
      );
      await Conversation.updateOne(
        { conversationId: recentThreadId },
        { $set: { updatedAt: new Date('2026-08-21T10:00:00.000Z') } },
        { timestamps: false },
      );
      await methods.acquireSubagentThreadLease({
        user: 'active-index-user',
        conversationId: activeThreadId,
        token: 'private-token',
        taskId: 'active-task',
        now: new Date('2026-08-22T10:00:00.000Z'),
        expiresAt: new Date('2026-08-22T10:00:30.000Z'),
      });

      const records = await methods.listSubagentThreadsForParent({
        user: 'active-index-user',
        parentConversationId,
        limit: 1,
      });

      expect(records).toEqual([
        expect.objectContaining({
          conversationId: activeThreadId,
          subagentThreadLease: expect.objectContaining({ taskId: 'active-task' }),
        }),
      ]);
    });

    it('resolves an event binding only through its owner, tenant, and API key', async () => {
      const conversationId = uuidv4();
      const bindingId = `evtbind_${'a'.repeat(48)}`;
      await Conversation.create({
        conversationId,
        user: 'binding-user',
        tenantId: 'tenant-a',
        endpoint: EModelEndpoint.agents,
        agent_id: 'agent-player',
        agentEventBinding: { bindingId, sourceKeyId: 'key-a', actorId: 'player-a' },
        subagentThread: {
          rootConversationId: 'parent',
          parentConversationId: 'parent',
          parentMessageId: 'parent-message',
          parentToolCallId: 'event-binding',
          parentAgentId: 'agent-director',
          subagentType: 'agent-player',
          subagentKind: 'agent',
          depth: 1,
        },
      });

      await expect(
        methods.getAgentEventBinding({
          user: 'binding-user',
          tenantId: 'tenant-a',
          bindingId,
          sourceKeyId: 'key-a',
        }),
      ).resolves.toMatchObject({
        conversationId,
        agentId: 'agent-player',
        binding: { bindingId, sourceKeyId: 'key-a', actorId: 'player-a' },
      });
      await expect(
        methods.getAgentEventBinding({
          user: 'binding-user',
          tenantId: 'tenant-a',
          bindingId,
          sourceKeyId: 'key-b',
        }),
      ).resolves.toBeNull();
      await expect(
        methods.getAgentEventBinding({
          user: 'binding-user',
          tenantId: 'tenant-b',
          bindingId,
          sourceKeyId: 'key-a',
        }),
      ).resolves.toBeNull();
      await Conversation.updateOne({ conversationId }, { expiredAt: new Date(0) });
      await expect(
        methods.getAgentEventBinding({
          user: 'binding-user',
          tenantId: 'tenant-a',
          bindingId,
          sourceKeyId: 'key-a',
        }),
      ).resolves.toBeNull();
      expect(await methods.getConvo('binding-user', conversationId)).not.toHaveProperty(
        'agentEventBinding',
      );
    });

    it.each(['owned', 'legacy'])(
      'serializes %s suspension ownership through claim, re-pause, and resumed commit',
      async (storage) => {
        const conversationId = uuidv4();
        const owner = {
          user: 'suspended-actor-user',
          tenantId: 'tenant-a',
          conversationId,
        };
        await Conversation.create({
          conversationId,
          user: owner.user,
          tenantId: owner.tenantId,
          endpoint: EModelEndpoint.agents,
          agent_id: 'agent-player',
          agentEventBinding: {
            bindingId: `evtbind_${'s'.repeat(48)}`,
            sourceKeyId: 'key-a',
            actorId: 'player-a',
          },
          subagentThread: {
            rootConversationId: 'parent',
            parentConversationId: 'parent',
            parentMessageId: 'parent-message',
            parentToolCallId: 'event-binding',
            parentAgentId: 'agent-director',
            subagentType: 'agent-player',
            subagentKind: 'agent',
            depth: 1,
          },
        });
        const checkpoint = (suffix: string) => ({
          threadId: conversationId,
          checkpointId: `checkpoint-${suffix}`,
          checkpointNs: `event-actor/${suffix}`,
        });
        const suspension = (
          suffix: string,
          attempt: number,
        ): IAgentEventActorSuspensionEvidence => ({
          version: 1,
          suspensionId: `suspension-${suffix}`,
          attempt,
          issuedAt: 1_000 + attempt,
          expiresAt: 100_000 + attempt,
          invocation: {
            actorThreadId: conversationId,
            invocationId: 'event-pause',
            depth: 1,
            continuation: 'cold',
            base: { actorThreadId: conversationId, generation: 0 },
            fork: { ...checkpoint('fork'), invocationId: 'event-pause' },
          },
          checkpoint: {
            ...checkpoint('fork'),
            checkpointId: `checkpoint-${suffix}`,
            invocationId: 'event-pause',
          },
          interrupt: {
            id: `interrupt-${suffix}`,
            payload: { type: 'ask_user_question', actionId: `action-${suffix}` },
          },
          suspensionDigest: `digest-${suffix}`,
        });

        await expect(
          methods.recordAgentEventActorReconciliation({
            ...owner,
            reconciliation: {
              invocationId: 'event-pause',
              actionAdmitted: true,
              status: 'invocation_pending',
              checkpoint: checkpoint('fork'),
              action: { toolName: 'submit_move' },
              observedAt: new Date(),
            },
          }),
        ).resolves.toBe(true);
        const first = suspension('first', 0);
        await expect(
          methods.storeAgentEventActorSuspension({
            ...owner,
            suspension: {
              ...first,
              interrupt: {
                ...first.interrupt,
                payload: { type: 'ask_user_question', question: 'x'.repeat(65 * 1_024) },
              },
            },
            actionId: 'action-oversized',
            jobCreatedAt: 123,
          }),
        ).rejects.toThrow('Event actor suspension exceeds maximum payload size');
        await expect(
          methods.storeAgentEventActorSuspension({
            ...owner,
            suspension: first,
            actionId: 'action-first',
            jobCreatedAt: 123,
          }),
        ).resolves.toEqual({ status: 'stored' });
        await expect(methods.getAgentEventActorSnapshot(owner)).resolves.toMatchObject({
          suspension: { kind: 'human_decision' },
        });
        await expect(
          methods.storeAgentEventActorSuspension({
            ...owner,
            suspension: { ...first, suspensionId: 'competing-suspension' },
            actionId: 'action-first',
            jobCreatedAt: 123,
          }),
        ).resolves.toEqual({ status: 'stale' });

        expect(
          (await Conversation.collection.findOne({ conversationId }))?.agentEventActorSuspension
            .status,
        ).toBe('pending_owned');
        const oldClaim = await Conversation.collection.updateOne(
          { conversationId, user: owner.user, 'agentEventActorSuspension.status': 'pending' },
          { $set: { 'agentEventActorSuspension.status': 'claimed' } },
        );
        expect(oldClaim.matchedCount).toBe(0);
        if (storage === 'legacy') {
          await Conversation.collection.updateOne(
            { conversationId },
            { $set: { 'agentEventActorSuspension.status': 'pending' } },
          );
        }

        const claim = {
          ...owner,
          suspensionId: first.suspensionId,
          attempt: first.attempt,
          actionId: 'action-first',
          jobCreatedAt: 123,
          resumeAttemptId: 'resume-one',
        };
        const claims = await Promise.all([
          methods.claimAgentEventActorSuspension(claim),
          methods.claimAgentEventActorSuspension({ ...claim, resumeAttemptId: 'resume-two' }),
        ]);
        expect(claims).toEqual(
          expect.arrayContaining([{ status: 'claimed' }, { status: 'stale' }]),
        );
        const winningResumeAttemptId = claims[0].status === 'claimed' ? 'resume-one' : 'resume-two';
        expect(
          (await Conversation.collection.findOne({ conversationId }))?.agentEventActorSuspension
            .status,
        ).toBe('claimed_owned');
        expect(
          (
            await Conversation.collection.updateOne(
              { conversationId, user: owner.user, 'agentEventActorSuspension.status': 'claimed' },
              { $set: { 'agentEventActorSuspension.status': 'closed' } },
            )
          ).matchedCount,
        ).toBe(0);

        const second = suspension('second', 1);
        await expect(
          methods.storeAgentEventActorSuspension({
            ...owner,
            suspension: second,
            kind: 'internal_completion',
            actionId: 'action-second',
            jobCreatedAt: 123,
            previous: {
              suspensionId: first.suspensionId,
              attempt: first.attempt,
              resumeAttemptId: winningResumeAttemptId,
            },
          }),
        ).resolves.toEqual({ status: 'stored' });
        await expect(methods.getAgentEventActorSnapshot(owner)).resolves.toMatchObject({
          suspension: {
            kind: 'internal_completion',
            suspension: { suspensionId: second.suspensionId },
          },
        });
        await expect(
          methods.claimAgentEventActorSuspension({
            ...owner,
            suspensionId: second.suspensionId,
            attempt: second.attempt,
            actionId: 'action-second',
            jobCreatedAt: 123,
            resumeAttemptId: 'resume-three',
          }),
        ).resolves.toEqual({ status: 'claimed' });

        await expect(
          methods.commitAgentEventActorState({
            ...owner,
            invocationId: 'event-pause',
            expectedEpoch: 0,
            action: { toolName: 'submit_move' },
            checkpoint: checkpoint('committed'),
            settlementAuthority: {
              suspensionId: second.suspensionId,
              attempt: second.attempt,
              resumeAttemptId: 'resume-three',
            },
          }),
        ).resolves.toMatchObject({ status: 'committed' });
        await expect(methods.getAgentEventActorSnapshot(owner)).resolves.toMatchObject({
          suspension: {
            status: 'closed',
            outcome: 'committed',
            resumeAttemptId: 'resume-three',
          },
          state: { generation: 1, checkpoint: checkpoint('committed') },
        });
        await expect(
          methods.recordAgentEventActorReconciliation({
            ...owner,
            reconciliation: {
              invocationId: 'event-pause',
              actionAdmitted: true,
              status: 'history_persisted',
              checkpoint: checkpoint('committed'),
              action: { toolName: 'submit_move' },
              observedAt: new Date(),
            },
          }),
        ).resolves.toBe(true);
        await expect(
          methods.resolveAgentEventActorReconciliation({
            ...owner,
            invocationId: 'event-pause',
            checkpoint: checkpoint('committed'),
            resolution: 'checkpoint_verified',
          }),
        ).resolves.toBe(true);

        const cancellationCheckpoint = checkpoint('cancel');
        const cancellationSuspension: IAgentEventActorSuspensionEvidence = {
          ...suspension('cancel', 0),
          invocation: {
            ...suspension('cancel', 0).invocation,
            invocationId: 'event-cancel',
            fork: {
              ...cancellationCheckpoint,
              invocationId: 'event-cancel',
            },
          },
          checkpoint: {
            ...cancellationCheckpoint,
            invocationId: 'event-cancel',
          },
        };
        await expect(
          methods.recordAgentEventActorReconciliation({
            ...owner,
            reconciliation: {
              invocationId: 'event-cancel',
              status: 'invocation_pending',
              checkpoint: cancellationCheckpoint,
              action: { toolName: 'submit_move' },
              observedAt: new Date(),
            },
          }),
        ).resolves.toBe(true);
        await expect(
          methods.storeAgentEventActorSuspension({
            ...owner,
            suspension: cancellationSuspension,
            actionId: 'action-cancel',
            jobCreatedAt: 124,
          }),
        ).resolves.toEqual({ status: 'stored' });
        const [resumeRace, cancelRace] = await Promise.all([
          methods.claimAgentEventActorSuspension({
            ...owner,
            suspensionId: cancellationSuspension.suspensionId,
            attempt: 0,
            actionId: 'action-cancel',
            jobCreatedAt: 124,
            resumeAttemptId: 'resume-race',
          }),
          methods.cancelAgentEventActorSuspension({
            ...owner,
            suspensionId: cancellationSuspension.suspensionId,
            attempt: 0,
            invocationId: 'event-cancel',
            checkpoint: cancellationCheckpoint,
          }),
        ]);
        const raceStatuses = [resumeRace.status, cancelRace.status];
        expect(raceStatuses.filter((status) => status === 'stale')).toHaveLength(1);
        expect(raceStatuses).toEqual(
          expect.arrayContaining([expect.stringMatching(/^(claimed|cancelled)$/), 'stale']),
        );
        if (resumeRace.status === 'claimed') {
          await expect(
            methods.cancelAgentEventActorSuspension({
              ...owner,
              suspensionId: cancellationSuspension.suspensionId,
              attempt: 0,
              invocationId: 'event-cancel',
              checkpoint: cancellationCheckpoint,
              claimedResumeAttemptId: 'resume-race',
            }),
          ).resolves.toEqual({ status: 'cancelled' });
        }
        await expect(methods.getAgentEventActorSnapshot(owner)).resolves.toMatchObject({
          suspension: { status: 'closed', outcome: 'cancelled' },
        });
      },
    );

    it('closes a resumed suspension when the actor-head commit is stale', async () => {
      const conversationId = uuidv4();
      const owner = { user: 'stale-resume-user', tenantId: 'tenant-a', conversationId };
      const baseCheckpoint = {
        threadId: conversationId,
        checkpointId: 'checkpoint-base',
        checkpointNs: 'event-actor/base',
      };
      const baseState = { generation: 1, checkpoint: baseCheckpoint };
      const evidence: IAgentEventActorSuspensionEvidence = {
        version: 1,
        suspensionId: 'suspension-stale',
        attempt: 0,
        issuedAt: 1_000,
        expiresAt: 100_000,
        invocation: {
          actorThreadId: conversationId,
          invocationId: 'event-stale',
          depth: 1,
          continuation: 'warm',
          base: { actorThreadId: conversationId, ...baseState },
          fork: { ...baseCheckpoint, invocationId: 'event-stale' },
        },
        checkpoint: {
          ...baseCheckpoint,
          checkpointId: 'checkpoint-paused',
          invocationId: 'event-stale',
        },
        interrupt: { id: 'interrupt-stale', payload: { type: 'tool_approval' } },
        suspensionDigest: 'digest-stale',
      };
      await Conversation.create({
        conversationId,
        user: owner.user,
        tenantId: owner.tenantId,
        endpoint: EModelEndpoint.agents,
        agent_id: 'agent-player',
        agentEventBinding: {
          bindingId: `evtbind_${'t'.repeat(48)}`,
          sourceKeyId: 'key-a',
          actorId: 'player-a',
        },
        subagentThread: {
          rootConversationId: 'parent',
          parentConversationId: 'parent',
          parentMessageId: 'parent-message',
          parentToolCallId: 'event-binding',
          subagentType: 'agent-player',
          subagentKind: 'agent',
          depth: 1,
        },
        agentEventActor: baseState,
        agentEventActorReconciliations: [
          {
            invocationId: 'event-stale',
            actionAdmitted: true,
            status: 'invocation_pending',
            checkpoint: baseCheckpoint,
            action: { toolName: 'submit_move' },
            observedAt: new Date(),
          },
        ],
      });
      await expect(
        methods.storeAgentEventActorSuspension({
          ...owner,
          suspension: evidence,
          actionId: 'action-stale',
          jobCreatedAt: 456,
          invalidateHead: true,
        }),
      ).resolves.toEqual({ status: 'stored' });
      await expect(methods.getAgentEventActorSnapshot(owner)).resolves.toMatchObject({
        state: { ...baseState, requiresColdStart: true },
        suspension: { status: 'pending' },
      });
      await expect(
        methods.claimAgentEventActorSuspension({
          ...owner,
          suspensionId: evidence.suspensionId,
          attempt: 0,
          actionId: 'action-stale',
          jobCreatedAt: 456,
          resumeAttemptId: 'resume-stale',
        }),
      ).resolves.toEqual({ status: 'claimed' });
      const competingState = {
        generation: 2,
        checkpoint: {
          threadId: conversationId,
          checkpointId: 'checkpoint-competing',
          checkpointNs: 'event-actor/competing',
        },
      };
      await Conversation.updateOne(
        { conversationId },
        { $set: { agentEventActor: competingState } },
      );

      await expect(
        methods.commitAgentEventActorState({
          ...owner,
          invocationId: 'event-stale',
          expectedEpoch: 0,
          expected: baseState,
          action: { toolName: 'submit_move' },
          checkpoint: {
            threadId: conversationId,
            checkpointId: 'checkpoint-resumed',
            checkpointNs: 'event-actor/base',
          },
          settlementAuthority: {
            suspensionId: evidence.suspensionId,
            attempt: 0,
            resumeAttemptId: 'resume-stale',
          },
        }),
      ).resolves.toEqual({ status: 'stale', state: competingState });
      await expect(methods.getAgentEventActorSnapshot(owner)).resolves.toMatchObject({
        state: competingState,
        suspension: { status: 'closed', outcome: 'stale' },
      });
    });

    it('commits event actor heads with full checkpoint CAS and two-checkpoint retention', async () => {
      const conversationId = uuidv4();
      await Conversation.create({
        conversationId,
        user: 'actor-head-user',
        tenantId: 'tenant-a',
        endpoint: EModelEndpoint.agents,
        agent_id: 'agent-player',
        agentEventBinding: {
          bindingId: `evtbind_${'c'.repeat(48)}`,
          sourceKeyId: 'key-a',
          actorId: 'player-a',
        },
        subagentThread: {
          rootConversationId: 'parent',
          parentConversationId: 'parent',
          parentMessageId: 'parent-message',
          parentToolCallId: 'event-binding',
          parentAgentId: 'agent-director',
          subagentType: 'agent-player',
          subagentKind: 'agent',
          depth: 1,
        },
      });
      const checkpoint = (suffix: string) => ({
        threadId: conversationId,
        checkpointId: `checkpoint-${suffix}`,
        checkpointNs: `event-actor/${suffix}`,
      });
      const beginInvocation = (invocationId: string, actorCheckpoint = checkpoint(invocationId)) =>
        methods.recordAgentEventActorReconciliation({
          user: 'actor-head-user',
          tenantId: 'tenant-a',
          conversationId,
          reconciliation: {
            invocationId,
            status: 'invocation_pending',
            checkpoint: actorCheckpoint,
            action: { toolName: 'submit_move' },
            observedAt: new Date(),
          },
        });
      const finishInvocation = async (
        invocationId: string,
        actorCheckpoint: ReturnType<typeof checkpoint>,
      ) => {
        const historyRecorded = await methods.recordAgentEventActorReconciliation({
          user: 'actor-head-user',
          tenantId: 'tenant-a',
          conversationId,
          reconciliation: {
            invocationId,
            status: 'history_persisted',
            checkpoint: actorCheckpoint,
            action: { toolName: 'submit_move' },
            observedAt: new Date(),
          },
        });
        if (!historyRecorded) {
          return false;
        }
        return methods.resolveAgentEventActorReconciliation({
          user: 'actor-head-user',
          tenantId: 'tenant-a',
          conversationId,
          invocationId,
          checkpoint: actorCheckpoint,
          resolution: 'checkpoint_verified',
        });
      };

      await expect(beginInvocation('one')).resolves.toBe(true);
      await expect(beginInvocation('one')).resolves.toBe(false);
      await expect(beginInvocation('one', checkpoint('different'))).resolves.toBe(false);
      await expect(beginInvocation('competing', checkpoint('one'))).resolves.toBe(false);
      const first = await methods.commitAgentEventActorState({
        user: 'actor-head-user',
        tenantId: 'tenant-a',
        conversationId,
        invocationId: 'one',
        expectedEpoch: 0,
        action: { toolName: 'submit_move' },
        checkpoint: checkpoint('one'),
      });
      expect(first).toEqual({
        status: 'committed',
        state: { generation: 1, checkpoint: checkpoint('one') },
      });
      await expect(
        methods.getAgentEventActorSnapshot({
          user: 'actor-head-user',
          tenantId: 'tenant-a',
          conversationId,
        }),
      ).resolves.toMatchObject({
        state: first.state,
        epoch: 0,
        legacyTurn: null,
        suspension: null,
        reconciliations: [
          {
            invocationId: 'one',
            status: 'persistence_pending',
            checkpoint: checkpoint('one'),
            action: { toolName: 'submit_move' },
          },
        ],
      });
      await expect(
        methods.recordAgentEventActorReconciliation({
          user: 'actor-head-user',
          tenantId: 'tenant-a',
          conversationId,
          reconciliation: {
            invocationId: 'one',
            status: 'persistence_failed',
            checkpoint: checkpoint('one'),
            action: { toolName: 'submit_move' },
            error: 'message write unavailable',
            observedAt: new Date(),
          },
        }),
      ).resolves.toBe(true);
      await expect(finishInvocation('one', checkpoint('one'))).resolves.toBe(true);
      await expect(
        methods.recordAgentEventActorReconciliation({
          user: 'actor-head-user',
          tenantId: 'tenant-a',
          conversationId,
          reconciliation: {
            invocationId: 'one',
            status: 'persistence_failed',
            checkpoint: checkpoint('one'),
            action: { toolName: 'submit_move' },
            error: 'late stale controller',
            observedAt: new Date(),
          },
        }),
      ).resolves.toBe(false);
      await expect(beginInvocation('one', checkpoint('one'))).resolves.toBe(false);

      const stale = await methods.commitAgentEventActorState({
        user: 'actor-head-user',
        tenantId: 'tenant-a',
        conversationId,
        invocationId: 'stale',
        expectedEpoch: 0,
        action: { toolName: 'submit_move' },
        checkpoint: checkpoint('stale'),
      });
      expect(stale).toEqual({ status: 'stale', state: first.state });

      await expect(beginInvocation('two', checkpoint('one'))).resolves.toBe(true);
      const second = await methods.commitAgentEventActorState({
        user: 'actor-head-user',
        tenantId: 'tenant-a',
        conversationId,
        invocationId: 'two',
        expectedEpoch: 0,
        action: { toolName: 'submit_move' },
        expected: first.state,
        checkpoint: checkpoint('two'),
      });
      expect(second).toEqual({
        status: 'committed',
        state: {
          generation: 2,
          checkpoint: checkpoint('two'),
          previousCheckpoint: checkpoint('one'),
        },
      });
      await expect(finishInvocation('two', checkpoint('two'))).resolves.toBe(true);

      await expect(beginInvocation('three', checkpoint('two'))).resolves.toBe(true);
      const third = await methods.commitAgentEventActorState({
        user: 'actor-head-user',
        tenantId: 'tenant-a',
        conversationId,
        invocationId: 'three',
        expectedEpoch: 0,
        action: { toolName: 'submit_move' },
        expected: second.state,
        checkpoint: checkpoint('three'),
      });
      expect(third).toEqual({
        status: 'committed',
        state: {
          generation: 3,
          checkpoint: checkpoint('three'),
          previousCheckpoint: checkpoint('two'),
        },
        prunableCheckpoint: checkpoint('one'),
      });
      const pendingPruning = await Conversation.findOne({ conversationId })
        .select('+agentEventActorCleanup')
        .lean();
      expect(pendingPruning?.agentEventActorCleanup).toEqual([checkpoint('one')]);
      await expect(finishInvocation('three', checkpoint('three'))).resolves.toBe(true);
      await expect(
        methods.getAgentEventActorSnapshot({
          user: 'actor-head-user',
          tenantId: 'tenant-a',
          conversationId,
        }),
      ).resolves.toMatchObject({
        state: third.state,
        epoch: 0,
        legacyTurn: null,
        reconciliations: [
          { invocationId: 'one', status: 'settled' },
          { invocationId: 'two', status: 'settled' },
          { invocationId: 'three', status: 'settled' },
        ],
      });
      await expect(
        methods.beginAgentEventActorLegacyTurn({
          user: 'actor-head-user',
          tenantId: 'tenant-a',
          conversationId,
          token: 'legacy-turn-1',
        }),
      ).resolves.toBe(true);
      await expect(
        methods.completeAgentEventActorLegacyTurn({
          user: 'actor-head-user',
          tenantId: 'tenant-a',
          conversationId,
          token: 'legacy-turn-1',
        }),
      ).resolves.toBe(true);
      await expect(beginInvocation('stale-warm', checkpoint('three'))).resolves.toBe(true);
      await expect(
        methods.commitAgentEventActorState({
          user: 'actor-head-user',
          tenantId: 'tenant-a',
          conversationId,
          invocationId: 'stale-warm',
          expectedEpoch: 0,
          action: { toolName: 'submit_move' },
          expected: third.state,
          checkpoint: checkpoint('stale-warm'),
        }),
      ).resolves.toEqual({
        status: 'stale',
        state: { ...third.state!, requiresColdStart: true },
      });
      await expect(
        methods.resolveAgentEventActorReconciliation({
          user: 'actor-head-user',
          tenantId: 'tenant-a',
          conversationId,
          invocationId: 'stale-warm',
          checkpoint: checkpoint('three'),
          resolution: 'invocation_abandoned',
        }),
      ).resolves.toBe(true);
      await expect(
        methods.getAgentEventActorSnapshot({
          user: 'actor-head-user',
          tenantId: 'tenant-a',
          conversationId,
        }),
      ).resolves.toEqual({
        state: { ...third.state, requiresColdStart: true },
        epoch: 1,
        legacyTurn: null,
        suspension: null,
        reconciliations: expect.arrayContaining([
          expect.objectContaining({ invocationId: 'one', status: 'settled' }),
          expect.objectContaining({ invocationId: 'two', status: 'settled' }),
          expect.objectContaining({ invocationId: 'three', status: 'settled' }),
        ]),
      });
      await expect(beginInvocation('four', checkpoint('three'))).resolves.toBe(true);
      const fourth = await methods.commitAgentEventActorState({
        user: 'actor-head-user',
        tenantId: 'tenant-a',
        conversationId,
        invocationId: 'four',
        expectedEpoch: 1,
        action: { toolName: 'submit_move' },
        expected: { ...third.state!, requiresColdStart: true },
        checkpoint: checkpoint('four'),
      });
      expect(fourth.status).toBe('committed');
      expect(fourth.state).not.toHaveProperty('requiresColdStart');
      await expect(finishInvocation('four', checkpoint('four'))).resolves.toBe(true);
      const competingOwners = await Promise.all([
        beginInvocation('five', checkpoint('four')),
        beginInvocation('five', checkpoint('four')),
      ]);
      expect(competingOwners.sort()).toEqual([false, true]);
      await expect(
        methods.resolveAgentEventActorReconciliation({
          user: 'actor-head-user',
          tenantId: 'tenant-a',
          conversationId,
          invocationId: 'five',
          checkpoint: checkpoint('four'),
          resolution: 'invocation_abandoned',
        }),
      ).resolves.toBe(true);
      await expect(
        methods.getAgentEventActorSnapshot({
          user: 'actor-head-user',
          tenantId: 'tenant-a',
          conversationId: 'missing-actor-thread',
        }),
      ).resolves.toBeUndefined();
      expect(await methods.getConvo('actor-head-user', conversationId)).not.toHaveProperty(
        'agentEventActor',
      );
    });

    it('persists complete warm-continuation state with the actor head', async () => {
      const conversationId = uuidv4();
      const fingerprint = {
        algorithm: 'sha256' as const,
        version: 1,
        digest: 'context-one',
      };
      const actorCheckpoint = {
        threadId: conversationId,
        checkpointId: 'checkpoint-context',
        checkpointNs: 'event-actor/context',
      };
      const skillManifest = [{ id: 'skill-1', name: 'analysis', version: 3 }];
      const discoveredToolNames = ['deferred_lookup', 'deferred_write'];
      const summary = { text: 'Earlier compacted context.', tokenCount: 12 };
      const contextMeta = { calibrationRatio: 1.25, encoding: 'o200k_base' };
      const compactionSemanticIndex = {
        version: 1 as const,
        providedEntryCount: 9,
        entries: [
          {
            type: 'activity_phase' as const,
            sourceMessageId: 'assistant-history',
            sourceContentIndex: 1,
            revision: 1,
            status: 'committed' as const,
            text: 'Verified the release state',
          },
        ],
      };
      await Conversation.create({
        conversationId,
        user: 'actor-context-user',
        endpoint: EModelEndpoint.agents,
        agent_id: 'agent-player',
        agentEventBinding: {
          bindingId: `evtbind_${'f'.repeat(48)}`,
          sourceKeyId: 'key-a',
          actorId: 'player-a',
        },
        subagentThread: {
          rootConversationId: 'parent',
          parentConversationId: 'parent',
          parentMessageId: 'parent-message',
          parentToolCallId: 'event-binding',
          parentAgentId: 'agent-director',
          subagentType: 'agent-player',
          subagentKind: 'agent',
          depth: 1,
        },
      });
      await methods.recordAgentEventActorReconciliation({
        user: 'actor-context-user',
        conversationId,
        reconciliation: {
          invocationId: 'context-one',
          status: 'invocation_pending',
          checkpoint: actorCheckpoint,
          action: { toolName: 'submit_move' },
          observedAt: new Date(),
        },
      });

      const committed = await methods.commitAgentEventActorState({
        user: 'actor-context-user',
        conversationId,
        invocationId: 'context-one',
        expectedEpoch: 0,
        action: { toolName: 'submit_move' },
        checkpoint: actorCheckpoint,
        contextFingerprint: fingerprint,
        skillManifest,
        discoveredToolNames,
        summary,
        contextMeta,
        compactionSemanticIndex,
      });

      expect(committed).toMatchObject({
        status: 'committed',
        state: {
          generation: 1,
          checkpoint: actorCheckpoint,
          contextFingerprint: fingerprint,
          skillManifest,
          discoveredToolNames,
          summary,
          contextMeta,
          compactionSemanticIndex,
        },
      });
      await expect(
        methods.getAgentEventActorSnapshot({ user: 'actor-context-user', conversationId }),
      ).resolves.toMatchObject({
        state: {
          contextFingerprint: fingerprint,
          skillManifest,
          discoveredToolNames,
          summary,
          contextMeta,
          compactionSemanticIndex,
        },
      });

      await expect(
        methods.commitAgentEventActorState({
          user: 'actor-context-user',
          conversationId,
          invocationId: 'too-many-skills',
          expectedEpoch: 0,
          action: { toolName: 'submit_move' },
          checkpoint: actorCheckpoint,
          skillManifest: Array.from({ length: 65 }, (_, index) => ({
            id: `skill-${index}`,
            name: `skill-${index}`,
            version: 1,
          })),
        }),
      ).rejects.toThrow('Event actor Skill manifest exceeds 64');

      await expect(
        methods.commitAgentEventActorState({
          user: 'actor-context-user',
          conversationId,
          invocationId: 'too-many-tools',
          expectedEpoch: 0,
          action: { toolName: 'submit_move' },
          checkpoint: actorCheckpoint,
          discoveredToolNames: Array.from({ length: 129 }, (_, index) => `tool-${index}`),
        }),
      ).rejects.toThrow('Event actor discovered-tool state is invalid');

      await expect(
        methods.commitAgentEventActorState({
          user: 'actor-context-user',
          conversationId,
          invocationId: 'invalid-summary',
          expectedEpoch: 0,
          action: { toolName: 'submit_move' },
          checkpoint: actorCheckpoint,
          summary: { text: '', tokenCount: 1 },
        }),
      ).rejects.toThrow('Event actor summary state is invalid');

      await expect(
        methods.commitAgentEventActorState({
          user: 'actor-context-user',
          conversationId,
          invocationId: 'invalid-calibration',
          expectedEpoch: 0,
          action: { toolName: 'submit_move' },
          checkpoint: actorCheckpoint,
          contextMeta: { calibrationRatio: 9, encoding: 'o200k_base' },
        }),
      ).rejects.toThrow('Event actor context calibration is invalid');

      await expect(
        methods.commitAgentEventActorState({
          user: 'actor-context-user',
          conversationId,
          invocationId: 'invalid-fading',
          expectedEpoch: 0,
          action: { toolName: 'submit_move' },
          checkpoint: actorCheckpoint,
          contextMeta: {
            calibrationRatio: 1.25,
            fading: { v: 1, budgetTokens: -5, masked: true },
          },
        }),
      ).rejects.toThrow('Event actor context fading tier is invalid');

      await expect(
        methods.commitAgentEventActorState({
          user: 'actor-context-user',
          conversationId,
          invocationId: 'invalid-fading-tiers',
          expectedEpoch: 0,
          action: { toolName: 'submit_move' },
          checkpoint: actorCheckpoint,
          contextMeta: {
            calibrationRatio: 1.25,
            fadingTiers: [
              { agentId: 'agent-a', v: 1, budgetTokens: 20_000, masked: true },
              { agentId: 'agent-a', v: 1, budgetTokens: 10_000, masked: true },
            ],
          },
        }),
      ).rejects.toThrow('Event actor context fading tiers are invalid');

      await expect(
        methods.commitAgentEventActorState({
          user: 'actor-context-user',
          conversationId,
          invocationId: 'invalid-compaction-index',
          expectedEpoch: 0,
          action: { toolName: 'submit_move' },
          checkpoint: actorCheckpoint,
          compactionSemanticIndex: {
            version: 1,
            entries: [{ ...compactionSemanticIndex.entries[0], sourceContentIndex: -1 }],
          },
        }),
      ).rejects.toThrow('Event actor compaction semantic index is invalid');

      await expect(
        methods.commitAgentEventActorState({
          user: 'actor-context-user',
          conversationId,
          invocationId: 'invalid-compaction-count',
          expectedEpoch: 0,
          action: { toolName: 'submit_move' },
          checkpoint: actorCheckpoint,
          compactionSemanticIndex: {
            version: 1,
            entries: compactionSemanticIndex.entries,
            providedEntryCount: 0,
          },
        }),
      ).rejects.toThrow('Event actor compaction semantic index is invalid');
    });

    it('retains exact legacy settled receipts until delivery-ledger migration', async () => {
      const conversationId = uuidv4();
      await Conversation.create({
        conversationId,
        user: 'actor-reconcile-user',
        endpoint: EModelEndpoint.agents,
        agent_id: 'agent-player',
        agentEventBinding: {
          bindingId: `evtbind_${'d'.repeat(48)}`,
          sourceKeyId: 'key-a',
          actorId: 'player-a',
        },
        subagentThread: {
          rootConversationId: 'parent',
          parentConversationId: 'parent',
          parentMessageId: 'parent-message',
          parentToolCallId: 'event-binding',
          parentAgentId: 'agent-director',
          subagentType: 'agent-player',
          subagentKind: 'agent',
          depth: 1,
        },
      });
      const checkpoint = {
        threadId: conversationId,
        checkpointId: 'checkpoint-one',
        checkpointNs: 'event-actor/one',
      };
      await methods.recordAgentEventActorReconciliation({
        user: 'actor-reconcile-user',
        conversationId,
        reconciliation: {
          invocationId: 'event-one',
          status: 'invocation_pending',
          checkpoint,
          action: { toolName: 'submit_move' },
          observedAt: new Date(),
        },
      });
      const first = await methods.commitAgentEventActorState({
        user: 'actor-reconcile-user',
        conversationId,
        invocationId: 'event-one',
        expectedEpoch: 0,
        action: { toolName: 'submit_move' },
        checkpoint,
      });
      expect(first.status).toBe('committed');
      await methods.recordAgentEventActorReconciliation({
        user: 'actor-reconcile-user',
        conversationId,
        reconciliation: {
          invocationId: 'event-one',
          status: 'history_persisted',
          checkpoint,
          action: { toolName: 'submit_move' },
          observedAt: new Date(),
        },
      });
      await methods.resolveAgentEventActorReconciliation({
        user: 'actor-reconcile-user',
        conversationId,
        invocationId: 'event-one',
        checkpoint,
        resolution: 'checkpoint_verified',
      });
      const observedAt = new Date('2026-08-25T00:00:00.000Z');
      const reconciliation = {
        invocationId: 'event-conflict',
        status: 'commit_conflict' as const,
        checkpoint: {
          threadId: conversationId,
          checkpointId: 'checkpoint-conflict',
          checkpointNs: 'event-actor/conflict',
        },
        action: { toolName: 'submit_move', toolCallId: 'call-1' },
        error: 'A competing checkpoint advanced the actor head',
        observedAt,
      };
      const beginReconciliation = (next: IAgentEventActorReconciliation) =>
        methods.recordAgentEventActorReconciliation({
          user: 'actor-reconcile-user',
          conversationId,
          reconciliation: { ...next, status: 'invocation_pending' },
        });

      await expect(beginReconciliation(reconciliation)).resolves.toBe(true);
      await expect(
        methods.recordAgentEventActorReconciliation({
          user: 'actor-reconcile-user',
          conversationId,
          reconciliation,
        }),
      ).resolves.toBe(true);
      await expect(
        methods.getAgentEventActorSnapshot({
          user: 'actor-reconcile-user',
          conversationId,
        }),
      ).resolves.toEqual({
        state: first.state,
        epoch: 0,
        legacyTurn: null,
        suspension: null,
        reconciliations: [
          expect.objectContaining({ invocationId: 'event-one', status: 'settled' }),
          reconciliation,
        ],
      });
      await expect(
        methods.commitAgentEventActorState({
          user: 'actor-reconcile-user',
          conversationId,
          invocationId: 'event-blocked',
          expectedEpoch: 0,
          action: { toolName: 'submit_move' },
          expected: first.state,
          checkpoint: { ...checkpoint, checkpointId: 'checkpoint-two' },
        }),
      ).resolves.toEqual({ status: 'stale', state: first.state });
      await expect(
        methods.resolveAgentEventActorReconciliation({
          user: 'actor-reconcile-user',
          conversationId,
          invocationId: reconciliation.invocationId,
          checkpoint: {
            threadId: conversationId,
            checkpointId: 'checkpoint-conflict',
            checkpointNs: 'event-actor/conflict',
          },
          resolution: 'checkpoint_verified',
        }),
      ).resolves.toBe(false);
      await expect(
        methods.resolveAgentEventActorReconciliation({
          user: 'actor-reconcile-user',
          conversationId,
          invocationId: reconciliation.invocationId,
          checkpoint: {
            threadId: conversationId,
            checkpointId: 'checkpoint-conflict',
            checkpointNs: 'event-actor/conflict',
          },
          resolution: 'action_compensated',
        }),
      ).resolves.toBe(true);
      const checkpointless = {
        ...reconciliation,
        invocationId: 'event-checkpointless',
        checkpoint: {
          threadId: conversationId,
          checkpointNs: 'event-actor/checkpointless',
        },
      };
      await expect(beginReconciliation(checkpointless)).resolves.toBe(true);
      await expect(
        methods.recordAgentEventActorReconciliation({
          user: 'actor-reconcile-user',
          conversationId,
          reconciliation: checkpointless,
        }),
      ).resolves.toBe(true);
      await expect(
        methods.resolveAgentEventActorReconciliation({
          user: 'actor-reconcile-user',
          conversationId,
          invocationId: checkpointless.invocationId,
          checkpoint: checkpointless.checkpoint,
          resolution: 'action_compensated',
        }),
      ).resolves.toBe(true);
      const verified = {
        ...reconciliation,
        invocationId: 'event-verified',
        status: 'history_persisted' as const,
        checkpoint,
      };
      await expect(beginReconciliation(verified)).resolves.toBe(true);
      await expect(
        methods.recordAgentEventActorReconciliation({
          user: 'actor-reconcile-user',
          conversationId,
          reconciliation: verified,
        }),
      ).resolves.toBe(true);
      await expect(
        methods.resolveAgentEventActorReconciliation({
          user: 'actor-reconcile-user',
          conversationId,
          invocationId: verified.invocationId,
          checkpoint,
          resolution: 'checkpoint_verified',
        }),
      ).resolves.toBe(true);
      /** A crashed settle retries verification and replays its own receipt. */
      await expect(
        methods.resolveAgentEventActorReconciliation({
          user: 'actor-reconcile-user',
          conversationId,
          invocationId: verified.invocationId,
          checkpoint,
          resolution: 'checkpoint_verified',
        }),
      ).resolves.toBe(true);
      const later = { ...reconciliation, invocationId: 'event-later' };
      await expect(beginReconciliation(later)).resolves.toBe(true);
      await expect(
        methods.recordAgentEventActorReconciliation({
          user: 'actor-reconcile-user',
          conversationId,
          reconciliation: later,
        }),
      ).resolves.toBe(true);
      await expect(
        methods.getAgentEventActorSnapshot({
          user: 'actor-reconcile-user',
          conversationId,
        }),
      ).resolves.toEqual({
        state: { ...first.state!, requiresColdStart: true },
        epoch: 0,
        legacyTurn: null,
        suspension: null,
        reconciliations: [
          expect.objectContaining({
            invocationId: 'event-one',
            status: 'settled',
            resolution: 'checkpoint_verified',
          }),
          expect.objectContaining({
            invocationId: 'event-conflict',
            status: 'settled',
            resolution: 'action_compensated',
          }),
          expect.objectContaining({
            invocationId: 'event-checkpointless',
            status: 'settled',
            resolution: 'action_compensated',
          }),
          expect.objectContaining({
            invocationId: 'event-verified',
            status: 'settled',
            resolution: 'checkpoint_verified',
          }),
          later,
        ],
      });
      await expect(
        methods.resolveAgentEventActorReconciliation({
          user: 'actor-reconcile-user',
          conversationId,
          invocationId: 'event-later',
          checkpoint: reconciliation.checkpoint,
          resolution: 'history_repaired',
        }),
      ).resolves.toBe(true);
      /** A repaired or compensated invocation keeps its receipt: it already
       * applied an external action, so a delayed duplicate owner must never
       * reacquire the same id. */
      await expect(
        methods.getAgentEventActorSnapshot({
          user: 'actor-reconcile-user',
          conversationId,
        }),
      ).resolves.toEqual({
        state: { ...first.state!, requiresColdStart: true },
        epoch: 0,
        legacyTurn: null,
        suspension: null,
        reconciliations: [
          expect.objectContaining({ invocationId: 'event-one', status: 'settled' }),
          expect.objectContaining({ invocationId: 'event-conflict', status: 'settled' }),
          expect.objectContaining({ invocationId: 'event-checkpointless', status: 'settled' }),
          expect.objectContaining({ invocationId: 'event-verified', status: 'settled' }),
          expect.objectContaining({
            invocationId: 'event-later',
            status: 'settled',
            resolution: 'history_repaired',
          }),
        ],
      });
      await expect(beginReconciliation(later)).resolves.toBe(false);
      await expect(
        beginReconciliation({ ...reconciliation, invocationId: 'event-checkpointless' }),
      ).resolves.toBe(false);
      /** Retrying a repair converges on its own retained receipt. */
      await expect(
        methods.resolveAgentEventActorReconciliation({
          user: 'actor-reconcile-user',
          conversationId,
          invocationId: 'event-later',
          checkpoint: reconciliation.checkpoint,
          resolution: 'history_repaired',
        }),
      ).resolves.toBe(true);
      /** A different id stays admissible after those settled receipts. */
      await expect(
        beginReconciliation({ ...reconciliation, invocationId: 'event-fresh' }),
      ).resolves.toBe(true);
      await expect(
        methods.resolveAgentEventActorReconciliation({
          user: 'actor-reconcile-user',
          conversationId,
          invocationId: 'event-fresh',
          checkpoint: reconciliation.checkpoint,
          resolution: 'invocation_abandoned',
        }),
      ).resolves.toBe(true);
      const visible = await methods.getConvo('actor-reconcile-user', conversationId);
      expect(visible).not.toHaveProperty('agentEventActor');
      expect(visible).not.toHaveProperty('agentEventActorReconciliations');
    });

    it('confirms action admission only on the exact pending lifecycle', async () => {
      const conversationId = uuidv4();
      await Conversation.create({
        conversationId,
        user: 'actor-admission-user',
        endpoint: EModelEndpoint.agents,
        agentEventBinding: {
          bindingId: `evtbind_${'a'.repeat(48)}`,
          sourceKeyId: 'key-a',
          actorId: 'player-a',
        },
        subagentThread: {
          rootConversationId: 'parent',
          parentConversationId: 'parent',
          parentMessageId: 'parent-message',
          parentToolCallId: 'event-binding',
          parentAgentId: 'agent-director',
          subagentType: 'agent-player',
          subagentKind: 'agent',
          depth: 1,
        },
      });
      const pending = {
        invocationId: 'event-admission',
        status: 'invocation_pending' as const,
        checkpoint: {
          threadId: conversationId,
          checkpointNs: 'event-actor/admission',
        },
        action: { toolName: 'submit_move' },
        observedAt: new Date(),
      };

      await expect(
        methods.recordAgentEventActorReconciliation({
          user: 'actor-admission-user',
          conversationId,
          reconciliation: pending,
        }),
      ).resolves.toBe(true);
      await expect(
        methods.recordAgentEventActorReconciliation({
          user: 'actor-admission-user',
          conversationId,
          reconciliation: { ...pending, actionAdmitted: true },
        }),
      ).resolves.toBe(true);
      await expect(
        methods.recordAgentEventActorReconciliation({
          user: 'actor-admission-user',
          conversationId,
          reconciliation: { ...pending, actionAdmitted: true },
        }),
      ).resolves.toBe(false);
      await expect(
        methods.getAgentEventActorSnapshot({
          user: 'actor-admission-user',
          conversationId,
        }),
      ).resolves.toMatchObject({
        reconciliations: [
          expect.objectContaining({
            invocationId: 'event-admission',
            status: 'invocation_pending',
            actionAdmitted: true,
          }),
        ],
      });
      await expect(
        methods.resolveAgentEventActorReconciliation({
          user: 'actor-admission-user',
          conversationId,
          invocationId: pending.invocationId,
          checkpoint: pending.checkpoint,
          expectedActionAdmitted: false,
          resolution: 'invocation_abandoned',
        }),
      ).resolves.toBe(false);
      await expect(
        methods.resolveAgentEventActorReconciliation({
          user: 'actor-admission-user',
          conversationId,
          invocationId: pending.invocationId,
          checkpoint: pending.checkpoint,
          expectedActionAdmitted: true,
          resolution: 'invocation_abandoned',
        }),
      ).resolves.toBe(true);
    });

    it('does not confirm a stale marker after a checkpoint-distinct successor wins', async () => {
      const conversationId = uuidv4();
      const invocationId = 'event-stale-confirmation';
      const original = {
        invocationId,
        status: 'invocation_pending' as const,
        checkpoint: {
          threadId: conversationId,
          checkpointId: 'checkpoint-original',
          checkpointNs: 'event-actor/original',
        },
        action: { toolName: 'submit_move', toolCallId: 'call-original' },
        observedAt: new Date(),
      };
      const successor = {
        ...original,
        checkpoint: {
          threadId: conversationId,
          checkpointId: 'checkpoint-successor',
          checkpointNs: 'event-actor/successor',
        },
        action: { toolName: 'submit_move', toolCallId: 'call-successor' },
      };
      await Conversation.create({
        conversationId,
        user: 'actor-stale-confirmation-user',
        endpoint: EModelEndpoint.agents,
        agentEventBinding: {
          bindingId: `evtbind_${'b'.repeat(48)}`,
          sourceKeyId: 'key-a',
          actorId: 'player-a',
        },
        subagentThread: {
          rootConversationId: 'parent',
          parentConversationId: 'parent',
          parentMessageId: 'parent-message',
          parentToolCallId: 'event-binding',
          parentAgentId: 'agent-director',
          subagentType: 'agent-player',
          subagentKind: 'agent',
          depth: 1,
        },
        agentEventActorReconciliations: [successor],
      });
      const staleRead = jest.spyOn(Conversation, 'findOne').mockImplementationOnce(
        () =>
          ({
            select: () => ({
              lean: () => Promise.resolve({ agentEventActorReconciliations: [original] }),
            }),
          }) as never,
      );

      await expect(
        methods.recordAgentEventActorReconciliation({
          user: 'actor-stale-confirmation-user',
          conversationId,
          reconciliation: { ...original, actionAdmitted: true },
        }),
      ).resolves.toBe(false);
      staleRead.mockRestore();
      await expect(
        methods.getAgentEventActorSnapshot({
          user: 'actor-stale-confirmation-user',
          conversationId,
        }),
      ).resolves.toMatchObject({
        reconciliations: [
          expect.objectContaining({
            checkpoint: expect.objectContaining({ checkpointId: 'checkpoint-successor' }),
            action: expect.objectContaining({ toolCallId: 'call-successor' }),
          }),
        ],
      });
    });

    it('clears an exact reconciled invocation without retaining a conversation receipt', async () => {
      const conversationId = uuidv4();
      const observedAt = new Date('2026-08-26T12:00:00.000Z');
      const checkpoint = {
        threadId: conversationId,
        checkpointId: 'checkpoint-one',
        checkpointNs: 'event-actor/event-one',
      };
      await Conversation.create({
        conversationId,
        user: 'actor-receipt-user',
        endpoint: EModelEndpoint.agents,
        agent_id: 'agent-player',
        agentEventBinding: {
          bindingId: `evtbind_${'f'.repeat(48)}`,
          sourceKeyId: 'key-a',
          actorId: 'player-a',
        },
        subagentThread: {
          rootConversationId: 'parent',
          parentConversationId: 'parent',
          parentMessageId: 'parent-message',
          parentToolCallId: 'event-binding',
          parentAgentId: 'agent-director',
          subagentType: 'agent-player',
          subagentKind: 'agent',
          depth: 1,
        },
      });
      await methods.recordAgentEventActorReconciliation({
        user: 'actor-receipt-user',
        conversationId,
        reconciliation: {
          invocationId: 'event-one',
          status: 'invocation_pending',
          checkpoint,
          action: { toolName: 'submit_move' },
          observedAt,
        },
      });
      await methods.commitAgentEventActorState({
        user: 'actor-receipt-user',
        conversationId,
        invocationId: 'event-one',
        expectedEpoch: 0,
        action: { toolName: 'submit_move' },
        checkpoint,
      });
      await methods.recordAgentEventActorReconciliation({
        user: 'actor-receipt-user',
        conversationId,
        reconciliation: {
          invocationId: 'event-one',
          status: 'history_persisted',
          checkpoint,
          action: { toolName: 'submit_move' },
          observedAt,
        },
      });

      await expect(
        methods.getAgentEventActorReconciliationStorageMetrics(
          new Date(observedAt.getTime() + 12_000),
        ),
      ).resolves.toEqual({ pending: 1, oldestPendingAgeSeconds: 12 });

      await expect(
        methods.clearAgentEventActorReconciliation({
          user: 'actor-receipt-user',
          conversationId,
          invocationId: 'event-one',
          checkpoint,
          resolution: 'checkpoint_verified',
        }),
      ).resolves.toBe(true);
      await expect(
        methods.getAgentEventActorSnapshot({ user: 'actor-receipt-user', conversationId }),
      ).resolves.toMatchObject({ reconciliations: [] });
      await expect(
        methods.getAgentEventActorReconciliationStorageMetrics(
          new Date(observedAt.getTime() + 12_000),
        ),
      ).resolves.toEqual({ pending: 0, oldestPendingAgeSeconds: 0 });
    });

    it('does not prune legacy settled receipts during new invocation admission', async () => {
      const conversationId = uuidv4();
      await Conversation.create({
        conversationId,
        user: 'actor-retention-user',
        endpoint: EModelEndpoint.agents,
        agent_id: 'agent-player',
        agentEventBinding: {
          bindingId: `evtbind_${'e'.repeat(48)}`,
          sourceKeyId: 'key-a',
          actorId: 'player-a',
        },
        subagentThread: {
          rootConversationId: 'parent',
          parentConversationId: 'parent',
          parentMessageId: 'parent-message',
          parentToolCallId: 'event-binding',
          parentAgentId: 'agent-director',
          subagentType: 'agent-player',
          subagentKind: 'agent',
          depth: 1,
        },
      });
      const settleReceipt = async (invocationId: string) => {
        const checkpoint = {
          threadId: conversationId,
          checkpointId: `checkpoint-${invocationId}`,
          checkpointNs: `event-actor/${invocationId}`,
        };
        const base = {
          invocationId,
          checkpoint,
          action: { toolName: 'submit_move' },
          observedAt: new Date(),
        };
        await expect(
          methods.recordAgentEventActorReconciliation({
            user: 'actor-retention-user',
            conversationId,
            reconciliation: { ...base, status: 'invocation_pending' },
          }),
        ).resolves.toBe(true);
        await expect(
          methods.recordAgentEventActorReconciliation({
            user: 'actor-retention-user',
            conversationId,
            reconciliation: { ...base, status: 'commit_conflict', error: 'conflict' },
          }),
        ).resolves.toBe(true);
        await expect(
          methods.resolveAgentEventActorReconciliation({
            user: 'actor-retention-user',
            conversationId,
            invocationId,
            checkpoint,
            resolution: 'action_compensated',
          }),
        ).resolves.toBe(true);
      };
      await settleReceipt('event-old');
      await settleReceipt('event-recent');
      await Conversation.updateOne(
        { conversationId },
        {
          $set: {
            'agentEventActorReconciliations.$[receipt].observedAt': new Date(
              Date.now() - 8 * 24 * 60 * 60 * 1000,
            ),
          },
        },
        { arrayFilters: [{ 'receipt.invocationId': 'event-old' }], timestamps: false },
      );
      await expect(
        methods.recordAgentEventActorReconciliation({
          user: 'actor-retention-user',
          conversationId,
          reconciliation: {
            invocationId: 'event-next',
            status: 'invocation_pending',
            checkpoint: {
              threadId: conversationId,
              checkpointId: 'checkpoint-next',
              checkpointNs: 'event-actor/next',
            },
            action: { toolName: 'submit_move' },
            observedAt: new Date(),
          },
        }),
      ).resolves.toBe(true);
      /** Conversation admission no longer owns receipt retention. Lazy
       * delivery-ledger migration removes either legacy receipt only after its
       * authoritative row is durable. */
      await expect(
        methods.getAgentEventActorSnapshot({
          user: 'actor-retention-user',
          conversationId,
        }),
      ).resolves.toEqual({
        state: null,
        epoch: 0,
        legacyTurn: null,
        suspension: null,
        reconciliations: [
          expect.objectContaining({ invocationId: 'event-old', status: 'settled' }),
          expect.objectContaining({ invocationId: 'event-recent', status: 'settled' }),
          expect.objectContaining({ invocationId: 'event-next', status: 'invocation_pending' }),
        ],
      });
    });

    it('expires dormant legacy settled receipts independently of matching delivery replay', async () => {
      const oldConversationId = uuidv4();
      const recentConversationId = uuidv4();
      const settled = (invocationId: string, observedAt: Date) => ({
        invocationId,
        status: 'settled' as const,
        resolution: 'action_compensated' as const,
        checkpoint: {
          threadId: invocationId === 'old' ? oldConversationId : recentConversationId,
          checkpointNs: `event-actor/${invocationId}`,
        },
        action: { toolName: 'submit_move' },
        observedAt,
      });
      const now = new Date();
      await Conversation.create([
        {
          conversationId: oldConversationId,
          user: 'actor-legacy-expiry-user',
          endpoint: EModelEndpoint.agents,
          agentEventActorReconciliations: [
            settled('old', new Date(now.getTime() - 91 * 24 * 60 * 60_000)),
          ],
        },
        {
          conversationId: recentConversationId,
          user: 'actor-legacy-expiry-user',
          endpoint: EModelEndpoint.agents,
          agentEventActorReconciliations: [
            settled('recent', new Date(now.getTime() - 89 * 24 * 60 * 60_000)),
          ],
        },
      ]);

      const activity = { found: false };
      await expect(methods.expireLegacyAgentEventActorReceipts(now, 1, activity)).resolves.toBe(1);
      expect(activity.found).toBe(true);
      await expect(
        Conversation.findOne({ conversationId: oldConversationId })
          .select('+agentEventActorReconciliations')
          .lean(),
      ).resolves.toMatchObject({ agentEventActorReconciliations: [] });
      await expect(
        Conversation.findOne({ conversationId: recentConversationId })
          .select('+agentEventActorReconciliations')
          .lean(),
      ).resolves.toMatchObject({
        agentEventActorReconciliations: [expect.objectContaining({ invocationId: 'recent' })],
      });
    });

    it('sends a pure inclusion projection for the candidate read', async () => {
      /** The string form `'_id +field'` compiles to `{ _id: 1 }` plus a `: 0`
       * exclusion for every other `select: false` sibling — a mixed projection
       * MongoDB tolerates but Amazon DocumentDB rejects, which failed this
       * sweep on every maintenance pass. The candidate read must stay a pure
       * inclusion AND still return the hidden reconciliations field. */
      const conversationId = uuidv4();
      const now = new Date();
      await Conversation.create({
        conversationId,
        user: 'actor-projection-user',
        endpoint: EModelEndpoint.agents,
        agentEventActorReconciliations: [
          {
            invocationId: 'projection-probe',
            status: 'settled',
            resolution: 'action_compensated',
            checkpoint: {
              threadId: conversationId,
              checkpointNs: 'event-actor/projection-probe',
            },
            action: { toolName: 'submit_move' },
            observedAt: new Date(now.getTime() - 91 * 24 * 60 * 60_000),
          },
        ],
      });
      const projections: Array<Record<string, number> | undefined> = [];
      const originalFind = Conversation.collection.find.bind(Conversation.collection);
      const findSpy = jest
        .spyOn(Conversation.collection, 'find')
        .mockImplementation((filter, options) => {
          projections.push(options?.projection);
          return originalFind(filter, options);
        });
      try {
        await expect(methods.expireLegacyAgentEventActorReceipts(now)).resolves.toBe(1);
      } finally {
        findSpy.mockRestore();
      }
      expect(projections[0]).toEqual({ _id: 1, agentEventActorReconciliations: 1 });
    });

    it('retains an expired legacy receipt while its delivery handling is nonterminal', async () => {
      const conversationId = uuidv4();
      const userId = new mongoose.Types.ObjectId();
      const now = new Date();
      await Conversation.create({
        conversationId,
        user: userId.toString(),
        endpoint: EModelEndpoint.agents,
        agentEventActorReconciliations: [
          {
            invocationId: 'protected-old',
            status: 'settled',
            resolution: 'checkpoint_verified',
            checkpoint: {
              threadId: conversationId,
              checkpointId: 'checkpoint-old',
              checkpointNs: 'event-actor/protected-old',
            },
            action: { toolName: 'submit_move' },
            observedAt: new Date(now.getTime() - 91 * 24 * 60 * 60_000),
          },
        ],
      });
      const Delivery = mongoose.models.AgentTriggerDelivery;
      await Delivery.create({
        deliveryKey: 'protected-old',
        fingerprint: 'protected-old-fingerprint',
        orderingKey: 'protected-old-lane',
        laneSequence: 1,
        envelope: {},
        user: userId,
        status: 'succeeded',
        attempts: 1,
        availableAt: now,
        awaitTerminalHandling: true,
        handling: {
          status: 'started',
          conversationId,
          streamId: conversationId,
          generationCreatedAt: now.getTime(),
          startedAt: now,
        },
      });

      await expect(methods.expireLegacyAgentEventActorReceipts(now)).resolves.toBe(0);
      await expect(
        Conversation.findOne({ conversationId }).select('+agentEventActorReconciliations').lean(),
      ).resolves.toMatchObject({
        agentEventActorReconciliations: [
          expect.objectContaining({ invocationId: 'protected-old' }),
        ],
      });

      await Delivery.updateOne(
        { deliveryKey: 'protected-old' },
        { $set: { 'handling.status': 'applied', 'handling.settledAt': now } },
      );
      const updatedAtBeforeExpiry = (
        await Conversation.findOne({ conversationId }).select('updatedAt').lean()
      )?.updatedAt;
      /** The first call reaches the end of the protected page and resets the
       * cursor; the next bounded sweep revisits it after handling is terminal. */
      await expect(methods.expireLegacyAgentEventActorReceipts(now)).resolves.toBe(0);
      await expect(methods.expireLegacyAgentEventActorReceipts(now)).resolves.toBe(1);
      await expect(
        Conversation.findOne({ conversationId }).select('updatedAt').lean(),
      ).resolves.toMatchObject({ updatedAt: updatedAtBeforeExpiry });
    });

    it('pages raw conversations before filtering and advances past protected receipts', async () => {
      const freshConversationId = uuidv4();
      const protectedConversationId = uuidv4();
      const removableConversationId = uuidv4();
      const userId = new mongoose.Types.ObjectId();
      const now = new Date();
      const oldReceipt = (invocationId: string, threadId: string) => ({
        invocationId,
        status: 'settled' as const,
        resolution: 'action_compensated' as const,
        checkpoint: { threadId, checkpointNs: `event-actor/${invocationId}` },
        action: { toolName: 'submit_move' },
        observedAt: new Date(now.getTime() - 91 * 24 * 60 * 60_000),
      });
      await Conversation.create([
        {
          conversationId: freshConversationId,
          user: userId.toString(),
          endpoint: EModelEndpoint.agents,
          agentEventActorReconciliations: [
            { ...oldReceipt('fresh-first', freshConversationId), observedAt: now },
          ],
        },
        {
          conversationId: protectedConversationId,
          user: userId.toString(),
          endpoint: EModelEndpoint.agents,
          agentEventActorReconciliations: [oldReceipt('protected-first', protectedConversationId)],
        },
        {
          conversationId: removableConversationId,
          user: userId.toString(),
          endpoint: EModelEndpoint.agents,
          agentEventActorReconciliations: [oldReceipt('removable-second', removableConversationId)],
        },
      ]);
      const Delivery = mongoose.models.AgentTriggerDelivery;
      await Delivery.create({
        deliveryKey: 'protected-first',
        fingerprint: 'protected-first-fingerprint',
        orderingKey: 'protected-first-lane',
        laneSequence: 1,
        envelope: {},
        user: userId,
        status: 'succeeded',
        attempts: 1,
        availableAt: now,
        awaitTerminalHandling: true,
      });

      /** The first raw page contains no expired receipt. It must still keep
       * discovery active, without querying delivery protection for an empty ID set.
       * The second is protected, and only the third reaches removable work. */
      const activity = { found: false };
      const protection = jest.spyOn(Delivery, 'find');
      try {
        await expect(methods.expireLegacyAgentEventActorReceipts(now, 1, activity)).resolves.toBe(
          0,
        );
        expect(activity.found).toBe(true);
        expect(protection).not.toHaveBeenCalled();
      } finally {
        protection.mockRestore();
      }
      await expect(methods.expireLegacyAgentEventActorReceipts(now, 1)).resolves.toBe(0);
      await expect(methods.expireLegacyAgentEventActorReceipts(now, 1)).resolves.toBe(1);
      await expect(
        Conversation.findOne({ conversationId: protectedConversationId })
          .select('+agentEventActorReconciliations')
          .lean(),
      ).resolves.toMatchObject({
        agentEventActorReconciliations: [
          expect.objectContaining({ invocationId: 'protected-first' }),
        ],
      });
      await expect(
        Conversation.findOne({ conversationId: removableConversationId })
          .select('+agentEventActorReconciliations')
          .lean(),
      ).resolves.toMatchObject({ agentEventActorReconciliations: [] });
    });

    it('clears a compensated headless lifecycle without creating a partial actor head', async () => {
      const conversationId = uuidv4();
      const checkpoint = {
        threadId: conversationId,
        checkpointNs: 'event-actor/headless-compensation',
      };
      await Conversation.create({
        conversationId,
        user: 'actor-headless-clear-user',
        endpoint: EModelEndpoint.agents,
        agent_id: 'agent-player',
        agentEventBinding: {
          bindingId: `evtbind_${'d'.repeat(48)}`,
          sourceKeyId: 'key-a',
          actorId: 'player-a',
        },
        subagentThread: {
          rootConversationId: 'parent',
          parentConversationId: 'parent',
          parentMessageId: 'parent-message',
          parentToolCallId: 'event-binding',
          parentAgentId: 'agent-director',
          subagentType: 'agent-player',
          subagentKind: 'agent',
          depth: 1,
        },
        agentEventActorReconciliations: [
          {
            invocationId: 'headless-compensation',
            status: 'commit_conflict',
            checkpoint,
            action: { toolName: 'submit_move' },
            observedAt: new Date(),
          },
        ],
      });

      await expect(
        methods.clearAgentEventActorReconciliation({
          user: 'actor-headless-clear-user',
          conversationId,
          invocationId: 'headless-compensation',
          checkpoint,
          resolution: 'action_compensated',
        }),
      ).resolves.toBe(true);
      await expect(
        Conversation.findOne({ conversationId })
          .select('+agentEventActor +agentEventActorReconciliations')
          .lean(),
      ).resolves.toMatchObject({ agentEventActorReconciliations: [] });
      const stored = await Conversation.findOne({ conversationId })
        .select('+agentEventActor')
        .lean();
      expect(stored?.agentEventActor).toBeUndefined();
    });

    it('clears an exact settled legacy receipt after delivery-ledger migration', async () => {
      const conversationId = uuidv4();
      const checkpoint = {
        threadId: conversationId,
        checkpointId: 'checkpoint-migrated',
        checkpointNs: 'event-actor/migrated',
      };
      await Conversation.create({
        conversationId,
        user: 'actor-migrated-clear-user',
        endpoint: EModelEndpoint.agents,
        agent_id: 'agent-player',
        agentEventBinding: {
          bindingId: `evtbind_${'c'.repeat(48)}`,
          sourceKeyId: 'key-a',
          actorId: 'player-a',
        },
        subagentThread: {
          rootConversationId: 'parent',
          parentConversationId: 'parent',
          parentMessageId: 'parent-message',
          parentToolCallId: 'event-binding',
          parentAgentId: 'agent-director',
          subagentType: 'agent-player',
          subagentKind: 'agent',
          depth: 1,
        },
        agentEventActor: { generation: 1, checkpoint },
        agentEventActorReconciliations: [
          {
            invocationId: 'migrated',
            status: 'settled',
            resolution: 'checkpoint_verified',
            checkpoint,
            action: { toolName: 'submit_move' },
            observedAt: new Date(),
          },
        ],
      });

      await expect(
        methods.clearAgentEventActorReconciliation({
          user: 'actor-migrated-clear-user',
          conversationId,
          invocationId: 'migrated',
          checkpoint,
          resolution: 'checkpoint_verified',
        }),
      ).resolves.toBe(true);
      await expect(
        methods.getAgentEventActorSnapshot({
          user: 'actor-migrated-clear-user',
          conversationId,
        }),
      ).resolves.toMatchObject({ reconciliations: [] });
    });

    it('does not compensate an action that has not passed invocation admission', async () => {
      const conversationId = uuidv4();
      const checkpoint = {
        threadId: conversationId,
        checkpointNs: 'event-actor/not-admitted',
      };
      await Conversation.create({
        conversationId,
        user: 'actor-unadmitted-user',
        endpoint: EModelEndpoint.agents,
        agent_id: 'agent-player',
        agentEventBinding: {
          bindingId: `evtbind_${'b'.repeat(48)}`,
          sourceKeyId: 'key-a',
          actorId: 'player-a',
        },
        subagentThread: {
          rootConversationId: 'parent',
          parentConversationId: 'parent',
          parentMessageId: 'parent-message',
          parentToolCallId: 'event-binding',
          parentAgentId: 'agent-director',
          subagentType: 'agent-player',
          subagentKind: 'agent',
          depth: 1,
        },
        agentEventActorReconciliations: [
          {
            invocationId: 'not-admitted',
            actionAdmitted: true,
            status: 'invocation_pending',
            checkpoint,
            action: { toolName: 'submit_move' },
            observedAt: new Date(),
          },
        ],
      });

      await expect(
        methods.resolveAgentEventActorReconciliation({
          user: 'actor-unadmitted-user',
          conversationId,
          invocationId: 'not-admitted',
          checkpoint,
          resolution: 'action_compensated',
        }),
      ).resolves.toBe(false);
    });

    it('versions every legacy invalidation so a stale prepared fork cannot commit past it', async () => {
      const conversationId = uuidv4();
      await Conversation.create({
        conversationId,
        user: 'actor-epoch-user',
        endpoint: EModelEndpoint.agents,
        agent_id: 'agent-player',
        agentEventBinding: {
          bindingId: `evtbind_${'a'.repeat(48)}`,
          sourceKeyId: 'key-a',
          actorId: 'player-a',
        },
        subagentThread: {
          rootConversationId: 'parent',
          parentConversationId: 'parent',
          parentMessageId: 'parent-message',
          parentToolCallId: 'event-binding',
          parentAgentId: 'agent-director',
          subagentType: 'agent-player',
          subagentKind: 'agent',
          depth: 1,
        },
      });
      const owner = { user: 'actor-epoch-user', conversationId };
      const checkpoint = (id: string) => ({
        threadId: conversationId,
        checkpointId: `checkpoint-${id}`,
        checkpointNs: `event-actor/${id}`,
      });
      /** A headless actor has nothing for the cold-start marker to mark, so
       * the epoch is the invalidation's only durable trace. */
      await expect(methods.getAgentEventActorSnapshot(owner)).resolves.toMatchObject({
        state: null,
        epoch: 0,
        legacyTurn: null,
      });
      await expect(
        methods.beginAgentEventActorLegacyTurn({ ...owner, token: 'legacy-a' }),
      ).resolves.toBe(true);
      /** While the fence is open the epoch has NOT moved — the fence itself is
       * what blocks, so a fork cannot slip through on an unchanged epoch. */
      await expect(methods.getAgentEventActorSnapshot(owner)).resolves.toMatchObject({
        state: null,
        legacyTurn: { token: 'legacy-a' },
        epoch: 0,
      });
      await expect(
        methods.completeAgentEventActorLegacyTurn({ ...owner, token: 'legacy-a' }),
      ).resolves.toBe(true);
      await expect(methods.getAgentEventActorSnapshot(owner)).resolves.toMatchObject({
        state: null,
        legacyTurn: null,
        epoch: 1,
      });
      await expect(
        methods.recordAgentEventActorReconciliation({
          ...owner,
          reconciliation: {
            invocationId: 'event-stale-cold',
            status: 'invocation_pending',
            checkpoint: checkpoint('stale-cold'),
            action: { toolName: 'submit_move' },
            observedAt: new Date(),
          },
        }),
      ).resolves.toBe(true);
      /** The stale fork prepared against epoch 0; its expected-absent head
       * still matches, so only the epoch defeats the commit. */
      await expect(
        methods.commitAgentEventActorState({
          ...owner,
          invocationId: 'event-stale-cold',
          action: { toolName: 'submit_move' },
          expectedEpoch: 0,
          checkpoint: checkpoint('stale-cold'),
        }),
      ).resolves.toEqual({ status: 'stale' });
      await expect(
        methods.commitAgentEventActorState({
          ...owner,
          invocationId: 'event-stale-cold',
          action: { toolName: 'submit_move' },
          expectedEpoch: 1,
          checkpoint: checkpoint('stale-cold'),
        }),
      ).resolves.toMatchObject({ status: 'committed', state: { generation: 1 } });
      await expect(
        methods.recordAgentEventActorReconciliation({
          ...owner,
          reconciliation: {
            invocationId: 'event-stale-cold',
            status: 'history_persisted',
            checkpoint: checkpoint('stale-cold'),
            action: { toolName: 'submit_move' },
            observedAt: new Date(),
          },
        }),
      ).resolves.toBe(true);
      await expect(
        methods.resolveAgentEventActorReconciliation({
          ...owner,
          invocationId: 'event-stale-cold',
          checkpoint: checkpoint('stale-cold'),
          resolution: 'checkpoint_verified',
        }),
      ).resolves.toBe(true);
      /** An already cold-marked head shows no field change from a second
       * invalidation either — the epoch must still advance every time. */
      for (const token of ['legacy-b', 'legacy-c']) {
        await expect(methods.beginAgentEventActorLegacyTurn({ ...owner, token })).resolves.toBe(
          true,
        );
        await expect(methods.completeAgentEventActorLegacyTurn({ ...owner, token })).resolves.toBe(
          true,
        );
      }
      const snapshot = await methods.getAgentEventActorSnapshot(owner);
      expect(snapshot).toMatchObject({
        state: { generation: 1, requiresColdStart: true },
        epoch: 3,
        legacyTurn: null,
      });
      await expect(
        methods.recordAgentEventActorReconciliation({
          ...owner,
          reconciliation: {
            invocationId: 'event-stale-rebuild',
            status: 'invocation_pending',
            checkpoint: checkpoint('stale-rebuild'),
            action: { toolName: 'submit_move' },
            observedAt: new Date(),
          },
        }),
      ).resolves.toBe(true);
      await expect(
        methods.commitAgentEventActorState({
          ...owner,
          invocationId: 'event-stale-rebuild',
          action: { toolName: 'submit_move' },
          expected: { ...snapshot!.state!, requiresColdStart: true },
          expectedEpoch: 2,
          checkpoint: checkpoint('stale-rebuild'),
        }),
      ).resolves.toMatchObject({ status: 'stale' });
      await expect(
        methods.commitAgentEventActorState({
          ...owner,
          invocationId: 'event-stale-rebuild',
          action: { toolName: 'submit_move' },
          expected: { ...snapshot!.state!, requiresColdStart: true },
          expectedEpoch: 3,
          checkpoint: checkpoint('stale-rebuild'),
        }),
      ).resolves.toMatchObject({ status: 'committed', state: { generation: 2 } });
      /** Sealing a completed legacy turn advances the epoch. Fork admission
       * and legacy admission are mutually exclusive, so neither executor can
       * begin its external work while the other owns the actor. */
      await expect(
        methods.recordAgentEventActorReconciliation({
          ...owner,
          reconciliation: {
            invocationId: 'event-stale-rebuild',
            status: 'history_persisted',
            checkpoint: checkpoint('stale-rebuild'),
            action: { toolName: 'submit_move' },
            observedAt: new Date(),
          },
        }),
      ).resolves.toBe(true);
      await expect(
        methods.resolveAgentEventActorReconciliation({
          ...owner,
          invocationId: 'event-stale-rebuild',
          checkpoint: checkpoint('stale-rebuild'),
          resolution: 'checkpoint_verified',
        }),
      ).resolves.toBe(true);
      await expect(
        methods.beginAgentEventActorLegacyTurn({ ...owner, token: 'legacy-d' }),
      ).resolves.toBe(true);
      /** An open legacy fence refuses fork-lifecycle admission outright. */
      await expect(
        methods.recordAgentEventActorReconciliation({
          ...owner,
          reconciliation: {
            invocationId: 'event-during-legacy',
            status: 'invocation_pending',
            checkpoint: checkpoint('during-legacy'),
            action: { toolName: 'submit_move' },
            observedAt: new Date(),
          },
        }),
      ).resolves.toBe(false);
      const beforeSeal = await methods.getAgentEventActorSnapshot(owner);
      /** Defense in depth: a commit without an admitted invocation is stale,
       * even at the exact epoch observed while the legacy turn is open. */
      await expect(
        methods.commitAgentEventActorState({
          ...owner,
          invocationId: 'event-during-legacy',
          action: { toolName: 'submit_move' },
          expected: beforeSeal!.state!,
          expectedEpoch: beforeSeal!.epoch,
          checkpoint: checkpoint('during-legacy'),
        }),
      ).resolves.toMatchObject({ status: 'stale' });
      /** The legacy owner can now seal its exact token and advance the epoch. */
      await expect(
        methods.completeAgentEventActorLegacyTurn({ ...owner, token: 'legacy-d' }),
      ).resolves.toBe(true);
      await expect(methods.getAgentEventActorSnapshot(owner)).resolves.toMatchObject({
        state: { generation: 2, requiresColdStart: true },
        legacyTurn: null,
        epoch: 4,
      });
    });

    it('serializes legacy-turn and fork-lifecycle acquisition before either can execute', async () => {
      const conversationId = uuidv4();
      await Conversation.create({
        conversationId,
        user: 'actor-mutual-exclusion-user',
        endpoint: EModelEndpoint.agents,
        agent_id: 'agent-player',
        agentEventBinding: {
          bindingId: `evtbind_${'m'.repeat(48)}`,
          sourceKeyId: 'key-a',
          actorId: 'player-a',
        },
        subagentThread: {
          rootConversationId: 'parent',
          parentConversationId: 'parent',
          parentMessageId: 'parent-message',
          parentToolCallId: 'event-binding',
          parentAgentId: 'agent-director',
          subagentType: 'agent-player',
          subagentKind: 'agent',
          depth: 1,
        },
      });
      const owner = { user: 'actor-mutual-exclusion-user', conversationId };
      const checkpoint = {
        threadId: conversationId,
        checkpointId: 'checkpoint-mutual-exclusion',
        checkpointNs: 'event-actor/mutual-exclusion',
      };
      const pending = (invocationId: string) => ({
        invocationId,
        status: 'invocation_pending' as const,
        checkpoint,
        action: { toolName: 'submit_move' },
        observedAt: new Date(),
      });

      await expect(
        methods.beginAgentEventActorLegacyTurn({ ...owner, token: 'legacy-wins' }),
      ).resolves.toBe(true);
      await expect(
        methods.recordAgentEventActorReconciliation({
          ...owner,
          reconciliation: pending('fork-loses'),
        }),
      ).resolves.toBe(false);
      await expect(
        methods.completeAgentEventActorLegacyTurn({ ...owner, token: 'legacy-wins' }),
      ).resolves.toBe(true);

      await expect(
        methods.recordAgentEventActorReconciliation({
          ...owner,
          reconciliation: pending('fork-wins'),
        }),
      ).resolves.toBe(true);
      await expect(
        methods.beginAgentEventActorLegacyTurn({ ...owner, token: 'legacy-loses' }),
      ).resolves.toBe(false);
    });

    it('uses a DocumentDB-compatible classic update for legacy fence open', async () => {
      const conversationId = uuidv4();
      await Conversation.create({
        conversationId,
        user: 'actor-documentdb-fence-user',
        endpoint: EModelEndpoint.agents,
        agent_id: 'agent-player',
        agentEventBinding: {
          bindingId: `evtbind_${'d'.repeat(48)}`,
          sourceKeyId: 'key-a',
          actorId: 'player-a',
        },
        subagentThread: {
          rootConversationId: 'parent',
          parentConversationId: 'parent',
          parentMessageId: 'parent-message',
          parentToolCallId: 'event-binding',
          parentAgentId: 'agent-director',
          subagentType: 'agent-player',
          subagentKind: 'agent',
          depth: 1,
        },
      });
      const owner = { user: 'actor-documentdb-fence-user', conversationId };
      const updateSpy = jest.spyOn(Conversation, 'findOneAndUpdate');
      try {
        await expect(
          methods.beginAgentEventActorLegacyTurn({ ...owner, token: 'documentdb-token' }),
        ).resolves.toBe(true);
        expect(updateSpy.mock.calls.length).toBeGreaterThan(0);
        for (const [, update] of updateSpy.mock.calls) {
          expect(Array.isArray(update)).toBe(false);
        }
      } finally {
        updateSpy.mockRestore();
      }
    });

    it('does not let a legacy settled journal cap block a healthy actor', async () => {
      const conversationId = uuidv4();
      await Conversation.create({
        conversationId,
        user: 'actor-cap-user',
        endpoint: EModelEndpoint.agents,
        agent_id: 'agent-player',
        agentEventBinding: {
          bindingId: `evtbind_${'f'.repeat(48)}`,
          sourceKeyId: 'key-a',
          actorId: 'player-a',
        },
        subagentThread: {
          rootConversationId: 'parent',
          parentConversationId: 'parent',
          parentMessageId: 'parent-message',
          parentToolCallId: 'event-binding',
          parentAgentId: 'agent-director',
          subagentType: 'agent-player',
          subagentKind: 'agent',
          depth: 1,
        },
      });
      const bulkReceipts = (observedAt: Date) =>
        Array.from({ length: 1025 }, (_, index) => ({
          invocationId: `bulk-${index}`,
          status: 'settled' as const,
          resolution: 'checkpoint_verified' as const,
          checkpoint: {
            threadId: conversationId,
            checkpointId: `checkpoint-${index}`,
            checkpointNs: `event-actor/bulk-${index}`,
          },
          action: { toolName: 'submit_move' },
          observedAt,
        }));
      await Conversation.updateOne(
        { conversationId },
        { $set: { agentEventActorReconciliations: bulkReceipts(new Date()) } },
        { timestamps: false },
      );
      const admit = () =>
        methods.recordAgentEventActorReconciliation({
          user: 'actor-cap-user',
          conversationId,
          reconciliation: {
            invocationId: 'event-at-cap',
            status: 'invocation_pending',
            checkpoint: {
              threadId: conversationId,
              checkpointId: 'checkpoint-cap',
              checkpointNs: 'event-actor/cap',
            },
            action: { toolName: 'submit_move' },
            observedAt: new Date(),
          },
        });
      await expect(admit()).resolves.toBe(true);
      await expect(
        methods.getAgentEventActorSnapshot({
          user: 'actor-cap-user',
          conversationId,
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          reconciliations: expect.arrayContaining([
            expect.objectContaining({ invocationId: 'bulk-0' }),
            expect.objectContaining({ invocationId: 'event-at-cap' }),
          ]),
        }),
      );
    });

    it('admits one cross-replica owner and fences renewal and release by token', async () => {
      const conversationId = uuidv4();
      await Conversation.create({
        conversationId,
        user: 'lease-user',
        endpoint: EModelEndpoint.agents,
        subagentThread: {
          rootConversationId: 'root',
          parentConversationId: 'parent',
          parentMessageId: 'parent-message',
          parentToolCallId: 'parent-tool',
          parentAgentId: 'parent-agent',
          subagentType: 'researcher',
          subagentKind: 'agent',
          depth: 1,
        },
      });
      const now = new Date('2026-08-18T00:00:00.000Z');
      const expiresAt = new Date(now.getTime() + 30_000);

      const claims = await Promise.all(
        ['token-a', 'token-b'].map((token) =>
          methods.acquireSubagentThreadLease({
            user: 'lease-user',
            conversationId,
            token,
            taskId: `task-${token}`,
            now,
            expiresAt,
          }),
        ),
      );
      expect(claims.filter(Boolean)).toHaveLength(1);
      const winner = claims[0] ? 'token-a' : 'token-b';
      const loser = winner === 'token-a' ? 'token-b' : 'token-a';
      expect(await methods.countActiveSubagentThreadLeases({ user: 'lease-user', now })).toBe(1);
      await expect(
        methods.listActiveSubagentThreadLeases({ user: 'lease-user', now }),
      ).resolves.toEqual([
        {
          conversationId,
          parentConversationId: 'parent',
          taskId: `task-${winner}`,
        },
      ]);
      expect(await methods.getConvo('lease-user', conversationId)).not.toHaveProperty(
        'subagentThreadLease',
      );
      await expect(
        methods.renewSubagentThreadLease({
          user: 'lease-user',
          conversationId,
          token: loser,
          now,
          expiresAt: new Date(expiresAt.getTime() + 30_000),
        }),
      ).resolves.toBe(false);
      await expect(
        methods.releaseSubagentThreadLease({
          user: 'lease-user',
          conversationId,
          token: loser,
        }),
      ).resolves.toBe(false);
      await expect(
        methods.releaseSubagentThreadLease({
          user: 'lease-user',
          conversationId,
          token: winner,
        }),
      ).resolves.toBe(true);
      expect(await methods.countActiveSubagentThreadLeases({ user: 'lease-user', now })).toBe(0);
    });

    it('allows takeover only after the prior lease expires', async () => {
      const conversationId = uuidv4();
      await Conversation.create({
        conversationId,
        user: 'takeover-user',
        endpoint: EModelEndpoint.agents,
        subagentThread: {
          rootConversationId: 'root',
          parentConversationId: 'parent',
          parentMessageId: 'parent-message',
          parentToolCallId: 'parent-tool',
          subagentType: 'graph',
          subagentKind: 'graph',
          depth: 1,
        },
      });
      const startedAt = new Date('2026-08-18T00:00:00.000Z');
      const firstExpiry = new Date(startedAt.getTime() + 1_000);
      await methods.acquireSubagentThreadLease({
        user: 'takeover-user',
        conversationId,
        token: 'first',
        taskId: 'task-first',
        now: startedAt,
        expiresAt: firstExpiry,
      });

      await expect(
        methods.acquireSubagentThreadLease({
          user: 'takeover-user',
          conversationId,
          token: 'second',
          taskId: 'task-second',
          now: new Date(firstExpiry.getTime() - 1),
          expiresAt: new Date(firstExpiry.getTime() + 1_000),
        }),
      ).resolves.toBe(false);
      await expect(
        methods.acquireSubagentThreadLease({
          user: 'takeover-user',
          conversationId,
          token: 'second',
          taskId: 'task-second',
          now: firstExpiry,
          expiresAt: new Date(firstExpiry.getTime() + 1_000),
        }),
      ).resolves.toBe(true);
    });
  });

  describe('tenantId stripping', () => {
    it('saveConvo should not write caller-supplied tenantId to the document', async () => {
      const conversationId = uuidv4();
      const result = await saveConvo(
        { userId: 'user123' },
        { conversationId, tenantId: 'malicious-tenant', title: 'Tenant Test' },
      );

      expect(result).not.toBeNull();
      const doc = await Conversation.findOne({ conversationId }).lean();
      expect(doc).not.toBeNull();
      expect(doc?.title).toBe('Tenant Test');
      expect(doc?.tenantId).toBeUndefined();
    });

    it('bulkSaveConvos should not overwrite tenantId via update payload', async () => {
      const conversationId = uuidv4();

      await tenantStorage.run({ tenantId: 'real-tenant' }, async () => {
        await Conversation.create({
          conversationId,
          user: 'user123',
          title: 'Original',
          endpoint: EModelEndpoint.openAI,
        });
      });

      await tenantStorage.run({ tenantId: 'real-tenant' }, async () => {
        await methods.bulkSaveConvos([
          {
            conversationId,
            user: 'user123',
            title: 'Updated',
            tenantId: 'malicious-tenant',
            endpoint: EModelEndpoint.openAI,
          },
        ]);
      });

      const doc = await runAsSystem(async () => Conversation.findOne({ conversationId }).lean());
      expect(doc).not.toBeNull();
      expect(doc?.title).toBe('Updated');
      expect(doc?.tenantId).toBe('real-tenant');
    });

    it('bulkSaveConvos refreshes stats for cloned project conversations', async () => {
      const project = await ChatProject.create({
        user: 'user123',
        name: 'Bulk Project',
        conversationCount: 0,
        lastConversationAt: null,
        lastConversationId: null,
      });
      const conversationId = uuidv4();
      const createdAt = new Date('2026-01-01T00:00:00.000Z');

      await methods.bulkSaveConvos([
        {
          conversationId,
          user: 'user123',
          title: 'Cloned Project Chat',
          endpoint: EModelEndpoint.openAI,
          chatProjectId: project._id!.toString(),
          createdAt,
          updatedAt: createdAt,
        },
      ]);

      const refreshedProject = await ChatProject.findById(project._id).lean<IChatProject>();
      expect(refreshedProject?.conversationCount).toBe(1);
      expect(refreshedProject?.lastConversationId).toBe(conversationId);
      expect(refreshedProject?.lastConversationAt?.toISOString()).toBe(createdAt.toISOString());
    });
  });

  describe('getConvosByCursor search', () => {
    it('should include conversations matched only by message content', async () => {
      const titleMatch = await Conversation.create({
        conversationId: uuidv4(),
        user: 'user123',
        title: 'Contains keyword',
        endpoint: EModelEndpoint.openAI,
      });
      const contentMatch = await Conversation.create({
        conversationId: uuidv4(),
        user: 'user123',
        title: 'Unrelated title',
        endpoint: EModelEndpoint.openAI,
      });
      await Conversation.create({
        conversationId: uuidv4(),
        user: 'user123',
        title: 'No match anywhere',
        endpoint: EModelEndpoint.openAI,
      });

      const meiliSearch = jest
        .fn()
        .mockResolvedValue({ hits: [{ conversationId: titleMatch.conversationId }] });
      Object.assign(Conversation, { meiliSearch });
      searchMessages.mockResolvedValue({
        hits: [{ conversationId: contentMatch.conversationId }],
      });

      const result = await getConvosByCursor('user123', { search: 'keyword' });

      const searchParams = {
        filter: 'user = "user123"',
        limit: MEILI_SEARCH_LIMIT,
        attributesToRetrieve: ['conversationId', 'originalConversationId'],
      };
      expect(meiliSearch).toHaveBeenCalledWith('keyword', searchParams);
      expect(searchMessages).toHaveBeenCalledWith('keyword', searchParams);
      const convoIds = result?.conversations.map((c) => c.conversationId);
      expect(convoIds).toHaveLength(2);
      expect(convoIds).toContain(titleMatch.conversationId);
      expect(convoIds).toContain(contentMatch.conversationId);
    });

    it('should dedupe conversations matched by both title and message search', async () => {
      const overlapMatch = await Conversation.create({
        conversationId: uuidv4(),
        user: 'user123',
        title: 'Contains keyword',
        endpoint: EModelEndpoint.openAI,
      });
      const titleOnlyMatch = await Conversation.create({
        conversationId: uuidv4(),
        user: 'user123',
        title: 'Keyword in title',
        endpoint: EModelEndpoint.openAI,
      });
      const messageOnlyMatch = await Conversation.create({
        conversationId: uuidv4(),
        user: 'user123',
        title: 'Unrelated title',
        endpoint: EModelEndpoint.openAI,
      });

      const meiliSearch = jest.fn().mockResolvedValue({
        hits: [
          { conversationId: overlapMatch.conversationId },
          { conversationId: titleOnlyMatch.conversationId },
        ],
      });
      Object.assign(Conversation, { meiliSearch });
      searchMessages.mockResolvedValue({
        hits: [
          { conversationId: overlapMatch.conversationId },
          { conversationId: messageOnlyMatch.conversationId },
        ],
      });

      const result = await getConvosByCursor('user123', { search: 'keyword' });

      const searchParams = {
        filter: 'user = "user123"',
        limit: MEILI_SEARCH_LIMIT,
        attributesToRetrieve: ['conversationId', 'originalConversationId'],
      };
      expect(meiliSearch).toHaveBeenCalledWith('keyword', searchParams);
      expect(searchMessages).toHaveBeenCalledWith('keyword', searchParams);
      const convoIds = result?.conversations.map((c) => c.conversationId);
      expect(convoIds).toHaveLength(3);
      expect(convoIds).toContain(overlapMatch.conversationId);
      expect(convoIds).toContain(titleOnlyMatch.conversationId);
      expect(convoIds).toContain(messageOnlyMatch.conversationId);
    });

    it('should return an empty result when neither titles nor messages match', async () => {
      await Conversation.create({
        conversationId: uuidv4(),
        user: 'user123',
        title: 'No match anywhere',
        endpoint: EModelEndpoint.openAI,
      });

      Object.assign(Conversation, { meiliSearch: jest.fn().mockResolvedValue({ hits: [] }) });
      searchMessages.mockResolvedValue({ hits: [] });

      const result = await getConvosByCursor('user123', { search: 'keyword' });

      expect(result?.conversations).toHaveLength(0);
      expect(result?.nextCursor).toBeNull();
    });

    it('should fall back to title matches when the message index search fails', async () => {
      const titleMatch = await Conversation.create({
        conversationId: uuidv4(),
        user: 'user123',
        title: 'Contains keyword',
        endpoint: EModelEndpoint.openAI,
      });

      Object.assign(Conversation, {
        meiliSearch: jest
          .fn()
          .mockResolvedValue({ hits: [{ conversationId: titleMatch.conversationId }] }),
      });
      searchMessages.mockRejectedValue(new Error('MeiliSearch plugin not registered'));

      const result = await getConvosByCursor('user123', { search: 'keyword' });

      expect(result?.conversations.map((c) => c.conversationId)).toEqual([
        titleMatch.conversationId,
      ]);
    });

    it('should search titles when message methods are not injected', async () => {
      const titleMatch = await Conversation.create({
        conversationId: uuidv4(),
        user: 'user123',
        title: 'Contains keyword',
        endpoint: EModelEndpoint.openAI,
      });

      Object.assign(Conversation, {
        meiliSearch: jest
          .fn()
          .mockResolvedValue({ hits: [{ conversationId: titleMatch.conversationId }] }),
      });

      const scopedMethods = createConversationMethods(mongoose);
      const result = await scopedMethods.getConvosByCursor('user123', { search: 'keyword' });

      expect(result?.conversations.map((c) => c.conversationId)).toEqual([
        titleMatch.conversationId,
      ]);
    });
  });
});
