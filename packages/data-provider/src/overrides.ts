import { ZodFirstPartyTypeKind } from 'zod';
import type { ZodTypeAny } from 'zod';
import { configSchema } from './config';

export type ConfigOverrideIssue = {
  /** Dot-path of the rejected override field, in YAML (`TCustomConfig`) keys. */
  path: string;
  /** The same location as keys, unambiguous when a record key itself contains a dot. */
  segments: string[];
  message: string;
};

type PlainObject = { [key: string]: unknown };

/**
 * Override arrays merged item-by-item over the base by a key field rather than replaced,
 * so each item may carry only the fields it changes, but must carry its key.
 */
const PARTIAL_ARRAY_KEYS: Record<string, string> = { 'endpoints.custom': 'name' };
const MAX_DEPTH = 32;

function isPlainObject(value: unknown): value is PlainObject {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function toIssue(segments: string[], message: string): ConfigOverrideIssue {
  return { path: segments.join('.'), segments, message };
}

/** One wrapper that does not change which fields an object accepts, or the schema itself. */
function unwrapOnce(schema: ZodTypeAny): ZodTypeAny {
  const def = schema._def;
  switch (def.typeName) {
    case ZodFirstPartyTypeKind.ZodOptional:
    case ZodFirstPartyTypeKind.ZodNullable:
    case ZodFirstPartyTypeKind.ZodDefault:
    case ZodFirstPartyTypeKind.ZodCatch:
    case ZodFirstPartyTypeKind.ZodReadonly:
      return def.innerType;
    case ZodFirstPartyTypeKind.ZodEffects:
      return def.schema;
    case ZodFirstPartyTypeKind.ZodBranded:
      return def.type;
    case ZodFirstPartyTypeKind.ZodPipeline:
      return def.in;
    case ZodFirstPartyTypeKind.ZodLazy:
      return def.getter();
    default:
      return schema;
  }
}

/** Strips wrappers that do not change which fields an object accepts. */
function unwrap(schema: ZodTypeAny): ZodTypeAny {
  let current = schema;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const next = unwrapOnce(current);
    if (next === current) {
      return current;
    }
    current = next;
  }
  return current;
}

function checkLeaf(schema: ZodTypeAny, value: unknown, segments: string[]): ConfigOverrideIssue[] {
  const result = schema.safeParse(value);
  if (result.success) {
    return [];
  }
  const [issue] = result.error.issues;
  const detail =
    issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message;
  return [toIssue(segments, detail)];
}

function hasRefinement(schema: ZodTypeAny): boolean {
  let current = schema;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const def = current._def;
    if (def.typeName === ZodFirstPartyTypeKind.ZodEffects && def.effect.type === 'refinement') {
      return true;
    }
    const next = unwrapOnce(current);
    if (next === current) {
      return false;
    }
    current = next;
  }
  return false;
}

/**
 * Whether a refinement issue judges only what the patch supplies. A record entry stands
 * alone. In an object, parsing fills defaults for absent fields, so an issue on a scalar
 * field may come from a field the base provides; an issue inside a supplied field, or on
 * a supplied array (which replaces the base whole), judges the patch's own value.
 */
function judgesSuppliedValue(
  inner: ZodTypeAny,
  value: PlainObject,
  path: Array<string | number>,
): boolean {
  const [head] = path;
  if (path.length === 0 || !Object.prototype.hasOwnProperty.call(value, head)) {
    return false;
  }
  const def = inner._def;
  if (def.typeName !== ZodFirstPartyTypeKind.ZodObject || path.length > 1) {
    return true;
  }
  const fieldSchema = (def.shape() as Record<string, ZodTypeAny>)[String(head)];
  return (
    fieldSchema != null && unwrap(fieldSchema)._def.typeName === ZodFirstPartyTypeKind.ZodArray
  );
}

/**
 * Applies an object's refinements to a patch of it, keeping only the issues that judge
 * what the patch supplies. A rule relating fields reports on the one it finds missing,
 * which the base may provide, and a rule on the whole object judges the merged result,
 * so both are left out rather than rejecting a valid partial write.
 */
function checkRefinements(
  schema: ZodTypeAny,
  value: PlainObject,
  segments: string[],
): ConfigOverrideIssue[] {
  if (!hasRefinement(schema)) {
    return [];
  }
  const result = schema.safeParse(value);
  if (result.success) {
    return [];
  }
  const inner = unwrap(schema);
  return result.error.issues
    .filter((issue) => issue.code === 'custom' && judgesSuppliedValue(inner, value, issue.path))
    .map((issue) => {
      const path = issue.path.map(String);
      const itemEnd = path.findIndex((segment) => /^\d+$/.test(segment)) + 1;
      if (itemEnd === 0 || itemEnd === path.length) {
        return toIssue([...segments, ...path], issue.message);
      }
      /** An array item is removed whole, never left without the field that failed. */
      const detail = `${path.slice(itemEnd).join('.')}: ${issue.message}`;
      return toIssue([...segments, ...path.slice(0, itemEnd)], detail);
    });
}

/**
 * Validates an override value the way it is applied: plain objects are deep-merged over
 * the base config, so each provided field is checked against its own schema and absent
 * fields are left to the base. Keys the schema does not define are not checked, and
 * object-level refinements are skipped because they judge the merged object, not the patch.
 */
function checkPartial(
  schema: ZodTypeAny,
  value: unknown,
  segments: string[],
  depth: number,
): ConfigOverrideIssue[] {
  const inner = unwrap(schema);
  const def = inner._def;
  if (depth >= MAX_DEPTH) {
    return [];
  }

  const path = segments.join('.');
  const keyField = Object.prototype.hasOwnProperty.call(PARTIAL_ARRAY_KEYS, path)
    ? PARTIAL_ARRAY_KEYS[path]
    : undefined;
  if (def.typeName === ZodFirstPartyTypeKind.ZodArray && Array.isArray(value) && keyField) {
    return value.flatMap((item, index) => {
      const itemSegments = [...segments, String(index)];
      if (isPlainObject(item) && (typeof item[keyField] !== 'string' || item[keyField] === '')) {
        return [toIssue(itemSegments, `${keyField}: Required`)];
      }
      return checkPartial(def.type, item, itemSegments, depth + 1);
    });
  }

  if (!isPlainObject(value)) {
    return checkLeaf(schema, value, segments);
  }

  switch (def.typeName) {
    case ZodFirstPartyTypeKind.ZodObject: {
      const shape = def.shape() as Record<string, ZodTypeAny>;
      const issues = Object.entries(value).flatMap(([key, fieldValue]) => {
        const fieldSchema = Object.prototype.hasOwnProperty.call(shape, key)
          ? shape[key]
          : undefined;
        return fieldSchema
          ? checkPartial(fieldSchema, fieldValue, [...segments, key], depth + 1)
          : [];
      });
      return issues.length > 0 ? issues : checkRefinements(schema, value, segments);
    }
    case ZodFirstPartyTypeKind.ZodRecord: {
      const issues = Object.entries(value).flatMap(([key, fieldValue]) =>
        checkPartial(def.valueType, fieldValue, [...segments, key], depth + 1),
      );
      return issues.length > 0 ? issues : checkRefinements(schema, value, segments);
    }
    case ZodFirstPartyTypeKind.ZodIntersection:
      return [
        ...checkPartial(def.left, value, segments, depth + 1),
        ...checkPartial(def.right, value, segments, depth + 1),
      ];
    case ZodFirstPartyTypeKind.ZodUnion:
    case ZodFirstPartyTypeKind.ZodDiscriminatedUnion:
      return checkOptions(def.options as ZodTypeAny[], value, segments, depth);
    default:
      return checkLeaf(schema, value, segments);
  }
}

/** How many of an object value's keys a schema defines; records define every key. */
function countKnownKeys(schema: ZodTypeAny, value: PlainObject, depth: number): number {
  const def = unwrap(schema)._def;
  if (depth >= MAX_DEPTH) {
    return 0;
  }
  switch (def.typeName) {
    case ZodFirstPartyTypeKind.ZodObject: {
      const shape = def.shape() as Record<string, ZodTypeAny>;
      return Object.keys(value).filter((key) => Object.prototype.hasOwnProperty.call(shape, key))
        .length;
    }
    case ZodFirstPartyTypeKind.ZodRecord:
      return Object.keys(value).length;
    case ZodFirstPartyTypeKind.ZodIntersection:
      return Math.max(
        countKnownKeys(def.left, value, depth + 1),
        countKnownKeys(def.right, value, depth + 1),
      );
    case ZodFirstPartyTypeKind.ZodUnion:
    case ZodFirstPartyTypeKind.ZodDiscriminatedUnion:
      return Math.max(
        0,
        ...(def.options as ZodTypeAny[]).map((option) => countKnownKeys(option, value, depth + 1)),
      );
    default:
      return 0;
  }
}

/**
 * An object value is judged only by the options that define the most of its keys, so an
 * option that ignores every supplied key cannot accept it by reporting nothing.
 */
function getCandidateOptions(options: ZodTypeAny[], value: unknown, depth: number): ZodTypeAny[] {
  if (!isPlainObject(value)) {
    return options;
  }
  const counts = options.map((option) => countKnownKeys(option, value, depth));
  const best = Math.max(0, ...counts);
  return best === 0 ? options : options.filter((_, index) => counts[index] === best);
}

/** A value matching any option is valid; otherwise report the closest option's issues. */
function checkOptions(
  options: ZodTypeAny[],
  value: unknown,
  segments: string[],
  depth: number,
): ConfigOverrideIssue[] {
  let closest: ConfigOverrideIssue[] | undefined;
  let closestRank = Infinity;
  for (const option of getCandidateOptions(options, value, depth)) {
    const issues = checkPartial(option, value, segments, depth + 1);
    if (issues.length === 0) {
      return issues;
    }
    /** Ties go to an option whose shape matched, i.e. one that reported a nested field. */
    const matched = issues.some((issue) => issue.segments.length > segments.length);
    const rank = issues.length * 2 + (matched ? 0 : 1);
    if (rank < closestRank) {
      closest = issues;
      closestRank = rank;
    }
  }
  return closest ?? [];
}

/** Merges alternative resolutions: unreachable only when every alternative is. */
function combineResolutions(results: Array<ZodTypeAny[] | null>): ZodTypeAny[] | null {
  const reachable = results.filter((result): result is ZodTypeAny[] => result !== null);
  return reachable.length === 0 ? null : reachable.flat();
}

/**
 * Every schema a dot-path can address; a union contributes each of its options. An empty
 * list means the path leaves the schema through an undefined key, and `null` means it
 * continues past a field that holds a value rather than fields.
 */
function resolveSchemas(schema: ZodTypeAny, segments: string[]): ZodTypeAny[] | null {
  if (segments.length === 0) {
    return [schema];
  }
  const [segment, ...rest] = segments;
  const inner = unwrap(schema);
  const def = inner._def;
  switch (def.typeName) {
    case ZodFirstPartyTypeKind.ZodObject: {
      const shape = def.shape() as Record<string, ZodTypeAny>;
      return Object.prototype.hasOwnProperty.call(shape, segment)
        ? resolveSchemas(shape[segment], rest)
        : [];
    }
    case ZodFirstPartyTypeKind.ZodRecord:
      return resolveSchemas(def.valueType, rest);
    case ZodFirstPartyTypeKind.ZodArray:
      return /^\d+$/.test(segment) ? resolveSchemas(def.type, rest) : null;
    case ZodFirstPartyTypeKind.ZodIntersection:
      return combineResolutions([
        resolveSchemas(def.left, segments),
        resolveSchemas(def.right, segments),
      ]);
    case ZodFirstPartyTypeKind.ZodUnion:
    case ZodFirstPartyTypeKind.ZodDiscriminatedUnion:
      return combineResolutions(
        (def.options as ZodTypeAny[]).map((option) => resolveSchemas(option, segments)),
      );
    case ZodFirstPartyTypeKind.ZodAny:
    case ZodFirstPartyTypeKind.ZodUnknown:
      return [];
    default:
      return null;
  }
}

/**
 * An item of a merged-by-key array is found by its key, not its index, so a path into one
 * item would store a keyless item that the merge then drops.
 */
function getIndexedItemIssue(segments: string[]): ConfigOverrideIssue | undefined {
  for (let end = 1; end < segments.length; end++) {
    const arrayPath = segments.slice(0, end).join('.');
    if (Object.prototype.hasOwnProperty.call(PARTIAL_ARRAY_KEYS, arrayPath)) {
      return toIssue(
        segments,
        `Write the whole ${arrayPath} array; its items are merged by ${PARTIAL_ARRAY_KEYS[arrayPath]}`,
      );
    }
  }
  return undefined;
}

/**
 * Checks a principal config override against `configSchema` before it is stored or merged.
 *
 * `fieldPath` addresses where `value` is written (empty for a whole overrides document).
 * Returns one issue per rejected field; an empty list means every field `configSchema`
 * defines is valid. Paths the schema does not define are accepted unchanged.
 */
export function getConfigOverrideIssues(value: unknown, fieldPath = ''): ConfigOverrideIssue[] {
  const segments = fieldPath ? fieldPath.split('.') : [];
  const indexedItemIssue = getIndexedItemIssue(segments);
  if (indexedItemIssue) {
    return [indexedItemIssue];
  }
  const schemas = resolveSchemas(configSchema, segments);
  if (schemas === null) {
    return [toIssue(segments, 'Path continues past a field that is not an object')];
  }
  if (schemas.length === 0) {
    return [];
  }
  return checkOptions(schemas, value, segments, 0);
}
