import { Constants } from 'librechat-data-provider';
import type { QueuedMessage, RunEnd, SettledQueuedTurnReceipt } from '../types';
import {
  parkRunEnd,
  batchFileIds,
  pickDrainable,
  isBoundaryAdmitted,
  matchesInterruptArm,
  collectQueuedFileIds,
  selectQueuedTurnReveal,
  consumeAdmittedBoundary,
} from '../drain';

const row = (id: string, extra: Partial<QueuedMessage> = {}): QueuedMessage => ({
  id,
  text: id,
  createdAt: 1,
  ...extra,
});

const end = (extra: Partial<RunEnd> = {}): RunEnd => ({
  conversationId: 'c',
  outcome: 'completed',
  endedAt: 1,
  generationCreatedAt: 5,
  ...extra,
});

describe('queued file renewal', () => {
  it('collects only local rows and batches by the server cap', () => {
    const ids = collectQueuedFileIds([
      row('a', { files: [{ file_id: 'f1' }, { file_id: '' }] as never }),
      row('b', { server: { status: 'queued' }, files: [{ file_id: 'f2' }] as never }),
    ]);
    expect(ids).toEqual(['f1']);
    const many = Array.from({ length: 23 }, (_, i) => `f${i}`);
    expect(batchFileIds(many).map((batch) => batch.length)).toEqual([10, 10, 3]);
  });
});

describe('matchesInterruptArm', () => {
  it('matches only the armed generation of the same conversation', () => {
    const armed = { conversationId: 'c', generationCreatedAt: 5 };
    expect(matchesInterruptArm(armed, end())).toBe(true);
    expect(matchesInterruptArm(armed, end({ generationCreatedAt: 6 }))).toBe(false);
    expect(matchesInterruptArm(false, end())).toBe(false);
    expect(matchesInterruptArm(armed, end({ generationCreatedAt: undefined }))).toBe(false);
  });

  it('lets a NEW_CONVO arm follow the conversation its first run resolved to', () => {
    const armed = { conversationId: String(Constants.NEW_CONVO), generationCreatedAt: 5 };
    expect(matchesInterruptArm(armed, end({ startedAsNewConvo: true }))).toBe(true);
    expect(matchesInterruptArm(armed, end())).toBe(false);
  });
});

describe('parkRunEnd', () => {
  it('carries interrupt intent with the parked signal', () => {
    expect(parkRunEnd(end(), true).interruptArmed).toBe(true);
    expect(parkRunEnd(end({ interruptArmed: true }), false).interruptArmed).toBe(true);
    expect(parkRunEnd(end(), false)).not.toHaveProperty('interruptArmed');
  });
});

describe('admitted boundaries', () => {
  const admitted = (clientRequestId: string, at: number): SettledQueuedTurnReceipt => ({
    clientRequestId,
    status: 'admitted',
    effectivePredecessorCreatedAt: at,
  });

  it('detects an admission that consumed this run end', () => {
    expect(isBoundaryAdmitted([admitted('a', 5)], 5)).toBe(true);
    expect(isBoundaryAdmitted([admitted('a', 4)], 5)).toBe(false);
    expect(isBoundaryAdmitted([admitted('a', 5)], undefined)).toBe(false);
    expect(isBoundaryAdmitted([{ ...admitted('a', 5), boundaryConsumed: true }], 5)).toBe(false);
  });

  it('consumes only the first matching admission, keeping it flagged while its enqueue is pending', () => {
    const receipts = [admitted('a', 5), admitted('b', 5)];
    expect(consumeAdmittedBoundary(receipts, 5, [])).toEqual([admitted('b', 5)]);
    expect(consumeAdmittedBoundary(receipts, 5, ['a'])).toEqual([
      { ...admitted('a', 5), boundaryConsumed: true },
      admitted('b', 5),
    ]);
  });
});

describe('selectQueuedTurnReveal', () => {
  const server = row('s', { clientRequestId: 'r', server: { id: 'q', status: 'queued' } });

  it('reveals the first admissible server row after a clean completion', () => {
    const queue = [row('local'), server];
    expect(selectQueuedTurnReveal(end({ responseMessageId: 'm' }), queue)).toBe(server);
  });

  it('reveals nothing after a stop or without a response id', () => {
    expect(
      selectQueuedTurnReveal(end({ outcome: 'aborted', responseMessageId: 'm' }), [server]),
    ).toBe(null);
    expect(selectQueuedTurnReveal(end(), [server])).toBe(null);
  });
});

describe('pickDrainable', () => {
  it('skips held rows and records where the sent row sat', () => {
    const queue = [row('held'), row('next'), row('later')];
    const pick = pickDrainable(queue, (item) => item.id === 'held');
    expect(pick.next?.id).toBe('next');
    expect(pick.remainder.map((item) => item.id)).toEqual(['held', 'later']);
    expect(pick.origin).toMatchObject({ beforeIds: ['held'], afterIds: ['later'] });
  });

  it('returns the queue untouched when every row is held', () => {
    const queue = [row('a')];
    expect(pickDrainable(queue, () => true)).toEqual({ next: null, remainder: queue });
  });
});
