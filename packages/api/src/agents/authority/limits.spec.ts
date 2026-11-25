import { exemptTriggerFromUserLimiter } from './limits';

type Request = Parameters<typeof exemptTriggerFromUserLimiter>[0];

function trigger(source: Record<string, unknown> | undefined, isTrigger = true): Request {
  return {
    user: { id: 'owner-1' },
    _isAgentTrigger: isTrigger,
    body: {
      agent_id: 'agent_1',
      clientRequestId: 'delivery-1',
      agentTrigger: {
        version: 1,
        event: { id: 'event-1', type: 'github.check_suite.completed', occurredAt: 1, source },
      },
    },
  } as unknown as Request;
}

describe('exemptTriggerFromUserLimiter', () => {
  it("leaves a subscription's run out of its owner's chat limiter", () => {
    expect(exemptTriggerFromUserLimiter(trigger({ type: 'subscription', id: 'sub_1' }))).toBe(true);
  });

  it('keeps an automatic schedule occurrence out, as before', () => {
    expect(exemptTriggerFromUserLimiter({ _isScheduledFire: true } as unknown as Request)).toBe(
      true,
    );
    expect(
      exemptTriggerFromUserLimiter({
        _isScheduledFire: true,
        _isManualScheduledFire: true,
      } as unknown as Request),
    ).toBe(false);
  });

  it("counts an API key's event and a request no trigger made", () => {
    expect(exemptTriggerFromUserLimiter(trigger({ type: 'remote_api_key', id: 'key_1' }))).toBe(
      false,
    );
    expect(
      exemptTriggerFromUserLimiter(trigger({ type: 'subscription', id: 'sub_1' }, false)),
    ).toBe(false);
    expect(exemptTriggerFromUserLimiter(undefined)).toBe(false);
  });

  it('counts a trigger whose subscription cannot be read', () => {
    expect(exemptTriggerFromUserLimiter(trigger({ type: 'subscription', id: '  ' }))).toBe(false);
  });
});
