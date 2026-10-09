import {
  handleFilesUsageRequest,
  resolveFilesUsageHold,
  FILES_USAGE_QUEUED_RUN_ALLOWANCE,
  FILES_USAGE_BASE_HOLD_MS,
  FILES_USAGE_MAX_IDS,
} from './usage';

describe('handleFilesUsageRequest', () => {
  const user = { id: 'user-1', tenantId: 'tenant-1' };

  const createDeps = (held = 0) => ({
    extendFilesTTL: jest.fn().mockResolvedValue(held),
  });

  it('rejects unauthenticated requests without touching the DB', async () => {
    const deps = createDeps();
    const result = await handleFilesUsageRequest({}, { file_ids: ['f1'] }, deps);
    expect(result).toEqual({ status: 401, body: { code: 'UNAUTHORIZED' } });
    expect(deps.extendFilesTTL).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', {}],
    ['not an array', { file_ids: 'f1' }],
    ['empty', { file_ids: [] }],
    ['non-string entry', { file_ids: ['f1', 42] }],
    ['empty-string entry', { file_ids: [''] }],
  ])('rejects %s file_ids with 400', async (_label, body) => {
    const deps = createDeps();
    const result = await handleFilesUsageRequest(user, body, deps);
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ code: 'INVALID_FILE_IDS' });
    expect(deps.extendFilesTTL).not.toHaveBeenCalled();
  });

  it('caps the list at FILES_USAGE_MAX_IDS', async () => {
    const deps = createDeps();
    const file_ids = Array.from({ length: FILES_USAGE_MAX_IDS + 1 }, (_, i) => `f${i}`);
    const result = await handleFilesUsageRequest(user, { file_ids }, deps);
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ code: 'TOO_MANY_FILES', max: FILES_USAGE_MAX_IDS });
    expect(deps.extendFilesTTL).not.toHaveBeenCalled();
  });

  it('requests an owner-scoped hold of the resolved window', async () => {
    const deps = createDeps(1);
    const result = await handleFilesUsageRequest(user, { file_ids: ['f1', 'f2'] }, deps);
    expect(deps.extendFilesTTL).toHaveBeenCalledTimes(1);
    expect(deps.extendFilesTTL).toHaveBeenCalledWith(
      ['f1', 'f2'],
      { renewMs: FILES_USAGE_BASE_HOLD_MS, maxLifetimeMs: FILES_USAGE_BASE_HOLD_MS },
      { user: 'user-1', tenantId: 'tenant-1' },
    );
    expect(result).toEqual({ status: 200, body: { held: 1 } });
  });

  /** The ceiling must be a constant the data layer clamps against the upload
   *  time, not a deadline derived here: a request-clock deadline with no
   *  ceiling would let a caller walk the file's lifetime forward per call. */
  it('passes a constant ceiling, never a request-derived deadline', async () => {
    const deps = createDeps(1);
    await handleFilesUsageRequest(user, { file_ids: ['f1'] }, deps);
    await handleFilesUsageRequest(user, { file_ids: ['f1'] }, deps);

    const [, firstHold] = deps.extendFilesTTL.mock.calls[0];
    const [, secondHold] = deps.extendFilesTTL.mock.calls[1];
    expect(secondHold).toEqual(firstHold);
    expect(typeof firstHold.maxLifetimeMs).toBe('number');
  });

  /** A paused run's approval window has no configured upper bound, so a fixed
   *  window shorter than it would reap an attachment whose approval is still
   *  live and leave the drain sending a missing file. */
  it('stretches the hold to outlast a long configured approval window', async () => {
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const deps = { ...createDeps(1), approvalTtlMs: sevenDaysMs };
    await handleFilesUsageRequest(user, { file_ids: ['f1'] }, deps);

    const [, hold] = deps.extendFilesTTL.mock.calls[0];
    expect(hold.renewMs).toBe(FILES_USAGE_BASE_HOLD_MS + sevenDaysMs);
    expect(hold.renewMs).toBeGreaterThan(sevenDaysMs);
  });

  describe('resolveFilesUsageHold', () => {
    it('covers one approval window per renewal', () => {
      expect(resolveFilesUsageHold(1000).renewMs).toBe(FILES_USAGE_BASE_HOLD_MS + 1000);
    });

    /** The drain sends one queued item per run completion, so a deep queue
     *  waits behind several approval windows; the ceiling has to span them. */
    it('scales the ceiling to the queued run chain', () => {
      const hold = resolveFilesUsageHold(1000);
      expect(hold.maxLifetimeMs).toBe(
        FILES_USAGE_BASE_HOLD_MS + 1000 * FILES_USAGE_QUEUED_RUN_ALLOWANCE,
      );
      expect(hold.maxLifetimeMs).toBeGreaterThan(hold.renewMs);
    });

    it.each([
      ['undefined', undefined],
      ['zero', 0],
      ['negative', -1],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
    ])('falls back to the baseline for %s', (_label, value) => {
      expect(resolveFilesUsageHold(value)).toEqual({
        renewMs: FILES_USAGE_BASE_HOLD_MS,
        maxLifetimeMs: FILES_USAGE_BASE_HOLD_MS,
      });
    });
  });

  it('returns 200 with zero held when no id resolves to an owned file', async () => {
    const deps = createDeps(0);
    const result = await handleFilesUsageRequest(user, { file_ids: ['not-owned'] }, deps);
    expect(result).toEqual({ status: 200, body: { held: 0 } });
  });
});
