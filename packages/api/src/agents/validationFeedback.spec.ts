import { tool } from '@librechat/agents/langchain/tools';
import type { StructuredToolInterface } from '@librechat/agents/langchain/tools';
import { toolValidationFeedback } from './validationFeedback';

describe('toolValidationFeedback', () => {
  it('explains a misrouted poll without invoking Bash or disclosing values', async () => {
    const execute = jest.fn(async () => 'executed');
    const bash = tool(execute, {
      name: 'bash_tool',
      description: 'Runs commands',
      schema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    });
    const input = { background_task_id: 'private-task-id', intent: 'private-intent' };
    const error = await bash.invoke(input).catch((failure: Error) => failure);
    const feedback = toolValidationFeedback(error, bash.name, bash.schema, input, true);
    expect(execute).not.toHaveBeenCalled();
    expect(feedback).toContain('Missing required fields: command');
    expect(feedback).toContain('call check_background_task');
    expect(feedback).not.toContain('private-');
    expect(toolValidationFeedback(error, bash.name, bash.schema, input)).not.toContain(
      'check_background_task',
    );
  });

  it('does not rewrite execution failures that happen to use the parser message', () => {
    expect(
      toolValidationFeedback(
        new Error('Received tool input did not match expected schema'),
        'bash_tool',
      ),
    ).toBeUndefined();
  });

  it('reports primitive type mismatches using schema metadata only', async () => {
    const execute = jest.fn(async () => 'executed');
    const bash = tool(execute, {
      name: 'bash_tool',
      description: 'Runs commands',
      schema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    });
    const input = { command: { secret: 'never-echo' } };
    const error = await bash.invoke(input).catch((failure: Error) => failure);
    const feedback = toolValidationFeedback(error, bash.name, bash.schema, input);
    expect(feedback).toContain('command (expected string)');
    expect(feedback).not.toContain('never-echo');
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('toolValidationFeedback type checks', () => {
  /** Raw MCP JSON Schemas (e.g. Pydantic unions) are wider than the SDK's schema type. */
  const jsonSchema = (schema: object) => schema as StructuredToolInterface['schema'];
  const parserError = (): Error => {
    class ToolInputParsingException extends Error {}
    return new ToolInputParsingException('Received tool input did not match expected schema');
  };

  it('reports union, object, array and integer mismatches past the eighth property', () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 11; i++) {
      properties[`field_${i}`] = { type: 'string' };
    }
    properties.custom_fields = { type: ['object', 'null'] };
    properties.tags = { type: 'array' };
    properties.count = { type: 'integer' };
    properties.meta = { type: 'object' };
    properties.anything = {};
    const schema = jsonSchema({ type: 'object', properties });
    const input = {
      custom_fields: '{"secret":"never-echo"}',
      tags: 'never-echo',
      count: 1.5,
      meta: [],
      anything: 'never-echo',
      confirm: true,
    };
    const feedback = toolValidationFeedback(parserError(), 'create_work_package', schema, input);
    expect(feedback).toContain(
      'Invalid field types: custom_fields (expected object or null), tags (expected array), count (expected integer), meta (expected object).',
    );
    expect(feedback).not.toContain('never-echo');
    expect(feedback).not.toContain('anything');
    expect(feedback).not.toContain('confirm');
  });

  it('accepts values matching any member of a union and skips unknown types', () => {
    const schema = jsonSchema({
      type: 'object',
      properties: {
        custom_fields: { type: ['object', 'null'] },
        limit: { type: ['integer', 'null'] },
        ratio: { type: 'number' },
        odd: { type: ['string', 'custom-type'] },
      },
    });
    const input = { custom_fields: null, limit: 3, ratio: 0.5, odd: 4 };
    expect(toolValidationFeedback(parserError(), 'tool', schema, input)).not.toContain(
      'Invalid field types',
    );
  });

  it('reads anyOf and oneOf unions and the nullable flag', () => {
    const schema = jsonSchema({
      type: 'object',
      properties: {
        custom_fields: { anyOf: [{ type: 'object', additionalProperties: {} }, { type: 'null' }] },
        mode: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        collapsed: { type: 'object', nullable: true },
        pattern: { anyOf: [{ type: 'string' }, { not: {} }] },
      },
    });
    const invalid = { custom_fields: '{}', mode: false, collapsed: 'x', pattern: 4 };
    const feedback = toolValidationFeedback(parserError(), 'tool', schema, invalid);
    expect(feedback).toContain(
      'Invalid field types: custom_fields (expected object or null), mode (expected string or integer), collapsed (expected object or null).',
    );
    expect(feedback).not.toContain('pattern');
    const valid = { custom_fields: null, mode: 2, collapsed: null };
    expect(toolValidationFeedback(parserError(), 'tool', schema, valid)).not.toContain(
      'Invalid field types',
    );
  });

  it('caps reported fields rather than inspected properties', () => {
    const properties: Record<string, unknown> = {};
    const input: Record<string, unknown> = {};
    const required: string[] = [];
    for (let i = 0; i < 14; i++) {
      properties[`field_${i}`] = { type: 'string' };
      input[`field_${i}`] = i < 4 ? 'valid' : i;
      required.push(`req_${i}`);
      if (i < 4) {
        input[`req_${i}`] = 'present';
      }
    }
    const schema = jsonSchema({ type: 'object', properties, required });
    const feedback = toolValidationFeedback(parserError(), 'tool', schema, input);
    expect(feedback).toContain('Missing required fields: req_4,');
    expect(feedback).toContain('req_11.');
    expect(feedback).not.toContain('req_12');
    expect(feedback).toContain('Invalid field types: field_4 (expected string),');
    expect(feedback).toContain('field_11 (expected string).');
    expect(feedback).not.toContain('field_12');
    expect(feedback).not.toContain('field_3 ');
  });
});
