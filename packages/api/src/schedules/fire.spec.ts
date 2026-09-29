import type { ScheduleEngineDeps, ScheduleLimits, ScheduleUserContext } from './types';
import type { FireableSchedule } from './types';
import { AgentTriggerServiceUnavailableError } from '../agents/triggers/service';
import { getAgentTriggerIdempotencyKey } from '../agents/triggers/envelope';
import { AgentTriggerDeliveryError } from '../agents/triggers/delivery';
import { buildFireClientRequestId, fireSchedule } from './fire';
import { withCapacitySlot } from './capacity';
import { ScheduleMCPError } from './mcp';

const OWNER: ScheduleUserContext = { id: 'user-1', tenantId: 't1', role: 'USER' };
const LIMITS: ScheduleLimits = {
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

/** In-memory run store exercising the real insert/count/delete/idempotency interplay. */
function makeMethods() {
  const runs = new Map<
    string,
    { status: string; conversationId?: string; capacitySlot?: number; admissionOnly?: boolean }
  >();
  const calls = {
    advance: 0,
    releaseLease: 0,
    disable: [] as string[],
    recordOutcome: [] as { status: string }[],
    skipped: [] as string[],
    setFireDetails: 0,
  };
  const key = (id: string, when: Date) => `${id}:${when.toISOString()}`;
  const methods = {
    releaseLease: jest.fn(async () => {
      calls.releaseLease += 1;
      return true;
    }),
    advanceSchedule: jest.fn(async () => {
      calls.advance += 1;
      return true;
    }),
    disableSchedule: jest.fn(async (_id: string, reason: string) => {
      calls.disable.push(reason);
    }),
    hasActiveRun: jest.fn(async (id: string) =>
      [...runs.entries()].some(([k, r]) => k.startsWith(`${id}:`) && r.status === 'started'),
    ),
    countActiveRuns: jest.fn(
      async () => [...runs.values()].filter((r) => r.status === 'started').length,
    ),
    insertScheduleRun: jest.fn(
      async (data: { scheduleId: string; scheduledFor: Date; conversationId?: string }) => {
        const k = key(data.scheduleId, data.scheduledFor);
        if (runs.has(k)) {
          return null; // unique {scheduleId, scheduledFor}
        }
        runs.set(k, { status: 'started', conversationId: data.conversationId });
        return { scheduleId: data.scheduleId, scheduledFor: data.scheduledFor };
      },
    ),
    // Mirrors the partial-unique-index semantics: same-occurrence row => 'duplicate';
    // any OTHER started run for the schedule => 'overlap'; else reserve the slot.
    reserveStartedRun: jest.fn(
      async (data: {
        scheduleId: string;
        scheduledFor: Date;
        conversationId?: string;
        capacitySlot?: number;
        admissionOnly?: boolean;
        deliveryKey?: string;
      }) => {
        const k = key(data.scheduleId, data.scheduledFor);
        if (runs.has(k)) {
          // Mirrors the real method: a duplicate reports the EXISTING row's status so
          // the caller can tell "still running" from "already finished".
          return { conflict: 'duplicate' as const, existingStatus: runs.get(k)!.status };
        }
        // Mirrors the unique {capacitySlot} partial index (status:'started').
        if (
          data.capacitySlot != null &&
          [...runs.values()].some(
            (r) => r.status === 'started' && r.capacitySlot === data.capacitySlot,
          )
        ) {
          return { conflict: 'slot-taken' as const };
        }
        const overlap = [...runs.entries()].some(
          ([rk, r]) => rk.startsWith(`${data.scheduleId}:`) && r.status === 'started',
        );
        if (overlap) {
          return { conflict: 'overlap' as const };
        }
        runs.set(k, {
          status: 'started',
          conversationId: data.conversationId,
          capacitySlot: data.capacitySlot,
          admissionOnly: data.admissionOnly,
        });
        return { run: { scheduleId: data.scheduleId, scheduledFor: data.scheduledFor } };
      },
    ),
    getCapacityOccupancy: jest.fn(async () => {
      const takenSlots: number[] = [];
      let unslotted = 0;
      for (const r of runs.values()) {
        if (r.status !== 'started') {
          continue;
        }
        if (r.admissionOnly) {
          continue;
        }
        if (typeof r.capacitySlot === 'number') {
          takenSlots.push(r.capacitySlot);
        } else {
          unslotted += 1;
        }
      }
      return { takenSlots, unslotted };
    }),
    revalidateClaim: jest.fn(async () => true),
    releaseLeaseByHolder: jest.fn(async () => undefined),
    deleteScheduleRun: jest.fn(
      async (id: string, when: Date, _status?: string, expectedConversationId?: string) => {
        const k = key(id, when);
        const row = runs.get(k) as { conversationId?: string } | undefined;
        // Mirrors the conversationId fence: a fire only deletes the row IT inserted.
        if (expectedConversationId != null && row?.conversationId !== expectedConversationId) {
          return;
        }
        runs.delete(k);
      },
    ),
    setRunFireDetails: jest.fn(async () => {
      calls.setFireDetails += 1;
    }),
    recordSkippedRun: jest.fn(async (data: { status: string }) => {
      calls.skipped.push(data.status);
    }),
    recordRunOutcome: jest.fn(
      async (data: { scheduleId: string; scheduledFor: Date; status: string }) => {
        const k = key(data.scheduleId, data.scheduledFor);
        if (runs.has(k)) {
          runs.set(k, { status: data.status });
        }
        calls.recordOutcome.push({ status: data.status });
      },
    ),
  };
  return { methods, runs, calls };
}

function makeDeps(
  methods: ReturnType<typeof makeMethods>['methods'],
  over: Partial<ScheduleEngineDeps> = {},
): ScheduleEngineDeps {
  return {
    methods: methods as unknown as ScheduleEngineDeps['methods'],
    getLimits: async () => LIMITS,
    getUserContext: async () => OWNER,
    isOutOfBalance: async () => false,
    preflightMCP: jest.fn().mockResolvedValue([]),
    agentAccess: async () => 'ok',
    hasScheduleAccess: async () => true,
    resolveFiles: async () => [],
    enqueueTrigger: jest.fn(async () => undefined),
    runInTenantContext: (_user, fn) => fn(),
    getJobStatus: async () => null,
    abortScheduledJob: async () => undefined,
    clearReconciledJob: async () => undefined,
    isOwnerDeleting: async () => false,
    isGloballyDisabled: async () => false,
    countActiveRunsGlobal: async () => methods.countActiveRuns(),
    withGlobalCapacitySlot: (cap: number, claim: (slot: number) => Promise<unknown>) =>
      withCapacitySlot(
        cap,
        () => methods.getCapacityOccupancy(),
        claim as Parameters<typeof withCapacitySlot>[2],
      ),
    ...over,
  } as ScheduleEngineDeps;
}

function mockFetch(impl: () => Promise<unknown> | never) {
  global.fetch = jest.fn(impl as never) as never;
}

const okResponse = (conversationId = 'convo-1') =>
  ({
    ok: true,
    status: 200,
    // The accept path answers with JSON; fire reads the body as text and JSON-parses it.
    text: async () => JSON.stringify({ conversationId }),
  }) as Response;

const dueAt = () => new Date(Date.now() - 60_000);

afterEach(() => jest.restoreAllMocks());

/**
 * The chat route validates `clientRequestId` against `/^[A-Za-z0-9:_-]{1,128}$/`
 * (CLIENT_REQUEST_ID_PATTERN in api/server/controllers/agents/request.js). An id
 * outside that charset makes the route answer 400 INVALID_CLIENT_REQUEST_ID, which
 * fails EVERY fire — so the encoding is a contract, not a formatting choice.
 */
describe('buildFireClientRequestId', () => {
  const ROUTE_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;

  it('stays within the charset the chat route accepts', () => {
    const id = buildFireClientRequestId(
      'sched_bf55e051-b26d-4ccc-b96c-93ffaafe1a5b',
      new Date('2026-08-01T14:05:55.132Z'),
    );

    // A raw ISO instant carries a '.' in its milliseconds, which the route rejects.
    expect(id).not.toContain('.');
    expect(id).toMatch(ROUTE_PATTERN);
  });

  it('is deterministic per occurrence and distinct across occurrences', () => {
    const scheduleId = 'sched_bf55e051-b26d-4ccc-b96c-93ffaafe1a5b';
    const first = new Date('2026-08-01T14:05:55.132Z');
    const second = new Date('2026-08-01T15:05:55.132Z');

    expect(buildFireClientRequestId(scheduleId, first)).toBe(
      buildFireClientRequestId(scheduleId, new Date(first.getTime())),
    );
    expect(buildFireClientRequestId(scheduleId, first)).not.toBe(
      buildFireClientRequestId(scheduleId, second),
    );
  });

  it('stays inside the 128-character cap', () => {
    expect(
      buildFireClientRequestId(
        'sched_bf55e051-b26d-4ccc-b96c-93ffaafe1a5b',
        new Date('2026-08-01T14:05:55.132Z'),
      ).length,
    ).toBeLessThanOrEqual(128);
  });
});

describe('fireSchedule', () => {
  it('preserves a claimed occurrence when the deployment switch turns off', async () => {
    const { methods } = makeMethods();
    const getLimits = jest.fn(async () => ({ ...LIMITS, enabled: false }));
    const deps = makeDeps(methods, {
      getLimits,
    });

    const result = await fireSchedule(deps, makeSchedule(), LIMITS, dueAt());

    expect(result).toMatchObject({ fired: false, skipped: 'superseded' });
    expect(methods.advanceSchedule).not.toHaveBeenCalled();
    expect(methods.releaseLeaseByHolder).toHaveBeenCalledWith('sched-1', 'inst-1');
    expect(getLimits).toHaveBeenCalledWith();
  });

  it('fires the happy path and records fire details', async () => {
    const { methods, runs } = makeMethods();
    mockFetch(async () => okResponse());
    const result = await fireSchedule(makeDeps(methods), makeSchedule(), LIMITS, dueAt());
    expect(result.fired).toBe(true);
    // The conversation id is pre-generated and recorded on the run row up front
    // (so reconciliation can always find the occurrence's job), not read back from
    // the POST response.
    expect(result.conversationId).toMatch(/^[0-9a-f-]{36}$/);
    expect([...runs.values()][0].conversationId).toBe(result.conversationId);
    expect(methods.setRunFireDetails).toHaveBeenCalledTimes(1);
    expect([...runs.values()][0].status).toBe('started');
  });

  it('refuses to fire a cadence the engine cannot read at all', async () => {
    // A cron cadence reaches the fire path with a stored timezone croner cannot use,
    // so the next run is uncomputable: disable without dispatching.
    const { methods, runs } = makeMethods();
    mockFetch(async () => okResponse());
    const schedule = makeSchedule({
      cadence: { frequency: 'cron', expression: '0 9 * * *' },
      timezone: 'Not/AZone',
    });

    const result = await fireSchedule(makeDeps(methods), schedule, LIMITS, dueAt());

    expect(result.fired).toBe(false);
    expect(runs.size).toBe(0);
    expect(methods.disableSchedule).toHaveBeenCalledWith('sched-1', 'invalid_schedule', 'ct-1');
  });

  it('releases the old holder when a post-enqueue owner edit fences the advance', async () => {
    const { methods } = makeMethods();
    const enqueueTrigger = jest.fn(async () => undefined);
    methods.advanceSchedule.mockResolvedValueOnce(false);

    const result = await fireSchedule(
      makeDeps(methods, { enqueueTrigger }),
      makeSchedule({ leaseBy: 'claim-holder-1' }),
      LIMITS,
      dueAt(),
    );

    expect(result.fired).toBe(true);
    expect(enqueueTrigger).toHaveBeenCalledTimes(1);
    expect(methods.releaseLeaseByHolder).toHaveBeenCalledWith('sched-1', 'claim-holder-1');
  });

  it('stamps the deterministic deliveryKey on the reservation (== the enqueued key)', async () => {
    const { methods } = makeMethods();
    const enqueueTrigger = jest.fn<
      ReturnType<ScheduleEngineDeps['enqueueTrigger']>,
      Parameters<ScheduleEngineDeps['enqueueTrigger']>
    >(async () => undefined);

    const result = await fireSchedule(
      makeDeps(methods, { enqueueTrigger }),
      makeSchedule(),
      LIMITS,
      dueAt(),
    );

    expect(result.fired).toBe(true);
    const reservation = (methods.reserveStartedRun as jest.Mock).mock.calls[0][0];
    const envelope = enqueueTrigger.mock.calls[0][0];
    // Stored BEFORE enqueue and equal to the enqueued delivery's idempotency key, so
    // reconciliation can read the durable delivery for THIS occurrence even if the enqueue
    // committed ambiguously.
    expect(reservation.deliveryKey).toEqual(expect.any(String));
    expect(reservation.deliveryKey).toBe(getAgentTriggerIdempotencyKey(envelope));
  });

  it('marks a Run Now trigger as manual for downstream limiter policy', async () => {
    const { methods } = makeMethods();
    const enqueueTrigger = jest.fn<
      ReturnType<ScheduleEngineDeps['enqueueTrigger']>,
      Parameters<ScheduleEngineDeps['enqueueTrigger']>
    >(async () => undefined);
    await fireSchedule(makeDeps(methods, { enqueueTrigger }), makeSchedule(), LIMITS, dueAt(), {
      manual: true,
    });
    const envelope = enqueueTrigger.mock.calls[0][0];
    expect(envelope).toMatchObject({
      mode: 'fire',
      principal: { userId: 'user-1', role: 'USER', tenantId: 't1' },
      event: {
        type: 'schedule.occurrence',
        source: { id: 'sched-1', type: 'schedule' },
      },
      run: { metadata: { manual: true } },
    });
    expect(enqueueTrigger).toHaveBeenCalledWith(envelope, { orderingKey: 'sched-1' });
  });

  it('marks an automatic occurrence as non-manual', async () => {
    const { methods } = makeMethods();
    const enqueueTrigger = jest.fn<
      ReturnType<ScheduleEngineDeps['enqueueTrigger']>,
      Parameters<ScheduleEngineDeps['enqueueTrigger']>
    >(async () => undefined);
    await fireSchedule(makeDeps(methods, { enqueueTrigger }), makeSchedule(), LIMITS, dueAt());

    expect(enqueueTrigger.mock.calls[0][0]).toMatchObject({
      run: { metadata: { manual: false } },
    });
  });

  it('carries the claimed config revision and fire inputs on the durable trigger', async () => {
    const { methods } = makeMethods();
    const enqueueTrigger = jest.fn<
      ReturnType<ScheduleEngineDeps['enqueueTrigger']>,
      Parameters<ScheduleEngineDeps['enqueueTrigger']>
    >(async () => undefined);
    await fireSchedule(
      makeDeps(methods, {
        enqueueTrigger,
        resolveFiles: async () => [{ file_id: 'file-1' }],
      }),
      makeSchedule({ configRevision: 7, file_ids: ['file-1'] } as never),
      LIMITS,
      dueAt(),
    );
    expect(enqueueTrigger.mock.calls[0][0]).toMatchObject({
      input: 'Summarize',
      target: { agentId: 'agent-1' },
      run: {
        timezone: 'America/New_York',
        files: [{ file_id: 'file-1' }],
        metadata: { manual: false, configRevision: 7 },
      },
    });
  });

  it('records a definite trigger admission rejection as an error', async () => {
    const { methods, calls } = makeMethods();
    const result = await fireSchedule(
      makeDeps(methods, {
        enqueueTrigger: async () => {
          throw new AgentTriggerServiceUnavailableError('not initialized');
        },
      }),
      makeSchedule(),
      LIMITS,
      dueAt(),
    );
    expect(result.fired).toBe(false);
    expect(calls.recordOutcome).toEqual([{ status: 'error' }]);
  });

  it('leaves an ambiguous persistence failure reconcilable', async () => {
    const { methods, runs, calls } = makeMethods();
    const result = await fireSchedule(
      makeDeps(methods, {
        enqueueTrigger: async () => {
          throw new Error('Mongo result unknown');
        },
      }),
      makeSchedule(),
      LIMITS,
      dueAt(),
    );
    expect(result.fired).toBe(false);
    expect(calls.recordOutcome).toHaveLength(0);
    expect([...runs.values()][0].status).toBe('started');
    expect(calls.advance).toBe(1);
  });

  it('records an invalid durable delivery as a definite error', async () => {
    const { methods, runs, calls } = makeMethods();
    const result = await fireSchedule(
      makeDeps(methods, {
        enqueueTrigger: async () => {
          throw new AgentTriggerDeliveryError('invalid delivery');
        },
      }),
      makeSchedule(),
      LIMITS,
      dueAt(),
    );
    expect(result.fired).toBe(false);
    expect(calls.recordOutcome).toEqual([{ status: 'error' }]);
    expect([...runs.values()][0].status).toBe('error');
  });

  it('does not orphan a run when file resolution fails', async () => {
    const { methods, runs, calls } = makeMethods();
    mockFetch(async () => okResponse());
    const deps = makeDeps(methods, {
      resolveFiles: async () => {
        throw new Error('db down');
      },
    });
    const result = await fireSchedule(deps, makeSchedule({ file_ids: ['f1'] }), LIMITS, dueAt());
    expect(result.fired).toBe(false);
    expect(runs.size).toBe(0); // no run row created
    // Automatic fire KEEPS the claim lease as a backoff (nextRunAt untouched → the
    // occurrence retries when the lease expires) so a transient file error can't get
    // this row re-claimed every tick and starve others.
    expect(calls.releaseLease).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('releases the lease on a manual run-now when file resolution fails', async () => {
    const { methods, runs } = makeMethods();
    // An owner edit can rotate the token while the file lookup is in flight while
    // deliberately preserving this fire's unique lease holder.
    methods.releaseLease.mockResolvedValueOnce(false);
    mockFetch(async () => okResponse());
    const deps = makeDeps(methods, {
      resolveFiles: async () => {
        throw new Error('db down');
      },
    });
    const result = await fireSchedule(deps, makeSchedule({ file_ids: ['f1'] }), LIMITS, dueAt(), {
      manual: true,
    });
    expect(result.fired).toBe(false);
    expect(runs.size).toBe(0);
    // Run-now releases so the user can retry immediately (no misleading lease-held 409).
    expect(methods.releaseLease).toHaveBeenCalledWith('sched-1', 'ct-1');
    expect(methods.releaseLeaseByHolder).toHaveBeenCalledWith('sched-1', 'inst-1');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('refuses the fire at the global capacity cap WITHOUT inserting a run', async () => {
    const { methods, runs } = makeMethods();
    // All 5 slots taken → the allocator finds no free slot and never inserts.
    for (let i = 0; i < 5; i++) {
      runs.set(`other-${i}:x`, { status: 'started', capacitySlot: i });
    }
    mockFetch(async () => okResponse());
    const result = await fireSchedule(makeDeps(methods), makeSchedule(), LIMITS, dueAt());
    expect(result.skipped).toBe('capacity');
    expect(global.fetch).not.toHaveBeenCalled();
    // Slot-based capacity is decided BEFORE the write, so there is nothing to roll back.
    expect([...runs.values()].filter((r) => r.status === 'started')).toHaveLength(5);
    expect(methods.reserveStartedRun).not.toHaveBeenCalled();
    expect(methods.deleteScheduleRun).not.toHaveBeenCalled();
  });

  it('completes readiness before requesting generation capacity', async () => {
    const { methods } = makeMethods();
    const order: string[] = [];
    const deps = makeDeps(methods, {
      preflightMCP: async () => {
        order.push('readiness');
        return [];
      },
      withGlobalCapacitySlot: async (_cap, claim) => {
        order.push('generation-capacity');
        const attempt = await claim(0);
        return attempt === 'slot-taken' ? 'capacity' : attempt;
      },
    });
    mockFetch(async () => okResponse());

    await fireSchedule(deps, makeSchedule(), LIMITS, dueAt());

    expect(order).toEqual(['readiness', 'generation-capacity']);
  });

  it('does not let a principal override widen the global capacity cap', async () => {
    const { methods, runs } = makeMethods();
    // The single deployment-wide slot is already occupied.
    runs.set('other-0:x', { status: 'started', capacitySlot: 0 });
    mockFetch(async () => okResponse());
    const deps = makeDeps(methods, {
      // Base allows 1 concurrent scheduled generation; this owner's role/tenant
      // override raises their limit to 5.
      getLimits: async (user) => ({ ...LIMITS, fireConcurrency: user ? 5 : 1 }),
    });
    // Run Now resolves the OWNER's limits and skips the tick's base-config budget, so
    // without the clamp the override would hand out slots 1-4 and run five billed
    // generations against a deployment that advertises a cap of one.
    const result = await fireSchedule(deps, makeSchedule(), LIMITS, dueAt());
    expect(result.skipped).toBe('capacity');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(methods.reserveStartedRun).not.toHaveBeenCalled();
    expect(methods.releaseLease).toHaveBeenCalledWith('sched-1', 'ct-1');
  });

  it('still honors an owner override that is STRICTER than the deployment cap', async () => {
    const { methods, runs } = makeMethods();
    runs.set('other-0:x', { status: 'started', capacitySlot: 0 });
    mockFetch(async () => okResponse());
    const deps = makeDeps(methods, {
      getLimits: async (user) => ({ ...LIMITS, fireConcurrency: user ? 1 : 5 }),
    });
    // Only WIDENING is the defect; a tenant that wants less concurrency than the
    // deployment allows must still get it.
    const result = await fireSchedule(deps, makeSchedule(), LIMITS, dueAt());
    expect(result.skipped).toBe('capacity');
  });

  it('claims a free slot and never exceeds the cap when slots collide', async () => {
    const { methods, runs } = makeMethods();
    // Slots 0 and 2 are taken; the allocator must land the fire on slot 1.
    runs.set('other-a:x', { status: 'started', capacitySlot: 0 });
    runs.set('other-b:x', { status: 'started', capacitySlot: 2 });
    mockFetch(async () => okResponse());
    const result = await fireSchedule(makeDeps(methods), makeSchedule(), LIMITS, dueAt());
    expect(result.fired).toBe(true);
    const own = [...runs.entries()].find(([k]) => k.startsWith('sched-1:'));
    expect(own?.[1].capacitySlot).toBe(1);
  });

  it('re-fires cleanly next tick once capacity frees, exactly once', async () => {
    const { methods, runs } = makeMethods();
    for (let i = 0; i < 5; i++) {
      runs.set(`other-${i}:x`, { status: 'started', capacitySlot: i });
    }
    const enqueueTrigger = jest.fn(async () => undefined);
    const deps = makeDeps(methods, { enqueueTrigger });
    const schedule = makeSchedule();
    const when = dueAt();
    // Tick 1: every slot taken → refused before any insert.
    const first = await fireSchedule(deps, schedule, LIMITS, when);
    expect(first.skipped).toBe('capacity');
    // Capacity frees up before the next tick.
    runs.delete('other-0:x');
    // Tick 2: same occurrence re-claimed → now fires, exactly one live run.
    const second = await fireSchedule(deps, schedule, LIMITS, when);
    expect(second.fired).toBe(true);
    expect(methods.reserveStartedRun).toHaveBeenCalledTimes(1); // only the successful tick inserts
    expect(
      [...runs.entries()].filter(([k, r]) => k.startsWith('sched-1:') && r.status === 'started'),
    ).toHaveLength(1);
    expect(enqueueTrigger).toHaveBeenCalledTimes(1);
  });

  it('does not reserve a run when the claim already lapsed during preflight', async () => {
    const { methods, runs } = makeMethods();
    // The preflight (user/config/permission/balance/attachment queries) outlasted the
    // 5-minute lease and another worker re-claimed the occurrence.
    (methods.revalidateClaim as jest.Mock).mockResolvedValue(false);
    mockFetch(async () => okResponse());
    const result = await fireSchedule(makeDeps(methods), makeSchedule(), LIMITS, dueAt());
    expect(result.skipped).toBe('superseded');
    // Reserving here would win the occurrence's unique row: the FRESH claimer would then
    // see `duplicate` and advance without firing, while this worker's own revalidation
    // fails and rollbackReservation deliberately retains the row (leaseBy changed). The
    // occurrence would be lost with its capacity slot held until the orphan sweep.
    expect(methods.reserveStartedRun).not.toHaveBeenCalled();
    expect([...runs.entries()].some(([k]) => k.startsWith('sched-1:'))).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
    // The lease is handed back by holder so the fresh claimer is not left waiting.
    expect(methods.releaseLeaseByHolder).toHaveBeenCalledWith('sched-1', 'inst-1');
  });

  /**
   * A failed revalidation must NEVER advance. In every true supersession (takeover,
   * owner edit) the claim token rotated, so an advance would no-op anyway — the only
   * case where it can land is a PURE lease expiry with no takeover, where the token
   * never rotated. advanceSchedule checks no lease, so that advance moved nextRunAt
   * past an occurrence nothing had fired: a slow preflight silently DROPPED it
   * instead of leaving it due for the next claim to retry.
   */
  it('leaves the occurrence due when only the lease expired (no takeover)', async () => {
    const { methods } = makeMethods();
    // Same claim token, merely past leaseUntil: revalidateClaim fails on the lease
    // predicate alone while the token-fenced advance filter would still MATCH.
    (methods.revalidateClaim as jest.Mock).mockResolvedValue(false);
    mockFetch(async () => okResponse());
    const result = await fireSchedule(makeDeps(methods), makeSchedule(), LIMITS, dueAt());
    expect(result.skipped).toBe('superseded');
    expect(methods.advanceSchedule).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('never advances from any superseded branch, including post-reserve', async () => {
    const { methods } = makeMethods();
    (methods.revalidateClaim as jest.Mock).mockResolvedValueOnce(true).mockResolvedValue(false);
    mockFetch(async () => okResponse());
    const result = await fireSchedule(makeDeps(methods), makeSchedule(), LIMITS, dueAt());
    expect(result.skipped).toBe('superseded');
    expect(methods.advanceSchedule).not.toHaveBeenCalled();
  });

  /**
   * The lease can expire between the pre-reserve revalidation and the reservation
   * itself: the capacity allocator reads occupancy in between, and the preflight
   * before it can already have outlasted the 5-minute lease. Gating the rollback on
   * lease ownership stranded the row — the new holder's own reserve saw `duplicate`
   * and advanced past the occurrence without firing it, while this row held a global
   * capacity slot until the 30-minute orphan sweep.
   */
  it('deletes its own undispatched reservation even after a lease takeover', async () => {
    const { methods, runs } = makeMethods();
    // Valid at the pre-reserve check, superseded by the pre-POST one: that ordering IS
    // the scenario, since a claim already dead before reserving never reserves at all.
    (methods.revalidateClaim as jest.Mock).mockResolvedValueOnce(true).mockResolvedValue(false);
    mockFetch(async () => okResponse());
    const result = await fireSchedule(makeDeps(methods), makeSchedule(), LIMITS, dueAt());
    expect(result.skipped).toBe('superseded');
    // Nothing was dispatched for this row, so it is unambiguously this fire's garbage.
    expect(methods.deleteScheduleRun).toHaveBeenCalledWith(
      'sched-1',
      expect.any(Date),
      'started',
      expect.any(String),
    );
    expect([...runs.entries()].some(([k]) => k.startsWith('sched-1:'))).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rechecks shutdown immediately before dispatch and rolls back the reservation', async () => {
    const { methods, runs } = makeMethods();
    // The coordinator flips AFTER the pre-reservation gate: the deployment-limit
    // read, capacity allocation, and claim revalidation all run in between and can
    // overlap SIGTERM. Without the recheck the POST lands on a closing listener —
    // booked as an error (or a refused connect that advances the occurrence).
    const isShuttingDown = jest.fn().mockReturnValueOnce(false).mockReturnValue(true);
    mockFetch(async () => okResponse());
    const result = await fireSchedule(
      makeDeps(methods, { isShuttingDown }),
      makeSchedule(),
      LIMITS,
      dueAt(),
    );
    expect(result.skipped).toBe('superseded');
    expect(global.fetch).not.toHaveBeenCalled();
    // Rolled back, not advanced: the occurrence stays due for the restarted process.
    expect(methods.advanceSchedule).not.toHaveBeenCalled();
    expect([...runs.entries()].some(([k]) => k.startsWith('sched-1:'))).toBe(false);
  });

  it('deletes the reserved run when the schedule was hard-deleted mid-fire', async () => {
    const { methods, runs } = makeMethods();
    // Account deletion hard-deleted the schedule after this fire reserved its run.
    (methods.revalidateClaim as jest.Mock).mockResolvedValueOnce(true).mockResolvedValue(false);
    mockFetch(async () => okResponse());
    const result = await fireSchedule(makeDeps(methods), makeSchedule(), LIMITS, dueAt());
    expect(result.skipped).toBe('superseded');
    // The orphaned reservation (no schedule left to own it) is deleted, not leaked.
    expect(methods.deleteScheduleRun).toHaveBeenCalledWith(
      'sched-1',
      expect.any(Date),
      'started',
      expect.any(String),
    );
    expect([...runs.entries()].some(([k]) => k.startsWith('sched-1:'))).toBe(false);
  });

  it('records an unavailable trigger service as a definite error', async () => {
    const { methods, runs, calls } = makeMethods();
    const result = await fireSchedule(
      makeDeps(methods, {
        enqueueTrigger: async () => {
          throw new AgentTriggerServiceUnavailableError('not ready');
        },
      }),
      makeSchedule(),
      LIMITS,
      dueAt(),
    );
    expect(result.fired).toBe(false);
    expect(calls.recordOutcome).toEqual([{ status: 'error' }]);
    expect([...runs.values()][0].status).toBe('error');
  });

  it('skips overlap when a prior run is still active', async () => {
    const { methods, runs, calls } = makeMethods();
    runs.set('sched-1:prior', { status: 'started' });
    mockFetch(async () => okResponse());
    const result = await fireSchedule(makeDeps(methods), makeSchedule(), LIMITS, dueAt());
    expect(result.skipped).toBe('overlap');
    expect(calls.skipped).toEqual(['skipped_overlap']);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('disables and stops firing when agent VIEW access was revoked', async () => {
    const { methods, calls } = makeMethods();
    const deps = makeDeps(methods, { agentAccess: async () => 'forbidden' });
    const result = await fireSchedule(deps, makeSchedule(), LIMITS, dueAt());
    expect(result.skipped).toBe('permission_revoked');
    expect(calls.disable).toEqual(['permission_revoked']);
  });

  it('skips a duplicate occurrence (idempotency claim already held)', async () => {
    const { methods, runs } = makeMethods();
    runs.set(`sched-1:${dueAt().toISOString()}`, { status: 'requires_action' });
    mockFetch(async () => okResponse());
    const when = new Date(dueAt().getTime());
    runs.set(`sched-1:${when.toISOString()}`, { status: 'requires_action' });
    const result = await fireSchedule(makeDeps(methods), makeSchedule(), LIMITS, when);
    expect(result.skipped).toBe('duplicate');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  /**
   * A balance skip is not a no-op: it stamps the card and walks the balance-skip streak
   * toward auto-disable. The preflight above it (user, config, permission and balance
   * lookups) can outlast the 5-minute lease, so writing it under a dead claim is a write
   * on behalf of a fire that no longer owns the occurrence.
   */
  it('does not record a balance skip under a superseded claim', async () => {
    const { methods, calls } = makeMethods();
    (methods.revalidateClaim as jest.Mock).mockResolvedValue(false);
    mockFetch(async () => okResponse());

    const result = await fireSchedule(
      makeDeps(methods, { isOutOfBalance: async () => true }),
      makeSchedule(),
      LIMITS,
      dueAt(),
    );

    expect(result.skipped).toBe('superseded');
    expect(methods.recordSkippedRun).not.toHaveBeenCalled();
    expect(calls.skipped).toEqual([]);
  });

  it('records the balance skip normally while the claim is still valid', async () => {
    const { methods, calls } = makeMethods();
    mockFetch(async () => okResponse());

    const result = await fireSchedule(
      makeDeps(methods, { isOutOfBalance: async () => true }),
      makeSchedule(),
      LIMITS,
      dueAt(),
    );

    expect(result.skipped).toBe('balance');
    expect(calls.skipped).toEqual(['skipped_balance']);
  });

  /**
   * A `duplicate` means ANOTHER worker holds this occurrence's row — not that the
   * occurrence is done. Advancing past it hands the occurrence away: if that other
   * worker is a stale lease holder whose own revalidation then fails, it rolls its
   * undispatched row back and NOTHING ever fires the occurrence. Leaving nextRunAt
   * alone keeps it claimable; the worker that actually dispatches is the one that
   * advances, and the claim's lease provides the retry backoff.
   */
  /**
   * A settled-but-unadvanced occurrence (its fire was accepted, the post-accept advance
   * failed) leaves nextRunAt pointing at it. Refusing to advance on `duplicate` then
   * makes every future claim re-pick the same finished occurrence — a permanent stall.
   */
  it('advances past a duplicate whose run already settled', async () => {
    const { methods, runs, calls } = makeMethods();
    const when = new Date(dueAt().getTime());
    runs.set(`sched-1:${when.toISOString()}`, { status: 'success', conversationId: 'done' });
    mockFetch(async () => okResponse());

    const result = await fireSchedule(makeDeps(methods), makeSchedule(), LIMITS, when);

    expect(result.skipped).toBe('duplicate');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(calls.advance).toBe(1);
  });

  it('does not advance past an occurrence another worker is holding', async () => {
    const { methods, runs, calls } = makeMethods();
    const when = new Date(dueAt().getTime());
    // A peer already reserved this occurrence's row.
    runs.set(`sched-1:${when.toISOString()}`, {
      status: 'started',
      conversationId: 'peer-convo',
    });
    mockFetch(async () => okResponse());

    const result = await fireSchedule(makeDeps(methods), makeSchedule(), LIMITS, when);

    expect(result.skipped).toBe('duplicate');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(calls.advance).toBe(0);
  });

  it('releases the lease on a duplicate for run-now so the user can retry', async () => {
    const { methods, runs, calls } = makeMethods();
    const when = new Date(dueAt().getTime());
    runs.set(`sched-1:${when.toISOString()}`, { status: 'started' });
    mockFetch(async () => okResponse());

    await fireSchedule(makeDeps(methods), makeSchedule(), LIMITS, when, { manual: true });

    // Automatic claims keep the lease as backoff; a manual click must not be told
    // "already in progress" for the full lease TTL.
    expect(calls.releaseLease).toBe(1);
    expect(calls.advance).toBe(0);
  });
});

it('settles an unavailable MCP occurrence without dispatching a generation', async () => {
  const { methods } = makeMethods();
  const failure = new ScheduleMCPError([{ server: 'Notion', status: 'mcp_reauth_required' }]);
  const deps = makeDeps(methods, {
    preflightMCP: async () => {
      throw failure;
    },
  });
  const capacitySpy = jest.spyOn(deps, 'withGlobalCapacitySlot');
  const result = await fireSchedule(deps, makeSchedule(), LIMITS, new Date('2026-09-09T12:00:00Z'));
  expect(result).toMatchObject({ fired: false, mcp: failure.outcomes });
  expect(capacitySpy).not.toHaveBeenCalled();
  expect(methods.reserveStartedRun).toHaveBeenCalledWith(
    expect.objectContaining({
      admissionOnly: true,
      error: failure.message,
      mcp: failure.outcomes,
    }),
  );
  expect(deps.enqueueTrigger).not.toHaveBeenCalled();
  expect(methods.recordRunOutcome).toHaveBeenCalledWith(
    expect.objectContaining({
      error: failure.message,
      status: 'error',
      clearConversationId: true,
      mcp: failure.outcomes,
    }),
  );
});

it('does not settle or disable from a failed MCP preflight after losing its claim', async () => {
  const { methods } = makeMethods();
  (methods.revalidateClaim as jest.Mock).mockResolvedValueOnce(true).mockResolvedValue(false);
  const deps = makeDeps(methods, {
    preflightMCP: async () => {
      throw new ScheduleMCPError([{ server: 'Notion', status: 'mcp_reauth_required' }]);
    },
  });
  const result = await fireSchedule(deps, makeSchedule(), LIMITS, new Date('2026-09-09T12:00:00Z'));
  expect(result.skipped).toBe('superseded');
  expect(methods.recordRunOutcome).not.toHaveBeenCalled();
  expect(methods.advanceSchedule).not.toHaveBeenCalled();
});

it('does not invent a server outcome for infrastructure preflight failures', async () => {
  const { methods } = makeMethods();
  const deps = makeDeps(methods, {
    preflightMCP: async () => {
      throw new Error('role database unavailable with private details');
    },
  });
  const result = await fireSchedule(deps, makeSchedule(), LIMITS, new Date('2026-09-09T12:00:00Z'));
  expect(result).toMatchObject({
    fired: false,
    error: 'MCP preflight unavailable',
    mcpPreflightUnavailable: true,
  });
  expect(result.mcp).toBeUndefined();
  expect(methods.recordRunOutcome).toHaveBeenCalledWith(
    expect.objectContaining({ error: 'MCP preflight unavailable' }),
  );
});

it('bounds MCP preflight by the claim lease and the stricter concurrency config', async () => {
  const { methods } = makeMethods();
  const leaseUntil = new Date(Date.now() + 10_000);
  const failure = new ScheduleMCPError([{ server: 'Notion', status: 'mcp_unavailable' }]);
  const preflightMCP = jest.fn(async () => {
    throw failure;
  });
  const deps = makeDeps(methods, {
    preflightMCP,
    getLimits: async (user) => ({
      ...LIMITS,
      mcpPreflightConcurrency: user == null ? 2 : 5,
    }),
  });

  await fireSchedule(deps, makeSchedule({ leaseUntil }), LIMITS, new Date('2026-09-09T12:00:00Z'));

  expect(preflightMCP).toHaveBeenCalledWith(
    'agent-1',
    OWNER,
    expect.objectContaining({
      scheduleId: 'sched-1',
      concurrency: 2,
      deadlineMs: leaseUntil.getTime(),
    }),
  );
});

it('bounds MCP preflight by the stricter owner and deployment timeout', async () => {
  const { methods } = makeMethods();
  const startedAt = Date.now();
  let deadlineMs: number | undefined;
  const preflightMCP: ScheduleEngineDeps['preflightMCP'] = async (_agentId, _user, options) => {
    deadlineMs = options?.deadlineMs;
    return [];
  };
  const deps = makeDeps(methods, {
    preflightMCP,
    getLimits: async (user) => ({
      ...LIMITS,
      mcpPreflightTimeoutMs: user == null ? 12_000 : 20_000,
    }),
  });

  await fireSchedule(
    deps,
    makeSchedule({ leaseUntil: new Date(startedAt + 240_000) }),
    LIMITS,
    new Date('2026-09-09T12:00:00Z'),
  );

  expect(deadlineMs).toBeGreaterThanOrEqual(startedAt + 11_900);
  expect(deadlineMs).toBeLessThanOrEqual(Date.now() + 12_000);
});

it('cancels MCP preflight before reserving or recording a run', async () => {
  const { methods } = makeMethods();
  const controller = new AbortController();
  const deps = makeDeps(methods, {
    preflightMCP: async (_agentId, _user, options) => {
      expect(options?.signal).toBe(controller.signal);
      controller.abort(new Error('schedule engine stopped'));
      throw controller.signal.reason;
    },
  });

  const result = await fireSchedule(
    deps,
    makeSchedule(),
    LIMITS,
    new Date('2026-09-09T12:00:00Z'),
    { signal: controller.signal },
  );

  expect(result).toMatchObject({ fired: false, skipped: 'superseded' });
  // Readiness now runs before generation reservation, so cancellation has no
  // started row or capacity slot to roll back.
  expect(methods.deleteScheduleRun).not.toHaveBeenCalled();
  expect(methods.recordRunOutcome).not.toHaveBeenCalled();
  expect(methods.advanceSchedule).not.toHaveBeenCalled();
});

it('does not enqueue when Run Now is cancelled during final claim validation', async () => {
  const { methods } = makeMethods();
  const controller = new AbortController();
  let releaseValidation: () => void = () => undefined;
  let markValidationStarted: () => void = () => undefined;
  const validationStarted = new Promise<void>((resolve) => {
    markValidationStarted = resolve;
  });
  const validationGate = new Promise<void>((resolve) => {
    releaseValidation = resolve;
  });
  let validations = 0;
  (methods.revalidateClaim as jest.Mock).mockImplementation(async () => {
    validations += 1;
    if (validations === 2) {
      markValidationStarted();
      await validationGate;
    }
    return true;
  });
  const deps = makeDeps(methods);

  const pending = fireSchedule(deps, makeSchedule(), LIMITS, new Date('2026-09-09T12:00:00Z'), {
    manual: true,
    signal: controller.signal,
  });
  await validationStarted;
  controller.abort(new Error('Run Now request closed'));
  releaseValidation();
  const result = await pending;

  expect(result).toMatchObject({ fired: false, skipped: 'superseded' });
  expect(methods.deleteScheduleRun).toHaveBeenCalled();
  expect(deps.enqueueTrigger).not.toHaveBeenCalled();
  expect(methods.recordRunOutcome).not.toHaveBeenCalled();
});
