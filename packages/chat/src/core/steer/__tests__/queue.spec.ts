import type { QueuedMessage, RunEnd } from '../types';
import { isSameRunEpoch, insertQueuedMessage, mergeQueuedMessages } from '../queue';

const item = (id: string, createdAt: number, priority?: boolean): QueuedMessage => ({
  id,
  text: id,
  createdAt,
  ...(priority === true && { priority }),
});

const ids = (queue: QueuedMessage[]) => queue.map((queued) => queued.id);

describe('insertQueuedMessage', () => {
  it('places by priority then age without reordering existing rows', () => {
    const queue = [item('b', 2), item('a', 1)];
    expect(ids(insertQueuedMessage(queue, item('c', 3)))).toEqual(['b', 'a', 'c']);
    expect(ids(insertQueuedMessage(queue, item('p', 9, true)))).toEqual(['p', 'b', 'a']);
  });
});

describe('mergeQueuedMessages', () => {
  it('interleaves two ordered queues while keeping each one in its own order', () => {
    const merged = mergeQueuedMessages([item('a', 1), item('c', 3)], [item('b', 2), item('d', 4)]);
    expect(ids(merged)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('isSameRunEpoch', () => {
  const end = (extra: Partial<RunEnd>): RunEnd => ({
    conversationId: 'c',
    outcome: 'completed',
    endedAt: 1,
    ...extra,
  });

  it('matches by generation epoch when either signal carries one', () => {
    expect(isSameRunEpoch(end({ generationCreatedAt: 5 }), end({ generationCreatedAt: 5 }))).toBe(
      true,
    );
    expect(isSameRunEpoch(end({ generationCreatedAt: 5 }), end({}))).toBe(false);
  });

  it('falls back to the end time and never matches another conversation', () => {
    expect(isSameRunEpoch(end({}), end({}))).toBe(true);
    expect(isSameRunEpoch(end({}), end({ endedAt: 2 }))).toBe(false);
    expect(isSameRunEpoch(end({ conversationId: 'd' }), end({}))).toBe(false);
    expect(isSameRunEpoch(null, end({}))).toBe(false);
  });
});
