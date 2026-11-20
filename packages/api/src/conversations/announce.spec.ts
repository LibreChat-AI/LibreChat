import { Types } from 'mongoose';
import {
  announceReply,
  announceErrorTurn,
  announceStoppedReply,
  isAnnounceableReply,
  settleAssistantFinal,
} from './announce';

const readable = [{ type: 'text', text: 'here is the answer' }];
const rowA = new Types.ObjectId().toString();
const rowB = new Types.ObjectId().toString();

describe('isAnnounceableReply', () => {
  it('announces a persisted reply that has something to read', () => {
    expect(isAnnounceableReply({ messageId: 'msg-1', content: readable })).toBe(true);
    expect(isAnnounceableReply({ messageId: 'msg-1', text: 'plain answer' })).toBe(true);
  });

  it('refuses a reply whose write resolved empty', () => {
    expect(isAnnounceableReply({ messageId: null, content: readable })).toBe(false);
    expect(isAnnounceableReply({ messageId: '', content: readable })).toBe(false);
  });

  /* A run cancelled before any output still persists the synthetic row the gap check built, and
     a Responses API completion carrying only reasoning or tool calls persists an empty `text`.
     Both render nothing, so a dot raised for them could never be cleared by opening the chat. */
  it('refuses a reply with nothing a reader could open', () => {
    expect(isAnnounceableReply({ messageId: 'msg-1', content: [] })).toBe(false);
    expect(isAnnounceableReply({ messageId: 'msg-1', text: '' })).toBe(false);
    expect(isAnnounceableReply({ messageId: 'msg-1', text: '   ' })).toBe(false);
    expect(
      isAnnounceableReply({ messageId: 'msg-1', content: [{ type: 'text', text: '  ' }] }),
    ).toBe(false);
  });

  it('refuses a temporary chat, which holds no row in the lists the indicator reads', () => {
    expect(isAnnounceableReply({ messageId: 'msg-1', content: readable, isTemporary: true })).toBe(
      false,
    );
  });
});

describe('announceReply', () => {
  it('stamps the persisted reply on its conversation', async () => {
    const stampConvoLastResponse = jest.fn().mockResolvedValue(undefined);
    const announced = await announceReply(
      { stampConvoLastResponse },
      {
        userId: 'user-1',
        conversationId: 'convo-1',
        reply: { messageId: 'msg-1', content: readable },
        context: 'spec',
      },
    );
    expect(announced).toBe(true);
    expect(stampConvoLastResponse).toHaveBeenCalledWith('user-1', 'convo-1', 'msg-1');
  });

  it.each([
    ['an unreadable reply', { messageId: 'msg-1', content: [] }],
    ['a temporary chat', { messageId: 'msg-1', content: readable, isTemporary: true }],
    ['an empty message write', { messageId: undefined, content: readable }],
  ])('writes nothing for %s', async (_case, reply) => {
    const stampConvoLastResponse = jest.fn();
    const announced = await announceReply(
      { stampConvoLastResponse },
      { userId: 'user-1', conversationId: 'convo-1', reply, context: 'spec' },
    );
    expect(announced).toBe(false);
    expect(stampConvoLastResponse).not.toHaveBeenCalled();
  });

  it('writes nothing without an owner or a conversation to stamp', async () => {
    const stampConvoLastResponse = jest.fn();
    const reply = { messageId: 'msg-1', content: readable };
    await announceReply(
      { stampConvoLastResponse },
      { userId: undefined, conversationId: 'convo-1', reply, context: 'spec' },
    );
    await announceReply(
      { stampConvoLastResponse },
      { userId: 'user-1', conversationId: '', reply, context: 'spec' },
    );
    expect(stampConvoLastResponse).not.toHaveBeenCalled();
  });

  /* The messages are already durable; failing a reply over its indicator would trade a missed
     dot for a lost response. */
  it('survives a failing stamp write', async () => {
    const stampConvoLastResponse = jest.fn().mockRejectedValue(new Error('mongo is away'));
    await expect(
      announceReply(
        { stampConvoLastResponse },
        {
          userId: 'user-1',
          conversationId: 'convo-1',
          reply: { messageId: 'msg-1', content: readable },
          context: 'spec',
        },
      ),
    ).resolves.toBe(false);
  });
});

describe('announceStoppedReply', () => {
  const ctx = { userId: 'user-1' };

  it('carries the stamp and the rows already written on the conversation upsert', async () => {
    const saveConvo = jest.fn().mockResolvedValue({ conversationId: 'convo-1' });
    const announced = await announceStoppedReply(
      { saveConvo },
      {
        ctx,
        conversationId: 'convo-1',
        endpoint: 'agents',
        model: 'gpt-5',
        reply: { messageId: 'msg-1', content: readable },
        appendMessageIds: [rowA, rowB],
        context: 'spec',
      },
    );
    expect(announced).toBe(true);
    expect(saveConvo).toHaveBeenCalledWith(
      ctx,
      { conversationId: 'convo-1', endpoint: 'agents', model: 'gpt-5' },
      expect.objectContaining({
        stampReply: true,
        replyMessageId: 'msg-1',
        appendMessageIds: [rowA, rowB],
      }),
    );
  });

  /* An interrupt before the model's first real token still persists the unfinished assistant
     row; a dot raised for it names a reply the user can never open. */
  it('leaves a stopped turn that produced nothing to read alone', async () => {
    const saveConvo = jest.fn();
    const announced = await announceStoppedReply(
      { saveConvo },
      {
        ctx,
        conversationId: 'convo-1',
        reply: { messageId: 'msg-1', content: [] },
        context: 'spec',
      },
    );
    expect(announced).toBe(false);
    expect(saveConvo).not.toHaveBeenCalled();
  });

  it('takes the temporary flag from the write context the turn runs under', async () => {
    const saveConvo = jest.fn();
    await announceStoppedReply(
      { saveConvo },
      {
        ctx: { userId: 'user-1', isTemporary: true },
        conversationId: 'convo-1',
        reply: { messageId: 'msg-1', content: readable },
        context: 'spec',
      },
    );
    expect(saveConvo).not.toHaveBeenCalled();
  });

  it('normalizes the ids the caller holds and drops rows that were never written', async () => {
    const saveConvo = jest.fn().mockResolvedValue({ conversationId: 'convo-1' });
    await announceStoppedReply(
      { saveConvo },
      {
        ctx,
        conversationId: 'convo-1',
        reply: { messageId: 'msg-1', content: readable },
        appendMessageIds: [null, new Types.ObjectId(rowA), undefined, rowB],
        context: 'spec',
      },
    );
    expect(saveConvo.mock.calls[0][2]).toMatchObject({ appendMessageIds: [rowA, rowB] });
  });

  it('omits an empty append set rather than sending one', async () => {
    const saveConvo = jest.fn().mockResolvedValue({ conversationId: 'convo-1' });
    await announceStoppedReply(
      { saveConvo },
      {
        ctx,
        conversationId: 'convo-1',
        reply: { messageId: 'msg-1', content: readable },
        context: 'spec',
      },
    );
    expect(saveConvo.mock.calls[0][2]).not.toHaveProperty('appendMessageIds');
  });

  it('survives a failing conversation write', async () => {
    const saveConvo = jest.fn().mockRejectedValue(new Error('mongo is away'));
    await expect(
      announceStoppedReply(
        { saveConvo },
        {
          ctx,
          conversationId: 'convo-1',
          reply: { messageId: 'msg-1', content: readable },
          context: 'spec',
        },
      ),
    ).resolves.toBe(false);
  });
});

describe('announceErrorTurn', () => {
  const settled = {
    lastResponseAt: '2026-09-22T12:00:00.000Z',
    lastResponseMessageId: 'err-1',
    updatedAt: '2026-09-22T12:00:00.000Z',
  };

  it('stamps a persisted error turn and returns the snapshot its event carries', async () => {
    const stampConvoLastResponse = jest.fn().mockResolvedValue(settled);
    const snapshot = await announceErrorTurn(
      { stampConvoLastResponse },
      { userId: 'user-1', conversationId: 'convo-1', messageId: 'err-1', context: 'spec' },
    );

    expect(stampConvoLastResponse).toHaveBeenCalledWith('user-1', 'convo-1', 'err-1');
    expect(snapshot).toEqual({ conversationId: 'convo-1', ...settled });
  });

  it.each([
    ['a temporary chat', { isTemporary: true }],
    ['an error write that resolved empty', { messageId: undefined }],
    ['a request without a user', { userId: undefined }],
  ])('writes nothing for %s', async (_case, override) => {
    const stampConvoLastResponse = jest.fn();
    const snapshot = await announceErrorTurn(
      { stampConvoLastResponse },
      {
        userId: 'user-1',
        conversationId: 'convo-1',
        messageId: 'err-1',
        context: 'spec',
        ...override,
      },
    );

    expect(snapshot).toBeUndefined();
    expect(stampConvoLastResponse).not.toHaveBeenCalled();
  });

  /* The error row is already durable; a failed stamp must not turn a handled error into a thrown one. */
  it('returns no snapshot, rather than throwing, when the stamp fails', async () => {
    const stampConvoLastResponse = jest.fn().mockRejectedValue(new Error('mongo is away'));
    await expect(
      announceErrorTurn(
        { stampConvoLastResponse },
        { userId: 'user-1', conversationId: 'convo-1', messageId: 'err-1', context: 'spec' },
      ),
    ).resolves.toBeUndefined();
  });
});

describe('settleAssistantFinal', () => {
  it('returns the plain settled conversation for the final event', async () => {
    const settled = { conversationId: 'convo-1', lastResponseAt: '2026-09-23T10:00:00.000Z' };
    const conversation = await settleAssistantFinal(async () => ({
      message: { messageId: 'msg-1' },
      conversation: { ...settled, toObject: () => settled },
    }));

    expect(conversation).toEqual(settled);
  });

  /* A save that persisted nothing is not a snapshot, so nothing may be published from it. */
  it('refuses to publish when the response row was not persisted', async () => {
    await expect(
      settleAssistantFinal(async () => ({ message: null, conversation: { conversationId: 'c' } })),
    ).rejects.toThrow('Assistant response could not be persisted before final publication');
  });

  it('refuses to publish when the conversation write returned its error shape', async () => {
    await expect(
      settleAssistantFinal(async () => ({
        message: { messageId: 'msg-1' },
        conversation: { message: 'Error saving conversation' },
      })),
    ).rejects.toThrow('Assistant conversation could not be persisted before final publication');
  });
});

describe('isAnnounceableReply attachments', () => {
  /* The message body renders attachments, and acknowledgement checks the body, so a reply made
     only of files can be both announced and cleared. */
  it('announces a reply made only of attachments', () => {
    expect(
      isAnnounceableReply({ messageId: 'msg-1', content: [], text: '', attachments: [{}] }),
    ).toBe(true);
  });

  it('does not treat an empty attachment list as something to read', () => {
    expect(isAnnounceableReply({ messageId: 'msg-1', content: [], attachments: [] })).toBe(false);
  });
});
