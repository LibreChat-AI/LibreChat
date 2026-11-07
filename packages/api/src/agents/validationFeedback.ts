import type { StructuredToolInterface } from '@librechat/agents/langchain/tools';

const MAX_FIELDS = 8;
const safeName = (name: string): string => name.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);

const typeChecks: Record<string, (value: unknown) => boolean> = {
  string: (value) => typeof value === 'string',
  boolean: (value) => typeof value === 'boolean',
  number: (value) => typeof value === 'number',
  integer: (value) => Number.isInteger(value),
  array: (value) => Array.isArray(value),
  object: (value) => value != null && typeof value === 'object' && !Array.isArray(value),
  null: (value) => value === null,
};

const MAX_UNION_DEPTH = 3;

/**
 * Declared JSON types of a property, read from `type` (a string or an array), an
 * `anyOf`/`oneOf` union, and the OpenAPI-style `nullable` flag that the Gemini
 * sanitizer leaves behind. Undefined when any member cannot be checked here.
 */
function declaredTypes(property: unknown, depth = 0): string[] | undefined {
  if (property == null || typeof property !== 'object' || depth > MAX_UNION_DEPTH) {
    return undefined;
  }
  const types = new Set<string>();
  if ('type' in property) {
    const declared = Array.isArray(property.type) ? property.type : [property.type];
    for (const type of declared) {
      if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(typeChecks, type)) {
        return undefined;
      }
      types.add(type);
    }
  } else {
    let union: unknown;
    if ('anyOf' in property) {
      union = property.anyOf;
    } else if ('oneOf' in property) {
      union = property.oneOf;
    }
    if (!Array.isArray(union)) {
      return undefined;
    }
    for (const branch of union) {
      const branchTypes = declaredTypes(branch, depth + 1);
      if (branchTypes == null) {
        return undefined;
      }
      branchTypes.forEach((type) => types.add(type));
    }
  }
  if (types.size === 0) {
    return undefined;
  }
  if ('nullable' in property && property.nullable === true) {
    types.add('null');
  }
  return [...types];
}

/** Read only schema-owned field names; parser messages/output can contain input secrets. */
export function toolValidationFeedback(
  error: unknown,
  toolName: string,
  schema?: StructuredToolInterface['schema'],
  input?: unknown,
  canCheckBackground = false,
): string | undefined {
  if (
    !(error instanceof Error) ||
    error.constructor.name !== 'ToolInputParsingException' ||
    !error.message.startsWith('Received tool input did not match expected schema')
  ) {
    return undefined;
  }
  const fields: string[] = [];
  if (schema != null && typeof schema === 'object' && 'required' in schema) {
    const required = schema.required;
    if (Array.isArray(required)) {
      for (const field of required) {
        if (fields.length >= MAX_FIELDS) {
          break;
        }
        if (
          typeof field === 'string' &&
          (input == null ||
            typeof input !== 'object' ||
            !Object.prototype.hasOwnProperty.call(input, field))
        ) {
          fields.push(safeName(field));
        }
      }
    }
  }
  const missing = fields.length ? ` Missing required fields: ${fields.join(', ')}.` : '';
  const invalid: string[] = [];
  if (
    schema != null &&
    typeof schema === 'object' &&
    'properties' in schema &&
    schema.properties != null &&
    typeof schema.properties === 'object' &&
    input != null &&
    typeof input === 'object'
  ) {
    for (const [field, property] of Object.entries(schema.properties)) {
      if (invalid.length >= MAX_FIELDS) {
        break;
      }
      if (!Object.prototype.hasOwnProperty.call(input, field)) {
        continue;
      }
      const types = declaredTypes(property);
      if (types == null) {
        continue;
      }
      const value = Object.getOwnPropertyDescriptor(input, field)?.value;
      if (!types.some((type) => typeChecks[type](value))) {
        invalid.push(`${safeName(field)} (expected ${types.join(' or ')})`);
      }
    }
  }
  const invalidTypes = invalid.length ? ` Invalid field types: ${invalid.join(', ')}.` : '';
  const polling =
    canCheckBackground &&
    input != null &&
    typeof input === 'object' &&
    Object.prototype.hasOwnProperty.call(input, 'background_task_id')
      ? ' To inspect an existing background task, call check_background_task with background_task_id.'
      : '';
  return `Tool "${safeName(toolName)}" input failed schema validation.${missing}${invalidTypes} Use this tool's declared arguments.${polling}`;
}
