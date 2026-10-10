import { freeSpan } from '../engine/span';

describe('freeSpan', () => {
  it('returns the whole range when nothing blocks it', () => {
    expect(freeSpan(0, 100, [], 50)).toEqual([0, 100]);
  });

  it('keeps the free stretch Lia is standing in', () => {
    expect(freeSpan(0, 100, [[40, 60]], 80)).toEqual([60, 100]);
    expect(freeSpan(0, 100, [[40, 60]], 10)).toEqual([0, 40]);
  });

  it('falls back to the widest stretch when Lia stands on a blocked part', () => {
    expect(freeSpan(0, 100, [[20, 40]], 30)).toEqual([40, 100]);
  });

  it('drops stretches narrower than the minimum and reports when none is left', () => {
    expect(freeSpan(0, 100, [[10, 95]], 0, 20)).toBeNull();
    expect(freeSpan(0, 100, [[10, 70]], 0, 20)).toEqual([70, 100]);
  });

  it('handles several overlapping obstacles', () => {
    expect(
      freeSpan(
        0,
        100,
        [
          [10, 30],
          [25, 50],
          [80, 120],
        ],
        60,
      ),
    ).toEqual([50, 80]);
  });

  it('ignores empty obstacles and reads reversed ones the right way round', () => {
    expect(freeSpan(0, 100, [[50, 50]], 20, 60)).toEqual([0, 100]);
    expect(freeSpan(0, 100, [[60, 40]], 80)).toEqual([60, 100]);
  });
});
