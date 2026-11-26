import http from 'node:http';
import { once } from 'node:events';
import { expect, test } from '@playwright/test';
import { ChatBedrockConverse } from '@langchain/aws';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { Providers, createSchemaOnlyTools } from '@librechat/agents';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { createMCPStructuredTool, loadToolDefinitions } from '@librechat/api';
import type { StructuredToolInterface } from '@librechat/agents/langchain/tools';

/** Capture the actual SDK HTTP body without credentials or a remote provider. */
async function captureRequest(tools: StructuredToolInterface[]) {
  let body = '';
  const server = http.createServer(async (request, response) => {
    for await (const chunk of request) {
      body += chunk.toString();
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        output: { message: { role: 'assistant', content: [{ text: 'OK' }] } },
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        metrics: { latencyMs: 1 },
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('Expected a local HTTP port');
  }
  const client = new BedrockRuntimeClient({
    region: 'us-east-1',
    endpoint: `http://127.0.0.1:${address.port}`,
    requestHandler: new NodeHttpHandler(),
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  try {
    const model = new ChatBedrockConverse({
      model: 'global.openai.gpt-6.1-sol',
      region: 'us-east-1',
      client,
    });
    await model.invoke('Hello', { tools });
    return JSON.parse(body) as {
      toolConfig: { tools: { toolSpec: { name: string; description: string } }[] };
    };
  } finally {
    client.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test('runtime MCP tools have valid descriptions @scenario:runtime-mcp-tools-without-descriptions-send-nonempty-bedrock-descriptions', async () => {
  const tools = ['', 'Search the web'].map((description, index) =>
    createMCPStructuredTool(async () => 'result', {
      name: `search_${index}`,
      description,
      schema: { type: 'object', properties: {} },
    }),
  );
  const body = await captureRequest(tools);
  expect(body.toolConfig.tools.map(({ toolSpec }) => toolSpec.description)).toEqual([
    'search_0 tool',
    'Search the web',
  ]);
});

test('named and wildcard definitions have valid descriptions @scenario:named-and-wildcard-mcp-definitions-without-descriptions-send-nonempty-bedrock-descriptions', async () => {
  for (const selection of ['sys__all__sys_mcp_gateway', 'search_mcp_gateway']) {
    for (const description of [undefined, '', 'Search the web']) {
      const result = await loadToolDefinitions(
        { userId: 'user', agentId: 'agent', tools: [selection], provider: Providers.BEDROCK },
        {
          isBuiltInTool: () => false,
          getOrFetchMCPServerTools: async () => ({
            search_mcp_gateway: {
              function: {
                name: 'search_mcp_gateway',
                description,
                parameters: { type: 'object', properties: {} },
              },
            },
          }),
        },
      );
      const body = await captureRequest(createSchemaOnlyTools(result.toolDefinitions));
      expect(body.toolConfig.tools[0].toolSpec).toMatchObject({
        name: 'search_mcp_gateway',
        description: description || 'search_mcp_gateway tool',
      });
    }
  }
});
