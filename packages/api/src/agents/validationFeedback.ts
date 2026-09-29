import type { StructuredToolInterface } from '@librechat/agents/langchain/tools';

const MAX_FIELDS = 8;
const safeName = (name: string): string => name.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);

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
      for (const field of required.slice(0, MAX_FIELDS)) {
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
    for (const [field, property] of Object.entries(schema.properties).slice(0, MAX_FIELDS)) {
      if (
        !Object.prototype.hasOwnProperty.call(input, field) ||
        property == null ||
        typeof property !== 'object' ||
        !('type' in property)
      )
        continue;
      const type = property.type;
      const value = Object.getOwnPropertyDescriptor(input, field)?.value;
      if ((type === 'string' || type === 'boolean' || type === 'number') && typeof value !== type) {
        invalid.push(`${safeName(field)} (expected ${type})`);
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
