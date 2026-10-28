import type { IUser } from '@librechat/data-schemas';
import type { ScheduledTokenContext } from './context';
import {
  bindUpstreamTokenProviderResolver,
  createScheduleUpstreamTokenProviderResolver,
} from './mcp';
import { createLazyOboUpstreamTokenProvider } from '../mcp/oauth/obo';
import { restoreScheduledTokenContext } from './context';

const user = { id: 'owner', tenantId: 'tenant' } as IUser;
const context: ScheduledTokenContext = {
  scheduleId: 'schedule',
  ownerId: 'owner',
  tenantId: 'tenant',
  agentId: 'root-agent',
  invocationMode: 'delegated',
};
const target = { mcpServer: 'warehouse', scopes: 'api://warehouse/.default' };

function request(manual = false) {
  return {
    user,
    _isAgentTrigger: true,
    body: {
      agent_id: 'root-agent',
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

it.each([false, true])('captures verified root identity for manual=%s', async (manual) => {
  const req = request(manual);
  const provider = jest.fn().mockResolvedValue({ access_token: 'token' });
  const resolve = jest.fn().mockResolvedValue(provider);
  const signal = new AbortController().signal;
  const bound = createScheduleUpstreamTokenProviderResolver(req, resolve, signal)!;
  req.body.agent_id = 'child-agent';
  req.body.agentTrigger.event.source.id = 'changed';
  await createLazyOboUpstreamTokenProvider(bound, signal, target)();
  expect(resolve).toHaveBeenCalledWith(user, { signal, context, target });
  expect(Object.isFrozen(resolve.mock.calls[0][1].context)).toBe(true);
});

it('ignores copied schedule metadata on an ordinary interactive request', () => {
  const resolve = jest.fn();
  expect(
    createScheduleUpstreamTokenProviderResolver({ ...request(), _isAgentTrigger: false }, resolve),
  ).toBeUndefined();
  expect(resolve).not.toHaveBeenCalled();
});

it('leaves context absent for legacy schedule classification without verified metadata', async () => {
  const resolve = jest.fn().mockResolvedValue(jest.fn());
  const bound = createScheduleUpstreamTokenProviderResolver(
    { ...request(), _isAgentTrigger: false, _isScheduledFire: true },
    resolve,
  )!;
  await bound();
  expect(resolve).toHaveBeenCalledWith(user, { signal: undefined });
});

it('shares lookup for sibling consumers and reconnects, but isolates server and scope changes', async () => {
  const resolve = jest.fn(async () => jest.fn(async () => ({ access_token: 'token' })));
  const bound = bindUpstreamTokenProviderResolver(user, resolve, undefined, context)!;
  const targets = [
    target,
    target,
    { ...target, mcpServer: 'second' },
    { ...target, scopes: 'read' },
  ];
  await Promise.all(
    targets.map((item) => createLazyOboUpstreamTokenProvider(bound, undefined, item)()),
  );
  expect(resolve).toHaveBeenCalledTimes(3);
  await createLazyOboUpstreamTokenProvider(bound, undefined, target)({ forceRefresh: true });
  expect(resolve).toHaveBeenCalledTimes(3);
});

it('isolates provider caches between schedules and retries only the failed target', async () => {
  const resolve = jest
    .fn()
    .mockRejectedValueOnce(new Error('temporary'))
    .mockResolvedValue(jest.fn());
  const first = bindUpstreamTokenProviderResolver(user, resolve, undefined, context)!;
  const second = bindUpstreamTokenProviderResolver(user, resolve, undefined, {
    ...context,
    scheduleId: 'second',
  })!;
  await expect(first({ target })).rejects.toThrow('temporary');
  await second({ target });
  await first({ target });
  await first({ target });
  expect(resolve).toHaveBeenCalledTimes(3);
  expect(resolve.mock.calls[1][1].context.scheduleId).toBe('second');
  expect(resolve.mock.calls[2][1].context.scheduleId).toBe('schedule');
});

it('restores a paused run from job identity without trusting resume body fields', async () => {
  const req = {
    user,
    _isScheduledFire: true,
    body: { scheduleId: 'spoofed', agent_id: 'spoofed' },
  };
  const restored = restoreScheduledTokenContext(req, {
    userId: 'owner',
    tenantId: 'tenant',
    scheduleId: 'schedule',
    agent_id: 'root-agent',
  });
  const resolve = jest.fn().mockResolvedValue(jest.fn());
  await createScheduleUpstreamTokenProviderResolver(req, resolve, undefined, restored)!({ target });
  expect(resolve).toHaveBeenCalledWith(user, { signal: undefined, context, target });
  expect(JSON.stringify(req)).not.toContain('root-agent');
});

it.each([{ userId: 'different' }, { tenantId: 'different' }])(
  'rejects invalid restored identity %j',
  (override) => {
    expect(() =>
      restoreScheduledTokenContext(
        { user },
        {
          userId: 'owner',
          tenantId: 'tenant',
          scheduleId: 'schedule',
          agent_id: 'root-agent',
          ...override,
        },
      ),
    ).toThrow('Scheduled job identity');
  },
);

it.each([{ agent_id: undefined }, { tenantId: undefined }])(
  'leaves legacy job context absent for %j',
  async (override) => {
    const req = { user, _isScheduledFire: true };
    const restored = restoreScheduledTokenContext(req, {
      userId: 'owner',
      tenantId: 'tenant',
      scheduleId: 'schedule',
      agent_id: 'root-agent',
      ...override,
    });
    const resolve = jest.fn().mockResolvedValue(jest.fn());
    await createScheduleUpstreamTokenProviderResolver(req, resolve, undefined, restored)!();
    expect(resolve).toHaveBeenCalledWith(user, { signal: undefined });
  },
);
