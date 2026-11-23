/**
 * Tests for sendError's reply stamping.
 *
 * A terminal error is a persisted assistant turn, and on the fallback paths that reach here it
 * is the only one written: without a stamp another device never learns the run ended.
 */

const mockSaveMessage = jest.fn();
const mockStampConvoLastResponse = jest.fn();
const mockHandleError = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

jest.mock('@librechat/api', () => ({
  sendEvent: jest.fn(),
  handleError: (...args) => mockHandleError(...args),
  sanitizeMessageForTransmit: jest.fn((message) => message),
  /** Real, because when an error turn is stamped and what its event carries is under test. */
  announceErrorTurn: jest.requireActual('@librechat/api').announceErrorTurn,
}));

jest.mock('~/models', () => ({
  saveMessage: (...args) => mockSaveMessage(...args),
  getMessages: jest.fn().mockResolvedValue([]),
  getConvo: jest.fn().mockResolvedValue({}),
  stampConvoLastResponse: (...args) => mockStampConvoLastResponse(...args),
}));

const { sendError } = require('./error');

const CONVO_ID = 'convo-errored';

const options = {
  user: 'user-123',
  sender: 'AI',
  conversationId: CONVO_ID,
  messageId: 'error-msg',
  parentMessageId: 'user-msg',
  text: 'Something went wrong',
  shouldSaveMessage: true,
};

const reqWith = (body = {}) => ({ user: { id: 'user-123' }, body, config: {} });

describe('sendError', () => {
  const stampedAt = new Date('2026-08-16T10:00:00.000Z');
  const updatedAt = new Date('2026-08-16T10:00:00.001Z');

  beforeEach(() => {
    mockSaveMessage.mockReset();
    mockSaveMessage.mockImplementation(async (_ctx, message) => message);
    mockStampConvoLastResponse.mockReset();
    mockStampConvoLastResponse.mockResolvedValue({
      lastResponseAt: stampedAt,
      lastResponseMessageId: 'error-msg',
      updatedAt,
    });
    mockHandleError.mockReset();
  });

  it('stamps the conversation once the error reply is durable and emits that settled read state', async () => {
    await sendError(reqWith(), {}, options);

    expect(mockStampConvoLastResponse).toHaveBeenCalledWith('user-123', CONVO_ID, 'error-msg');
    expect(mockHandleError).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        conversation: {
          conversationId: CONVO_ID,
          lastResponseAt: stampedAt,
          lastResponseMessageId: 'error-msg',
          updatedAt,
        },
      }),
    );
  });

  it('never stamps or exposes a temporary conversation', async () => {
    await sendError(reqWith({ isTemporary: true }), {}, options);

    expect(mockStampConvoLastResponse).not.toHaveBeenCalled();
    expect(mockHandleError).toHaveBeenCalledWith(
      {},
      expect.not.objectContaining({ conversation: expect.anything() }),
    );
  });

  it('never stamps or exposes a reply the message write did not persist', async () => {
    /* Announcing a reply that is absent from message history would show a dot for a message
       nobody can open. */
    mockSaveMessage.mockResolvedValue(null);

    await sendError(reqWith(), {}, options);

    expect(mockStampConvoLastResponse).not.toHaveBeenCalled();
    expect(mockHandleError).toHaveBeenCalledWith(
      {},
      expect.not.objectContaining({ conversation: expect.anything() }),
    );
  });

  it('never exposes a read stamp when the indicator write fails', async () => {
    mockStampConvoLastResponse.mockRejectedValue(new Error('mongo is down'));

    await expect(sendError(reqWith(), {}, options)).resolves.toBeUndefined();

    expect(mockHandleError).toHaveBeenCalledWith(
      {},
      expect.not.objectContaining({ conversation: expect.anything() }),
    );
  });

  it('does not expose a stamp when the conversation cannot be settled', async () => {
    mockStampConvoLastResponse.mockResolvedValue(null);

    await sendError(reqWith(), {}, options);

    expect(mockHandleError).toHaveBeenCalledWith(
      {},
      expect.not.objectContaining({ conversation: expect.anything() }),
    );
  });

  it('leaves the stamp alone when the caller does not persist the message', async () => {
    await sendError(reqWith(), {}, { ...options, shouldSaveMessage: false });

    expect(mockSaveMessage).not.toHaveBeenCalled();
    expect(mockStampConvoLastResponse).not.toHaveBeenCalled();
  });
});
