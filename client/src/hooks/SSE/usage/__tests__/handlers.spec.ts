import { createStore } from 'jotai';
import type { TTokenUsageEvent } from 'librechat-data-provider';
import type { UsageSubmissionLike } from '../events';
import {
  pendingUsageFamily,
  liveTokensFamily,
  activeUsageResponseIdFamily,
} from '~/components/Chat/Input/TokenUsage/store';
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
