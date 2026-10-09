jest.mock('~/models', () => ({
  getConvoOwnership: jest.fn(),
}));

jest.mock('@librechat/api', () => ({
  createMessageRequestMiddleware:
    jest.requireActual('@librechat/api').createMessageRequestMiddleware,
  GenerationJobManager: {
    getJob: jest.fn(),
  },
  isPendingActionStale: jest.fn(() => false),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    warn: jest.fn(),
  },
}));

const validateMessageReq = require('../validateMessageReq');
const { getConvoOwnership } = require('~/models');
const { GenerationJobManager } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');

function createResponse() {
  const res = {
    json: jest.fn(),
    send: jest.fn(),
    status: jest.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}

describe('validateMessageReq', () => {
  const userId = 'user-123';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should reject requests when URL and body conversationId values differ', async () => {
    const req = {
      params: { conversationId: 'convo-owned' },
      body: { conversationId: 'convo-victim' },
      user: { id: userId },
    };
    const res = createResponse();
    const next = jest.fn();

    await validateMessageReq(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Conversation ID mismatch' });
    expect(getConvoOwnership).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject requests when URL and nested message conversationId values differ', async () => {
    const req = {
      params: { conversationId: 'convo-owned' },
      body: { message: { conversationId: 'convo-victim' } },
      user: { id: userId },
    };
    const res = createResponse();
    const next = jest.fn();

    await validateMessageReq(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Conversation ID mismatch' });
    expect(getConvoOwnership).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('should validate ownership against the URL conversationId when values match', async () => {
    const req = {
      params: { conversationId: 'convo-owned' },
      body: { conversationId: 'convo-owned' },
      user: { id: userId },
    };
    const res = createResponse();
    const next = jest.fn();
    getConvoOwnership.mockResolvedValue({ conversationId: 'convo-owned', user: userId });

    await validateMessageReq(req, res, next);

    expect(getConvoOwnership).toHaveBeenCalledWith(userId, 'convo-owned');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('returns not found for a direct child-thread message read', async () => {
    const req = {
      method: 'GET',
      params: { conversationId: 'child-convo', messageId: 'child-message' },
      body: {},
      user: { id: userId },
    };
    const res = createResponse();
    const next = jest.fn();
    getConvoOwnership.mockResolvedValue({
      user: userId,
      subagentThread: { parentConversationId: 'parent-convo' },
    });

    await validateMessageReq(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Conversation not found' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns not found for a HEAD request to a child thread', async () => {
    const req = {
      method: 'HEAD',
      params: { conversationId: 'child-convo' },
      body: {},
      user: { id: userId },
    };
    const res = createResponse();
    const next = jest.fn();
    getConvoOwnership.mockResolvedValue({
      user: userId,
      subagentThread: { parentConversationId: 'parent-convo' },
    });

    await validateMessageReq(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Conversation not found' });
    expect(next).not.toHaveBeenCalled();
  });

  it('should allow message reads for an owned active generation job before the conversation is saved', async () => {
    const req = {
      method: 'GET',
      params: { conversationId: 'active-convo' },
      body: {},
      user: { id: userId, tenantId: 'tenant-a' },
    };
    const res = createResponse();
    const next = jest.fn();
    getConvoOwnership.mockResolvedValue(null);
    GenerationJobManager.getJob.mockResolvedValue({
      status: 'running',
      metadata: { userId, tenantId: 'tenant-a' },
    });

    await validateMessageReq(req, res, next);

    expect(GenerationJobManager.getJob).toHaveBeenCalledWith('active-convo');
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('should allow message reads for an owned active generation job without tenant metadata', async () => {
    const req = {
      method: 'GET',
      params: { conversationId: 'active-convo' },
      body: {},
      user: { id: userId },
    };
    const res = createResponse();
    const next = jest.fn();
    getConvoOwnership.mockResolvedValue(null);
    GenerationJobManager.getJob.mockResolvedValue({
      status: 'running',
      metadata: { userId },
    });

    await validateMessageReq(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('should reject active job message reads owned by another user', async () => {
    const req = {
      method: 'GET',
      params: { conversationId: 'active-convo' },
      body: {},
      user: { id: userId },
    };
    const res = createResponse();
    const next = jest.fn();
    getConvoOwnership.mockResolvedValue(null);
    GenerationJobManager.getJob.mockResolvedValue({
      status: 'running',
      metadata: { userId: 'another-user' },
    });

    await validateMessageReq(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Conversation not found' });
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject active job message reads from another tenant', async () => {
    const req = {
      method: 'GET',
      params: { conversationId: 'active-convo' },
      body: {},
      user: { id: userId, tenantId: 'tenant-a' },
    };
    const res = createResponse();
    const next = jest.fn();
    getConvoOwnership.mockResolvedValue(null);
    GenerationJobManager.getJob.mockResolvedValue({
      status: 'running',
      metadata: { userId, tenantId: 'tenant-b' },
    });

    await validateMessageReq(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Conversation not found' });
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject message-by-id reads before the conversation is saved', async () => {
    const req = {
      method: 'GET',
      params: { conversationId: 'active-convo', messageId: 'message-id' },
      body: {},
      user: { id: userId },
    };
    const res = createResponse();
    const next = jest.fn();
    getConvoOwnership.mockResolvedValue(null);

    await validateMessageReq(req, res, next);

    expect(GenerationJobManager.getJob).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Conversation not found' });
    expect(next).not.toHaveBeenCalled();
  });

  it('should return not found when active job lookup fails', async () => {
    const req = {
      method: 'GET',
      params: { conversationId: 'active-convo' },
      body: {},
      user: { id: userId },
    };
    const res = createResponse();
    const next = jest.fn();
    const error = new Error('job store unavailable');
    getConvoOwnership.mockResolvedValue(null);
    GenerationJobManager.getJob.mockRejectedValue(error);

    await validateMessageReq(req, res, next);

    expect(GenerationJobManager.getJob).toHaveBeenCalledWith('active-convo');
    expect(logger.warn).toHaveBeenCalledWith(
      '[validateMessageReq] Active job lookup failed for active-convo:',
      error,
    );
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Conversation not found' });
    expect(next).not.toHaveBeenCalled();
  });

  it('should not allow unsaved conversation writes through active job ownership', async () => {
    const req = {
      method: 'POST',
      params: { conversationId: 'active-convo' },
      body: {},
      user: { id: userId },
    };
    const res = createResponse();
    const next = jest.fn();
    getConvoOwnership.mockResolvedValue(null);

    await validateMessageReq(req, res, next);

    expect(GenerationJobManager.getJob).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });
});
