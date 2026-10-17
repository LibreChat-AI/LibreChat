import { cascadeStep, runCascade } from './cascade';

describe('runCascade', () => {
  it('reports failed steps and restores only the steps that were removed', async () => {
    const restoreA = jest.fn().mockResolvedValue(undefined);
    const restoreB = jest.fn().mockResolvedValue(undefined);
    const outcome = await runCascade(
      [
        cascadeStep('a', async () => ['x'], restoreA),
        cascadeStep('b', async () => Promise.reject(new Error('boom')), restoreB),
      ],
      '[test]',
    );

    expect(outcome.failed).toEqual(['b']);
    await outcome.compensate();
    expect(restoreA).toHaveBeenCalledWith(['x']);
    expect(restoreB).not.toHaveBeenCalled();
  });

  it('keeps restoring when one restore throws', async () => {
    const restoreB = jest.fn().mockResolvedValue(undefined);
    const outcome = await runCascade(
      [
        cascadeStep(
          'a',
          async () => 1,
          async () => Promise.reject(new Error('restore failed')),
        ),
        cascadeStep('b', async () => 2, restoreB),
      ],
      '[test]',
    );

    await expect(outcome.compensate()).resolves.toBeUndefined();
    expect(restoreB).toHaveBeenCalledWith(2);
  });

  it('restores a snapshot immediately when a removal rejects after committing', async () => {
    const restore = jest.fn().mockResolvedValue(undefined);
    const outcome = await runCascade(
      [
        cascadeStep(
          'a',
          async () => Promise.reject(new Error('response lost')),
          restore,
          async () => ['before'],
        ),
      ],
      '[test]',
    );

    expect(outcome.failed).toEqual(['a']);
    expect(restore).toHaveBeenCalledWith(['before']);
  });

  it('retries a snapshot restore that failed transiently when compensating', async () => {
    const restore = jest
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(undefined);
    const outcome = await runCascade(
      [
        cascadeStep(
          'a',
          async () => Promise.reject(new Error('response lost')),
          restore,
          async () => 'snap',
        ),
      ],
      '[test]',
    );

    expect(restore).toHaveBeenCalledTimes(1);
    await outcome.compensate();
    expect(restore).toHaveBeenCalledTimes(2);
    expect(restore).toHaveBeenLastCalledWith('snap');
  });

  it('compensates from what the removal returned, falling back to the snapshot', async () => {
    const restoreReturned = jest.fn().mockResolvedValue(undefined);
    const restoreVoid = jest.fn().mockResolvedValue(undefined);
    const outcome = await runCascade(
      [
        cascadeStep(
          'a',
          async () => 'removed',
          restoreReturned,
          async () => 'snapshot',
        ),
        cascadeStep(
          'b',
          async (): Promise<void> => undefined,
          restoreVoid,
          async () => 'snapshot',
        ),
      ],
      '[test]',
    );

    await outcome.compensate();
    expect(restoreReturned).toHaveBeenCalledWith('removed');
    expect(restoreVoid).toHaveBeenCalledWith('snapshot');
  });
});
