const { v4: uuidv4 } = require('uuid');
const mockSaveMessage = jest.fn();
const mockSendEvent = jest.fn();
const mockSendError = jest.fn().mockResolvedValue(undefined);

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  sendEvent: (...args) => mockSendEvent(...args),
}));
jest.mock('~/models', () => ({
  saveMessage: (...args) => mockSaveMessage(...args),
}));
jest.mock('~/server/middleware/error', () => ({
  sendError: (...args) => mockSendError(...args),
}));

const { createPrivateTextIngress } = require('@librechat/api');
const denyRequest = require('./denyRequest');
const original = 'alice@example.com';

beforeEach(() => {
  jest.clearAllMocks();
  mockSaveMessage.mockImplementation(async (_ctx, message, metadata) => ({
    ...message,
    ...(metadata?.privateText && { privacyRevision: metadata.privateText.revision }),
  }));
});

it('encrypts denied PII for an existing conversation and sends only the filtered view', async () => {
  const req = {
    method: 'POST',
    path: '/',
    originalUrl: '/api/agents/chat',
    config: {
      filters: {
        messages: {
          pii: {
            action: 'redact',
            fields: ['text'],
            starterPatterns: [],
            customPatterns: [
              { id: 'email', label: 'Email', regex: 'alice@example\\.com', category: 'email' },
            ],
          },
        },
      },
    },
    user: { id: 'owner', tenantId: 'tenant-a' },
    body: {
      text: `Email ${original}`,
      messageId: uuidv4(),
      conversationId: uuidv4(),
      parentMessageId: uuidv4(),
      clientRequestId: uuidv4(),
    },
  };
  const res = {};
  const next = jest.fn();
  createPrivateTextIngress({
    getFilters: () => req.config.filters,
    getLegacyPii: () => undefined,
    getKey: () => 'ab'.repeat(32),
  })(req, res, next);
  expect(next).toHaveBeenCalledTimes(1);
  await denyRequest(req, res, { type: 'message_limit' });

  expect(mockSendEvent).toHaveBeenCalledTimes(1);
  const event = mockSendEvent.mock.calls[0][1];
  const [ctx, saved, metadata] = mockSaveMessage.mock.calls[0];
  expect(mockSaveMessage).toHaveBeenCalledTimes(1);
  expect(mockSaveMessage.mock.invocationCallOrder[0]).toBeLessThan(
    mockSendEvent.mock.invocationCallOrder[0],
  );
  expect(ctx.userId).toBe('owner');
  expect(saved.text).toMatch(/^Email \[EMAIL_1_[a-f0-9]{32}\]$/);
  expect(saved.privacyRevision).toBe(event.message.privacyRevision);
  expect(metadata.privateText).toMatchObject({ revision: event.message.privacyRevision });
  expect(metadata.privateText.envelope).toMatch(/^v1:/);
  expect(event.message.text).toBe(saved.text);
  expect(JSON.stringify({ event, ctx, saved, metadata })).not.toContain(original);
  expect(mockSendError).toHaveBeenCalledWith(
    req,
    res,
    expect.objectContaining({ shouldSaveMessage: true }),
  );
});

it('does not advertise an original on a denied first turn that is never persisted', async () => {
  const req = {
    method: 'POST',
    path: '/',
    originalUrl: '/api/agents/chat',
    config: {
      filters: {
        messages: {
          pii: {
            action: 'redact',
            fields: ['text'],
            starterPatterns: [],
            customPatterns: [
              { id: 'email', label: 'Email', regex: 'alice@example\\.com', category: 'email' },
            ],
          },
        },
      },
    },
    user: { id: 'owner', tenantId: 'tenant-a' },
    body: { text: `Email ${original}`, clientRequestId: uuidv4() },
  };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  createPrivateTextIngress({
    getFilters: () => req.config.filters,
    getLegacyPii: () => undefined,
    getKey: () => 'ab'.repeat(32),
  })(req, res, next);
  expect(next).toHaveBeenCalledTimes(1);
  await denyRequest(req, res, { type: 'ban' });

  expect(mockSaveMessage).not.toHaveBeenCalled();
  expect(mockSendEvent).toHaveBeenCalledTimes(1);
  expect(mockSendEvent.mock.calls[0][1].message).toMatchObject({
    text: expect.stringMatching(/^Email \[EMAIL_1_[a-f0-9]{32}\]$/),
    isCreatedByUser: true,
  });
  expect(mockSendEvent.mock.calls[0][1].message).not.toHaveProperty('privacyRevision');
  expect(JSON.stringify(mockSendEvent.mock.calls)).not.toContain(original);
  expect(mockSendError).toHaveBeenCalledWith(
    req,
    res,
    expect.objectContaining({ shouldSaveMessage: false }),
  );
});

it('fails closed before event or storage when denial hits untransformed private text', async () => {
  const req = {
    path: '/',
    user: { id: 'owner', tenantId: 'tenant-a' },
    config: {
      filters: {
        messages: {
          pii: {
            action: 'redact',
            fields: ['text'],
            starterPatterns: [],
            customPatterns: [
              { id: 'email', label: 'Email', regex: 'alice@example\\.com', category: 'email' },
            ],
          },
        },
      },
    },
    body: {
      text: `Email ${original}`,
      files: [{}],
      messageId: uuidv4(),
      conversationId: uuidv4(),
      parentMessageId: uuidv4(),
      clientRequestId: uuidv4(),
    },
  };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  createPrivateTextIngress({
    getFilters: () => req.config.filters,
    getLegacyPii: () => undefined,
    getKey: () => 'ab'.repeat(32),
  })(req, res, next);
  expect(next).toHaveBeenCalledTimes(1);
  await denyRequest(req, res, { type: 'message_limit' });
  expect(res.status).toHaveBeenCalledWith(400);
  expect(JSON.stringify(res.json.mock.calls)).not.toContain(original);
  expect(mockSendEvent).not.toHaveBeenCalled();
  expect(mockSaveMessage).not.toHaveBeenCalled();
  expect(mockSendError).not.toHaveBeenCalled();
});

it.each(['redact', 'block'])(
  'rejects a queued-turn denial before events or storage with %s policy',
  async (action) => {
    const req = {
      method: 'POST',
      originalUrl: '/api/agents/chat/queued-turns',
      user: { id: 'owner', tenantId: 'tenant-a' },
      config: {
        filters: {
          messages: {
            pii: {
              action,
              fields: ['text'],
              starterPatterns: [],
              customPatterns: [
                { id: 'email', label: 'Email', regex: 'alice@example\\.com', category: 'email' },
              ],
            },
          },
        },
      },
      body: { text: `Email ${original}`, conversationId: uuidv4(), parentMessageId: uuidv4() },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await denyRequest(req, res, { type: 'ban' });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(JSON.stringify(res.json.mock.calls)).not.toContain(original);
    expect(mockSendEvent).not.toHaveBeenCalled();
    expect(mockSaveMessage).not.toHaveBeenCalled();
  },
);

it('fails closed on a denied Agent submission when its policy was not loaded', async () => {
  const req = {
    method: 'POST',
    originalUrl: '/api/agents/chat/queued-turns',
    user: { id: 'owner' },
    body: { text: original, conversationId: uuidv4(), parentMessageId: uuidv4() },
  };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await denyRequest(req, res, { type: 'ban' });
  expect(res.status).toHaveBeenCalledWith(400);
  expect(mockSendEvent).not.toHaveBeenCalled();
  expect(mockSaveMessage).not.toHaveBeenCalled();
});

it('retains the existing denial behavior when no PII transformer ran', async () => {
  const req = {
    user: { id: 'owner' },
    body: {
      text: 'ordinary message',
      messageId: uuidv4(),
      conversationId: uuidv4(),
      parentMessageId: uuidv4(),
    },
  };
  await denyRequest(req, {}, { type: 'message_limit' });
  expect(mockSaveMessage).toHaveBeenCalledWith(
    expect.objectContaining({ userId: 'owner' }),
    expect.objectContaining({ text: 'ordinary message' }),
    expect.not.objectContaining({ privateText: expect.anything() }),
  );
});
