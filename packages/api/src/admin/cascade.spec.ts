import { PrincipalType } from 'librechat-data-provider';
import type { ConfigRecord } from '@librechat/data-schemas';
import { cascadeStep, runCascade, invalidatingConfigStore } from './cascade';

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

describe('invalidatingConfigStore', () => {
  const profile = { principalId: 'g1' } as ConfigRecord;

  function wrap(store: Parameters<typeof invalidatingConfigStore>[0]) {
    const invalidateConfigCaches = jest.fn().mockResolvedValue(undefined);
    const wrapped = invalidatingConfigStore(store, {
      invalidateConfigCaches,
      tenantId: 'tenant-a',
      logPrefix: '[test]',
    });
    return { wrapped, invalidateConfigCaches };
  }

  it('invalidates after a removal or restore that changed the store, and only then', async () => {
    const { wrapped, invalidateConfigCaches } = wrap({
      deleteConfig: jest.fn().mockResolvedValueOnce(profile).mockResolvedValueOnce(null),
      restoreConfig: jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
    });

    expect(await wrapped.deleteConfig(PrincipalType.GROUP, 'g1')).toBe(profile);
    expect(invalidateConfigCaches).toHaveBeenCalledTimes(1);
    expect(await wrapped.deleteConfig(PrincipalType.GROUP, 'g1')).toBeNull();
    expect(await wrapped.restoreConfig?.(profile)).toBe(true);
    expect(invalidateConfigCaches).toHaveBeenCalledTimes(2);
    expect(await wrapped.restoreConfig?.(profile)).toBe(false);
    expect(invalidateConfigCaches).toHaveBeenCalledTimes(2);
    expect(invalidateConfigCaches).toHaveBeenCalledWith('tenant-a');
  });

  it('invalidates after a call that rejects, which may have committed, and rethrows', async () => {
    const failure = new Error('ack lost');
    const { wrapped, invalidateConfigCaches } = wrap({
      deleteConfig: jest.fn().mockRejectedValue(failure),
      restoreConfig: jest.fn().mockRejectedValue(failure),
    });

    await expect(wrapped.deleteConfig(PrincipalType.ROLE, 'editor')).rejects.toBe(failure);
    await expect(wrapped.restoreConfig?.(profile)).rejects.toBe(failure);
    expect(invalidateConfigCaches).toHaveBeenCalledTimes(2);
  });

  it('resolves with the change when the invalidation fails, since the change committed', async () => {
    const wrapped = invalidatingConfigStore(
      { deleteConfig: jest.fn().mockResolvedValue(profile) },
      {
        invalidateConfigCaches: jest.fn().mockRejectedValue(new Error('redis down')),
        tenantId: undefined,
        logPrefix: '[test]',
      },
    );

    await expect(wrapped.deleteConfig(PrincipalType.USER, 'u1')).resolves.toBe(profile);
    expect(wrapped.restoreConfig).toBeUndefined();
  });
});
