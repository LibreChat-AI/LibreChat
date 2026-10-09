import { PermissionBits, PrincipalType, ResourceType, SystemRoles } from 'librechat-data-provider';
import type {
  IAclEntry,
  IUser,
  RecordAuditEntryInput,
  RecordAuditEntryOptions,
} from '@librechat/data-schemas';
import type { TPrincipal } from 'librechat-data-provider';
import type { Types } from 'mongoose';
import type { ServerRequest } from '~/types';
import { buildAuditContext } from '~/admin/context';

export type InsightsPermissionPrincipal = {
  type: PrincipalType;
  id?: string | Types.ObjectId | null;
  name?: string;
};

export type InsightsWrittenEntry = {
  permBits: number;
  roleId: Types.ObjectId;
  grantedBy: string | Types.ObjectId;
  grantedAt: Date;
};

export type InsightsPermissionChange = {
  action: 'assigned' | 'removed';
  previousEntry: IAclEntry | null;
  writtenEntry: InsightsWrittenEntry | null;
  principal: InsightsPermissionPrincipal;
};

type ValidationResult = { status: 400 | 403; error: string } | null;

type AuditDeps = {
  getAgent: (
    filter: Record<string, unknown>,
    projection: string,
  ) => Promise<{ id: string; name?: string } | null>;
  recordAuditEntry: (
    input: RecordAuditEntryInput,
    options?: RecordAuditEntryOptions,
  ) => Promise<unknown>;
  restoreInsightsPermissionChanges: (changes: InsightsPermissionChange[]) => Promise<void>;
  logger: {
    error: (message: string, error?: unknown) => void;
  };
};

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

function statusError(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 500 });
}

export async function auditInsightsPermissionChanges({
  req,
  resourceId,
  changes,
  failClosed,
  deps,
}: {
  req: ServerRequest;
  resourceId: string;
  changes: InsightsPermissionChange[];
  failClosed: boolean;
  deps: AuditDeps;
}): Promise<void> {
  if (changes.length === 0) {
    return;
  }

  const user = req.user as IUser | undefined;
  const actorId = user?._id?.toString() ?? user?.id;
  if (!user || !actorId) {
    throw statusError('Authenticated user required for Insights permission audit');
  }

  let agent: { id: string; name?: string } | null;
  try {
    agent = await deps.getAgent(
      {
        _id: resourceId,
        ...(user.tenantId ? { tenantId: user.tenantId } : { tenantId: { $exists: false } }),
      },
      '_id id name',
    );
    if (!agent) {
      throw new Error('Agent not found for Insights permission audit');
    }
  } catch (error) {
    if (!failClosed) {
      deps.logger.error('[InsightsPermissions] Audit target lookup failed', error);
      return;
    }
    await deps
      .restoreInsightsPermissionChanges(changes)
      .catch((restoreError) =>
        deps.logger.error('[InsightsPermissions] Permission rollback failed', restoreError),
      );
    throw statusError(
      error instanceof Error ? error.message : 'Insights audit target lookup failed',
    );
  }

  const actorName = user.name || user.username || user.email || actorId;
  for (let index = 0; index < changes.length; index++) {
    const change = changes[index];
    const input: RecordAuditEntryInput = {
      action:
        change.action === 'assigned'
          ? 'permission.insights_assigned'
          : 'permission.insights_removed',
      outcome: 'success',
      severity: 'warning',
      actor: { type: 'user', id: actorId, name: actorName },
      target: { type: ResourceType.AGENT, id: agent.id, name: agent.name || agent.id },
      metadata: {
        principalType: change.principal.type,
        principalId: change.principal.id?.toString() ?? '',
      },
      context: buildAuditContext(req),
      tenantId: user.tenantId,
    };
    try {
      await deps.recordAuditEntry(input, { failClosed });
    } catch (error) {
      if (failClosed) {
        await deps
          .restoreInsightsPermissionChanges(changes.slice(index))
          .catch((restoreError) =>
            deps.logger.error('[InsightsPermissions] Permission rollback failed', restoreError),
          );
        throw statusError(error instanceof Error ? error.message : 'Insights audit failed');
      }
      deps.logger.error('[InsightsPermissions] Audit persistence failed', error);
    }
  }
}
