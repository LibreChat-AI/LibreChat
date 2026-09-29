import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import type { ConversationMethods, MessageMethods } from '@librechat/data-schemas';
import type { TurnConversationRequest } from './save';
import {
  runAfterSeed,
  saveTurnConversation,
  seedTurnConversation,
  getConversationWriteContext,
  recoverTurnMessageReference,
} from './save';

type Store = Pick<ConversationMethods, 'getConvo' | 'saveConvo' | 'appendConvoMessageReference'> &
  Pick<MessageMethods, 'saveMessage'>;

let mongoServer: MongoMemoryServer;
let store: Store;

const endpointOptions = { model: 'claude-sonnet', agent_id: 'agent_persisted' };

function createRequest(userId: string): TurnConversationRequest {
  return {
    user: { id: userId },
    body: {},
    conversationCreatedAt: '2026-09-19T12:00:00.000Z',
  };
}

function seedFields(req: TurnConversationRequest, conversationId: string) {
  return {
    req,
    conversationId,
    endpoint: 'agents',
    endpointType: undefined,
    endpointOptions,
    agentId: 'agent_persisted',
    context: 'save.spec seed',
  };
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  const methods = createMethods(mongoose);
  store = {
    getConvo: methods.getConvo,
    saveConvo: methods.saveConvo,
    appendConvoMessageReference: methods.appendConvoMessageReference,
    saveMessage: methods.saveMessage,
  };
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.models.Conversation.deleteMany({});
  await mongoose.models.Message.deleteMany({});
  jest.restoreAllMocks();
});

describe('seedTurnConversation', () => {
  it('creates the row a deferred first message has not written yet', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const conversationId = randomUUID();
    const req = createRequest(userId);
    const messageFind = jest.spyOn(mongoose.models.Message, 'find');

    await seedTurnConversation(store, seedFields(req, conversationId));

    const row = await store.getConvo(userId, conversationId);
    expect(row).toMatchObject({
      conversationId,
      endpoint: 'agents',
      model: 'claude-sonnet',
      agent_id: 'agent_persisted',
      messages: [],
    });
    expect(row?.createdAt?.toISOString()).toBe('2026-09-19T12:00:00.000Z');
    /** The seed knows the row holds no messages, so it never reads the message list. */
    expect(messageFind).not.toHaveBeenCalled();
    expect(req.resolvedConversation).toMatchObject({ conversationId });
  });

  it('lets the deferred message save reuse the seeded row and append its message', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const conversationId = randomUUID();
    const req = createRequest(userId);
    await seedTurnConversation(store, seedFields(req, conversationId));
    const getConvo = jest.spyOn(store, 'getConvo');

    const ctx = getConversationWriteContext(req);
    const saved = await store.saveMessage(ctx, {
      messageId: randomUUID(),
      conversationId,
      text: 'Summarize the attached sheet',
      isCreatedByUser: true,
      user: userId,
    });
    const { initialized } = await saveTurnConversation(store, {
      ...seedFields(req, conversationId),
      context: 'save.spec message',
      ctx,
      savedMessageId: saved?._id,
    });

    expect(initialized).toBe(true);
    expect(getConvo).not.toHaveBeenCalled();
    const row = await store.getConvo(userId, conversationId);
    expect(row?.messages?.map(String)).toEqual([String(saved?._id)]);
    expect(row).toMatchObject({ model: 'claude-sonnet', agent_id: 'agent_persisted' });
  });

  it('leaves an existing conversation to the message save', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const conversationId = randomUUID();
    await store.saveConvo(
      { userId },
      { conversationId, endpoint: 'openAI', model: 'gpt-4o', title: 'Existing chat' },
    );
    const before = await store.getConvo(userId, conversationId);
    const saveConvo = jest.spyOn(store, 'saveConvo');

    await seedTurnConversation(store, seedFields(createRequest(userId), conversationId));

    expect(saveConvo).not.toHaveBeenCalled();
    const after = await store.getConvo(userId, conversationId);
    expect(after).toMatchObject({ endpoint: 'openAI', model: 'gpt-4o', title: 'Existing chat' });
    expect(after?.updatedAt).toEqual(before?.updatedAt);
  });

  it('never creates a subagent thread row, which only its parent run may create', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const conversationId = randomUUID();
    const req = {
      ...createRequest(userId),
      _agentEventBindingParentConversationId: randomUUID(),
    };

    await seedTurnConversation(store, seedFields(req, conversationId));

    await expect(store.getConvo(userId, conversationId)).resolves.toBeNull();
  });

  it('stamps a temporary chat with its retention', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const conversationId = randomUUID();
    const req = { ...createRequest(userId), body: { isTemporary: true } };

    await seedTurnConversation(store, seedFields(req, conversationId));

    const row = await store.getConvo(userId, conversationId);
    expect(row?.isTemporary).toBe(true);
    expect(row?.expiredAt).toBeInstanceOf(Date);
  });

  it('settles instead of rejecting when the lookup fails, so the message still saves', async () => {
    const failingStore = {
      ...store,
      getConvo: jest.fn().mockRejectedValue(new Error('database unavailable')),
    };

    await expect(
      seedTurnConversation(
        failingStore,
        seedFields(createRequest(new mongoose.Types.ObjectId().toString()), randomUUID()),
      ),
    ).resolves.toBeUndefined();
  });

  it('does nothing for a request without a user', async () => {
    const saveConvo = jest.spyOn(store, 'saveConvo');

    await seedTurnConversation(store, seedFields({ body: {} }, randomUUID()));

    expect(saveConvo).not.toHaveBeenCalled();
  });
});

describe('recoverTurnMessageReference', () => {
  /** The whole failure path, in order: the user-message write fails and is swallowed, the
   *  response's write creates the row referencing only itself, the terminal retries the user
   *  row with a bare `saveMessage` that never touches the conversation, and the recovery
   *  carries the reference the turn would otherwise have lost for good. */
  const runFailedUserWriteTurn = async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const conversationId = randomUUID();
    const req = createRequest(userId);
    const ctx = getConversationWriteContext(req);

    const responseRow = await store.saveMessage(ctx, {
      messageId: randomUUID(),
      conversationId,
      text: 'Answer',
      isCreatedByUser: false,
    });
    await saveTurnConversation(store, {
      ...seedFields(req, conversationId),
      ctx,
      savedMessageId: responseRow?._id,
    });

    /** The retry: the row is restored, the conversation is not told. */
    const recoveredUserRow = await store.saveMessage(ctx, {
      messageId: randomUUID(),
      conversationId,
      text: 'First message',
      isCreatedByUser: true,
    });

    return { userId, conversationId, ctx, responseRow, recoveredUserRow };
  };

  it('appends a recovered reference the conversation never received', async () => {
    const turn = await runFailedUserWriteTurn();
    const before = await store.getConvo(turn.userId, turn.conversationId);
    expect(before?.messages?.map(String)).toEqual([String(turn.responseRow?._id)]);

    const wrote = await recoverTurnMessageReference(store, {
      userId: turn.userId,
      conversationId: turn.conversationId,
      messageId: String(turn.recoveredUserRow?._id),
      alreadyRecorded: false,
      managesConversation: true,
      context: 'save.spec recovery',
    });

    expect(wrote).toBe(true);
    const row = await store.getConvo(turn.userId, turn.conversationId);
    expect(row?.messages?.map(String)).toEqual(
      [turn.responseRow?._id, turn.recoveredUserRow?._id].map(String),
    );
  });

  it('is idempotent, so a repeated recovery cannot duplicate the reference', async () => {
    const turn = await runFailedUserWriteTurn();
    const recovery = {
      userId: turn.userId,
      conversationId: turn.conversationId,
      messageId: String(turn.recoveredUserRow?._id),
      alreadyRecorded: false,
      managesConversation: true,
      context: 'save.spec recovery',
    };

    await recoverTurnMessageReference(store, recovery);
    await recoverTurnMessageReference(store, recovery);

    const row = await store.getConvo(turn.userId, turn.conversationId);
    expect(row?.messages?.map(String)).toEqual(
      [turn.responseRow?._id, turn.recoveredUserRow?._id].map(String),
    );
  });

  /** A repair is bookkeeping beside an already-durable row, so it reorders nothing. */
  it('does not count as activity, leaving the sidebar order alone', async () => {
    const turn = await runFailedUserWriteTurn();
    const before = await store.getConvo(turn.userId, turn.conversationId);

    await recoverTurnMessageReference(store, {
      userId: turn.userId,
      conversationId: turn.conversationId,
      messageId: String(turn.recoveredUserRow?._id),
      alreadyRecorded: false,
      managesConversation: true,
      context: 'save.spec recovery',
    });

    const after = await store.getConvo(turn.userId, turn.conversationId);
    expect(after?.updatedAt?.getTime()).toBe(before?.updatedAt?.getTime());
  });

  it.each([
    ['the reference is already recorded', { alreadyRecorded: true, managesConversation: true }],
    ['the turn does not own the row', { alreadyRecorded: false, managesConversation: false }],
  ])('writes nothing when %s', async (_label, overrides) => {
    const turn = await runFailedUserWriteTurn();
    const append = jest.spyOn(store, 'appendConvoMessageReference');

    const wrote = await recoverTurnMessageReference(store, {
      userId: turn.userId,
      conversationId: turn.conversationId,
      messageId: String(turn.recoveredUserRow?._id),
      context: 'save.spec recovery',
      ...overrides,
    });

    expect(wrote).toBe(false);
    expect(append).not.toHaveBeenCalled();
  });

  it.each([
    ['there is no recovered row to reference', undefined],
    ['the recovered id is empty', ''],
  ])('writes nothing when %s', async (_label, messageId) => {
    const turn = await runFailedUserWriteTurn();
    const append = jest.spyOn(store, 'appendConvoMessageReference');

    const wrote = await recoverTurnMessageReference(store, {
      userId: turn.userId,
      conversationId: turn.conversationId,
      messageId,
      alreadyRecorded: false,
      managesConversation: true,
      context: 'save.spec recovery',
    });

    expect(wrote).toBe(false);
    expect(append).not.toHaveBeenCalled();
  });

  it('never creates a row of its own', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const conversationId = randomUUID();

    const wrote = await recoverTurnMessageReference(store, {
      userId,
      conversationId,
      messageId: new mongoose.Types.ObjectId().toString(),
      alreadyRecorded: false,
      managesConversation: true,
      context: 'save.spec recovery',
    });

    expect(wrote).toBe(true);
    expect(await store.getConvo(userId, conversationId)).toBeNull();
  });

  /** The repair must never take a turn down with it: the message it points at is already
   *  durable, and the reference is the only thing at stake. */
  it('reports failure instead of throwing when the append fails', async () => {
    const turn = await runFailedUserWriteTurn();
    jest
      .spyOn(store, 'appendConvoMessageReference')
      .mockRejectedValue(new Error('Error appending the message reference'));

    await expect(
      recoverTurnMessageReference(store, {
        userId: turn.userId,
        conversationId: turn.conversationId,
        messageId: String(turn.recoveredUserRow?._id),
        alreadyRecorded: false,
        managesConversation: true,
        context: 'save.spec recovery',
      }),
    ).resolves.toBe(false);
  });
});

describe('runAfterSeed', () => {
  it('holds the write while the seed is in flight', async () => {
    let finishSeed: () => void = () => undefined;
    const seed = new Promise<void>((resolve) => {
      finishSeed = resolve;
    });
    const write = jest.fn().mockResolvedValue('written');

    const pending = runAfterSeed(seed, write)();
    expect(write).not.toHaveBeenCalled();

    finishSeed();
    await expect(pending).resolves.toBe('written');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('starts the write synchronously once the seed has landed', async () => {
    const seed = Promise.resolve();
    const write = jest.fn().mockResolvedValue('written');
    const start = runAfterSeed(seed, write);
    await seed;
    await Promise.resolve();

    void start();

    expect(write).toHaveBeenCalledTimes(1);
  });
});
