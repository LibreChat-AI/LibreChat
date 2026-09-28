import { ZodFirstPartyTypeKind } from 'zod';
import type { ZodTypeAny } from 'zod';
import { configSchema } from './config';

export type ConfigOverrideIssue = {
  /** Dot-path of the rejected override field, in YAML (`TCustomConfig`) keys. */
  path: string;
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

function joinPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

/** Strips wrappers that do not change which fields an object accepts. */
function unwrap(schema: ZodTypeAny): ZodTypeAny {
  let current = schema;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const def = current._def;
    switch (def.typeName) {
      case ZodFirstPartyTypeKind.ZodOptional:
      case ZodFirstPartyTypeKind.ZodNullable:
      case ZodFirstPartyTypeKind.ZodDefault:
      case ZodFirstPartyTypeKind.ZodCatch:
      case ZodFirstPartyTypeKind.ZodReadonly:
        current = def.innerType;
        break;
      case ZodFirstPartyTypeKind.ZodEffects:
        current = def.schema;
        break;
      case ZodFirstPartyTypeKind.ZodBranded:
        current = def.type;
        break;
      case ZodFirstPartyTypeKind.ZodPipeline:
        current = def.in;
        break;
      case ZodFirstPartyTypeKind.ZodLazy:
        current = def.getter();
        break;
      default:
        return current;
    }
  }
  return current;
}

function checkLeaf(schema: ZodTypeAny, value: unknown, path: string): ConfigOverrideIssue[] {
  const result = schema.safeParse(value);
  if (result.success) {
    return [];
  }
  const [issue] = result.error.issues;
  const detail =
    issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message;
  return [{ path, message: detail }];
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
  path: string,
  depth: number,
): ConfigOverrideIssue[] {
  const inner = unwrap(schema);
  const def = inner._def;
  if (depth >= MAX_DEPTH) {
    return [];
  }

  const keyField = Object.prototype.hasOwnProperty.call(PARTIAL_ARRAY_KEYS, path)
    ? PARTIAL_ARRAY_KEYS[path]
    : undefined;
  if (def.typeName === ZodFirstPartyTypeKind.ZodArray && Array.isArray(value) && keyField) {
    return value.flatMap((item, index) => {
      const itemPath = joinPath(path, String(index));
      if (isPlainObject(item) && (typeof item[keyField] !== 'string' || item[keyField] === '')) {
        return [{ path: itemPath, message: `${keyField}: Required` }];
      }
      return checkPartial(def.type, item, itemPath, depth + 1);
    });
  }

  if (!isPlainObject(value)) {
    return checkLeaf(schema, value, path);
  }

  switch (def.typeName) {
    case ZodFirstPartyTypeKind.ZodObject: {
      const shape = def.shape() as Record<string, ZodTypeAny>;
      return Object.entries(value).flatMap(([key, fieldValue]) => {
        const fieldSchema = Object.prototype.hasOwnProperty.call(shape, key)
          ? shape[key]
          : undefined;
        return fieldSchema
          ? checkPartial(fieldSchema, fieldValue, joinPath(path, key), depth + 1)
          : [];
      });
    }
    case ZodFirstPartyTypeKind.ZodRecord:
      return Object.entries(value).flatMap(([key, fieldValue]) =>
        checkPartial(def.valueType, fieldValue, joinPath(path, key), depth + 1),
      );
    case ZodFirstPartyTypeKind.ZodIntersection:
      return [
        ...checkPartial(def.left, value, path, depth + 1),
        ...checkPartial(def.right, value, path, depth + 1),
      ];
    case ZodFirstPartyTypeKind.ZodUnion:
    case ZodFirstPartyTypeKind.ZodDiscriminatedUnion:
      return checkOptions(def.options as ZodTypeAny[], value, path, depth);
    default:
      return checkLeaf(schema, value, path);
  }
}

/** A value matching any option is valid; otherwise report the closest option's issues. */
function checkOptions(
  options: ZodTypeAny[],
  value: unknown,
  path: string,
  depth: number,
): ConfigOverrideIssue[] {
  let closest: ConfigOverrideIssue[] | undefined;
  let closestRank = Infinity;
  for (const option of options) {
    const issues = checkPartial(option, value, path, depth + 1);
    if (issues.length === 0) {
      return issues;
    }
    /** Ties go to an option whose shape matched, i.e. one that reported a nested field. */
    const rank = issues.length * 2 + (issues.every((issue) => issue.path === path) ? 1 : 0);
    if (rank < closestRank) {
      closest = issues;
      closestRank = rank;
    }
  }
  return closest ?? [];
}

/** Every schema a dot-path can address; a union contributes each of its options. */
function resolveSchemas(schema: ZodTypeAny, segments: string[]): ZodTypeAny[] {
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
      return /^\d+$/.test(segment) ? resolveSchemas(def.type, rest) : [];
    case ZodFirstPartyTypeKind.ZodIntersection:
      return [...resolveSchemas(def.left, segments), ...resolveSchemas(def.right, segments)];
    case ZodFirstPartyTypeKind.ZodUnion:
    case ZodFirstPartyTypeKind.ZodDiscriminatedUnion:
      return (def.options as ZodTypeAny[]).flatMap((option) => resolveSchemas(option, segments));
    default:
      return [];
  }
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
  const schemas = resolveSchemas(configSchema, segments);
  if (schemas.length === 0) {
    return [];
  }
  return checkOptions(schemas, value, fieldPath, 0);
}
