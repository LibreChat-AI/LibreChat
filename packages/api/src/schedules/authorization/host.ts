import {
  Permissions,
  PermissionTypes,
  DEFAULT_SCHEDULE_MCP_CONSENT_LIFETIME_HOURS,
} from 'librechat-data-provider';
import type { ScheduleMCPConsentStorage } from '@librechat/data-schemas';
import type { ScheduledMCPIdentity } from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import type {
  ScheduleMCPEnrollmentResolver,
  ScheduleMCPConsentDeps,
  ScheduleMCPConsentService,
} from './service';
import type { ScheduleMCPConsentHandlers } from './handlers';
import type { CheckAccessParams } from '~/middleware/access';
import type { SchedulesHandlersDeps } from '../handlers';
import { createScheduleMCPConsentHandlers } from './handlers';
import { createScheduleMCPConsentService } from './service';
import { checkAccess } from '~/middleware/access';

export function createScheduleMCPConsentHost(deps: {
  methods: ScheduleMCPConsentStorage & Pick<SchedulesHandlersDeps['methods'], 'getScheduleById'>;
  getLimits: SchedulesHandlersDeps['getLimits'];
  findUser: (id: string) => Promise<IUser | null>;
  getRoleByName: CheckAccessParams['getRoleByName'];
  canViewAgent: (agentId: string, user: IUser) => Promise<boolean>;
  resolveEnrollment?: ScheduleMCPEnrollmentResolver;
  checkToolPolicy?: ScheduleMCPConsentDeps['checkToolPolicy'];
}): { service: ScheduleMCPConsentService; handlers: ScheduleMCPConsentHandlers } {
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
  const service = createScheduleMCPConsentService({
    storage: deps.methods,
    getLimits: async (identity) => {
      const user = await loadPrincipal(identity);
      if (!user)
        return { enabled: false, maxLifetimeHours: DEFAULT_SCHEDULE_MCP_CONSENT_LIFETIME_HOURS };
      const limits = await deps.getLimits(user);
      return {
        enabled: limits.enabled && limits.mcpConsent?.enabled === true,
        maxLifetimeHours:
          limits.mcpConsent?.maxLifetimeHours ?? DEFAULT_SCHEDULE_MCP_CONSENT_LIFETIME_HOURS,
      };
    },
    canUse: async (identity) => {
      const user = await loadPrincipal(identity);
      if (!user) return false;
      const permissions = await Promise.all([
        checkAccess({
          user,
          getRoleByName: deps.getRoleByName,
          permissionType: PermissionTypes.SCHEDULES,
          permissions: [Permissions.USE, Permissions.CREATE],
        }),
        checkAccess({
          user,
          getRoleByName: deps.getRoleByName,
          permissionType: PermissionTypes.MCP_SERVERS,
          permissions: [Permissions.USE],
        }),
      ]);
      return permissions.every(Boolean) && (await deps.canViewAgent(identity.agentId, user));
    },
    resolveEnrollment: deps.resolveEnrollment,
    checkToolPolicy: deps.checkToolPolicy,
  });
  const handlers = createScheduleMCPConsentHandlers({
    service,
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
