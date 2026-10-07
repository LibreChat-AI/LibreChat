import { SystemCategories } from 'librechat-data-provider';
import type { PromptGroupsListResponse } from '~/types';
import type { StoredId } from './types';

/**
 * Formats prompt groups for the paginated /groups endpoint response
 */
export function formatPromptGroupsResponse<T>({
  promptGroups = [],
  pageNumber,
  pageSize,
  actualLimit,
  hasMore = false,
  after = null,
}: {
  promptGroups: T[];
  pageNumber?: string;
  pageSize?: string;
  actualLimit?: string | number;
  hasMore?: boolean;
  after?: string | null;
}): PromptGroupsListResponse<T> {
  const currentPage = parseInt(pageNumber || '1');

  // Calculate total pages based on whether there are more results
  // If hasMore is true, we know there's at least one more page
  // We use a high number (9999) to indicate "many pages" since we don't know the exact count
  const totalPages = hasMore ? '9999' : currentPage.toString();

  return {
    promptGroups,
    pageNumber: pageNumber || '1',
    pageSize: pageSize || String(actualLimit) || '10',
    pages: totalPages,
    has_more: hasMore,
    after,
  };
}

/**
 * Marks prompt groups as public based on the publicly accessible IDs
 */
export function markPublicPromptGroups<T extends { readonly _id?: StoredId }>(
  promptGroups: readonly T[],
  publiclyAccessibleIds: readonly StoredId[],
): T[] {
  if (!promptGroups.length) {
    return [];
  }

  const publicIds = new Set(publiclyAccessibleIds.map(String));
  return promptGroups.map((group) =>
    group._id != null && publicIds.has(String(group._id)) ? { ...group, isPublic: true } : group,
  );
}

/**
 * Converts the listing name and category, including system categories, to plain
 * listing inputs and shared-search flags.
 */
export function buildPromptGroupFilter({ name, category }: { name?: string; category?: string }): {
  name?: string;
  category?: string;
  searchShared: boolean;
  searchSharedOnly: boolean;
} {
  let searchShared = true;
  let searchSharedOnly = false;
  let categoryFilter: string | undefined;

  if (category === SystemCategories.MY_PROMPTS) {
    searchShared = false;
  } else if (category === SystemCategories.NO_CATEGORY) {
    categoryFilter = '';
  } else if (category === SystemCategories.SHARED_PROMPTS) {
    searchSharedOnly = true;
  } else if (category) {
    categoryFilter = category;
  }

  return {
    name: name || undefined,
    category: categoryFilter,
    searchShared,
    searchSharedOnly,
  };
}

/**
 * Filters accessible IDs based on shared/public prompts logic.
 *
 * @param ownedPromptGroupIds - IDs of prompt groups authored by the current user.
 *   Required for correct MY_PROMPTS and SHARED_PROMPTS filtering. When omitted the
 *   function falls back to the legacy behaviour (public-only filtering).
 */
export async function filterAccessibleIdsBySharedLogic<T extends StoredId>({
  accessibleIds,
  searchShared,
  searchSharedOnly,
  publicPromptGroupIds,
  ownedPromptGroupIds,
}: {
  accessibleIds: readonly T[];
  searchShared: boolean;
  searchSharedOnly: boolean;
  publicPromptGroupIds?: readonly T[];
  ownedPromptGroupIds?: readonly T[];
}): Promise<T[]> {
  const ownedIdStrings = new Set((ownedPromptGroupIds || []).map((id) => id.toString()));

  if (!searchShared) {
    // MY_PROMPTS — only prompt groups the user authored
    if (ownedPromptGroupIds != null) {
      return accessibleIds.filter((id) => ownedIdStrings.has(id.toString()));
    }
    // Legacy fallback: exclude public IDs (imprecise but backwards-compatible)
    const publicIdStrings = new Set((publicPromptGroupIds || []).map((id) => id.toString()));
    return accessibleIds.filter((id) => !publicIdStrings.has(id.toString()));
  }

  if (searchSharedOnly) {
    // SHARED_PROMPTS — all prompts the user can access that they did NOT author
    // Combine accessible + public, deduplicate, then exclude owned
    const allAccessible = [...accessibleIds, ...(publicPromptGroupIds || [])];
    const uniqueMap = new Map(allAccessible.map((id) => [id.toString(), id]));

    if (ownedPromptGroupIds != null) {
      return [...uniqueMap.values()].filter((id) => !ownedIdStrings.has(id.toString()));
    }
    // Legacy fallback
    if (!publicPromptGroupIds?.length) {
      return [];
    }
    const accessibleIdStrings = new Set(accessibleIds.map((id) => id.toString()));
    return publicPromptGroupIds.filter((id) => accessibleIdStrings.has(id.toString()));
  }

  // ALL — return everything accessible + public (deduplicated)
  const allAccessible = [...accessibleIds, ...(publicPromptGroupIds || [])];
  const uniqueMap = new Map(allAccessible.map((id) => [id.toString(), id]));
  return [...uniqueMap.values()];
}
