import { getClientTimeouts } from './client';

describe('getClientTimeouts', () => {
  it('returns undefined when unset or empty', () => {
    expect(getClientTimeouts(undefined)).toBeUndefined();
    expect(getClientTimeouts({})).toBeUndefined();
  });

  it('publishes configured values', () => {
    expect(getClientTimeouts({ refreshMs: 90000, ttsMs: 120000 })).toEqual({
      refreshMs: 90000,
      ttsMs: 120000,
    });
  });

  it('drops invalid configuration so client defaults apply', () => {
    expect(getClientTimeouts({ refreshMs: -1 })).toBeUndefined();
    expect(getClientTimeouts({ unknown: 5 })).toBeUndefined();
  });
});
