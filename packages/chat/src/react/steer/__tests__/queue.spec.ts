import { createStore } from 'jotai';
import { ContentTypes } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import type { DetachedRun } from '../../../core/steer/types';
import {
  settledQueuedTurnReceiptsByConvoId,
  queuedMessagesByConvoId,
  stopRequestedByConvoId,
  isDetachedRunManual,
} from '../queue';
import { resolveDetachedRunEnd, isStoppedRun } from '../../../core/steer/queue';

const CONVO_ID = 'convo-detached';
const USER_ID = 'user-1';
const EPOCH = 1000;

const run = (overrides: Partial<DetachedRun> = {}): DetachedRun => ({
  userMessageId: USER_ID,
  generationCreatedAt: EPOCH,
  ...overrides,
});

const response = (overrides: Partial<TMessage> = {}): TMessage =>
  ({
    messageId: 'response-1',
    parentMessageId: USER_ID,
    conversationId: CONVO_ID,
    isCreatedByUser: false,
    text: 'done',
    updatedAt: new Date(EPOCH + 1000).toISOString(),
    ...overrides,
  }) as TMessage;

const userMessage = { messageId: USER_ID, isCreatedByUser: true } as TMessage;

const writtenAt = (epoch: number) => new Date(epoch).toISOString();

describe('resolveDetachedRunEnd', () => {
  it('reports a completed run with its persisted response', () => {
    const end = resolveDetachedRunEnd(CONVO_ID, run(), [userMessage, response()]);
    expect(end).toEqual(
      expect.objectContaining({
        conversationId: CONVO_ID,
        outcome: 'completed',
        responseMessageId: 'response-1',
      }),
    );
  });

  it('reports a failed run as an error, so the queue waits for a manual send', () => {
    const end = resolveDetachedRunEnd(CONVO_ID, run(), [response({ error: true })]);
    expect(end?.outcome).toBe('error');
    expect(end?.responseMessageId).toBeUndefined();
  });

  it('reports an unfinished response as aborted', () => {
    const end = resolveDetachedRunEnd(CONVO_ID, run(), [response({ unfinished: true })]);
    expect(end?.outcome).toBe('aborted');
  });

  it('reports a compaction that ended without a summary as aborted, as a Stop and a failure persist alike', () => {
    const failedSummary = resolveDetachedRunEnd(CONVO_ID, run(), [
      response({
        content: [
          { type: ContentTypes.SUMMARY, content: [], failed: true, initiatedBy: 'user' },
        ] as TMessage['content'],
      }),
    ]);
    expect(failedSummary?.outcome).toBe('aborted');
    const errorPart = resolveDetachedRunEnd(CONVO_ID, run(), [
      response({
        content: [
          { type: ContentTypes.ERROR, error: 'stopped', initiatedBy: 'user' },
        ] as TMessage['content'],
      }),
    ]);
    expect(errorPart?.outcome).toBe('aborted');
  });

  it('reads a run as completed when only an ordinary failed round or a superseded failure is persisted', () => {
    const ordinaryRound = resolveDetachedRunEnd(CONVO_ID, run(), [
      response({
        content: [
          { type: ContentTypes.SUMMARY, content: [], failed: true },
          { type: ContentTypes.TEXT, text: 'answer' },
        ] as TMessage['content'],
      }),
    ]);
    expect(ordinaryRound?.outcome).toBe('completed');
    const laterUsable = resolveDetachedRunEnd(CONVO_ID, run(), [
      response({
        content: [
          { type: ContentTypes.SUMMARY, content: [], failed: true, initiatedBy: 'user' },
          {
            type: ContentTypes.SUMMARY,
            content: [{ type: ContentTypes.TEXT, text: 'summary' }],
            initiatedBy: 'user',
          },
        ] as TMessage['content'],
      }),
    ]);
    expect(laterUsable?.outcome).toBe('completed');
  });

  it('returns nothing while no response to the run is persisted', () => {
    expect(resolveDetachedRunEnd(CONVO_ID, run(), [userMessage])).toBeNull();
    expect(resolveDetachedRunEnd(CONVO_ID, run(), undefined)).toBeNull();
  });

  it('picks the response the run created among regenerated siblings', () => {
    const end = resolveDetachedRunEnd(CONVO_ID, run({ responseMessageId: 'response-2_' }), [
      response({ messageId: 'response-1', error: true }),
      response({ messageId: 'response-2' }),
    ]);
    expect(end).toEqual(
      expect.objectContaining({ outcome: 'completed', responseMessageId: 'response-2' }),
    );
  });

  it('matches a persisted response id that itself ends in an underscore', () => {
    const end = resolveDetachedRunEnd(CONVO_ID, run({ responseMessageId: 'response-2_' }), [
      response({ messageId: 'response-1' }),
      response({ messageId: 'response-2_' }),
    ]);
    expect(end?.responseMessageId).toBe('response-2_');
  });

  it('leaves a run unresolved when the response it named is not loaded', () => {
    expect(
      resolveDetachedRunEnd(CONVO_ID, run({ responseMessageId: 'response-2' }), [
        response({ messageId: 'response-1' }),
      ]),
    ).toBeNull();
  });

  it('does not stand a sibling in for the response a fresh run named', () => {
    const run = {
      userMessageId: USER_ID,
      responseMessageId: 'response-a',
      generationCreatedAt: 5000,
    };
    expect(
      resolveDetachedRunEnd(CONVO_ID, run, [
        response({ messageId: 'response-b', updatedAt: writtenAt(6000) }),
      ]),
    ).toBeNull();
  });

  it('treats the padded user id placeholder as naming no response', () => {
    const end = resolveDetachedRunEnd(CONVO_ID, run({ responseMessageId: `${USER_ID}_` }), [
      response({ messageId: 'server-response' }),
    ]);
    expect(end?.responseMessageId).toBe('server-response');
  });

  it('carries the run epoch so the drain can match server admission receipts', () => {
    const end = resolveDetachedRunEnd(
      CONVO_ID,
      { userMessageId: USER_ID, generationCreatedAt: 4200 },
      [response({ updatedAt: writtenAt(4300) })],
    );
    expect(end?.generationCreatedAt).toBe(4200);
  });

  it('ignores a row the run never wrote, even under the id it named', () => {
    expect(
      resolveDetachedRunEnd(
        CONVO_ID,
        { userMessageId: USER_ID, responseMessageId: 'response-1', generationCreatedAt: 5000 },
        [
          response({ messageId: 'response-1', updatedAt: writtenAt(4999) }),
          response({ messageId: 'other' }),
        ],
      ),
    ).toBeNull();
  });

  it('does not guess between siblings when the run named no response', () => {
    expect(
      resolveDetachedRunEnd(CONVO_ID, run(), [
        response({ messageId: 'response-1' }),
        response({ messageId: 'response-2' }),
      ]),
    ).toBeNull();
  });
});

describe('isStoppedRun', () => {
  it('holds a Stop to the run it was pressed on', () => {
    const stopped = { generationCreatedAt: 1000 };
    expect(isStoppedRun(null, 1000)).toBe(false);
    expect(isStoppedRun(stopped, 1000)).toBe(true);
    expect(isStoppedRun(stopped, 2000)).toBe(false);
  });
});

describe('isDetachedRunManual', () => {
  const CONVO = 'convo-manual';

  it('resolves an ordinary run from history, whatever the server queue holds', () => {
    const store = createStore();
    expect(isDetachedRunManual(store.get, CONVO, run())).toBe(false);
    store.set(settledQueuedTurnReceiptsByConvoId(CONVO), [
      { clientRequestId: 'queued-1', status: 'admitted', effectivePredecessorCreatedAt: EPOCH },
    ]);
    store.set(queuedMessagesByConvoId(CONVO), [
      { id: 'row-1', text: 'next', createdAt: 1, server: { status: 'sending' } },
    ]);
    expect(isDetachedRunManual(store.get, CONVO, run())).toBe(false);
  });

  it('leaves the run the user stopped, and only that run, for a manual send', () => {
    const store = createStore();
    store.set(stopRequestedByConvoId(CONVO), { generationCreatedAt: EPOCH });
    expect(isDetachedRunManual(store.get, CONVO, run())).toBe(true);
    expect(isDetachedRunManual(store.get, CONVO, run({ generationCreatedAt: 2000 }))).toBe(false);
  });
});
