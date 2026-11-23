import {
  Permissions,
  EModelEndpoint,
  PermissionTypes,
  DEFAULT_RUN_GRANT_LIFETIME_HOURS,
  scheduleOfferRequestSchema,
} from 'librechat-data-provider';
import type { ScheduleMCPConsentStorage, AppConfig, IUser } from '@librechat/data-schemas';
import type { ScheduledMCPIdentity, TCheckpointerConfig } from 'librechat-data-provider';
import type {
  RunGrantToolsResolver,
  RunGrantServersResolver,
  RunGrantService,
  RunGrantTargetResolver,
} from '~/agents/authority/service';
import type { RunGrantHandlers } from '~/agents/authority/handlers';
import type { CheckAccessParams } from '~/middleware/access';
import type { GetAppConfigOptions } from '~/app/service';
import type { SchedulesHandlersDeps } from '../handlers';
import { createRunGrantHandlers } from '~/agents/authority/handlers';
import { createRunGrantService } from '~/agents/authority/service';
import { getAppConfigOptionsFromUser } from '~/app/service';
import { checkAccess } from '~/middleware/access';

/**
 * A scheduled run waits for its owner on another day and, often, another replica. That needs
 * a shared generation store and a durable checkpointer, and an endpoint that has not turned
 * approval off.
 */
export function createScheduledPauseCheck(deps: {
  isSharedStore: () => boolean;
  getCheckpointer: (config?: TCheckpointerConfig) => Promise<unknown>;
  getAppConfig: (options: GetAppConfigOptions) => Promise<AppConfig | undefined>;
}): (user: IUser) => Promise<boolean> {
  return async (user) => {
    if (!deps.isSharedStore()) return false;
    const config = await deps.getAppConfig(getAppConfigOptionsFromUser(user));
    const agents = config?.endpoints?.[EModelEndpoint.agents];
    if (agents?.toolApproval?.enabled === false) return false;
    return (await deps.getCheckpointer(agents?.checkpointer)) != null;
  };
}

/** Whether a user's role may use MCP servers: what offering or calling an MCP tool needs. */
export function createMCPUseCheck(
  getRoleByName: CheckAccessParams['getRoleByName'],
): (user: IUser) => Promise<boolean> {
  return (user) =>
    checkAccess({
      user,
      getRoleByName,
      permissionType: PermissionTypes.MCP_SERVERS,
      permissions: [Permissions.USE],
    });
}

export function createScheduleMCPConsentHost(deps: {
  /** Where a schedule's grant is kept: its own object, as an API key's is. */
  storage: ScheduleMCPConsentStorage;
  methods: Pick<SchedulesHandlersDeps['methods'], 'getScheduleById'>;
  getLimits: SchedulesHandlersDeps['getLimits'];
  findUser: (id: string) => Promise<IUser | null>;
  getRoleByName: CheckAccessParams['getRoleByName'];
  canViewAgent: (agentId: string, user: IUser) => Promise<boolean>;
  resolveEnrollment?: RunGrantTargetResolver;
  resolveTools?: RunGrantToolsResolver;
  resolveServers?: RunGrantServersResolver;
  /** Whether a scheduled run of this owner can pause for approval. Absent, it cannot. */
  canPauseRuns?: (user: IUser) => Promise<boolean>;
}): { service: RunGrantService; handlers: RunGrantHandlers } {
  const pendingPrincipals = new Map<string, Promise<IUser | null>>();
  const loadPrincipal = (identity: ScheduledMCPIdentity): Promise<IUser | null> => {
    const key = JSON.stringify([identity.ownerId, identity.tenantId]);
    const pending = pendingPrincipals.get(key);
    if (pending) return pending;
    const lookup = Promise.resolve()
      .then(() => deps.findUser(identity.ownerId))
      .then((user) => {
        if (!user || (user.tenantId ?? null) !== identity.tenantId) return null;
        user.id = identity.ownerId;
        return user;
      })
      .finally(() => {
        pendingPrincipals.delete(key);
      });
    pendingPrincipals.set(key, lookup);
    return lookup;
  };
  const canUseMCP = createMCPUseCheck(deps.getRoleByName);
  const service = createRunGrantService({
    storage: deps.storage,
    getLimits: async (identity) => {
      const user = await loadPrincipal(identity);
      if (!user) return { enabled: false, maxLifetimeHours: DEFAULT_RUN_GRANT_LIFETIME_HOURS };
      const limits = await deps.getLimits(user);
      return {
        enabled: limits.enabled && limits.mcpConsent?.enabled === true,
        maxLifetimeHours: limits.mcpConsent?.maxLifetimeHours ?? DEFAULT_RUN_GRANT_LIFETIME_HOURS,
        ...(limits.mcpConsent?.requireAfterMs != null && {
          requireAfterMs: limits.mcpConsent.requireAfterMs,
        }),
      };
    },
    canUse: async (identity) => {
      const user = await loadPrincipal(identity);
      if (!user) return false;
      // Authorizing a schedule is not using an MCP server: a role without MCP servers may
      // still allow its agents' other tools. The MCP tools are held to `canUseMCP`.
      const permitted = await checkAccess({
        user,
        getRoleByName: deps.getRoleByName,
        permissionType: PermissionTypes.SCHEDULES,
        permissions: [Permissions.USE, Permissions.CREATE],
      });
      return permitted && (await deps.canViewAgent(identity.agentId, user));
    },
    canUseMCP: async (identity) => {
      const user = await loadPrincipal(identity);
      return user != null && (await canUseMCP(user));
    },
    resolveEnrollment: deps.resolveEnrollment,
    resolveTools: deps.resolveTools,
    resolveServers: deps.resolveServers,
    canPause: async (identity) => {
      const user = await loadPrincipal(identity);
      return user != null && (await deps.canPauseRuns?.(user)) === true;
    },
  });
  const handlers = createRunGrantHandlers({
    service,
    // A schedule being created has no id yet. The offer is bound to its owner and agent.
    resolveDraft: async (req): Promise<ScheduledMCPIdentity | null> => {
      const parsed = scheduleOfferRequestSchema.safeParse(req.body);
      if (!req.user || !parsed.success) return null;
      return {
        scheduleId: 'draft',
        ownerId: req.user.id,
        tenantId: req.user.tenantId ?? null,
        agentId: parsed.data.agent_id,
        invocationMode: 'delegated',
      };
    },
    resolveIdentity: async (req): Promise<ScheduledMCPIdentity | null> => {
      const user = req.user;
      const { id } = req.params as { id: string };
      if (!user) return null;
      const schedule = await deps.methods.getScheduleById(id, user.id);
      if (!schedule || (schedule.tenantId ?? null) !== (user.tenantId ?? null)) return null;
      return {
        scheduleId: schedule.id,
        ownerId: user.id,
        tenantId: user.tenantId ?? null,
        agentId: schedule.agent_id,
        invocationMode: 'delegated',
      };
    },
  });
  return { service, handlers };
}
