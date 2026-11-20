import {
  captureScheduleFireContext,
  exemptFromConcurrencyLimiter,
  exemptFromUserLimiter,
  isScheduleFireRequest,
  readScheduleFireContext,
  withoutSkippedMCPServers,
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
  const skipping = (skip: unknown) => {
    const req = request();
    Object.assign(req.body.agentTrigger.metadata, { skip });
    return req;
  };

  it('reads them from the verified trigger and keeps them for the run', () => {
    const req: ReturnType<typeof request> & { _scheduleSkippedServers?: string[] } = skipping([
      'Notion',
      'Sales Force',
    ]);
    expect(captureScheduleFireContext(req)).toMatchObject({ skip: ['Notion', 'Sales Force'] });
    expect(req._scheduleSkippedServers).toEqual(['Notion', 'Sales Force']);
  });

  it('carries none where the trigger names none', () => {
    expect(readScheduleFireContext(request())).not.toHaveProperty('skip');
    expect(readScheduleFireContext(skipping([]))).not.toHaveProperty('skip');
  });

  it.each([['Notion', 7], 'Notion', { 0: 'Notion' }])(
    'does not treat a trigger with a malformed list as a schedule fire: %j',
    (skip) => {
      expect(readScheduleFireContext(skipping(skip))).toBeUndefined();
    },
  );

  it('drops every key on a skipped server, by its name and by its normalized name', () => {
    const req = { _scheduleSkippedServers: ['Notion', 'Sales Force'] };
    const keys = [
      'search_mcp_Notion',
      'sys__all__sys_mcp_Notion',
      'sys__server__sys_mcp_Notion',
      'query_mcp_Sales_Force',
      'list_mcp_Linear',
      'execute_code',
      'web_search',
    ];
    expect(withoutSkippedMCPServers(req, keys)).toEqual([
      'list_mcp_Linear',
      'execute_code',
      'web_search',
    ]);
  });

  it('hands back the same list when nothing is left out', () => {
    const keys = ['list_mcp_Linear', 'execute_code'];
    expect(withoutSkippedMCPServers({ _scheduleSkippedServers: ['Notion'] }, keys)).toBe(keys);
    expect(withoutSkippedMCPServers({}, keys)).toBe(keys);
    expect(withoutSkippedMCPServers(undefined, keys)).toBe(keys);
  });
});
