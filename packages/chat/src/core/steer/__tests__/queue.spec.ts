import type { QueuedMessage, RunEnd } from '../types';
import {
  isSameRunEpoch,
  insertQueuedMessage,
  mergeQueuedMessages,
  resolveLostRunOutcome,
} from '../queue';

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

describe('resolveLostRunOutcome', () => {
  it.each([
    ['completed, with its rows read', { status: 'complete', createdAt: 2000 }, true, 'completed'],
    ['completed, by a status that names no generation', { status: 'complete' }, true, 'completed'],
    [
      'completed, but its rows could not be read',
      { status: 'complete', createdAt: 2000 },
      false,
      'error',
    ],
    ['stopped', { status: 'aborted', createdAt: 2000 }, true, 'aborted'],
    ['failed', { status: 'error', createdAt: 2000 }, true, 'error'],
    ['gone from the server’s records', {}, true, 'error'],
    ['another generation’s status', { status: 'complete', createdAt: 9000 }, true, 'error'],
  ] as const)('%s', (_case, status, read, outcome) => {
    expect(resolveLostRunOutcome(status, 2000, read)).toBe(outcome);
  });
});
