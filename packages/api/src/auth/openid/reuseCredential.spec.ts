import jwt from 'jsonwebtoken';
import { getValidOpenIDReuseCredential } from './reuseCredential';

const secret = 'refresh-secret';

describe('getValidOpenIDReuseCredential', () => {
  it('returns null without a cookie or secret', () => {
    expect(getValidOpenIDReuseCredential({}, secret)).toBeNull();
    expect(getValidOpenIDReuseCredential({ openid_user_id: 'x' }, undefined)).toBeNull();
  });

  it('surfaces the signed session reference when present', () => {
    const token = jwt.sign({ id: 'user-1', openidSessionId: 'session-1' }, secret);
    const credential = getValidOpenIDReuseCredential({ openid_user_id: token }, secret);
    expect(credential).toMatchObject({ userId: 'user-1', openidSessionId: 'session-1' });
  });

  it('leaves the session reference undefined for a legacy marker', () => {
    const token = jwt.sign({ id: 'user-1' }, secret);
    const credential = getValidOpenIDReuseCredential({ openid_user_id: token }, secret);
    expect(credential).toMatchObject({ userId: 'user-1' });
    expect(credential?.openidSessionId).toBeUndefined();
  });

  it('rejects a refresh-token binding mismatch regardless of the session reference', () => {
    const token = jwt.sign(
      { id: 'user-1', openidSessionId: 'session-1', refreshTokenHash: 'stale-hash' },
      secret,
    );
    const credential = getValidOpenIDReuseCredential(
      { openid_user_id: token },
      secret,
      'current-refresh-token',
    );
    expect(credential).toBeNull();
  });
});
