import type { AgentSortOption } from 'librechat-data-provider';

/**
 * The marketplace list's sort modes, in the order the picker offers them. The
 * allowlist lives here rather than in the route handler so the query contract has one
 * definition beside `AgentSortOption` and the data-schemas implementation it drives.
 */
export const AGENT_SORT_OPTIONS: readonly AgentSortOption[] = [
  'newest',
  'oldest',
  'popular',
  'author',
];

const SORT_OPTIONS = new Set<string>(AGENT_SORT_OPTIONS);

const isAgentSortOption = (value: string): value is AgentSortOption => SORT_OPTIONS.has(value);

/** Raw `?sort=` / `?mine=` values as Express hands them over. */
export interface MarketplaceListQuery {
  sort?: string | string[];
  mine?: string | string[];
}

export interface MarketplaceListSelection {
  /**
   * The requested mode, or `undefined` for a missing, repeated or unknown one. Undefined
   * is not the same as `'newest'`: `GET /api/agents` also serves the agent selector, the
   * mention menu and the schedule pickers, which ask for no mode and have always been
   * answered in most-recently-edited order. Leaving it undefined keeps that order theirs
   * and makes the marketplace request its creation order explicitly.
   */
  sort?: AgentSortOption;
  /** True only for `?mine=1`. */
  mineOnly: boolean;
}

/**
 * Normalizes the marketplace list query. An unknown sort mode is not an error: the
 * marketplace is a browsing surface, and a stale link or a client from another version
 * should still list agents, so it falls back to the endpoint's own order instead of
 * 400-ing.
 */
export function resolveMarketplaceListQuery(query: MarketplaceListQuery): MarketplaceListSelection {
  const { sort, mine } = query;
  return {
    sort: typeof sort === 'string' && isAgentSortOption(sort) ? sort : undefined,
    mineOnly: mine === '1',
  };
}

/**
 * What `?mine=1` adds to the list filter: a plain author match, narrowing the
 * ACL-resolved set rather than replacing it. Returned as a filter fragment so the route
 * handler merges a contribution instead of deciding what the filter should say.
 */
export function marketplaceMineFilter(
  selection: MarketplaceListSelection,
  callerId: string,
): { author?: string } {
  return selection.mineOnly ? { author: callerId } : {};
}

export interface MarketplaceListErrorResponse {
  status: 409;
  body: { error: 'cursor_ordering_mismatch' };
}

export const AGENT_SORT_CURSOR_ERROR_CODE = 'AGENT_SORT_CURSOR_INVALID';

/**
 * Maps the database cursor contract failure to the marketplace HTTP response. Keeping
 * this translation here leaves the legacy CJS controller as route wiring only.
 */
export function mapMarketplaceListError(error: unknown): MarketplaceListErrorResponse | undefined {
  const code =
    error instanceof Error && 'code' in error
      ? (error as Error & { code?: unknown }).code
      : undefined;
  return code === AGENT_SORT_CURSOR_ERROR_CODE
    ? { status: 409, body: { error: 'cursor_ordering_mismatch' } }
    : undefined;
}
