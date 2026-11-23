import {
  getSourceKey,
  getScheduleSource,
  restoreExecutionContext,
  toScheduledTokenContext,
  stampMessageTrigger,
  toMessageTrigger,
  createRemoteExecutionContext,
  createTriggerExecutionContext,
  createScheduleExecutionContext,
} from './context';
import { parseRunTrigger, captureTrigger } from './trigger';

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
      source: {
        type: 'trigger',
        subject: { kind: 'schedule', id: 'schedule' },
        manual,
        resumed: false,
      },
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
      source: {
        type: 'trigger',
        subject: { kind: 'schedule', id: 'schedule' },
        manual: true,
        resumed: true,
      },
      unattended: false,
    });
    expect(Object.isFrozen(context)).toBe(true);
  });

  const delivery = {
    key: 'trigger_abc',
    event: { id: 'event-1', type: 'review.submitted', occurredAt: 1_000 },
  };
  const keyJob = {
    userId: 'owner',
    tenantId: 'tenant',
    agent_id: 'root-agent',
    trigger: { subject: { kind: 'key' as const, id: 'key-1' }, delivery },
  };

  it('rebuilds a paused run an API key started, for that key and the same delivery', () => {
    const context = restoreExecutionContext({ user }, keyJob);

    expect(context).toEqual({
      principal: { userId: 'owner', tenantId: 'tenant' },
      agentId: 'root-agent',
      source: {
        type: 'trigger',
        subject: { kind: 'key', id: 'key-1' },
        delivery,
        manual: false,
        resumed: true,
      },
      unattended: false,
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(getSourceKey(context)).toBe('key-1');
  });

  it("rebuilds a paused turn that reports earlier work with its origin and that run's root agent", () => {
    const origin = { agentId: 'root-agent', delivery };
    const own = { key: 'trigger_wake', event: { id: 'task-1', type: 'done', occurredAt: 2_000 } };
    const context = restoreExecutionContext(
      { user },
      {
        ...keyJob,
        agent_id: 'handoff-agent',
        trigger: { subject: keyJob.trigger.subject, delivery: own, origin },
      },
    );

    expect(context?.agentId).toBe('root-agent');
    expect(context?.source).toEqual({
      type: 'trigger',
      subject: { kind: 'key', id: 'key-1' },
      delivery: own,
      origin,
      manual: false,
      resumed: true,
    });
    expect(getSourceKey(context)).toBe('key-1');
  });

  it("keeps a paused turn the schedule's completion turn, not its occurrence", () => {
    const trigger = {
      subject: { kind: 'schedule' as const, id: 'schedule' },
      delivery,
      origin: { agentId: 'root-agent', delivery },
    };
    const context = restoreExecutionContext({ user }, { ...keyJob, trigger });

    expect(context?.source).toMatchObject({ subject: trigger.subject, origin: trigger.origin });
    expect(getScheduleSource(context)).toBeUndefined();
    expect(toScheduledTokenContext(context)).toBeUndefined();
  });

  it('rebuilds a paused run no subject started with its delivery alone', () => {
    const context = restoreExecutionContext({ user }, { ...keyJob, trigger: { delivery } });

    expect(context?.source).toEqual({ type: 'trigger', delivery, manual: false, resumed: true });
    expect(getSourceKey(context)).toBeUndefined();
  });

  it('gives a paused scheduled run the delivery its job saved', () => {
    const trigger = { subject: { kind: 'schedule' as const, id: 'schedule' }, delivery };
    const context = restoreExecutionContext({ user }, { ...savedJob, trigger });

    expect(context?.source).toEqual({ type: 'trigger', ...trigger, manual: true, resumed: true });
    expect(getScheduleSource(context)).toEqual({ id: 'schedule', manual: true, resumed: true });
  });

  it('restores a scheduled job saved before its trigger was, with no delivery', () => {
    const context = restoreExecutionContext({ user }, savedJob);

    expect(context?.source).not.toHaveProperty('delivery');
    expect(getScheduleSource(context)).toEqual({ id: 'schedule', manual: true, resumed: true });
    expect(toScheduledTokenContext(context)).toMatchObject({ scheduleId: 'schedule' });
  });

  it('refuses a scheduled job whose saved trigger names another subject', () => {
    for (const subject of [
      { kind: 'key' as const, id: 'key-1' },
      { kind: 'schedule' as const, id: 'other' },
    ])
      expect(() =>
        restoreExecutionContext({ user }, { ...savedJob, trigger: { subject, delivery } }),
      ).toThrow('saved trigger');
  });

  it.each([{ userId: 'different' }, { tenantId: 'different' }])(
    'refuses a triggered job owned by someone else %j',
    (override) => {
      expect(() => restoreExecutionContext({ user }, { ...keyJob, ...override })).toThrow(
        'Saved job identity',
      );
    },
  );

  it('restores a key job that cannot prove its agent without one', () => {
    const context = restoreExecutionContext({ user }, { ...keyJob, agent_id: undefined });

    expect(getSourceKey(context)).toBe('key-1');
    expect(context?.agentId).toBeUndefined();
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

describe('createTriggerExecutionContext', () => {
  const event = (source: Record<string, unknown>) => ({
    id: 'event-1',
    type: 'review.submitted',
    occurredAt: 1_000,
    source,
  });
  /** A new conversation the trigger host starts for an event the public route accepted. */
  const fire = (source: Record<string, unknown> = { type: 'remote_api_key', id: 'key-1' }) => ({
    user,
    _isAgentTrigger: true,
    body: {
      agent_id: 'root-agent',
      clientRequestId: 'trigger_abc',
      agentTrigger: { version: 1, deliveryId: 'caller-key', event: event(source) },
    },
  });
  /** A later event the trigger host continues a bound conversation with. */
  const bound = () => ({
    user,
    _isAgentTrigger: true,
    body: {
      agent_id: 'root-agent',
      conversationId: 'conversation',
      clientRequestId: 'ignored',
      agentEventDelivery: {
        deliveryKey: 'trigger_def',
        event: event({ type: 'remote_api_key', id: 'key-1' }),
      },
    },
  });

  it('gives a delivery an API key posted that key as its subject, and names the delivery', () => {
    const context = createTriggerExecutionContext(fire());
    expect(context).toEqual({
      principal: { userId: 'owner', tenantId: 'tenant' },
      agentId: 'root-agent',
      source: {
        type: 'trigger',
        subject: { kind: 'key', id: 'key-1' },
        delivery: {
          key: 'trigger_abc',
          event: { id: 'event-1', type: 'review.submitted', occurredAt: 1_000 },
        },
        manual: false,
        resumed: false,
      },
      unattended: false,
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(getSourceKey(context)).toBe('key-1');
  });

  it('reads a bound continuation the same way, from the delivery it carries', () => {
    expect(createTriggerExecutionContext(bound())?.source).toEqual({
      type: 'trigger',
      subject: { kind: 'key', id: 'key-1' },
      delivery: {
        key: 'trigger_def',
        event: { id: 'event-1', type: 'review.submitted', occurredAt: 1_000 },
      },
      manual: false,
      resumed: false,
    });
  });

  it('keeps the context a schedule occurrence has always had', () => {
    const req = scheduleFire({ manual: true });
    expect(createTriggerExecutionContext(req)).toEqual(createScheduleExecutionContext(req));
    expect(getScheduleSource(createTriggerExecutionContext(req))).toEqual({
      id: 'schedule',
      manual: true,
      resumed: false,
    });
  });

  it('gives a schedule occurrence the schedule as its subject and names its delivery', () => {
    const req = scheduleFire();
    Object.assign(req.body, { clientRequestId: 'trigger_occurrence' });
    Object.assign(req.body.agentTrigger.event, { id: 'sched:schedule:1970' });

    expect(createTriggerExecutionContext(req)?.source).toEqual({
      type: 'trigger',
      subject: { kind: 'schedule', id: 'schedule' },
      delivery: {
        key: 'trigger_occurrence',
        event: { id: 'sched:schedule:1970', type: 'schedule.occurrence', occurredAt: 0 },
      },
      manual: false,
      resumed: false,
    });
  });

  /** A turn the trigger host continues a conversation with, bound to no event source. */
  const unbound = (source: Record<string, unknown>, type: string) => ({
    user,
    _isAgentTrigger: true,
    body: {
      agent_id: 'root-agent',
      conversationId: 'conversation',
      clientRequestId: 'trigger_ghi',
      agentEvent: { ...event(source), type },
    },
  });

  it.each([
    ['a task wake-up', { type: 'internal', id: 'subagent-completion' }, 'subagent.completed'],
    ['a queued turn', { type: 'internal', id: 'agent-queued-turn' }, 'agent.queued-turn'],
  ])('gives %s its delivery and no subject', (_label, source, type) => {
    const context = createTriggerExecutionContext(unbound(source, type));

    expect(context).toEqual({
      principal: { userId: 'owner', tenantId: 'tenant' },
      agentId: 'root-agent',
      source: {
        type: 'trigger',
        delivery: { key: 'trigger_ghi', event: { id: 'event-1', type, occurredAt: 1_000 } },
        manual: false,
        resumed: false,
      },
      unattended: false,
    });
    expect(Object.isFrozen(context?.source)).toBe(true);
    expect(getSourceKey(context)).toBeUndefined();
    expect(getScheduleSource(context)).toBeUndefined();
    expect(toScheduledTokenContext(context)).toBeUndefined();
  });

  /** The turn the trigger host starts to report a task, with what the task captured. */
  const completion = (trigger: unknown, sourceId = 'background-tool-completion') => {
    const req = unbound({ type: 'internal', id: sourceId }, 'background_tool.completed');
    Object.assign(req.body, {
      agent_id: 'handoff-agent',
      agentCompletion: { version: 1, sourceId, ...(trigger !== undefined && { trigger }) },
    });
    return req;
  };
  const began = {
    agentId: 'root-agent',
    delivery: {
      key: 'trigger_abc',
      event: { id: 'event-0', type: 'review.submitted', occurredAt: 500 },
    },
  };

  it.each(['background-tool-completion', 'subagent-completion'])(
    "gives the turn that reports a key run's %s the key, the root agent and where the work began",
    (sourceId) => {
      const trigger = { subject: { kind: 'key', id: 'key-1' }, origin: began };
      const context = createTriggerExecutionContext(completion(trigger, sourceId));

      expect(context).toEqual({
        principal: { userId: 'owner', tenantId: 'tenant' },
        agentId: 'root-agent',
        source: {
          type: 'trigger',
          subject: { kind: 'key', id: 'key-1' },
          delivery: {
            key: 'trigger_ghi',
            event: { id: 'event-1', type: 'background_tool.completed', occurredAt: 1_000 },
          },
          origin: began,
          manual: false,
          resumed: false,
        },
        unattended: false,
      });
      expect(Object.isFrozen(context?.source)).toBe(true);
      expect(getSourceKey(context)).toBe('key-1');
    },
  );

  it("gives the turn that reports a schedule's task the schedule, without making it an occurrence", () => {
    const trigger = { subject: { kind: 'schedule', id: 'schedule' }, origin: began };
    const context = createTriggerExecutionContext(completion(trigger));

    expect(context?.source).toMatchObject({ subject: trigger.subject, origin: began });
    expect(getScheduleSource(context)).toBeUndefined();
    expect(toScheduledTokenContext(context)).toBeUndefined();
    expect(createScheduleExecutionContext(completion(trigger))).toBeUndefined();
    expect(getSourceKey(context)).toBeUndefined();
  });

  it('leaves the turn that reports a task no trigger captured as it was: its delivery alone', () => {
    for (const trigger of [undefined, null]) {
      const context = createTriggerExecutionContext(completion(trigger));

      expect(context?.agentId).toBe('handoff-agent');
      expect(context?.source).toEqual({
        type: 'trigger',
        delivery: {
          key: 'trigger_ghi',
          event: { id: 'event-1', type: 'background_tool.completed', occurredAt: 1_000 },
        },
        manual: false,
        resumed: false,
      });
    }
  });

  it('falls back to the addressed agent where the origin names none', () => {
    const trigger = { subject: { kind: 'key', id: 'key-1' }, origin: { delivery: began.delivery } };

    expect(createTriggerExecutionContext(completion(trigger))?.agentId).toBe('handoff-agent');
  });

  it.each([
    ['not an object', 'key-1'],
    ['a subject of no known kind', { subject: { kind: 'user', id: 'owner' } }],
    ['a subject with no id', { subject: { kind: 'key' } }],
    ['an origin that names nothing', { subject: { kind: 'key', id: 'key-1' }, origin: {} }],
    ['an origin whose agent is not a name', { origin: { ...began, agentId: 7 } }],
    ['an origin whose delivery has no event', { origin: { delivery: { key: 'trigger_abc' } } }],
  ])('refuses a completion turn whose captured trigger is %s', (_label, trigger) => {
    expect(() => createTriggerExecutionContext(completion(trigger))).toThrow('run_trigger_invalid');
  });

  it('refuses a completion turn that names the run that began its work but no event', () => {
    const req = completion({ subject: { kind: 'key', id: 'key-1' }, origin: began });
    Object.assign(req.body, { agentEvent: undefined });

    expect(() => createTriggerExecutionContext(req)).toThrow(/without an event/);
  });

  it('gives the delivery that resumes an actor suspended on a detached action the same', () => {
    const trigger = { subject: { kind: 'key', id: 'key-1' }, origin: began };
    const resumed = bound();
    Object.assign(resumed.body.agentEventDelivery, {
      event: { ...event({ type: 'internal', id: 'librechat-event-actor' }), type: 'resumed' },
      internalCompletion: { version: 1 },
      trigger,
    });
    const context = createTriggerExecutionContext(resumed);

    expect(context?.agentId).toBe('root-agent');
    expect(context?.source).toEqual({
      type: 'trigger',
      subject: trigger.subject,
      delivery: {
        key: 'trigger_def',
        event: { id: 'event-1', type: 'resumed', occurredAt: 1_000 },
      },
      origin: began,
      manual: false,
      resumed: false,
    });
    expect(getSourceKey(context)).toBe('key-1');
    Object.assign(resumed.body.agentEventDelivery, { trigger: { subject: { kind: 'user' } } });
    expect(() => createTriggerExecutionContext(resumed)).toThrow('run_trigger_invalid');
  });

  it('takes no subject from a kept trigger on a request the server did not make for itself', () => {
    const kept = { subject: { kind: 'key', id: 'key-9' }, origin: began };
    const marker = { version: 1, sourceId: 'subagent-completion', trigger: kept };
    // A new turn, whatever its source: a completion marker is not read on one.
    const started = fire({ type: 'internal', id: 'subagent-completion' });
    Object.assign(started.body, { agentCompletion: marker });
    // A bound continuation a key posted keeps that key, and gains no origin.
    const continued = bound();
    Object.assign(continued.body, { agentCompletion: marker });
    Object.assign(continued.body.agentEventDelivery, { trigger: kept });
    // A continuation from any other source outside the server, bound or not.
    const foreign = bound();
    Object.assign(foreign.body.agentEventDelivery, {
      event: event({ type: 'responses', id: 'response-1' }),
      trigger: kept,
    });
    const unboundForeign = unbound({ type: 'responses', id: 'response-1' }, 'response.done');
    Object.assign(unboundForeign.body, { agentCompletion: marker });
    const plain = { user, body: { ...completion(kept).body } };

    for (const req of [started, foreign, unboundForeign]) {
      const source = createTriggerExecutionContext(req)?.source;
      expect(source).toMatchObject({ type: 'trigger' });
      expect(source).not.toHaveProperty('subject');
      expect(source).not.toHaveProperty('origin');
    }
    expect(getSourceKey(createTriggerExecutionContext(continued))).toBe('key-1');
    expect(createTriggerExecutionContext(continued)?.source).not.toHaveProperty('origin');
    expect(createTriggerExecutionContext(plain)).toBeUndefined();
  });

  it('reads the event of the request it is, not one named beside it', () => {
    const req = fire();
    Object.assign(req.body, {
      agentEvent: { ...event({ type: 'remote_api_key', id: 'other' }), id: 'other-event' },
    });

    expect(getSourceKey(createTriggerExecutionContext(req))).toBe('key-1');
    expect(createTriggerExecutionContext(req)?.source).toMatchObject({
      delivery: { event: { id: 'event-1' } },
    });
  });

  it('runs an unbound continuation a key is named on for that key', () => {
    const req = unbound({ type: 'remote_api_key', id: 'key-1' }, 'review.submitted');

    expect(getSourceKey(createTriggerExecutionContext(req))).toBe('key-1');
  });

  it('has none for a request that is not a trigger, whatever its body says', () => {
    expect(createTriggerExecutionContext({ ...fire(), _isAgentTrigger: false })).toBeUndefined();
    expect(createTriggerExecutionContext({ user, body: fire().body })).toBeUndefined();
  });

  it('gives a delivery no key posted its delivery alone', () => {
    for (const source of [
      { type: 'internal', id: 'subagent-completion' },
      { type: 'responses', id: 'response-1' },
    ]) {
      const context = createTriggerExecutionContext(fire(source));
      expect(context?.source).toEqual({
        type: 'trigger',
        delivery: {
          key: 'trigger_abc',
          event: { id: 'event-1', type: 'review.submitted', occurredAt: 1_000 },
        },
        manual: false,
        resumed: false,
      });
      expect(getSourceKey(context)).toBeUndefined();
    }
  });

  it('has none for a trigger that names no event, as a host from before this sends', () => {
    expect(
      createTriggerExecutionContext({
        user,
        _isAgentTrigger: true,
        body: { agent_id: 'a', conversationId: 'conversation', clientRequestId: 'trigger_ghi' },
      }),
    ).toBeUndefined();
    const nameless = unbound({ type: 'internal', id: 'subagent-completion' }, '');
    expect(createTriggerExecutionContext(nameless)).toBeUndefined();
  });

  it('refuses a delivery that names a key as its source without identifying it', () => {
    for (const source of [{ type: 'remote_api_key' }, { type: 'remote_api_key', id: '  ' }])
      expect(() => createTriggerExecutionContext(fire(source))).toThrow(/API key/);
    const unnamed = fire();
    Object.assign(unnamed.body.agentTrigger.event, { id: undefined });
    expect(() => createTriggerExecutionContext(unnamed)).toThrow(/API key/);
  });

  describe('what the first message of the turn records', () => {
    const at = '1970-01-01T00:00:01.000Z';
    const record = (req: Parameters<typeof createTriggerExecutionContext>[0]) =>
      toMessageTrigger(createTriggerExecutionContext(req));

    it('names the occurrence and the schedule for a scheduled turn', () => {
      const req = scheduleFire();
      Object.assign(req.body, { clientRequestId: 'trigger_occurrence' });
      Object.assign(req.body.agentTrigger.event, { id: 'sched:schedule:1970' });

      expect(record(req)).toEqual({
        event: { type: 'schedule.occurrence', occurredAt: '1970-01-01T00:00:00.000Z' },
        subject: { kind: 'schedule', id: 'schedule' },
      });
    });

    it.each([
      ['a new conversation', fire],
      ['a bound continuation', bound],
    ])('names the event and the key for %s an API key posted to', (_label, request) => {
      expect(record(request())).toEqual({
        event: { type: 'review.submitted', occurredAt: at },
        subject: { kind: 'key', id: 'key-1' },
      });
    });

    it.each([
      ['a subagent wake-up', 'subagent-completion', 'subagent.completion'],
      ['a background tool wake-up', 'background-tool-completion', 'background-tool.completion'],
      ['a queued turn', 'agent-queued-turn', 'agent.queued-turn'],
    ])('names the event alone for %s in an interactive chat', (_label, id, type) => {
      expect(record(unbound({ type: 'internal', id }, type))).toEqual({
        event: { type, occurredAt: at },
      });
    });

    it('names the event that began the run on a turn that reports its work', () => {
      const trigger = { subject: { kind: 'key', id: 'key-1' }, origin: began };

      expect(record(completion(trigger, 'subagent-completion'))).toEqual({
        event: { type: 'background_tool.completed', occurredAt: at },
        subject: { kind: 'key', id: 'key-1' },
        origin: { event: { type: 'review.submitted', occurredAt: '1970-01-01T00:00:00.500Z' } },
      });
    });

    it('keeps no delivery key and no event id', () => {
      const trigger = { subject: { kind: 'schedule', id: 'schedule' }, origin: began };
      const stored = JSON.stringify(record(completion(trigger)));

      for (const hidden of ['trigger_ghi', 'trigger_abc', 'event-1', 'event-0', 'root-agent'])
        expect(stored).not.toContain(hidden);
    });

    it('records nothing for a turn a person sent, whatever its body says', () => {
      const typed = { ...fire(), _isAgentTrigger: false };
      const copied = { user, body: { trigger: { event: { type: 'subagent.completion' } } } };

      expect(record(typed)).toBeUndefined();
      expect(record(copied)).toBeUndefined();
      expect(toMessageTrigger(undefined)).toBeUndefined();
      expect(
        toMessageTrigger(
          createRemoteExecutionContext({
            principal: { userId: 'owner' },
            protocol: 'responses',
            background: true,
          }),
        ),
      ).toBeUndefined();
    });

    it('records nothing for a trigger that names no event, as a host from before this sends', () => {
      expect(record(scheduleFire())).toBeUndefined();
    });

    it('makes an event type an outside system named safe to show', () => {
      const named = (type: string) => {
        const req = fire();
        Object.assign(req.body.agentTrigger.event, { type });
        return record(req)?.event.type;
      };

      expect(named('x'.repeat(1_000))).toBe('x'.repeat(256));
      expect(named('review.\u202Esubmitted\u2066\n')).toBe('review. submitted');
      expect(named('\u202E\u2066')).toBeUndefined();
    });

    it('stamps a first message of the turn from what the route kept, and no other message', () => {
      const trigger = record(fire());
      const message = { messageId: 'first', text: 'hello', trigger: { event: { type: 'forged' } } };
      const typed = { messageId: 'typed', text: 'hello' };

      expect(stampMessageTrigger({ _messageTrigger: trigger }, message)).toEqual({
        ...message,
        trigger,
      });
      expect(stampMessageTrigger({}, typed)).toBe(typed);
      expect(stampMessageTrigger(undefined, typed)).toBe(typed);
      expect(stampMessageTrigger({ _messageTrigger: trigger }, null)).toBeNull();
    });

    it('records nothing for an event whose time is no date', () => {
      const late = fire();
      Object.assign(late.body.agentTrigger.event, { occurredAt: Number.MAX_SAFE_INTEGER });

      expect(record(late)).toBeUndefined();
    });
  });
});

describe('captureTrigger', () => {
  const delivery = {
    key: 'trigger_abc',
    event: { id: 'event-1', type: 'review.submitted', occurredAt: 1_000 },
  };
  const keyFire = {
    user,
    _isAgentTrigger: true,
    body: {
      agent_id: 'root-agent',
      clientRequestId: 'trigger_abc',
      agentTrigger: {
        version: 1,
        event: { ...delivery.event, source: { type: 'remote_api_key', id: 'key-1' } },
      },
    },
  };

  it('keeps the subject of a key run, its root agent and its delivery', () => {
    const captured = captureTrigger(createTriggerExecutionContext(keyFire));

    expect(captured).toEqual({
      subject: { kind: 'key', id: 'key-1' },
      origin: { agentId: 'root-agent', delivery },
    });
    expect(Object.isFrozen(captured)).toBe(true);
    expect(parseRunTrigger(JSON.parse(JSON.stringify(captured)))).toEqual(captured);
  });

  it('keeps the schedule of an occurrence and of its resumed run', () => {
    expect(captureTrigger(createTriggerExecutionContext(scheduleFire()))).toMatchObject({
      subject: { kind: 'schedule', id: 'schedule' },
      origin: { agentId: 'root-agent' },
    });
    expect(captureTrigger(restoreExecutionContext({ user }, savedJob))).toEqual({
      subject: { kind: 'schedule', id: 'schedule' },
      origin: { agentId: 'root-agent' },
    });
  });

  it("passes on the origin a turn was given, not the turn's own delivery", () => {
    const origin = { agentId: 'root-agent', delivery };
    const turn = createTriggerExecutionContext({
      user,
      _isAgentTrigger: true,
      body: {
        agent_id: 'handoff-agent',
        conversationId: 'conversation',
        clientRequestId: 'trigger_wake',
        agentEvent: {
          id: 'task-1',
          type: 'background_tool.completed',
          occurredAt: 2_000,
          source: { type: 'internal', id: 'background-tool-completion' },
        },
        agentCompletion: {
          version: 1,
          sourceId: 'background-tool-completion',
          trigger: { subject: { kind: 'key', id: 'key-1' }, origin },
        },
      },
    });

    expect(captureTrigger(turn)).toEqual({ subject: { kind: 'key', id: 'key-1' }, origin });
  });

  it('keeps where a run with no subject began, and no subject', () => {
    const turn = createTriggerExecutionContext({
      user,
      _isAgentTrigger: true,
      body: {
        agent_id: 'root-agent',
        conversationId: 'conversation',
        clientRequestId: 'trigger_queue',
        agentEvent: {
          id: 'turn-1',
          type: 'agent.queued-turn',
          occurredAt: 3_000,
          source: { type: 'internal', id: 'agent-queued-turn' },
        },
      },
    });

    expect(captureTrigger(turn)).toEqual({
      origin: {
        agentId: 'root-agent',
        delivery: {
          key: 'trigger_queue',
          event: { id: 'turn-1', type: 'agent.queued-turn', occurredAt: 3_000 },
        },
      },
    });
  });

  it('keeps nothing for a run no trigger started', () => {
    const remote = createRemoteExecutionContext({
      principal: { userId: 'owner' },
      agentId: 'root-agent',
      protocol: 'responses',
      background: true,
      keyId: 'key-1',
    });

    expect(captureTrigger(undefined)).toBeUndefined();
    expect(captureTrigger(remote)).toBeUndefined();
  });
});

describe('getSourceKey', () => {
  it('names the key of a run the remote API started, and none for a schedule or no run', () => {
    expect(
      getSourceKey(
        createRemoteExecutionContext({
          principal: { userId: 'owner' },
          protocol: 'responses',
          background: true,
          keyId: 'key-2',
        }),
      ),
    ).toBe('key-2');
    expect(getSourceKey(createScheduleExecutionContext(scheduleFire()))).toBeUndefined();
    expect(getSourceKey(undefined)).toBeUndefined();
  });
});

describe('parseRunTrigger', () => {
  const trigger = {
    subject: { kind: 'key', id: 'key-1' },
    delivery: {
      key: 'trigger_abc',
      event: { id: 'event-1', type: 'review.submitted', occurredAt: 1_000 },
    },
  };

  it('keeps the subject and delivery of a run source and nothing else', () => {
    const source = createTriggerExecutionContext({
      user,
      _isAgentTrigger: true,
      body: {
        agent_id: 'root-agent',
        clientRequestId: 'trigger_abc',
        agentTrigger: {
          version: 1,
          event: { ...trigger.delivery.event, source: { type: 'remote_api_key', id: 'key-1' } },
        },
      },
    })?.source;

    expect(parseRunTrigger(source)).toEqual(trigger);
    expect(Object.isFrozen(parseRunTrigger(source))).toBe(true);
  });

  it('reads back what a store serialized', () => {
    expect(parseRunTrigger(JSON.stringify(trigger), true)).toEqual(trigger);
    expect(parseRunTrigger(JSON.stringify({ delivery: trigger.delivery }), true)).toEqual({
      delivery: trigger.delivery,
    });
    expect(parseRunTrigger({ subject: trigger.subject })).toEqual({ subject: trigger.subject });
  });

  it('keeps the origin of a turn that reports earlier work', () => {
    const origin = { agentId: 'root-agent', delivery: trigger.delivery };

    expect(parseRunTrigger({ ...trigger, origin })).toEqual({ ...trigger, origin });
    expect(parseRunTrigger(JSON.stringify({ origin: { agentId: 'root-agent' } }), true)).toEqual({
      origin: { agentId: 'root-agent' },
    });
    expect(Object.isFrozen(parseRunTrigger({ origin })?.origin)).toBe(true);
  });

  it('saves nothing for a source no trigger started', () => {
    const remote = createRemoteExecutionContext({
      principal: { userId: 'owner' },
      protocol: 'responses',
      background: true,
      keyId: 'key-1',
    });

    expect(parseRunTrigger(remote.source)).toBeUndefined();
  });

  it.each([
    ['not an object', 'key-1'],
    ['unreadable', '{'],
    ['a subject of no known kind', JSON.stringify({ subject: { kind: 'user', id: 'owner' } })],
    ['a subject with no id', JSON.stringify({ subject: { kind: 'key', id: ' ' } })],
    ['a delivery with no event', JSON.stringify({ delivery: { key: 'trigger_abc' } })],
    [
      'a delivery whose event has no time',
      JSON.stringify({ delivery: { event: { id: 'event-1', type: 'review.submitted' } } }),
    ],
    ['an origin that is not an object', JSON.stringify({ origin: 'root-agent' })],
    ['an origin that names nothing', JSON.stringify({ origin: {} })],
    [
      'an origin whose agent has no name',
      JSON.stringify({ origin: { agentId: ' ', delivery: trigger.delivery } }),
    ],
    [
      'an origin whose delivery cannot be read',
      JSON.stringify({ origin: { agentId: 'root-agent', delivery: { event: { id: 'e' } } } }),
    ],
  ])('refuses a stored trigger that is %s', (_label, stored) => {
    expect(() => parseRunTrigger(stored, true)).toThrow('run_trigger_invalid');
  });
});
