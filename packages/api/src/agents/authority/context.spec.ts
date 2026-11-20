import {
  getScheduleSource,
  restoreExecutionContext,
  toScheduledTokenContext,
  createRemoteExecutionContext,
  createScheduleExecutionContext,
} from './context';

const user = { id: 'owner', tenantId: 'tenant' };

function scheduleFire({ manual = false, agentId = 'root-agent' as unknown } = {}) {
  return {
    user,
    _isAgentTrigger: true,
    body: {
      agent_id: agentId,
      scheduleId: 'spoofed',
      agentTrigger: {
        version: 1,
        event: {
          type: 'schedule.occurrence',
          occurredAt: 0,
          source: { type: 'schedule', id: 'schedule' },
        },
        metadata: { manual },
      },
    },
  };
}

const savedJob = {
  userId: 'owner',
  tenantId: 'tenant',
  scheduleId: 'schedule',
  scheduleManual: true,
  agent_id: 'root-agent',
};

describe('createScheduleExecutionContext', () => {
  it.each([false, true])('reads the verified trigger, not the body (manual=%s)', (manual) => {
    const context = createScheduleExecutionContext(scheduleFire({ manual }));

    expect(context).toEqual({
      principal: { userId: 'owner', tenantId: 'tenant' },
      agentId: 'root-agent',
      source: { type: 'schedule', id: 'schedule', manual, resumed: false },
      unattended: false,
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context?.principal)).toBe(true);
    expect(Object.isFrozen(context?.source)).toBe(true);
  });

  it('ignores schedule fields copied into an ordinary request', () => {
    expect(
      createScheduleExecutionContext({ ...scheduleFire(), _isAgentTrigger: false }),
    ).toBeUndefined();
    expect(
      createScheduleExecutionContext({ user, body: { scheduleId: 'forged' } }),
    ).toBeUndefined();
  });

  it('keeps no agent when the trigger body carries a non-string one', () => {
    expect(createScheduleExecutionContext(scheduleFire({ agentId: 42 }))?.agentId).toBeUndefined();
  });
});

describe('restoreExecutionContext', () => {
  it('rebuilds a paused scheduled run from its saved job', () => {
    const context = restoreExecutionContext({ user }, savedJob);

    expect(context).toEqual({
      principal: { userId: 'owner', tenantId: 'tenant' },
      agentId: 'root-agent',
      source: { type: 'schedule', id: 'schedule', manual: true, resumed: true },
      unattended: false,
    });
    expect(Object.isFrozen(context)).toBe(true);
  });

  it('returns nothing for an unscheduled job', () => {
    expect(restoreExecutionContext({ user }, { userId: 'owner' })).toBeUndefined();
    expect(restoreExecutionContext({ user })).toBeUndefined();
  });

  it.each([{ userId: 'different' }, { tenantId: 'different' }])(
    'refuses a job owned by someone else %j',
    (override) => {
      expect(() => restoreExecutionContext({ user }, { ...savedJob, ...override })).toThrow(
        'Scheduled job identity',
      );
    },
  );

  it.each([{ agent_id: undefined }, { tenantId: undefined }])(
    'restores a legacy job %j without an agent, so it cannot mint',
    (override) => {
      const context = restoreExecutionContext({ user }, { ...savedJob, ...override });

      expect(getScheduleSource(context)).toMatchObject({ id: 'schedule', resumed: true });
      expect(context?.agentId).toBeUndefined();
      expect(toScheduledTokenContext(context)).toBeUndefined();
    },
  );
});

describe('createRemoteExecutionContext', () => {
  it('records the principal, agent and protocol', () => {
    const context = createRemoteExecutionContext({
      principal: { userId: 'owner', tenantId: 'tenant', role: 'USER' },
      agentId: 'agent_remote',
      protocol: 'responses',
      background: true,
    });

    expect(context).toEqual({
      principal: { userId: 'owner', tenantId: 'tenant', role: 'USER' },
      agentId: 'agent_remote',
      source: { type: 'remote_api', protocol: 'responses', background: true },
      unattended: false,
    });
    expect(Object.isFrozen(context.source)).toBe(true);
  });
});

describe('whether anybody can follow a sign-in prompt', () => {
  const remote = (background: boolean) =>
    createRemoteExecutionContext({
      principal: { userId: 'owner' },
      protocol: 'chat.completions',
      background,
    });
  const job = { userId: 'owner', tenantId: 'tenant', scheduleId: 'sched-1', agent_id: 'agent_x' };

  it.each([
    ['a foreground remote run', remote(false), true],
    ['a background remote run', remote(true), false],
    ['a scheduled run', createScheduleExecutionContext(scheduleFire()), false],
    [
      'a resumed scheduled run',
      restoreExecutionContext({ user: { id: 'owner', tenantId: 'tenant' } }, job),
      false,
    ],
  ])('is decided where the run enters: %s', (_label, context, expected) => {
    expect(context?.unattended).toBe(expected);
  });
});

describe('toScheduledTokenContext', () => {
  it('projects the identity host credential providers bind to', () => {
    const fresh = toScheduledTokenContext(createScheduleExecutionContext(scheduleFire()));
    const resumed = toScheduledTokenContext(restoreExecutionContext({ user }, savedJob));
    const expected = {
      scheduleId: 'schedule',
      ownerId: 'owner',
      tenantId: 'tenant',
      agentId: 'root-agent',
      invocationMode: 'delegated',
    };

    expect(fresh).toEqual(expected);
    expect(resumed).toEqual(expected);
    expect(Object.isFrozen(fresh)).toBe(true);
  });

  it('omits the tenant for a tenant-less owner', () => {
    const context = createScheduleExecutionContext({ ...scheduleFire(), user: { id: 'owner' } });

    expect(toScheduledTokenContext(context)).not.toHaveProperty('tenantId');
  });

  it.each([['   '], ['']])('projects nothing for a blank agent %j', (agentId) => {
    expect(
      toScheduledTokenContext(createScheduleExecutionContext(scheduleFire({ agentId }))),
    ).toBeUndefined();
  });

  it('projects nothing for an unscheduled run', () => {
    expect(
      toScheduledTokenContext(
        createRemoteExecutionContext({
          principal: { userId: 'owner' },
          agentId: 'agent_remote',
          protocol: 'responses',
          background: false,
        }),
      ),
    ).toBeUndefined();
  });
});

it('names the personal API key that started a remote run, and nothing when there is none', () => {
  const base = {
    principal: { userId: 'owner' },
    agentId: 'agent_a',
    protocol: 'responses' as const,
    background: true,
  };
  expect(createRemoteExecutionContext({ ...base, keyId: 'key-1' }).source).toEqual({
    type: 'remote_api',
    protocol: 'responses',
    background: true,
    keyId: 'key-1',
  });
  expect(createRemoteExecutionContext(base).source).not.toHaveProperty('keyId');
  expect(createRemoteExecutionContext({ ...base, keyId: undefined }).source).not.toHaveProperty(
    'keyId',
  );
});
