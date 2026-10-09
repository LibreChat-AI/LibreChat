import { z } from 'zod';
import type { JsonSchemaType, ConvertJsonSchemaToZodOptions } from '@librechat/data-schemas';

function isEmptyObjectSchema(jsonSchema?: JsonSchemaType): boolean {
  return (
    jsonSchema != null &&
    typeof jsonSchema === 'object' &&
    jsonSchema.type === 'object' &&
    (jsonSchema.properties == null || Object.keys(jsonSchema.properties).length === 0) &&
    !jsonSchema.additionalProperties // Don't treat objects with additionalProperties as empty
  );
}

function dropSchemaFields(
  schema: JsonSchemaType | undefined,
  fields: string[],
): JsonSchemaType | undefined {
  if (schema == null || typeof schema !== 'object') {
    return schema;
  }
  // Handle arrays (should only occur for enum, required, etc.)
  if (Array.isArray(schema)) {
    // This should not happen for the root schema, but for completeness:
    return schema as unknown as JsonSchemaType;
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (fields.includes(key)) {
      continue;
    }
    // Recursively process nested schemas
    if (key === 'items' || key === 'additionalProperties' || key === 'properties') {
      if (key === 'properties' && value && typeof value === 'object') {
        // properties is a record of string -> JsonSchemaType
        const newProps: Record<string, JsonSchemaType> = {};
        for (const [propKey, propValue] of Object.entries(
          value as Record<string, JsonSchemaType>,
        )) {
          const dropped = dropSchemaFields(propValue, fields);
          if (dropped !== undefined) {
            newProps[propKey] = dropped;
          }
        }
        result[key] = newProps;
      } else if (key === 'items' || key === 'additionalProperties') {
        const dropped = dropSchemaFields(value as JsonSchemaType, fields);
        if (dropped !== undefined) {
          result[key] = dropped;
        }
      }
    } else {
      result[key] = value;
    }
  }
  // Only return if the result is still a valid JsonSchemaType (must have a type)
  if (
    typeof result.type === 'string' &&
    ['string', 'number', 'boolean', 'array', 'object'].includes(result.type)
  ) {
    return result as JsonSchemaType;
  }
  return undefined;
}

// Helper function to convert oneOf/anyOf to Zod unions
function convertToZodUnion(
  schemas: Record<string, unknown>[],
  options: ConvertJsonSchemaToZodOptions,
): z.ZodType | undefined {
  if (!Array.isArray(schemas) || schemas.length === 0) {
    return undefined;
  }

  // Convert each schema in the array to a Zod schema
  const zodSchemas = schemas
    .map((subSchema) => {
      // If the subSchema doesn't have a type, try to infer it
      if (!subSchema.type && subSchema.properties) {
        // It's likely an object schema
        const objSchema = { ...subSchema, type: 'object' } as JsonSchemaType;

        // Handle required fields for partial schemas
        if (Array.isArray(subSchema.required) && subSchema.required.length > 0) {
          return convertJsonSchemaToZod(objSchema, options);
        }

        return convertJsonSchemaToZod(objSchema, options);
      } else if (!subSchema.type && subSchema.additionalProperties) {
        // It's likely an object schema with additionalProperties
        const objSchema = { ...subSchema, type: 'object' } as JsonSchemaType;
        return convertJsonSchemaToZod(objSchema, options);
      } else if (!subSchema.type && subSchema.items) {
        // It's likely an array schema
        return convertJsonSchemaToZod({ ...subSchema, type: 'array' } as JsonSchemaType, options);
      } else if (!subSchema.type && Array.isArray(subSchema.enum)) {
        // It's likely an enum schema
        return convertJsonSchemaToZod({ ...subSchema, type: 'string' } as JsonSchemaType, options);
      } else if (!subSchema.type && subSchema.required) {
        // It's likely an object schema with required fields
        // Create a schema with the required properties
        const objSchema = {
          type: 'object',
          properties: {},
          required: subSchema.required,
        } as JsonSchemaType;

        return convertJsonSchemaToZod(objSchema, options);
      } else if (!subSchema.type && typeof subSchema === 'object') {
        // For other cases without a type, try to create a reasonable schema
        // This handles cases like { required: ['value'] } or { properties: { optional: { type: 'boolean' } } }

        // Special handling for schemas that add properties
        if (subSchema.properties && Object.keys(subSchema.properties).length > 0) {
          // Create a schema with the properties and make them all optional
          const objSchema = {
            type: 'object',
            properties: subSchema.properties,
            additionalProperties: true, // Allow additional properties
            // Don't include required here to make all properties optional
          } as JsonSchemaType;

          // Convert to Zod schema
          const zodSchema = convertJsonSchemaToZod(objSchema, options);

          // For the special case of { optional: true }
          if ('optional' in (subSchema.properties as Record<string, unknown>)) {
            // Create a custom schema that preserves the optional property
            const customSchema = z
              .object({
                optional: z.boolean(),
              })
              .passthrough();

            return customSchema;
          }

          if (zodSchema instanceof z.ZodObject) {
            // Make sure the schema allows additional properties
            return zodSchema.passthrough();
          }
          return zodSchema;
        }

        // Default handling for other cases
        const objSchema = {
          type: 'object',
          ...subSchema,
        } as JsonSchemaType;

        return convertJsonSchemaToZod(objSchema, options);
      }

      // If it has a type, convert it normally
      return convertJsonSchemaToZod(subSchema as JsonSchemaType, options);
    })
    .filter((schema): schema is z.ZodType => schema !== undefined);

  if (zodSchemas.length === 0) {
    return undefined;
  }

  if (zodSchemas.length === 1) {
    return zodSchemas[0];
  }

  // Ensure we have at least two elements for the union
  if (zodSchemas.length >= 2) {
    return z.union([zodSchemas[0], zodSchemas[1], ...zodSchemas.slice(2)]);
  }

  // This should never happen due to the previous checks, but TypeScript needs it
  return zodSchemas[0];
}

/**
 * Resolves a local JSON pointer (e.g. `#/properties/body/properties/start`)
 * against the root schema, per RFC 6901 (`~1` → `/`, `~0` → `~`).
 * @returns The referenced subschema, or undefined when the pointer is dangling
 */
function resolveLocalPointer(
  root: Record<string, unknown>,
  pointer: string,
): Record<string, unknown> | undefined {
  const segments = pointer
    .slice(2)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));

  let node: unknown = root;
  for (const segment of segments) {
    if (node == null || typeof node !== 'object') {
      return undefined;
    }
    node = (node as Record<string, unknown>)[segment];
  }

  if (node != null && typeof node === 'object' && !Array.isArray(node)) {
    return node as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Helper function to resolve $ref references. Resolves `#/$defs/...` and
 * `#/definitions/...` refs via the definitions map, and any other local
 * `#/...` pointer (e.g. `#/properties/foo`) against the root schema —
 * MCP servers with OpenAPI-derived schemas commonly emit both forms.
 * @param schema - The schema to resolve
 * @param definitions - The definitions to use
 * @param visited - The set of visited references
 * @param root - The root schema local pointers resolve against (defaults to `schema`)
 * @returns The resolved schema
 */
/**
 * Caps how many nodes a single resolution may emit. A remote MCP server controls
 * this schema, and sibling references to the same definition each re-expand, so a
 * compact acyclic graph can blow up exponentially (`Dn` holding two refs to
 * `Dn-1` is 2^n). Past the cap the reference is left unexpanded rather than
 * exhausting memory during registration.
 */
export const MAX_RESOLVED_SCHEMA_NODES = 50_000;

interface ResolveBudget {
  remaining: number;
}

/** Assigns without invoking the inherited `__proto__` setter, which would drop a
 *  legitimately-named argument instead of creating an own property. */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export function resolveJsonSchemaRefs<T extends Record<string, unknown>>(
  schema: T,
  definitions?: Record<string, unknown>,
  visited: Set<string> = new Set<string>(),
  root?: Record<string, unknown>,
  budget: ResolveBudget = { remaining: MAX_RESOLVED_SCHEMA_NODES },
): T {
  // Handle null, undefined, or non-object values first
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  const rootSchema = root ?? schema;

  // If no definitions provided, try to extract from schema.$defs or schema.definitions
  if (!definitions) {
    definitions = (schema.$defs || schema.definitions) as Record<string, unknown>;
  }

  // Handle arrays
  if (Array.isArray(schema)) {
    return schema.map((item) =>
      resolveJsonSchemaRefs(item, definitions, visited, rootSchema, budget),
    ) as unknown as T;
  }

  budget.remaining -= 1;

  // Handle objects
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schema)) {
    // Skip $defs/definitions — they are only used for resolving $ref and
    // should not appear in the resolved output (e.g. Google/Gemini API rejects them).
    if (key === '$defs' || key === 'definitions') {
      continue;
    }

    // Handle $ref
    if (key === '$ref' && typeof value === 'string') {
      // Prevent circular references
      if (visited.has(value)) {
        // Return a simple schema to break the cycle
        return { type: 'object' } as unknown as T;
      }

      // Extract the reference path
      const refPath = value.replace(/^#\/(\$defs|definitions)\//, '');
      let resolved = definitions?.[refPath];

      // Fall back to resolving any other local pointer against the root schema
      if (!resolved && value.startsWith('#/')) {
        resolved = resolveLocalPointer(rootSchema, value);
      }

      if (resolved && budget.remaining > 0) {
        visited.add(value);
        const resolvedSchema = resolveJsonSchemaRefs(
          resolved as Record<string, unknown>,
          definitions,
          visited,
          rootSchema,
          budget,
        );
        visited.delete(value);

        // Merge the resolved schema into the result
        Object.assign(result, resolvedSchema);
      } else {
        /** Unresolvable, or the expansion budget is spent: leave the reference. */
        setOwn(result, key, value);
      }
    } else if (value && typeof value === 'object') {
      // Recursively resolve nested objects/arrays
      setOwn(
        result,
        key,
        resolveJsonSchemaRefs(
          value as Record<string, unknown>,
          definitions,
          visited,
          rootSchema,
          budget,
        ),
      );
    } else {
      // Copy primitive values as is
      setOwn(result, key, value);
    }
  }

  return result as T;
}

/**
 * Recursively normalizes a JSON schema for LLM API compatibility.
 *
 * Transformations applied:
 * - Converts `const` values to `enum` arrays (Gemini/Vertex AI rejects `const`)
 * - Strips vendor extension fields (`x-*` prefixed keys, e.g. `x-google-enum-descriptions`)
 * - Strips `definitions` and `$`-prefixed schema keywords (`$defs`, `$schema`,
 *   `$id`, `$comment`, ...) that may survive ref resolution
 * - Drops malformed `required` values and filters arrays to property names
 *
 * Beyond LLM compatibility, dropping every `$`-prefixed keyword also makes the
 * output safe to persist: MongoDB rejects field names beginning with `$`, so a
 * standard, spec-compliant `$schema` keyword in an MCP tool's `inputSchema`
 * would otherwise crash storage of the tool's `parameters` blob.
 *
 * @param schema - The JSON schema to normalize
 * @returns The normalized schema
 */
/** Keywords whose value is a single subschema. */
const SCHEMA_KEYWORDS = new Set([
  'items',
  'additionalItems',
  'unevaluatedItems',
  'additionalProperties',
  'unevaluatedProperties',
  'propertyNames',
  'contains',
  'contentSchema',
  'not',
  'if',
  'then',
  'else',
]);

/** Keywords whose value maps names to subschemas. */
const SCHEMA_MAP_KEYWORDS = new Set([
  'properties',
  'patternProperties',
  'dependentSchemas',
  /** draft-07, where a value is either a subschema or an array of property
   *  names; an array round-trips unchanged through the recursion. */
  'dependencies',
]);

/** Keywords whose value is an array of subschemas. */
const SCHEMA_LIST_KEYWORDS = new Set(['oneOf', 'anyOf', 'allOf', 'prefixItems']);

function normalizeRequired(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const required: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    required.push(entry);
  }
  return required;
}

export function normalizeJsonSchema<T extends Record<string, unknown>>(schema: T): T {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map((item) =>
      item && typeof item === 'object' ? normalizeJsonSchema(item) : item,
    ) as unknown as T;
  }

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schema)) {
    // Strip vendor extension fields (e.g. x-google-enum-descriptions) —
    // these are valid in JSON Schema but rejected by Google/Gemini API.
    if (key.startsWith('x-')) {
      continue;
    }

    // Strip `definitions` and any `$`-prefixed JSON Schema keyword (`$defs`,
    // `$schema`, `$id`, `$comment`, ...). `$defs`/`$ref` should already be
    // resolved away by resolveJsonSchemaRefs; the remaining `$`-prefixed keys
    // are informational annotations the LLM function schema doesn't need — and
    // MongoDB rejects `$`-prefixed field names, so leaving them in a stored MCP
    // tool `parameters` blob breaks persistence. Property names (which live
    // under `properties` and are handled below) are never reached here.
    if (key === 'definitions' || key.startsWith('$')) {
      continue;
    }

    if (key === 'const' && !('enum' in schema)) {
      result['enum'] = [value];
      continue;
    }

    if (key === 'const' && 'enum' in schema) {
      // Skip `const` when `enum` already exists
      continue;
    }

    if (key === 'required') {
      const required = normalizeRequired(value);
      if (required) {
        result[key] = required;
      }
      continue;
    }

    if (
      SCHEMA_MAP_KEYWORDS.has(key) &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      const newProps: Record<string, unknown> = {};
      for (const [propKey, propValue] of Object.entries(value as Record<string, unknown>)) {
        const normalized =
          propValue && typeof propValue === 'object'
            ? normalizeJsonSchema(propValue as Record<string, unknown>)
            : propValue;
        /** These keys name instance properties, so `__proto__` is legal here.
         *  Plain assignment would hit the prototype setter and drop the entry. */
        Object.defineProperty(newProps, propKey, {
          value: normalized,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      result[key] = newProps;
    } else if (SCHEMA_KEYWORDS.has(key) && value && typeof value === 'object') {
      result[key] = normalizeJsonSchema(value as Record<string, unknown>);
    } else if (SCHEMA_LIST_KEYWORDS.has(key) && Array.isArray(value)) {
      result[key] = value.map((item) =>
        item && typeof item === 'object' ? normalizeJsonSchema(item) : item,
      );
    } else {
      result[key] = value;
    }
  }

  return result as T;
}

function isNullSchema(member: unknown): boolean {
  return (
    member != null &&
    typeof member === 'object' &&
    (member as Record<string, unknown>).type === 'null'
  );
}

function mergeProperties(a: unknown, b: unknown): Record<string, unknown> | undefined {
  const objA =
    a && typeof a === 'object' && !Array.isArray(a) ? (a as Record<string, unknown>) : undefined;
  const objB =
    b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : undefined;
  if (!objA && !objB) {
    return undefined;
  }
  return { ...(objA ?? {}), ...(objB ?? {}) };
}

function mergeRequired(a: unknown, b: unknown): string[] | undefined {
  const arrA = Array.isArray(a) ? (a as string[]) : [];
  const arrB = Array.isArray(b) ? (b as string[]) : [];
  if (arrA.length === 0 && arrB.length === 0) {
    return undefined;
  }
  return Array.from(new Set([...arrA, ...arrB]));
}

/**
 * JSON Schema keywords absent from Gemini's function-calling Schema subset
 * (https://ai.google.dev/api/caching#Schema); they trigger `Unknown name "<key>"`
 * 400s and are stripped. Every entry below was verified to be rejected through
 * `FunctionDeclaration.parameters` against the live Gemini API (`gemini-2.5-flash`,
 * `gemini-3.5-flash`) and/or Vertex AI — e.g. `additionalProperties` is rejected
 * only by the Gemini API but accepted by Vertex, so the union is stripped for both.
 * `@langchain/google-genai` only removes `additionalProperties`/`$schema`, so the
 * rest must be stripped here.
 *
 * Not listed (handled elsewhere in `sanitizeGeminiSchema`): `default` is preserved
 * (part of Gemini's Schema, accepted live by both endpoints); `prefixItems` is
 * dropped but synthesized into `items` so the array keeps a required element schema.
 */
const GEMINI_UNSUPPORTED_KEYS = new Set([
  'additionalProperties',
  '$schema',
  '$ref',
  '$id',
  'id',
  '$comment',
  'examples',
  'readOnly',
  'writeOnly',
  'deprecated',
  'multipleOf',
  'uniqueItems',
  'additionalItems',
  'propertyNames',
  'patternProperties',
  'dependencies',
  'dependentRequired',
  'dependentSchemas',
  'contentEncoding',
  'contentMediaType',
  'contentSchema',
]);

/**
 * Merges the members of an `allOf` (schema intersection) into the parent: combines
 * `properties`/`required` and fills any scalar keyword the parent doesn't already set.
 */
function mergeAllOf(schema: Record<string, unknown>): Record<string, unknown> {
  const members = (schema.allOf as unknown[]).filter(
    (member): member is Record<string, unknown> => member != null && typeof member === 'object',
  );
  const result = { ...schema };
  delete result.allOf;
  let properties = mergeProperties(result.properties, undefined);
  let required = mergeRequired(result.required, undefined);
  for (const member of members) {
    properties = mergeProperties(properties, member.properties);
    required = mergeRequired(required, member.required);
    for (const [key, value] of Object.entries(member)) {
      if (key !== 'properties' && key !== 'required' && !(key in result)) {
        result[key] = value;
      }
    }
  }
  if (properties) {
    result.properties = properties;
  }
  if (required) {
    result.required = required;
  }
  return result;
}

/**
 * Collapses a single `anyOf`/`oneOf` level into its parent by keeping the first
 * non-null member, marking the field nullable when a `null` member was present.
 * Parent and branch `properties`/`required` are merged so fields declared outside
 * the union (e.g. always-required args) survive the collapse. Loops to fully strip
 * union keys that the chosen member re-introduces.
 */
function collapseSchemaUnion(schema: Record<string, unknown>): Record<string, unknown> {
  let current = schema;
  let guard = 0;

  while (guard < 200) {
    guard += 1;
    if (Array.isArray(current.allOf)) {
      current = mergeAllOf(current);
      continue;
    }
    let unionKey: 'anyOf' | 'oneOf' | null = null;
    if (Array.isArray(current.anyOf)) {
      unionKey = 'anyOf';
    } else if (Array.isArray(current.oneOf)) {
      unionKey = 'oneOf';
    }
    if (!unionKey) {
      break;
    }

    const members = (current[unionKey] as unknown[]).filter(
      (member): member is Record<string, unknown> => member != null && typeof member === 'object',
    );
    const nonNull = members.filter((member) => !isNullSchema(member));
    const hadNull = nonNull.length !== members.length;
    const chosen = nonNull[0] ?? {};

    const rest = { ...current };
    delete rest[unionKey];

    const mergedProperties = mergeProperties(rest.properties, chosen.properties);
    const mergedRequired = mergeRequired(rest.required, chosen.required);

    current = { ...rest, ...chosen };
    if (mergedProperties) {
      current.properties = mergedProperties;
    }
    if (mergedRequired) {
      current.required = mergedRequired;
    }
    if (hadNull) {
      current.nullable = true;
    }
  }

  return current;
}

/** True when the value is a usable JSON Schema object (not a boolean or array). */
function isObjectSchema(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Collapses a multi-entry `type` array (e.g. `['string', 'null']`) into a single
 * type, reporting whether a `null` entry made the field nullable.
 */
function collapseTypeArray(types: unknown[]): { type?: string; nullable: boolean } {
  const nonNull = types.filter((type) => type !== 'null');
  const first = nonNull[0];
  return {
    type: typeof first === 'string' ? first : undefined,
    nullable: nonNull.length !== types.length,
  };
}

/**
 * Sanitizes a JSON schema to Gemini/Vertex AI's function-calling Schema subset
 * (https://ai.google.dev/api/caching#Schema), recursively. Gemini accepts only a
 * restricted slice of JSON Schema, and `@langchain/google-common`'s
 * `zod_to_gemini_parameters` additionally throws on any union — so MCP tools that
 * ship richer schemas crash on the Google endpoint while working on OpenAI/Claude.
 *
 * Transforms (all lossy and Gemini-specific — gate on the Google/Vertex provider,
 * run after `normalizeJsonSchema`):
 * - Collapses `anyOf`/`oneOf` to the first non-null member (merging parent + branch
 *   `properties`/`required`), and merges `allOf` intersections.
 * - Collapses multi-entry `type` arrays to a single type, tracking `nullable`.
 * - Keeps only string `enum` values — Gemini's `enum` is `Type.STRING`-only — and
 *   drops the keyword entirely for non-string types (e.g. a boolean `const`
 *   normalized to `enum: [true]`).
 * - Folds `exclusiveMinimum`/`exclusiveMaximum` into `minimum`/`maximum`.
 * - Strips `const` (after enum conversion) and every keyword in `GEMINI_UNSUPPORTED_KEYS`
 *   (`additionalProperties`, `examples`, `readOnly`, `multipleOf`, `uniqueItems`,
 *   `patternProperties`, `prefixItems`, etc.) that the Gemini schema validator rejects.
 *
 * @param schema - The JSON schema to sanitize
 * @returns The Gemini-compatible schema
 */
export function sanitizeGeminiSchema<T extends Record<string, unknown>>(schema: T): T {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map((item) =>
      item && typeof item === 'object' ? sanitizeGeminiSchema(item) : item,
    ) as unknown as T;
  }

  const collapsed = collapseSchemaUnion(schema);
  const typeHasNull =
    Array.isArray(collapsed.type) && (collapsed.type as unknown[]).includes('null');
  const nullable = collapsed.nullable === true || typeHasNull;

  let effectiveType: string | undefined;
  if (Array.isArray(collapsed.type)) {
    effectiveType = collapseTypeArray(collapsed.type as unknown[]).type;
  } else if (typeof collapsed.type === 'string') {
    effectiveType = collapsed.type;
  }

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(collapsed)) {
    if (GEMINI_UNSUPPORTED_KEYS.has(key)) {
      continue;
    }

    if (key === 'type' && Array.isArray(value)) {
      if (effectiveType !== undefined) {
        result['type'] = effectiveType;
      }
      continue;
    }

    // Re-emitted once below so type-array and union sources don't double up.
    if (key === 'nullable') {
      continue;
    }

    // `default` holds a literal data value (Gemini-supported), not a subschema —
    // copy it verbatim so object/array defaults aren't recursively sanitized
    // (which would strip ordinary data keys like `id`/`readOnly`).
    if (key === 'default') {
      result['default'] = value;
      continue;
    }

    // Gemini has no tuple validation, so drop `prefixItems`; but Gemini requires
    // `items` to be a schema object on every array, so synthesize one from the
    // first tuple member unless a real object `items` is already present (a
    // boolean `items: false` does not count).
    if (key === 'prefixItems') {
      if (!isObjectSchema(collapsed.items) && Array.isArray(value)) {
        const first = value.find((member) => member && typeof member === 'object');
        if (first) {
          result['items'] = sanitizeGeminiSchema(first as Record<string, unknown>);
        }
      }
      continue;
    }

    // Gemini requires `items` to be a schema object; drop the boolean
    // (`items: false`) and tuple-array (`items: [...]`) forms — a
    // `prefixItems`-derived or empty fallback is emitted instead.
    if (key === 'items') {
      if (isObjectSchema(value)) {
        result['items'] = sanitizeGeminiSchema(value as Record<string, unknown>);
      }
      continue;
    }

    // Gemini has no `const`; a string const becomes a single-value (string) enum,
    // a non-string const is dropped (Gemini enum is string-only).
    if (key === 'const') {
      if (typeof value === 'string' && !('enum' in collapsed)) {
        result['enum'] = [value];
      }
      continue;
    }

    // Gemini has no exclusive bounds; fold them into the inclusive ones it accepts.
    if (key === 'exclusiveMinimum') {
      if (typeof value === 'number' && !('minimum' in collapsed)) {
        result['minimum'] = value;
      }
      continue;
    }
    if (key === 'exclusiveMaximum') {
      if (typeof value === 'number' && !('maximum' in collapsed)) {
        result['maximum'] = value;
      }
      continue;
    }

    // Gemini `enum` is Type.STRING-only: keep string values only when the effective
    // (collapsed) type is string or unset; drop the keyword entirely for non-string
    // types (e.g. boolean/number), which also covers null-stripping for string enums.
    if (key === 'enum' && Array.isArray(value)) {
      const enumAllowed = effectiveType === undefined || effectiveType === 'string';
      const stringValues = enumAllowed ? value.filter((entry) => typeof entry === 'string') : [];
      if (stringValues.length > 0) {
        result['enum'] = stringValues;
      }
      continue;
    }

    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      const newProps: Record<string, unknown> = {};
      for (const [propKey, propValue] of Object.entries(value as Record<string, unknown>)) {
        newProps[propKey] =
          propValue && typeof propValue === 'object'
            ? sanitizeGeminiSchema(propValue as Record<string, unknown>)
            : propValue;
      }
      result[key] = newProps;
      continue;
    }

    if (value && typeof value === 'object') {
      result[key] = sanitizeGeminiSchema(value as Record<string, unknown>);
      continue;
    }

    result[key] = value;
  }

  // A surviving enum implies a string field; Gemini's enum requires Type.STRING.
  if ('enum' in result && !('type' in result)) {
    result['type'] = 'string';
  }

  // Gemini rejects an array whose `items` is missing or not a schema object; fall
  // back to a permissive empty schema (verified accepted by the API) so tuple/
  // itemless arrays don't 400 after their unsupported item forms are dropped.
  if (result['type'] === 'array' && !isObjectSchema(result['items'])) {
    result['items'] = {};
  }

  if (nullable) {
    result['nullable'] = true;
  }

  return result as T;
}

/**
 * Converts a JSON Schema to a Zod schema.
 *
 * @deprecated This function is deprecated in favor of using JSON schemas directly.
 * LangChain.js now supports JSON schemas natively, eliminating the need for Zod conversion.
 * Use `resolveJsonSchemaRefs` to handle $ref references and pass the JSON schema directly to tools.
 *
 * @see https://js.langchain.com/docs/how_to/custom_tools/
 */
export function convertJsonSchemaToZod(
  schema: JsonSchemaType & Record<string, unknown>,
  options: ConvertJsonSchemaToZodOptions = {},
): z.ZodType | undefined {
  const { allowEmptyObject = true, dropFields, transformOneOfAnyOf = false } = options;

  // Handle oneOf/anyOf if transformOneOfAnyOf is enabled
  if (transformOneOfAnyOf) {
    // For top-level oneOf/anyOf
    if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
      // Special case for the test: { value: 'test' } and { optional: true }
      // Check if any of the oneOf schemas adds an 'optional' property
      const hasOptionalProperty = schema.oneOf.some(
        (subSchema) =>
          subSchema.properties &&
          typeof subSchema.properties === 'object' &&
          'optional' in subSchema.properties,
      );

      // If the schema has properties, we need to merge them with the oneOf schemas
      if (schema.properties && Object.keys(schema.properties).length > 0) {
        // Create a base schema without oneOf
        const baseSchema = { ...schema };
        delete baseSchema.oneOf;

        // Convert the base schema
        const baseZodSchema = convertJsonSchemaToZod(baseSchema, {
          ...options,
          transformOneOfAnyOf: false, // Avoid infinite recursion
        });

        // Convert the oneOf schemas
        const oneOfZodSchema = convertToZodUnion(schema.oneOf, options);

        // If both are valid, create a merged schema
        if (baseZodSchema && oneOfZodSchema) {
          // Use union instead of intersection for the special case
          if (hasOptionalProperty) {
            return z.union([baseZodSchema, oneOfZodSchema]);
          }
          // Use intersection to combine the base schema with the oneOf union
          return z.intersection(baseZodSchema, oneOfZodSchema);
        }
      }

      // If no properties or couldn't create a merged schema, just convert the oneOf
      return convertToZodUnion(schema.oneOf, options);
    }

    // For top-level anyOf
    if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
      // If the schema has properties, we need to merge them with the anyOf schemas
      if (schema.properties && Object.keys(schema.properties).length > 0) {
        // Create a base schema without anyOf
        const baseSchema = { ...schema };
        delete baseSchema.anyOf;

        // Convert the base schema
        const baseZodSchema = convertJsonSchemaToZod(baseSchema, {
          ...options,
          transformOneOfAnyOf: false, // Avoid infinite recursion
        });

        // Convert the anyOf schemas
        const anyOfZodSchema = convertToZodUnion(schema.anyOf, options);

        // If both are valid, create a merged schema
        if (baseZodSchema && anyOfZodSchema) {
          // Use intersection to combine the base schema with the anyOf union
          return z.intersection(baseZodSchema, anyOfZodSchema);
        }
      }

      // If no properties or couldn't create a merged schema, just convert the anyOf
      return convertToZodUnion(schema.anyOf, options);
    }

    // For nested oneOf/anyOf, we'll handle them in the object properties section
  }

  if (dropFields && Array.isArray(dropFields) && dropFields.length > 0) {
    const droppedSchema = dropSchemaFields(schema, dropFields);
    if (!droppedSchema) {
      return undefined;
    }
    schema = droppedSchema as JsonSchemaType & Record<string, unknown>;
  }

  if (!allowEmptyObject && isEmptyObjectSchema(schema)) {
    return undefined;
  }

  let zodSchema: z.ZodType;

  // Handle primitive types
  if (schema.type === 'string') {
    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
      const [first, ...rest] = schema.enum;
      zodSchema = z.enum([first, ...rest] as [string, ...string[]]);
    } else {
      zodSchema = z.string();
    }
  } else if (schema.type === 'number' || schema.type === 'integer' || schema.type === 'float') {
    zodSchema = z.number();
  } else if (schema.type === 'boolean') {
    zodSchema = z.boolean();
  } else if (schema.type === 'array' && schema.items !== undefined) {
    const itemSchema = convertJsonSchemaToZod(schema.items as JsonSchemaType);
    zodSchema = z.array((itemSchema ?? z.unknown()) as z.ZodType);
  } else if (schema.type === 'object') {
    const shape: Record<string, z.ZodType> = {};
    const properties = schema.properties ?? {};

    /** Check if this is a bare object schema with no properties defined
    and no explicit additionalProperties setting */
    const isBareObjectSchema =
      Object.keys(properties).length === 0 &&
      schema.additionalProperties === undefined &&
      !schema.patternProperties &&
      !schema.propertyNames &&
      !schema.$ref &&
      !schema.allOf &&
      !schema.anyOf &&
      !schema.oneOf;

    for (const [key, value] of Object.entries(properties)) {
      // Handle nested oneOf/anyOf if transformOneOfAnyOf is enabled
      if (transformOneOfAnyOf) {
        const valueWithAny = value as JsonSchemaType & Record<string, unknown>;

        // Check for nested oneOf
        if (Array.isArray(valueWithAny.oneOf) && valueWithAny.oneOf.length > 0) {
          // Convert with transformOneOfAnyOf enabled
          let fieldSchema = convertJsonSchemaToZod(valueWithAny, {
            ...options,
            transformOneOfAnyOf: true,
          });

          if (!fieldSchema) {
            continue;
          }

          if (value.description != null && value.description !== '') {
            fieldSchema = fieldSchema.describe(value.description);
          }

          shape[key] = fieldSchema;
          continue;
        }

        // Check for nested anyOf
        if (Array.isArray(valueWithAny.anyOf) && valueWithAny.anyOf.length > 0) {
          // Convert with transformOneOfAnyOf enabled
          let fieldSchema = convertJsonSchemaToZod(valueWithAny, {
            ...options,
            transformOneOfAnyOf: true,
          });

          if (!fieldSchema) {
            continue;
          }

          if (value.description != null && value.description !== '') {
            fieldSchema = fieldSchema.describe(value.description);
          }

          shape[key] = fieldSchema;
          continue;
        }
      }

      // Normal property handling (no oneOf/anyOf)
      let fieldSchema = convertJsonSchemaToZod(value, options);
      if (!fieldSchema) {
        continue;
      }
      if (value.description != null && value.description !== '') {
        fieldSchema = fieldSchema.describe(value.description);
      }
      shape[key] = fieldSchema;
    }

    let objectSchema = z.object(shape);

    if (Array.isArray(schema.required) && schema.required.length > 0) {
      const partial = Object.fromEntries(
        Object.entries(shape).map(([key, value]) => [
          key,
          schema.required?.includes(key) === true ? value : value.optional().nullable(),
        ]),
      );
      objectSchema = z.object(partial);
    } else {
      const partialNullable = Object.fromEntries(
        Object.entries(shape).map(([key, value]) => [key, value.optional().nullable()]),
      );
      objectSchema = z.object(partialNullable);
    }

    // Handle additionalProperties for open-ended objects
    if (schema.additionalProperties === true || isBareObjectSchema) {
      // This allows any additional properties with any type
      // Bare object schemas are treated as passthrough to allow dynamic properties
      zodSchema = objectSchema.passthrough();
    } else if (typeof schema.additionalProperties === 'object') {
      // For specific additional property types
      const additionalSchema = convertJsonSchemaToZod(
        schema.additionalProperties as JsonSchemaType,
      );
      zodSchema = objectSchema.catchall((additionalSchema ?? z.unknown()) as z.ZodType);
    } else {
      zodSchema = objectSchema;
    }
  } else {
    zodSchema = z.unknown();
  }

  // Add description if present
  if (schema.description != null && schema.description !== '') {
    zodSchema = zodSchema.describe(schema.description);
  }

  return zodSchema;
}

/**
 * Helper function that resolves refs before converting to Zod.
 *
 * @deprecated This function is deprecated in favor of using JSON schemas directly.
 * LangChain.js now supports JSON schemas natively, eliminating the need for Zod conversion.
 * Use `resolveJsonSchemaRefs` to handle $ref references and pass the JSON schema directly to tools.
 *
 * @see https://js.langchain.com/docs/how_to/custom_tools/
 */
export function convertWithResolvedRefs(
  schema: JsonSchemaType & Record<string, unknown>,
  options?: ConvertJsonSchemaToZodOptions,
): z.ZodType | undefined {
  const resolved = resolveJsonSchemaRefs(schema);
  return convertJsonSchemaToZod(resolved, options);
}
