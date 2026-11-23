import { z } from 'zod';
import { z as zodV3 } from 'zod/v3';
import { toToolParameters } from './schema';

describe('toToolParameters', () => {
  it('converts a Zod 4 schema to draft-07 input parameters', () => {
    const parameters = toToolParameters(
      z.object({
        query: z.string().describe('Search query'),
        limit: z.number().default(5),
        since: z.date().optional(),
      }),
    );

    expect(parameters).toEqual({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', default: 5 },
        since: {},
      },
      required: ['query'],
    });
  });

  it('converts a Zod 3 schema such as the legacy LangChain `Tool` default', () => {
    const parameters = toToolParameters(
      zodV3.object({ input: zodV3.string().optional() }).transform((value) => value.input),
    );

    expect(parameters).toMatchObject({
      type: 'object',
      properties: { input: { type: 'string' } },
    });
  });

  it('returns a JSON Schema or a missing schema unchanged', () => {
    const jsonSchema = { type: 'object', properties: { id: { type: 'string' } } };

    expect(toToolParameters(jsonSchema)).toBe(jsonSchema);
    expect(toToolParameters(undefined)).toBeUndefined();
  });
});
