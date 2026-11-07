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

/** Declared JSON types of a property, or undefined when any of them cannot be checked here. */
function declaredTypes(property: unknown): string[] | undefined {
  if (property == null || typeof property !== 'object' || !('type' in property)) {
    return undefined;
  }
  const types = Array.isArray(property.type) ? property.type : [property.type];
  if (
    types.length === 0 ||
    !types.every(
      (type) => typeof type === 'string' && Object.prototype.hasOwnProperty.call(typeChecks, type),
    )
  ) {
    return undefined;
  }
  return types as string[];
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
