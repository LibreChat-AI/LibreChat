import { z } from 'zod';
import { ChatBedrockConverse } from '@langchain/aws';
import { createMCPStructuredTool } from './tools';

it.each(['', 'Search the web'])(
  'preserves valid descriptions or supplies a fallback for runtime MCP tools (%p)',
  (description) => {
    const tool = createMCPStructuredTool(async () => 'result', {
      name: 'web_search',
      description,
      schema: z.object({}),
    });
    const model = new ChatBedrockConverse({
      model: 'amazon.nova-pro-v1:0',
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    const params = model.invocationParams({ tools: [tool] });
    expect(params.toolConfig?.tools?.[0]).toMatchObject({
      toolSpec: { name: 'web_search', description: description || 'web_search tool' },
    });
  },
);
