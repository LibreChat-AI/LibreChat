import {
  Permissions,
  PermissionTypes,
  SUBSCRIPTION_APPROVAL_REASON,
  DEFAULT_RUN_GRANT_LIFETIME_HOURS,
} from 'librechat-data-provider';
import type {
  RunGrantStorage,
  RecordedRunRef,
  Subscriptions,
  TriggerRuns,
  IUser,
} from '@librechat/data-schemas';
import type {
  ScheduleMCPOutcome,
  SubscriptionIdentity,
  Subscription,
  Connection,
} from 'librechat-data-provider';
import type { RunGrantExecutionFactory, PolicyWording } from '~/agents/authority/execution';
import type { SubjectAdapter, SubjectInput, Settle } from '~/agents/authority/subject';
import type { PreflightDeps, PreflightOptions } from '~/agents/authority/preflight';
import type { ExecutionContext } from '~/agents/authority/context';
import type { RunGrantService } from '~/agents/authority/service';
import type { RunGrantOfferDeps } from '~/agents/authority/offer';
import type { CheckAccessParams } from '~/middleware/access';
import type { AgentAccess } from '~/schedules/access';
import type { RunSettings } from './settings';
import { createRunGrantExecution } from '~/agents/authority/execution';
import { createRunGrantService } from '~/agents/authority/service';
import { RunGrantPolicyError } from '~/agents/authority/policy';
import { createPreflight } from '~/agents/authority/preflight';
import { createRunGrantOffer } from '~/agents/authority/offer';
import { createReadyCache } from '~/agents/authority/ready';
import { getAppConfigOptionsFromUser } from '~/app/service';
import { checkAccess } from '~/middleware/access';
import { runSettings } from './settings';

/** A subscription's wording. Both strings are read outside this code: by the model and the client. */
export const SUBSCRIPTION_WORDING: PolicyWording = {
  leftOut: 'The owner of this event subscription has not allowed this tool. Continue without it.',
  ask: SUBSCRIPTION_APPROVAL_REASON,
};

export interface SubscriptionInput extends SubjectInput {
  /** The request the trigger host made for the delivery, as the subscription's owner. */
  req: SubjectInput['req'] & { user?: { id: string; tenantId?: string; role?: string } };
}

type Adapter = SubjectAdapter<SubscriptionIdentity, SubscriptionInput>;

/** The subscription a run's context says it acts for, whichever of the run's turns this is. */
function named({ executionContext }: SubscriptionInput): string | undefined {
  const source = executionContext?.source;
  if (source?.type !== 'trigger' || source.subject?.kind !== 'subscription') return;
  return source.subject.id;
}

/**
 * The subscription subject: a delivery an event subscription matched, the resume of a run it
 * started, and the turns that report work such a run sent to the background. Each names the
 * subscription in the run's context, which only the server writes. Its host is built only
 * for a request it claims.
 */
export function subscriptionSubject(
  getHost: () => Pick<SubscriptionHost, 'resolve' | 'execution' | 'settle'>,
): Adapter {
  return {
    kind: 'subscription',
    claims: (input) => named(input) != null,
    resolve: (input) => getHost().resolve(input),
    settle: (run) => getHost().settle(run),
    get execution() {
      return getHost().execution;
    },
  };
}

/** How long a subscription reuses a check that an MCP server is ready, when nothing sets it. */
export const DEFAULT_READY_TTL_SECONDS = 300;

/**
 * Whether the MCP servers a subscription's run would use are ready, for its owner and under
 * its grant. Resolves with every server ready; throws `PreflightError` naming those that are not.
 */
export type SubscriptionPreflight = (
  agentId: string,
  principal: { readonly id: string; readonly tenantId?: string },
  options: Omit<PreflightOptions<SubscriptionIdentity>, 'identity'> & { subscriptionId: string },
) => Promise<ScheduleMCPOutcome[]>;

/** Why a subscription's delivery was not run, beside the refusal its grant check reads as. */
export type RunRefusalCode = 'blocked' | 'duplicate' | 'capped';

/**
 * A subscription's delivery its run record refused. `blocked`: the record cannot hold the
 * run's row yet. `duplicate`: this delivery already has a run. `capped`: the subscription has
 * started as many runs this hour as it may. Never retried: a retry would be refused the same.
 */
export class RunRefusal extends RunGrantPolicyError {
  readonly refusal: RunRefusalCode;
  constructor(refusal: RunRefusalCode, agentId?: string) {
    super(refusal === 'blocked' ? 'dependency_unavailable' : 'binding_mismatch', '', agentId);
    this.name = 'RunRefusal';
    this.refusal = refusal;
  }
}

/**
 * The run's own record: the subscription and the delivery that started it. Nothing for a turn
 * that reports earlier work, whose run is the one that began it and is recorded there, or for
 * a context that names no subscription or no delivery key.
 */
function recordOf(executionContext?: ExecutionContext): RunRef | undefined {
  const source = executionContext?.source;
  if (source?.type !== 'trigger' || source.subject?.kind !== 'subscription' || source.origin)
    return;
  const key = source.delivery?.key;
  if (!key) return;
  return {
    subject: { kind: 'subscription', id: source.subject.id },
    delivery: { key, event: { occurredAt: source.delivery.event.occurredAt } },
  };
}

/** A subscription's run, found by its delivery's key. */
type RunRef = RecordedRunRef & { readonly delivery: { readonly key: string } };

/** How a run that ended counts into its subscription's failure streak; a skip counts not at all. */
function counted(status: string): { failed: boolean } | undefined {
  if (status === 'success') return { failed: false };
  // As for a schedule: an interrupted run, stopped, preempted or cut off by a restart, neither
  // counts as a failure nor ends the streak.
  if (status === 'error') return { failed: true };
  return undefined;
}

/**
 * The stable reasons a run's row may keep, by the fixed text the chat route ends a turn with.
 * Anything else, such as a provider's or a tool's error text, is stored as `run_failed`:
 * the row is read by the owner, and an error's own words may carry what it was given.
 */
const REASONS: Readonly<Record<string, string>> = {
  'Scheduled run was stopped': 'stopped',
  'Scheduled run was interrupted before completion': 'preempted',
  'Scheduled run reached its tool call limit before completion': 'step_limit',
  'Scheduled run ended with an error response': 'error_response',
  'Request aborted during initialization': 'initialization_aborted',
};

/** The code a run's row keeps for how it ended; nothing for a run that names no error. */
export function runReason(error?: string): string | undefined {
  if (!error) return undefined;
  return REASONS[error] ?? 'run_failed';
}

/** The generation job store, asked for one conversation's current generation. */
export interface JobSource {
  getJobStore():
    | { getJob(id: string): Promise<{ status: string; createdAt: number } | null> }
    | null
    | undefined;
}

export interface SubscriptionHost extends Pick<Adapter, 'resolve'> {
  /** Records how a turn of a subscription's run ended. */
  settle: NonNullable<Adapter['settle']>;
  /** The deployment's bounds on a subscription's runs, as its config now sets them. */
  bounds: () => Promise<RunSettings>;
  /**
   * Finishes the subscription runs nobody else will: an active run whose own generation is no
   * longer running or paused, ended as interrupted, which does not count into its streak, and
   * an ended run whose subscription step never landed. Only a settle records a run's real
   * outcome. Run as the system; answers how many it finished.
   */
  reconcile: () => Promise<number>;
  /** What the owner may allow the subscription's runs, and the grant they made. */
  service: RunGrantService<SubscriptionIdentity>;
  execution: RunGrantExecutionFactory<SubscriptionIdentity>;
  /** Present when the host was given what a readiness check needs. */
  preflight?: SubscriptionPreflight;
}

/**
 * Holds a subscription's runs to what its owner allowed. A subscription is scoped: with no
 * grant its runs load and use none of the agent's tools, whatever schedules are allowed,
 * because the text that starts such a run is written by people outside the deployment.
 *
 * A run starts only while the subscription is live: it exists for this owner and agent, is
 * turned on, its connection is active, its owner may still use the agent, and the grant it
 * holds, if any, was made for the subscription as it now stands. That is asked afresh for
 * every delivery, resume and reporting turn.
 */
export function createSubscriptionHost(deps: {
  storage: RunGrantStorage<SubscriptionIdentity>;
  /** The owner's subscription by id, or `null`. */
  getSubscription: (id: string, owner: string) => Promise<Subscription | null>;
  /** A connection of the caller's tenant by id, or `null`. */
  getConnection: (id: string) => Promise<Connection | null>;
  findUser: (id: string) => Promise<IUser | null>;
  getRoleByName: CheckAccessParams['getRoleByName'];
  /** The owner's access to the agent now. Only `ok` lets a run start or a grant be made. */
  access: (agentId: string, user: IUser) => Promise<AgentAccess>;
  /** The record a subscription's runs are kept in. */
  runs: Pick<
    TriggerRuns,
    'reserve' | 'skip' | 'pause' | 'finish' | 'settled' | 'stranded' | 'count'
  >;
  /** The subscription's hourly count and failure streak. */
  usage: Pick<Subscriptions, 'take' | 'tally'>;
  /** The generation job store: which generation a run is, and whether it still runs. */
  jobs: JobSource;
  /**
   * The longest a grant this owner makes may last, in hours, as the deployment sets it.
   * Absent, the default every grant has. It bounds the grant only: no value lifts the need
   * for one.
   */
  getMaxLifetimeHours?: (user: IUser) => Promise<number>;
  /** The owner and whether they may run the agent are supplied by this host. */
  enrollment: Omit<RunGrantOfferDeps, 'findUser' | 'canUseRoot' | 'canUseMCP'>;
  /** What checking that the servers a run needs are ready reads and connects with. */
  readiness?: Omit<PreflightDeps<SubscriptionIdentity>, 'execution'>;
}): SubscriptionHost {
  // Ready listings this process reuses for subscriptions alone: schedules and keys keep none.
  // How long one is reused is the deployment's `endpoints.agents.events.readyTtlSeconds`, which
  // only librechat.yaml sets, read from the base configuration for every check.
  const ready = createReadyCache({
    ttlMs: async () => {
      const config = await deps.enrollment.getAppConfig({ baseOnly: true });
      const seconds = config?.endpoints?.agents?.events?.readyTtlSeconds;
      return (seconds ?? DEFAULT_READY_TTL_SECONDS) * 1000;
    },
  });
  const loadOwner = async (
    identity: Pick<SubscriptionIdentity, 'ownerId' | 'tenantId'>,
    findUser = deps.findUser,
  ): Promise<IUser | null> => {
    const user = await findUser(identity.ownerId);
    if (!user || (user.tenantId ?? null) !== identity.tenantId) return null;
    user.id = identity.ownerId;
    return user;
  };
  /** Whether the owner's role still allows event subscriptions, and they may run the agent. */
  const canUseAgent = async (agentId: string, user: IUser): Promise<boolean> => {
    const [permitted, access] = await Promise.all([
      checkAccess({
        user,
        getRoleByName: deps.getRoleByName,
        permissionType: PermissionTypes.AGENT_EVENTS,
        permissions: [Permissions.USE],
      }),
      deps.access(agentId, user),
    ]);
    return permitted && access === 'ok';
  };
  const canUseMCP = (user: IUser): Promise<boolean> =>
    checkAccess({
      user,
      getRoleByName: deps.getRoleByName,
      permissionType: PermissionTypes.MCP_SERVERS,
      permissions: [Permissions.USE],
    });

  /** The consent service over one way of reading the owner and their configuration. */
  const createService = (source: Pick<RunGrantOfferDeps, 'findUser' | 'getAppConfig'>) => {
    // No server is declared for subscriptions, so none is offered as a recipient to bind:
    // the agents' MCP tools are offered among their other tools, by the key the agent has
    // each by, and one that is allowed is called as the owner's own use would call it.
    const offer = createRunGrantOffer<SubscriptionIdentity>(
      { ...deps.enrollment, ...source, canUseRoot: canUseAgent, canUseMCP },
      { resources: () => undefined, otherTools: 'offer' },
    );
    return createRunGrantService<SubscriptionIdentity>({
      storage: deps.storage,
      // A subscription always needs its grant, from the moment it is created.
      getLimits: async (identity) => {
        const user = deps.getMaxLifetimeHours && (await loadOwner(identity, source.findUser));
        return {
          enabled: true,
          maxLifetimeHours: user
            ? await deps.getMaxLifetimeHours!(user)
            : DEFAULT_RUN_GRANT_LIFETIME_HOURS,
          requireAfterMs: 0,
        };
      },
      canUse: async (identity) => {
        const user = await loadOwner(identity, source.findUser);
        return user != null && (await canUseAgent(identity.agentId, user));
      },
      canUseMCP: async (identity) => {
        const user = await loadOwner(identity, source.findUser);
        return user != null && (await canUseMCP(user));
      },
      resolveEnrollment: offer.targets,
      resolveTools: offer.tools,
      resolveServers: offer.servers,
      // A subscription's run does not pause for its owner: nothing yet records the run again
      // when a resume finishes it, so a call that would ask first is refused instead.
      canPause: async () => false,
    });
  };
  const service = createService({
    findUser: deps.findUser,
    getAppConfig: deps.enrollment.getAppConfig,
  });

  const execution = createRunGrantExecution<SubscriptionIdentity>({
    storage: {
      ...deps.storage,
      // A grant made for an earlier revision of the subscription is not one a run can be put
      // under: the owner has not seen what it would now allow. Read as unusable, it refuses
      // the run where a missing grant would only leave the run without tools.
      async readRunGrant(identity) {
        const snapshot = await deps.storage.readRunGrant(identity);
        if (!snapshot?.enrollment) return snapshot;
        return snapshot.enrollment.scheduleRevision === snapshot.configRevision
          ? snapshot
          : { ...snapshot, compatible: false };
      },
    },
    async loadAuthorization(identity) {
      // Private to this attempt. The owner and their configuration are read once and shared
      // by the access check and the offer; nothing resolved here outlives it.
      const user = await loadOwner(identity);
      const config = user
        ? await deps.enrollment.getAppConfig({
            ...getAppConfigOptionsFromUser(user),
            failClosed: true,
          })
        : undefined;
      return {
        authority: createService({ findUser: async () => user, getAppConfig: async () => config })
          .authority,
      };
    },
    // Asked of nothing and never false: no setting lifts it.
    requiresGrant: async () => true,
    // The grant covers the whole run: the agents' other tools load only if it lists them.
    coversTools: true,
    // And with no grant, nothing a grant could list is loaded at all.
    scoped: true,
    // A background task's completion turn finds the subscription by the trigger the task kept.
    detaches: true,
    wording: SUBSCRIPTION_WORDING,
    // A call the server refused for the owner's sign-in: that server is checked afresh next time.
    rejected: (identity, server) => ready.forget(identity.ownerId, server),
  });
  const check =
    deps.readiness &&
    createPreflight<SubscriptionIdentity>({ ...deps.readiness, execution }, {}, ready);
  const preflight: SubscriptionPreflight | undefined =
    check &&
    ((agentId, principal, { subscriptionId, ...options }) =>
      check(agentId, principal, {
        ...options,
        identity: {
          subscriptionId,
          ownerId: principal.id,
          tenantId: principal.tenantId ?? null,
          agentId,
          invocationMode: 'delegated',
        },
      }));

  /** The requests that put a run on record, each the only one that may settle it. */
  const started = new WeakSet<object>();

  const settings = async (): Promise<RunSettings> =>
    runSettings(
      (await deps.enrollment.getAppConfig({ baseOnly: true }))?.endpoints?.agents?.events,
    );

  /**
   * Puts a delivery's first turn on record, inside its subscription's hourly cap. A delivery
   * over the cap is recorded as skipped and not run. The hour is counted before the row is
   * written, so a delivery retried after the count, or delivered twice, counts again: the cap
   * errs toward fewer runs, never more.
   */
  async function start(
    ref: RunRef,
    subscription: Subscription,
    owner: IUser,
    req: SubscriptionInput['req'],
  ) {
    const { agentId } = subscription;
    // The conversation is the generation's own key, fixed before the run is initialized, so
    // a sweep can ask whether the run's generation still lives from the moment it is on record.
    const conversationId = req.body?.conversationId;
    const named = typeof conversationId === 'string' && conversationId ? conversationId : undefined;
    // The generation this request created for the run, before the run was initialized: a later
    // turn in the same conversation is another generation, created at another time.
    const job = named ? await deps.jobs.getJobStore()?.getJob(named) : undefined;
    const row = {
      user: owner.id as never,
      ...(owner.tenantId != null && { tenantId: owner.tenantId }),
      ...(named && { conversationId: named }),
      ...(job != null && { jobCreatedAt: new Date(job.createdAt) }),
      firedAt: new Date(),
      configRevision: subscription.revision,
    };
    const bounds = await settings();
    const perHour = Math.min(subscription.cap?.perHour ?? bounds.perHour, bounds.maxPerHour);
    if (!(await deps.usage.take(subscription.id, owner.id, perHour))) {
      await deps.runs.skip(ref, { ...row, status: 'skipped_cap' });
      throw new RunRefusal('capped', agentId);
    }
    const reserved = await deps.runs.reserve(ref, row);
    if ('conflict' in reserved) {
      throw new RunRefusal(reserved.conflict === 'blocked' ? 'blocked' : 'duplicate', agentId);
    }
    started.add(req);
  }

  /** The subscription's own step for a run that ended: its failure streak, then the mark. */
  async function account(ref: RunRef, owner: string, status: string, revision?: number) {
    const count = counted(status);
    // The row records that its run was counted, by the one writer that marks it, so a replay
    // counts nothing however many runs were counted since. Marked first: a crash before the
    // tally leaves the run uncounted, never counted twice.
    if (count && (await deps.runs.count(ref))) {
      const { failures } = await settings();
      // Fenced on the revision the run started under: a run older than the owner's last edit,
      // or than turning it back on, does not count into the streak that edit started.
      const run = { key: ref.delivery.key, ...count, ...(revision != null && { revision }) };
      await deps.usage.tally(ref.subject.id, owner, run, failures);
    }
    await deps.runs.settled(ref);
  }

  async function settle(run: Settle): Promise<boolean> {
    const ref = recordOf(run.executionContext);
    const owner = run.executionContext?.principal.userId;
    // Only the request that put the run on record settles it. A delivery refused as a duplicate
    // names the same row, which belongs to the request still running it.
    if (!ref || !owner || !run.request || !started.has(run.request)) return true;
    if (run.status === 'requires_action') {
      const held = await deps.runs.pause(ref, {
        ...(run.conversationId && { conversationId: run.conversationId }),
        ...(run.checkpointNamespace && { checkpointNamespace: run.checkpointNamespace }),
      });
      return held != null;
    }
    const reason = runReason(run.error);
    const ended = await deps.runs.finish(ref, {
      status: run.status,
      ...(reason && { error: reason }),
      ...(run.conversationId && { conversationId: run.conversationId }),
      ...(run.clearConversationId && { clearConversationId: true }),
    });
    if (ended == null) return false;
    await account(ref, owner, ended.status, ended.revision);
    return true;
  }

  /** Whether the generation a run was reserved with is the one still running or paused. */
  async function live(run: { conversationId?: string; jobCreatedAt?: Date }): Promise<boolean> {
    if (!run.conversationId || run.jobCreatedAt == null) return false;
    const job = await deps.jobs.getJobStore()?.getJob(run.conversationId);
    if (job == null || job.createdAt !== new Date(run.jobCreatedAt).getTime()) return false;
    return job.status === 'running' || job.status === 'requires_action';
  }

  async function reconcile(): Promise<number> {
    const { staleMs } = await settings();
    const stranded = await deps.runs.stranded('subscription', new Date(Date.now() - staleMs), 50);
    let finished = 0;
    for (const { ref, run } of stranded) {
      try {
        let status: string = run.status;
        if (run.status === 'started' || run.status === 'requires_action') {
          if (await live(run)) continue;
          // Its own generation is gone or ended without a settle: nothing here knows how the run
          // went, so it is interrupted, which counts neither for nor against the streak.
          const written = await deps.runs.finish(ref, { status: 'interrupted' });
          if (written == null) continue;
          status = written.status;
        }
        await account(ref as RunRef, run.owner, status, run.revision);
        finished++;
      } catch {
        // One row that cannot be finished now is left for the next pass; the rest go on.
      }
    }
    return finished;
  }

  return {
    service,
    execution,
    ...(preflight && { preflight }),
    settle,
    reconcile,
    bounds: settings,
    async resolve(input) {
      const subscriptionId = named(input);
      if (subscriptionId == null) return;
      const { req, context, executionContext, approvedToolCalls } = input;
      const source = executionContext?.source;
      const agentId = executionContext?.agentId;
      const user = req.user;
      // A run that names a subscription is under it or does not start: a request with no
      // owner, no agent, or nowhere to hold the check is not a reason to run unrestricted.
      if (source?.type !== 'trigger' || !user || !agentId || !context)
        throw new RunGrantPolicyError('binding_mismatch', '', agentId);
      const identity: SubscriptionIdentity = {
        subscriptionId,
        ownerId: user.id,
        tenantId: user.tenantId ?? null,
        agentId,
        invocationMode: 'delegated',
      };
      const [subscription, owner] = await Promise.all([
        deps.getSubscription(subscriptionId, user.id),
        loadOwner(identity),
      ]);
      // Gone, for another agent, or turned off. That it is this owner's, in this tenant, is
      // held by the grant's own read below, which finds nothing for anyone else.
      if (!subscription || !owner || subscription.agentId !== agentId || !subscription.enabled)
        throw new RunGrantPolicyError('binding_mismatch', '', agentId);
      const [connection, allowed] = await Promise.all([
        deps.getConnection(subscription.connection),
        canUseAgent(agentId, owner),
      ]);
      if (connection?.status !== 'active')
        throw new RunGrantPolicyError('provider_missing', '', agentId);
      if (!allowed) throw new RunGrantPolicyError('rbac_denied', '', agentId);
      // A delivery's first turn is put on record; a resume and a turn that reports earlier
      // work belong to a run already there.
      const ref = source.resumed ? undefined : recordOf(executionContext);
      if (ref) await start(ref, subscription, owner, req);
      return {
        identity,
        context,
        stage: source.resumed ? 'resume' : 'invoke',
        // With a grant or with none, the run is put under the subscription or does not start.
        require: 'run',
        agentId,
        options: {
          // A turn that reports earlier work is addressed to the agent that began it.
          ...(source.origin && { completion: true }),
          // Only a resumed run can carry approvals: a fresh delivery has asked nobody yet.
          ...(source.resumed && { approvedToolCalls }),
        },
      };
    },
  };
}
