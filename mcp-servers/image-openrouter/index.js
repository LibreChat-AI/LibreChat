import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import path from 'path';

const API_KEY = process.env.OPENROUTER_KEY || '';
const API_BASE = process.env.IMAGE_OPENROUTER_BASE || 'https://openrouter.ai/api/v1/images';
const MODEL = process.env.IMAGE_OPENROUTER_MODEL || 'x-ai/grok-imagine-image-2.0';
const IMAGES_PATH = process.env.IMAGES_PATH || '/app/generated_files/';

if (!API_KEY) {
  console.error('Error: OPENROUTER_KEY environment variable is required');
  process.exit(1);
}

// Ensure images directory exists
try {
  fs.mkdirSync(IMAGES_PATH, { recursive: true });
} catch (err) {
  console.error(`Warning: Could not create images directory: ${err.message}`);
}

function generateFilename(prompt) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const cleanPrompt = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 50);
  return `openrouter_${timestamp}_${cleanPrompt}.png`;
}

function saveImageToDisk(base64, filename) {
  const filepath = path.join(IMAGES_PATH, filename);
  const buffer = Buffer.from(base64, 'base64');
  fs.writeFileSync(filepath, buffer);
  return filepath;
}

const server = new Server(
  { name: 'image-openrouter', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'generate_image_openrouter',
        description: 'Generate an image using OpenRouter image models (FLUX, etc.). Returns a high-quality image based on the text prompt.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: 'The text description of the image to generate.',
            },
            size: {
              type: 'string',
              description: 'Image size. Default: 1024x1024',
              default: '1024x1024',
            },
          },
          required: ['prompt'],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'generate_image_openrouter') {
      const { prompt, size } = args;

      if (!prompt) {
        return {
          content: [{ type: 'text', text: 'Error: prompt is required' }],
          isError: true,
        };
      }

      const response = await fetch(API_BASE, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          prompt,
          size: size || '1024x1024',
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
      }

      const result = await response.json();

      if (!result.data || result.data.length === 0 || !result.data[0].b64_json) {
        throw new Error('No image returned from OpenRouter API');
      }

      const base64 = result.data[0].b64_json;

      // Save to disk
      const filename = generateFilename(prompt);
      let savedPath = null;
      try {
        savedPath = saveImageToDisk(base64, filename);
      } catch (err) {
        console.error(`Warning: Could not save image: ${err.message}`);
      }

      const urlInfo = savedPath ? ` (Saved as ${filename})` : '';

      return {
        content: [
          {
            type: 'image',
            data: base64,
            mimeType: 'image/png',
          },
          {
            type: 'text',
            text: `Image generated successfully via OpenRouter. Model: ${MODEL}. Prompt: "${prompt}"${urlInfo}`,
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
  console.error('Image OpenRouter MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
