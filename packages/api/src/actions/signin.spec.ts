import { ActionSignInUnattendedError, assertActionSignInAttended } from './signin';

describe('assertActionSignInAttended', () => {
  it('refuses with a typed error on a run nobody can sign in for', () => {
    expect(() => assertActionSignInAttended(true)).toThrow(ActionSignInUnattendedError);
    try {
      assertActionSignInAttended(true);
    } catch (error) {
      expect(error).toMatchObject({
        name: 'ActionSignInUnattendedError',
        code: 'action_reauth_required',
      });
    }
  });

  it.each([false, undefined])('lets a prompt through when unattended is %s', (unattended) => {
    expect(() => assertActionSignInAttended(unattended)).not.toThrow();
  });
});
