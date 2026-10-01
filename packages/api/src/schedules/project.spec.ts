import type { ISchedule, IScheduleRun } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ScheduleEngineDeps, ScheduleLimits, ScheduleUserContext } from './types';
import type { SchedulesHandlersDeps } from './handlers';
import type { FireableSchedule } from './types';
import type { ServerRequest } from '~/types';
import { createSchedulesHandlers, computeCreateDigest, toWireSchedule } from './handlers';
import { withCapacitySlot } from './capacity';
import { fireSchedule } from './fire';

const OWNER: ScheduleUserContext = { id: 'user-1', tenantId: 't1', role: 'USER' };

const BASE_LIMITS: ScheduleLimits = {
  enabled: true,
  maxPerUser: 10,
  minIntervalMinutes: 60,
  autoDisableAfterFailures: 5,
  admissionConcurrency: 20,
  fireConcurrency: 5,
  mcpPreflightConcurrency: 3,
  mcpPreflightTimeoutMs: 300_000,
  requireProject: false,
};

function makeSchedule(overrides: Partial<FireableSchedule> = {}): FireableSchedule {
  return {
    id: 'sched-1',
    user: 'user-1' as never,
    tenantId: 't1',
    name: 'Digest',
    prompt: 'Summarize',
    agent_id: 'agent-1',
    cadence: { frequency: 'daily', hour: 8, minute: 0 },
    timezone: 'America/New_York',
    target: 'new',
    enabled: true,
    claimToken: 'ct-1',
    leaseBy: 'inst-1',
    runCount: 0,
    failureCount: 0,
    balanceSkipCount: 0,
    ...overrides,
  } as FireableSchedule;
}

/** Minimal run store: enough for the reservation the fire path makes once its
 *  prechecks pass, so a skipped fire is distinguishable from a dispatched one. */
function makeMethods() {
  const disabled: string[] = [];
  const reservations: Array<Partial<IScheduleRun>> = [];
  const methods = {
    releaseLease: jest.fn(async () => true),
    releaseLeaseByHolder: jest.fn(async () => undefined),
    advanceSchedule: jest.fn(async () => true),
    disableSchedule: jest.fn(async (_id: string, reason: string) => {
      disabled.push(reason);
    }),
    revalidateClaim: jest.fn(async () => true),
    reserveStartedRun: jest.fn(async (data: Partial<IScheduleRun>) => {
      reservations.push(data);
      return { run: { scheduleId: 'sched-1' } };
    }),
    getCapacityOccupancy: jest.fn(async () => ({ takenSlots: [] as number[], unslotted: 0 })),
    deleteScheduleRun: jest.fn(async () => undefined),
    setRunFireDetails: jest.fn(async () => undefined),
    persistResolvedProject: jest.fn(async () => undefined),
    countActiveRuns: jest.fn(async () => 0),
    recordSkippedRun: jest.fn(async () => undefined),
  };
  return { methods, disabled, reservations };
}

function makeEngineDeps(
  methods: ReturnType<typeof makeMethods>['methods'],
  over: Partial<ScheduleEngineDeps> = {},
): ScheduleEngineDeps {
  return {
    methods: methods as unknown as ScheduleEngineDeps['methods'],
    getLimits: async () => BASE_LIMITS,
    getUserContext: async () => OWNER,
    isOutOfBalance: async () => false,
    preflightMCP: jest.fn().mockResolvedValue([]),
    agentAccess: async () => 'ok',
    projectAccess: async () => 'ok',
    hasScheduleAccess: async () => true,
    resolveFiles: async () => [],
    enqueueTrigger: jest.fn(async () => undefined),
    getTriggerDelivery: async () => null,
    runInTenantContext: (_user, fn) => fn(),
    getJobStatus: async () => null,
    abortScheduledJob: async () => undefined,
    clearReconciledJob: async () => undefined,
    isOwnerDeleting: async () => false,
    isGloballyDisabled: async () => false,
    countActiveRunsGlobal: async () => 0,
    withGlobalCapacitySlot: (cap: number, claim: (slot: number) => Promise<unknown>) =>
      withCapacitySlot(
        cap,
        () => methods.getCapacityOccupancy(),
        claim as Parameters<typeof withCapacitySlot>[2],
      ),
    ...over,
  } as ScheduleEngineDeps;
}

const dueAt = () => new Date(Date.now() - 60_000);

describe('fire-time project scope', () => {
  it('carries the stored project into the trigger envelope', async () => {
    const { methods } = makeMethods();
    const enqueueTrigger = jest.fn<
      ReturnType<ScheduleEngineDeps['enqueueTrigger']>,
      Parameters<ScheduleEngineDeps['enqueueTrigger']>
    >(async () => undefined);

    const result = await fireSchedule(
      makeEngineDeps(methods, { enqueueTrigger }),
      makeSchedule({ chatProjectId: 'proj-1' }),
      BASE_LIMITS,
      dueAt(),
    );

    expect(result.fired).toBe(true);
    expect(enqueueTrigger.mock.calls[0][0]).toMatchObject({
      run: { chatProjectId: 'proj-1' },
    });
  });

  /** The pin is a policy about where scheduled runs land. A row written before the
   *  pin must follow it, not keep its own destination until someone edits it. */
  it('lets an operator pin override the stored project', async () => {
    const { methods } = makeMethods();
    const enqueueTrigger = jest.fn<
      ReturnType<ScheduleEngineDeps['enqueueTrigger']>,
      Parameters<ScheduleEngineDeps['enqueueTrigger']>
    >(async () => undefined);
    const pinned = { ...BASE_LIMITS, requireProject: true, projectId: 'proj-pinned' };

    await fireSchedule(
      makeEngineDeps(methods, { enqueueTrigger, getLimits: async () => pinned }),
      makeSchedule({ chatProjectId: 'proj-old' }),
      BASE_LIMITS,
      dueAt(),
    );

    expect(enqueueTrigger.mock.calls[0][0]).toMatchObject({
      run: { chatProjectId: 'proj-pinned' },
    });
  });

  /** Raising the requirement must STOP schedules that predate it — filing their runs
   *  loose would quietly ignore the policy the operator just set. */
  it('disables an unscoped schedule once a project becomes required', async () => {
    const { methods, disabled } = makeMethods();
    const enqueueTrigger = jest.fn(async () => undefined);
    const required = { ...BASE_LIMITS, requireProject: true };

    const result = await fireSchedule(
      makeEngineDeps(methods, { enqueueTrigger, getLimits: async () => required }),
      makeSchedule(),
      BASE_LIMITS,
      dueAt(),
    );

    expect(result).toMatchObject({ fired: false, skipped: 'project_required' });
    expect(disabled).toEqual(['project_required']);
    expect(enqueueTrigger).not.toHaveBeenCalled();
    // Every path advances, so the schedule cannot wedge on the same occurrence.
    expect(methods.advanceSchedule).toHaveBeenCalledTimes(1);
  });

  /** Mirrors agent_deleted: stop at the boundary rather than dispatching a billed run
   *  whose conversation the conversation save would file nowhere. */
  it('disables when the destination project is gone', async () => {
    const { methods, disabled } = makeMethods();
    const enqueueTrigger = jest.fn(async () => undefined);

    const result = await fireSchedule(
      makeEngineDeps(methods, { enqueueTrigger, projectAccess: async () => 'missing' }),
      makeSchedule({ chatProjectId: 'proj-gone' }),
      BASE_LIMITS,
      dueAt(),
    );

    expect(result).toMatchObject({ fired: false, skipped: 'project_deleted' });
    expect(disabled).toEqual(['project_deleted']);
    expect(enqueueTrigger).not.toHaveBeenCalled();
  });

  /**
   * The row must not keep claiming project A once a pin has been sending this
   * schedule's conversations to B: every later re-validation — the resume boundary
   * above all — would then check a project the conversation was never filed under.
   */
  it('converges the stored project on the destination it actually resolved', async () => {
    const { methods } = makeMethods();
    const pinned = { ...BASE_LIMITS, requireProject: true, projectId: 'proj-pinned' };

    await fireSchedule(
      makeEngineDeps(methods, { getLimits: async () => pinned }),
      makeSchedule({ chatProjectId: 'proj-old' }),
      BASE_LIMITS,
      dueAt(),
    );

    // Claim-token fenced like every other worker-side write.
    expect(methods.persistResolvedProject).toHaveBeenCalledWith('sched-1', 'proj-pinned', 'ct-1');
  });

  it('leaves the row alone when the resolved destination already matches', async () => {
    const { methods } = makeMethods();

    await fireSchedule(
      makeEngineDeps(methods),
      makeSchedule({ chatProjectId: 'proj-1' }),
      BASE_LIMITS,
      dueAt(),
    );

    expect(methods.persistResolvedProject).not.toHaveBeenCalled();
  });

  /** An unusable pin is refused, and must never be written to the row on the way out. */
  it('does not converge a destination that failed validation', async () => {
    const { methods } = makeMethods();

    await fireSchedule(
      makeEngineDeps(methods, { projectAccess: async () => 'missing' }),
      makeSchedule({ chatProjectId: 'proj-gone' }),
      BASE_LIMITS,
      dueAt(),
    );

    expect(methods.persistResolvedProject).not.toHaveBeenCalled();
  });

  /** A failed convergence costs accuracy on a later recheck, never this run. */
  it('fires anyway when the convergence write fails', async () => {
    const { methods } = makeMethods();
    methods.persistResolvedProject = jest.fn(async () => {
      throw new Error('mongo down');
    });
    const enqueueTrigger = jest.fn(async () => undefined);
    const pinned = { ...BASE_LIMITS, requireProject: true, projectId: 'proj-pinned' };

    const result = await fireSchedule(
      makeEngineDeps(methods, { enqueueTrigger, getLimits: async () => pinned }),
      makeSchedule({ chatProjectId: 'proj-old' }),
      BASE_LIMITS,
      dueAt(),
    );

    expect(result.fired).toBe(true);
    expect(enqueueTrigger).toHaveBeenCalledTimes(1);
  });

  /** The schedule-level value can move on while a run is paused, so the RESERVATION
   *  is what a resume re-validates against. */
  it('records the destination on the occurrence it reserves', async () => {
    const { methods, reservations } = makeMethods();
    const pinned = { ...BASE_LIMITS, requireProject: true, projectId: 'proj-pinned' };

    await fireSchedule(
      makeEngineDeps(methods, { getLimits: async () => pinned }),
      makeSchedule({ chatProjectId: 'proj-old' }),
      BASE_LIMITS,
      dueAt(),
    );

    expect(reservations[0].chatProjectId).toBe('proj-pinned');
  });

  /** Recorded as an explicit null, never omitted: a later reader must be able to tell
   *  "this run had no project" from "this row predates the field". */
  it('records an unscoped occurrence as an explicit null', async () => {
    const { methods, reservations } = makeMethods();

    await fireSchedule(makeEngineDeps(methods), makeSchedule(), BASE_LIMITS, dueAt());

    expect(reservations[0]).toHaveProperty('chatProjectId', null);
  });

  it('never consults project access for an unscoped schedule', async () => {
    const { methods } = makeMethods();
    const projectAccess = jest.fn(async () => 'ok' as const);

    await fireSchedule(
      makeEngineDeps(methods, { projectAccess }),
      makeSchedule(),
      BASE_LIMITS,
      dueAt(),
    );

    expect(projectAccess).not.toHaveBeenCalled();
  });
});

function makeRes() {
  const captured: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
  };
  return { res: res as unknown as Response, captured };
}

const CREATE_BODY = {
  name: 'Digest',
  prompt: 'Summarize',
  agent_id: 'agent-1',
  cadence: { frequency: 'daily' as const, hour: 8, minute: 0 },
  timezone: 'America/New_York',
  clientRequestId: 'intent-1',
};

function makeReq(body: Record<string, unknown>, params: Record<string, string> = {}) {
  return {
    body,
    params,
    user: { id: 'user-1', tenantId: 't1', role: 'USER' },
  } as unknown as ServerRequest;
}

function makeHandlerDeps(
  limits: Partial<ScheduleLimits>,
  over: Partial<SchedulesHandlersDeps> = {},
) {
  const created: Array<Partial<ISchedule>> = [];
  const updates: Array<{ update: Partial<ISchedule>; unset?: Record<string, 1> }> = [];
  const methods = {
    countSchedulesByUser: jest.fn(async () => 0),
    createScheduleWithSlot: jest.fn(async (data: Partial<ISchedule>) => {
      created.push(data);
      return { ...data, configRevision: 0 } as ISchedule;
    }),
    getScheduleByClientRequestId: jest.fn(async () => null),
    // Reads back what this attempt inserted: creation arms in a SECOND write and then
    // re-reads, so a null here would send every create down the "row is gone" 410.
    getScheduleById: jest.fn(async () => (created[0] ?? null) as ISchedule | null),
    updateScheduleById: jest.fn(
      async (_id: string, _user: string, update: Partial<ISchedule>, unset?: Record<string, 1>) => {
        updates.push({ update, unset });
        return { id: 'sched-1', ...update } as ISchedule;
      },
    ),
    armSchedule: jest.fn(async () => true),
    getDeletingScheduleIds: jest.fn(async () => []),
  };
  const deps = {
    methods: methods as unknown as SchedulesHandlersDeps['methods'],
    getLimits: async () => ({ ...BASE_LIMITS, ...limits }),
    preflightMCP: jest.fn().mockResolvedValue([]),
    canViewAgent: async () => true,
    canUseProject: async () => true,
    filterOwnedFileIds: async (ids: string[]) => ids,
    markFilesUsed: async () => undefined,
    fireNow: async () => null,
    deleteSchedule: async () => 'deleted',
    isUserDeleting: async () => false,
    ...over,
  } as unknown as SchedulesHandlersDeps;
  return { deps, methods, created, updates };
}

describe('write-time project scope', () => {
  it('refuses a project the requester does not own', async () => {
    const { deps, methods } = makeHandlerDeps({}, { canUseProject: async () => false });
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).createSchedule(
      makeReq({ ...CREATE_BODY, chatProjectId: 'someone-elses' }),
      res,
    );

    expect(captured.status).toBe(400);
    expect(methods.createScheduleWithSlot).not.toHaveBeenCalled();
  });

  it('refuses an unscoped create when the deployment requires a project', async () => {
    const { deps, methods } = makeHandlerDeps({ requireProject: true });
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).createSchedule(makeReq({ ...CREATE_BODY }), res);

    expect(captured.status).toBe(400);
    expect(methods.createScheduleWithSlot).not.toHaveBeenCalled();
  });

  /** The client sends nothing under a pin; the row still records the destination so
   *  its projection and its runs agree about where they land. */
  it('stores the pinned project even when the payload omits it', async () => {
    const { deps, created } = makeHandlerDeps({ requireProject: true, projectId: 'proj-pinned' });
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).createSchedule(makeReq({ ...CREATE_BODY }), res);

    expect(captured.status).toBe(201);
    expect(created[0].chatProjectId).toBe('proj-pinned');
  });

  /** Silently rewriting a named destination would hide a real disagreement about
   *  where the schedule's runs go. */
  /** `null` is the payload contract's CLEAR, not an omission. Resolving it to the pin
   *  would answer 201 for the opposite of what was asked. */
  it('refuses an explicit clear when a project is pinned', async () => {
    const { deps, methods } = makeHandlerDeps({ projectId: 'proj-pinned' });
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).createSchedule(
      makeReq({ ...CREATE_BODY, chatProjectId: null }),
      res,
    );

    expect(captured.status).toBe(400);
    expect(methods.createScheduleWithSlot).not.toHaveBeenCalled();
  });

  /**
   * The idempotency key exists so a create whose response was lost can be recovered by
   * an identical retry. Policy that changed in between must not turn that recovery into
   * a 400 — the client would rotate its key and create a DUPLICATE schedule, the exact
   * failure the key prevents.
   */
  it('recovers a committed create by retry even after the policy tightened', async () => {
    const { deps, methods } = makeHandlerDeps(
      { requireProject: true, projectId: 'proj-pinned' },
      { canUseProject: async () => false },
    );
    const original = {
      id: 'sched-1',
      user: 'user-1',
      name: CREATE_BODY.name,
      prompt: CREATE_BODY.prompt,
      agent_id: CREATE_BODY.agent_id,
      timezone: CREATE_BODY.timezone,
      target: 'new',
      enabled: true,
      cadence: CREATE_BODY.cadence,
      configRevision: 0,
      nextRunAt: new Date('2026-09-01T12:00:00Z'),
      clientRequestDigest: computeCreateDigest({
        ...CREATE_BODY,
        target: 'new',
        enabled: true,
      } as never),
    } as unknown as ISchedule;
    (methods.getScheduleByClientRequestId as jest.Mock).mockResolvedValue(original);
    (methods.getScheduleById as jest.Mock).mockResolvedValue(original);
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).createSchedule(makeReq({ ...CREATE_BODY }), res);

    expect(captured.status).toBe(201);
    expect(methods.createScheduleWithSlot).not.toHaveBeenCalled();
  });

  it('refuses a create that names a project other than the pin', async () => {
    const { deps, methods } = makeHandlerDeps({ projectId: 'proj-pinned' });
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).createSchedule(
      makeReq({ ...CREATE_BODY, chatProjectId: 'proj-other' }),
      res,
    );

    expect(captured.status).toBe(400);
    expect(methods.createScheduleWithSlot).not.toHaveBeenCalled();
  });

  const storedSchedule = (over: Partial<ISchedule> = {}): ISchedule =>
    ({
      id: 'sched-1',
      user: 'user-1',
      name: 'Digest',
      prompt: 'Summarize',
      agent_id: 'agent-1',
      cadence: { frequency: 'daily', hour: 8, minute: 0 },
      timezone: 'America/New_York',
      target: 'new',
      enabled: true,
      configRevision: 3,
      nextRunAt: new Date('2026-09-01T12:00:00Z'),
      runCount: 0,
      failureCount: 0,
      balanceSkipCount: 0,
      ...over,
    }) as unknown as ISchedule;

  it('clears the scope only on an explicit null', async () => {
    const { deps, methods, updates } = makeHandlerDeps({});
    (methods.getScheduleById as jest.Mock).mockResolvedValue(
      storedSchedule({ chatProjectId: 'proj-1' }),
    );
    const { res } = makeRes();

    await createSchedulesHandlers(deps).updateSchedule(
      makeReq({ chatProjectId: null }, { id: 'sched-1' }),
      res,
    );

    expect(updates[0].unset).toMatchObject({ chatProjectId: 1 });
    expect(updates[0].update).not.toHaveProperty('chatProjectId');
  });

  /** A rename must not drag the stored destination along as an edit, but it also must
   *  not drop it. */
  it('leaves an untouched scope intact on an unrelated edit', async () => {
    const { deps, methods, updates } = makeHandlerDeps({});
    (methods.getScheduleById as jest.Mock).mockResolvedValue(
      storedSchedule({ chatProjectId: 'proj-1' }),
    );
    const { res } = makeRes();

    await createSchedulesHandlers(deps).updateSchedule(
      makeReq({ name: 'Renamed' }, { id: 'sched-1' }),
      res,
    );

    expect(updates[0].unset).toBeUndefined();
    expect(updates[0].update.chatProjectId).toBe('proj-1');
  });

  /** The requirement is checked against the EFFECTIVE state, so a schedule that
   *  already has a project is editable without resending it. */
  it('accepts an unrelated edit under requireProject when a project is stored', async () => {
    const { deps, methods } = makeHandlerDeps({ requireProject: true });
    (methods.getScheduleById as jest.Mock).mockResolvedValue(
      storedSchedule({ chatProjectId: 'proj-1' }),
    );
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).updateSchedule(
      makeReq({ name: 'Renamed' }, { id: 'sched-1' }),
      res,
    );

    expect(captured.status).toBeUndefined();
    expect(methods.updateScheduleById).toHaveBeenCalled();
  });

  it('refuses an edit that leaves an unscoped schedule enabled under requireProject', async () => {
    const { deps, methods } = makeHandlerDeps({ requireProject: true });
    (methods.getScheduleById as jest.Mock).mockResolvedValue(storedSchedule());
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).updateSchedule(
      makeReq({ name: 'Renamed' }, { id: 'sched-1' }),
      res,
    );

    expect(captured.status).toBe(400);
    expect(methods.updateScheduleById).not.toHaveBeenCalled();
  });

  /** Otherwise a schedule auto-disabled for project_required could never be turned
   *  off or tidied up — the requirement would trap it. */
  it('still allows DISABLING an unscoped schedule under requireProject', async () => {
    const { deps, methods } = makeHandlerDeps({ requireProject: true });
    (methods.getScheduleById as jest.Mock).mockResolvedValue(storedSchedule());
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).updateSchedule(
      makeReq({ enabled: false }, { id: 'sched-1' }),
      res,
    );

    expect(captured.status).toBeUndefined();
    expect(methods.updateScheduleById).toHaveBeenCalled();
  });

  /** An omitted field and an explicit `null` are different INTENTS, so they must not
   *  share a digest — otherwise a key reused with a clear is answered 201 describing
   *  the pinned row it did not ask for. */
  it('digests an explicit clear differently from an omitted field', () => {
    const omitted = computeCreateDigest({ ...CREATE_BODY, target: 'new', enabled: true } as never);
    const cleared = computeCreateDigest({
      ...CREATE_BODY,
      target: 'new',
      enabled: true,
      chatProjectId: null,
    } as never);
    expect(cleared).not.toBe(omitted);
  });

  /** ...while an omitted field still digests exactly as it did before project scope
   *  existed, so a create in flight across the upgrade still matches its own row. */
  it('keeps the omitted-field digest stable against a pre-scope payload', () => {
    const withKey = computeCreateDigest({
      ...CREATE_BODY,
      target: 'new',
      enabled: true,
      chatProjectId: undefined,
    } as never);
    const withoutKey = computeCreateDigest({
      ...CREATE_BODY,
      target: 'new',
      enabled: true,
    } as never);
    expect(withKey).toBe(withoutKey);
  });

  /** A pin disagreement is refused whether the edit assigns a different project or
   *  clears the scope — only the REQUIREMENT is waived for a disabling edit. */
  it('refuses an explicit clear under a pin even while disabling', async () => {
    const { deps, methods } = makeHandlerDeps({ projectId: 'proj-pinned' });
    (methods.getScheduleById as jest.Mock).mockResolvedValue(
      storedSchedule({ chatProjectId: 'proj-pinned' }),
    );
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).updateSchedule(
      makeReq({ enabled: false, chatProjectId: null }, { id: 'sched-1' }),
      res,
    );

    expect(captured.status).toBe(400);
    expect(methods.updateScheduleById).not.toHaveBeenCalled();
  });

  /** The requirement, unlike the pin, IS waived so a stopped row stays tidy-able. */
  it('allows clearing the scope while disabling when only a requirement is set', async () => {
    const { deps, methods, updates } = makeHandlerDeps({ requireProject: true });
    (methods.getScheduleById as jest.Mock).mockResolvedValue(
      storedSchedule({ chatProjectId: 'proj-1' }),
    );
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).updateSchedule(
      makeReq({ enabled: false, chatProjectId: null }, { id: 'sched-1' }),
      res,
    );

    expect(captured.status).toBeUndefined();
    expect(updates[0].unset).toMatchObject({ chatProjectId: 1 });
  });

  /** Turning a schedule off is not a decision about its destination. */
  it('keeps the stored project when a schedule is disabled', async () => {
    const { deps, methods, updates } = makeHandlerDeps({});
    (methods.getScheduleById as jest.Mock).mockResolvedValue(
      storedSchedule({ chatProjectId: 'proj-1' }),
    );
    const { res } = makeRes();

    await createSchedulesHandlers(deps).updateSchedule(
      makeReq({ enabled: false }, { id: 'sched-1' }),
      res,
    );

    expect(updates[0].unset).toBeUndefined();
    expect(updates[0].update).not.toHaveProperty('chatProjectId');
  });
});

describe('wire projection', () => {
  const row = { id: 'sched-1', chatProjectId: 'proj-stored' } as unknown as ISchedule;

  it('reports the pin rather than the stored id', () => {
    expect(toWireSchedule(row, { projectId: 'proj-pinned' }).chatProjectId).toBe('proj-pinned');
  });

  it('reports the stored id when nothing is pinned', () => {
    expect(toWireSchedule(row, {}).chatProjectId).toBe('proj-stored');
  });
});
