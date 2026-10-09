import {
  captureScheduleFireContext,
  exemptFromConcurrencyLimiter,
  exemptFromUserLimiter,
  isScheduleFireRequest,
  readScheduleFireContext,
} from './trigger';

function request(manual = false) {
  return {
    _isAgentTrigger: true,
    body: {
      scheduleId: 'spoofed',
      agentTrigger: {
        version: 1,
        deliveryId: 'delivery-1',
        event: {
          id: 'occurrence-1',
          type: 'schedule.occurrence',
          occurredAt: 1_725_000_000_000,
          source: { id: 'schedule-1', type: 'schedule' },
        },
        metadata: { manual, configRevision: 7 },
      },
    },
  };
}

describe('schedule trigger context', () => {
  it('projects a verified generic trigger into schedule lifecycle fields', () => {
    const req = request();

    expect(captureScheduleFireContext(req)).toEqual({
      scheduleId: 'schedule-1',
      scheduledFor: new Date(1_725_000_000_000).toISOString(),
      manual: false,
      configRevision: 7,
    });
    expect(req.body).toMatchObject({
      scheduleId: 'schedule-1',
      scheduledFor: new Date(1_725_000_000_000).toISOString(),
      scheduleConfigRevision: 7,
    });
    expect(isScheduleFireRequest(req)).toBe(true);
    expect(exemptFromUserLimiter(req)).toBe(true);
    expect(exemptFromConcurrencyLimiter(req)).toBe(true);
  });

  it('keeps manual runs on the interactive user and concurrency limiters', () => {
    const req = request(true);
    captureScheduleFireContext(req);

    expect(exemptFromUserLimiter(req)).toBe(false);
    expect(exemptFromConcurrencyLimiter(req)).toBe(false);
  });

  it('rejects copied metadata without a verified agent-trigger identity', () => {
    const req = request();
    req._isAgentTrigger = false;

    expect(readScheduleFireContext(req)).toBeUndefined();
    expect(captureScheduleFireContext(req)).toBeUndefined();
    expect(req.body.scheduleId).toBe('spoofed');
    expect(isScheduleFireRequest(req)).toBe(false);
  });

  it.each([
    { event: { type: 'schedule.occurrence', occurredAt: 1, source: { id: 's', type: 'webhook' } } },
    {
      event: { type: 'schedule.occurrence', occurredAt: -1, source: { id: 's', type: 'schedule' } },
    },
    {
      event: { type: 'schedule.occurrence', occurredAt: 1, source: { id: 's', type: 'schedule' } },
      metadata: { manual: 'yes' },
    },
  ])('fails closed for malformed schedule trigger metadata', (agentTrigger) => {
    expect(
      readScheduleFireContext({
        _isAgentTrigger: true,
        body: { agentTrigger: { version: 1, ...agentTrigger } },
      }),
    ).toBeUndefined();
  });
});
