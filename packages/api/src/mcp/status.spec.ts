import { z } from 'zod';
import { ToolMessage } from '@librechat/agents/langchain/messages';
import { markMCPToolResultError, isMCPToolResultError } from './status';
import { createMCPStructuredTool } from './tools';
import { formatToolContent } from './parsers';

test('protocol errors retain content and status through the structured-tool adapter', async () => {
  const formatted = markMCPToolResultError(
    formatToolContent(
      { isError: true, content: [{ type: 'text', text: 'Invalid query' }] },
      'openai',
    ),
    true,
  );
  const probe = createMCPStructuredTool(async () => formatted, {
    name: 'probe',
    description: 'Protocol status probe',
    schema: z.object({}),
    responseFormat: 'content_and_artifact',
  });
  const result = await probe.invoke({ name: 'probe', args: {}, id: 'call-a', type: 'tool_call' });
  expect(result).toBeInstanceOf(ToolMessage);
  expect(result.status).toBe('error');
  expect(JSON.stringify(result.content)).toContain('Invalid query');
  expect(result.tool_call_id).toBe('call-a');
  expect(isMCPToolResultError(JSON.parse(JSON.stringify(formatted)))).toBe(false);
});

test('successful MCP results retain their existing content and artifact contract', async () => {
  const formatted = markMCPToolResultError(
    formatToolContent({ content: [{ type: 'text', text: 'Success' }] }, 'openai'),
    false,
  );
  const probe = createMCPStructuredTool(async () => formatted, {
    name: 'probe',
    description: 'Protocol status probe',
    schema: z.object({}),
    responseFormat: 'content_and_artifact',
  });
  const result = await probe.invoke({ name: 'probe', args: {}, id: 'call-a', type: 'tool_call' });
  expect(result.status).toBe('success');
  expect(result.artifact).toEqual(formatted[1]);
});
