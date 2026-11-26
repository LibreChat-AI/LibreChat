import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const API_KEY = process.env.OPENROUTER_KEY || '';
const API_BASE = process.env.VIDEO_OPENROUTER_BASE || 'https://openrouter.ai/api/v1/videos';
const MODEL = process.env.VIDEO_OPENROUTER_MODEL || 'black-forest-labs/flux-3-video';
const POLL_INTERVAL = parseInt(process.env.VIDEO_POLL_INTERVAL || '5', 10);
const POLL_TIMEOUT = parseInt(process.env.VIDEO_POLL_TIMEOUT || '300', 10); // 5 min default

if (!API_KEY) {
  console.error('Error: OPENROUTER_KEY environment variable is required');
  process.exit(1);
}

const server = new Server(
  { name: 'video-openrouter', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'generate_video_openrouter',
        description: 'Generate a video using OpenRouter video models (HappyHorse, etc.). Submits a generation job and polls until complete.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: 'The text description of the video to generate.',
            },
          },
          required: ['prompt'],
        },
      },
    ],
  };
});

async function pollVideo(pollingUrl, timeout) {
  const startTime = Date.now();

  while (true) {
    const elapsed = (Date.now() - startTime) / 1000;
    if (elapsed > timeout) {
      throw new Error(`Video generation timed out after ${timeout}s`);
    }

    const pollResponse = await fetch(pollingUrl, {
      headers: { 'Authorization': `Bearer ${API_KEY}` },
    });

    if (!pollResponse.ok) {
      const errorText = await pollResponse.text();
      throw new Error(`Polling error: ${pollResponse.status} - ${errorText}`);
    }

    const statusData = await pollResponse.json();

    if (statusData.status === 'completed') {
      return statusData.unsigned_urls || [];
    }

    if (statusData.status === 'failed') {
      throw new Error(`Video generation failed: ${statusData.error || 'Unknown error'}`);
    }

    // Still processing, wait and retry
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL * 1000));
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'generate_video_openrouter') {
      const { prompt } = args;

      if (!prompt) {
        return {
          content: [{ type: 'text', text: 'Error: prompt is required' }],
          isError: true,
        };
      }

      // Step 1: Submit video generation request
      const response = await fetch(API_BASE, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          prompt,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
      }

      const result = await response.json();

      if (!result.id || !result.polling_url) {
        throw new Error('Invalid response from OpenRouter API: missing job ID or polling URL');
      }

      const jobId = result.id;
      const pollingUrl = result.polling_url;

      // Step 2: Poll for completion
      const urls = await pollVideo(pollingUrl, POLL_TIMEOUT);

      // Step 3: Return results
      const urlList = urls.map((url, i) => `[📥 Video ${i + 1}](${url})`).join('\n');

      return {
        content: [
          {
            type: 'text',
            text: `Video generated successfully via OpenRouter!\nModel: ${MODEL}\nJob ID: ${jobId}\nPrompt: "${prompt}"\n\n${urlList}`,
          },
        ],
      };
    }

    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Video OpenRouter MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
