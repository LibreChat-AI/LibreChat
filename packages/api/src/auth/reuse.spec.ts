import jwt from 'jsonwebtoken';
import { getValidOpenIdReuseUserId } from './reuse';

const secret = 'test-refresh-secret';

describe('getValidOpenIdReuseUserId', () => {
  it('returns the signed OpenID user id', () => {
    const token = jwt.sign({ id: 'user-a' }, secret);

    expect(getValidOpenIdReuseUserId(token, secret)).toBe('user-a');
  });

  it('rejects missing or invalid signed user ids', () => {
    expect(getValidOpenIdReuseUserId(undefined, secret)).toBeNull();
    expect(getValidOpenIdReuseUserId('invalid-token', secret)).toBeNull();
    expect(getValidOpenIdReuseUserId(jwt.sign({ sub: 'user-a' }, secret), secret)).toBeNull();
  });
});
