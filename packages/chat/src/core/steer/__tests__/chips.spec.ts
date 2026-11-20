import type { TPendingSteer } from 'librechat-data-provider';
import type { PendingSteer, QueuedMessage } from '../types';
import {
  seedPendingSteers,
  settledSteerQuotes,
  removePendingSteers,
  acceptedClientSteerIds,
  heldSteerClientIds,
  withoutPromotedSteers,
  withoutRecoveredSteers,
  updatePendingSteerLabels,
} from '../chips';

const chip = (steerId: string, extra: Partial<PendingSteer> = {}): PendingSteer => ({
  steerId,
  text: steerId,
  status: 'pending',
  createdAt: 1,
  ...extra,
});

const server = (steerId: string, extra: Partial<TPendingSteer> = {}): TPendingSteer =>
  ({ steerId, text: steerId, createdAt: 2, ...extra }) as TPendingSteer;

describe('acceptedClientSteerIds', () => {
  it('lists the client ids the server echoed', () => {
    expect(acceptedClientSteerIds([server('a', { clientSteerId: 'c' }), server('b')])).toEqual([
      'c',
    ]);
    expect(acceptedClientSteerIds(undefined)).toEqual([]);
  });
});

describe('seedPendingSteers', () => {
  it('replaces pending chips with the server list and keeps unclaimed failed chips', () => {
    const next = seedPendingSteers(
      [chip('stale'), chip('failed', { status: 'failed' })],
      [server('s1')],
      { generationCreatedAt: 9, generationProtocolVersion: 2 },
    );
    expect(next.map((item) => [item.steerId, item.status])).toEqual([
      ['s1', 'pending'],
      ['failed', 'failed'],
    ]);
    expect(next[0]).toMatchObject({ generationCreatedAt: 9, generationProtocolVersion: 2 });
  });

  it('clears every pending chip when the server has none queued', () => {
    expect(seedPendingSteers([chip('a')], undefined, { generationProtocolVersion: 1 })).toEqual([]);
  });

  it('keeps the local chip context and a newer local preempt label', () => {
    const local = chip('local', {
      quotes: ['q'],
      manualSkills: ['s'],
      preempt: true,
      preemptRevision: 3,
      generationCreatedAt: 4,
    });
    const [seeded] = seedPendingSteers(
      [local],
      [server('srv', { clientSteerId: 'local', preemptRevision: 1 })],
      { generationProtocolVersion: 2 },
    );
    expect(seeded).toMatchObject({
      steerId: 'srv',
      clientSteerId: 'local',
      quotes: ['q'],
      manualSkills: ['s'],
      preempt: true,
      preemptRevision: 3,
      generationCreatedAt: 4,
    });
  });
});

describe('updatePendingSteerLabels', () => {
  it('returns the same list when nothing changed', () => {
    const prev = [chip('a', { preemptRevision: 1 })];
    expect(
      updatePendingSteerLabels(prev, [
        { steerId: 'a', preempt: false, preemptRevision: 1 } as never,
      ]),
    ).toBe(prev);
  });

  it('correlates a local chip to its server id and applies a newer preempt label', () => {
    const [next] = updatePendingSteerLabels(
      [chip('local', { status: 'sending' })],
      [{ steerId: 'srv', clientSteerId: 'local', preempt: true, preemptRevision: 2 } as never],
    );
    expect(next).toMatchObject({
      steerId: 'srv',
      clientSteerId: 'local',
      status: 'pending',
      preempt: true,
      preemptRevision: 2,
    });
  });

  it('ignores an older revision and drops a disarmed label', () => {
    const prev = [chip('a', { preempt: true, preemptRevision: 5 })];
    expect(
      updatePendingSteerLabels(prev, [
        { steerId: 'a', preempt: false, preemptRevision: 4 } as never,
      ]),
    ).toBe(prev);
    const [disarmed] = updatePendingSteerLabels(prev, [
      { steerId: 'a', preempt: false, preemptRevision: 6 } as never,
    ]);
    expect(disarmed.preempt).toBeUndefined();
    expect(disarmed.preemptRevision).toBe(6);
  });
});

describe('removePendingSteers', () => {
  it('removes the named chips and keeps the list identity when none match', () => {
    const prev = [chip('a'), chip('b')];
    expect(removePendingSteers(prev, ['a']).map((item) => item.steerId)).toEqual(['b']);
    expect(removePendingSteers(prev, ['z'])).toBe(prev);
  });
});

describe('settledSteerQuotes', () => {
  it('returns the quotes of the settled chip that holds some', () => {
    const chips = [chip('a'), chip('b', { quotes: ['q'] })];
    expect(settledSteerQuotes(chips, ['b'])).toEqual(['q']);
    expect(settledSteerQuotes(chips, ['a'])).toBeUndefined();
  });
});

describe('withoutRecoveredSteers', () => {
  it('evicts recovery rows of an applied steer by either id', () => {
    const rows: QueuedMessage[] = [
      { id: '1', text: 'x', createdAt: 1, recoverySteerId: 'srv' },
      { id: '2', text: 'y', createdAt: 2, recoveryClientSteerId: 'local' },
      { id: '3', text: 'z', createdAt: 3 },
    ];
    expect(withoutRecoveredSteers(rows, ['srv', 'local']).map((item) => item.id)).toEqual(['3']);
    expect(withoutRecoveredSteers(rows, ['none'])).toBe(rows);
  });
});

describe('withoutPromotedSteers', () => {
  it('evicts every local copy of a promoted steer and keeps server rows', () => {
    const rows: QueuedMessage[] = [
      { id: 'bound', text: 'x', createdAt: 1, recoverySteerId: 'srv' },
      { id: 'local', text: 'x', createdAt: 2 },
      { id: 'srv', text: 'x', createdAt: 3, server: { status: 'queued', id: 'turn-1' } },
      { id: 'other', text: 'z', createdAt: 4 },
    ];
    expect(withoutPromotedSteers(rows, ['srv', 'local']).map((item) => item.id)).toEqual([
      'srv',
      'other',
    ]);
    expect(withoutPromotedSteers(rows, ['none'])).toBe(rows);
  });
});

describe('heldSteerClientIds', () => {
  it('names recovery rows and failed chips, never a chip its run still owns', () => {
    const rows: QueuedMessage[] = [
      { id: 'bound', text: 'x', createdAt: 1, recoverySteerId: 'srv', recoveryClientSteerId: 'l1' },
      { id: 'plain', text: 'y', createdAt: 2 },
      {
        id: 'server',
        text: 'z',
        createdAt: 3,
        recoveryClientSteerId: 'l2',
        server: { status: 'queued', id: 'turn-1' },
      },
    ];
    const chips = [
      chip('l3', { status: 'failed' }),
      chip('srv-4', { status: 'failed', clientSteerId: 'l4' }),
      chip('l5', { status: 'sending' }),
      chip('srv-6', { status: 'pending', clientSteerId: 'l6' }),
    ];
    expect(heldSteerClientIds(chips, rows)).toEqual(['l1', 'l3', 'l4']);
  });
});
