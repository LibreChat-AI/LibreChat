import type { SteerAttempt } from '../attempt';
import { routeSteerFailure, steerAttemptChip } from '../attempt';
import { createSteerDispatch } from '../dispatch';

const attempt: SteerAttempt = {
  localId: 'local-1',
  text: 'steer',
  createdAt: 10,
  files: [{ file_id: 'f1', type: 'text/plain' }],
  generationCreatedAt: 5,
  generationProtocolVersion: 2,
  carried: { quotes: ['q'] },
};

const failure = (status: number, data?: Record<string, unknown>) => ({
  response: { status, data },
});

describe('steerAttemptChip', () => {
  it('stamps the attempt onto the chip state the caller names', () => {
    expect(steerAttemptChip(attempt, { steerId: 'local-1', status: 'sending' })).toEqual({
      steerId: 'local-1',
      status: 'sending',
      text: 'steer',
      createdAt: 10,
      files: [{ file_id: 'f1', type: 'text/plain' }],
      generationCreatedAt: 5,
      generationProtocolVersion: 2,
      quotes: ['q'],
    });
  });

  it('omits absent files, epoch and origin', () => {
    const chip = steerAttemptChip(
      { ...attempt, files: undefined, generationCreatedAt: undefined, carried: {} },
      { steerId: 's', status: 'failed', deliveryUncertain: true },
    );
    expect(chip).toEqual({
      steerId: 's',
      status: 'failed',
      deliveryUncertain: true,
      text: 'steer',
      createdAt: 10,
      generationProtocolVersion: 2,
    });
  });
});

describe('routeSteerFailure', () => {
  it('routes run-state refusals to a send or the queue', () => {
    expect(routeSteerFailure(failure(409, { code: 'NO_ACTIVE_RUN' }), 2)).toBe('send-after-run');
    for (const code of ['RUN_PAUSED', 'STEER_UNSUPPORTED', 'STEER_QUEUE_FULL']) {
      expect(routeSteerFailure(failure(409, { code }), 1)).toBe('send-when-idle');
    }
  });

  it('requeues a replaced run only when both sides speak protocol v2', () => {
    const replaced = failure(409, { code: 'RUN_REPLACED', generationProtocolVersion: 2 });
    expect(routeSteerFailure(replaced, 2)).toBe('requeue');
    expect(routeSteerFailure(replaced, 1)).toBe('failed');
    expect(routeSteerFailure(failure(409, { code: 'RUN_REPLACED' }), 2)).toBe('failed');
  });

  it('keeps transport and intermediary failures uncertain', () => {
    expect(routeSteerFailure(failure(400), 2)).toBe('failed');
    expect(routeSteerFailure(failure(408), 2)).toBe('uncertain');
    expect(routeSteerFailure(failure(502), 2)).toBe('uncertain');
    expect(routeSteerFailure(new Error('network'), 2)).toBe('uncertain');
  });
});

describe('createSteerDispatch', () => {
  it('runs one task per key at a time, in order', () => {
    const dispatch = createSteerDispatch();
    const log: string[] = [];
    const settles: Array<() => void> = [];
    dispatch('a', (settle) => {
      log.push('a1');
      settles.push(settle);
    });
    dispatch('a', (settle) => {
      log.push('a2');
      settles.push(settle);
    });
    dispatch('b', () => log.push('b1'));
    expect(log).toEqual(['a1', 'b1']);
    settles[0]();
    settles[0]();
    expect(log).toEqual(['a1', 'b1', 'a2']);
  });

  it('releases the key when a task throws', () => {
    const dispatch = createSteerDispatch();
    expect(() =>
      dispatch('a', () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    const ran = jest.fn();
    dispatch('a', ran);
    expect(ran).toHaveBeenCalledTimes(1);
  });
});
