import {
  Permissions,
  EModelEndpoint,
  PermissionTypes,
  DEFAULT_RUN_GRANT_LIFETIME_HOURS,
} from 'librechat-data-provider';
import type { AgentKeyMCPIdentity, RunGrantResourceBinding } from 'librechat-data-provider';
import type { RunGrantStorage, AppConfig, IUser } from '@librechat/data-schemas';
import type { SubjectAdapter, SubjectInput } from '~/agents/authority/subject';
import type { RunGrantExecutionFactory } from '~/agents/authority/execution';
import type { RunGrantHandlers } from '~/agents/authority/handlers';
import type { RunGrantService } from '~/agents/authority/service';
import type { RunGrantOfferDeps } from '~/agents/authority/offer';
import type { CheckAccessParams } from '~/middleware/access';
import type { ApiKeyAuthRequest } from './middleware';
import { getBackgroundResponseWorkerRecord } from '~/agents/responses/worker';
import { createRunGrantTargetResolver } from '~/agents/authority/offer';
import { createRunGrantExecution } from '~/agents/authority/execution';
import { createRunGrantHandlers } from '~/agents/authority/handlers';
import { createRunGrantService } from '~/agents/authority/service';
import { RunGrantPolicyError } from '~/agents/authority/policy';
import { getAppConfigOptionsFromUser } from '~/app/service';
import { getSourceKey } from '~/agents/authority/context';
import { getMCPRequestContext } from '~/mcp/request';
import { placeRun } from '~/agents/authority/host';
import { checkRemoteAgentAccess } from './service';
import { checkAccess } from '~/middleware/access';

type RemoteAgentAccessParams = Parameters<typeof checkRemoteAgentAccess>[0];

export interface RemoteIntegrations {
  /**
   * `owner`, the default: every server the key's owner can use. `delegated`: only what a grant
   * covers.
   */
  mode: 'owner' | 'delegated';
  maxLifetimeHours: number;
  resources?: Record<string, RunGrantResourceBinding>;
}

/** How runs started through the remote agent API may use the owner's MCP servers. */
export function resolveRemoteIntegrations(appConfig?: AppConfig): RemoteIntegrations {
  const integrations = appConfig?.endpoints?.[EModelEndpoint.agents]?.remoteApi?.integrations;
  return {
    mode: integrations?.mode ?? 'owner',
    maxLifetimeHours: integrations?.maxLifetimeHours ?? DEFAULT_RUN_GRANT_LIFETIME_HOURS,
    ...(integrations?.resources && { resources: integrations.resources }),
  };
}

/**
 * The personal API key a remote request runs under: the one it authenticated with, or, for a
 * background Responses worker, the one its admitted record was created with. A key issued to
 * an integration is not the owner's personal key and holds no grants.
 */
export function getRemoteRunKeyId(req: ApiKeyAuthRequest): string | undefined {
  if (req.apiKeyBound === true) return undefined;
  return req.apiKeyId ?? getBackgroundResponseWorkerRecord(req)?.sourceKeyId ?? undefined;
}

export interface KeyInput extends SubjectInput {
  /**
   * The authenticated request. Its MCP tools are built against this request's context. A
   * request a key authenticated names the key; one the trigger host made does not, and the
   * run's context does: for a key's delivery, and for the turn that reports work a key's
   * run sent to the background.
   */
  req: SubjectInput['req'] &
    Pick<ApiKeyAuthRequest, 'apiKeyId'> & {
      user?: { id: string; tenantId?: string; role?: string };
    };
  res?: Parameters<typeof getMCPRequestContext>[1];
}

type Key = SubjectAdapter<AgentKeyMCPIdentity, KeyInput>;

/** Whether the run names a personal key, whichever way the key started it. */
const names = ({ req, executionContext }: KeyInput): boolean =>
  getSourceKey(executionContext) != null && req.user != null;

export interface AgentKeyMCPGrantHost extends Pick<Key, 'resolve'> {
  service: RunGrantService<AgentKeyMCPIdentity>;
  handlers: RunGrantHandlers;
  execution: RunGrantExecutionFactory<AgentKeyMCPIdentity>;
  /**
   * Puts a run started with a personal API key under that key's grant for the agent, so every
   * MCP call is checked against it. Does nothing where the operator left key runs unrestricted,
   * and for a run no personal key started. The remote API's controllers call it themselves.
   */
  prepare: (input: KeyInput) => Promise<void>;
}

/**
 * The API key subject: a run a personal key started, through the remote API or by posting an
 * event, and the turns and resumes that belong to it, which name the key in the run's
 * context. Its host is built only for a request it claims. A failure reaches the caller as
 * it is: a key has no run record for it to be stored on.
 */
export function keySubject(getHost: () => Pick<Key, 'resolve' | 'execution'>): Key {
  return {
    kind: 'key',
    // A run the remote API started names its key too, and its controller has put it under
    // the key already: only a delivery of the trigger engine is claimed here.
    claims: (input) => input.executionContext?.source.type === 'trigger' && names(input),
    resolve: (input) => getHost().resolve(input),
    get execution() {
      return getHost().execution;
    },
  };
}

/**
 * The grants an API key's owner makes for it: which MCP servers and tools a run started with
 * that key may use, per agent. The same consent service and per-call check as a schedule's
 * grant, held on the key instead.
 */
export function createAgentKeyMCPGrantHost(deps: {
  storage: RunGrantStorage<AgentKeyMCPIdentity>;
  findUser: (id: string) => Promise<IUser | null>;
  getRoleByName: CheckAccessParams['getRoleByName'];
  /** Read to decide whether the owner may run an agent through the remote API. */
  getAgent: RemoteAgentAccessParams['getAgent'];
  getEffectivePermissions: RemoteAgentAccessParams['getEffectivePermissions'];
  /** The stored key a run names, to tell a personal key from one issued to an integration. */
  getKey: (keyId: string, userId: string) => Promise<{ binding?: unknown } | null>;
  /** The owner and whether they may run the agent are supplied by this host. */
  enrollment: Omit<RunGrantOfferDeps, 'findUser' | 'canUseRoot'>;
}): AgentKeyMCPGrantHost {
  const canUseAgent = async (agentId: string, user: IUser): Promise<boolean> =>
    (
      await checkRemoteAgentAccess({
        userId: user.id,
        role: user.role,
        agentId,
        getAgent: deps.getAgent,
        getEffectivePermissions: deps.getEffectivePermissions,
      })
    ).hasAccess;
  const integrationsFor = async (
    user: { id: string; tenantId?: string; role?: string },
    getAppConfig = deps.enrollment.getAppConfig,
  ): Promise<RemoteIntegrations> =>
    resolveRemoteIntegrations(
      await getAppConfig({ ...getAppConfigOptionsFromUser(user), failClosed: true }),
    );

  const loadOwner = async (
    identity: AgentKeyMCPIdentity,
    findUser = deps.findUser,
  ): Promise<IUser | null> => {
    const user = await findUser(identity.ownerId);
    if (!user || (user.tenantId ?? null) !== identity.tenantId) return null;
    user.id = identity.ownerId;
    return user;
  };

  /** The consent service over one way of reading the owner and their configuration. */
  const createService = (source: Pick<RunGrantOfferDeps, 'findUser' | 'getAppConfig'>) => {
    return createRunGrantService<AgentKeyMCPIdentity>({
      storage: deps.storage,
      getLimits: async (identity) => {
        const user = await loadOwner(identity, source.findUser);
        if (!user) return { enabled: false, maxLifetimeHours: DEFAULT_RUN_GRANT_LIFETIME_HOURS };
        const integrations = await integrationsFor(user, source.getAppConfig);
        return {
          enabled: integrations.mode === 'delegated',
          maxLifetimeHours: integrations.maxLifetimeHours,
        };
      },
      canUse: async (identity) => {
        const user = await loadOwner(identity, source.findUser);
        if (!user) return false;
        const permissions = await Promise.all([
          checkAccess({
            user,
            getRoleByName: deps.getRoleByName,
            permissionType: PermissionTypes.REMOTE_AGENTS,
            permissions: [Permissions.USE],
          }),
          checkAccess({
            user,
            getRoleByName: deps.getRoleByName,
            permissionType: PermissionTypes.MCP_SERVERS,
            permissions: [Permissions.USE],
          }),
        ]);
        return permissions.every(Boolean) && (await canUseAgent(identity.agentId, user));
      },
      resolveEnrollment: createRunGrantTargetResolver<AgentKeyMCPIdentity>(
        { ...deps.enrollment, ...source, canUseRoot: canUseAgent },
        {
          resources: (appConfig) => resolveRemoteIntegrations(appConfig).resources,
          otherTools: 'ignore',
        },
      ),
    });
  };
  const service = createService({
    findUser: deps.findUser,
    getAppConfig: deps.enrollment.getAppConfig,
  });

  const execution = createRunGrantExecution<AgentKeyMCPIdentity>({
    storage: deps.storage,
    async loadAuthorization(identity) {
      // Private to this attempt. The owner and their configuration are read once and shared
      // by the access check, the limits and the offer; nothing resolved here outlives it.
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
    // Under `delegated`, a key with no grant for the agent may not use MCP tools at all.
    requiresGrant: async () => true,
    // A background task's completion turn finds the key again by the trigger the task kept.
    detaches: true,
  });

  const handlers = createRunGrantHandlers<AgentKeyMCPIdentity>({
    service,
    resolveIdentity: async (req) => {
      const user = req.user;
      const { id, agentId } = req.params as { id?: string; agentId?: string };
      if (!user?.id || !id || !agentId) return null;
      return {
        keyId: id,
        ownerId: user.id,
        tenantId: user.tenantId ?? null,
        agentId,
        invocationMode: 'delegated',
      };
    },
  });

  const host: AgentKeyMCPGrantHost = {
    service,
    handlers,
    execution,
    async resolve({ req, res, executionContext }) {
      const keyId = getSourceKey(executionContext);
      const agentId = executionContext?.agentId;
      const user = req.user;
      if (keyId == null || !user) return;
      // Resolved again, fail-closed, and not read from the request: a config that fell back to
      // the deployment's base during an override outage must not read as "unrestricted".
      if ((await integrationsFor(user)).mode !== 'delegated') return;
      // A background worker rebuilds the request from its admitted record, which names the key
      // but not what kind it is. One issued to an integration holds no grants, here as on the
      // request that started the run. A key that is gone is refused below with any other.
      if (req.apiKeyId == null && (await deps.getKey(keyId, user.id))?.binding != null) return;
      const context = getMCPRequestContext(req, res);
      // An agent the run cannot name, a request with nowhere to hold the check, or a key the
      // store no longer finds, is not a reason to run unrestricted.
      if (!agentId || !context) throw new RunGrantPolicyError('binding_mismatch', '');
      return {
        identity: {
          keyId,
          ownerId: user.id,
          tenantId: user.tenantId ?? null,
          agentId,
          invocationMode: 'delegated',
        },
        context,
        stage: 'invoke',
        // Under `delegated` a key's run is under the key or does not start.
        require: 'run',
        agentId,
      };
    },
    prepare: (input) => placeRun([{ ...keySubject(() => host), claims: names }], input),
  };
  return host;
}
