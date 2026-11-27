import type { Request } from 'express';

type QueryValue = Request['query'][string];

export const DEFAULT_PAGE_LIMIT = 25;
export const MAX_PAGE_LIMIT = 100;

export type SortDirection = 'asc' | 'desc';

/** The sort fields `getConvosByCursor` accepts; anything else makes it throw. Keep this
 *  in sync with the whitelist in `packages/data-schemas/src/methods/conversation.ts`. */
export type ConversationSortField = 'title' | 'createdAt' | 'updatedAt' | 'archivedAt';

export const CONVERSATION_SORT_FIELDS: Readonly<Record<ConversationSortField, true>> = {
  title: true,
  createdAt: true,
  updatedAt: true,
  archivedAt: true,
};

/** Express parses a repeated `?limit=a&limit=b` into an array, which `parseInt` reads as its first element's digits. */
export const queryString = (value: QueryValue): string | undefined => {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return queryString(value[0]);
  }
  return undefined;
};

export const normalizeSortField = <T extends string>(
  value: QueryValue,
  { fields, fallback }: { fields: Readonly<Record<T, true>>; fallback: T },
): T => {
  const sortField = queryString(value);
  return sortField != null && fields[sortField as T] === true ? (sortField as T) : fallback;
};

export const normalizeSortDirection = (
  value: QueryValue,
  { fallback = 'desc' }: { fallback?: SortDirection } = {},
): SortDirection => {
  const sortDirection = queryString(value);
  return sortDirection === 'asc' || sortDirection === 'desc' ? sortDirection : fallback;
};

/**
 * Clamps a page size from user input. An unclamped limit reaches Mongo's `.limit()`,
 * where a negative value means "one batch" and `0` means "no limit at all".
 */
export const normalizeLimit = (
  value: QueryValue,
  { fallback = DEFAULT_PAGE_LIMIT, max = MAX_PAGE_LIMIT }: { fallback?: number; max?: number } = {},
): number => {
  const limit = parseInt(queryString(value) ?? '', 10);
  if (!Number.isFinite(limit)) {
    return fallback;
  }
  return Math.min(Math.max(limit, 1), max);
};
