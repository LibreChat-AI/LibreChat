import { getReplayablePendingMCPOAuthStarts, OAuthLifecycleRelay } from './pending';

describe('getReplayablePendingMCPOAuthStarts', () => {
  it('reads every server at once and keeps request order for pending starts only', async () => {
    const createdAt = Date.now();
    const resolvers: Array<() => void> = [];
    const getFlowState = jest.fn(
      (flowId: string) =>
        new Promise((resolve) => {
          resolvers.push(() =>
            resolve(
              flowId.includes('idle')
                ? null
                : {
                    status: 'PENDING',
                    createdAt,
                    metadata: { authorizationUrl: `https://auth.example.com/${flowId}` },
                  },
            ),
          );
        }),
    );

    const result = getReplayablePendingMCPOAuthStarts({
      flowManager: { getFlowState } as never,
      userId: 'user-1',
      serverNames: ['zeta', 'idle', 'skipped', 'alpha'],
      skip: (serverName) => serverName === 'skipped',
    });
    await Promise.resolve();
    expect(getFlowState).toHaveBeenCalledTimes(3);
    resolvers.reverse().forEach((resolve) => resolve());

    const pending = await result;
    expect([...pending.keys()]).toEqual(['zeta', 'alpha']);
    expect(pending.get('zeta')?.authURL).toContain('zeta');
  });
});

describe('OAuthLifecycleRelay.onSignInRequested', () => {
  const url = 'https://auth.example.com/authorize';

  it('tells a waiter with no prompt handler when a person is asked to sign in', async () => {
    const oauthStart = jest.fn().mockResolvedValue(undefined);
    const relay = new OAuthLifecycleRelay({ oauthStart, logPrefix: '[test]' });
    const early = jest.fn();
    const withdrawn = jest.fn();
    relay.onSignInRequested(early);
    relay.onSignInRequested(withdrawn)();
    expect(early).not.toHaveBeenCalled();

    await relay.start(url);
    await relay.start(url);

    expect(early).toHaveBeenCalledTimes(1);
    expect(withdrawn).not.toHaveBeenCalled();
    expect(oauthStart).toHaveBeenCalledTimes(1);

    const late = jest.fn();
    relay.onSignInRequested(late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('tells waiters even when every prompt handler refuses the publication', async () => {
    const refusal = new Error('nobody to prompt');
    const relay = new OAuthLifecycleRelay({
      oauthStart: jest.fn().mockRejectedValue(refusal),
      logPrefix: '[test]',
    });
    const waiter = jest.fn();
    relay.onSignInRequested(waiter);

    await expect(relay.start(url)).rejects.toBe(refusal);
    expect(waiter).toHaveBeenCalledTimes(1);
  });
});
