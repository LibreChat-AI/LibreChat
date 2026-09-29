import mongoose from 'mongoose';
import { EModelEndpoint } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Filter, Document as MongoDocument } from 'mongodb';
import type { SchemaWithMeiliMethods } from '~/models/plugins/mongoMeili';
import mongoMeili, {
  MEILI_INDEX_SCHEMA_VERSION,
  buildExcludedIndexedQuery,
} from '~/models/plugins/mongoMeili';
import { createConversationModel } from '~/models/convo';
import { createMessageModel } from '~/models/message';
import meiliLogger from '~/config/meiliLogger';

interface DynamicMeiliDocument extends mongoose.Document {
  docId: string;
  user: string;
  title: string;
  isTemporary?: boolean;
  expiredAt?: Date | null;
  _meiliIndex?: boolean;
  _meiliIndexAttempted?: boolean;
  _meiliIndexSchemaVersion?: number;
  _meiliCleanupVersion?: number;
}

type DynamicMeiliModel = mongoose.Model<DynamicMeiliDocument> & SchemaWithMeiliMethods;

const createDynamicMeiliModel = (modelName: string): DynamicMeiliModel => {
  const schema = new mongoose.Schema<DynamicMeiliDocument>({
    docId: {
      type: String,
      required: true,
      meiliIndex: true,
    },
    title: {
      type: String,
      meiliIndex: true,
    },
    user: {
      type: String,
      meiliIndex: true,
    },
    isTemporary: {
      type: Boolean,
      default: false,
    },
    expiredAt: {
      type: Date,
    },
  });

  schema.plugin(mongoMeili, {
    mongoose,
    host: 'foo',
    apiKey: 'bar',
    indexName: modelName.toLowerCase(),
    primaryKey: 'docId',
  });

  return mongoose.model<DynamicMeiliDocument>(modelName, schema) as unknown as DynamicMeiliModel;
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const waitForCondition = async (
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> => {
  const start = Date.now();
  while (!(await condition()) && Date.now() - start <= timeoutMs) {
    await wait(10);
  }
};

const waitForMock = (mock: jest.Mock, timeoutMs = 2000): Promise<void> =>
  waitForCondition(() => mock.mock.calls.length > 0, timeoutMs);

const waitForMockCalls = (mock: jest.Mock, callCount: number, timeoutMs = 2000): Promise<void> =>
  waitForCondition(() => mock.mock.calls.length >= callCount, timeoutMs);

const mockAddDocuments = jest.fn();
const mockAddDocumentsInBatches = jest.fn();
const mockUpdateDocuments = jest.fn();
const mockDeleteDocument = jest.fn();
const mockDeleteDocuments = jest.fn();
const mockGetDocument = jest.fn();
const mockGetDocuments = jest.fn().mockResolvedValue({ results: [] });
const mockWaitForTask = jest.fn().mockResolvedValue({ status: 'succeeded' });
const mockIndex = jest.fn().mockReturnValue({
  getRawInfo: jest.fn(),
  updateSettings: jest.fn(),
  addDocuments: mockAddDocuments,
  addDocumentsInBatches: mockAddDocumentsInBatches,
  updateDocuments: mockUpdateDocuments,
  deleteDocument: mockDeleteDocument,
  deleteDocuments: mockDeleteDocuments,
  getDocument: mockGetDocument,
  getDocuments: mockGetDocuments,
});
jest.mock('meilisearch', () => {
  return {
    MeiliSearch: jest.fn().mockImplementation(() => {
      return {
        index: mockIndex,
        waitForTask: mockWaitForTask,
      };
    }),
  };
});

describe('Meilisearch Mongoose plugin', () => {
  const OLD_ENV = process.env;

  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    process.env = {
      ...OLD_ENV,
      // Set a fake meilisearch host/key so that we activate the meilisearch plugin
      MEILI_HOST: 'foo',
      MEILI_MASTER_KEY: 'bar',
    };

    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);
  });

  beforeEach(() => {
    mockAddDocuments.mockReset().mockResolvedValue({ taskUid: 1 });
    mockAddDocumentsInBatches.mockClear();
    mockUpdateDocuments.mockReset().mockResolvedValue({ taskUid: 1 });
    mockDeleteDocument.mockReset().mockResolvedValue({ taskUid: 2 });
    mockDeleteDocuments.mockReset().mockResolvedValue({ taskUid: 1 });
    mockGetDocument.mockClear();
    mockGetDocuments.mockReset().mockResolvedValue({ results: [] });
    mockWaitForTask.mockReset().mockResolvedValue({ status: 'succeeded' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();

    process.env = OLD_ENV;
  });

  test('settles query updates and deletes when no document hook is available', async () => {
    const modelName = `QueryMiddlewareResult${Date.now()}`;
    const Model = createDynamicMeiliModel(modelName);
    try {
      await Model.create({ docId: 'query-result', user: 'user', title: 'Before' });
      await expect(
        Model.updateOne({ docId: 'query-result' }, { $set: { title: 'After' } }),
      ).resolves.toMatchObject({ matchedCount: 1, modifiedCount: 1 });
      await expect(Model.deleteOne({ docId: 'query-result' })).resolves.toMatchObject({
        deletedCount: 1,
      });
    } finally {
      mongoose.deleteModel(modelName);
    }
  });

  test('saving conversation indexes w/ meilisearch', async () => {
    await createConversationModel(mongoose).create({
      conversationId: new mongoose.Types.ObjectId(),
      user: new mongoose.Types.ObjectId(),
      title: 'Test Conversation',
      endpoint: EModelEndpoint.openAI,
    });
    await waitForMock(mockAddDocuments);
    expect(mockAddDocuments).toHaveBeenCalledWith(
      [expect.objectContaining({ conversationId: expect.anything() })],
      { primaryKey: 'conversationId' },
    );
  });

  test('saving conversation indexes with expiredAt=null w/ meilisearch', async () => {
    await createConversationModel(mongoose).create({
      conversationId: new mongoose.Types.ObjectId(),
      user: new mongoose.Types.ObjectId(),
      title: 'Test Conversation',
      endpoint: EModelEndpoint.openAI,
      expiredAt: null,
    });
    await waitForMock(mockAddDocuments);
    expect(mockAddDocuments).toHaveBeenCalled();
  });

  test('saving retained non-temporary conversation indexes w/ meilisearch', async () => {
    await createConversationModel(mongoose).create({
      conversationId: new mongoose.Types.ObjectId(),
      user: new mongoose.Types.ObjectId(),
      title: 'Test Conversation',
      endpoint: EModelEndpoint.openAI,
      isTemporary: false,
      expiredAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    await waitForMock(mockAddDocuments);
    expect(mockAddDocuments).toHaveBeenCalled();
  });

  test('saving a subagent thread does NOT index its conversation or messages', async () => {
    const conversationId = new mongoose.Types.ObjectId().toString();
    const user = new mongoose.Types.ObjectId().toString();

    await createConversationModel(mongoose).create({
      conversationId,
      user,
      title: 'Subagent thread',
      endpoint: EModelEndpoint.agents,
      subagentThread: {
        rootConversationId: 'root-conversation',
        parentConversationId: 'parent-conversation',
        parentMessageId: 'parent-message',
        parentToolCallId: 'parent-tool-call',
        subagentType: 'agent-child',
        subagentKind: 'agent',
        depth: 1,
      },
    });
    await createMessageModel(mongoose).create({
      messageId: new mongoose.Types.ObjectId().toString(),
      conversationId,
      user,
      isCreatedByUser: true,
      text: 'Private child transcript',
      subagentTask: {
        attemptKey: 'attempt-key',
        status: 'running',
      },
    });

    expect(mockAddDocuments).not.toHaveBeenCalled();
  });

  test('findOneAndUpdate loads the private child marker before deciding to index', async () => {
    const messageModel = createMessageModel(mongoose);
    const messageId = new mongoose.Types.ObjectId().toString();

    const savedMessage = await messageModel.findOneAndUpdate(
      { messageId, user: 'user-123' },
      {
        messageId,
        conversationId: new mongoose.Types.ObjectId().toString(),
        user: 'user-123',
        isCreatedByUser: true,
        text: 'Private child transcript',
        subagentTask: {
          attemptKey: 'attempt-key',
          status: 'running',
        },
      },
      { upsert: true, new: true },
    );

    expect(mockAddDocuments).not.toHaveBeenCalled();
    expect(savedMessage?.subagentTask).toBeUndefined();
  });

  test('findOneAndUpdate hides its injected private marker from lean results', async () => {
    const messageModel = createMessageModel(mongoose);
    const messageId = new mongoose.Types.ObjectId().toString();

    const savedMessage = await messageModel
      .findOneAndUpdate(
        { messageId, user: 'user-lean' },
        {
          messageId,
          conversationId: new mongoose.Types.ObjectId().toString(),
          user: 'user-lean',
          isCreatedByUser: true,
          text: 'Private child transcript',
          subagentTask: {
            attemptKey: 'attempt-key',
            status: 'running',
          },
        },
        { upsert: true, new: true, projection: { unfinished: 1 } },
      )
      .lean();

    expect(savedMessage).not.toBeNull();
    expect(savedMessage?.subagentTask).toBeUndefined();
    expect(mockAddDocuments).not.toHaveBeenCalled();
  });

  test('findOneAndUpdate preserves a private marker explicitly projected by a lean caller', async () => {
    const messageModel = createMessageModel(mongoose);
    const messageId = new mongoose.Types.ObjectId().toString();
    await messageModel.collection.insertOne({
      messageId,
      conversationId: new mongoose.Types.ObjectId().toString(),
      user: 'user-explicit',
      isCreatedByUser: true,
      text: 'Completed child result',
      subagentTask: {
        attemptKey: 'attempt-key',
        status: 'completed',
      },
    });

    const savedMessage = await messageModel
      .findOneAndUpdate(
        { messageId, user: 'user-explicit' },
        { $set: { 'subagentTask.resultClaim': { kind: 'manual', claimId: 'claim-1' } } },
        { new: true, projection: { messageId: 1, subagentTask: 1 } },
      )
      .lean();

    expect(savedMessage?.subagentTask).toMatchObject({
      status: 'completed',
      resultClaim: { kind: 'manual', claimId: 'claim-1' },
    });
    expect(mockAddDocuments).not.toHaveBeenCalled();
  });

  test('saving expired retained non-temporary conversation does NOT index w/ meilisearch', async () => {
    await createConversationModel(mongoose).create({
      conversationId: new mongoose.Types.ObjectId(),
      user: new mongoose.Types.ObjectId(),
      title: 'Test Conversation',
      endpoint: EModelEndpoint.openAI,
      isTemporary: false,
      expiredAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    expect(mockAddDocuments).not.toHaveBeenCalled();
  });

  test('saving temporary conversation does NOT index w/ meilisearch', async () => {
    await createConversationModel(mongoose).create({
      conversationId: new mongoose.Types.ObjectId(),
      user: new mongoose.Types.ObjectId(),
      title: 'Test Conversation',
      endpoint: EModelEndpoint.openAI,
      isTemporary: true,
      expiredAt: new Date(),
    });
    expect(mockAddDocuments).not.toHaveBeenCalled();
  });

  test('saving messages indexes w/ meilisearch', async () => {
    await createMessageModel(mongoose).create({
      messageId: new mongoose.Types.ObjectId(),
      conversationId: new mongoose.Types.ObjectId(),
      user: new mongoose.Types.ObjectId(),
      isCreatedByUser: true,
    });
    await waitForMock(mockAddDocuments);
    expect(mockAddDocuments).toHaveBeenCalledWith(
      [expect.objectContaining({ messageId: expect.anything() })],
      { primaryKey: 'messageId' },
    );
  });

  test('saving messages with expiredAt=null indexes w/ meilisearch', async () => {
    await createMessageModel(mongoose).create({
      messageId: new mongoose.Types.ObjectId(),
      conversationId: new mongoose.Types.ObjectId(),
      user: new mongoose.Types.ObjectId(),
      isCreatedByUser: true,
      expiredAt: null,
    });
    await waitForMock(mockAddDocuments);
    expect(mockAddDocuments).toHaveBeenCalled();
  });

  test('saving retained non-temporary messages indexes w/ meilisearch', async () => {
    await createMessageModel(mongoose).create({
      messageId: new mongoose.Types.ObjectId(),
      conversationId: new mongoose.Types.ObjectId(),
      user: new mongoose.Types.ObjectId(),
      isCreatedByUser: true,
      isTemporary: false,
      expiredAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    await waitForMock(mockAddDocuments);
    expect(mockAddDocuments).toHaveBeenCalled();
  });

  test('saving expired retained non-temporary message does NOT index w/ meilisearch', async () => {
    await createMessageModel(mongoose).create({
      messageId: new mongoose.Types.ObjectId(),
      conversationId: new mongoose.Types.ObjectId(),
      user: new mongoose.Types.ObjectId(),
      isCreatedByUser: true,
      isTemporary: false,
      expiredAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    expect(mockAddDocuments).not.toHaveBeenCalled();
  });

  test('saving temporary messages does NOT index w/ meilisearch', async () => {
    await createMessageModel(mongoose).create({
      messageId: new mongoose.Types.ObjectId(),
      conversationId: new mongoose.Types.ObjectId(),
      user: new mongoose.Types.ObjectId(),
      isCreatedByUser: true,
      isTemporary: true,
      expiredAt: new Date(),
    });
    expect(mockAddDocuments).not.toHaveBeenCalled();
  });

  test('updating an indexed conversation calls updateDocuments with primaryKey', async () => {
    const conversationModel = createConversationModel(
      mongoose,
    ) as unknown as SchemaWithMeiliMethods;
    const convo = await conversationModel.create({
      conversationId: new mongoose.Types.ObjectId().toString(),
      user: new mongoose.Types.ObjectId(),
      title: 'Original Title',
      endpoint: EModelEndpoint.openAI,
    });
    mockUpdateDocuments.mockClear();

    convo._meiliIndex = true;
    convo.title = 'Updated Title';
    await convo.save();

    await waitForMock(mockUpdateDocuments);
    expect(mockUpdateDocuments).toHaveBeenCalledWith(
      [expect.objectContaining({ conversationId: expect.anything() })],
      { primaryKey: 'conversationId' },
    );
  });

  test('updating an indexed message calls updateDocuments with primaryKey: messageId', async () => {
    const messageModel = createMessageModel(mongoose);
    const msg = await messageModel.create({
      messageId: new mongoose.Types.ObjectId().toString(),
      conversationId: new mongoose.Types.ObjectId(),
      user: new mongoose.Types.ObjectId(),
      isCreatedByUser: true,
    });
    mockUpdateDocuments.mockClear();

    msg._meiliIndex = true;
    msg.text = 'Updated text';
    await msg.save();

    await waitForMock(mockUpdateDocuments);
    expect(mockUpdateDocuments).toHaveBeenCalledWith(
      [expect.objectContaining({ messageId: expect.anything() })],
      { primaryKey: 'messageId' },
    );
  });

  test('deleteObjectFromMeili calls deleteDocument with messageId, not _id', async () => {
    const messageModel = createMessageModel(mongoose);
    const msgId = new mongoose.Types.ObjectId().toString();
    const msg = await messageModel.create({
      messageId: msgId,
      conversationId: new mongoose.Types.ObjectId(),
      user: new mongoose.Types.ObjectId(),
      isCreatedByUser: true,
    });
    mockDeleteDocument.mockClear();

    const typedMsg = msg as unknown as import('./mongoMeili').DocumentWithMeiliIndex;
    await new Promise<void>((resolve, reject) => {
      typedMsg.deleteObjectFromMeili!((err) => (err ? reject(err) : resolve()));
    });

    expect(mockDeleteDocument).toHaveBeenCalledWith(msgId);
    expect(mockDeleteDocument).not.toHaveBeenCalledWith(String(msg._id));
  });

  test('updateDocuments receives preprocessed data with primaryKey', async () => {
    const conversationModel = createConversationModel(
      mongoose,
    ) as unknown as SchemaWithMeiliMethods;
    const conversationId = 'abc|def|ghi';
    const convo = await conversationModel.create({
      conversationId,
      user: new mongoose.Types.ObjectId(),
      title: 'Pipe Test',
      endpoint: EModelEndpoint.openAI,
    });
    mockUpdateDocuments.mockClear();

    convo._meiliIndex = true;
    convo.title = 'Updated Pipe Test';
    await convo.save();

    await waitForMock(mockUpdateDocuments);
    expect(mockUpdateDocuments).toHaveBeenCalledWith(
      [expect.objectContaining({ conversationId: 'abc--def--ghi' })],
      { primaryKey: 'conversationId' },
    );
  });

  test('sync w/ meili does not include TTL documents', async () => {
    const conversationModel = createConversationModel(
      mongoose,
    ) as unknown as SchemaWithMeiliMethods;
    await conversationModel.create({
      conversationId: new mongoose.Types.ObjectId(),
      user: new mongoose.Types.ObjectId(),
      title: 'Test Conversation',
      endpoint: EModelEndpoint.openAI,
      isTemporary: true,
      expiredAt: new Date(),
    });

    await conversationModel.syncWithMeili();

    expect(mockAddDocuments).not.toHaveBeenCalled();
  });

  test('sync w/ meili excludes legacy temporary conversations without isTemporary', async () => {
    const conversationModel = createConversationModel(
      mongoose,
    ) as unknown as SchemaWithMeiliMethods;
    await conversationModel.deleteMany({});
    mockAddDocumentsInBatches.mockClear();
    const conversationId = new mongoose.Types.ObjectId().toString();

    await conversationModel.collection.insertOne({
      conversationId,
      user: new mongoose.Types.ObjectId().toString(),
      title: 'Legacy Temporary Conversation',
      endpoint: EModelEndpoint.openAI,
      expiredAt: new Date(Date.now() + 60 * 60 * 1000),
      _meiliIndex: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await conversationModel.syncWithMeili();
    const storedDoc = await conversationModel.collection.findOne({ conversationId });

    expect(mockAddDocumentsInBatches).not.toHaveBeenCalled();
    expect(storedDoc?._meiliIndex).toBe(false);
  });

  test('sync removes an existing child conversation from Meili and clears its index flag', async () => {
    const conversationModel = createConversationModel(
      mongoose,
    ) as unknown as SchemaWithMeiliMethods;
    await conversationModel.deleteMany({});
    const conversationId = new mongoose.Types.ObjectId().toString();

    await conversationModel.collection.insertOne({
      conversationId,
      user: new mongoose.Types.ObjectId().toString(),
      title: 'Indexed child conversation',
      endpoint: EModelEndpoint.agents,
      subagentThread: {
        rootConversationId: 'root-conversation',
        parentConversationId: 'parent-conversation',
        parentMessageId: 'parent-message',
        parentToolCallId: 'parent-tool-call',
        subagentType: 'agent-child',
        subagentKind: 'agent',
        depth: 1,
      },
      _meiliIndex: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockGetDocuments.mockResolvedValueOnce({ results: [{ conversationId }] });

    const progress = await conversationModel.getSyncProgress();
    await conversationModel.syncWithMeili();
    const storedDoc = await conversationModel.collection.findOne({ conversationId });

    expect(progress).toMatchObject({ pendingCleanup: 1, isComplete: false });
    expect(mockDeleteDocuments).toHaveBeenCalledWith([conversationId]);
    expect(mockWaitForTask).toHaveBeenCalledWith(1, {
      timeOutMs: 10000,
      intervalMs: 100,
    });
    expect(storedDoc?._meiliIndex).toBeUndefined();
  });

  test('keeps cleanup pending when Meili fails the asynchronous deletion task', async () => {
    const conversationModel = createConversationModel(
      mongoose,
    ) as unknown as SchemaWithMeiliMethods;
    await conversationModel.deleteMany({});
    const conversationId = new mongoose.Types.ObjectId().toString();

    await conversationModel.collection.insertOne({
      conversationId,
      user: new mongoose.Types.ObjectId().toString(),
      title: 'Indexed child conversation',
      endpoint: EModelEndpoint.agents,
      subagentThread: {
        rootConversationId: 'root-conversation',
        parentConversationId: 'parent-conversation',
        parentMessageId: 'parent-message',
        parentToolCallId: 'parent-tool-call',
        subagentType: 'agent-child',
        subagentKind: 'agent',
        depth: 1,
      },
      _meiliIndex: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockGetDocuments.mockResolvedValueOnce({ results: [{ conversationId }] });
    mockWaitForTask.mockResolvedValueOnce({ status: 'failed' });

    await conversationModel.syncWithMeili();
    const storedDoc = await conversationModel.collection.findOne({ conversationId });

    expect(mockDeleteDocuments).toHaveBeenCalledWith([conversationId]);
    expect(storedDoc?._meiliIndex).toBe(true);
  });

  test('retries update-hook deletion before clearing an indexed marker', async () => {
    const conversationModel = createConversationModel(
      mongoose,
    ) as unknown as SchemaWithMeiliMethods;
    await conversationModel.deleteMany({});
    const conversationId = new mongoose.Types.ObjectId().toString();

    await conversationModel.create({
      conversationId,
      user: new mongoose.Types.ObjectId().toString(),
      title: 'Initially searchable conversation',
      endpoint: EModelEndpoint.agents,
    });
    await waitForMock(mockAddDocuments);
    let indexed = false;
    const acknowledgmentStart = Date.now();
    while (!indexed && Date.now() - acknowledgmentStart <= 2000) {
      indexed =
        (
          await conversationModel
            .findOne({ conversationId })
            .select('+_meiliIndex +_meiliIndexAttempted')
        )?._meiliIndex === true;
      await wait(10);
    }
    const conversation = await conversationModel
      .findOne({ conversationId })
      .select('+_meiliIndex +_meiliIndexAttempted');
    expect(conversation?._meiliIndex).toBe(true);
    expect(conversation?._meiliIndexAttempted).toBe(true);
    mockWaitForTask.mockClear();

    conversation!.subagentThread = {
      rootConversationId: 'root-conversation',
      parentConversationId: 'parent-conversation',
      parentMessageId: 'parent-message',
      parentToolCallId: 'parent-tool-call',
      subagentType: 'agent-child',
      subagentKind: 'agent',
      depth: 1,
    };
    mockWaitForTask.mockResolvedValueOnce({ status: 'failed' }).mockImplementationOnce(async () => {
      await wait(50);
      return { status: 'succeeded' };
    });
    await conversation!.save();
    await waitForMockCalls(mockWaitForTask, 2);
    await waitForCondition(async () => {
      const storedDoc = await conversationModel.collection.findOne({ conversationId });
      return storedDoc?._meiliIndex === undefined && storedDoc?._meiliIndexAttempted === undefined;
    });
    const storedDoc = await conversationModel.collection.findOne({ conversationId });

    expect(mockDeleteDocument).toHaveBeenCalledTimes(2);
    expect(mockWaitForTask).toHaveBeenCalledWith(2, {
      timeOutMs: 10000,
      intervalMs: 100,
    });
    expect(storedDoc?._meiliIndex).toBeUndefined();
    expect(storedDoc?._meiliIndexAttempted).toBeUndefined();
  });

  test('retries cleanup when Meili deletion succeeds before the Mongo flag update fails', async () => {
    const conversationModel = createConversationModel(
      mongoose,
    ) as unknown as SchemaWithMeiliMethods;
    await conversationModel.deleteMany({});
    const conversationId = new mongoose.Types.ObjectId().toString();

    await conversationModel.collection.insertOne({
      conversationId,
      user: new mongoose.Types.ObjectId().toString(),
      title: 'Indexed child conversation',
      endpoint: EModelEndpoint.agents,
      subagentThread: {
        rootConversationId: 'root-conversation',
        parentConversationId: 'parent-conversation',
        parentMessageId: 'parent-message',
        parentToolCallId: 'parent-tool-call',
        subagentType: 'agent-child',
        subagentKind: 'agent',
        depth: 1,
      },
      _meiliIndex: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    jest
      .spyOn(conversationModel, 'updateMany')
      .mockRejectedValueOnce(new Error('Mongo acknowledgment failed'));

    await conversationModel.syncWithMeili();
    expect((await conversationModel.collection.findOne({ conversationId }))?._meiliIndex).toBe(
      true,
    );

    mockGetDocuments.mockResolvedValue({ results: [] });
    await conversationModel.syncWithMeili();
    expect(mockDeleteDocuments).toHaveBeenCalledTimes(2);
    expect(
      (await conversationModel.collection.findOne({ conversationId }))?._meiliIndex,
    ).toBeUndefined();
  });

  test('saving hydrated legacy temporary conversations without isTemporary does NOT index', async () => {
    const conversationModel = createConversationModel(
      mongoose,
    ) as unknown as SchemaWithMeiliMethods;
    await conversationModel.deleteMany({});
    mockAddDocuments.mockClear();
    mockUpdateDocuments.mockClear();
    const conversationId = new mongoose.Types.ObjectId().toString();

    await conversationModel.collection.insertOne({
      conversationId,
      user: new mongoose.Types.ObjectId().toString(),
      title: 'Legacy Temporary Conversation',
      endpoint: EModelEndpoint.openAI,
      expiredAt: new Date(Date.now() + 60 * 60 * 1000),
      _meiliIndex: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const legacyConvo = await conversationModel.findOne({ conversationId });
    expect(legacyConvo).toBeTruthy();

    legacyConvo!.title = 'Updated Legacy Temporary Conversation';
    await legacyConvo!.save();
    const storedDoc = await conversationModel.collection.findOne({ conversationId });

    expect(mockAddDocuments).not.toHaveBeenCalled();
    expect(mockUpdateDocuments).not.toHaveBeenCalled();
    expect(storedDoc?._meiliIndex).toBe(false);
  });

  test('findOneAndUpdate on legacy temporary conversations without isTemporary does NOT index', async () => {
    const conversationModel = createConversationModel(
      mongoose,
    ) as unknown as SchemaWithMeiliMethods;
    await conversationModel.deleteMany({});
    mockAddDocuments.mockClear();
    mockUpdateDocuments.mockClear();
    const conversationId = new mongoose.Types.ObjectId().toString();

    await conversationModel.collection.insertOne({
      conversationId,
      user: new mongoose.Types.ObjectId().toString(),
      title: 'Legacy Temporary Conversation',
      endpoint: EModelEndpoint.openAI,
      expiredAt: new Date(Date.now() + 60 * 60 * 1000),
      _meiliIndex: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await conversationModel.findOneAndUpdate(
      { conversationId },
      { $set: { title: 'Updated via findOneAndUpdate' } },
      { new: true },
    );
    const storedDoc = await conversationModel.collection.findOne({ conversationId });

    expect(mockAddDocuments).not.toHaveBeenCalled();
    expect(mockUpdateDocuments).not.toHaveBeenCalled();
    expect(storedDoc?._meiliIndex).toBe(false);
  });

  test('sync w/ meili excludes legacy temporary messages without isTemporary', async () => {
    const messageModel = createMessageModel(mongoose) as unknown as SchemaWithMeiliMethods;
    await messageModel.deleteMany({});
    mockAddDocumentsInBatches.mockClear();
    const messageId = new mongoose.Types.ObjectId().toString();

    await messageModel.collection.insertOne({
      messageId,
      conversationId: new mongoose.Types.ObjectId().toString(),
      user: new mongoose.Types.ObjectId().toString(),
      isCreatedByUser: true,
      text: 'Legacy temporary message',
      expiredAt: new Date(Date.now() + 60 * 60 * 1000),
      _meiliIndex: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await messageModel.syncWithMeili();
    const storedDoc = await messageModel.collection.findOne({ messageId });

    expect(mockAddDocumentsInBatches).not.toHaveBeenCalled();
    expect(storedDoc?._meiliIndex).toBe(false);
  });

  test('does not schedule cleanup for a child message that was never indexed', async () => {
    const messageModel = createMessageModel(mongoose) as unknown as SchemaWithMeiliMethods;
    await messageModel.deleteMany({});
    const messageId = new mongoose.Types.ObjectId().toString();

    await messageModel.collection.insertOne({
      messageId,
      conversationId: new mongoose.Types.ObjectId().toString(),
      user: new mongoose.Types.ObjectId().toString(),
      isCreatedByUser: true,
      text: 'Indexed child transcript',
      subagentTask: {
        attemptKey: 'attempt-key',
        status: 'completed',
      },
      _meiliIndex: false,
      _meiliCleanupVersion: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const progress = await messageModel.getSyncProgress();
    await messageModel.cleanupExcludedMeiliIndex();
    const storedDoc = await messageModel.collection.findOne({ messageId });

    expect(progress).toMatchObject({ pendingCleanup: 0, isComplete: true });
    expect(mockDeleteDocuments).not.toHaveBeenCalled();
    expect(mockGetDocuments).not.toHaveBeenCalled();
    expect(storedDoc?._meiliIndex).toBe(false);
  });

  test('reconciles a legacy excluded false marker exactly once', async () => {
    const messageModel = createMessageModel(mongoose) as unknown as SchemaWithMeiliMethods;
    await messageModel.deleteMany({});
    const messageId = new mongoose.Types.ObjectId().toString();

    await messageModel.collection.insertOne({
      messageId,
      conversationId: new mongoose.Types.ObjectId().toString(),
      user: new mongoose.Types.ObjectId().toString(),
      isCreatedByUser: true,
      text: 'Legacy child transcript with an ambiguous deletion result',
      subagentTask: {
        attemptKey: 'legacy-attempt-key',
        status: 'completed',
      },
      _meiliIndex: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const progressBefore = await messageModel.getSyncProgress();
    await messageModel.cleanupExcludedMeiliIndex();
    const progressAfter = await messageModel.getSyncProgress();
    const storedDoc = await messageModel.collection.findOne({ messageId });

    expect(progressBefore).toMatchObject({ pendingCleanup: 1, isComplete: false });
    expect(progressAfter).toMatchObject({ pendingCleanup: 0, isComplete: true });
    expect(mockDeleteDocuments).toHaveBeenCalledWith([messageId]);
    expect(storedDoc?._meiliIndex).toBeUndefined();
    expect(storedDoc?._meiliCleanupVersion).toBe(1);
  });

  test('cleans an excluded child when an earlier Meili add was attempted but not acknowledged', async () => {
    const messageModel = createMessageModel(mongoose) as unknown as SchemaWithMeiliMethods;
    await messageModel.deleteMany({});
    const messageId = new mongoose.Types.ObjectId().toString();

    await messageModel.collection.insertOne({
      messageId,
      conversationId: new mongoose.Types.ObjectId().toString(),
      user: new mongoose.Types.ObjectId().toString(),
      isCreatedByUser: true,
      text: 'Possibly indexed child transcript',
      subagentTask: {
        attemptKey: 'attempt-key',
        status: 'completed',
      },
      _meiliIndex: false,
      _meiliIndexAttempted: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const progress = await messageModel.getSyncProgress();
    await messageModel.cleanupExcludedMeiliIndex();
    const storedDoc = await messageModel.collection.findOne({ messageId });

    expect(progress).toMatchObject({ pendingCleanup: 1, isComplete: false });
    expect(mockDeleteDocuments).toHaveBeenCalledWith([messageId]);
    expect(storedDoc?._meiliIndex).toBeUndefined();
    expect(storedDoc?._meiliIndexAttempted).toBeUndefined();
  });

  test('defines partial indexes for pending excluded-document cleanup', () => {
    const conversationIndexes = createConversationModel(mongoose).schema.indexes();
    const messageIndexes = createMessageModel(mongoose).schema.indexes();

    expect(conversationIndexes).toContainEqual([
      { _meiliIndex: 1, conversationId: 1 },
      expect.objectContaining({
        name: 'meili_excluded_indexed_cleanup_v3',
        partialFilterExpression: {
          subagentThread: { $exists: true },
          _meiliIndex: { $eq: true },
        },
      }),
    ]);
    expect(conversationIndexes).toContainEqual([
      { _meiliIndexAttempted: 1, conversationId: 1 },
      expect.objectContaining({
        name: 'meili_excluded_attempted_cleanup_v3',
        partialFilterExpression: {
          subagentThread: { $exists: true },
          _meiliIndexAttempted: { $eq: true },
        },
      }),
    ]);
    expect(conversationIndexes).toContainEqual([
      { _meiliIndex: 1, _meiliCleanupVersion: 1, conversationId: 1 },
      expect.objectContaining({
        name: 'meili_excluded_legacy_cleanup_v4',
        partialFilterExpression: {
          subagentThread: { $exists: true },
          _meiliIndex: { $eq: false },
          _meiliCleanupVersion: { $eq: null },
        },
      }),
    ]);
    expect(messageIndexes).toContainEqual([
      { _meiliIndex: 1, messageId: 1 },
      expect.objectContaining({
        name: 'meili_excluded_indexed_cleanup_v3',
        partialFilterExpression: {
          subagentTask: { $exists: true },
          _meiliIndex: { $eq: true },
        },
      }),
    ]);
    expect(messageIndexes).toContainEqual([
      { _meiliIndexAttempted: 1, messageId: 1 },
      expect.objectContaining({
        name: 'meili_excluded_attempted_cleanup_v3',
        partialFilterExpression: {
          subagentTask: { $exists: true },
          _meiliIndexAttempted: { $eq: true },
        },
      }),
    ]);
    expect(messageIndexes).toContainEqual([
      { _meiliIndex: 1, _meiliCleanupVersion: 1, messageId: 1 },
      expect.objectContaining({
        name: 'meili_excluded_legacy_cleanup_v4',
        partialFilterExpression: {
          subagentTask: { $exists: true },
          _meiliIndex: { $eq: false },
          _meiliCleanupVersion: { $eq: null },
        },
      }),
    ]);
  });

  test('sync w/ meili treats null isTemporary with no expiration like missing legacy fields', async () => {
    const modelName = `DynamicMeiliNullTemporary${new mongoose.Types.ObjectId().toString()}`;
    const dynamicModel = createDynamicMeiliModel(modelName);
    mockAddDocumentsInBatches.mockClear();

    try {
      await dynamicModel.collection.insertOne({
        docId: 'legacy-null-temporary',
        user: 'user-123',
        title: 'Legacy Null Temporary',
        isTemporary: null as unknown as boolean,
        expiredAt: null,
        _meiliIndex: false,
      });

      const progress = await dynamicModel.getSyncProgress();
      await dynamicModel.syncWithMeili();
      const storedDoc = await dynamicModel.collection.findOne({ docId: 'legacy-null-temporary' });

      expect(progress.totalDocuments).toBe(1);
      expect(mockAddDocumentsInBatches).toHaveBeenCalled();
      expect(storedDoc?._meiliIndex).toBe(true);
    } finally {
      await mongoose.connection.dropCollection(modelName.toLowerCase()).catch(() => undefined);
      delete mongoose.models[modelName];
    }
  });

  test('sync queries use a fresh expiration cutoff after plugin initialization', async () => {
    const modelName = `DynamicMeiliCutoff${new mongoose.Types.ObjectId().toString()}`;
    const dynamicModel = createDynamicMeiliModel(modelName);
    mockAddDocumentsInBatches.mockClear();

    try {
      await dynamicModel.collection.insertOne({
        docId: 'expires-soon',
        user: 'user-123',
        title: 'Expires Soon',
        isTemporary: false,
        expiredAt: new Date(Date.now() + 25),
        _meiliIndex: false,
      });

      await wait(100);

      const progress = await dynamicModel.getSyncProgress();
      await dynamicModel.syncWithMeili();
      const storedDoc = await dynamicModel.collection.findOne({ docId: 'expires-soon' });

      expect(progress.totalDocuments).toBe(0);
      expect(mockAddDocumentsInBatches).not.toHaveBeenCalled();
      expect(storedDoc?._meiliIndex).toBe(false);
    } finally {
      await dynamicModel.deleteMany({});
      mongoose.deleteModel(modelName);
    }
  });

  describe('estimatedDocumentCount usage in syncWithMeili', () => {
    test('syncWithMeili completes successfully with estimatedDocumentCount', async () => {
      // Clear any previous documents
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});

      // Create test documents
      await conversationModel.create({
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        title: 'Test Conversation 1',
        endpoint: EModelEndpoint.openAI,
      });

      await conversationModel.create({
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        title: 'Test Conversation 2',
        endpoint: EModelEndpoint.openAI,
      });

      // Trigger sync - should use estimatedDocumentCount internally
      await expect(conversationModel.syncWithMeili()).resolves.not.toThrow();

      // Verify documents were processed
      expect(mockAddDocuments).toHaveBeenCalled();
    });

    test('syncWithMeili handles empty collection correctly', async () => {
      const messageModel = createMessageModel(mongoose) as unknown as SchemaWithMeiliMethods;
      await messageModel.deleteMany({});

      // Verify collection is empty
      const count = await messageModel.estimatedDocumentCount();
      expect(count).toBe(0);

      // Sync should complete without error even with 0 estimated documents
      await expect(messageModel.syncWithMeili()).resolves.not.toThrow();
    });

    test('estimatedDocumentCount returns count for non-empty collection', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});

      // Create documents
      await conversationModel.create({
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        title: 'Test 1',
        endpoint: EModelEndpoint.openAI,
      });

      await conversationModel.create({
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        title: 'Test 2',
        endpoint: EModelEndpoint.openAI,
      });

      const estimatedCount = await conversationModel.estimatedDocumentCount();
      expect(estimatedCount).toBeGreaterThanOrEqual(2);
    });

    test('estimatedDocumentCount is available on model', async () => {
      const messageModel = createMessageModel(mongoose) as unknown as SchemaWithMeiliMethods;

      // Verify the method exists and is callable
      expect(typeof messageModel.estimatedDocumentCount).toBe('function');

      // Should be able to call it
      const result = await messageModel.estimatedDocumentCount();
      expect(typeof result).toBe('number');
      expect(result).toBeGreaterThanOrEqual(0);
    });

    test('syncWithMeili handles mix of syncable and TTL documents correctly', async () => {
      const messageModel = createMessageModel(mongoose) as unknown as SchemaWithMeiliMethods;
      await messageModel.deleteMany({});
      mockAddDocuments.mockClear();

      // Create syncable documents (expiredAt: null)
      await messageModel.create({
        messageId: new mongoose.Types.ObjectId(),
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        isCreatedByUser: true,
        expiredAt: null,
      });

      await messageModel.create({
        messageId: new mongoose.Types.ObjectId(),
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        isCreatedByUser: false,
        expiredAt: null,
      });

      // Create TTL documents (expiredAt set to a date)
      await messageModel.create({
        messageId: new mongoose.Types.ObjectId(),
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        isCreatedByUser: true,
        isTemporary: true,
        expiredAt: new Date(),
      });

      await messageModel.create({
        messageId: new mongoose.Types.ObjectId(),
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        isCreatedByUser: false,
        isTemporary: true,
        expiredAt: new Date(),
      });

      // estimatedDocumentCount should count all documents (both syncable and TTL)
      const estimatedCount = await messageModel.estimatedDocumentCount();
      expect(estimatedCount).toBe(4);

      // Actual syncable documents (expiredAt: null)
      const syncableCount = await messageModel.countDocuments({ expiredAt: null });
      expect(syncableCount).toBe(2);

      // Sync should complete successfully even though estimated count is higher than processed count
      await expect(messageModel.syncWithMeili()).resolves.not.toThrow();

      // Only syncable documents should be indexed (2 documents, not 4)
      // The mock should be called once per batch, and we have 2 documents
      expect(mockAddDocuments).toHaveBeenCalled();

      // Verify that only 2 documents were indexed (the syncable ones)
      const indexedCount = await messageModel.countDocuments({ _meiliIndex: true });
      expect(indexedCount).toBe(2);
    });
  });

  describe('New batch processing and retry functionality', () => {
    test('processSyncBatch uses addDocumentsInBatches', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});
      mockAddDocumentsInBatches.mockClear();
      mockAddDocuments.mockClear();

      await conversationModel.collection.insertOne({
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        title: 'Test Conversation',
        endpoint: EModelEndpoint.openAI,
        _meiliIndex: false,
        expiredAt: null,
      });

      // Run sync which should call processSyncBatch internally
      await conversationModel.syncWithMeili();

      // Verify addDocumentsInBatches was called with explicit primaryKey
      expect(mockAddDocumentsInBatches).toHaveBeenCalledWith(expect.any(Array), undefined, {
        primaryKey: 'conversationId',
      });
    });

    test('a transient document-write failure retries without delaying MongoDB persistence', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      let rejectMeiliWrite: ((reason?: Error) => void) | undefined;
      await conversationModel.deleteMany({});

      mockAddDocuments.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectMeiliWrite = reject;
          }),
      );

      const conversation = await conversationModel.create({
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        title: 'Detached Write',
        endpoint: EModelEndpoint.openAI,
      });

      await waitForMock(mockAddDocuments);
      expect(rejectMeiliWrite).toBeDefined();
      expect(mockAddDocuments).toHaveBeenCalledTimes(1);

      rejectMeiliWrite!(new Error('Network error'));
      await waitForMockCalls(mockAddDocuments, 2);
      await waitForCondition(async () => {
        const storedDoc = await conversationModel.collection.findOne({ _id: conversation._id });
        return storedDoc?._meiliIndex === true && storedDoc?._meiliIndexAttempted === true;
      });

      const storedConversation = await conversationModel.collection.findOne({
        _id: conversation._id,
      });
      expect(mockAddDocuments).toHaveBeenCalledTimes(2);
      expect(storedConversation?._meiliIndex).toBe(true);
      expect(storedConversation?._meiliIndexAttempted).toBe(true);
      expect(await conversationModel.getSyncProgress()).toMatchObject({ pendingIndexing: 0 });
    });

    test('a persistently failed document update stays marked for reconciliation', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      const finalError = new Error('Final network error');
      const errorSpy = jest.spyOn(meiliLogger, 'error').mockImplementation(() => meiliLogger);
      await conversationModel.deleteMany({});

      const conversation = await conversationModel.create({
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        title: 'Indexed Conversation',
        endpoint: EModelEndpoint.openAI,
      });
      await waitForMock(mockAddDocuments);
      await waitForCondition(async () => {
        const storedDoc = await conversationModel.collection.findOne({ _id: conversation._id });
        return storedDoc?._meiliIndex === true;
      });
      errorSpy.mockClear();
      mockUpdateDocuments
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(finalError);

      conversation._meiliIndex = true;
      conversation.title = 'Updated Conversation';
      await conversation.save();

      expect(
        (await conversationModel.collection.findOne({ _id: conversation._id }))?._meiliIndex,
      ).toBe(false);
      await waitForMockCalls(mockUpdateDocuments, 3);
      await waitForCondition(() => errorSpy.mock.calls.length > 0);

      const storedConversation = await conversationModel.collection.findOne({
        _id: conversation._id,
      });
      expect(errorSpy).toHaveBeenCalledWith(
        '[updateObjectToMeili] Error updating document in Meili:',
        finalError,
      );
      expect(mockUpdateDocuments).toHaveBeenCalledTimes(3);
      expect(storedConversation?._meiliIndex).toBe(false);
      expect(storedConversation?._meiliIndexAttempted).toBe(true);
    });

    test('a stale replica write is followed by the latest MongoDB snapshot', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      let resolveStaleWrite: ((result: { taskUid: number }) => void) | undefined;
      await conversationModel.deleteMany({});
      mockAddDocuments.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStaleWrite = resolve;
          }),
      );

      const conversation = await conversationModel.create({
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        title: 'Stale Replica Snapshot',
        endpoint: EModelEndpoint.openAI,
      });
      await waitForMock(mockAddDocuments);

      const latestVersion = new mongoose.Types.ObjectId().toString();
      await conversationModel.collection.updateOne(
        { _id: conversation._id },
        {
          $set: {
            title: 'Latest Replica Snapshot',
            _meiliIndex: true,
            _meiliIndexAttempted: true,
            _meiliIndexVersion: latestVersion,
            _meiliCleanupVersion: 0,
          },
        },
      );

      resolveStaleWrite!({ taskUid: 1 });
      await waitForMockCalls(mockAddDocuments, 2);
      await waitForCondition(async () => {
        const storedDoc = await conversationModel.collection.findOne({ _id: conversation._id });
        return (
          storedDoc?._meiliIndex === true &&
          storedDoc?._meiliIndexVersion === latestVersion &&
          storedDoc?._meiliCleanupVersion === 1
        );
      });

      expect(mockAddDocuments.mock.calls[1]).toEqual([
        [expect.objectContaining({ title: 'Latest Replica Snapshot' })],
        { primaryKey: 'conversationId' },
      ]);
      expect(await conversationModel.collection.findOne({ _id: conversation._id })).toMatchObject({
        _meiliIndex: true,
        _meiliIndexVersion: latestVersion,
        _meiliCleanupVersion: 1,
      });
    });

    test('getSyncProgress returns accurate progress information', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});

      // Insert documents directly to control the _meiliIndex flag
      await conversationModel.collection.insertOne({
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        title: 'Indexed',
        endpoint: EModelEndpoint.openAI,
        _meiliIndex: true,
        _meiliIndexSchemaVersion: MEILI_INDEX_SCHEMA_VERSION,
        expiredAt: null,
      });

      await conversationModel.collection.insertOne({
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        title: 'Not Indexed',
        endpoint: EModelEndpoint.openAI,
        _meiliIndex: false,
        expiredAt: null,
      });

      const progress = await conversationModel.getSyncProgress();

      expect(progress.totalDocuments).toBe(2);
      expect(progress.totalProcessed).toBe(1);
      expect(progress.isComplete).toBe(false);
    });

    test('reindexes documents from an older indexed schema version', async () => {
      const conversationModel = mongoose.models.Conversation as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});

      await conversationModel.collection.insertOne({
        conversationId: new mongoose.Types.ObjectId().toString(),
        user: new mongoose.Types.ObjectId(),
        title: 'Legacy Indexed Conversation',
        endpoint: EModelEndpoint.openAI,
        _meiliIndex: true,
        _meiliIndexSchemaVersion: MEILI_INDEX_SCHEMA_VERSION - 1,
        expiredAt: null,
      });

      const progress = await conversationModel.getSyncProgress();

      expect(progress.totalProcessed).toBe(0);
      expect(progress.pendingIndexing).toBe(1);

      await conversationModel.syncWithMeili();

      expect(
        (
          await conversationModel
            .findOne({ title: 'Legacy Indexed Conversation' })
            .select('+_meiliIndexSchemaVersion')
        )?._meiliIndexSchemaVersion,
      ).toBe(MEILI_INDEX_SCHEMA_VERSION);
    });

    test('getSyncProgress excludes TTL documents from counts', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});

      // Insert syncable documents (expiredAt: null)
      await conversationModel.collection.insertOne({
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        title: 'Syncable Indexed',
        endpoint: EModelEndpoint.openAI,
        _meiliIndex: true,
        _meiliIndexSchemaVersion: MEILI_INDEX_SCHEMA_VERSION,
        expiredAt: null,
      });

      await conversationModel.collection.insertOne({
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        title: 'Syncable Not Indexed',
        endpoint: EModelEndpoint.openAI,
        _meiliIndex: false,
        expiredAt: null,
      });

      // Insert TTL documents (expiredAt set) - these should NOT be counted
      await conversationModel.collection.insertOne({
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        title: 'TTL Document 1',
        endpoint: EModelEndpoint.openAI,
        _meiliIndex: true,
        expiredAt: new Date(),
      });

      await conversationModel.collection.insertOne({
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        title: 'TTL Document 2',
        endpoint: EModelEndpoint.openAI,
        _meiliIndex: false,
        expiredAt: new Date(),
      });

      const progress = await conversationModel.getSyncProgress();

      // Only syncable documents should be counted (2 total, 1 indexed)
      expect(progress.totalDocuments).toBe(2);
      expect(progress.totalProcessed).toBe(1);
      expect(progress.isComplete).toBe(false);
    });

    test('getSyncProgress shows completion when all syncable documents are indexed', async () => {
      const messageModel = createMessageModel(mongoose) as unknown as SchemaWithMeiliMethods;
      await messageModel.deleteMany({});

      // All syncable documents are indexed
      await messageModel.collection.insertOne({
        messageId: new mongoose.Types.ObjectId(),
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        isCreatedByUser: true,
        _meiliIndex: true,
        _meiliIndexSchemaVersion: MEILI_INDEX_SCHEMA_VERSION,
        expiredAt: null,
      });

      await messageModel.collection.insertOne({
        messageId: new mongoose.Types.ObjectId(),
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        isCreatedByUser: false,
        _meiliIndex: true,
        _meiliIndexSchemaVersion: MEILI_INDEX_SCHEMA_VERSION,
        expiredAt: null,
      });

      // Add TTL document - should not affect completion status
      await messageModel.collection.insertOne({
        messageId: new mongoose.Types.ObjectId(),
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        isCreatedByUser: true,
        _meiliIndex: false,
        expiredAt: new Date(),
      });

      const progress = await messageModel.getSyncProgress();

      expect(progress.totalDocuments).toBe(2);
      expect(progress.totalProcessed).toBe(2);
      expect(progress.isComplete).toBe(true);
    });
  });

  describe('Error handling in processSyncBatch', () => {
    test('syncWithMeili fails when processSyncBatch encounters addDocumentsInBatches error', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});
      mockAddDocumentsInBatches.mockClear();

      // Insert a document to sync
      await conversationModel.collection.insertOne({
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        title: 'Test Conversation',
        endpoint: EModelEndpoint.openAI,
        _meiliIndex: false,
        expiredAt: null,
      });

      // Mock addDocumentsInBatches to fail
      mockAddDocumentsInBatches.mockRejectedValueOnce(new Error('MeiliSearch connection error'));

      // Sync should throw the error
      await expect(conversationModel.syncWithMeili()).rejects.toThrow(
        'MeiliSearch connection error',
      );

      // Verify the error was logged
      expect(mockAddDocumentsInBatches).toHaveBeenCalled();

      // Document should NOT be marked as indexed since sync failed
      // Note: direct collection.insertOne doesn't set default values, so _meiliIndex may be undefined
      const doc = await conversationModel.findOne({});
      expect(doc?._meiliIndex).not.toBe(true);
    });

    test('syncWithMeili fails when processSyncBatch encounters updateMany error', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});
      mockAddDocumentsInBatches.mockClear();

      // Insert a document
      await conversationModel.collection.insertOne({
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        title: 'Test Conversation',
        endpoint: EModelEndpoint.openAI,
        _meiliIndex: false,
        expiredAt: null,
      });

      // Mock addDocumentsInBatches to succeed but simulate updateMany failure
      mockAddDocumentsInBatches.mockResolvedValueOnce({});

      // Spy on updateMany and make it fail
      const updateManySpy = jest
        .spyOn(conversationModel, 'updateMany')
        .mockResolvedValueOnce({
          acknowledged: true,
          matchedCount: 1,
          modifiedCount: 1,
          upsertedCount: 0,
          upsertedId: null,
        })
        .mockRejectedValueOnce(new Error('Database connection error'));

      // Sync should throw the error
      await expect(conversationModel.syncWithMeili()).rejects.toThrow('Database connection error');

      expect(updateManySpy).toHaveBeenCalled();

      // Restore original implementation
      updateManySpy.mockRestore();
    });

    test('processSyncBatch logs error and throws when addDocumentsInBatches fails', async () => {
      const messageModel = createMessageModel(mongoose) as unknown as SchemaWithMeiliMethods;
      await messageModel.deleteMany({});

      mockAddDocumentsInBatches.mockRejectedValueOnce(new Error('Network timeout'));

      await messageModel.collection.insertOne({
        messageId: new mongoose.Types.ObjectId(),
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        isCreatedByUser: true,
        _meiliIndex: false,
        expiredAt: null,
      });

      const indexMock = mockIndex();
      const documents = await messageModel.find({ _meiliIndex: false }).lean();

      // Should throw the error
      await expect(messageModel.processSyncBatch(indexMock, documents)).rejects.toThrow(
        'Network timeout',
      );

      expect(mockAddDocumentsInBatches).toHaveBeenCalled();
    });

    test('processSyncBatch handles empty document array gracefully', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      const indexMock = mockIndex();

      // Should not throw with empty array
      await expect(conversationModel.processSyncBatch(indexMock, [])).resolves.not.toThrow();

      // Should not call addDocumentsInBatches
      expect(mockAddDocumentsInBatches).not.toHaveBeenCalled();
    });

    test('syncWithMeili stops processing when batch fails and does not process remaining documents', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});
      mockAddDocumentsInBatches.mockClear();

      // Create multiple documents
      for (let i = 0; i < 5; i++) {
        await conversationModel.collection.insertOne({
          conversationId: new mongoose.Types.ObjectId(),
          user: new mongoose.Types.ObjectId(),
          title: `Test Conversation ${i}`,
          endpoint: EModelEndpoint.openAI,
          _meiliIndex: false,
          expiredAt: null,
        });
      }

      // Mock addDocumentsInBatches to fail on first call
      mockAddDocumentsInBatches.mockRejectedValueOnce(new Error('First batch failed'));

      // Sync should fail on the first batch
      await expect(conversationModel.syncWithMeili()).rejects.toThrow('First batch failed');

      // Should have attempted only once before failing
      expect(mockAddDocumentsInBatches).toHaveBeenCalledTimes(1);

      // No documents should be indexed since sync failed
      const indexedCount = await conversationModel.countDocuments({ _meiliIndex: true });
      expect(indexedCount).toBe(0);
    });

    test('error in processSyncBatch is properly logged before being thrown', async () => {
      const messageModel = createMessageModel(mongoose) as unknown as SchemaWithMeiliMethods;
      await messageModel.deleteMany({});

      const testError = new Error('Test error for logging');
      mockAddDocumentsInBatches.mockRejectedValueOnce(testError);

      await messageModel.collection.insertOne({
        messageId: new mongoose.Types.ObjectId(),
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        isCreatedByUser: true,
        _meiliIndex: false,
        expiredAt: null,
      });

      const indexMock = mockIndex();
      const documents = await messageModel.find({ _meiliIndex: false }).lean();

      // Should throw the same error that was passed to it
      await expect(messageModel.processSyncBatch(indexMock, documents)).rejects.toThrow(testError);
    });

    test('syncWithMeili properly propagates processSyncBatch errors', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});
      mockAddDocumentsInBatches.mockClear();

      await conversationModel.collection.insertOne({
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        title: 'Test',
        endpoint: EModelEndpoint.openAI,
        _meiliIndex: false,
        expiredAt: null,
      });

      const customError = new Error('Custom sync error');
      mockAddDocumentsInBatches.mockRejectedValueOnce(customError);

      // The error should propagate all the way up
      await expect(conversationModel.syncWithMeili()).rejects.toThrow('Custom sync error');
    });
  });

  describe('cleanupMeiliIndex', () => {
    let mockGetDocuments: jest.Mock;

    beforeEach(() => {
      mockGetDocuments = jest.fn();
      mockDeleteDocuments.mockClear();
      mockIndex.mockReturnValue({
        getRawInfo: jest.fn(),
        updateSettings: jest.fn(),
        addDocuments: mockAddDocuments,
        addDocumentsInBatches: mockAddDocumentsInBatches,
        updateDocuments: mockUpdateDocuments,
        deleteDocument: mockDeleteDocument,
        deleteDocuments: mockDeleteDocuments,
        getDocument: mockGetDocument,
        getDocuments: mockGetDocuments,
      });
    });

    test('cleanupMeiliIndex deletes orphaned documents from MeiliSearch', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});

      const existingConvoId = new mongoose.Types.ObjectId().toString();
      const orphanedConvoId1 = new mongoose.Types.ObjectId().toString();
      const orphanedConvoId2 = new mongoose.Types.ObjectId().toString();

      // Create one document in MongoDB
      await conversationModel.collection.insertOne({
        conversationId: existingConvoId,
        user: new mongoose.Types.ObjectId(),
        title: 'Existing Conversation',
        endpoint: EModelEndpoint.openAI,
        _meiliIndex: true,
        expiredAt: null,
      });

      // Mock MeiliSearch to return 3 documents (1 exists in MongoDB, 2 are orphaned)
      mockGetDocuments.mockResolvedValueOnce({
        results: [
          { conversationId: existingConvoId },
          { conversationId: orphanedConvoId1 },
          { conversationId: orphanedConvoId2 },
        ],
      });

      const indexMock = mockIndex();
      await conversationModel.cleanupMeiliIndex(indexMock, 'conversationId', 100, 0);

      // Should delete the 2 orphaned documents
      expect(mockDeleteDocuments).toHaveBeenCalledWith([orphanedConvoId1, orphanedConvoId2]);
    });

    test('cleanupMeiliIndex handles offset correctly when documents are deleted', async () => {
      const messageModel = createMessageModel(mongoose) as unknown as SchemaWithMeiliMethods;
      await messageModel.deleteMany({});

      const existingIds = [
        new mongoose.Types.ObjectId().toString(),
        new mongoose.Types.ObjectId().toString(),
        new mongoose.Types.ObjectId().toString(),
      ];

      const orphanedIds = [
        new mongoose.Types.ObjectId().toString(),
        new mongoose.Types.ObjectId().toString(),
      ];

      // Create existing documents in MongoDB
      for (const id of existingIds) {
        await messageModel.collection.insertOne({
          messageId: id,
          conversationId: new mongoose.Types.ObjectId(),
          user: new mongoose.Types.ObjectId(),
          isCreatedByUser: true,
          _meiliIndex: true,
          expiredAt: null,
        });
      }

      // Mock MeiliSearch to return batches with mixed existing and orphaned documents
      // First batch: 3 documents (1 existing, 2 orphaned) with batchSize=3
      mockGetDocuments
        .mockResolvedValueOnce({
          results: [
            { messageId: existingIds[0] },
            { messageId: orphanedIds[0] },
            { messageId: orphanedIds[1] },
          ],
        })
        // Second batch: should use offset=1 (3 - 2 deleted = 1)
        // results.length=2 < batchSize=3, so loop should stop after this
        .mockResolvedValueOnce({
          results: [{ messageId: existingIds[1] }, { messageId: existingIds[2] }],
        });

      const indexMock = mockIndex();
      await messageModel.cleanupMeiliIndex(indexMock, 'messageId', 3, 0);

      // Should have called getDocuments with correct offsets
      expect(mockGetDocuments).toHaveBeenCalledTimes(2);
      expect(mockGetDocuments).toHaveBeenNthCalledWith(1, { limit: 3, offset: 0 });
      // After deleting 2 documents, offset should be: 0 + (3 - 2) = 1
      expect(mockGetDocuments).toHaveBeenNthCalledWith(2, { limit: 3, offset: 1 });

      // Should delete only the orphaned documents
      expect(mockDeleteDocuments).toHaveBeenCalledWith([orphanedIds[0], orphanedIds[1]]);
    });

    test('cleanupMeiliIndex preserves existing documents', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});

      const existingId1 = new mongoose.Types.ObjectId().toString();
      const existingId2 = new mongoose.Types.ObjectId().toString();

      // Create documents in MongoDB
      await conversationModel.collection.insertMany([
        {
          conversationId: existingId1,
          user: new mongoose.Types.ObjectId(),
          title: 'Conversation 1',
          endpoint: EModelEndpoint.openAI,
          _meiliIndex: true,
          expiredAt: null,
        },
        {
          conversationId: existingId2,
          user: new mongoose.Types.ObjectId(),
          title: 'Conversation 2',
          endpoint: EModelEndpoint.openAI,
          _meiliIndex: true,
          expiredAt: null,
        },
      ]);

      // Mock MeiliSearch to return the same documents
      mockGetDocuments.mockResolvedValueOnce({
        results: [{ conversationId: existingId1 }, { conversationId: existingId2 }],
      });

      const indexMock = mockIndex();
      await conversationModel.cleanupMeiliIndex(indexMock, 'conversationId', 100, 0);

      // Should NOT delete any documents
      expect(mockDeleteDocuments).not.toHaveBeenCalled();
    });

    test('cleanupMeiliIndex handles empty MeiliSearch index', async () => {
      const messageModel = createMessageModel(mongoose) as unknown as SchemaWithMeiliMethods;

      // Mock empty MeiliSearch index
      mockGetDocuments.mockResolvedValueOnce({
        results: [],
      });

      const indexMock = mockIndex();
      await messageModel.cleanupMeiliIndex(indexMock, 'messageId', 100, 0);

      // Should not attempt to delete anything
      expect(mockDeleteDocuments).not.toHaveBeenCalled();
      expect(mockGetDocuments).toHaveBeenCalledTimes(1);
    });

    test('cleanupMeiliIndex stops when results.length < batchSize', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});

      const id1 = new mongoose.Types.ObjectId().toString();
      const id2 = new mongoose.Types.ObjectId().toString();

      await conversationModel.collection.insertMany([
        {
          conversationId: id1,
          user: new mongoose.Types.ObjectId(),
          title: 'Conversation 1',
          endpoint: EModelEndpoint.openAI,
          _meiliIndex: true,
          expiredAt: null,
        },
        {
          conversationId: id2,
          user: new mongoose.Types.ObjectId(),
          title: 'Conversation 2',
          endpoint: EModelEndpoint.openAI,
          _meiliIndex: true,
          expiredAt: null,
        },
      ]);

      // Mock: results.length (2) is less than batchSize (100), should process once and stop
      mockGetDocuments.mockResolvedValueOnce({
        results: [{ conversationId: id1 }, { conversationId: id2 }],
      });

      const indexMock = mockIndex();
      await conversationModel.cleanupMeiliIndex(indexMock, 'conversationId', 100, 0);

      // Should only call getDocuments once
      expect(mockGetDocuments).toHaveBeenCalledTimes(1);
      expect(mockDeleteDocuments).not.toHaveBeenCalled();
    });

    test('cleanupMeiliIndex handles multiple batches correctly', async () => {
      const messageModel = createMessageModel(mongoose) as unknown as SchemaWithMeiliMethods;
      await messageModel.deleteMany({});

      const existingIds = Array.from({ length: 5 }, () => new mongoose.Types.ObjectId().toString());
      const orphanedIds = Array.from({ length: 3 }, () => new mongoose.Types.ObjectId().toString());

      // Create existing documents in MongoDB
      for (const id of existingIds) {
        await messageModel.collection.insertOne({
          messageId: id,
          conversationId: new mongoose.Types.ObjectId(),
          user: new mongoose.Types.ObjectId(),
          isCreatedByUser: true,
          _meiliIndex: true,
          expiredAt: null,
        });
      }

      // Mock multiple batches with batchSize=3
      mockGetDocuments
        // Batch 1: 2 existing, 1 orphaned
        .mockResolvedValueOnce({
          results: [
            { messageId: existingIds[0] },
            { messageId: existingIds[1] },
            { messageId: orphanedIds[0] },
          ],
        })
        // Batch 2: offset should be 0 + (3 - 1) = 2
        .mockResolvedValueOnce({
          results: [
            { messageId: existingIds[2] },
            { messageId: orphanedIds[1] },
            { messageId: orphanedIds[2] },
          ],
        })
        // Batch 3: offset should be 2 + (3 - 2) = 3
        .mockResolvedValueOnce({
          results: [{ messageId: existingIds[3] }, { messageId: existingIds[4] }],
        });

      const indexMock = mockIndex();
      await messageModel.cleanupMeiliIndex(indexMock, 'messageId', 3, 0);

      expect(mockGetDocuments).toHaveBeenCalledTimes(3);
      expect(mockGetDocuments).toHaveBeenNthCalledWith(1, { limit: 3, offset: 0 });
      expect(mockGetDocuments).toHaveBeenNthCalledWith(2, { limit: 3, offset: 2 });
      expect(mockGetDocuments).toHaveBeenNthCalledWith(3, { limit: 3, offset: 3 });

      // Should have deleted orphaned documents in batches
      expect(mockDeleteDocuments).toHaveBeenCalledTimes(2);
      expect(mockDeleteDocuments).toHaveBeenNthCalledWith(1, [orphanedIds[0]]);
      expect(mockDeleteDocuments).toHaveBeenNthCalledWith(2, [orphanedIds[1], orphanedIds[2]]);
    });

    test('cleanupMeiliIndex handles delay between batches', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});

      const id1 = new mongoose.Types.ObjectId().toString();
      const id2 = new mongoose.Types.ObjectId().toString();

      await conversationModel.collection.insertMany([
        {
          conversationId: id1,
          user: new mongoose.Types.ObjectId(),
          title: 'Conversation 1',
          endpoint: EModelEndpoint.openAI,
          _meiliIndex: true,
          expiredAt: null,
        },
        {
          conversationId: id2,
          user: new mongoose.Types.ObjectId(),
          title: 'Conversation 2',
          endpoint: EModelEndpoint.openAI,
          _meiliIndex: true,
          expiredAt: null,
        },
      ]);

      mockGetDocuments
        .mockResolvedValueOnce({
          results: [{ conversationId: id1 }],
        })
        .mockResolvedValueOnce({
          results: [{ conversationId: id2 }],
        })
        .mockResolvedValueOnce({
          results: [],
        });

      const indexMock = mockIndex();
      const startTime = Date.now();
      await conversationModel.cleanupMeiliIndex(indexMock, 'conversationId', 1, 100);
      const endTime = Date.now();

      // Should have taken at least 200ms due to delay (2 delays between 3 batches)
      expect(endTime - startTime).toBeGreaterThanOrEqual(200);
      expect(mockGetDocuments).toHaveBeenCalledTimes(3);
    });

    test('cleanupMeiliIndex handles errors gracefully', async () => {
      const messageModel = createMessageModel(mongoose) as unknown as SchemaWithMeiliMethods;

      mockGetDocuments.mockRejectedValueOnce(new Error('MeiliSearch connection error'));

      const indexMock = mockIndex();

      // Should not throw, errors are caught and logged
      await expect(
        messageModel.cleanupMeiliIndex(indexMock, 'messageId', 100, 0),
      ).resolves.not.toThrow();
    });

    test('cleanupMeiliIndex with all documents being orphaned', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});

      const orphanedId1 = new mongoose.Types.ObjectId().toString();
      const orphanedId2 = new mongoose.Types.ObjectId().toString();
      const orphanedId3 = new mongoose.Types.ObjectId().toString();

      // MeiliSearch has documents but MongoDB is empty
      mockGetDocuments.mockResolvedValueOnce({
        results: [
          { conversationId: orphanedId1 },
          { conversationId: orphanedId2 },
          { conversationId: orphanedId3 },
        ],
      });

      const indexMock = mockIndex();
      await conversationModel.cleanupMeiliIndex(indexMock, 'conversationId', 100, 0);

      // Should delete all documents since none exist in MongoDB
      expect(mockDeleteDocuments).toHaveBeenCalledWith([orphanedId1, orphanedId2, orphanedId3]);
    });

    test('cleanupMeiliIndex adjusts offset to 0 when all batch documents are deleted', async () => {
      const messageModel = createMessageModel(mongoose) as unknown as SchemaWithMeiliMethods;
      await messageModel.deleteMany({});

      const orphanedIds = Array.from({ length: 3 }, () => new mongoose.Types.ObjectId().toString());
      const existingId = new mongoose.Types.ObjectId().toString();

      // Create one existing document
      await messageModel.collection.insertOne({
        messageId: existingId,
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        isCreatedByUser: true,
        _meiliIndex: true,
        expiredAt: null,
      });

      mockGetDocuments
        // Batch 1: All 3 are orphaned
        .mockResolvedValueOnce({
          results: [
            { messageId: orphanedIds[0] },
            { messageId: orphanedIds[1] },
            { messageId: orphanedIds[2] },
          ],
        })
        // Batch 2: offset should be 0 + (3 - 3) = 0
        .mockResolvedValueOnce({
          results: [{ messageId: existingId }],
        });

      const indexMock = mockIndex();
      await messageModel.cleanupMeiliIndex(indexMock, 'messageId', 3, 0);

      expect(mockGetDocuments).toHaveBeenCalledTimes(2);
      expect(mockGetDocuments).toHaveBeenNthCalledWith(1, { limit: 3, offset: 0 });
      // After deleting all 3, offset remains at 0
      expect(mockGetDocuments).toHaveBeenNthCalledWith(2, { limit: 3, offset: 0 });

      expect(mockDeleteDocuments).toHaveBeenCalledWith([
        orphanedIds[0],
        orphanedIds[1],
        orphanedIds[2],
      ]);
    });
  });

  describe('processSyncBatch does not modify updatedAt timestamps', () => {
    test('syncWithMeili preserves original updatedAt on conversations', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});
      mockAddDocumentsInBatches.mockClear();

      const pastDate = new Date('2024-01-15T12:00:00Z');

      // Insert documents with specific updatedAt timestamps using raw collection
      await conversationModel.collection.insertMany([
        {
          conversationId: new mongoose.Types.ObjectId().toString(),
          user: new mongoose.Types.ObjectId(),
          title: 'Old Conversation 1',
          endpoint: EModelEndpoint.openAI,
          _meiliIndex: false,
          expiredAt: null,
          createdAt: pastDate,
          updatedAt: pastDate,
        },
        {
          conversationId: new mongoose.Types.ObjectId().toString(),
          user: new mongoose.Types.ObjectId(),
          title: 'Old Conversation 2',
          endpoint: EModelEndpoint.openAI,
          _meiliIndex: false,
          expiredAt: null,
          createdAt: pastDate,
          updatedAt: pastDate,
        },
      ]);

      // Verify timestamps before sync
      const beforeSync = await conversationModel.find({}).lean();
      for (const doc of beforeSync) {
        expect(new Date(doc.updatedAt as Date).getTime()).toBe(pastDate.getTime());
      }

      // Run sync which calls processSyncBatch internally
      await conversationModel.syncWithMeili();

      // Verify _meiliIndex was updated
      const indexedCount = await conversationModel.countDocuments({ _meiliIndex: true });
      expect(indexedCount).toBe(2);

      // Verify updatedAt was NOT modified
      const afterSync = await conversationModel.find({}).lean();
      for (const doc of afterSync) {
        expect(new Date(doc.updatedAt as Date).getTime()).toBe(pastDate.getTime());
      }
    });

    test('syncWithMeili preserves original updatedAt on messages', async () => {
      const messageModel = createMessageModel(mongoose) as unknown as SchemaWithMeiliMethods;
      await messageModel.deleteMany({});
      mockAddDocumentsInBatches.mockClear();

      const pastDate = new Date('2023-06-01T08:30:00Z');

      await messageModel.collection.insertMany([
        {
          messageId: new mongoose.Types.ObjectId().toString(),
          conversationId: new mongoose.Types.ObjectId().toString(),
          user: new mongoose.Types.ObjectId(),
          isCreatedByUser: true,
          _meiliIndex: false,
          expiredAt: null,
          createdAt: pastDate,
          updatedAt: pastDate,
        },
        {
          messageId: new mongoose.Types.ObjectId().toString(),
          conversationId: new mongoose.Types.ObjectId().toString(),
          user: new mongoose.Types.ObjectId(),
          isCreatedByUser: false,
          _meiliIndex: false,
          expiredAt: null,
          createdAt: pastDate,
          updatedAt: pastDate,
        },
      ]);

      const beforeSync = await messageModel.find({}).lean();
      for (const doc of beforeSync) {
        expect(new Date(doc.updatedAt as Date).getTime()).toBe(pastDate.getTime());
      }

      await messageModel.syncWithMeili();

      const indexedCount = await messageModel.countDocuments({ _meiliIndex: true });
      expect(indexedCount).toBe(2);

      const afterSync = await messageModel.find({}).lean();
      for (const doc of afterSync) {
        expect(new Date(doc.updatedAt as Date).getTime()).toBe(pastDate.getTime());
      }
    });
  });

  describe('Missing _meiliIndex property handling in sync process', () => {
    test('syncWithMeili includes documents with missing _meiliIndex', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});
      mockAddDocumentsInBatches.mockClear();

      // Insert documents with different _meiliIndex states
      await conversationModel.collection.insertMany([
        {
          conversationId: new mongoose.Types.ObjectId(),
          user: new mongoose.Types.ObjectId(),
          title: 'Missing _meiliIndex',
          endpoint: EModelEndpoint.openAI,
          expiredAt: null,
          // _meiliIndex is not set (missing/undefined)
        },
        {
          conversationId: new mongoose.Types.ObjectId(),
          user: new mongoose.Types.ObjectId(),
          title: 'Explicit false',
          endpoint: EModelEndpoint.openAI,
          expiredAt: null,
          _meiliIndex: false,
        },
        {
          conversationId: new mongoose.Types.ObjectId(),
          user: new mongoose.Types.ObjectId(),
          title: 'Already indexed',
          endpoint: EModelEndpoint.openAI,
          expiredAt: null,
          _meiliIndex: true,
          _meiliIndexSchemaVersion: MEILI_INDEX_SCHEMA_VERSION,
        },
      ]);

      // Run sync
      await conversationModel.syncWithMeili();

      // Should have processed 2 documents (missing and false, but not true)
      expect(mockAddDocumentsInBatches).toHaveBeenCalled();

      // Check that both documents without _meiliIndex=true are now indexed
      const indexedCount = await conversationModel.countDocuments({
        expiredAt: null,
        _meiliIndex: true,
      });
      expect(indexedCount).toBe(3); // All 3 should now be indexed

      // Verify documents with missing _meiliIndex were updated
      const docsWithMissingIndex = await conversationModel.countDocuments({
        expiredAt: null,
        title: 'Missing _meiliIndex',
        _meiliIndex: true,
      });
      expect(docsWithMissingIndex).toBe(1);
    });

    test('getSyncProgress counts documents with missing _meiliIndex as not indexed', async () => {
      const messageModel = createMessageModel(mongoose) as unknown as SchemaWithMeiliMethods;
      await messageModel.deleteMany({});

      // Insert documents with different _meiliIndex states
      await messageModel.collection.insertMany([
        {
          messageId: new mongoose.Types.ObjectId(),
          conversationId: new mongoose.Types.ObjectId(),
          user: new mongoose.Types.ObjectId(),
          isCreatedByUser: true,
          expiredAt: null,
          _meiliIndex: true,
          _meiliIndexSchemaVersion: MEILI_INDEX_SCHEMA_VERSION,
        },
        {
          messageId: new mongoose.Types.ObjectId(),
          conversationId: new mongoose.Types.ObjectId(),
          user: new mongoose.Types.ObjectId(),
          isCreatedByUser: true,
          expiredAt: null,
          _meiliIndex: false,
        },
        {
          messageId: new mongoose.Types.ObjectId(),
          conversationId: new mongoose.Types.ObjectId(),
          user: new mongoose.Types.ObjectId(),
          isCreatedByUser: true,
          expiredAt: null,
          // _meiliIndex is missing
        },
      ]);

      const progress = await messageModel.getSyncProgress();

      // Total should be 3
      expect(progress.totalDocuments).toBe(3);
      // Only 1 is indexed (with _meiliIndex: true)
      expect(progress.totalProcessed).toBe(1);
      // Not complete since 2 documents are not indexed
      expect(progress.isComplete).toBe(false);
    });

    test('query with _meiliIndex: { $ne: true } includes missing values', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});

      // Insert documents with different _meiliIndex states
      await conversationModel.collection.insertMany([
        {
          conversationId: new mongoose.Types.ObjectId(),
          user: new mongoose.Types.ObjectId(),
          title: 'Missing',
          endpoint: EModelEndpoint.openAI,
          expiredAt: null,
          // _meiliIndex is missing
        },
        {
          conversationId: new mongoose.Types.ObjectId(),
          user: new mongoose.Types.ObjectId(),
          title: 'False',
          endpoint: EModelEndpoint.openAI,
          expiredAt: null,
          _meiliIndex: false,
        },
        {
          conversationId: new mongoose.Types.ObjectId(),
          user: new mongoose.Types.ObjectId(),
          title: 'True',
          endpoint: EModelEndpoint.openAI,
          expiredAt: null,
          _meiliIndex: true,
        },
      ]);

      // Query for documents where _meiliIndex is not true (used in syncWithMeili)
      const unindexedDocs = await conversationModel.find({
        expiredAt: null,
        _meiliIndex: { $ne: true },
      });

      // Should find 2 documents (missing and false, but not true)
      expect(unindexedDocs.length).toBe(2);
      const titles = unindexedDocs.map((doc) => doc.title).sort();
      expect(titles).toEqual(['False', 'Missing']);
    });

    test('syncWithMeili processes all documents where _meiliIndex is not true', async () => {
      const messageModel = createMessageModel(mongoose) as unknown as SchemaWithMeiliMethods;
      await messageModel.deleteMany({});
      mockAddDocumentsInBatches.mockClear();

      // Create a mix of documents with missing and false _meiliIndex
      await messageModel.collection.insertMany([
        {
          messageId: new mongoose.Types.ObjectId(),
          conversationId: new mongoose.Types.ObjectId(),
          user: new mongoose.Types.ObjectId(),
          isCreatedByUser: true,
          expiredAt: null,
          // _meiliIndex missing
        },
        {
          messageId: new mongoose.Types.ObjectId(),
          conversationId: new mongoose.Types.ObjectId(),
          user: new mongoose.Types.ObjectId(),
          isCreatedByUser: true,
          expiredAt: null,
          _meiliIndex: false,
        },
        {
          messageId: new mongoose.Types.ObjectId(),
          conversationId: new mongoose.Types.ObjectId(),
          user: new mongoose.Types.ObjectId(),
          isCreatedByUser: true,
          expiredAt: null,
          // _meiliIndex missing
        },
      ]);

      // Count documents that should be synced (where _meiliIndex: { $ne: true })
      const toSyncCount = await messageModel.countDocuments({
        expiredAt: null,
        _meiliIndex: { $ne: true },
      });
      expect(toSyncCount).toBe(3); // All 3 should be synced

      await messageModel.syncWithMeili();

      // All should now be indexed
      const indexedCount = await messageModel.countDocuments({
        expiredAt: null,
        _meiliIndex: true,
      });
      expect(indexedCount).toBe(3);
    });

    test('syncWithMeili treats missing _meiliIndex same as false', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});
      mockAddDocumentsInBatches.mockClear();

      // Insert one document with missing _meiliIndex and one with false
      await conversationModel.collection.insertMany([
        {
          conversationId: new mongoose.Types.ObjectId(),
          user: new mongoose.Types.ObjectId(),
          title: 'Missing',
          endpoint: EModelEndpoint.openAI,
          expiredAt: null,
          // _meiliIndex is missing
        },
        {
          conversationId: new mongoose.Types.ObjectId(),
          user: new mongoose.Types.ObjectId(),
          title: 'False',
          endpoint: EModelEndpoint.openAI,
          expiredAt: null,
          _meiliIndex: false,
        },
      ]);

      // Both should be picked up by the sync query
      const toSync = await conversationModel.find({
        expiredAt: null,
        _meiliIndex: { $ne: true },
      });
      expect(toSync.length).toBe(2);

      await conversationModel.syncWithMeili();

      // Both should be indexed after sync
      const afterSync = await conversationModel.find({
        expiredAt: null,
        _meiliIndex: true,
      });
      expect(afterSync.length).toBe(2);
    });
  });

  describe('excluded-document cleanup indexes', () => {
    test('builds every cleanup index the plugin declares', async () => {
      const messageModel = createMessageModel(mongoose);

      await expect(messageModel.createIndexes()).resolves.toBeUndefined();

      const builtIndexes = await messageModel.collection.listIndexes().toArray();
      expect(builtIndexes.map((builtIndex) => builtIndex.name)).toEqual(
        expect.arrayContaining([
          'meili_excluded_indexed_cleanup_v3',
          'meili_excluded_attempted_cleanup_v3',
          'meili_excluded_legacy_cleanup_v4',
        ]),
      );

      const legacyCleanup = builtIndexes.find(
        (builtIndex) => builtIndex.name === 'meili_excluded_legacy_cleanup_v4',
      );
      expect(legacyCleanup?.key).toEqual({
        _meiliIndex: 1,
        _meiliCleanupVersion: 1,
        messageId: 1,
      });
      /** `$exists: false` is the operator MongoDB rejects in a partial filter, so the
       *  unstamped state is expressed as a null equality and must stay that way. */
      expect(legacyCleanup?.partialFilterExpression).toEqual({
        subagentTask: { $exists: true },
        _meiliIndex: { $eq: false },
        _meiliCleanupVersion: { $eq: null },
      });
    });

    test('cleans up an excluded document stored before the cleanup version existed', async () => {
      const messageModel = createMessageModel(mongoose) as unknown as SchemaWithMeiliMethods;
      const messageId = new mongoose.Types.ObjectId().toString();
      await messageModel.collection.insertOne({
        messageId,
        conversationId: new mongoose.Types.ObjectId().toString(),
        user: 'user-legacy-cleanup',
        isCreatedByUser: true,
        text: 'Indexed before the private child marker existed',
        subagentTask: { attemptKey: 'attempt-key', status: 'completed' },
        _meiliIndex: false,
      });

      await messageModel.cleanupExcludedMeiliIndex();

      expect(mockDeleteDocuments).toHaveBeenCalledWith(expect.arrayContaining([messageId]));
      const cleaned = await messageModel.collection.findOne({ messageId });
      expect(cleaned?._meiliCleanupVersion).toBe(1);
      expect(cleaned?._meiliIndex).toBeUndefined();
    });

    test('holds only excluded documents still awaiting cleanup', async () => {
      const messageModel = createMessageModel(mongoose);
      await messageModel.createIndexes();
      const conversationId = new mongoose.Types.ObjectId().toString();
      const awaitingCleanup = new mongoose.Types.ObjectId().toString();
      const alreadyStamped = new mongoose.Types.ObjectId().toString();
      await messageModel.collection.insertMany([
        {
          messageId: awaitingCleanup,
          conversationId,
          user: 'user-index-population',
          isCreatedByUser: true,
          text: 'Written before the cleanup version existed',
          subagentTask: { attemptKey: 'attempt-key', status: 'completed' },
          _meiliIndex: false,
        },
        {
          messageId: alreadyStamped,
          conversationId,
          user: 'user-index-population',
          isCreatedByUser: true,
          text: 'Written by the current schema, nothing to clean up',
          subagentTask: { attemptKey: 'attempt-key', status: 'completed' },
          _meiliIndex: false,
          _meiliCleanupVersion: 1,
        },
      ]);

      /** Hinting the partial index reaches only the documents it holds, which is the
       *  invariant that keeps it from growing with every private subagent document. */
      const indexedMessageIds = await messageModel.collection
        .find({ user: 'user-index-population' })
        .hint('meili_excluded_legacy_cleanup_v4')
        .project({ messageId: 1, _id: 0 })
        .toArray();

      expect(indexedMessageIds.map((document) => document.messageId)).toEqual([awaitingCleanup]);
    });

    test('serves the legacy cleanup branch from the index', async () => {
      const messageModel = createMessageModel(mongoose);
      await messageModel.createIndexes();
      const excludedQuery = buildExcludedIndexedQuery('subagentTask');
      const branches = (excludedQuery?.$or ?? []) as Filter<MongoDocument>[];
      const legacyBranch = branches.find((branch) => branch._meiliIndex === false);
      const legacyFilter: Filter<MongoDocument> = {
        subagentTask: { $exists: true },
        ...legacyBranch,
      };

      const plan = await messageModel.collection.find(legacyFilter).explain('queryPlanner');

      expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain(
        'meili_excluded_legacy_cleanup_v4',
      );
    });
  });
});
