import { PermissionBits, ResourceType } from 'librechat-data-provider';

export interface SkillAccessParams {
  /** Whether the skills capability is enabled for the agent endpoint. */
  enabled: boolean;
  userId: string;
  role?: string | null;
}

export interface SkillAccessDeps<TId> {
  findAccessibleResources: (params: {
    userId: string;
    role?: string | null;
    resourceType: ResourceType;
    requiredPermissions: number;
  }) => Promise<TId[]>;
  /** Adds the deployment skills every user can read to the VIEW set. */
  withDeploymentSkillIds: (ids: TId[]) => TId[];
  canCreateSkill: () => Promise<boolean>;
}

export interface SkillAccess<TId> {
  accessibleSkillIds: TId[];
  editableSkillIds: TId[];
  skillCreateAllowed: boolean;
}

/**
 * Resolves which skills a user can read and edit, and whether they may create one, for an
 * agent run. The three reads are independent, so they run together; with the capability off
 * nothing is read.
 */
export async function loadSkillAccess<TId>(
  { enabled, userId, role }: SkillAccessParams,
  deps: SkillAccessDeps<TId>,
): Promise<SkillAccess<TId>> {
  if (!enabled) {
    return { accessibleSkillIds: [], editableSkillIds: [], skillCreateAllowed: false };
  }
  const [viewable, editableSkillIds, skillCreateAllowed] = await Promise.all([
    deps.findAccessibleResources({
      userId,
      role,
      resourceType: ResourceType.SKILL,
      requiredPermissions: PermissionBits.VIEW,
    }),
    deps.findAccessibleResources({
      userId,
      role,
      resourceType: ResourceType.SKILL,
      requiredPermissions: PermissionBits.EDIT,
    }),
    deps.canCreateSkill(),
  ]);
  return {
    accessibleSkillIds: deps.withDeploymentSkillIds(viewable),
    editableSkillIds,
    skillCreateAllowed,
  };
}
