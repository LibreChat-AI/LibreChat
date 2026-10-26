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

/** Eligibility only: detailed inspection also requires the effective YAML setting. */
export type InsightsAccess = {
  agents: TInsightsAgent[];
  detailAgentIds: string[];
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

const sortChoices = (agents: AgentRecord[]): TInsightsAgent[] =>
  agents.map(toChoice).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

function createAccessResolver(deps: InsightsAgentAccessDeps, includeEditableAgents: boolean) {
  return async (user: InsightsAccessUser): Promise<InsightsAccess> => {
    const tenantFilter = user.tenantId
      ? { tenantId: user.tenantId }
      : { tenantId: { $exists: false } };
    if (user.role === SystemRoles.ADMIN) {
      const agents = sortChoices(await deps.getAgents(tenantFilter, '_id id name tenantId'));
      return { agents, detailAgentIds: agents.map((agent) => agent.id) };
    }

    const principalsPromise = deps.getUserPrincipals({
      userId: user.id,
      role: user.role,
      idOnTheSource: user.idOnTheSource,
    });
    const [agents, principals, hasGlobalAccess] = await Promise.all([
      deps.getAgents(tenantFilter, '_id id name tenantId'),
      principalsPromise,
      principalsPromise.then((principals) =>
        deps.hasCapabilityForPrincipals({
          principals,
          capability: SystemCapabilities.READ_INSIGHTS,
          tenantId: user.tenantId,
        }),
      ),
    ]);

    if (hasGlobalAccess) {
      const choices = sortChoices(agents);
      return { agents: choices, detailAgentIds: choices.map((agent) => agent.id) };
    }
    const privatePrincipals = principals.filter(
      (principal) => principal.principalType !== PrincipalType.PUBLIC,
    );
    if (agents.length === 0 || privatePrincipals.length === 0) {
      return { agents: [], detailAgentIds: [] };
    }

    const candidates = agents.map((agent) => agent._id);
    const [detailResources, editableResources] = await Promise.all([
      deps.findAccessibleResources(
        privatePrincipals,
        ResourceType.AGENT,
        PermissionBits.VIEW | PermissionBits.VIEW_INSIGHTS,
        candidates,
      ),
      includeEditableAgents
        ? deps.findAccessibleResources(
            privatePrincipals,
            ResourceType.AGENT,
            PermissionBits.VIEW | PermissionBits.EDIT,
            candidates,
          )
        : Promise.resolve([]),
    ]);
    const detailIds = new Set(detailResources.map(String));
    const editableIds = new Set(editableResources.map(String));
    const detailAgentIds: string[] = [];
    const choices = sortChoices(
      agents.filter((agent) => {
        if (detailIds.has(String(agent._id))) {
          detailAgentIds.push(agent.id);
          return true;
        }
        return editableIds.has(String(agent._id));
      }),
    );
    return { agents: choices, detailAgentIds: detailAgentIds.sort() };
  };
}

/** Resolve aggregate access separately from existing inspection eligibility. */
export function createInsightsAccessResolver(
  deps: InsightsAgentAccessDeps,
): (user: InsightsAccessUser) => Promise<InsightsAccess> {
  return createAccessResolver(deps, true);
}

/** Preserve the existing route contract until the separate eligibility is enforced there. */
export function createInsightsAgentAccessResolver(
  deps: InsightsAgentAccessDeps,
): (user: InsightsAccessUser) => Promise<TInsightsAgent[]> {
  const resolveAccess = createAccessResolver(deps, false);
  return async (user: InsightsAccessUser): Promise<TInsightsAgent[]> =>
    (await resolveAccess(user)).agents;
}
