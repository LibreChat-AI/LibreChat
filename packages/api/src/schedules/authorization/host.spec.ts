import type { AppConfig, IUser } from '@librechat/data-schemas';
import { buildScheduledApprovalAdmissionHooks } from './execution';
import { createScheduledPauseCheck } from './host';

describe('createScheduledPauseCheck', () => {
  const user = { id: 'owner', tenantId: 'tenant', role: 'USER' } as IUser;
  function check(
    over: {
      shared?: boolean;
      checkpointer?: unknown;
      toolApproval?: { enabled?: boolean };
    } = {},
  ) {
    const getCheckpointer = jest.fn(async () => ('checkpointer' in over ? over.checkpointer : {}));
    const getAppConfig = jest.fn(
      async () =>
        ({
          endpoints: {
            agents: { toolApproval: over.toolApproval, checkpointer: { type: 'mongo' } },
          },
        }) as unknown as AppConfig,
    );
    const canPause = createScheduledPauseCheck({
      isSharedStore: () => over.shared !== false,
      getCheckpointer,
      getAppConfig,
    });
    return { canPause, getCheckpointer, getAppConfig };
  }

  it('says yes with a shared store, a durable checkpointer and approval not turned off', async () => {
    const { canPause, getCheckpointer, getAppConfig } = check();
    expect(await canPause(user)).toBe(true);
    expect(getCheckpointer).toHaveBeenCalledWith({ type: 'mongo' });
    expect(getAppConfig).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'owner', tenantId: 'tenant', role: 'USER' }),
    );
    expect(await check({ toolApproval: { enabled: true } }).canPause(user)).toBe(true);
  });

  it('says no without a shared generation store, and reads nothing else', async () => {
    const { canPause, getAppConfig } = check({ shared: false });
    expect(await canPause(user)).toBe(false);
    expect(getAppConfig).not.toHaveBeenCalled();
  });

  it('says no where the administrator turned approval off', async () => {
    expect(await check({ toolApproval: { enabled: false } }).canPause(user)).toBe(false);
  });

  it('says no without a durable checkpointer', async () => {
    expect(await check({ checkpointer: undefined }).canPause(user)).toBe(false);
  });
});

describe('buildScheduledApprovalAdmissionHooks', () => {
  it('announces a possible pause only for a grant that asks', async () => {
    expect(buildScheduledApprovalAdmissionHooks()).toEqual([]);
    expect(buildScheduledApprovalAdmissionHooks({ mayAsk: false })).toEqual([]);
    const [entry, ...rest] = buildScheduledApprovalAdmissionHooks({ mayAsk: true });
    expect(rest).toEqual([]);
    // No matcher: admission treats every tool as one that may ask. It decides nothing itself.
    expect(entry.matcher).toBeUndefined();
    expect(
      await entry.hook({} as Parameters<typeof entry.hook>[0], new AbortController().signal),
    ).toEqual({});
  });
});
