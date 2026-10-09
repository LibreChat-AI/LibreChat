import { PrincipalType } from 'librechat-data-provider';
import {
  logger,
  isValidCapability,
  SystemCapabilities,
  expandImplications,
} from '@librechat/data-schemas';
import type {
  AuditAction,
  AuditContext,
  ISystemGrant,
  RecordAuditEntryInput,
  RecordAuditEntryOptions,
  SystemCapability,
} from '@librechat/data-schemas';
import type { Response } from 'express';
import type { Types } from 'mongoose';
import type { ResolvedPrincipal } from '~/types/principal';
import type { ServerRequest } from '~/types/http';
import { parsePagination } from './pagination';
import { buildAuditContext } from './context';

interface GrantRequestBody {
  principalType?: string;
  principalId?: string | null;
  capability?: string;
}

export interface AdminGrantsDeps {
  listGrants: (options?: {
    tenantId?: string;
    principalTypes?: PrincipalType[];
    limit?: number;
    offset?: number;
  }) => Promise<ISystemGrant[]>;
  countGrants: (options?: {
    tenantId?: string;
    principalTypes?: PrincipalType[];
  }) => Promise<number>;
  getCapabilitiesForPrincipal: (params: {
    principalType: PrincipalType;
    principalId: string | Types.ObjectId;
    tenantId?: string;
  }) => Promise<ISystemGrant[]>;
  getCapabilitiesForPrincipals: (params: {
    principals: Array<{ principalType: PrincipalType; principalId: string | Types.ObjectId }>;
    tenantId?: string;
  }) => Promise<ISystemGrant[]>;
  grantCapability: (params: {
    principalType: PrincipalType;
    principalId: string | Types.ObjectId;
    capability: SystemCapability;
    tenantId?: string;
    grantedBy?: string | Types.ObjectId;
  }) => Promise<{ grant: ISystemGrant | null; created: boolean }>;
  revokeCapability: (params: {
    principalType: PrincipalType;
    principalId: string | Types.ObjectId;
    capability: SystemCapability;
    tenantId?: string;
  }) => Promise<{ deletedCount: number }>;
  getUserPrincipals: (params: {
    userId: string;
    role?: string | null;
    tenantId?: string;
  }) => Promise<ResolvedPrincipal[]>;
  hasCapabilityForPrincipals: (params: {
    principals: ResolvedPrincipal[];
    capability: SystemCapability;
    tenantId?: string;
  }) => Promise<boolean>;
  getHeldCapabilities: (params: {
    principals: ResolvedPrincipal[];
    capabilities: SystemCapability[];
    tenantId?: string;
  }) => Promise<Set<SystemCapability>>;
  getCachedPrincipals?: (user: {
    id: string;
    role: string;
    tenantId?: string;
  }) => ResolvedPrincipal[] | undefined;
  checkRoleExists?: (roleId: string) => Promise<boolean>;
  /** Optional audit emission. Failure is logged but does not roll back the grant
   * unless `auditFailClosed` is set. */
  recordAuditEntry?: (
    input: RecordAuditEntryInput,
    options?: RecordAuditEntryOptions,
  ) => Promise<void>;
  /**
   * When true, a failed audit write surfaces as a 5xx instead of being
   * swallowed. The grant itself is already persisted (and grant writes are
   * idempotent upserts), so a client retry is safe; an operator must reconcile
   * the missing audit row. Defaults to fail-open.
   */
  auditFailClosed?: boolean;
}

/** Currently ROLE-only; Record/Set structure preserved for future principal-type expansion. */
export type GrantPrincipalType = PrincipalType.ROLE;

/** Creates admin grant handlers with dependency injection for the /api/admin/grants routes. */
export function createAdminGrantsHandlers(deps: AdminGrantsDeps): {
  listGrants: (req: ServerRequest, res: Response) => Promise<Response>;
  getEffectiveCapabilities: (req: ServerRequest, res: Response) => Promise<Response>;
  getPrincipalGrants: (req: ServerRequest, res: Response) => Promise<Response>;
  assignGrant: (req: ServerRequest, res: Response) => Promise<Response>;
  revokeGrant: (req: ServerRequest, res: Response) => Promise<Response>;
} {
  const {
    listGrants,
    countGrants,
    getCapabilitiesForPrincipal,
    getCapabilitiesForPrincipals,
    grantCapability,
    revokeCapability,
    getUserPrincipals,
    hasCapabilityForPrincipals,
    getHeldCapabilities,
    getCachedPrincipals,
    checkRoleExists,
    recordAuditEntry,
    auditFailClosed,
  } = deps;

  async function emitAudit(args: {
    action: AuditAction;
    caller: { userId: string; actorName: string; role: string; tenantId?: string };
    principalType: PrincipalType;
    principalId: string;
    capability: SystemCapability;
    context?: AuditContext;
  }): Promise<void> {
    if (!recordAuditEntry) return;
    /** The grants surface is ROLE-only today (see `MANAGE_CAPABILITY_BY_TYPE`),
     * and SystemGrant stores the human-readable role name in `principalId` for
     * ROLE principals, so the audit target's id and name are both `principalId`.
     * When USER and GROUP grants are enabled, resolve the display name here. */
    const input: RecordAuditEntryInput = {
      action: args.action,
      outcome: 'success',
      severity: 'warning',
      actor: { type: 'user', id: args.caller.userId, name: args.caller.actorName },
      target: { type: args.principalType, id: args.principalId, name: args.principalId },
      metadata: { capability: args.capability },
      context: args.context,
      tenantId: args.caller.tenantId,
    };
    if (auditFailClosed) {
      /** Let the failure propagate to the handler (→ 5xx); see `auditFailClosed`. */
      await recordAuditEntry(input, { failClosed: true });
      return;
    }
    try {
      await recordAuditEntry(input);
    } catch (err) {
      /** Fail-open: audit failure must not roll back the grant. */
      logger.error('[adminGrants] audit write failed', err);
    }
  }

  const MANAGE_CAPABILITY_BY_TYPE: Record<GrantPrincipalType, SystemCapability> = {
    [PrincipalType.ROLE]: SystemCapabilities.MANAGE_ROLES,
  };

  const READ_CAPABILITY_BY_TYPE: Record<GrantPrincipalType, SystemCapability> = {
    [PrincipalType.ROLE]: SystemCapabilities.READ_ROLES,
  };

  const VALID_PRINCIPAL_TYPES = new Set(
    Object.keys(MANAGE_CAPABILITY_BY_TYPE) as GrantPrincipalType[],
  );

  function resolveUser(
    req: ServerRequest,
  ): { userId: string; role: string; actorName: string; tenantId?: string } | null {
    const user = req.user;
    if (!user) {
      return null;
    }
    const userId = user._id?.toString() ?? user.id;
    if (!userId || !user.role) {
      return null;
    }
    /** JWT-loaded `req.user` already carries name/username/email, so the actor
     * display name is available without a database round-trip. */
    const actorName = user.name || user.username || user.email || userId;
    return { userId, role: user.role, actorName, tenantId: user.tenantId };
  }

  async function resolvePrincipals(user: {
    userId: string;
    role: string;
    tenantId?: string;
  }): Promise<ResolvedPrincipal[]> {
    if (getCachedPrincipals) {
      const cached = getCachedPrincipals({
        id: user.userId,
        role: user.role,
        tenantId: user.tenantId,
      });
      if (cached) {
        return cached;
      }
    }
    return getUserPrincipals({ userId: user.userId, role: user.role, tenantId: user.tenantId });
  }

  function validatePrincipal(principalType: string, principalId: string): string | null {
    if (!principalType || !VALID_PRINCIPAL_TYPES.has(principalType as GrantPrincipalType)) {
      return 'Invalid principal type';
    }
    if (!principalId) {
      return 'Principal ID is required';
    }
    return null;
  }

  function validateGrantBody(body: GrantRequestBody): string | null {
    const { principalType, principalId, capability } = body;
    if (typeof principalType !== 'string') {
      return 'Invalid principal type';
    }
    if (principalId == null) {
      return 'Principal ID is required';
    }
    if (typeof principalId !== 'string') {
      return 'Principal ID must be a string';
    }
    const principalError = validatePrincipal(principalType, principalId);
    if (principalError) {
      return principalError;
    }
    if (!capability || typeof capability !== 'string' || !isValidCapability(capability)) {
      return 'Invalid capability';
    }
    return null;
  }

  async function listGrantsHandler(req: ServerRequest, res: Response) {
    try {
      const user = resolveUser(req);
      if (!user) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { limit, offset } = parsePagination(req.query as { limit?: string; offset?: string });
      const { tenantId } = user;
      const principals = await resolvePrincipals(user);
      const entries = Object.entries(READ_CAPABILITY_BY_TYPE) as [
        GrantPrincipalType,
        SystemCapability,
      ][];

      const heldCaps = await getHeldCapabilities({
        principals,
        capabilities: entries.map(([, cap]) => cap),
        tenantId,
      });
      const allowedTypes = entries
        .filter(([, cap]) => heldCaps.has(cap))
        .map(([type]) => type) as PrincipalType[];

      if (!allowedTypes.length) {
        return res.status(200).json({ grants: [], total: 0, limit, offset });
      }
      const [grants, total] = await Promise.all([
        listGrants({ tenantId, principalTypes: allowedTypes, limit, offset }),
        countGrants({ tenantId, principalTypes: allowedTypes }),
      ]);
      return res.status(200).json({ grants, total, limit, offset });
    } catch (error) {
      logger.error('[adminGrants] listGrants error:', error);
      return res.status(500).json({ error: 'Failed to list grants' });
    }
  }

  /**
   * Returns the caller's effective capabilities: direct grants plus base-level
   * implications (e.g. manage:roles → read:roles).
   *
   * Note: this endpoint does NOT expand parent capabilities into their
   * section-level children (e.g. manage:configs does NOT expand into
   * manage:configs:endpoints, manage:configs:models, etc.). Section-level
   * capabilities are resolved dynamically by the authorization layer
   * (hasCapabilityForPrincipals / getHeldCapabilities) at check time via
   * getParentCapabilities. The admin UI should treat a base capability like
   * manage:configs as implying authority over all its sections.
   */
  async function getEffectiveCapabilitiesHandler(req: ServerRequest, res: Response) {
    try {
      const user = resolveUser(req);
      if (!user) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { tenantId } = user;
      const principals = await resolvePrincipals(user);
      const filteredPrincipals = principals.filter(
        (p): p is ResolvedPrincipal & { principalId: string | Types.ObjectId } =>
          p.principalId != null,
      );

      if (!filteredPrincipals.length) {
        return res.status(200).json({ capabilities: [] });
      }

      const grants = await getCapabilitiesForPrincipals({
        principals: filteredPrincipals,
        tenantId,
      });

      const directCaps = new Set<string>();
      for (const grant of grants) {
        directCaps.add(grant.capability);
      }

      return res.status(200).json({ capabilities: expandImplications(Array.from(directCaps)) });
    } catch (error) {
      logger.error('[adminGrants] getEffectiveCapabilities error:', error);
      return res.status(500).json({ error: 'Failed to get effective capabilities' });
    }
  }

  async function getPrincipalGrantsHandler(req: ServerRequest, res: Response) {
    try {
      const user = resolveUser(req);
      if (!user) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { principalType, principalId } = req.params as {
        principalType: string;
        principalId: string;
      };

      const principalError = validatePrincipal(principalType, principalId);
      if (principalError) {
        return res.status(400).json({ error: principalError });
      }

      const { tenantId } = user;
      const readCap = READ_CAPABILITY_BY_TYPE[principalType as GrantPrincipalType];
      const principals = await resolvePrincipals(user);
      const allowed = await hasCapabilityForPrincipals({
        principals,
        capability: readCap,
        tenantId,
      });
      if (!allowed) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      const grants = await getCapabilitiesForPrincipal({
        principalType: principalType as PrincipalType,
        principalId,
        tenantId,
      });
      return res.status(200).json({ grants });
    } catch (error) {
      logger.error('[adminGrants] getPrincipalGrants error:', error);
      return res.status(500).json({ error: 'Failed to get grants' });
    }
  }

  async function assignGrantHandler(req: ServerRequest, res: Response) {
    try {
      const caller = resolveUser(req);
      if (!caller) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const bodyError = validateGrantBody(req.body as GrantRequestBody);
      if (bodyError) {
        return res.status(400).json({ error: bodyError });
      }

      const { principalType, principalId, capability } = req.body as {
        principalType: GrantPrincipalType;
        principalId: string;
        capability: SystemCapability;
      };

      const { tenantId } = caller;
      const principals = await resolvePrincipals(caller);

      const manageCap = MANAGE_CAPABILITY_BY_TYPE[principalType];
      const held = await getHeldCapabilities({
        principals,
        capabilities: [manageCap, capability],
        tenantId,
      });
      if (!held.has(manageCap)) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }
      if (!held.has(capability)) {
        return res.status(403).json({ error: 'Cannot grant a capability you do not possess' });
      }

      /** Reject grants targeting non-existent roles when the dep is provided. */
      if (checkRoleExists) {
        const exists = await checkRoleExists(principalId);
        if (!exists) {
          return res.status(400).json({ error: 'Role not found' });
        }
      }

      /** `created` comes from the atomic upsert result, so a re-assert of a
       * capability the role already holds (or a concurrent double-assign) is not
       * audited as a new change — and a new tenant-scoped grant is correctly
       * distinguished from an inherited platform-level one. */
      const { grant, created } = await grantCapability({
        principalType,
        principalId,
        capability,
        tenantId,
        grantedBy: caller.userId,
      });
      if (!grant) {
        return res.status(500).json({ error: 'Grant operation returned no result' });
      }
      if (created) {
        try {
          await emitAudit({
            action: 'grant.assigned',
            caller,
            principalType,
            principalId,
            capability,
            context: buildAuditContext(req),
          });
        } catch (auditErr) {
          /** Fail-closed only (emitAudit rethrows here): roll back the grant we
           * just created so a 5xx never leaves an unaudited grant in place. */
          await revokeCapability({ principalType, principalId, capability, tenantId }).catch((e) =>
            logger.error('[adminGrants] compensating revoke after audit failure failed', e),
          );
          logger.error(
            '[adminGrants] assignGrant audit failed (fail-closed) — rolled back grant',
            auditErr,
          );
          return res.status(500).json({ error: 'Failed to record audit entry' });
        }
      }
      return res.status(201).json({ grant });
    } catch (error) {
      logger.error('[adminGrants] assignGrant error:', error);
      return res.status(500).json({ error: 'Failed to assign grant' });
    }
  }

  /**
   * Revocation requires MANAGE on the target principal type but does NOT
   * require the caller to possess the capability being revoked. This avoids
   * a bootstrap deadlock where no one can clean up grants they don't hold.
   */
  async function revokeGrantHandler(req: ServerRequest, res: Response) {
    try {
      const caller = resolveUser(req);
      if (!caller) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { principalType, principalId, capability } = req.params as {
        principalType: string;
        principalId: string;
        capability?: string;
      };

      const principalError = validatePrincipal(principalType, principalId);
      if (principalError) {
        return res.status(400).json({ error: principalError });
      }
      if (!capability || !isValidCapability(capability)) {
        return res.status(400).json({ error: 'Invalid capability' });
      }

      const { tenantId } = caller;
      const principals = await resolvePrincipals(caller);
      const manageCap = MANAGE_CAPABILITY_BY_TYPE[principalType as GrantPrincipalType];
      if (!(await hasCapabilityForPrincipals({ principals, capability: manageCap, tenantId }))) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      const revokeResult = await revokeCapability({
        principalType: principalType as PrincipalType,
        principalId,
        capability: capability as SystemCapability,
        tenantId,
      });
      // Only emit the audit entry when a grant document was actually deleted —
      // a no-op revoke (the grant never existed) must not appear in the audit
      // trail or the forensic record becomes misleading.
      if (revokeResult.deletedCount > 0) {
        try {
          await emitAudit({
            action: 'grant.removed',
            caller,
            principalType: principalType as PrincipalType,
            principalId,
            capability: capability as SystemCapability,
            context: buildAuditContext(req),
          });
        } catch (auditErr) {
          /** Fail-closed only (emitAudit rethrows here): restore the grant we
           * just removed so a 5xx never leaves an unaudited revoke. The original
           * `grantedBy`/`grantedAt` are not recoverable here; restoring access is
           * the priority on this rare error path. */
          await grantCapability({
            principalType: principalType as PrincipalType,
            principalId,
            capability: capability as SystemCapability,
            tenantId,
            grantedBy: caller.userId,
          }).catch((e) =>
            logger.error('[adminGrants] compensating re-grant after audit failure failed', e),
          );
          logger.error(
            '[adminGrants] revokeGrant audit failed (fail-closed) — restored grant',
            auditErr,
          );
          return res.status(500).json({ error: 'Failed to record audit entry' });
        }
      }
      return res.status(200).json({ success: true });
    } catch (error) {
      logger.error('[adminGrants] revokeGrant error:', error);
      return res.status(500).json({ error: 'Failed to revoke grant' });
    }
  }

  return {
    listGrants: listGrantsHandler,
    getEffectiveCapabilities: getEffectiveCapabilitiesHandler,
    getPrincipalGrants: getPrincipalGrantsHandler,
    assignGrant: assignGrantHandler,
    revokeGrant: revokeGrantHandler,
  };
}
