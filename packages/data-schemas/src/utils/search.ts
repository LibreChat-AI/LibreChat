import { escapeRegExp } from './string';

/**
 * Word-prefix search over derived token arrays.
 *
 * Each searchable source field (`name`, `email`, `username`) gets a lowercase,
 * accent-folded token array stored beside it and indexed with `tenantId`. A query
 * is tokenized the same way, and each query token must prefix-match some token,
 * so "john smi" finds "John Smith" through an anchored, case-sensitive regex
 * that the multikey index can bound. Matches inside a word ("ohn") are not
 * found, by design: that is the price of an index-bound search.
 *
 * The token rules are a stored format: changing them requires re-running the
 * backfill, so the caps are constants rather than configuration.
 */

/** How a source value is split into tokens. */
export type SearchTokenKind = 'words' | 'email' | 'handle';

export interface SearchTokenField {
  /** The stored field the tokens derive from. */
  readonly source: string;
  /** The derived, indexed token array. */
  readonly tokens: string;
  readonly kind: SearchTokenKind;
}

export const USER_SEARCH_TOKEN_FIELDS: readonly SearchTokenField[] = [
  { source: 'name', tokens: 'nameTokens', kind: 'words' },
  { source: 'email', tokens: 'emailTokens', kind: 'email' },
  { source: 'username', tokens: 'usernameTokens', kind: 'handle' },
];

export const GROUP_SEARCH_TOKEN_FIELDS: readonly SearchTokenField[] = [
  { source: 'name', tokens: 'nameTokens', kind: 'words' },
  { source: 'email', tokens: 'emailTokens', kind: 'email' },
];

/** Longest stored or queried word token; longer words are truncated to this prefix. */
export const MAX_SEARCH_TOKEN_LENGTH = 64;
/** Longest whole-value token (a full email address or username). */
export const MAX_SEARCH_VALUE_LENGTH = 256;
/** Most tokens stored per field. */
export const MAX_SEARCH_TOKENS = 32;
/**
 * Most distinct query words. Every word must match, so a longer query matches
 * nothing rather than ignoring its extra words; the cap bounds the filter a
 * single request can build.
 */
export const MAX_SEARCH_QUERY_TOKENS = 16;

const NON_WORD = /[^\p{L}\p{N}]+/u;
const COMBINING_MARKS = /\p{M}+/gu;

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return Array.from(value).slice(0, max).join('');
}

/** Lowercases and folds accents, so "José" and "jose" compare equal. */
export function normalizeSearchText(value: string): string {
  return value.normalize('NFKD').replace(COMBINING_MARKS, '').toLowerCase();
}

function words(normalized: string): string[] {
  return normalized
    .split(NON_WORD)
    .filter(Boolean)
    .map((word) => truncate(word, MAX_SEARCH_TOKEN_LENGTH));
}

/**
 * A value reduced to the words the filter matches, joined by single spaces, so
 * relevance scoring sees "Mary-Jane" and "mary jane" as the same text.
 */
export function normalizeSearchPhrase(value: string): string {
  return words(normalizeSearchText(value)).join(' ');
}

/** Derives the stored token array for one field value. Non-strings yield no tokens. */
export function computeSearchTokens(kind: SearchTokenKind, value: unknown): string[] {
  if (typeof value !== 'string') {
    return [];
  }
  const normalized = normalizeSearchText(value.trim());
  if (!normalized) {
    return [];
  }
  const tokens: string[] = [];
  if (kind !== 'words') {
    tokens.push(truncate(normalized, MAX_SEARCH_VALUE_LENGTH));
  }
  tokens.push(...words(normalized));
  if (kind === 'email') {
    const domain = normalized.slice(normalized.lastIndexOf('@') + 1);
    tokens.push(...domain.split('.').filter(Boolean));
  }
  return [...new Set(tokens)].slice(0, MAX_SEARCH_TOKENS);
}

/** Every token field of `fields`, computed from a document's source values. */
export function computeSearchTokenSet(
  fields: readonly SearchTokenField[],
  doc: Record<string, unknown>,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const field of fields) {
    result[field.tokens] = computeSearchTokens(field.kind, doc[field.source]);
  }
  return result;
}

type UpdateDoc = Record<string, unknown>;

/**
 * The indexes behind each token field. Tenant first serves tenant-scoped
 * searches with an equality seek before the prefix range; token first serves
 * unscoped ones (single-tenant deployments run without a tenant context), which
 * could not use the tenant-first index at all.
 */
export function searchTokenIndexes(field: SearchTokenField): Array<Record<string, 1>> {
  return [
    { tenantId: 1, [field.tokens]: 1 },
    { [field.tokens]: 1, tenantId: 1 },
  ];
}

/** Mongoose drops `undefined` assignments from an update, so they write nothing. */
function writes(doc: UpdateDoc | undefined, key: string): doc is UpdateDoc {
  return doc != null && key in doc && doc[key] !== undefined;
}

const SKIP = Symbol('skip');

/**
 * The value an upsert insert takes for `key` from the query filter: a plain or
 * `$eq` equality is copied into the new document, no condition leaves it unset.
 * Any other condition is ambiguous, so the token field is left for the backfill.
 */
function insertedValue(filter: UpdateDoc | undefined, key: string): unknown {
  const condition = filter?.[key];
  if (condition === undefined) {
    return undefined;
  }
  if (typeof condition === 'string') {
    return condition;
  }
  const eq = operator({ condition }, 'condition');
  return eq && Object.keys(eq).length === 1 && typeof eq.$eq === 'string' ? eq.$eq : SKIP;
}

function operator(update: UpdateDoc, key: string): UpdateDoc | undefined {
  const value = update[key];
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UpdateDoc)
    : undefined;
}

/**
 * Returns `update` with the token fields recomputed for every source field it
 * writes, through `$set`, `$setOnInsert`, `$unset` or a top-level replacement
 * value. Each token field depends on one source field, so a partial update
 * stays correct. On an upsert, a token field whose source the update does not
 * write is initialized on insert from the source's equality condition in
 * `filter` (MongoDB copies it into the new document), or to `[]` when the
 * filter has none, so new documents never look un-migrated. Copy-on-write: the same reference comes back when nothing
 * changes. Pipeline updates are returned untouched.
 *
 * Mongoose runs no middleware for `bulkWrite`; a bulk write that changes a
 * source field must pass its update through this function.
 */
export function withSearchTokens<T>(
  fields: readonly SearchTokenField[],
  update: T,
  options: { upsert?: boolean; filter?: UpdateDoc } = {},
): T {
  if (update == null || typeof update !== 'object' || Array.isArray(update)) {
    return update;
  }
  const source = update as UpdateDoc;
  let next: UpdateDoc | undefined;
  const write = (op: string | null, key: string, tokens: string[]) => {
    next ??= { ...source };
    if (op == null) {
      next[key] = tokens;
      return;
    }
    next[op] = { ...(operator(next, op) ?? {}), [key]: tokens };
  };

  for (const field of fields) {
    const set = operator(source, '$set');
    const setOnInsert = operator(source, '$setOnInsert');
    const unset = operator(source, '$unset');
    let written = true;
    if (writes(set, field.source)) {
      write('$set', field.tokens, computeSearchTokens(field.kind, set[field.source]));
    } else if (writes(source, field.source)) {
      write(null, field.tokens, computeSearchTokens(field.kind, source[field.source]));
    } else if (writes(unset, field.source)) {
      write('$set', field.tokens, []);
    } else {
      written = false;
    }
    if (writes(setOnInsert, field.source)) {
      write(
        '$setOnInsert',
        field.tokens,
        computeSearchTokens(field.kind, setOnInsert[field.source]),
      );
    } else if (options.upsert && !written) {
      const condition = insertedValue(options.filter, field.source);
      if (condition !== SKIP) {
        write('$setOnInsert', field.tokens, computeSearchTokens(field.kind, condition));
      }
    }
  }
  return (next ?? source) as T;
}

export interface SearchFilterOptions {
  /** Anchor the legacy fallback at the start of the field, for callers whose old search was a prefix match. */
  legacyPrefix?: boolean;
}

/**
 * Builds the filter for a word-prefix search, or `null` when the query has
 * nothing to match.
 *
 * Every query token must prefix-match a token of some field (fields may
 * differ per token, so "john gmail" finds John at gmail.com). Fields that
 * store their whole value (email, username) also match the whole query as a
 * prefix, so a pasted "john.smith@exa" works. Documents written before the
 * token fields existed fall back to the caller's old case-insensitive regex
 * on the source field (unanchored, or anchored with `legacyPrefix`); the
 * fallback branches seek the token index on `$exists: false` and match
 * nothing once the backfill has run.
 */
export function buildSearchTokenFilter(
  fields: readonly SearchTokenField[],
  query: string,
  options: SearchFilterOptions = {},
): Record<string, unknown> | null {
  const trimmed = query.trim();
  const normalized = normalizeSearchText(trimmed);
  const queryTokens = [...new Set(words(normalized))];
  const whole = truncate(normalized, MAX_SEARCH_VALUE_LENGTH);
  const matchWhole = whole.length > 0 && !(queryTokens.length === 1 && queryTokens[0] === whole);
  if (
    !trimmed ||
    queryTokens.length > MAX_SEARCH_QUERY_TOKENS ||
    (queryTokens.length === 0 && !matchWhole)
  ) {
    return null;
  }

  const legacy = new RegExp(`${options.legacyPrefix ? '^' : ''}${escapeRegExp(trimmed)}`, 'i');
  const shared: Record<string, unknown>[] = [];
  for (const field of fields) {
    if (matchWhole && field.kind !== 'words') {
      shared.push({ [field.tokens]: new RegExp(`^${escapeRegExp(whole)}`) });
    }
    shared.push({ [field.tokens]: { $exists: false }, [field.source]: legacy });
  }

  if (queryTokens.length === 0) {
    return { $or: shared };
  }
  const clauses = queryTokens.map((token) => {
    const prefix = new RegExp(`^${escapeRegExp(token)}`);
    return { $or: [...fields.map((field) => ({ [field.tokens]: prefix })), ...shared] };
  });
  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

export function buildUserSearchFilter(
  query: string,
  options?: SearchFilterOptions,
): Record<string, unknown> | null {
  return buildSearchTokenFilter(USER_SEARCH_TOKEN_FIELDS, query, options);
}

export function buildGroupSearchFilter(query: string): Record<string, unknown> | null {
  return buildSearchTokenFilter(GROUP_SEARCH_TOKEN_FIELDS, query);
}
