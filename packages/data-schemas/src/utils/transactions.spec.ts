import { getTransactionSupport } from './transactions';

describe('getTransactionSupport', () => {
  // The cache-hit path does not touch the database, so a stub mongoose is fine.
  const mongoose = {} as unknown as typeof import('mongoose');

  it('returns the cached value on a cache hit (does not re-probe)', async () => {
    await expect(getTransactionSupport(mongoose, true)).resolves.toBe(true);
    await expect(getTransactionSupport(mongoose, false)).resolves.toBe(false);
  });
});
