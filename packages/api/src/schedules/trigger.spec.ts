import {
  captureScheduleFireContext,
  exemptFromConcurrencyLimiter,
  exemptFromUserLimiter,
  isScheduleFireRequest,
  readScheduleFireContext,
  restoreSkippedMCPServers,
  skippedMCPServers,
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

  it('drops every key on a skipped server, by its name and by its normalized name', () => {
    const req = {
      _scheduleSkippedServers: ['Notion', 'Sales Force'],
      _scheduleCheckedServers: ['Notion', 'Sales Force', 'Linear'],
    };
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

  it('leaves a ready server alone when its name ends with a skipped one', () => {
    const req = {
      _scheduleSkippedServers: ['bar'],
      _scheduleCheckedServers: ['bar', 'foo_mcp_bar'],
    };
    expect(
      withoutSkippedMCPServers(req, ['query_mcp_bar', 'query_mcp_foo_mcp_bar', 'web_search']),
    ).toEqual(['query_mcp_foo_mcp_bar', 'web_search']);
    // And the other way round: the longer name skipped, the shorter one ready.
    expect(
      withoutSkippedMCPServers(
        {
          _scheduleSkippedServers: ['foo_mcp_bar'],
          _scheduleCheckedServers: ['bar', 'foo_mcp_bar'],
        },
        ['query_mcp_bar', 'query_mcp_foo_mcp_bar'],
      ),
    ).toEqual(['query_mcp_bar']);
  });

  it('hands back the same list when nothing is left out', () => {
    const keys = ['list_mcp_Linear', 'execute_code'];
    expect(withoutSkippedMCPServers({ _scheduleSkippedServers: ['Notion'] }, keys)).toBe(keys);
    expect(withoutSkippedMCPServers({}, keys)).toBe(keys);
    expect(withoutSkippedMCPServers(undefined, keys)).toBe(keys);
  });
});
