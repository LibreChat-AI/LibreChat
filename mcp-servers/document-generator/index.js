import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { generateMarkdown } from './generators/markdown.js';
import { generatePDF } from './generators/pdf.js';
import path from 'path';

const OUTPUT_PATH = process.env.DOCUMENTS_PATH || '/app/generated_files';
const BASE_URL = process.env.DOCUMENTS_BASE_URL || '';

const server = new Server(
  {
    name: 'document-generator',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'generate_markdown',
        description: 'Generate a Markdown document from text, markdown, or HTML content. Returns the filepath to the generated .md file.',
        inputSchema: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'The document content (plain text, markdown, or HTML)',
            },
            filename: {
              type: 'string',
              description: 'Optional filename (without extension). If not provided, a timestamp-based name will be used.',
            },
          },
          required: ['content'],
        },
      },
      {
        name: 'generate_pdf',
        description: 'Generate a PDF document from text, markdown, or HTML content. Returns the filepath to the generated .pdf file.',
        inputSchema: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'The document content (plain text, markdown, or HTML)',
            },
            filename: {
              type: 'string',
              description: 'Optional filename (without extension). If not provided, a timestamp-based name will be used.',
            },
            title: {
              type: 'string',
              description: 'Optional document title for PDF metadata',
            },
            fontSize: {
              type: 'number',
              description: 'Optional base font size (default: 12)',
            },
          },
          required: ['content'],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'generate_markdown') {
      const { content, filename } = args;

      if (!content) {
        return {
          content: [{ type: 'text', text: 'Error: content is required' }],
          isError: true,
        };
      }

      const result = await generateMarkdown(content, filename, OUTPUT_PATH);
      const meta = {
        filename: result.filename,
        filepath: result.filename,
        mimeType: 'text/markdown',
        size: result.size,
        type: 'markdown',
        source: 'document_generator',
        url: BASE_URL ? `${BASE_URL}/generated_files/${result.filename}` : null,
      };

      const downloadLink = BASE_URL ? `\n[📥 Descàrrega](${BASE_URL}/generated_files/${result.filename})` : '';

      return {
        content: [
          {
            type: 'text',
            text: `FILE_METADATA:${JSON.stringify(meta)}\nMarkdown document generated successfully: ${result.filename}${downloadLink}`,
          },
        ],
      };
    }

    if (name === 'generate_pdf') {
      const { content, filename, title, fontSize } = args;

      if (!content) {
        return {
          content: [{ type: 'text', text: 'Error: content is required' }],
          isError: true,
        };
      }

      const options = {};
      if (title) options.title = title;
      if (fontSize) options.fontSize = fontSize;

      const result = await generatePDF(content, filename, OUTPUT_PATH, options);
      const meta = {
        filename: result.filename,
        filepath: result.filename,
        mimeType: 'application/pdf',
        size: result.size,
        type: 'pdf',
        source: 'document_generator',
        url: BASE_URL ? `${BASE_URL}/generated_files/${result.filename}` : null,
      };

      const downloadLink = BASE_URL ? `\n[📥 Descàrrega](${BASE_URL}/generated_files/${result.filename})` : '';

      return {
        content: [
          {
            type: 'text',
            text: `FILE_METADATA:${JSON.stringify(meta)}\nPDF document generated successfully: ${result.filename}${downloadLink}`,
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
  console.error('Document Generator MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
