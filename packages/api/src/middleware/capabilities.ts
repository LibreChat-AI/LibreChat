import { isMainThread } from 'node:worker_threads';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PrincipalType } from 'librechat-data-provider';
import {
  logger,
  configCapability,
  SystemCapabilities,
  readConfigCapability,
} from '@librechat/data-schemas';
import type { SystemCapability, ConfigSection } from '@librechat/data-schemas';
import type { NextFunction, Response } from 'express';
import type { Types, ClientSession } from 'mongoose';
import type { ResolvedPrincipal } from '~/types/principal';
import type { ServerRequest } from '~/types/http';

interface CapabilityDeps {
  getUserPrincipals: (
    params: {
      userId: string | Types.ObjectId;
      role?: string | null;
      idOnTheSource?: string | null;
    },
    session?: ClientSession,
  ) => Promise<ResolvedPrincipal[]>;
  hasCapabilityForPrincipals: (params: {
    principals: ResolvedPrincipal[];
    capability: SystemCapability;
    tenantId?: string;
  }) => Promise<boolean>;
  hasAnyConfigReadAccess?: (params: {
    principals: ResolvedPrincipal[];
    tenantId?: string;
  }) => Promise<boolean>;
  getHeldCapabilities?: (params: {
    principals: ResolvedPrincipal[];
    capabilities: SystemCapability[];
    tenantId?: string;
  }) => Promise<Set<SystemCapability>>;
}

export interface CapabilityUser {
  id: string;
  role: string;
  tenantId?: string;
  /** External member id; pass `null` for local users to skip the fallback lookup. */
  idOnTheSource?: string | null;
}

interface CapabilityStore {
  principals: Map<string, ResolvedPrincipal[]>;
  results: Map<string, boolean>;
}

const DENIAL_WARN_INTERVAL_MS = 5 * 60 * 1000;
const MAX_DENIAL_WARN_KEYS = 1000;
const recentDenialWarnings = new Map<string, number>();

export type HasCapabilityFn = (
  user: CapabilityUser,
  capability: SystemCapability,
) => Promise<boolean>;

export type RequireCapabilityFn = (
  capability: SystemCapability,
  options?: { platformOnly?: boolean },
) => (req: ServerRequest, res: Response, next: NextFunction) => Promise<void>;

export type HasConfigCapabilityFn = (
  user: CapabilityUser,
  section: ConfigSection | null,
  verb?: 'manage' | 'read',
) => Promise<boolean>;

export type GetHeldCapabilitiesFn = (
  user: CapabilityUser,
  capabilities: SystemCapability[],
) => Promise<Set<SystemCapability>>;

/**
 * Per-request store for caching resolved principals and capability check results.
 * When running inside an Express request (via `capabilityContextMiddleware`),
 * duplicate `hasCapability` calls within the same request are served from
 * the in-memory Map instead of hitting the database again.
 * Outside a request context (background jobs, tests), the store is undefined
 * and every check falls through to the database — correct behavior.
 */
export const capabilityStore: AsyncLocalStorage<CapabilityStore> =
  new AsyncLocalStorage<CapabilityStore>();

export function capabilityContextMiddleware(
  _req: ServerRequest,
  _res: Response,
  next: NextFunction,
): void {
  if (!isMainThread) {
    logger.error(
      '[capabilityContextMiddleware] Mounted in a worker thread — ' +
        'ALS context will not propagate to the main thread or other workers. ' +
        'This middleware should only run in the main Express process.',
    );
  }
  capabilityStore.run({ principals: new Map(), results: new Map() }, next);
}

function warnDeniedCapabilityOnce(key: string, message: string): void {
  const now = Date.now();
  const lastLoggedAt = recentDenialWarnings.get(key);
  if (lastLoggedAt !== undefined && now - lastLoggedAt < DENIAL_WARN_INTERVAL_MS) {
    return;
  }

  if (recentDenialWarnings.size >= MAX_DENIAL_WARN_KEYS) {
    const oldestKey = recentDenialWarnings.keys().next().value;
    if (oldestKey !== undefined) {
      recentDenialWarnings.delete(oldestKey);
    }
  }

  recentDenialWarnings.set(key, now);
  logger.warn(message);
}

/**
 * Reads principals from the per-request ALS cache without side effects.
 * Returns `undefined` when called outside a request context or before
 * `requireCapability` has populated the cache for this user.
 */
export function getCachedPrincipals(user: CapabilityUser): ResolvedPrincipal[] | undefined {
  const store = capabilityStore.getStore();
  if (!store) {
    return undefined;
  }
  const key = `${user.id}:${user.role}:${user.tenantId ?? ''}`;
  return store.principals.get(key);
}

/**
 * Factory that creates `hasCapability` and `requireCapability` with injected
 * database methods. Follows the same dependency-injection pattern as
 * `generateCheckAccess`.
 */
export type GetReadableConfigSectionsFn = (
  user: CapabilityUser,
  sections: ConfigSection[],
) => Promise<{ broad: boolean; sections: Set<string> }>;

export function generateCapabilityCheck(deps: CapabilityDeps): {
  hasCapability: HasCapabilityFn;
  requireCapability: RequireCapabilityFn;
  hasConfigCapability: HasConfigCapabilityFn;
  getHeldCapabilities: GetHeldCapabilitiesFn;
  hasAnyConfigReadAccess: (user: CapabilityUser) => Promise<boolean>;
  getReadableConfigSections: GetReadableConfigSectionsFn;
} {
  const {
    getUserPrincipals,
    hasCapabilityForPrincipals,
    hasAnyConfigReadAccess: checkAny = async () => false,
    getHeldCapabilities: getHeldCaps = async () => new Set(),
  } = deps;

  let workerWarned = false;

  async function resolvePrincipals(user: CapabilityUser): Promise<ResolvedPrincipal[]> {
    const store = capabilityStore.getStore();
    const principalKey = `${user.id}:${user.role}:${user.tenantId ?? ''}`;
    const cached = store?.principals.get(principalKey);
    if (cached) {
      return cached;
    }
    const principals = await getUserPrincipals({
      userId: user.id,
      role: user.role,
      idOnTheSource: user.idOnTheSource,
    });
    store?.principals.set(principalKey, principals);
    return principals;
  }

  /** Whether the user holds any config-read capability at all, broad or section-scoped. */
  async function hasAnyConfigReadAccess(user: CapabilityUser): Promise<boolean> {
    const principals = await resolvePrincipals(user);
    return checkAny({ principals, tenantId: user.tenantId });
  }

  async function getHeldCapabilities(
    user: CapabilityUser,
    capabilities: SystemCapability[],
  ): Promise<Set<SystemCapability>> {
    const principals = await resolvePrincipals(user);
    return getHeldCaps({ principals, capabilities, tenantId: user.tenantId });
  }

  /**
   * Resolves which of `sections` the user can read in a single batched
   * query, instead of one `hasConfigCapability` round trip per section.
   */
  async function getReadableConfigSections(
    user: CapabilityUser,
    sections: ConfigSection[],
  ): Promise<{ broad: boolean; sections: Set<string> }> {
    const capsToCheck = [
      SystemCapabilities.READ_CONFIGS,
      SystemCapabilities.MANAGE_CONFIGS,
      ...sections.map(readConfigCapability),
    ];
    const held = await getHeldCapabilities(user, capsToCheck);
    const broad =
      held.has(SystemCapabilities.READ_CONFIGS) || held.has(SystemCapabilities.MANAGE_CONFIGS);
    const readableSections = new Set(
      broad ? sections : sections.filter((s) => held.has(readConfigCapability(s))),
    );
    return { broad, sections: readableSections };
  }

  async function hasCapability(
    user: CapabilityUser,
    capability: SystemCapability,
    { platformOnly = false }: { platformOnly?: boolean } = {},
  ): Promise<boolean> {
    if (!isMainThread && !workerWarned) {
      workerWarned = true;
      logger.warn(
        '[hasCapability] Called from a worker thread — ALS context is unavailable. ' +
          'Capability checks will hit the database on every call (no per-request caching). ' +
          'If this is intentional, no action needed.',
      );
    }

    const store = capabilityStore.getStore();

    const resultKey = `${user.id}:${user.tenantId ?? ''}:${capability}:${platformOnly ? 'platform' : 'tenant'}`;
    const cached = store?.results.get(resultKey);
    if (cached !== undefined) {
      return cached;
    }

    const resolvedPrincipals = await resolvePrincipals(user);
    const principals =
      platformOnly && user.tenantId
        ? resolvedPrincipals.filter(({ principalType }) => principalType === PrincipalType.USER)
        : resolvedPrincipals;
    const result = await hasCapabilityForPrincipals({
      principals,
      capability,
      tenantId: platformOnly ? undefined : user.tenantId,
    });
    store?.results.set(resultKey, result);
    return result;
  }

  /**
   * Checks if a user can manage or read a specific config section.
   * First checks the broad capability (manage:configs / read:configs),
   * then falls back to the section-specific capability (manage:configs:<section>).
   */
  async function hasConfigCapability(
    user: CapabilityUser,
    section: ConfigSection | null,
    verb: 'manage' | 'read' = 'manage',
  ): Promise<boolean> {
    const broadCap =
      verb === 'manage' ? SystemCapabilities.MANAGE_CONFIGS : SystemCapabilities.READ_CONFIGS;
    if (section == null) {
      return hasCapability(user, broadCap);
    }
    if (await hasCapability(user, broadCap)) {
      return true;
    }
    const sectionCap =
      verb === 'manage' ? configCapability(section) : readConfigCapability(section);
    return hasCapability(user, sectionCap);
  }

  function requireCapability(
    capability: SystemCapability,
    { platformOnly = false }: { platformOnly?: boolean } = {},
  ) {
    return async (req: ServerRequest, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          res.status(401).json({ message: 'Authentication required' });
          return;
        }

        const id = req.user.id ?? req.user._id?.toString();
        if (!id) {
          res.status(401).json({ message: 'Authentication required' });
          return;
        }

        const user: CapabilityUser = {
          id,
          role: req.user.role ?? '',
          tenantId: (req.user as CapabilityUser).tenantId,
          idOnTheSource: req.user.idOnTheSource ?? null,
        };

        if (await hasCapability(user, capability, { platformOnly })) {
          next();
          return;
        }

        warnDeniedCapabilityOnce(
          `missing-capability:${id}:${capability}`,
          `[requireCapability] Forbidden: user ${id} missing capability '${capability}'`,
        );
        res.status(403).json({ message: 'Forbidden' });
      } catch (err) {
        logger.error(`[requireCapability] Error checking capability: ${capability}`, err);
        res.status(500).json({ message: 'Internal Server Error' });
      }
    };
  }

  return {
    hasCapability,
    requireCapability,
    hasConfigCapability,
    getHeldCapabilities,
    hasAnyConfigReadAccess,
    getReadableConfigSections,
  };
}
