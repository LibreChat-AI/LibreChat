import type { MessageMethods, IMessage } from '@librechat/data-schemas';
import type { FiltersConfig } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import {
  createPrivateTextIngress,
  savePrivateTextMessage,
  stampPrivateTextMessage,
  stampPreliminaryPrivateTextMessage,
  requirePrivateTextPersistence,
  saveAbortedUserMessage,
  isPreDenialTextSubmission,
  isPrivateTextChatSubmission,
  privateTextBinding,
} from './submission';
import { createPrivateTextCipher } from './crypto';
import { createPrivateTextView } from './view';

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const key = 'ab'.repeat(32);
const original = 'Email alice@example.com';
const filters: FiltersConfig = {
  messages: {
    pii: {
      action: 'redact',
      fields: ['text'],
      starterPatterns: [],
      customPatterns: [
        { id: 'email', label: 'Email', regex: '[a-z]+@[a-z]+\\.[a-z]+', category: 'email' },
      ],
    },
  },
};
function submit(overrides: object = {}, encryptionKey = key) {
  const req = {
    path: '/',
    user: { id: 'owner', tenantId: 'tenant-a' },
    body: { text: original, clientRequestId: 'request-1', ...overrides },
  } as unknown as Request;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), setHeader: jest.fn() };
  const next = jest.fn();
  createPrivateTextIngress({
    getFilters: () => filters,
    getLegacyPii: () => undefined,
    getKey: () => encryptionKey,
  })(req, res as unknown as Response, next);
  const message = stampPrivateTextMessage(req, {
    messageId: 'message-1',
    conversationId: 'conversation-1',
    isCreatedByUser: true,
    text: req.body.text,
  });
  return { req, res, next, message };
}

describe('private text submission boundary', () => {
  it('limits early processing to interactive POSTs, excluding controls and queued work', () => {
    for (const path of ['/api/agents/chat', '/api/agents/chat/safe-ephemeral']) {
      expect(
        isPrivateTextChatSubmission({
          method: 'POST',
          originalUrl: path,
          body: { text: original },
        } as Request),
      ).toBe(true);
    }
    for (const path of [
      '/api/agents/chat/abort',
      '/api/agents/chat/resume',
      '/api/agents/chat/queued-turns',
      '/api/agents/chat/steer',
      '/api/agents/chat/status/one',
    ]) {
      expect(
        isPrivateTextChatSubmission({
          method: 'POST',
          originalUrl: path,
          body: { text: original },
        } as Request),
      ).toBe(false);
    }
    expect(
      isPreDenialTextSubmission({
        method: 'POST',
        body: { text: original },
      } as Request),
    ).toBe(true);
    expect(
      isPrivateTextChatSubmission({
        method: 'GET',
        originalUrl: '/api/agents/chat',
        body: { text: original },
      } as Request),
    ).toBe(false);
  });

  it('preserves the exact encrypted user row on Stop and fails closed when missing', async () => {
    const saveMessage: MessageMethods['saveMessage'] = jest.fn(
      async (_ctx, message) => message as IMessage,
    );
    const hasPersistedPrivateText = jest.fn(async () => true);
    const getPrivateMessageTexts = jest.fn(async (): Promise<never[]> => []);
    const store = { saveMessage, hasPersistedPrivateText, getPrivateMessageTexts };
    const { message } = submit();
    expect(
      await saveAbortedUserMessage(
        store,
        { userId: 'owner' },
        message,
        { context: 'Stop' },
        'tenant-a',
      ),
    ).toBe(true);
    expect(hasPersistedPrivateText).toHaveBeenCalledWith({
      userId: 'owner',
      tenantId: 'tenant-a',
      conversationId: message.conversationId,
      messageId: message.messageId,
      text: message.text,
      privacyRevision: message.privacyRevision,
    });
    expect(saveMessage).not.toHaveBeenCalled();
    hasPersistedPrivateText.mockResolvedValueOnce(false);
    await expect(
      saveAbortedUserMessage(store, { userId: 'owner' }, message, { context: 'Stop' }, 'tenant-a'),
    ).rejects.toThrow('private value');
    expect(saveMessage).not.toHaveBeenCalled();
    expect(
      await saveAbortedUserMessage(
        store,
        { userId: 'owner' },
        {
          ...message,
          text: 'ordinary turn without private values',
          privacyRevision: undefined,
        },
        { context: 'ordinary Stop' },
        'tenant-a',
      ),
    ).toBe(true);
    expect(saveMessage).toHaveBeenCalledTimes(1);
  });

  it('checks old revisionless protected jobs against storage instead of overwriting them', async () => {
    const { message } = submit();
    const saveMessage = jest.fn(async () => message as IMessage);
    const getPrivateMessageTexts = jest.fn(async () => [
      {
        messageId: message.messageId!,
        text: message.text!,
        privacyRevision: message.privacyRevision!,
        privateText: 'v1:encrypted',
      },
    ]);
    const store = {
      saveMessage,
      hasPersistedPrivateText: jest.fn(async () => true),
      getPrivateMessageTexts,
    };
    const finalEvent = { requestMessage: { messageId: message.messageId, privacyRevision: '' } };
    const older = { ...message, privacyRevision: undefined };
    expect(
      await saveAbortedUserMessage(
        store,
        { userId: 'owner' },
        older,
        undefined,
        'tenant-a',
        finalEvent,
      ),
    ).toBe(true);
    expect(saveMessage).not.toHaveBeenCalled();
    expect(finalEvent.requestMessage.privacyRevision).toBe(message.privacyRevision);
    getPrivateMessageTexts.mockResolvedValueOnce([]);
    await expect(
      saveAbortedUserMessage(store, { userId: 'owner' }, older, undefined, 'tenant-a'),
    ).rejects.toThrow('private value');
    expect(saveMessage).not.toHaveBeenCalled();
  });

  it('stamps a protected preliminary job message before the created event', () => {
    const { req, message } = submit();
    const preliminary = stampPreliminaryPrivateTextMessage(req, {
      messageId: message.messageId,
      conversationId: message.conversationId,
      text: message.text,
    });
    expect(preliminary?.privacyRevision).toBe(message.privacyRevision);
    expect(JSON.stringify(preliminary)).not.toContain(original);
    expect(stampPreliminaryPrivateTextMessage(req, null)).toBeNull();
  });

  it('replaces request text before consumers and exposes no original in metadata or serialization', () => {
    const { req, message, next } = submit();
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.body.text).toMatch(/^Email \[EMAIL_1_[a-f0-9]{32}\]$/);
    expect(message).toHaveProperty('privacyRevision');
    expect(JSON.stringify({ req, message })).not.toContain('alice@example.com');
  });

  it('uses stable retry revisions and distinct namespaces for different turns or originals', () => {
    const first = submit().message;
    expect(submit().message).toEqual(first);
    expect(submit({ clientRequestId: 'request-2' }).message.text).not.toBe(first.text);
    expect(submit({ text: 'Email bob@example.com' }).message.text).not.toBe(first.text);
  });

  it.each([
    { files: [{}] },
    { quotes: ['quote'] },
    { isRegenerate: true },
    { isEdited: true },
    { isContinued: true },
    { editedContent: {} },
    { recoverySteerId: 'steer' },
  ])('leaves unsupported submissions to the existing blocking inspector: %j', (extra) => {
    const { req, next, message } = submit(extra);
    expect(req.body.text).toBe(original);
    expect(message).not.toHaveProperty('privacyRevision');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('fails closed without a valid key and does not echo matched text', () => {
    const { next, res } = submit({}, '');
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(JSON.stringify(res.json.mock.calls)).not.toContain(original);
  });

  it('commits canonical text and ciphertext together and binds the owner view to final identity', async () => {
    const { req, message } = submit();
    let envelope = '';
    const save: MessageMethods['saveMessage'] = jest.fn(async (_ctx, value, metadata) => {
      envelope = metadata?.privateText?.envelope ?? '';
      expect(JSON.stringify({ value, metadata })).not.toContain(original);
      return { ...value, privacyRevision: metadata?.privateText?.revision } as IMessage;
    });
    const stored = await savePrivateTextMessage(save, req, { userId: 'owner' }, message);
    expect(save).toHaveBeenCalledTimes(1);
    const cipher = createPrivateTextCipher(key);
    const binding = privateTextBinding('owner', 'tenant-a', stored!);
    expect(cipher.open(envelope, binding)).toBe(original);
    for (let index = 0; index < binding.length; index++) {
      const tampered = [...binding];
      tampered[index] += '-changed';
      expect(() => cipher.open(envelope, tampered)).toThrow('Private message text is unavailable.');
    }
    expect(() => createPrivateTextCipher('cd'.repeat(32)).open(envelope, binding)).toThrow();
    expect(() => cipher.open(envelope.slice(0, -4) + 'abcd', binding)).toThrow();
    await expect(savePrivateTextMessage(save, req, { userId: 'other' }, message)).rejects.toThrow();
  });

  it('does not release main provider admission until persistence finishes', async () => {
    const { req, message } = submit();
    let finish!: (result: { message: typeof message }) => void;
    const pending = new Promise<{ message: typeof message }>((resolve) => {
      finish = resolve;
    });
    const provider = jest.fn();
    const started = requirePrivateTextPersistence(req, () => pending).then(provider);
    await Promise.resolve();
    expect(provider).not.toHaveBeenCalled();
    finish({ message });
    await started;
    expect(provider).toHaveBeenCalledTimes(1);
    await expect(requirePrivateTextPersistence(req, async () => ({}))).rejects.toThrow();
    await expect(
      requirePrivateTextPersistence(req, async () => {
        throw new Error('write failed');
      }),
    ).rejects.toThrow();
  });

  it('rejects stale or swallowed persistence results, including a duplicate ID with different text', async () => {
    const { req, message } = submit();
    const save: MessageMethods['saveMessage'] = jest.fn(async () => undefined);
    await expect(savePrivateTextMessage(save, req, { userId: 'owner' }, message)).rejects.toThrow();
    await expect(
      requirePrivateTextPersistence(req, async () => ({ message: { ...message, text: 'stale' } })),
    ).rejects.toThrow();
  });

  it('returns original text only from the authenticated private view, with no-store headers', async () => {
    const { req, message } = submit();
    const cipher = createPrivateTextCipher(key);
    const row = {
      ...message,
      privacyRevision: message.privacyRevision!,
      privateText: cipher.seal(original, privateTextBinding('owner', 'tenant-a', message)),
    };
    const read = jest.fn(async () => [row]);
    const handler = createPrivateTextView({ read, getKey: () => key });
    req.params = { conversationId: 'conversation-1' };
    req.body = { messageIds: ['message-1'] };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), setHeader: jest.fn() };
    await handler(req, res as unknown as Response, jest.fn());
    expect(read).toHaveBeenCalledWith({
      userId: 'owner',
      tenantId: 'tenant-a',
      conversationId: 'conversation-1',
      messageIds: ['message-1'],
    });
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(res.json).toHaveBeenCalledWith({
      messages: [
        {
          messageId: 'message-1',
          revision: row.privacyRevision,
          canonicalText: row.text,
          text: original,
        },
      ],
    });
    req.body.messageIds = Array(51).fill('message-1');
    await handler(req, res as unknown as Response, jest.fn());
    expect(res.status).toHaveBeenLastCalledWith(400);
    expect(read).toHaveBeenCalledTimes(1);
    await handler(
      { params: req.params, body: { messageIds: ['message-1'] } } as Request,
      res as unknown as Response,
      jest.fn(),
    );
    expect(res.status).toHaveBeenLastCalledWith(401);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('returns no original when a stored row has changed canonical text or the key is unavailable', async () => {
    const { message, req } = submit();
    const cipher = createPrivateTextCipher(key);
    const privateText = cipher.seal(original, privateTextBinding('owner', 'tenant-a', message));
    const read = jest.fn(async () => [
      {
        ...message,
        text: 'edited canonical',
        privacyRevision: message.privacyRevision!,
        privateText,
      },
    ]);
    req.params = { conversationId: 'conversation-1' };
    req.body = { messageIds: ['message-1'] };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), setHeader: jest.fn() };
    await createPrivateTextView({ read, getKey: () => key })(
      req,
      res as unknown as Response,
      jest.fn(),
    );
    expect(JSON.stringify(res.json.mock.calls)).not.toContain(original);
    expect(res.status).toHaveBeenLastCalledWith(200);
    await createPrivateTextView({ read, getKey: () => '' })(
      req,
      res as unknown as Response,
      jest.fn(),
    );
    expect(res.status).toHaveBeenLastCalledWith(503);
    expect(JSON.stringify(res.json.mock.calls)).not.toContain(original);
  });
});
