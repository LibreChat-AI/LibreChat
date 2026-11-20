import { createStore } from 'jotai';
import type { TTokenUsageEvent } from 'librechat-data-provider';
import type { UsageSubmissionLike } from '../events';
import { pendingUsageFamily, liveTokensFamily, activeUsageResponseIdFamily } from '../../../usage';
import { createUsageCounters, createUsageHandlers } from '../handlers';

const submission: UsageSubmissionLike = {
  userMessage: { messageId: 'u1', conversationId: 'c1' },
  initialResponse: { messageId: 'r1', parentMessageId: 'u1' },
  conversation: { conversationId: 'c1' },
};

const usage = (fields: Partial<TTokenUsageEvent>): TTokenUsageEvent =>
  ({ runId: 'run', seq: 0, input_tokens: 10, output_tokens: 5, ...fields }) as TTokenUsageEvent;

describe('createUsageHandlers', () => {
  it('binds the response and folds a usage event exactly once', () => {
    const store = createStore();
    const handlers = createUsageHandlers(store, createUsageCounters());
    handlers.usageHandler(usage({}), submission);
    handlers.usageHandler(usage({}), submission);
    expect(store.get(activeUsageResponseIdFamily('c1'))).toBe('r1');
    expect(store.get(pendingUsageFamily('c1')).eventCount).toBe(1);
  });

  /** The reply is drawn under a placeholder id and the first run step renames its row. Every
   * later frame is handled with the submission, which still names the placeholder, so without
   * the name the response in progress snapped back to an id no row has. */
  it('follows the reply to the id the stream names for it, through the frames after', () => {
    const store = createStore();
    const handlers = createUsageHandlers(store, createUsageCounters());
    handlers.bindResponse(submission);
    expect(store.get(activeUsageResponseIdFamily('c1'))).toBe('r1');

    handlers.nameResponse('stored-reply', submission);
    expect(store.get(activeUsageResponseIdFamily('c1'))).toBe('stored-reply');

    handlers.tapStream({ delta: { content: [{ type: 'text', text: 'more words' }] } }, submission);
    handlers.usageHandler(usage({}), submission);
    expect(store.get(activeUsageResponseIdFamily('c1'))).toBe('stored-reply');
    expect(handlers.bindResponse(submission)).toBe('stored-reply');
  });

  it('names nothing for another turn, whose reply has a placeholder of its own', () => {
    const store = createStore();
    const handlers = createUsageHandlers(store, createUsageCounters());
    handlers.nameResponse('stored-reply', submission);
    const next: UsageSubmissionLike = {
      ...submission,
      userMessage: { messageId: 'u2', conversationId: 'c1' },
      initialResponse: { messageId: 'r2', parentMessageId: 'u2' },
    };

    expect(handlers.bindResponse(next)).toBe('r2');
    /** A name equal to the placeholder, or none at all, is no rename. */
    handlers.nameResponse('r2', next);
    handlers.nameResponse('', next);
    expect(store.get(activeUsageResponseIdFamily('c1'))).toBe('r2');
  });

  it('resetLive clears pending usage and the live estimate', () => {
    const store = createStore();
    const handlers = createUsageHandlers(store, createUsageCounters());
    handlers.usageHandler(usage({}), submission);
    handlers.resetLive(submission);
    expect(store.get(pendingUsageFamily('c1')).eventCount).toBe(0);
    expect(store.get(liveTokensFamily('c1'))).toBe(0);
  });

  it('keeps separate counters per handler set', () => {
    const store = createStore();
    const counters = createUsageCounters();
    const handlers = createUsageHandlers(store, counters);
    handlers.seedLive(400, submission);
    expect(counters.streamChars).toBe(400);
    expect(store.get(liveTokensFamily('c1'))).toBeGreaterThan(0);
    expect(createUsageCounters().streamChars).toBe(0);
  });
});
