import { logger } from '@librechat/data-schemas';
import { Permissions, SystemRoles, PrincipalType, PermissionTypes } from 'librechat-data-provider';
import type {
  TUser,
  TPeoplePickerPermissions,
  TPrincipalSearchResponse,
  TPrincipalSearchResult,
} from 'librechat-data-provider';
import type { NextFunction, Request, Response } from 'express';

export type SearchablePrincipalType = PrincipalType.USER | PrincipalType.GROUP | PrincipalType.ROLE;

export type EntraPrincipalSearchType = 'all' | 'users' | 'groups';

export type PrincipalSearchUser = Partial<Pick<TUser, 'id' | 'role' | 'provider'>> & {
  openidId?: string;
};

export type PrincipalSearchRequest = Pick<Request, 'query' | 'headers'> & {
  user?: PrincipalSearchUser;
  /** Principal types the caller may search, resolved by the people picker access check. */
  principalSearchTypes?: SearchablePrincipalType[];
};

export type PeoplePickerAccess = (
  req: PrincipalSearchRequest,
  res: Response,
  next: NextFunction,
) => Promise<Response | void>;

export type PeoplePickerRole = {
  permissions?: { [PermissionTypes.PEOPLE_PICKER]?: Partial<TPeoplePickerPermissions> };
};

export type PrincipalSearch = (req: PrincipalSearchRequest, res: Response) => Promise<void>;

type ScoredPrincipal = TPrincipalSearchResult & { _searchScore: number };

export interface PrincipalSearchDeps {
  searchPrincipals: (
    query: string,
    limitPerType: number,
    types: SearchablePrincipalType[],
  ) => Promise<TPrincipalSearchResult[]>;
  calculateRelevanceScore: (item: TPrincipalSearchResult, query: string) => number;
  sortPrincipalsByRelevance: (results: ScoredPrincipal[]) => ScoredPrincipal[];
  entraIdPrincipalFeatureEnabled: (user?: PrincipalSearchUser) => boolean;
  searchEntraIdPrincipals: (
    accessToken: string,
    sub: string | undefined,
    query: string,
    type: EntraPrincipalSearchType,
    limit: number,
  ) => Promise<TPrincipalSearchResult[]>;
}

const SEARCHABLE_PRINCIPAL_TYPES: readonly SearchablePrincipalType[] = [
  PrincipalType.USER,
  PrincipalType.GROUP,
  PrincipalType.ROLE,
];

const PRINCIPAL_SEARCH_PERMISSIONS: Record<
  SearchablePrincipalType,
  {
    permission: Permissions.VIEW_USERS | Permissions.VIEW_GROUPS | Permissions.VIEW_ROLES;
    label: string;
  }
> = {
  [PrincipalType.USER]: { permission: Permissions.VIEW_USERS, label: 'users' },
  [PrincipalType.GROUP]: { permission: Permissions.VIEW_GROUPS, label: 'groups' },
  [PrincipalType.ROLE]: { permission: Permissions.VIEW_ROLES, label: 'roles' },
};

const isSearchablePrincipalType = (value: string): value is SearchablePrincipalType =>
  (SEARCHABLE_PRINCIPAL_TYPES as readonly string[]).includes(value);

/**
 * Collects the principal types named by the `type` and `types` query parameters, in request order.
 * Each value may be a single type, a comma-separated list, or a repeated parameter.
 */
export function getRequestedPrincipalTypes(
  query: PrincipalSearchRequest['query'],
): SearchablePrincipalType[] {
  const requested = new Set<SearchablePrincipalType>();
  for (const value of [query.type, query.types].flat()) {
    if (typeof value !== 'string') {
      continue;
    }
    for (const name of value.split(',')) {
      if (isSearchablePrincipalType(name)) {
        requested.add(name);
      }
    }
  }
  return [...requested];
}

/** Maps resolved principal types to the Microsoft Graph search scope, or `null` when none apply. */
export function getEntraPrincipalSearchType(
  types: readonly SearchablePrincipalType[],
): EntraPrincipalSearchType | null {
  const users = types.includes(PrincipalType.USER);
  const groups = types.includes(PrincipalType.GROUP);
  if (users && groups) {
    return 'all';
  }
  if (users) {
    return 'users';
  }
  return groups ? 'groups' : null;
}

/**
 * Creates the people picker access check. It resolves the principal types the caller may search —
 * the requested types when every one is permitted, otherwise every permitted type — and stores
 * them on `req.principalSearchTypes` for the search handler.
 */
export function createPeoplePickerAccess({
  getRoleByName,
}: {
  getRoleByName: (roleName: string) => Promise<PeoplePickerRole | null>;
}): PeoplePickerAccess {
  return async (req, res, next) => {
    try {
      const user = req.user;
      if (!user || !user.role) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Authentication required',
        });
      }

      const requested = getRequestedPrincipalTypes(req.query);

      if (user.role === SystemRoles.ADMIN) {
        req.principalSearchTypes =
          requested.length > 0 ? requested : [...SEARCHABLE_PRINCIPAL_TYPES];
        return next();
      }

      const role = await getRoleByName(user.role);
      if (!role || !role.permissions) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'No permissions configured for user role',
        });
      }

      const peoplePickerPerms = role.permissions[PermissionTypes.PEOPLE_PICKER] ?? {};
      const canSearch = (type: SearchablePrincipalType) =>
        peoplePickerPerms[PRINCIPAL_SEARCH_PERMISSIONS[type].permission] === true;

      const denied = requested.find((type) => !canSearch(type));
      if (denied) {
        return res.status(403).json({
          error: 'Forbidden',
          message: `Insufficient permissions to search for ${PRINCIPAL_SEARCH_PERMISSIONS[denied].label}`,
        });
      }

      const types = requested.length > 0 ? requested : SEARCHABLE_PRINCIPAL_TYPES.filter(canSearch);
      if (types.length === 0) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Insufficient permissions to search for users, groups, or roles',
        });
      }

      req.principalSearchTypes = types;
      return next();
    } catch (error) {
      logger.error(
        `[checkPeoplePickerAccess][${req.user?.id}] error for type=${req.query.type}, types=${req.query.types}`,
        error,
      );
      return res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to check permissions',
      });
    }
  };
}

/** Entra ID principals for the resolved types that the local results do not already hold. */
async function findEntraPrincipals({
  req,
  query,
  types,
  remaining,
  localResults,
  deps,
}: {
  req: PrincipalSearchRequest;
  query: string;
  types: SearchablePrincipalType[];
  remaining: number;
  localResults: TPrincipalSearchResult[];
  deps: Pick<PrincipalSearchDeps, 'entraIdPrincipalFeatureEnabled' | 'searchEntraIdPrincipals'>;
}): Promise<TPrincipalSearchResult[]> {
  const graphType = getEntraPrincipalSearchType(types);
  if (remaining <= 0 || !graphType || !deps.entraIdPrincipalFeatureEnabled(req.user)) {
    return [];
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return [];
  }

  try {
    const graphResults = await deps.searchEntraIdPrincipals(
      authHeader.substring(7),
      req.user?.openidId,
      query,
      graphType,
      remaining,
    );

    const localEmails = new Set<string>();
    const localSourceIds = new Set<string>();
    for (const principal of localResults) {
      if (principal.email) {
        localEmails.add(principal.email.toLowerCase());
      }
      if (principal.idOnTheSource) {
        localSourceIds.add(principal.idOnTheSource);
      }
    }

    return graphResults.filter(
      (principal) =>
        !(principal.email && localEmails.has(principal.email.toLowerCase())) &&
        !(principal.idOnTheSource && localSourceIds.has(principal.idOnTheSource)),
    );
  } catch (error) {
    logger.warn(
      'Graph API search failed, falling back to local results:',
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

/**
 * Creates the principal search handler. It searches only `req.principalSearchTypes`, as resolved by
 * the people picker access check, so a request that skipped the check searches no types.
 */
export function createPrincipalSearch(deps: PrincipalSearchDeps): PrincipalSearch {
  return async (req, res) => {
    try {
      const { q: rawQuery, limit = 20 } = req.query;

      if (typeof rawQuery !== 'string' || rawQuery.trim().length === 0) {
        res.status(400).json({
          error: 'Query parameter "q" is required and must not be empty',
        });
        return;
      }

      const query = rawQuery.trim();

      if (query.length < 2) {
        res.status(400).json({
          error: 'Query must be at least 2 characters long',
        });
        return;
      }

      const searchLimit = Math.min(Math.max(1, parseInt(String(limit)) || 10), 50);
      const types = req.principalSearchTypes ?? [];

      const localResults = await deps.searchPrincipals(query, searchLimit, types);
      const entraResults = await findEntraPrincipals({
        req,
        query,
        types,
        remaining: searchLimit - localResults.length,
        localResults,
        deps,
      });

      const scoredResults = [...localResults, ...entraResults].map((item) => ({
        ...item,
        _searchScore: deps.calculateRelevanceScore(item, query),
      }));

      const sources = { local: 0, entra: 0 };
      const results = deps
        .sortPrincipalsByRelevance(scoredResults)
        .slice(0, searchLimit)
        .map(({ _searchScore, ...result }) => {
          sources[result.source] += 1;
          return result;
        });

      const response: TPrincipalSearchResponse = {
        query,
        limit: searchLimit,
        types,
        results,
        count: results.length,
        sources,
      };
      res.status(200).json(response);
    } catch (error) {
      logger.error('Error searching principals:', error);
      res.status(500).json({
        error: 'Failed to search principals',
      });
    }
  };
}
