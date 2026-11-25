import {
  captureScheduleFireContext,
  exemptFromConcurrencyLimiter,
  exemptFromUserLimiter,
  isScheduleFireRequest,
  readScheduleFireContext,
  restoreSkippedMCPServers,
  readSkippedMCPServers,
  skippedMCPServers,
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

describe('servers a scheduled run is started without', () => {
  type Marked = { _scheduleSkippedServers?: string[]; _scheduleCheckedServers?: string[] };
  const marking = (metadata: Record<string, unknown>) => {
    const req = request();
    Object.assign(req.body.agentTrigger.metadata, metadata);
    return req;
  };

  it('reads them from the verified trigger, with every server the check covered', () => {
    const req: ReturnType<typeof request> & Marked = marking({
      skip: ['Notion'],
      servers: ['Notion', 'Linear'],
    });
    expect(captureScheduleFireContext(req)).toMatchObject({
      skip: ['Notion'],
      servers: ['Notion', 'Linear'],
    });
    expect(req._scheduleSkippedServers).toEqual(['Notion']);
    expect(req._scheduleCheckedServers).toEqual(['Notion', 'Linear']);
  });

  it('carries none where the trigger names none', () => {
    expect(readScheduleFireContext(request())).not.toHaveProperty('skip');
    const none = readScheduleFireContext(marking({ skip: [], servers: ['Linear'] }));
    expect(none).not.toHaveProperty('skip');
    expect(none).not.toHaveProperty('servers');
  });

  it.each([
    { skip: ['Notion', 7] },
    { skip: 'Notion' },
    { skip: { 0: 'Notion' } },
    { skip: ['Notion'], servers: 'Notion' },
    { skip: ['Notion'], servers: [null] },
  ])('does not treat a trigger with a malformed list as a schedule fire: %j', (metadata) => {
    expect(readScheduleFireContext(marking(metadata))).toBeUndefined();
  });

  it('derives both lists from the outcomes of a check, and neither when nothing was skipped', () => {
    expect(
      skippedMCPServers([
        { server: 'Notion', skipped: true },
        { server: 'Notion', skipped: true },
        { server: 'Linear' },
      ]),
    ).toEqual({ skip: ['Notion'], servers: ['Notion', 'Linear'] });
    expect(skippedMCPServers([{ server: 'Linear' }])).toEqual({ skip: [], servers: [] });
  });

  it('puts them back on a request that resumes the run, and clears them when there are none', () => {
    const req: Marked = { _scheduleSkippedServers: ['stale'], _scheduleCheckedServers: ['stale'] };
    restoreSkippedMCPServers(req, [{ server: 'Notion', skipped: true }, { server: 'Linear' }]);
    expect(req).toEqual({
      _scheduleSkippedServers: ['Notion'],
      _scheduleCheckedServers: ['Notion', 'Linear'],
    });
    restoreSkippedMCPServers(req, [{ server: 'Linear' }]);
    expect(req._scheduleSkippedServers).toBeUndefined();
    expect(req._scheduleCheckedServers).toBeUndefined();
  });

  it('hands the run host what the request carries, and nothing where no server was skipped', () => {
    const req: Marked = {};
    restoreSkippedMCPServers(req, [{ server: 'Notion', skipped: true }, { server: 'Linear' }]);
    expect(readSkippedMCPServers(req)).toEqual({ skip: ['Notion'], servers: ['Notion', 'Linear'] });
    restoreSkippedMCPServers(req, [{ server: 'Linear' }]);
    expect(readSkippedMCPServers(req)).toBeUndefined();
    // A list with no record of what the check covered is still a list of what to go without.
    expect(readSkippedMCPServers({ _scheduleSkippedServers: ['Notion'] })).toEqual({
      skip: ['Notion'],
      servers: [],
    });
    expect(readSkippedMCPServers({ _scheduleCheckedServers: ['Notion'] })).toBeUndefined();
    expect(readSkippedMCPServers(undefined)).toBeUndefined();
  });
});
