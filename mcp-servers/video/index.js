import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;
const VARIANT = process.env.VIDEO_API_VARIANT || 'dashscope';
const DASHSCOPE_API_HOST = process.env.DASHSCOPE_API_HOST || (
  VARIANT === 'tokenplan'
    ? 'https://token-plan.ap-southeast-1.maas.aliyuncs.com'
    : 'https://dashscope-intl.aliyuncs.com'
);
const MODEL = process.env.VIDEO_MODEL || (
  VARIANT === 'tokenplan' ? 'happyhorse-1.1-t2v' : 'cogvideox-v1.5'
);
const POLL_INTERVAL = parseInt(process.env.VIDEO_POLL_INTERVAL || '10', 10);
const POLL_TIMEOUT = parseInt(process.env.VIDEO_POLL_TIMEOUT || '600', 10);

if (!DASHSCOPE_API_KEY) {
  console.error('Error: DASHSCOPE_API_KEY environment variable is required');
  process.exit(1);
}

function getSubmitUrl() {
  if (VARIANT === 'tokenplan') {
    return `${DASHSCOPE_API_HOST}/api/v1/services/aigc/video-generation/video-synthesis`;
  }
  return `${DASHSCOPE_API_HOST}/api/v1/services/aigc/video-generation/generation`;
}

function getPollUrl(taskId) {
  if (VARIANT === 'tokenplan') {
    return `${DASHSCOPE_API_HOST}/api/v1/tasks/${taskId}`;
  }
  return `${DASHSCOPE_API_HOST}/api/v1/services/aigc/video-generation/generation?task_id=${taskId}`;
}

function extractVideoUrls(data) {
  if (VARIANT === 'tokenplan') {
    const videoUrl = data.output?.video_url;
    if (!videoUrl) {
      throw new Error('Video generation completed but no video_url in response');
    }
    return [videoUrl];
  }
  const results = data.output?.results;
  if (!results || results.length === 0) {
    throw new Error('Video generation completed but no results returned');
  }
  return results.map(r => r.video_url).filter(Boolean);
}

const server = new Server(
  { name: 'video', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'generate_video',
        description: 'Generate a video using Qwen video models via DashScope API. Submits a generation task and polls until complete.',
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

async function submitVideoTask(prompt) {
  const requestBody = {
    model: MODEL,
    input: {
      prompt,
    },
    parameters: {
      prompt_extend: true,
    },
  };

  const headers = {
    'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
    'Content-Type': 'application/json',
  };

  if (VARIANT === 'tokenplan') {
    headers['X-DashScope-Async'] = 'enable';
  }

  const response = await fetch(getSubmitUrl(), {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DashScope API error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();

  if (!result.output?.task_id) {
    throw new Error('Invalid response from DashScope API: missing task_id');
  }

  return result.output.task_id;
}

async function pollVideoTask(taskId, timeout) {
  const startTime = Date.now();
  const pollUrl = getPollUrl(taskId);

  while (true) {
    const elapsed = (Date.now() - startTime) / 1000;
    if (elapsed > timeout) {
      throw new Error(`Video generation timed out after ${timeout}s (task: ${taskId})`);
    }

    const response = await fetch(pollUrl, {
      headers: { 'Authorization': `Bearer ${DASHSCOPE_API_KEY}` },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Polling error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();

    if (data.output?.task_status === 'SUCCEEDED') {
      return extractVideoUrls(data);
    }

    if (data.output?.task_status === 'FAILED') {
      throw new Error(`Video generation failed: ${data.output.message || data.message || 'Unknown error'}`);
    }

    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL * 1000));
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'generate_video') {
      const { prompt } = args;

      if (!prompt) {
        return {
          content: [{ type: 'text', text: 'Error: prompt is required' }],
          isError: true,
        };
      }

      const taskId = await submitVideoTask(prompt);
      const urls = await pollVideoTask(taskId, POLL_TIMEOUT);

      const urlList = urls.map((url, i) => `[📥 Video ${i + 1}](${url})`).join('\n');

      return {
        content: [
          {
            type: 'text',
            text: `Video generated successfully via DashScope!\nModel: ${MODEL}\nTask ID: ${taskId}\nPrompt: "${prompt}"\n\n${urlList}`,
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
  console.error(`Video MCP server running on stdio (variant: ${VARIANT})`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
