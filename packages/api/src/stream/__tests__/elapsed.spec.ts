import { getGenerationElapsedMs } from '../elapsed';

describe('getGenerationElapsedMs', () => {
  it('reports the age of the job on this clock', () => {
    const elapsed = getGenerationElapsedMs({ createdAt: Date.now() - 5_000 });
    expect(elapsed).toBeGreaterThanOrEqual(5_000);
    expect(elapsed).toBeLessThan(6_000);
  });

  it('clamps a creator clock ahead of this replica to zero', () => {
    expect(getGenerationElapsedMs({ createdAt: Date.now() + 60_000 })).toBe(0);
  });
});
