import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodType as ZodV3Type } from 'zod/v3';

/**
 * Draft-07 JSON Schema parameters for a tool schema. LibreChat tools declare Zod 4 schemas, while
 * LangChain's legacy `Tool` still builds its default schema with the Zod 3 API, which Zod 4's
 * converter cannot read. A JSON Schema, or no schema, is returned unchanged.
 */
export function toToolParameters(schema: object | undefined): object | undefined {
  if (schema == null) {
    return schema;
  }
  if ('_zod' in schema) {
    return z.toJSONSchema(schema as z.core.$ZodType, {
      target: 'draft-7',
      io: 'input',
      unrepresentable: 'any',
    });
  }
  if ('_def' in schema) {
    return zodToJsonSchema(schema as ZodV3Type);
  }
  return schema;
}
