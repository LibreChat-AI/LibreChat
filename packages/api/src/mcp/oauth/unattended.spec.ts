import { guardUnattendedOAuth, OAuthPromptUnattendedError } from './unattended';

describe('guardUnattendedOAuth', () => {
  it('ends the caller with a typed error at the first sign-in prompt, reporting it once', async () => {
    const onSignInRequired = jest.fn();
    const guard = guardUnattendedOAuth(undefined, onSignInRequired);

    expect(guard.signal.aborted).toBe(false);
    await expect(guard.oauthStart('https://auth.example/authorize')).rejects.toBeInstanceOf(
      OAuthPromptUnattendedError,
    );
    await expect(guard.oauthStart('https://auth.example/authorize')).rejects.toMatchObject({
      code: 'mcp_reauth_required',
    });

    expect(guard.signal.aborted).toBe(true);
    expect(guard.signal.reason).toBeInstanceOf(OAuthPromptUnattendedError);
    guard.leave();
    expect(onSignInRequired).toHaveBeenCalledTimes(1);
  });

  it("keeps the caller's own cancellation and its reason", () => {
    const caller = new AbortController();
    const guard = guardUnattendedOAuth(caller.signal);
    const stopped = new Error('caller stopped');

    caller.abort(stopped);

    expect(guard.signal.aborted).toBe(true);
    expect(guard.signal.reason).toBe(stopped);
  });
});
