import { PrincipalType, ResourceType } from 'librechat-data-provider';
import type { RecordAuditEntryInput } from '@librechat/data-schemas';
import type { RecordAuditEntry } from '~/admin/audit';
import type { PermissionChange } from './types';
import type { ServerRequest } from '~/types';
import { getAuditActor, isAuditFailClosed } from '~/admin/audit';
import { PERMISSION_AUDIT_UNAVAILABLE } from './codes';
import { getSafeErrorMetadata } from '~/utils/errors';
import { buildAuditContext } from '~/admin/context';

const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;

/** Mongo casts ObjectId hex of any case to one id, so non-role principals are audited in lowercase. */
const canonicalPrincipalId = (type: string, id: unknown): string => {
  const raw = id == null ? '' : id.toString();
  return type !== PrincipalType.ROLE && OBJECT_ID_HEX.test(raw) ? raw.toLowerCase() : raw;
};

export type AuditPlanItem = {
  input: RecordAuditEntryInput;
  /** Grants or widens access; only these are held back when the audit store is down. */
  widening: boolean;
};

type AclAuditDeps = {
  recordAuditEntry: RecordAuditEntry;
  logger: { error: (message: string, error?: unknown) => void };
};

const safeMeta = (error: unknown) => ({ ...getSafeErrorMetadata(error) });

function statusError(message: string, code?: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 500, ...(code && { code }) });
}

/** A new grant, an added permission bit or a public enable; anything else only narrows access. */
const widensAccess = (change: PermissionChange): boolean =>
  change.action === 'assigned' &&
  (change.previous == null || ((change.written?.permBits ?? 0) & ~change.previous.permBits) !== 0);

function buildEvent(
  change: PermissionChange,
): Pick<RecordAuditEntryInput, 'action' | 'metadata'> | null {
  const { previous, written, principal } = change;
  const isPublic = principal.type === PrincipalType.PUBLIC;
  const previousBits = previous?.permBits ?? 0;
  const permBits = written?.permBits ?? 0;
  if (change.action === 'assigned') {
    const unchanged =
      previous != null &&
      written != null &&
      previous.roleId === written.roleId &&
      previousBits === permBits;
    if (unchanged) {
      return null;
    }
  }
  const metadata = {
    principalType: principal.type,
    principalId: canonicalPrincipalId(principal.type, principal.id),
    permBits,
    previousPermBits: previousBits,
    roleId: written?.roleId ?? '',
    previousRoleId: previous?.roleId ?? '',
  };
  if (isPublic) {
    return {
      action: 'acl.public_changed',
      metadata: { ...metadata, enabled: change.action === 'assigned' },
    };
  }
  /** A pure reduction of bits removes access, so it is reported as a revocation. */
  const reduced =
    previous != null && (previousBits & ~permBits) !== 0 && (permBits & ~previousBits) === 0;
  return {
    action: change.action === 'assigned' && !reduced ? 'acl.granted' : 'acl.revoked',
    metadata,
  };
}

type InsightsPlanDeps = {
  getAgent: (
    filter: Record<string, unknown>,
    projection: string,
  ) => Promise<{ id: string; name?: string } | null>;
  logger: AclAuditDeps['logger'];
};

type AgentTarget = { id: string; name: string };

/** The lookup only decorates the entry; a failure must not skip the audit. */
async function lookupAgentTarget({
  req,
  resourceId,
  deps,
}: {
  req: ServerRequest;
  resourceId: string;
  deps: InsightsPlanDeps;
}): Promise<AgentTarget> {
  let agent: { id: string; name?: string } | null = null;
  try {
    agent = await deps.getAgent(
      {
        _id: resourceId,
        ...(req.user?.tenantId
          ? { tenantId: req.user.tenantId }
          : { tenantId: { $exists: false } }),
      },
      '_id id name',
    );
  } catch (error) {
    deps.logger.error('[InsightsPermissions] Audit target lookup failed', safeMeta(error));
  }
  return { id: agent?.id ?? resourceId, name: agent?.name || agent?.id || resourceId };
}

/** Builds one `permission.insights_*` entry per Insights transition. */
export async function planInsightsAudit(args: {
  req: ServerRequest;
  resourceId: string;
  changes: PermissionChange[];
  deps: InsightsPlanDeps;
  /** The resolved agent target, when the caller already looked it up. */
  target?: AgentTarget;
}): Promise<AuditPlanItem[]> {
  const { req, resourceId, changes, deps } = args;
  if (changes.length === 0) {
    return [];
  }
  const actor = getAuditActor(req);
  if (!actor) {
    throw statusError('Authenticated user required for Insights permission audit');
  }
  const target = args.target ?? (await lookupAgentTarget({ req, resourceId, deps }));
  const context = buildAuditContext(req);
  return changes.map((change) => ({
    widening: change.action === 'assigned',
    input: {
      action:
        change.action === 'assigned'
          ? 'permission.insights_assigned'
          : 'permission.insights_removed',
      outcome: 'success',
      severity: 'warning',
      actor,
      target: { type: 'agent', ...target },
      metadata: {
        principalType: change.principal.type,
        principalId: canonicalPrincipalId(change.principal.type, change.principal.id),
        /** The database id, present however the agent's logical id resolved, for correlation. */
        resourceId,
      },
      context,
      tenantId: req.user?.tenantId,
    },
  }));
}

/** Builds one `acl.*` entry per effective grant, revoke and public change. */
export function planResourceAudit({
  req,
  resourceType,
  resourceId,
  changes,
  targetId = resourceId,
}: {
  req: ServerRequest;
  resourceType: ResourceType;
  resourceId: string;
  changes: PermissionChange[];
  /** The id the resource is audited under; defaults to the route id. */
  targetId?: string;
}): AuditPlanItem[] {
  if (changes.length === 0) {
    return [];
  }
  const actor = getAuditActor(req);
  if (!actor) {
    throw statusError('Authenticated user required for permission audit');
  }
  const context = buildAuditContext(req);
  const items: AuditPlanItem[] = [];
  for (const change of changes) {
    const event = buildEvent(change);
    if (event) {
      items.push({
        widening: widensAccess(change),
        input: {
          ...event,
          metadata: { ...event.metadata, resourceId },
          outcome: 'success',
          severity: 'warning',
          actor,
          target: { type: resourceType, id: targetId },
          context,
          tenantId: req.user?.tenantId,
        },
      });
    }
  }
  return items;
}

export type PermissionPlan = {
  aclChanges: PermissionChange[];
  insightsChanges: PermissionChange[];
};

/**
 * Audits a resource permission update before it is written. `update` receives a
 * `beforeWrite` hook to call with the computed changes ahead of any ACL write:
 * it records one `acl.*` entry per grant, revoke and public change, plus the
 * agent Insights entries when `getAgent` is given. With `failClosed`, a failed
 * audit write throws, so the request fails with the ACL untouched. If the ACL
 * write then fails, the entries already recorded are followed by matching
 * `failure` entries (best effort), so the log never claims a change that did
 * not happen. Entries carry ids and permission bits only, never names or emails.
 */
export async function runAuditedPermissionUpdate<T>({
  req,
  resourceType,
  resourceId: rawResourceId,
  failClosed = isAuditFailClosed(),
  deps,
  update,
}: {
  req: ServerRequest;
  resourceType: ResourceType;
  resourceId: string;
  /** Overrides `isAuditFailClosed()`. */
  failClosed?: boolean;
  deps: AclAuditDeps & { getAgent?: InsightsPlanDeps['getAgent'] };
  /** `afterWrite` retries deferred revocation entries; call it while the resource lease is still held. */
  update: (
    beforeWrite: (plan: PermissionPlan) => Promise<void>,
    afterWrite: () => Promise<void>,
  ) => Promise<T>;
}): Promise<T> {
  /** Mongoose casts uppercase and lowercase ObjectId hex to one id, so audit targets use the lowercase form. */
  const resourceId = OBJECT_ID_HEX.test(rawResourceId)
    ? rawResourceId.toLowerCase()
    : rawResourceId;
  const recorded: AuditPlanItem[] = [];
  const recordFailures = async () => {
    const items = recorded.splice(0);
    for (const item of items) {
      try {
        await deps.recordAuditEntry({ ...item.input, outcome: 'failure' });
      } catch (error) {
        deps.logger.error(
          '[ResourcePermissions] Audit failure entry not persisted',
          safeMeta(error),
        );
      }
    }
  };
  const deferred: AuditPlanItem[] = [];
  /** Set once the write is durable; a later error must not relabel recorded changes as failed. */
  let committed = false;
  const afterWrite = async () => {
    committed = true;
    await flushDeferred();
  };
  const flushDeferred = async () => {
    for (const item of deferred.splice(0)) {
      try {
        await deps.recordAuditEntry(item.input);
      } catch (error) {
        deps.logger.error('[ResourcePermissions] Revocation audit not persisted', safeMeta(error));
      }
    }
  };
  try {
    const result = await update(async ({ aclChanges, insightsChanges }) => {
      let items: AuditPlanItem[];
      try {
        const insightsDeps =
          resourceType === ResourceType.AGENT && deps.getAgent
            ? { getAgent: deps.getAgent, logger: deps.logger }
            : null;
        const target =
          insightsDeps && (aclChanges.length > 0 || insightsChanges.length > 0)
            ? await lookupAgentTarget({ req, resourceId, deps: insightsDeps })
            : undefined;
        items = [
          ...planResourceAudit({
            req,
            resourceType,
            resourceId,
            changes: aclChanges,
            targetId: target?.id,
          }),
          ...(insightsDeps
            ? await planInsightsAudit({
                req,
                resourceId,
                changes: insightsChanges,
                deps: insightsDeps,
                target,
              })
            : []),
        ];
      } catch (error) {
        if (failClosed) {
          throw error;
        }
        deps.logger.error('[ResourcePermissions] Audit skipped', safeMeta(error));
        return;
      }
      /** Widening entries go first so their failure aborts before anything is recorded. */
      const ordered = [
        ...items.filter((item) => item.widening),
        ...items.filter((item) => !item.widening),
      ];
      for (const item of ordered) {
        try {
          await deps.recordAuditEntry(item.input, { failClosed });
          recorded.push(item);
        } catch (error) {
          if (!failClosed) {
            deps.logger.error('[ResourcePermissions] Audit persistence failed', safeMeta(error));
            continue;
          }
          if (!item.widening) {
            /** Removing access must not wait on the audit store; the entry is retried after the write. */
            deps.logger.error('[ResourcePermissions] Revocation audit deferred', safeMeta(error));
            deferred.push(item);
            continue;
          }
          await recordFailures();
          throw statusError('Permission change could not be audited', PERMISSION_AUDIT_UNAVAILABLE);
        }
      }
    }, afterWrite);
    await flushDeferred();
    return result;
  } catch (error) {
    if (!committed) {
      await recordFailures();
    }
    throw error;
  }
}
