import type { SchedulesServiceDeps } from './service';
import { createSchedulesService } from './service';

/** Swappable per test: whether the stream store is SHARED across replicas. */
let mockIsRedis = false;

jest.mock('../stream/GenerationJobManager', () => ({
  GenerationJobManager: {
    getJobStore: () => null,
    abortJob: jest.fn(),
    get isRedis() {
      return mockIsRedis;
    },
  },
}));

type Cfg = { interfaceConfig?: { schedules?: unknown } };

function makeService(base: Cfg, merged: Cfg = base) {
  const deps = {
    methods: {
      countActiveRuns: jest.fn(async () => 0),
      getCapacityOccupancy: jest.fn(async () => ({ takenSlots: [], unslotted: 0 })),
      ensureScheduleIndexes: jest.fn(async () => undefined),
      acquireManualRunLease: jest.fn(async () => null),
    },
    getAppConfig: jest.fn(async (options?: { baseOnly?: boolean }) =>
      options?.baseOnly === true ? base : merged,
    ),
    findUserById: jest.fn(async () => null),
    findBalance: jest.fn(async () => null),
    upsertBalance: jest.fn(async () => null),
    initializeNullBalance: jest.fn(async () => null),
    preflightMCP: jest.fn().mockResolvedValue([]),
    resolveAgentFireAccess: jest.fn(async () => 'ok' as const),
    getChatProject: jest.fn(async () => ({ _id: 'proj-1' })),
    isUserDeleting: jest.fn(async () => false),
    enqueueAgentTrigger: jest.fn(async () => undefined),
    getTriggerDelivery: jest.fn(async () => null),
  } as unknown as SchedulesServiceDeps;
  return createSchedulesService(deps);
}

const schedule = { id: 's1', user: 'u1' } as never;
const limits = {
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

describe('v1 experimental gate, asserted at real entry points', () => {
  beforeEach(() => {
    // The harness mocks an in-memory job store, so every arming assertion below needs
    // the single-replica assertion the topology gate demands (see isTopologySafeToArm).
    process.env.SCHEDULES_SINGLE_PROCESS = 'true';
  });

  afterEach(() => {
    mockIsRedis = false;
    delete process.env.SCHEDULES_DISABLED;
    delete process.env.SCHEDULES_SINGLE_PROCESS;
  });

  it('REFUSES to arm on a process-local job store with no single-replica assertion', async () => {
    delete process.env.SCHEDULES_SINGLE_PROCESS;
    // The standard entrypoint arms the scheduler in EVERY replica. With a process-local
    // store a peer sees the globally visible `started` row but not its job, and after the
    // orphan cutoff marks a still-running generation interrupted and frees its capacity.
    // A process cannot count its own replicas, so unproven means refuse.
    const service = makeService({ interfaceConfig: { schedules: true } });
    expect(await service.initializeScheduleEngine()).toBeUndefined();
  });

  it('arms on a SHARED job store without any assertion, since replicas see each other', async () => {
    delete process.env.SCHEDULES_SINGLE_PROCESS;
    mockIsRedis = true;
    const service = makeService({ interfaceConfig: { schedules: true } });
    expect(await service.initializeScheduleEngine()).toBeDefined();
  });

  it('is OFF for limits when the admin never opted in', async () => {
    expect((await makeService({}).getLimits()).enabled).toBe(false);
  });

  it('STILL arms the engine when globally stopped, so reconciliation can settle prior state', async () => {
    // The engine owns firing AND reconciliation. Refusing to start would strand `started`
    // rows and preserved jobs left by a previous process until scheduling is re-enabled.
    // Firing is gated separately (runTick + getLimits), so nothing fires.
    const service = makeService({ interfaceConfig: { schedules: false } });
    expect(await service.initializeScheduleEngine()).toBeDefined();
    expect((await service.getLimits()).enabled).toBe(false);
  });

  it('reports limits DISABLED under the SCHEDULES_DISABLED lever, so writes and fires refuse', async () => {
    process.env.SCHEDULES_DISABLED = 'true';
    // Even with an explicit opt-in, the env stop must be visible wherever limits are
    // consulted — not only at the engine tick.
    const service = makeService({ interfaceConfig: { schedules: true } });
    expect((await service.getLimits()).enabled).toBe(false);
    expect(await service.engineDeps.isGloballyDisabled()).toBe(true);
  });

  it('DOES arm the engine when the base is merely absent, so principal-scoped enables work', async () => {
    // Gating engine start on the base config would never start it for a role/user that
    // enables schedules via override, and would leave schedulesReady false so their
    // writes are rejected outright. Absent base is not a global stop; the fire path and
    // write handlers still refuse owners who do not have it enabled.
    const service = makeService({}, { interfaceConfig: { schedules: { use: true } } });
    expect(await service.initializeScheduleEngine()).toBeDefined();
  });

  it('stays OFF for an explicit false', async () => {
    expect((await makeService({ interfaceConfig: { schedules: false } }).getLimits()).enabled).toBe(
      false,
    );
  });

  it('turns ON for an explicit opt-in', async () => {
    expect((await makeService({ interfaceConfig: { schedules: true } }).getLimits()).enabled).toBe(
      true,
    );
    const tuned = makeService({
      interfaceConfig: {
        schedules: { maxPerUser: 3, admissionConcurrency: 12, mcpPreflightConcurrency: 2 },
      },
    });
    const resolved = await tuned.getLimits();
    expect(resolved.enabled).toBe(true);
    expect(resolved.maxPerUser).toBe(3);
    expect(resolved.admissionConcurrency).toBe(12);
    expect(resolved.mcpPreflightConcurrency).toBe(2);
  });

  it('REFUSES a manual run-now while the global kill switch is on', async () => {
    // Run Now dispatches the same billed generation as an automatic fire, so gating only
    // the engine tick would leave this path open.
    process.env.SCHEDULES_DISABLED = 'true';
    const service = makeService({ interfaceConfig: { schedules: true } });
    const result = await service.fireScheduleNow(schedule, limits);
    expect(result).toEqual({ fired: false, skipped: 'disabled' });
  });

  it('refuses run-now when the BASE config disables it, even if a principal re-enables', async () => {
    const service = makeService(
      { interfaceConfig: { schedules: false } },
      { interfaceConfig: { schedules: true } },
    );
    const result = await service.fireScheduleNow(schedule, limits);
    expect(result).toEqual({ fired: false, skipped: 'disabled' });
  });

  it('constructing the service without a required dep fails LOUDLY at boot', () => {
    // The JS adapter is not typechecked against SchedulesServiceDeps, which is how the
    // deletion-barrier probe shipped unwired twice. A missing dep must not surface as a
    // cryptic per-fire "is not a function".
    expect(() =>
      createSchedulesService({
        methods: {},
        getAppConfig: jest.fn(),
        findUserById: jest.fn(),
        findBalance: jest.fn(),
        upsertBalance: jest.fn(),
        initializeNullBalance: jest.fn(),
        preflightMCP: jest.fn().mockResolvedValue([]),
        resolveAgentFireAccess: jest.fn(),
        getChatProject: jest.fn(),
      } as unknown as SchedulesServiceDeps),
    ).toThrow(/isUserDeleting/);
  });
});
