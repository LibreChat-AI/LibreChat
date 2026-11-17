import {
  Permissions,
  EModelEndpoint,
  PermissionTypes,
  DEFAULT_SCHEDULE_MCP_CONSENT_LIFETIME_HOURS,
} from 'librechat-data-provider';
import type { AgentKeyMCPIdentity, ScheduledMCPResourceBinding } from 'librechat-data-provider';
import type { MCPConsentStorage, AppConfig, IUser } from '@librechat/data-schemas';
import type {
  ScheduleMCPConsentHandlers,
  ScheduleMCPConsentService,
  ScheduleMCPEnrollmentDeps,
  ScheduleMCPExecutionFactory,
} from '~/schedules';
import type { ExecutionContext } from '~/agents/authority/context';
import type { CheckAccessParams } from '~/middleware/access';
import type { ApiKeyAuthRequest } from './middleware';
import {
  ScheduledMCPPolicyError,
  createScheduleMCPExecution,
  createScheduleMCPConsentService,
  createScheduleMCPConsentHandlers,
  createScheduleMCPEnrollmentResolver,
} from '~/schedules';
import { getBackgroundResponseWorkerRecord } from '~/agents/responses/worker';
import { getAppConfigOptionsFromUser } from '~/app/service';
import { getMCPRequestContext } from '~/mcp/request';
import { checkAccess } from '~/middleware/access';

export interface RemoteIntegrations {
  /** `owner`: every server the key's owner can use. `delegated`: only what a grant covers. */
  mode: 'owner' | 'delegated';
  maxLifetimeHours: number;
  resources?: Record<string, ScheduledMCPResourceBinding>;
}

/** How runs started through the remote agent API may use the owner's MCP servers. */
export function resolveRemoteIntegrations(appConfig?: AppConfig): RemoteIntegrations {
  const integrations = appConfig?.endpoints?.[EModelEndpoint.agents]?.remoteApi?.integrations;
  return {
    mode: integrations?.mode ?? 'owner',
    maxLifetimeHours: integrations?.maxLifetimeHours ?? DEFAULT_SCHEDULE_MCP_CONSENT_LIFETIME_HOURS,
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

export interface AgentKeyMCPGrantHost {
  service: ScheduleMCPConsentService<AgentKeyMCPIdentity>;
  handlers: ScheduleMCPConsentHandlers;
  execution: ScheduleMCPExecutionFactory<AgentKeyMCPIdentity>;
  /**
   * Puts a run started with a personal API key under that key's grant for the agent, so every
   * MCP call is checked against it. Does nothing where the operator left key runs unrestricted,
   * and for a run no personal key started.
   */
  prepare: (input: {
    /** The authenticated request. Its MCP tools are built against this request's context. */
    req: ApiKeyAuthRequest;
    res?: Parameters<typeof getMCPRequestContext>[1];
    executionContext?: ExecutionContext;
    signal?: AbortSignal;
  }) => Promise<void>;
}

/**
 * The grants an API key's owner makes for it: which MCP servers and tools a run started with
 * that key may use, per agent. The same consent service and per-call check as a schedule's
 * grant, held on the key instead.
 */
export function createAgentKeyMCPGrantHost(deps: {
  storage: MCPConsentStorage<AgentKeyMCPIdentity>;
  findUser: (id: string) => Promise<IUser | null>;
  getRoleByName: CheckAccessParams['getRoleByName'];
  /** Whether the owner may run this agent through the remote API. */
  canUseAgent: (agentId: string, user: IUser) => Promise<boolean>;
  enrollment: ScheduleMCPEnrollmentDeps;
}): AgentKeyMCPGrantHost {
  const loadOwner = async (identity: AgentKeyMCPIdentity): Promise<IUser | null> => {
    const user = await deps.findUser(identity.ownerId);
    if (!user || (user.tenantId ?? null) !== identity.tenantId) return null;
    user.id = identity.ownerId;
    return user;
  };
  const integrationsFor = async (user: {
    id: string;
    tenantId?: string;
    role?: string;
  }): Promise<RemoteIntegrations> =>
    resolveRemoteIntegrations(
      await deps.enrollment.getAppConfig({
        ...getAppConfigOptionsFromUser(user),
        failClosed: true,
      }),
    );

  const service = createScheduleMCPConsentService<AgentKeyMCPIdentity>({
    storage: deps.storage,
    getLimits: async (identity) => {
      const user = await loadOwner(identity);
      if (!user)
        return { enabled: false, maxLifetimeHours: DEFAULT_SCHEDULE_MCP_CONSENT_LIFETIME_HOURS };
      const integrations = await integrationsFor(user);
      return {
        enabled: integrations.mode === 'delegated',
        maxLifetimeHours: integrations.maxLifetimeHours,
      };
    },
    canUse: async (identity) => {
      const user = await loadOwner(identity);
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
      return permissions.every(Boolean) && (await deps.canUseAgent(identity.agentId, user));
    },
    resolveEnrollment: createScheduleMCPEnrollmentResolver<AgentKeyMCPIdentity>(deps.enrollment, {
      resources: (appConfig) => resolveRemoteIntegrations(appConfig).resources,
      otherTools: 'ignore',
    }),
  });

  const execution = createScheduleMCPExecution<AgentKeyMCPIdentity>({
    storage: deps.storage,
    loadAuthorization: async () => ({ authority: service.authority }),
    // Under `delegated`, a key with no grant for the agent may not use MCP tools at all.
    requiresGrant: async () => true,
  });

  const handlers = createScheduleMCPConsentHandlers<AgentKeyMCPIdentity>({
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

  return {
    service,
    handlers,
    execution,
    async prepare({ req, res, executionContext, signal }) {
      const source = executionContext?.source;
      const agentId = executionContext?.agentId;
      const user = req.user;
      if (source?.type !== 'remote_api' || source.keyId == null || !user) return;
      signal?.throwIfAborted();
      // Resolved again, fail-closed, and not read from the request: a config that fell back to
      // the deployment's base during an override outage must not read as "unrestricted".
      if ((await integrationsFor(user)).mode !== 'delegated') return;
      const context = getMCPRequestContext(req, res);
      // An agent the run cannot name, a request with nowhere to hold the check, or a key the
      // store no longer finds, is not a reason to run unrestricted.
      if (!agentId || !context) throw new ScheduledMCPPolicyError('binding_mismatch', '');
      const identity: AgentKeyMCPIdentity = {
        keyId: source.keyId,
        ownerId: user.id,
        tenantId: user.tenantId ?? null,
        agentId,
        invocationMode: 'delegated',
      };
      if (!(await execution.attach(context, identity, 'invoke')))
        throw new ScheduledMCPPolicyError('binding_mismatch', '', agentId);
      signal?.throwIfAborted();
    },
  };
}
