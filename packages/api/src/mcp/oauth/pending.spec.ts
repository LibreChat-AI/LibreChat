import { getReplayablePendingMCPOAuthStarts } from './pending';

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
