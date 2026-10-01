import { createHash } from 'node:crypto';
import type { ISchedule, IScheduleRun } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { SchedulesHandlersDeps } from './handlers';
import type { ServerRequest } from '~/types';
import { createSchedulesHandlers, toWireSchedule, computeCreateDigest } from './handlers';
import { ScheduleMCPError } from './mcp';

/** A lean schedule doc carrying both public fields and internal bookkeeping. */
function fullScheduleDoc(overrides: Partial<ISchedule> = {}): ISchedule {
  return {
    _id: 'mongo-id',
    __v: 0,
    id: 'sched-1',
    user: 'user-1',
    tenantId: 't1',
    name: 'Digest',
    prompt: 'Summarize',
    agent_id: 'agent-1',
    cadence: { frequency: 'daily', hour: 8, minute: 0 },
    timezone: 'America/New_York',
    target: 'new',
    file_ids: ['file-1'],
    enabled: true,
    disabledReason: undefined,
    nextRunAt: new Date('2026-07-21T12:00:00Z'),
    lastRun: { conversationId: 'c1', status: 'success', firedAt: new Date() },
    runCount: 3,
    failureCount: 0,
    // Internal bookkeeping that must NEVER reach the browser.
    claimToken: 'ct-secret',
    leaseUntil: new Date(),
    leaseBy: 'inst-1',
    slot: 2,
    deleting: false,
    countedFor: [new Date()],
    balanceSkipCount: 1,
    bookkept: true,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-10T00:00:00Z'),
    ...overrides,
  } as unknown as ISchedule;
}

describe('toWireSchedule', () => {
  const INTERNAL_FIELDS = [
    '_id',
    '__v',
    'tenantId',
    'claimToken',
    'leaseUntil',
    'leaseBy',
    'slot',
    'deleting',
    'countedFor',
    'balanceSkipCount',
    'bookkept',
  ];

  it('emits exactly the public TSchedule fields', () => {
    const wire = toWireSchedule(fullScheduleDoc());
    expect(Object.keys(wire).sort()).toEqual(
      [
        'agent_id',
        'cadence',
        'chatProjectId',
        // Public so the edit dialog can fence its PATCH on the revision it opened
        // with (updateSchedulePayloadSchema.expectedConfigRevision).
        'configRevision',
        'createdAt',
        'disabledReason',
        'enabled',
        'failureCount',
        'file_ids',
        'id',
        'lastRun',
        'name',
        'nextRunAt',
        'prompt',
        'runCount',
        'target',
        'timezone',
        'updatedAt',
        'user',
      ].sort(),
    );
  });

  it('leaks no internal bookkeeping field', () => {
    const wire = toWireSchedule(fullScheduleDoc()) as Record<string, unknown>;
    for (const field of INTERNAL_FIELDS) {
      expect(wire).not.toHaveProperty(field);
    }
  });

  it('preserves the public field values', () => {
    const wire = toWireSchedule(fullScheduleDoc());
    expect(wire.id).toBe('sched-1');
    expect(wire.name).toBe('Digest');
    expect(wire.runCount).toBe(3);
    expect(wire.cadence).toEqual({ frequency: 'daily', hour: 8, minute: 0 });
  });
});

/** Minimal Express double capturing the status/body the handler settled on. */
function makeRes() {
  const captured: { status?: number; body?: unknown; headers: Record<string, string> } = {
    headers: {},
  };
  const listeners = new Map<string, () => void>();
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(payload: unknown) {
      captured.body = payload;
      return this;
    },
    set(name: string, value: string) {
      captured.headers[name] = value;
      return this;
    },
    once(event: string, listener: () => void) {
      listeners.set(event, listener);
      return this;
    },
    off(event: string, listener: () => void) {
      if (listeners.get(event) === listener) listeners.delete(event);
      return this;
    },
    emit(event: string) {
      const listener = listeners.get(event);
      listeners.delete(event);
      listener?.();
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

function makeCreateReq(): ServerRequest {
  return {
    body: { ...CREATE_BODY },
    user: { id: 'user-1', tenantId: 't1', role: 'USER' },
  } as unknown as ServerRequest;
}

/** The digest a genuine retry of CREATE_BODY carries (zod defaults applied). */
function createBodyDigest(): string {
  return computeCreateDigest({ ...CREATE_BODY, target: 'new', enabled: true });
}

function makeCreateDeps(over: Partial<SchedulesHandlersDeps> = {}): SchedulesHandlersDeps {
  const methods = {
    countSchedulesByUser: jest.fn(async () => 0),
    createScheduleWithSlot: jest.fn(async (data: Partial<ISchedule>) => data as ISchedule),
    getScheduleByClientRequestId: jest.fn(async () => null),
    getScheduleById: jest.fn(async () => null),
    deleteScheduleById: jest.fn(async () => true),
    deleteUnarmedSchedule: jest.fn(async () => 'deleted'),
    markScheduleDeleting: jest.fn(async () => ({ id: 'sched-1' }) as ISchedule),
    updateScheduleById: jest.fn(async () => ({ id: 'sched-1' }) as ISchedule),
    armSchedule: jest.fn(async () => undefined),
    getActiveRunsForUser: jest.fn(async () => []),
    getActiveRunsForSchedule: jest.fn(async () => []),
  };
  return {
    methods: methods as unknown as SchedulesHandlersDeps['methods'],
    getLimits: async () => ({
      enabled: true,
      maxPerUser: 10,
      minIntervalMinutes: 60,
      autoDisableAfterFailures: 5,
      admissionConcurrency: 20,
      fireConcurrency: 5,
      mcpPreflightConcurrency: 3,
      mcpPreflightTimeoutMs: 300_000,
      requireProject: false,
    }),
    preflightMCP: jest.fn().mockResolvedValue([]),
    canViewAgent: async () => true,
    filterOwnedFileIds: async (ids: string[]) => ids,
    markFilesUsed: async () => undefined,
    fireNow: async () => null,
    deleteSchedule: async () => true,
    // Passes admission, then the barrier rises before the insert lands.
    isUserDeleting: jest.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
    ...over,
  } as SchedulesHandlersDeps;
}

describe('createSchedule late-create compensation', () => {
  it('answers 410 when the guarded delete removes the unarmed revision', async () => {
    const deps = makeCreateDeps();
    const { res, captured } = makeRes();
    await createSchedulesHandlers(deps).createSchedule(makeCreateReq(), res);
    // Guarded to the exact unarmed revision this attempt inserted — never the
    // unconditional hard delete, which could erase a row a concurrent replay armed
    // (and the engine claimed) before the barrier re-check ran.
    expect(deps.methods.deleteUnarmedSchedule).toHaveBeenCalledWith(
      expect.any(String),
      'user-1',
      0,
    );
    expect(deps.methods.deleteScheduleById).not.toHaveBeenCalled();
    expect(deps.methods.markScheduleDeleting).not.toHaveBeenCalled();
    expect(captured.status).toBe(410);
  });

  it('soft-deletes instead when the row moved past the inserted revision', async () => {
    const deps = makeCreateDeps();
    (deps.methods.deleteUnarmedSchedule as jest.Mock).mockResolvedValue('kept');
    const { res, captured } = makeRes();
    await createSchedulesHandlers(deps).createSchedule(makeCreateReq(), res);
    // An armed/claimed (or edited) row enters the ordinary drain-then-erase teardown
    // rather than being hard-deleted out from under a possible live fire.
    expect(deps.methods.markScheduleDeleting).toHaveBeenCalledWith(expect.any(String), 'user-1');
    expect(captured.status).toBe(410);
  });

  it('falls back to the durable soft-delete when the guarded delete fails', async () => {
    const deps = makeCreateDeps();
    (deps.methods.deleteUnarmedSchedule as jest.Mock).mockRejectedValue(new Error('mongo down'));
    const { res, captured } = makeRes();
    await createSchedulesHandlers(deps).createSchedule(makeCreateReq(), res);
    // Non-claimable at once, and erased by the reconciler's `deleting` sweep.
    expect(deps.methods.markScheduleDeleting).toHaveBeenCalledWith(expect.any(String), 'user-1');
    expect(captured.status).toBe(410);
  });

  it('refuses to report a clean 410 when no cleanup succeeded', async () => {
    const deps = makeCreateDeps();
    (deps.methods.deleteUnarmedSchedule as jest.Mock).mockRejectedValue(new Error('mongo down'));
    (deps.methods.markScheduleDeleting as jest.Mock).mockRejectedValue(new Error('mongo down'));
    const { res, captured } = makeRes();
    await createSchedulesHandlers(deps).createSchedule(makeCreateReq(), res);
    // 410 would claim the row is gone while the deleted user's prompt and
    // attachments stay in a live, non-TTL schedule.
    expect(captured.status).toBe(500);
  });

  /**
   * The compensation is best-effort by nature — when it runs, Mongo is usually the thing
   * failing, so no durable marker can be written either. Durability has to come from the
   * insert instead: an UNARMED row (no nextRunAt) is never claimed by the engine, so
   * even a total compensation failure cannot leave a schedule firing billed generations
   * for an account already being erased.
   */
  it('never inserts an armed row, so a failed compensation leaves an inert one', async () => {
    const deps = makeCreateDeps();
    (deps.methods.deleteScheduleById as jest.Mock).mockRejectedValue(new Error('mongo down'));
    (deps.methods.markScheduleDeleting as jest.Mock).mockRejectedValue(new Error('mongo down'));
    const { res } = makeRes();
    await createSchedulesHandlers(deps).createSchedule(makeCreateReq(), res);

    const inserted = (deps.methods.createScheduleWithSlot as jest.Mock).mock.calls[0][0];
    expect(inserted.nextRunAt).toBeUndefined();
    expect(deps.preflightMCP).toHaveBeenCalledWith(
      CREATE_BODY.agent_id,
      expect.objectContaining({ id: 'user-1' }),
      expect.objectContaining({ scheduleId: inserted.id }),
    );
    // And it is never armed afterwards, because the barrier refused the create.
    expect(deps.methods.updateScheduleById).not.toHaveBeenCalled();
  });

  it('arms the schedule only after the barrier re-check clears', async () => {
    const armedRow = {
      ...CREATE_BODY,
      id: 'sched-fresh',
      target: 'new',
      enabled: true,
      nextRunAt: new Date('2026-07-22T12:00:00Z'),
    } as unknown as ISchedule;
    const deps = makeCreateDeps({
      isUserDeleting: jest.fn(async () => false),
    });
    (deps.methods.armSchedule as jest.Mock).mockResolvedValue(true);
    (deps.methods.getScheduleById as jest.Mock).mockResolvedValue(armedRow);
    const { res, captured } = makeRes();
    await createSchedulesHandlers(deps).createSchedule(makeCreateReq(), res);

    expect(captured.status).toBe(201);
    const inserted = (deps.methods.createScheduleWithSlot as jest.Mock).mock.calls[0][0];
    expect(inserted.nextRunAt).toBeUndefined();
    // The ONE shared arming CAS, fenced on the revision stamped at insert — never
    // updateScheduleById, whose token rotation would fence an engine claim off a row
    // a concurrent replay armed first.
    expect(deps.methods.armSchedule).toHaveBeenCalledWith(expect.any(String), expect.any(Date), 0);
    expect(deps.methods.updateScheduleById).not.toHaveBeenCalled();
  });

  it('stamps the immutable create digest on the inserted row', async () => {
    const deps = makeCreateDeps({ isUserDeleting: jest.fn(async () => false) });
    const { res } = makeRes();
    await createSchedulesHandlers(deps).createSchedule(makeCreateReq(), res);

    const inserted = (deps.methods.createScheduleWithSlot as jest.Mock).mock.calls[0][0];
    expect(inserted.clientRequestDigest).toBe(createBodyDigest());
  });

  it('answers 201 with the current row when a concurrent PATCH wins the arming CAS', async () => {
    const patched = {
      ...CREATE_BODY,
      id: 'sched-fresh',
      target: 'new',
      enabled: true,
      nextRunAt: new Date('2026-07-22T12:00:00Z'),
    } as unknown as ISchedule;
    const deps = makeCreateDeps({ isUserDeleting: jest.fn(async () => false) });
    (deps.methods.armSchedule as jest.Mock).mockResolvedValue(false);
    (deps.methods.getScheduleById as jest.Mock).mockResolvedValue(patched);
    const { res, captured } = makeRes();
    await createSchedulesHandlers(deps).createSchedule(makeCreateReq(), res);

    // The revision moved: the PATCH's own arming governs, and this POST must not
    // overwrite it — it reports the row as the edit left it.
    expect(captured.status).toBe(201);
    expect((captured.body as { nextRunAt?: Date }).nextRunAt).toEqual(patched.nextRunAt);
  });

  /**
   * updateScheduleById filters out rows marked `deleting`, so a null arming result means
   * the deletion cascade claimed this row between the barrier re-check and the arming
   * write. Reporting the pre-delete snapshot as a 201 tells the client a schedule exists
   * that is already hidden and pending erasure.
   */
  it('does not report success when the arming write loses a delete race', async () => {
    const deps = makeCreateDeps({ isUserDeleting: jest.fn(async () => false) });
    (deps.methods.updateScheduleById as jest.Mock).mockResolvedValue(null);
    const { res, captured } = makeRes();
    await createSchedulesHandlers(deps).createSchedule(makeCreateReq(), res);

    expect(captured.status).toBe(410);
    expect(captured.status).not.toBe(201);
  });

  /**
   * A thrown arming write rolls the committed row back — but ONLY while it is still
   * the unarmed, unedited revision this attempt inserted: an ambiguously-committed
   * arm, a concurrent replay of this key that armed the row and already answered
   * 201, or a concurrent PATCH that edited it all leave a row that must survive.
   * deleteUnarmedSchedule carries exactly that guard (revision-fenced).
   */
  it('rolls back the committed row when the arming write throws', async () => {
    const deps = makeCreateDeps({ isUserDeleting: jest.fn(async () => false) });
    (deps.methods.armSchedule as jest.Mock).mockRejectedValue(new Error('mongo down'));
    const { res, captured } = makeRes();
    await createSchedulesHandlers(deps).createSchedule(makeCreateReq(), res);

    expect(captured.status).toBe(500);
    expect(deps.methods.deleteUnarmedSchedule).toHaveBeenCalledWith(
      expect.any(String),
      'user-1',
      0,
    );
    expect(deps.methods.deleteScheduleById).not.toHaveBeenCalled();
  });

  it('answers 201 instead of deleting when the ambiguous arm actually committed', async () => {
    const armedRow = {
      ...CREATE_BODY,
      id: 'sched-fresh',
      target: 'new',
      enabled: true,
      nextRunAt: new Date('2026-07-22T12:00:00Z'),
    } as unknown as ISchedule;
    const deps = makeCreateDeps({ isUserDeleting: jest.fn(async () => false) });
    (deps.methods.armSchedule as jest.Mock).mockRejectedValue(new Error('socket reset'));
    (deps.methods.deleteUnarmedSchedule as jest.Mock).mockResolvedValue('kept');
    (deps.methods.getScheduleById as jest.Mock).mockResolvedValue(armedRow);
    const { res, captured } = makeRes();
    await createSchedulesHandlers(deps).createSchedule(makeCreateReq(), res);

    // The write landed before the error surfaced: the schedule exists exactly as
    // requested, and deleting it would erase a row a concurrent replay may already
    // have confirmed with its own 201.
    expect(captured.status).toBe(201);
  });
});

describe('computeCreateDigest cadence shape', () => {
  it('hashes a structured cadence exactly as it did before cron existed', () => {
    // The digest is the idempotency key's content fence. Widening the canonical shape
    // for every cadence would change it for schedules already out there: a create that
    // committed before a deploy and lost its response would retry against a digest
    // that no longer matches and be refused as if the key had been reused.
    const legacy = createHash('sha256')
      .update(
        JSON.stringify({
          name: 'Digest',
          prompt: 'Summarize',
          agent_id: 'agent-1',
          timezone: 'America/New_York',
          target: 'new',
          enabled: true,
          cadence: { frequency: 'daily', hour: 8, minute: 0, daysOfWeek: null },
          file_ids: null,
        }),
      )
      .digest('hex');

    expect(createBodyDigest()).toBe(legacy);
  });

  it('hashes a cron cadence by its expression', () => {
    const cron = computeCreateDigest({
      ...CREATE_BODY,
      target: 'new',
      enabled: true,
      cadence: { frequency: 'cron', expression: '0 9 * * 1-5' },
    } as never);

    expect(cron).not.toBe(createBodyDigest());
  });
});

describe('create with a cron cadence', () => {
  it('resolves an idempotent replay after the floor was raised beneath it', async () => {
    // The row committed under the old floor and the client lost the response. An
    // admin raising the floor in between must not turn the retry into a 400 for a
    // schedule that already exists; the raised floor reaches it at fire time.
    const committed = {
      id: 'sched-1',
      clientRequestId: 'intent-1',
      name: 'Digest',
      prompt: 'Summarize',
      agent_id: 'agent-1',
      cadence: { frequency: 'daily', hour: 8, minute: 0 },
      timezone: 'America/New_York',
      target: 'new',
      enabled: true,
    } as unknown as ISchedule;
    const deps = makeCreateDeps({
      isUserDeleting: jest.fn(async () => false),
      preflightMCP: jest.fn(async () => {
        throw new Error('MCP became unavailable after the first create');
      }),
      getLimits: async () => ({
        enabled: true,
        maxPerUser: 10,
        // Above the ~1320 minutes a daily cadence reports, so the payload no longer
        // clears the floor it was admitted under.
        minIntervalMinutes: 100_000,
        autoDisableAfterFailures: 5,
        admissionConcurrency: 20,
        fireConcurrency: 5,
        mcpPreflightConcurrency: 3,
        mcpPreflightTimeoutMs: 300_000,
        requireProject: false,
      }),
    });
    (deps.methods.getScheduleByClientRequestId as jest.Mock).mockResolvedValue(committed);
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).createSchedule(makeCreateReq(), res);

    expect(captured.status).not.toBe(400);
    expect(deps.preflightMCP).not.toHaveBeenCalled();
    expect(deps.methods.createScheduleWithSlot).not.toHaveBeenCalled();
  });

  it('still refuses a NEW create below the floor', async () => {
    const deps = makeCreateDeps({
      isUserDeleting: jest.fn(async () => false),
      getLimits: async () => ({
        enabled: true,
        maxPerUser: 10,
        minIntervalMinutes: 100_000,
        autoDisableAfterFailures: 5,
        admissionConcurrency: 20,
        fireConcurrency: 5,
        mcpPreflightConcurrency: 3,
        mcpPreflightTimeoutMs: 300_000,
        requireProject: false,
      }),
    });
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).createSchedule(makeCreateReq(), res);

    expect(captured.status).toBe(400);
    expect(deps.methods.createScheduleWithSlot).not.toHaveBeenCalled();
  });

  it('does not hold attachments for a create it deterministically refuses', async () => {
    // retainFiles extends every upload's TTL to the 14-day schedule hold. Running it
    // before a refusal nothing can retry past meant each attempt pinned uploads that
    // no schedule will ever reference and nothing will ever release.
    const markFilesUsed = jest.fn(async () => undefined);
    const deps = makeCreateDeps({
      isUserDeleting: jest.fn(async () => false),
      markFilesUsed,
      getLimits: async () => ({
        enabled: true,
        maxPerUser: 10,
        minIntervalMinutes: 100_000,
        autoDisableAfterFailures: 5,
        admissionConcurrency: 20,
        fireConcurrency: 5,
        mcpPreflightConcurrency: 3,
        mcpPreflightTimeoutMs: 300_000,
        requireProject: false,
      }),
    });
    const { res, captured } = makeRes();
    const req = {
      body: { ...CREATE_BODY, file_ids: ['file-1'] },
      user: { id: 'user-1', tenantId: 't1', role: 'USER' },
    } as unknown as ServerRequest;

    await createSchedulesHandlers(deps).createSchedule(req, res);

    expect(captured.status).toBe(400);
    expect(markFilesUsed).not.toHaveBeenCalled();
  });

  it('accepts a recurring expression that clears the floor', async () => {
    // The default deps raise the account-deletion barrier on the post-insert
    // re-check; this case is about the cadence, so keep that barrier down.
    const deps = makeCreateDeps({ isUserDeleting: jest.fn(async () => false) });
    (deps.methods.armSchedule as jest.Mock).mockResolvedValue(true);
    // The response re-reads the row it just armed, so it has to exist to be returned.
    (deps.methods.getScheduleById as jest.Mock).mockResolvedValue({
      id: 'sched-1',
      cadence: { frequency: 'cron', expression: '0 9 * * 1-5' },
      timezone: 'America/New_York',
      enabled: true,
    });
    const { res, captured } = makeRes();
    const req = {
      body: { ...CREATE_BODY, cadence: { frequency: 'cron', expression: '0 9 * * 1-5' } },
      user: { id: 'user-1', tenantId: 't1', role: 'USER' },
    } as unknown as ServerRequest;

    await createSchedulesHandlers(deps).createSchedule(req, res);

    expect(captured.status).toBe(201);
    expect(deps.methods.armSchedule).toHaveBeenCalled();
  });
});

describe('create idempotency', () => {
  /** The row the FIRST attempt committed for CREATE_BODY, digest-less (legacy shape). */
  const originalRow = (): ISchedule =>
    ({
      id: 'sched-original',
      name: 'Digest',
      prompt: 'Summarize',
      agent_id: 'agent-1',
      timezone: 'America/New_York',
      target: 'new',
      enabled: true,
      cadence: { frequency: 'daily', hour: 8, minute: 0 },
      clientRequestId: 'intent-1',
      configRevision: 0,
    }) as unknown as ISchedule;

  /**
   * The retry is the whole point: the first attempt committed a row and then failed to
   * arm, so the client cannot know what persisted. Resolving to the ORIGINAL row is
   * what keeps one user intent from becoming two recurring schedules.
   */
  it('re-arms the row a previous attempt committed instead of creating another', async () => {
    const deps = makeCreateDeps({ isUserDeleting: jest.fn(async () => false) });
    const original = originalRow();
    (deps.methods.getScheduleByClientRequestId as jest.Mock).mockResolvedValue(original);
    (deps.methods.getScheduleById as jest.Mock).mockResolvedValue({
      ...original,
      nextRunAt: new Date('2026-07-22T12:00:00Z'),
    });
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).createSchedule(makeCreateReq(), res);

    expect(captured.status ?? 201).toBe(201);
    // Nothing was inserted, and the arm is the GUARDED one keyed by the ORIGINAL row's
    // id (same deterministic jitter as the first attempt) — never updateScheduleById,
    // whose claim-token rotation would fence off an active run of this schedule and
    // whose revision bump would break a concurrent PATCH's CAS.
    expect(deps.methods.createScheduleWithSlot).not.toHaveBeenCalled();
    expect(deps.methods.armSchedule).toHaveBeenCalledWith('sched-original', expect.any(Date));
    expect(deps.methods.updateScheduleById).not.toHaveBeenCalled();
  });

  it('leaves an already-armed row completely untouched on replay', async () => {
    const deps = makeCreateDeps({ isUserDeleting: jest.fn(async () => false) });
    const armed = { ...originalRow(), nextRunAt: new Date('2026-07-22T12:00:00Z') };
    (deps.methods.getScheduleByClientRequestId as jest.Mock).mockResolvedValue(armed);
    (deps.methods.getScheduleById as jest.Mock).mockResolvedValue(armed);
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).createSchedule(makeCreateReq(), res);

    expect(captured.status ?? 201).toBe(201);
    expect(deps.methods.armSchedule).not.toHaveBeenCalled();
    expect(deps.methods.updateScheduleById).not.toHaveBeenCalled();
    expect(deps.methods.deleteUnarmedSchedule).not.toHaveBeenCalled();
    expect(deps.methods.deleteScheduleById).not.toHaveBeenCalled();
  });

  /**
   * A retry can arrive while the user sits AT their schedule cap — with the first
   * attempt's row occupying the final slot. The key must resolve before any capacity
   * refusal, or the client is denied the very row it is trying to confirm.
   */
  it('resolves a retry occupying the final slot before the capacity pre-check', async () => {
    const deps = makeCreateDeps({ isUserDeleting: jest.fn(async () => false) });
    (deps.methods.countSchedulesByUser as jest.Mock).mockResolvedValue(10);
    const armed = { ...originalRow(), nextRunAt: new Date('2026-07-22T12:00:00Z') };
    (deps.methods.getScheduleByClientRequestId as jest.Mock).mockResolvedValue(armed);
    (deps.methods.getScheduleById as jest.Mock).mockResolvedValue(armed);
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).createSchedule(makeCreateReq(), res);

    expect(captured.status ?? 201).toBe(201);
  });

  it('resolves a concurrent retry that hits the allocator limit to the committed row', async () => {
    const deps = makeCreateDeps({ isUserDeleting: jest.fn(async () => false) });
    const armed = { ...originalRow(), nextRunAt: new Date('2026-07-22T12:00:00Z') };
    // Absent at the pre-insert lookup, present after the allocator reports 'limit':
    // the concurrent first attempt committed in between and took the last slot.
    (deps.methods.getScheduleByClientRequestId as jest.Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(armed);
    (deps.methods.createScheduleWithSlot as jest.Mock).mockResolvedValue('limit');
    (deps.methods.getScheduleById as jest.Mock).mockResolvedValue(armed);
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).createSchedule(makeCreateReq(), res);

    expect(captured.status ?? 201).toBe(201);
  });

  it('refuses a key reused for a different schedule', async () => {
    const deps = makeCreateDeps({ isUserDeleting: jest.fn(async () => false) });
    // Same key, but the row it resolves to is a different intent entirely.
    (deps.methods.getScheduleByClientRequestId as jest.Mock).mockResolvedValue({
      id: 'sched-original',
      name: 'Something else',
      prompt: 'Different prompt',
      agent_id: 'agent-9',
    } as ISchedule);
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).createSchedule(makeCreateReq(), res);

    // A 201 here would describe a schedule the caller never asked for.
    expect(captured.status).toBe(409);
    expect(deps.methods.armSchedule).not.toHaveBeenCalled();
    expect(deps.methods.updateScheduleById).not.toHaveBeenCalled();
  });

  /**
   * The digest is the IMMUTABLE record of the create intent: a PATCH that reshaped the
   * row between the first attempt and its retry must not make a genuine replay read as
   * key reuse — the mutable row no longer matches, but the stamped digest still does.
   */
  it('matches a replay by digest even after a PATCH reshaped the row', async () => {
    const deps = makeCreateDeps({ isUserDeleting: jest.fn(async () => false) });
    const patched = {
      ...originalRow(),
      name: 'Renamed by a PATCH',
      prompt: 'Edited prompt',
      nextRunAt: new Date('2026-07-22T12:00:00Z'),
      clientRequestDigest: createBodyDigest(),
    };
    (deps.methods.getScheduleByClientRequestId as jest.Mock).mockResolvedValue(patched);
    (deps.methods.getScheduleById as jest.Mock).mockResolvedValue(patched);
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).createSchedule(makeCreateReq(), res);

    expect(captured.status ?? 201).toBe(201);
  });

  it('refuses by digest when the key was reused for different content', async () => {
    const deps = makeCreateDeps({ isUserDeleting: jest.fn(async () => false) });
    // Field-identical row (a legacy comparison would pass) whose stamped digest says
    // the ORIGINAL create asked for something else — e.g. different attachments.
    const differentIntent = {
      ...originalRow(),
      nextRunAt: new Date('2026-07-22T12:00:00Z'),
      clientRequestDigest: 'not-this-request',
    };
    (deps.methods.getScheduleByClientRequestId as jest.Mock).mockResolvedValue(differentIntent);
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).createSchedule(makeCreateReq(), res);

    expect(captured.status).toBe(409);
  });

  it('never compensates on the replay path, even when its arm fails', async () => {
    const deps = makeCreateDeps({ isUserDeleting: jest.fn(async () => false) });
    (deps.methods.getScheduleByClientRequestId as jest.Mock).mockResolvedValue(originalRow());
    (deps.methods.armSchedule as jest.Mock).mockRejectedValue(new Error('mongo down'));
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).createSchedule(makeCreateReq(), res);

    // The established row survives for the next retry; deleting it here is data loss.
    expect(captured.status).toBe(500);
    expect(deps.methods.deleteScheduleById).not.toHaveBeenCalled();
    expect(deps.methods.deleteUnarmedSchedule).not.toHaveBeenCalled();
    expect(deps.methods.markScheduleDeleting).not.toHaveBeenCalled();
  });

  it('refuses a create without an idempotency key', async () => {
    const deps = makeCreateDeps({ isUserDeleting: jest.fn(async () => false) });
    const req = makeCreateReq() as unknown as { body: Record<string, unknown> };
    delete req.body.clientRequestId;
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).createSchedule(req as unknown as ServerRequest, res);

    // Optional keys preserved the keyless duplicate path — the exact failure the key
    // exists to close — so the payload schema requires one.
    expect(captured.status).toBe(400);
    expect(deps.methods.createScheduleWithSlot).not.toHaveBeenCalled();
  });
});

describe('deferred deletion retry', () => {
  it('re-drives the full deletion of the caller’s soft-deleted schedules on list', async () => {
    const deps = makeCreateDeps({
      deleteSchedule: jest.fn(async () => 'deleted'),
    } as Partial<SchedulesHandlersDeps>);
    (deps.methods.getSchedulesByUser as jest.Mock) = jest.fn(async () => []);
    (deps.methods.getDeletingScheduleIds as jest.Mock) = jest.fn(async () => ['stranded-1']);
    (deps.methods.markEraseAttempted as jest.Mock) = jest.fn(async () => undefined);
    const { res } = makeRes();

    await createSchedulesHandlers(deps).listSchedules(
      { user: { id: 'user-1' } } as unknown as ServerRequest,
      res,
    );
    // Fire-and-forget, so let the microtask chain settle before asserting.
    await new Promise((resolve) => setImmediate(resolve));

    // The service delete (abort + settle + erase), not a bare erase probe: a schedule
    // stranded mid-drain with a still-active run needs the abort re-driven too.
    expect(deps.deleteSchedule).toHaveBeenCalledWith('stranded-1', 'user-1');
    // Stamped attempted so the bounded window rotates past rows that stay unconfirmed.
    expect(deps.methods.markEraseAttempted).toHaveBeenCalledWith(['stranded-1']);
  });

  it('keeps listing even when a stranded deletion re-drive rejects', async () => {
    const deps = makeCreateDeps({
      deleteSchedule: jest.fn(async () => {
        throw new Error('still draining');
      }),
    } as Partial<SchedulesHandlersDeps>);
    (deps.methods.getSchedulesByUser as jest.Mock) = jest.fn(async () => []);
    (deps.methods.getDeletingScheduleIds as jest.Mock) = jest.fn(async () => ['stranded-1']);
    (deps.methods.markEraseAttempted as jest.Mock) = jest.fn(async () => undefined);
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).listSchedules(
      { user: { id: 'user-1' } } as unknown as ServerRequest,
      res,
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(captured.body).toEqual(expect.objectContaining({ schedules: [] }));
  });
});

describe('in-flight run projection', () => {
  const schedule = { id: 'sched-1', user: 'user-1', name: 'Digest' } as unknown as ISchedule;
  const run = (over: Partial<IScheduleRun>): IScheduleRun =>
    ({
      scheduleId: 'sched-1',
      user: 'user-1',
      scheduledFor: new Date('2026-09-06T09:00:00Z'),
      status: 'started',
      ...over,
    }) as unknown as IScheduleRun;
  type Wire = { inFlight?: Array<{ conversationId: string }> };

  async function listWith(runs: IScheduleRun[], schedules: ISchedule[] = [schedule]) {
    const deps = makeCreateDeps();
    (deps.methods.getSchedulesByUser as jest.Mock) = jest.fn(async () => schedules);
    (deps.methods.getActiveRunsForUser as jest.Mock) = jest.fn(async () => runs);
    (deps.methods.getDeletingScheduleIds as jest.Mock) = jest.fn(async () => []);
    const { res, captured } = makeRes();
    await createSchedulesHandlers(deps).listSchedules(
      { user: { id: 'user-1' } } as unknown as ServerRequest,
      res,
    );
    return { deps, schedules: (captured.body as { schedules: Wire[] }).schedules };
  }

  it('names the chat a generating occurrence is producing', async () => {
    const { schedules } = await listWith([run({ conversationId: 'convo-1' })]);
    expect(schedules[0].inFlight).toEqual([{ conversationId: 'convo-1' }]);
  });

  it('asks only for generating occurrences, never the parked ones', async () => {
    // Indexed by status rather than user, and `requires_action` rows accumulate for
    // as long as approvals wait; `started` rows are bounded by the capacity slots.
    const { deps } = await listWith([]);
    expect(deps.methods.getActiveRunsForUser).toHaveBeenCalledWith('user-1', ['started']);
  });

  it('projects nothing for a reservation that has not been dispatched', async () => {
    const { schedules } = await listWith([run({})]);
    expect(schedules[0].inFlight).toBeUndefined();
  });

  it('projects nothing when no occurrence is generating', async () => {
    const { schedules } = await listWith([]);
    expect(schedules[0].inFlight).toBeUndefined();
  });

  it('files each occurrence under its own schedule', async () => {
    const { schedules } = await listWith(
      [run({ conversationId: 'convo-2', scheduleId: 'sched-2' })],
      [schedule, { ...schedule, id: 'sched-2' }],
    );
    expect(schedules[0].inFlight).toBeUndefined();
    expect(schedules[1].inFlight).toEqual([{ conversationId: 'convo-2' }]);
  });

  it('scopes the single-schedule read to the caller before ownership is known', async () => {
    const deps = makeCreateDeps();
    (deps.methods.getScheduleById as jest.Mock) = jest.fn(async () => schedule);
    (deps.methods.getActiveRunsForUser as jest.Mock) = jest.fn(async () => [
      run({ conversationId: 'mine' }),
      run({ conversationId: 'other-schedule', scheduleId: 'sched-9' }),
    ]);
    const { res, captured } = makeRes();
    await createSchedulesHandlers(deps).getSchedule(
      { params: { id: 'sched-1' }, user: { id: 'user-1' } } as unknown as ServerRequest,
      res,
    );
    expect(deps.methods.getActiveRunsForUser).toHaveBeenCalledWith('user-1', ['started']);
    expect(deps.methods.getActiveRunsForSchedule).not.toHaveBeenCalled();
    expect((captured.body as Wire).inFlight).toEqual([{ conversationId: 'mine' }]);
  });
});

describe('deleteSchedule result mapping', () => {
  function makeDeleteReq(): ServerRequest {
    return {
      params: { id: 'sched-1' },
      user: { id: 'user-1', tenantId: 't1', role: 'USER' },
    } as unknown as ServerRequest;
  }

  const withResult = (result: string) =>
    makeCreateDeps({
      deleteSchedule: jest.fn(async () => result),
    } as Partial<SchedulesHandlersDeps>);

  it('404s when the schedule is not found', async () => {
    const { res, captured } = makeRes();
    await createSchedulesHandlers(withResult('not_found')).deleteSchedule(makeDeleteReq(), res);
    expect(captured.status).toBe(404);
  });

  it('answers 200 when drained and erased', async () => {
    const { res, captured } = makeRes();
    await createSchedulesHandlers(withResult('deleted')).deleteSchedule(makeDeleteReq(), res);
    expect(captured.status ?? 200).toBe(200);
    expect(captured.body).toEqual({ id: 'sched-1' });
  });

  it('answers 202 while a delivered abort is still settling', async () => {
    const { res, captured } = makeRes();
    await createSchedulesHandlers(withResult('draining')).deleteSchedule(makeDeleteReq(), res);
    expect(captured.status).toBe(202);
    expect(captured.body).toEqual({ id: 'sched-1' });
  });

  it('refuses honestly when the active run could not be confirmed stopped', async () => {
    // Reporting success would claim a possibly still-billing generation was stopped.
    const { res, captured } = makeRes();
    await createSchedulesHandlers(withResult('unconfirmed')).deleteSchedule(makeDeleteReq(), res);
    expect(captured.status).toBe(503);
  });
});

describe('capacity pre-check vs concurrent same-key insert', () => {
  it('re-checks the key before refusing an over-limit create', async () => {
    const deps = makeCreateDeps({ isUserDeleting: jest.fn(async () => false) });
    (deps.methods.countSchedulesByUser as jest.Mock).mockResolvedValue(10);
    const armed = {
      ...CREATE_BODY,
      id: 'sched-original',
      target: 'new',
      enabled: true,
      configRevision: 0,
      nextRunAt: new Date('2026-07-22T12:00:00Z'),
    } as unknown as ISchedule;
    // Absent at the replay lookup, present by the capacity pre-check: the concurrent
    // first attempt committed in between — and may itself be the row at the cap.
    (deps.methods.getScheduleByClientRequestId as jest.Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(armed);
    (deps.methods.getScheduleById as jest.Mock).mockResolvedValue(armed);
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).createSchedule(makeCreateReq(), res);

    // A 400 here would refuse the client the very row it is trying to confirm.
    expect(captured.status ?? 201).toBe(201);
    expect(deps.methods.createScheduleWithSlot).not.toHaveBeenCalled();
  });
});

describe('updateSchedule refuses field-less payloads', () => {
  it('rejects {} before touching claim-token or revision fencing', async () => {
    const deps = makeCreateDeps({ isUserDeleting: jest.fn(async () => false) });
    const { res, captured } = makeRes();
    await createSchedulesHandlers(deps).updateSchedule(
      {
        params: { id: 'sched-1' },
        body: {},
        user: { id: 'user-1', tenantId: 't1', role: 'USER' },
      } as unknown as ServerRequest,
      res,
    );
    // An empty update still rotates claimToken and bumps configRevision, fencing a
    // legitimate in-flight occurrence for a request that changed nothing.
    expect(captured.status).toBe(400);
    expect(deps.methods.updateScheduleById).not.toHaveBeenCalled();
  });
});

describe('updateSchedule client revision fence', () => {
  const existingRow = () =>
    ({
      id: 'sched-1',
      enabled: true,
      agent_id: 'agent-1',
      cadence: { frequency: 'daily', hour: 8, minute: 0 },
      timezone: 'UTC',
      nextRunAt: new Date('2026-07-31T09:00:00Z'),
      configRevision: 7,
    }) as unknown as ISchedule;

  const makePatchReq = (body: Record<string, unknown>) =>
    ({
      params: { id: 'sched-1' },
      body,
      user: { id: 'user-1', tenantId: 't1', role: 'USER' },
    }) as unknown as ServerRequest;

  it('refuses a PATCH computed from a superseded revision', async () => {
    const deps = makeCreateDeps({ isUserDeleting: jest.fn(async () => false) });
    (deps.methods.getScheduleById as jest.Mock).mockResolvedValue(existingRow());
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).updateSchedule(
      makePatchReq({ name: 'renamed', expectedConfigRevision: 6 }),
      res,
    );

    // The dialog rebuilds cadence whole from the snapshot it opened with, so the
    // server's fresh-read fence alone cannot see that another tab edited the row.
    expect(captured.status).toBe(409);
    expect(deps.methods.updateScheduleById).not.toHaveBeenCalled();
  });

  it('applies the PATCH and strips the fence field when the revision matches', async () => {
    const deps = makeCreateDeps({ isUserDeleting: jest.fn(async () => false) });
    (deps.methods.getScheduleById as jest.Mock).mockResolvedValue(existingRow());
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).updateSchedule(
      makePatchReq({ name: 'renamed', expectedConfigRevision: 7 }),
      res,
    );

    expect(captured.status ?? 200).toBe(200);
    const [, , update] = (deps.methods.updateScheduleById as jest.Mock).mock.calls[0];
    // The fence input is not a schedule field; writing it would corrupt the row.
    expect(update).not.toHaveProperty('expectedConfigRevision');
    expect(update).toHaveProperty('name', 'renamed');
  });

  it('still refuses a PATCH that carries only the fence field', async () => {
    const deps = makeCreateDeps({ isUserDeleting: jest.fn(async () => false) });
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).updateSchedule(
      makePatchReq({ expectedConfigRevision: 7 }),
      res,
    );

    expect(captured.status).toBe(400);
    expect(deps.methods.updateScheduleById).not.toHaveBeenCalled();
  });
});

describe('attachment id deduplication', () => {
  it('accepts a create whose payload repeats an owned file id', async () => {
    const deps = makeCreateDeps({ isUserDeleting: jest.fn(async () => false) });
    (deps.methods.armSchedule as jest.Mock).mockResolvedValue(true);
    (deps.methods.getScheduleById as jest.Mock).mockResolvedValue({
      ...CREATE_BODY,
      id: 'sched-1',
      file_ids: ['file-a'],
    } as unknown as ISchedule);
    const req = makeCreateReq() as unknown as { body: Record<string, unknown> };
    req.body.file_ids = ['file-a', 'file-a'];
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).createSchedule(req as unknown as ServerRequest, res);

    // The ownership query returns one doc per UNIQUE id, so an un-deduped list
    // read as a missing file and 400'd a valid request. The schema dedupes.
    expect(captured.status ?? 201).toBe(201);
    expect(deps.methods.createScheduleWithSlot).toHaveBeenCalledWith(
      expect.objectContaining({ file_ids: ['file-a'] }),
      expect.any(Number),
    );
  });
});

describe('updateSchedule cadence timezone resolution', () => {
  const nyRow = (enabled: boolean) =>
    ({
      id: 'sched-1',
      enabled,
      agent_id: 'agent-1',
      cadence: { frequency: 'daily', hour: 8, minute: 0 },
      timezone: 'America/New_York',
      configRevision: 1,
    }) as unknown as ISchedule;

  const patchCadence = () =>
    ({
      params: { id: 'sched-1' },
      body: { cadence: { frequency: 'cron', expression: '0 0,12 * * *' } },
      user: { id: 'user-1', tenantId: 't1', role: 'USER' },
    }) as unknown as ServerRequest;

  it('measures a cadence-only PATCH against the STORED timezone', async () => {
    // The payload carries no timezone, so validation used undefined (i.e. UTC) and
    // read the nominal 720-minute gap, while the schedule actually runs in New York
    // where spring-forward compresses it to 660. The row stays disabled, so the later
    // effective-cadence check never runs and nothing else catches it.
    const deps = makeCreateDeps({
      isUserDeleting: jest.fn(async () => false),
      getLimits: async () => ({
        enabled: true,
        maxPerUser: 10,
        minIntervalMinutes: 700,
        autoDisableAfterFailures: 5,
        admissionConcurrency: 20,
        fireConcurrency: 5,
        mcpPreflightConcurrency: 3,
        mcpPreflightTimeoutMs: 300_000,
        requireProject: false,
      }),
    });
    (deps.methods.getScheduleById as jest.Mock).mockResolvedValue(nyRow(false));
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).updateSchedule(patchCadence(), res);

    expect(captured.status).toBe(400);
    expect(deps.methods.updateScheduleById).not.toHaveBeenCalled();
  });

  it('measures a timezone-ONLY patch against the floor, even while disabled', async () => {
    // Timing is the cadence and the zone it is read in. Checking only a submitted
    // CADENCE let a disabled row be retimed into a zone where its gap violates the
    // floor: accepted with 200, then refused later at enable.
    const deps = makeCreateDeps({
      isUserDeleting: jest.fn(async () => false),
      getLimits: async () => ({
        enabled: true,
        maxPerUser: 10,
        minIntervalMinutes: 700,
        autoDisableAfterFailures: 5,
        admissionConcurrency: 20,
        fireConcurrency: 5,
        mcpPreflightConcurrency: 3,
        mcpPreflightTimeoutMs: 300_000,
        requireProject: false,
      }),
    });
    (deps.methods.getScheduleById as jest.Mock).mockResolvedValue({
      ...nyRow(false),
      cadence: { frequency: 'cron', expression: '0 0,12 * * *' },
      timezone: 'UTC',
    } as unknown as ISchedule);
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).updateSchedule(
      {
        params: { id: 'sched-1' },
        body: { timezone: 'America/New_York' },
        user: { id: 'user-1', tenantId: 't1', role: 'USER' },
      } as unknown as ServerRequest,
      res,
    );

    expect(captured.status).toBe(400);
    expect(deps.methods.updateScheduleById).not.toHaveBeenCalled();
  });

  it('accepts the same PATCH where the stored zone does not compress it', async () => {
    const deps = makeCreateDeps({
      isUserDeleting: jest.fn(async () => false),
      getLimits: async () => ({
        enabled: true,
        maxPerUser: 10,
        minIntervalMinutes: 700,
        autoDisableAfterFailures: 5,
        admissionConcurrency: 20,
        fireConcurrency: 5,
        mcpPreflightConcurrency: 3,
        mcpPreflightTimeoutMs: 300_000,
        requireProject: false,
      }),
    });
    (deps.methods.getScheduleById as jest.Mock).mockResolvedValue({
      ...nyRow(false),
      timezone: 'UTC',
    } as unknown as ISchedule);
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).updateSchedule(patchCadence(), res);

    expect(captured.status ?? 200).toBe(200);
  });
});

describe('updateSchedule re-enable attachment revalidation', () => {
  const disabledWithFiles = () =>
    ({
      id: 'sched-1',
      enabled: false,
      agent_id: 'agent-1',
      cadence: { type: 'daily', hour: 9, minute: 0 },
      timezone: 'UTC',
      nextRunAt: new Date('2026-07-31T09:00:00Z'),
      configRevision: 3,
      file_ids: ['file-a', 'file-b'],
    }) as unknown as ISchedule;

  const makeReEnableReq = () =>
    ({
      params: { id: 'sched-1' },
      body: { enabled: true },
      user: { id: 'user-1', tenantId: 't1', role: 'USER' },
    }) as unknown as ServerRequest;

  it('refuses re-enabling when a stored attachment is no longer owned', async () => {
    const deps = makeCreateDeps({
      isUserDeleting: jest.fn(async () => false),
      filterOwnedFileIds: jest.fn(async () => ['file-a']),
    } as Partial<SchedulesHandlersDeps>);
    (deps.methods.getScheduleById as jest.Mock).mockResolvedValue(disabledWithFiles());
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).updateSchedule(makeReEnableReq(), res);

    // The bounded upload hold only renews while the schedule fires, so a long-
    // disabled schedule can have lost its uploads; silently firing without them
    // is worse than telling the owner to replace the attachments.
    expect(captured.status).toBe(400);
    expect(deps.methods.updateScheduleById).not.toHaveBeenCalled();
  });

  it('renews the retention hold on the stored attachments before committing', async () => {
    const markFilesUsed = jest.fn(async () => undefined);
    const deps = makeCreateDeps({
      isUserDeleting: jest.fn(async () => false),
      markFilesUsed,
    } as Partial<SchedulesHandlersDeps>);
    (deps.methods.getScheduleById as jest.Mock).mockResolvedValue(disabledWithFiles());
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).updateSchedule(makeReEnableReq(), res);

    expect(markFilesUsed).toHaveBeenCalledWith(['file-a', 'file-b'], 'user-1');
    expect(deps.preflightMCP).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ id: 'user-1', tenantId: 't1' }),
      expect.objectContaining({ scheduleId: 'sched-1' }),
    );
    expect(captured.status ?? 200).toBe(200);
    expect(deps.methods.updateScheduleById).toHaveBeenCalled();
  });

  it('preserves run history when re-enable preflight succeeds', async () => {
    const deps = makeCreateDeps({ isUserDeleting: async () => false });
    jest.mocked(deps.methods.getScheduleById).mockResolvedValue({
      ...disabledWithFiles(),
      file_ids: [],
      lastRun: {
        status: 'error',
        firedAt: new Date(),
        error: 'mcp_reauth_required: [{"server":"Notion","status":"mcp_reauth_required"}]',
      },
    } as ISchedule);
    const { res } = makeRes();

    await createSchedulesHandlers(deps).updateSchedule(makeReEnableReq(), res);

    expect(deps.methods.updateScheduleById).toHaveBeenCalledWith(
      'sched-1',
      'user-1',
      expect.objectContaining({ enabled: true }),
      expect.objectContaining({ disabledReason: 1 }),
      expect.any(Object),
    );
    const [, , , unset] = jest.mocked(deps.methods.updateScheduleById).mock.calls[0];
    expect(unset).not.toHaveProperty('lastRun');
  });

  it('skips the stored-attachment recheck when the edit replaces file_ids', async () => {
    const filterOwnedFileIds = jest.fn(async (ids: string[]) => ids);
    const deps = makeCreateDeps({
      isUserDeleting: jest.fn(async () => false),
      filterOwnedFileIds,
    } as Partial<SchedulesHandlersDeps>);
    (deps.methods.getScheduleById as jest.Mock).mockResolvedValue(disabledWithFiles());
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).updateSchedule(
      {
        params: { id: 'sched-1' },
        body: { enabled: true, file_ids: ['file-new'] },
        user: { id: 'user-1', tenantId: 't1', role: 'USER' },
      } as unknown as ServerRequest,
      res,
    );

    // Supplied file_ids are validated by validatePayload; the stored list is
    // about to be overwritten, so rechecking it would refuse a valid replacement.
    expect(captured.status ?? 200).toBe(200);
    expect(filterOwnedFileIds).toHaveBeenCalledTimes(1);
    expect(filterOwnedFileIds).toHaveBeenCalledWith(['file-new'], 'user-1');
  });
});

describe('late-create compensation with a live manual run', () => {
  it('treats a draining rollback as compensated (the teardown owns it)', async () => {
    const deps = makeCreateDeps();
    (deps.methods.deleteUnarmedSchedule as jest.Mock).mockResolvedValue('draining');
    const { res, captured } = makeRes();
    await createSchedulesHandlers(deps).createSchedule(makeCreateReq(), res);
    // Soft-claimed and draining: hidden, unclaimable, erased once its live manual
    // run settles — never hard-deleted out from under that generation.
    expect(deps.methods.markScheduleDeleting).not.toHaveBeenCalled();
    expect(captured.status).toBe(410);
  });
});

describe('unattended MCP admission', () => {
  it('does not treat a consumed request stream as a client disconnect', async () => {
    const deps = makeCreateDeps({ isUserDeleting: async () => false });
    const req = Object.assign(makeCreateReq(), { destroyed: true });
    (req as unknown as { body: Record<string, unknown> }).body = {
      ...(req.body as unknown as Record<string, unknown>),
      enabled: false,
    };
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).createSchedule(req, res);

    expect(captured.status).toBe(201);
    expect(deps.preflightMCP).not.toHaveBeenCalled();
    expect(deps.methods.createScheduleWithSlot).toHaveBeenCalledTimes(1);
  });

  it.each([
    'mcp_reauth_required',
    'mcp_configuration_missing',
    'mcp_permission_denied',
    'mcp_unavailable',
  ] as const)('refuses create before persisting when preflight reports %s', async (status) => {
    const deps = makeCreateDeps({
      preflightMCP: async () => {
        throw new ScheduleMCPError([{ server: 'Notion', status }]);
      },
    });
    const { res, captured } = makeRes();
    await createSchedulesHandlers(deps).createSchedule(makeCreateReq(), res);
    expect(captured.status).toBe(status === 'mcp_unavailable' ? 503 : 400);
    expect(captured.body).toMatchObject({ code: status, mcp: [{ server: 'Notion', status }] });
    expect(deps.methods.createScheduleWithSlot).not.toHaveBeenCalled();
  });

  it('cancels MCP preflight and does not persist after the request closes', async () => {
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const deps = makeCreateDeps({
      preflightMCP: async (_agentId, _user, options) =>
        new Promise((_resolve, reject) => {
          markStarted();
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    });
    const { res, captured } = makeRes();
    const pending = createSchedulesHandlers(deps).createSchedule(makeCreateReq(), res);
    await started;

    (res as unknown as { emit: (event: string) => void }).emit('close');
    await pending;

    expect(captured.body).toBeUndefined();
    expect(deps.methods.createScheduleWithSlot).not.toHaveBeenCalled();
  });

  it('observes a disconnect that occurs during the first awaited admission read', async () => {
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const preflightMCP = jest.fn(async () => []);
    const deps = makeCreateDeps({
      isUserDeleting: async () => {
        await blocked;
        return false;
      },
      preflightMCP,
    });
    const { res, captured } = makeRes();
    const pending = createSchedulesHandlers(deps).createSchedule(makeCreateReq(), res);

    (res as unknown as { emit: (event: string) => void }).emit('close');
    release();
    await pending;

    expect(captured.body).toBeUndefined();
    expect(deps.methods.createScheduleWithSlot).not.toHaveBeenCalled();
  });
});

describe('Run Now MCP failures', () => {
  it.each([
    ['mcp_unavailable', 503],
    ['mcp_reauth_required', 400],
    ['mcp_configuration_missing', 400],
    ['mcp_permission_denied', 400],
  ] as const)('returns the correct status for %s', async (mcpStatus, expectedStatus) => {
    const deps = makeCreateDeps({
      isUserDeleting: async () => false,
      fireNow: async () => ({
        fired: false,
        error: 'MCP preflight failed',
        mcp: [
          { server: 'Ready', status: 'ready' },
          { server: 'Blocked', status: mcpStatus },
        ],
      }),
    });
    jest.mocked(deps.methods.getScheduleById).mockResolvedValue(fullScheduleDoc());
    const req = makeCreateReq();
    req.params = { id: 'sched-1' };
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).runScheduleNow(req, res);

    expect(captured.status).toBe(expectedStatus);
    expect(captured.body).toMatchObject({ code: mcpStatus });
  });

  it.each([
    [
      [
        { server: 'OAuth', status: 'mcp_reauth_required' as const },
        { server: 'Config', status: 'mcp_configuration_missing' as const },
      ],
      'mcp_configuration_missing',
    ],
    [
      [
        { server: 'OAuth', status: 'mcp_reauth_required' as const },
        { server: 'Config', status: 'mcp_configuration_missing' as const },
        { server: 'Policy', status: 'mcp_permission_denied' as const },
      ],
      'mcp_permission_denied',
    ],
  ])('uses shared failure precedence for mixed outcomes: %j', async (mcp, expectedCode) => {
    const deps = makeCreateDeps({
      isUserDeleting: async () => false,
      fireNow: async () => ({ fired: false, error: 'MCP preflight failed', mcp }),
    });
    jest.mocked(deps.methods.getScheduleById).mockResolvedValue(fullScheduleDoc());
    const req = makeCreateReq();
    req.params = { id: 'sched-1' };
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).runScheduleNow(req, res);

    expect(captured.status).toBe(400);
    expect(captured.body).toMatchObject({ code: expectedCode });
  });

  it('returns service unavailable when MCP infrastructure preflight fails', async () => {
    const deps = makeCreateDeps({
      isUserDeleting: async () => false,
      fireNow: async () => ({
        fired: false,
        error: 'MCP preflight unavailable',
        mcpPreflightUnavailable: true,
      }),
    });
    jest.mocked(deps.methods.getScheduleById).mockResolvedValue(fullScheduleDoc());
    const req = makeCreateReq();
    req.params = { id: 'sched-1' };
    const { res, captured } = makeRes();

    await createSchedulesHandlers(deps).runScheduleNow(req, res);

    expect(captured.status).toBe(503);
    expect(captured.body).toMatchObject({
      code: 'mcp_unavailable',
      error: 'MCP preflight unavailable',
    });
  });
});

it.each([{ enabled: true }, { prompt: 'Updated prompt' }, { agent_id: 'replacement' }])(
  'rechecks effective MCP configuration for edits and enable: %j',
  async (body) => {
    const deps = makeCreateDeps({
      isUserDeleting: async () => false,
      preflightMCP: async () => {
        throw new ScheduleMCPError([{ server: 'Notion', status: 'mcp_reauth_required' }]);
      },
    });
    jest.mocked(deps.methods.getScheduleById).mockResolvedValue(fullScheduleDoc());
    const req = makeCreateReq();
    req.params = { id: 'sched-1' };
    Object.assign(req, { body });
    const { res, captured } = makeRes();
    await createSchedulesHandlers(deps).updateSchedule(req, res);
    expect(captured.status).toBe(400);
    expect(deps.methods.updateScheduleById).not.toHaveBeenCalled();
  },
);

it('allows pausing even when MCP preflight would fail', async () => {
  const preflightMCP = jest.fn(async () => {
    throw new Error('unavailable');
  });
  const deps = makeCreateDeps({ isUserDeleting: async () => false, preflightMCP });
  jest.mocked(deps.methods.getScheduleById).mockResolvedValue(fullScheduleDoc());
  const req = makeCreateReq();
  req.params = { id: 'sched-1' };
  Object.assign(req, { body: { enabled: false } });
  const { res } = makeRes();
  await createSchedulesHandlers(deps).updateSchedule(req, res);
  expect(preflightMCP).not.toHaveBeenCalled();
  expect(deps.methods.updateScheduleById).toHaveBeenCalled();
});

it('allows repointing a disabled schedule without MCP preflight', async () => {
  const preflightMCP = jest.fn(async () => {
    throw new Error('unavailable');
  });
  const deps = makeCreateDeps({ isUserDeleting: async () => false, preflightMCP });
  jest
    .mocked(deps.methods.getScheduleById)
    .mockResolvedValue(fullScheduleDoc({ enabled: false, nextRunAt: undefined }));
  const req = makeCreateReq();
  req.params = { id: 'sched-1' };
  Object.assign(req, { body: { agent_id: 'replacement' } });
  const { res, captured } = makeRes();

  await createSchedulesHandlers(deps).updateSchedule(req, res);

  expect(captured.status ?? 200).toBe(200);
  expect(preflightMCP).not.toHaveBeenCalled();
  expect(deps.methods.updateScheduleById).toHaveBeenCalled();
});
