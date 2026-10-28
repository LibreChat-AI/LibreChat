const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { ViolationTypes } = require('librechat-data-provider');

const mockCache = {
  get: jest.fn(),
  set: jest.fn(),
};

jest.mock('~/cache', () => ({
  getLogStores: jest.fn(() => mockCache),
  logViolation: jest.fn(),
}));

jest.mock('~/server/middleware/denyRequest', () => jest.fn(async () => undefined));

const denyRequest = require('~/server/middleware/denyRequest');
const { Conversation } = require('~/db/models');
const validateConvoAccess = require('./convoAccess');

const OWNER_ID = new mongoose.Types.ObjectId().toString();
const OTHER_ID = new mongoose.Types.ObjectId().toString();
const CONVERSATION_ID = 'conversation-under-test';

function createRequest(userId, conversationId) {
  return {
    user: { id: userId },
    body: { conversationId, text: 'hello' },
  };
}

describe('validateConvoAccess', () => {
  let mongoServer;
  let res;
  let next;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await Conversation.create({
      conversationId: CONVERSATION_ID,
      user: OWNER_ID,
      endpoint: 'agents',
      title: 'Owned conversation',
      files: ['file-1', 'file-2'],
      isTemporary: true,
      expiredAt: new Date('2030-01-01T00:00:00.000Z'),
      messages: Array.from({ length: 50 }, () => new mongoose.Types.ObjectId()),
    });
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(() => {
    mockCache.get.mockReset().mockResolvedValue(undefined);
    mockCache.set.mockReset().mockResolvedValue(true);
    denyRequest.mockClear();
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    next = jest.fn();
  });

  it('stashes the full conversation document for downstream readers when access is granted', async () => {
    const req = createRequest(OWNER_ID, CONVERSATION_ID);

    await validateConvoAccess(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(denyRequest).not.toHaveBeenCalled();
    expect(req.resolvedConversation).toMatchObject({
      conversationId: CONVERSATION_ID,
      user: OWNER_ID,
      title: 'Owned conversation',
      files: ['file-1', 'file-2'],
    });
    expect(req.resolvedConversation).not.toHaveProperty('messages');
  });

  it('stashes null when the conversation does not exist so later readers skip their own lookup', async () => {
    const req = createRequest(OWNER_ID, 'never-created');

    await validateConvoAccess(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(Object.prototype.hasOwnProperty.call(req, 'resolvedConversation')).toBe(true);
    expect(req.resolvedConversation).toBeNull();
  });

  it("denies another user's conversation without exposing the document on the request", async () => {
    const req = createRequest(OTHER_ID, CONVERSATION_ID);

    await validateConvoAccess(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(denyRequest).toHaveBeenCalledTimes(1);
    expect(Object.prototype.hasOwnProperty.call(req, 'resolvedConversation')).toBe(false);
  });

  it('does not wait for the access marker to be written before continuing', async () => {
    mockCache.set.mockImplementation(() => new Promise(() => undefined));
    const req = createRequest(OWNER_ID, CONVERSATION_ID);

    await validateConvoAccess(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mockCache.set).toHaveBeenCalledWith(
      expect.stringContaining(`${OWNER_ID}:${CONVERSATION_ID}`),
      'authorized',
      expect.any(Number),
    );
  });

  it('skips the database entirely when access is already cached', async () => {
    mockCache.get.mockResolvedValue('authorized');
    const findOne = jest.spyOn(Conversation, 'findOne');
    const req = createRequest(OWNER_ID, CONVERSATION_ID);

    await validateConvoAccess(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(findOne).not.toHaveBeenCalled();
    expect(Object.prototype.hasOwnProperty.call(req, 'resolvedConversation')).toBe(false);
    expect(require('~/cache').getLogStores).toHaveBeenCalledWith(ViolationTypes.CONVO_ACCESS);
    findOne.mockRestore();
  });

  it('resolves stored retention on an authorization cache hit despite a forged flag', async () => {
    mockCache.get.mockResolvedValue('authorized');
    const findOne = jest.spyOn(Conversation, 'findOne');
    const req = createRequest(OWNER_ID, CONVERSATION_ID);
    req.body.isTemporary = false;
    req.config = { interfaceConfig: { retentionMode: 'all', generalChatRetention: 2160 } };
    await validateConvoAccess(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.resolvedConversation).toMatchObject({
      isTemporary: true,
      expiredAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    expect(findOne).toHaveBeenCalledTimes(1);
    findOne.mockRestore();
  });

  it.each([undefined, 'new'])(
    'marks a known-new conversation %s resolved without reading',
    async (conversationId) => {
      const findOne = jest.spyOn(Conversation, 'findOne');
      const req = createRequest(OWNER_ID, conversationId);
      req.config = { interfaceConfig: { retentionMode: 'all', generalChatRetention: 2160 } };
      await validateConvoAccess(req, res, next);
      expect(req.resolvedConversation).toBeNull();
      expect(next).toHaveBeenCalledTimes(1);
      expect(findOne).not.toHaveBeenCalled();
      findOne.mockRestore();
    },
  );
});
