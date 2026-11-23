import type { PendingSteer } from '../types';
import { acknowledgeSteerChips, isSteerRunReplaced } from '../ack';

const chip = (steerId: string, extra: Partial<PendingSteer> = {}): PendingSteer => ({
  steerId,
  text: steerId,
  status: 'pending',
  createdAt: 1,
  ...extra,
});

describe('isSteerRunReplaced', () => {
  it('is false for a steer without a source epoch', () => {
    expect(isSteerRunReplaced(chip('a'), null)).toBe(false);
    expect(isSteerRunReplaced(chip('a'), 5)).toBe(false);
  });

  it('is true once the source epoch is cleared or differs from the active one', () => {
    expect(isSteerRunReplaced(chip('a', { generationCreatedAt: 5 }), null)).toBe(true);
    expect(isSteerRunReplaced(chip('a', { generationCreatedAt: 5 }), 6)).toBe(true);
    expect(isSteerRunReplaced(chip('a', { generationCreatedAt: 5 }), 5)).toBe(false);
  });
});

describe('acknowledgeSteerChips', () => {
  it('swaps the local chip for the acknowledged one', () => {
    const next = acknowledgeSteerChips(
      [chip('other'), chip('local', { status: 'sending' })],
      'local',
      chip('server'),
      false,
    );
    expect(next.map((item) => item.steerId)).toEqual(['other', 'server']);
  });

  it('drops the local chip without minting one when told to', () => {
    const next = acknowledgeSteerChips([chip('local')], 'local', chip('server'), true);
    expect(next).toEqual([]);
  });

  it('does not duplicate a chip a reconnect already seeded under the server id', () => {
    const seeded = chip('server', { text: 'seeded' });
    const next = acknowledgeSteerChips([chip('local'), seeded], 'local', chip('server'), false);
    expect(next).toEqual([seeded]);
  });

  it('keeps a newer local preempt label over the one the ACK echoes', () => {
    const local = chip('local', { preempt: true, preemptRevision: 2 });
    const [acked] = acknowledgeSteerChips(
      [local],
      'local',
      chip('server', { preempt: false, preemptRevision: 1 }),
      false,
    );
    expect(acked).toMatchObject({ steerId: 'server', preempt: true, preemptRevision: 2 });
  });

  it('drops a stale preempt label when the newer local revision disarmed it', () => {
    const local = chip('local', { preemptRevision: 3 });
    const [acked] = acknowledgeSteerChips(
      [local],
      'local',
      chip('server', { preempt: true, preemptRevision: 1 }),
      false,
    );
    expect(acked.preempt).toBeUndefined();
    expect(acked.preemptRevision).toBe(3);
  });
});
