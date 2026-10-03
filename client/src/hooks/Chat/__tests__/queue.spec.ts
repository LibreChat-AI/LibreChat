import type { TMessage } from 'librechat-data-provider';
import { resolveDetachedRunEnd } from '../queue';

const CONVO_ID = 'convo-detached';
const USER_ID = 'user-1';

const response = (overrides: Partial<TMessage> = {}): TMessage =>
  ({
    messageId: 'response-1',
    parentMessageId: USER_ID,
    conversationId: CONVO_ID,
    isCreatedByUser: false,
    text: 'done',
    ...overrides,
  }) as TMessage;

const userMessage = { messageId: USER_ID, isCreatedByUser: true } as TMessage;

describe('resolveDetachedRunEnd', () => {
  it('reports a completed run with its persisted response', () => {
    const end = resolveDetachedRunEnd(CONVO_ID, { userMessageId: USER_ID }, [
      userMessage,
      response(),
    ]);
    expect(end).toEqual(
      expect.objectContaining({
        conversationId: CONVO_ID,
        outcome: 'completed',
        responseMessageId: 'response-1',
      }),
    );
  });

  it('reports a failed run as an error, so the queue waits for a manual send', () => {
    const end = resolveDetachedRunEnd(CONVO_ID, { userMessageId: USER_ID }, [
      response({ error: true }),
    ]);
    expect(end?.outcome).toBe('error');
    expect(end?.responseMessageId).toBeUndefined();
  });

  it('reports an unfinished response as aborted', () => {
    const end = resolveDetachedRunEnd(CONVO_ID, { userMessageId: USER_ID }, [
      response({ unfinished: true }),
    ]);
    expect(end?.outcome).toBe('aborted');
  });

  it('returns nothing while no response to the run is persisted', () => {
    expect(resolveDetachedRunEnd(CONVO_ID, { userMessageId: USER_ID }, [userMessage])).toBeNull();
    expect(resolveDetachedRunEnd(CONVO_ID, { userMessageId: USER_ID }, undefined)).toBeNull();
  });

  it('picks the response the run created among regenerated siblings', () => {
    const end = resolveDetachedRunEnd(
      CONVO_ID,
      { userMessageId: USER_ID, responseMessageId: 'response-2_' },
      [response({ messageId: 'response-1', error: true }), response({ messageId: 'response-2' })],
    );
    expect(end).toEqual(
      expect.objectContaining({ outcome: 'completed', responseMessageId: 'response-2' }),
    );
  });

  it('matches a persisted response id that itself ends in an underscore', () => {
    const end = resolveDetachedRunEnd(
      CONVO_ID,
      { userMessageId: USER_ID, responseMessageId: 'response-2_' },
      [response({ messageId: 'response-1' }), response({ messageId: 'response-2_' })],
    );
    expect(end?.responseMessageId).toBe('response-2_');
  });

  it('leaves a run unresolved when the response it named is not loaded', () => {
    expect(
      resolveDetachedRunEnd(CONVO_ID, { userMessageId: USER_ID, responseMessageId: 'response-2' }, [
        response({ messageId: 'response-1' }),
      ]),
    ).toBeNull();
  });

  it('treats the padded user id placeholder as naming no response', () => {
    const end = resolveDetachedRunEnd(
      CONVO_ID,
      { userMessageId: USER_ID, responseMessageId: `${USER_ID}_` },
      [response({ messageId: 'server-response' })],
    );
    expect(end?.responseMessageId).toBe('server-response');
  });

  it('leaves a regeneration unresolved, since history still holds the reply it replaces', () => {
    expect(
      resolveDetachedRunEnd(
        CONVO_ID,
        { userMessageId: USER_ID, responseMessageId: 'response-1_', isRegenerate: true },
        [response({ messageId: 'response-1' })],
      ),
    ).toBeNull();
  });

  it('carries the run epoch so the drain can match server admission receipts', () => {
    const end = resolveDetachedRunEnd(
      CONVO_ID,
      { userMessageId: USER_ID, generationCreatedAt: 4200 },
      [response()],
    );
    expect(end?.generationCreatedAt).toBe(4200);
  });

  it('does not guess between siblings when the run named no response', () => {
    expect(
      resolveDetachedRunEnd(CONVO_ID, { userMessageId: USER_ID }, [
        response({ messageId: 'response-1' }),
        response({ messageId: 'response-2' }),
      ]),
    ).toBeNull();
  });
});
