import {
  Permissions,
  PermissionTypes,
  SUBSCRIPTION_APPROVAL_REASON,
  DEFAULT_RUN_GRANT_LIFETIME_HOURS,
} from 'librechat-data-provider';
import type { SubscriptionIdentity, Subscription, Connection } from 'librechat-data-provider';
import type { RunGrantStorage, IUser } from '@librechat/data-schemas';
import type { RunGrantExecutionFactory, PolicyWording } from '~/agents/authority/execution';
import type { SubjectAdapter, SubjectInput } from '~/agents/authority/subject';
import type { RunGrantService } from '~/agents/authority/service';
import type { RunGrantOfferDeps } from '~/agents/authority/offer';
import type { CheckAccessParams } from '~/middleware/access';
import type { AgentAccess } from '~/schedules/access';
import { createRunGrantExecution } from '~/agents/authority/execution';
import { createRunGrantService } from '~/agents/authority/service';
import { RunGrantPolicyError } from '~/agents/authority/policy';
import { createRunGrantOffer } from '~/agents/authority/offer';
import { getAppConfigOptionsFromUser } from '~/app/service';
import { checkAccess } from '~/middleware/access';

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
  getHost: () => Pick<Adapter, 'resolve' | 'execution'>,
): Adapter {
  return {
    kind: 'subscription',
    claims: (input) => named(input) != null,
    resolve: (input) => getHost().resolve(input),
    get execution() {
      return getHost().execution;
    },
  };
}

export interface SubscriptionHost extends Pick<Adapter, 'resolve'> {
  /** What the owner may allow the subscription's runs, and the grant they made. */
  service: RunGrantService<SubscriptionIdentity>;
  execution: RunGrantExecutionFactory<SubscriptionIdentity>;
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
  /** Whether a run of this owner can pause for approval. Absent, it cannot. */
  canPauseRuns?: (user: IUser) => Promise<boolean>;
  /**
   * The longest a grant this owner makes may last, in hours, as the deployment sets it.
   * Absent, the default every grant has. It bounds the grant only: no value lifts the need
   * for one.
   */
  getMaxLifetimeHours?: (user: IUser) => Promise<number>;
  /** The owner and whether they may run the agent are supplied by this host. */
  enrollment: Omit<RunGrantOfferDeps, 'findUser' | 'canUseRoot' | 'canUseMCP'>;
}): SubscriptionHost {
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
      canPause: async (identity) => {
        const user = await loadOwner(identity, source.findUser);
        return user != null && (await deps.canPauseRuns?.(user)) === true;
      },
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
  });

  return {
    service,
    execution,
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
