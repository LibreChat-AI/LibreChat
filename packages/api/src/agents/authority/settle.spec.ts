import type { SubjectAdapter } from './subject';
import { createRunSettler } from './settle';

type Adapter = Pick<SubjectAdapter, 'claims' | 'settle'>;

const OWNER = 'owner-1';

function trigger(source: Record<string, unknown>) {
  return {
    user: { id: OWNER },
    _isAgentTrigger: true,
    body: {
      agent_id: 'agent_1',
      clientRequestId: 'delivery-1',
      agentTrigger: {
        version: 1,
        event: { id: 'event-1', type: 'github.check_suite.completed', occurredAt: 1, source },
      },
    },
  } as unknown as Parameters<ReturnType<typeof createRunSettler>>[0];
}

const subscription = trigger({ type: 'subscription', id: 'sub_1' });

function adapter(kind: string, answer = true): Adapter & { settle: jest.Mock } {
  return {
    claims: ({ executionContext }) =>
      executionContext?.source?.type === 'trigger' &&
      executionContext.source.subject?.kind === kind,
    settle: jest.fn(async () => answer),
  };
}

describe('createRunSettler', () => {
  it("hands a subscription run's outcome to the subject that claims it, with the run's context", async () => {
    const mine = adapter('subscription', false);
    const other = adapter('key');
    const settle = createRunSettler([other, mine]);
    await expect(settle(subscription, { status: 'error', error: 'failed' })).resolves.toBe(false);
    expect(other.settle).not.toHaveBeenCalled();
    expect(mine.settle).toHaveBeenCalledWith({
      status: 'error',
      error: 'failed',
      request: subscription,
      executionContext: expect.objectContaining({
        principal: { userId: OWNER },
        source: expect.objectContaining({
          subject: { kind: 'subscription', id: 'sub_1' },
          delivery: expect.objectContaining({ key: 'delivery-1' }),
        }),
      }),
    });
  });

  it('answers false, never throwing, when the subject cannot record the run', async () => {
    const mine = adapter('subscription');
    mine.settle.mockRejectedValue(new Error('store down'));
    await expect(createRunSettler([mine])(subscription, { status: 'success' })).resolves.toBe(
      false,
    );
  });

  it('settles nothing for a request no trigger made', async () => {
    const mine = adapter('subscription');
    const req = { ...subscription, _isAgentTrigger: false };
    await expect(createRunSettler([mine])(req, { status: 'success' })).resolves.toBe(true);
    expect(mine.settle).not.toHaveBeenCalled();
  });

  it('answers true when no subject records the run', async () => {
    const key = trigger({ type: 'remote_api_key', id: 'key_1' });
    const mine = adapter('subscription');
    await expect(createRunSettler([mine])(key, { status: 'success' })).resolves.toBe(true);
    expect(mine.settle).not.toHaveBeenCalled();
  });

  it('passes over a subject that claims the run but records none', async () => {
    const silent: Adapter = { claims: () => true };
    const mine = adapter('subscription');
    await expect(
      createRunSettler([silent, mine])(subscription, { status: 'success' }),
    ).resolves.toBe(true);
    expect(mine.settle).toHaveBeenCalled();
  });
});
