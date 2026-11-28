import { resolveRunPause } from './pause';

const ask = { canPause: true, sharedStore: false, getCheckpointer: async () => ({}) };

function trigger(source: Record<string, unknown>) {
  return {
    user: { id: 'owner-1' },
    _isAgentTrigger: true,
    body: {
      agent_id: 'agent_1',
      clientRequestId: 'delivery-1',
      agentTrigger: {
        version: 1,
        event: { id: 'event-1', type: 'github.check_suite.completed', occurredAt: 1, source },
      },
    },
  } as never;
}

describe('resolveRunPause', () => {
  it("never lets a subscription's run pause, even where a pause can be held", async () => {
    await expect(
      resolveRunPause({
        ...ask,
        sharedStore: true,
        req: trigger({ type: 'subscription', id: 's' }),
      }),
    ).resolves.toEqual({ capable: false, prunes: true, missing: 'unattended' });
  });

  it("asks a schedule's run as before", async () => {
    await expect(
      resolveRunPause({ ...ask, req: { _isScheduledFire: true } as never }),
    ).resolves.toEqual({ capable: false, prunes: true, missing: 'shared_store' });
  });

  it("lets any other run pause, an API key's event included", async () => {
    await expect(resolveRunPause({ ...ask, req: undefined })).resolves.toEqual({
      capable: true,
      prunes: true,
    });
    await expect(
      resolveRunPause({ ...ask, req: trigger({ type: 'remote_api_key', id: 'k' }) }),
    ).resolves.toEqual({ capable: true, prunes: true });
  });
});
