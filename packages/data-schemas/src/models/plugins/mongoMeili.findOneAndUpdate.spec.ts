/**
 * `meiliEnabled` is a module-level constant evaluated when `mongoMeili` is first
 * imported, so the MeiliSearch env vars must be set before the plugin module is
 * loaded. The plugin is therefore imported lazily inside `beforeAll`, after the
 * env is set, and the prior values are restored in `afterAll` so this suite does
 * not leak `meiliEnabled: true` into other test files that share the Jest
 * worker's `process.env`.
 *
 * This suite covers the `saveConvo` code path, which calls `findOneAndUpdate`
 * with `includeResultMetadata: true`. Mongoose then resolves the query to the raw
 * `{ value, ok, lastErrorObject }` wrapper, and the post hook must unwrap `value`
 * before invoking the indexing hook (regression test for conversation titles not
 * syncing to MeiliSearch).
 */
import mongoose from 'mongoose';
import { EModelEndpoint } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { SchemaWithMeiliMethods } from '~/models/plugins/mongoMeili';

const MEILI_ENV_KEYS = ['SEARCH', 'MEILI_HOST', 'MEILI_MASTER_KEY'] as const;
const savedMeiliEnv: Partial<Record<(typeof MEILI_ENV_KEYS)[number], string | undefined>> = {};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const waitForMock = async (mock: jest.Mock, timeoutMs = 2000): Promise<void> => {
  const start = Date.now();
  while (mock.mock.calls.length === 0) {
    if (Date.now() - start > timeoutMs) {
      return;
    }
    await wait(10);
  }
};

const mockAddDocuments = jest.fn();
const mockUpdateDocuments = jest.fn();
const mockDeleteDocument = jest.fn();
const mockWaitForTask = jest.fn();
const mockGetDocument = jest.fn();
const mockIndex = jest.fn().mockReturnValue({
  getRawInfo: jest.fn(),
  updateSettings: jest.fn(),
  addDocuments: mockAddDocuments,
  addDocumentsInBatches: jest.fn(),
  updateDocuments: mockUpdateDocuments,
  deleteDocument: mockDeleteDocument,
  deleteDocuments: jest.fn(),
  getDocument: mockGetDocument,
  getDocuments: jest.fn().mockReturnValue({ results: [] }),
});
jest.mock('meilisearch', () => ({
  MeiliSearch: jest.fn().mockImplementation(() => ({
    index: mockIndex,
    waitForTask: mockWaitForTask,
  })),
}));

describe('mongoMeili findOneAndUpdate with includeResultMetadata (saveConvo path)', () => {
  let mongoServer: MongoMemoryServer;
  let createConversationModel: (typeof import('~/models/convo'))['createConversationModel'];
  let conversationModel: SchemaWithMeiliMethods;

  beforeAll(async () => {
    for (const key of MEILI_ENV_KEYS) {
      savedMeiliEnv[key] = process.env[key];
    }
    process.env.SEARCH = 'true';
    process.env.MEILI_HOST = 'foo';
    process.env.MEILI_MASTER_KEY = 'bar';

    ({ createConversationModel } = await import('~/models/convo'));
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    conversationModel = createConversationModel(mongoose) as unknown as SchemaWithMeiliMethods;
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
    for (const key of MEILI_ENV_KEYS) {
      if (savedMeiliEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedMeiliEnv[key];
      }
    }
  });

  beforeEach(async () => {
    await conversationModel.deleteMany({});
    mockAddDocuments.mockReset().mockResolvedValue({ taskUid: 1 });
    mockUpdateDocuments.mockReset().mockResolvedValue({ taskUid: 1 });
    mockDeleteDocument.mockReset().mockResolvedValue({ taskUid: 1 });
    mockWaitForTask.mockReset().mockResolvedValue({ status: 'succeeded' });
    mockGetDocument.mockClear();
    mockGetDocument.mockReset();
  });

  const updateTitle = (conversationId: string, user: string, title: string) =>
    conversationModel.findOneAndUpdate(
      { conversationId, user },
      { $set: { title } },
      { new: true, upsert: true, includeResultMetadata: true },
    );

  const waitForIndexAcknowledgment = async (
    conversationId: string,
    timeoutMs = 2000,
  ): Promise<void> => {
    const start = Date.now();
    while (Date.now() - start <= timeoutMs) {
      const storedDoc = await conversationModel.collection.findOne({ conversationId });
      if (storedDoc?._meiliIndex === true) {
        return;
      }
      await wait(10);
    }
  };

  test('skips indexing for an internal admission fence without disabling later content updates', async () => {
    const { withoutMeiliIndexing } = await import('./mongoMeili');
    const conversationId = new mongoose.Types.ObjectId().toString();
    const user = new mongoose.Types.ObjectId().toString();
    await conversationModel.create({
      conversationId,
      user,
      title: 'Original Title',
      endpoint: EModelEndpoint.openAI,
    });
    await waitForIndexAcknowledgment(conversationId);
    const before = await conversationModel.collection.findOne({ conversationId });
    mockAddDocuments.mockClear();
    mockUpdateDocuments.mockClear();
    const result = await withoutMeiliIndexing(
      conversationModel.findOneAndUpdate(
        { conversationId, user },
        { $inc: { codeEnvironmentRevision: 1 } },
        { new: true, timestamps: false },
      ),
    )
      .select('conversationId codeWorkspaces')
      .lean();
    expect(result).toHaveProperty('conversationId', conversationId);
    expect(result).not.toHaveProperty('codeEnvironmentRevision');
    const after = await conversationModel.collection.findOne({ conversationId });
    expect(after?.codeEnvironmentRevision).toBe(1);
    expect(after?.updatedAt).toEqual(before?.updatedAt);
    expect(after?._meiliIndexVersion).toEqual(before?._meiliIndexVersion);
    expect(after?._meiliIndex).toBe(true);
    expect(mockAddDocuments).not.toHaveBeenCalled();
    expect(mockUpdateDocuments).not.toHaveBeenCalled();
    await updateTitle(conversationId, user, 'New title');
    await waitForMock(mockAddDocuments);
    expect(mockAddDocuments).toHaveBeenCalledTimes(1);
  });

  test('re-indexes the updated title when the raw result wrapper is returned', async () => {
    const conversationId = new mongoose.Types.ObjectId().toString();
    const user = new mongoose.Types.ObjectId().toString();
    await conversationModel.create({
      conversationId,
      user,
      title: 'Original Title',
      endpoint: EModelEndpoint.openAI,
    });
    await waitForIndexAcknowledgment(conversationId);
    mockAddDocuments.mockClear();

    const result = await updateTitle(conversationId, user, 'Renamed Title');

    // `includeResultMetadata: true` resolves to the raw wrapper, not the document.
    expect((result as unknown as { value: unknown }).value).toBeTruthy();

    await waitForMock(mockAddDocuments);
    expect(mockAddDocuments).toHaveBeenCalledWith(
      [expect.objectContaining({ conversationId, title: 'Renamed Title' })],
      { primaryKey: 'conversationId' },
    );
  });

  test('upserting a new conversation via the raw result wrapper indexes it', async () => {
    const conversationId = new mongoose.Types.ObjectId().toString();
    const user = new mongoose.Types.ObjectId().toString();

    await conversationModel.findOneAndUpdate(
      { conversationId, user },
      { $set: { title: 'Fresh Conversation', endpoint: EModelEndpoint.openAI } },
      { new: true, upsert: true, includeResultMetadata: true },
    );

    await waitForMock(mockAddDocuments);
    expect(mockAddDocuments).toHaveBeenCalledWith(
      [expect.objectContaining({ conversationId, title: 'Fresh Conversation' })],
      { primaryKey: 'conversationId' },
    );
  });

  test('persists the _meiliIndex flag after indexing via the wrapper', async () => {
    const conversationId = new mongoose.Types.ObjectId().toString();
    const user = new mongoose.Types.ObjectId().toString();

    await updateTitle(conversationId, user, 'Indexed Conversation');
    await waitForMock(mockAddDocuments);
    await waitForIndexAcknowledgment(conversationId);

    const storedDoc = await conversationModel.collection.findOne({ conversationId });
    expect(storedDoc?._meiliIndex).toBe(true);
  });

  test('does not wait for Meilisearch writes before settling the MongoDB update', async () => {
    const conversationId = new mongoose.Types.ObjectId().toString();
    const user = new mongoose.Types.ObjectId().toString();
    let resolveMeiliWrite: ((result: { taskUid: number }) => void) | undefined;

    await conversationModel.create({
      conversationId,
      user,
      title: 'Original Title',
      endpoint: EModelEndpoint.openAI,
    });
    await waitForMock(mockAddDocuments);
    await waitForIndexAcknowledgment(conversationId);
    mockAddDocuments.mockClear();
    mockAddDocuments.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMeiliWrite = resolve;
        }),
    );

    const result = await updateTitle(conversationId, user, 'Renamed Title');

    expect((result as unknown as { value: unknown }).value).toBeTruthy();
    await waitForMock(mockAddDocuments);
    expect(resolveMeiliWrite).toBeDefined();
    expect(mockAddDocuments).toHaveBeenCalledTimes(1);
    expect((await conversationModel.collection.findOne({ conversationId }))?._meiliIndex).toBe(
      false,
    );

    resolveMeiliWrite!({ taskUid: 1 });
    await waitForIndexAcknowledgment(conversationId);
    expect(mockAddDocuments).toHaveBeenCalledTimes(1);
  });

  test('re-indexes even when the title matches so every changed field stays current', async () => {
    const conversationId = new mongoose.Types.ObjectId().toString();
    const user = new mongoose.Types.ObjectId().toString();
    await conversationModel.create({
      conversationId,
      user,
      title: 'Same Title',
      endpoint: EModelEndpoint.openAI,
    });
    await waitForIndexAcknowledgment(conversationId);
    mockAddDocuments.mockClear();
    await updateTitle(conversationId, user, 'Same Title');

    await waitForMock(mockAddDocuments);
    expect(mockGetDocument).not.toHaveBeenCalled();
    expect(mockAddDocuments).toHaveBeenCalledWith(
      [expect.objectContaining({ conversationId, title: 'Same Title' })],
      { primaryKey: 'conversationId' },
    );
    expect(mockUpdateDocuments).not.toHaveBeenCalled();
  });

  test('persists the pending marker in the original findOneAndUpdate write', async () => {
    const conversationId = new mongoose.Types.ObjectId().toString();
    const user = new mongoose.Types.ObjectId().toString();
    let resolveMeiliWrite: ((result: { taskUid: number }) => void) | undefined;
    const modelUpdateOne = jest
      .spyOn(conversationModel, 'updateOne')
      .mockRejectedValue(new Error('follow-up marker writes must not be required'));
    mockAddDocuments.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMeiliWrite = resolve;
        }),
    );

    await expect(updateTitle(conversationId, user, 'Atomic Pending Marker')).resolves.toBeTruthy();

    const storedDoc = await conversationModel.collection.findOne({ conversationId });
    expect(storedDoc?._meiliIndex).toBe(false);
    expect(storedDoc?._meiliIndexAttempted).toBe(true);
    expect(storedDoc?._meiliIndexVersion).toEqual(expect.any(String));
    expect(modelUpdateOne).not.toHaveBeenCalled();

    await waitForMock(mockAddDocuments);
    resolveMeiliWrite!({ taskUid: 1 });
    await waitForIndexAcknowledgment(conversationId);
    modelUpdateOne.mockRestore();
  });

  test('does NOT index temporary conversations updated via the raw result wrapper', async () => {
    const conversationId = new mongoose.Types.ObjectId().toString();
    const user = new mongoose.Types.ObjectId().toString();
    await conversationModel.collection.insertOne({
      conversationId,
      user,
      title: 'Temporary Conversation',
      endpoint: EModelEndpoint.openAI,
      isTemporary: true,
      expiredAt: new Date(Date.now() + 60 * 60 * 1000),
      _meiliIndex: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await updateTitle(conversationId, user, 'Renamed Temporary Conversation');

    await wait(50);
    expect(mockAddDocuments).not.toHaveBeenCalled();
    expect(mockUpdateDocuments).not.toHaveBeenCalled();
  });
});
