import type { OneOrMany } from '~/types/query';

/** Maps every criterion of a domain query to the field it is stored under. */
export type FieldMap<TQuery> = Readonly<Record<keyof TQuery & string, string>>;

/** The value shapes a domain criterion may carry. */
type CriterionValue = string | number | boolean | Date;

function isCriterionValue(value: unknown): value is CriterionValue {
  const type = typeof value;
  return type === 'string' || type === 'number' || type === 'boolean' || value instanceof Date;
}

/**
 * Rejects anything that is not a scalar or a list of scalars.
 *
 * A criterion is a domain value, never a query fragment. Without this a
 * JavaScript caller could pass `{ agentId: { $ne: null } }` and have the
 * operator copied verbatim into the filter, widening the scope the field map
 * was supposed to fix.
 */
function assertCriterionValue(
  key: string,
  value: unknown,
): asserts value is OneOrMany<CriterionValue> {
  const values = Array.isArray(value) ? value : [value];
  for (const entry of values) {
    if (!isCriterionValue(entry)) {
      throw new Error(
        `Invalid value for query criterion '${key}': expected a scalar or array of scalars`,
      );
    }
  }
}

/**
 * Translates a scalar-or-list criterion into a Mongo match expression. Domain
 * query types express "any of these" as an array; the engine spells it.
 */
export function matchAny<T>(value: OneOrMany<T>): T | { $in: T[] } {
  return Array.isArray(value) ? { $in: value } : value;
}

/**
 * Builds a Mongo filter from a domain query, omitting criteria the caller left
 * undefined.
 *
 * Throws on any criterion the field map does not cover, and on any value that
 * is not a scalar or list of scalars. Callers in `api/` are JavaScript and get
 * no compile-time checking, and a silently accepted bad criterion would widen
 * the filter — an unscoped `findOne` returns an arbitrary document rather than
 * none, and an unscoped `deleteMany` removes every document — so this fails
 * closed instead.
 *
 * Keys are validated before the undefined-omission rule is applied: a
 * misspelled criterion that happens to carry `undefined` must still be
 * rejected, not quietly skipped. The lookup is an own-property check so that
 * inherited names like `toString` cannot resolve through the field map's
 * prototype.
 */
export function buildFilter<TQuery extends object, TFilter>(
  query: TQuery,
  fields: FieldMap<TQuery>,
): TFilter {
  const filter: Record<string, unknown> = {};
  for (const key of Object.keys(query) as Array<keyof TQuery & string>) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) {
      throw new Error(`Unknown query criterion: '${key}'`);
    }
    const value = query[key];
    if (value === undefined) {
      continue;
    }
    assertCriterionValue(key, value);
    filter[fields[key]] = matchAny(value);
  }
  return filter as TFilter;
}
