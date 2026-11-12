import { getClientLimits } from './client';

describe('getClientLimits', () => {
  it('returns undefined when unset or empty', () => {
    expect(getClientLimits(undefined)).toBeUndefined();
    expect(getClientLimits({})).toBeUndefined();
  });

  it('publishes configured values', () => {
    expect(getClientLimits({ refreshMs: 90000, ttsMs: 120000 })).toEqual({
      refreshMs: 90000,
      ttsMs: 120000,
    });
  });

  it('drops invalid configuration so client defaults apply', () => {
    expect(getClientLimits({ refreshMs: -1 })).toBeUndefined();
    expect(getClientLimits({ unknown: 5 })).toBeUndefined();
  });
});
