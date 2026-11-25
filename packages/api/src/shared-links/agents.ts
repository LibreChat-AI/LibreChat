import { ResourceCapabilityMap } from '@librechat/data-schemas';
import {
  Permissions,
  ResourceType,
  PermissionBits,
  PermissionTypes,
  isEphemeralAgentId,
} from 'librechat-data-provider';
import type { SystemCapability } from '@librechat/data-schemas';

type Viewer = { userId: string; role?: string; idOnTheSource?: string | null; tenantId?: string };
type Role = { permissions?: { [PermissionTypes.AGENTS]?: { [Permissions.USE]?: boolean } } };

type Access<Id extends { toString(): string }, Principal> = {
  getRoleByName: (role: string) => Promise<Role | null>;
  getAgents: (
    filter: { id: { $in: string[] } },
    select: string,
  ) => Promise<{ _id: Id; id: string }[]>;
  getUserPrincipals: (viewer: Omit<Viewer, 'tenantId'>) => Promise<Principal[]>;
  hasCapabilityForPrincipals: (query: {
    principals: Principal[];
    capability: SystemCapability;
    tenantId?: string;
  }) => Promise<boolean>;
  findAccessibleResources: (
    principals: Principal[],
    resource: ResourceType,
    permission: PermissionBits,
    ids: Id[],
  ) => Promise<Id[]>;
};

/** Resolve only candidate spec agents, in the viewer's tenant. Chat still rechecks access. */
export function createSharedForkAgentAccess<Id extends { toString(): string }, Principal>(
  deps: Access<Id, Principal>,
): (viewer: Viewer, ids: string[]) => Promise<Set<string>> {
  return async ({ tenantId, ...viewer }, ids) => {
    if (!viewer.role) {
      return new Set();
    }
    const stored = ids.filter((id) => !isEphemeralAgentId(id));
    const [role, agents, principals] = await Promise.all([
      deps.getRoleByName(viewer.role),
      stored.length > 0 ? deps.getAgents({ id: { $in: stored } }, '_id id') : [],
      stored.length > 0 ? deps.getUserPrincipals(viewer) : [],
    ]);
    if (!role?.permissions?.[PermissionTypes.AGENTS]?.[Permissions.USE]) {
      return new Set();
    }
    const allowed = new Set(ids.filter(isEphemeralAgentId));
    if (agents.length === 0 || principals.length === 0) {
      return allowed;
    }
    const capability = ResourceCapabilityMap[ResourceType.AGENT];
    const [manage, viewable] = await Promise.all([
      deps.hasCapabilityForPrincipals({ principals, capability, tenantId }),
      deps.findAccessibleResources(
        principals,
        ResourceType.AGENT,
        PermissionBits.VIEW,
        agents.map((agent) => agent._id),
      ),
    ]);
    const visible = new Set(viewable.map(String));
    for (const agent of agents) {
      if (manage || visible.has(String(agent._id))) {
        allowed.add(agent.id);
      }
    }
    return allowed;
  };
}
