import { pendingToBranchUsage } from '../view';

describe('pendingToBranchUsage', () => {
  it('normalizes counts and marks cost known only when every event carried one', () => {
    const usage = pendingToBranchUsage({
      input: 10,
      output: -3,
      cacheWrite: 1,
      cacheRead: 2,
      eventCount: 2,
      costUSD: 0.5,
      costKnown: true,
    });
    expect(usage).toMatchObject({ input: 10, output: 0, cacheWrite: 1, cacheRead: 2, cost: 0.5 });
    expect(usage.costKnown).toBe(true);
  });

  it('reports zero cost for a non-positive or non-finite figure', () => {
    const base = {
      input: 0,
      output: 0,
      cacheWrite: 0,
      cacheRead: 0,
      eventCount: 1,
      costKnown: false,
    };
    expect(pendingToBranchUsage({ ...base, costUSD: Number.NaN }).cost).toBe(0);
    expect(pendingToBranchUsage({ ...base, costUSD: 0 }).costKnown).toBe(false);
  });
});
