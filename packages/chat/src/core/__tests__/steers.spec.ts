import type { TMessage, TSubmission, TPendingSteer } from 'librechat-data-provider';
import type { FinalSteers } from '../resumable/steers';
import {
  settleStoredSteers,
  restoreRefusedStart,
  settleFinishedSteers,
  restoreReleasedSource,
} from '../resumable/steers';

/** The steer bookkeeping, recording what it is called with and in what order. */
const record = () => {
  const calls: Array<[string, ...unknown[]]> = [];
  const log =
    (name: string, result?: unknown) =>
    (...args: unknown[]): unknown => {
      calls.push([name, ...args]);
      return result;
    };
  const steers = {
    appliedIds: log('appliedIds', ['steer-taken']),
    settleApplied: log('settle'),
    adoptPromoted: log('adopt', ['steer-promoted']),
    convertToQueued: log('toQueued'),
    convertLocalToQueued: log('sweep'),
    blockRecovery: log('block'),
    restoreQueued: log('restore'),
    seed: log('seed'),
  };
  return {
    calls,
    steers: steers as unknown as FinalSteers &
      Parameters<typeof restoreRefusedStart>[0] &
      Parameters<typeof settleFinishedSteers>[0],
  };
};

const stored = [{ messageId: 'reply-1', conversationId: 'thread-1' }] as TMessage[];
const parked: TPendingSteer[] = [
  { steerId: 'steer-parked', clientSteerId: 'local-parked', text: 'Parked by the server' },
] as TPendingSteer[];

describe('settleStoredSteers', () => {
  it('settles what the rows and the status hold, restores what the server parked, then sweeps the rest', () => {
    const { calls, steers } = record();
    const streamed = [{ type: 'text', text: 'So far' }];

    settleStoredSteers(steers, 'thread-1', {
      messages: stored,
      status: { aggregatedContent: streamed, unrecoveredSteers: parked },
      promoted: [{ steerId: 'steer-promoted' }] as never,
      recoverySteerId: 'steer-recovered',
      generationProtocolVersion: 2,
    });

    expect(calls).toEqual([
      ['appliedIds', [...stored, ...streamed]],
      ['settle', 'thread-1', [...stored, ...streamed]],
      ['adopt', 'thread-1', [{ steerId: 'steer-promoted' }]],
      ['toQueued', 'thread-1', parked, { allowPreviouslyConvertedIds: ['steer-recovered'] }],
      [
        'sweep',
        'thread-1',
        {
          excludeSteerIds: new Set([
            'steer-taken',
            'steer-promoted',
            'steer-parked',
            'local-parked',
          ]),
          generationProtocolVersion: 2,
        },
      ],
    ]);
  });

  it('sweeps nothing when the stored rows could not be read: their absence proves nothing', () => {
    const { calls, steers } = record();

    settleStoredSteers(steers, 'thread-1', { messages: undefined });

    expect(calls.map(([name]) => name)).toEqual(['appliedIds', 'settle', 'adopt']);
  });
});

describe('restoreRefusedStart', () => {
  const submission = {
    conversation: { conversationId: 'thread-1' },
    recoverySteerId: 'steer-recovered',
  } as unknown as TSubmission;

  it('puts the queue row back for a refusal, and nothing for a failure that may have started the turn', () => {
    const { calls, steers } = record();

    expect(restoreRefusedStart(steers, submission, { response: { status: 403, data: {} } })).toBe(
      true,
    );
    expect(calls).toEqual([['restore', submission]]);

    calls.length = 0;
    expect(restoreRefusedStart(steers, submission, { response: { status: 502 } })).toBe(false);
    expect(restoreRefusedStart(steers, submission, { code: 'ERR_NETWORK' })).toBe(false);
    expect(restoreRefusedStart(steers, submission, undefined)).toBe(false);
    expect(calls).toEqual([]);
  });

  it.each(['RECOVERY_PAYLOAD_MISMATCH', 'INVALID_RECOVERY_REQUEST'])(
    'bars a recovery the server rejected as such (%s) before the row goes back',
    (code) => {
      const { calls, steers } = record();

      restoreRefusedStart(steers, submission, { response: { status: 409, data: { code } } });

      expect(calls).toEqual([
        ['block', 'thread-1', 'steer-recovered'],
        ['restore', submission],
      ]);
    },
  );
});

describe('restoreReleasedSource', () => {
  const released = { active: false, generationProtocolVersion: 2, unrecoveredSteers: parked };

  it('puts a parked steer back in the queue when the server has let go of it again', () => {
    const { calls, steers } = record();

    expect(restoreReleasedSource(steers, 'thread-1', 'steer-parked', released, 2)).toBe(true);

    expect(calls).toEqual([
      [
        'toQueued',
        'thread-1',
        parked,
        { generationProtocolVersion: 2, allowPreviouslyConvertedIds: ['steer-parked'] },
      ],
    ]);
  });

  it.each([
    ['a generation is still running', { ...released, active: true }],
    ['the status does not speak the protocol', { ...released, generationProtocolVersion: 1 }],
    ['the server parked another steer, not this one', { ...released, unrecoveredSteers: [] }],
  ])('puts nothing back when %s', (_case, status) => {
    const { calls, steers } = record();

    expect(restoreReleasedSource(steers, 'thread-1', 'steer-parked', status, 2)).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('settleFinishedSteers', () => {
  const accepted = [
    ...parked,
    { steerId: 'steer-accepted', text: 'Accepted, not parked yet' },
  ] as TPendingSteer[];

  it('restores what the server parked and what it had only accepted, once each, under the status’s protocol', () => {
    const { calls, steers } = record();

    settleFinishedSteers(
      steers,
      'thread-1',
      {
        generationProtocolVersion: 2,
        unrecoveredSteers: parked,
        resumeState: { pendingSteers: accepted } as never,
      },
      stored,
    );

    expect(calls).toEqual([
      ['toQueued', 'thread-1', accepted, { generationProtocolVersion: 2 }],
      ['settle', 'thread-1', stored],
      ['seed', 'thread-1', []],
    ]);
  });

  it('reads a status that names no protocol as the first one, and converts nothing when nothing is left', () => {
    const legacy = record();
    settleFinishedSteers(legacy.steers, 'thread-1', { unrecoveredSteers: parked }, stored);
    expect(legacy.calls[0]).toEqual([
      'toQueued',
      'thread-1',
      parked,
      { generationProtocolVersion: 1 },
    ]);

    const { calls, steers } = record();
    settleFinishedSteers(steers, 'thread-1', {}, stored);
    expect(calls.map(([name]) => name)).toEqual(['settle', 'seed']);
  });
});
