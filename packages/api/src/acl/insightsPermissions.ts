import { PermissionBits, PrincipalType, ResourceType, SystemRoles } from 'librechat-data-provider';
import type { TPrincipal } from 'librechat-data-provider';

export type { PermissionChange, PermissionSnapshot } from './types';

type ValidationResult = { status: 400 | 403; error: string } | null;

const hasOwn = (value: unknown, key: string): boolean =>
  value != null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key);

export function validateInsightsPermissionUpdates({
  resourceType,
  userRole,
  updatedPrincipals,
}: {
  resourceType: ResourceType;
  userRole?: string;
  updatedPrincipals: unknown[];
}): ValidationResult {
  if (resourceType !== ResourceType.AGENT) {
    return null;
  }

  const insightsUpdates = updatedPrincipals.filter((principal) =>
    hasOwn(principal, 'viewInsights'),
  );
  if (
    insightsUpdates.some(
      (principal) => typeof (principal as { viewInsights?: unknown }).viewInsights !== 'boolean',
    )
  ) {
    return { status: 400, error: 'viewInsights must be a boolean when provided' };
  }
  if (insightsUpdates.length > 0 && userRole !== SystemRoles.ADMIN) {
    return { status: 403, error: 'Only administrators can change Insights access' };
  }
  if (
    insightsUpdates.some(
      (principal) => (principal as { type?: unknown }).type === PrincipalType.PUBLIC,
    )
  ) {
    return { status: 400, error: 'Public principals cannot receive Insights access' };
  }
  return null;
}

export function maskAgentInsightsBit({
  resourceType,
  userRole,
  permBits,
}: {
  resourceType: ResourceType;
  userRole?: string;
  permBits: number;
}): number {
  return resourceType === ResourceType.AGENT && userRole !== SystemRoles.ADMIN
    ? permBits & ~PermissionBits.VIEW_INSIGHTS
    : permBits;
}

export function sanitizeInsightsPermissionPrincipals({
  resourceType,
  userRole,
  principals,
}: {
  resourceType: ResourceType;
  userRole?: string;
  principals: TPrincipal[];
}): TPrincipal[] {
  if (resourceType !== ResourceType.AGENT || userRole === SystemRoles.ADMIN) {
    return principals;
  }
  return principals.map(({ viewInsights: _protected, ...principal }) => principal);
}

export function getInsightsPrincipalState({
  principalType,
  principalRole,
  requesterRole,
  permBits,
}: {
  principalType: PrincipalType;
  principalRole?: string;
  requesterRole?: string;
  permBits: number;
}): { isAdmin?: true; viewInsights?: boolean } {
  const isAdmin =
    (principalType === PrincipalType.USER || principalType === PrincipalType.ROLE) &&
    principalRole === SystemRoles.ADMIN;
  return {
    ...(isAdmin ? { isAdmin: true } : {}),
    ...(requesterRole === SystemRoles.ADMIN
      ? {
          viewInsights: (permBits & PermissionBits.VIEW_INSIGHTS) === PermissionBits.VIEW_INSIGHTS,
        }
      : {}),
  };
}
