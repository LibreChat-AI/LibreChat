import { SystemCapabilities } from '@librechat/data-schemas';
import { PermissionBits, PrincipalType, ResourceType, SystemRoles } from 'librechat-data-provider';
import type { TInsightsAgent } from 'librechat-data-provider';
import type { Types } from 'mongoose';

type Principal = { principalType: PrincipalType; principalId?: string | Types.ObjectId };
type AgentRecord = { _id: Types.ObjectId; id: string; name?: string; tenantId?: string };

export type InsightsAccessUser = {
  id: string;
  role?: string;
  tenantId?: string;
  idOnTheSource?: string | null;
};

export type InsightsAgentAccessDeps = {
  getAgents: (
    filter: Record<string, unknown>,
    select?: string | Record<string, number>,
  ) => Promise<AgentRecord[]>;
  getUserPrincipals: (input: {
    userId: string;
    role?: string | null;
    idOnTheSource?: string | null;
  }) => Promise<Principal[]>;
  hasCapabilityForPrincipals: (input: {
    principals: Principal[];
    capability: typeof SystemCapabilities.READ_INSIGHTS;
    tenantId?: string;
  }) => Promise<boolean>;
  findAccessibleResources: (
    principals: Principal[],
    resourceType: ResourceType,
    requiredBits: number,
    resourceIds: Types.ObjectId[],
  ) => Promise<Types.ObjectId[]>;
};

const toChoice = (agent: AgentRecord): TInsightsAgent => ({
  id: agent.id,
  name: agent.name?.trim() || agent.id,
});

export function createInsightsAgentAccessResolver(deps: InsightsAgentAccessDeps) {
  return async (user: InsightsAccessUser): Promise<TInsightsAgent[]> => {
    const tenantFilter = user.tenantId
      ? { tenantId: user.tenantId }
      : { tenantId: { $exists: false } };
    const agentsPromise = deps.getAgents(tenantFilter, '_id id name tenantId');

    if (user.role === SystemRoles.ADMIN) {
      return (await agentsPromise)
        .map(toChoice)
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    }

    const principals = await deps.getUserPrincipals({
      userId: user.id,
      role: user.role,
      idOnTheSource: user.idOnTheSource,
    });
    const [agents, hasGlobalAccess] = await Promise.all([
      agentsPromise,
      deps.hasCapabilityForPrincipals({
        principals,
        capability: SystemCapabilities.READ_INSIGHTS,
        tenantId: user.tenantId,
      }),
    ]);

    let accessibleAgents = agents;
    if (!hasGlobalAccess && agents.length > 0) {
      const privatePrincipals = principals.filter(
        (principal) => principal.principalType !== PrincipalType.PUBLIC,
      );
      const resourceIds = await deps.findAccessibleResources(
        privatePrincipals,
        ResourceType.AGENT,
        PermissionBits.VIEW | PermissionBits.VIEW_INSIGHTS,
        agents.map((agent) => agent._id),
      );
      const allowed = new Set(resourceIds.map((id) => id.toString()));
      accessibleAgents = agents.filter((agent) => allowed.has(agent._id.toString()));
    }

    return accessibleAgents
      .map(toChoice)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  };
}
