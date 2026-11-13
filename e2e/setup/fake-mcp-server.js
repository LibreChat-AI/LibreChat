#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const z = require('zod/v4');
const { watchDynamicTool } = require('./dynamic-mcp-tools');

const APPROVAL_AUDIT_DIR = path.join('/tmp', 'librechat-e2e-approval-audit');

function recordApprovalInvocation(value) {
  fs.mkdirSync(APPROVAL_AUDIT_DIR, { recursive: true });
  const filename = Buffer.from(value).toString('base64url');
  fs.appendFileSync(path.join(APPROVAL_AUDIT_DIR, filename), `${value}\n`);
}

const server = new McpServer({
  name: 'e2e-memory',
  version: '1.0.0',
});

server.registerTool(
  'remember_fact',
  {
    description: 'Stores a deterministic fact for LibreChat mock end-to-end tests.',
    inputSchema: {
      fact: z.string().optional(),
    },
  },
  async ({ fact = 'LibreChat MCP e2e fact' }) => ({
    content: [
      {
        type: 'text',
        text: `E2E MCP memory noted: ${fact}`,
      },
    ],
  }),
);

server.registerTool(
  'recall_fact',
  {
    description: 'Returns a deterministic fact for LibreChat mock end-to-end tests.',
    inputSchema: {},
  },
  async () => ({
    content: [
      {
        type: 'text',
        text: 'E2E MCP memory recalled: LibreChat can persist MCP tools on agents.',
      },
    ],
  }),
);

server.registerTool(
  'slow_echo',
  {
    description:
      'Echoes text after a delay; used to verify background tool dispatch in mock e2e tests.',
    inputSchema: {
      text: z.string(),
      delay_ms: z.number().optional(),
    },
  },
  async ({ text, delay_ms = 1500 }) => {
    await new Promise((resolve) => setTimeout(resolve, delay_ms));
    return {
      content: [
        {
          type: 'text',
          text: `E2E slow echo: ${text}`,
        },
      ],
    };
  },
);

server.registerTool(
  'approval_probe',
  {
    description:
      'Echoes reviewed input so LibreChat mock end-to-end tests can verify tool approval decisions.',
    inputSchema: {
      value: z.string(),
      review: z.string().optional(),
    },
  },
  async ({ value }) => {
    recordApprovalInvocation(value);
    return {
      content: [
        {
          type: 'text',
          text: `E2E approval probe executed: ${value}`,
        },
      ],
    };
  },
);

/** Mirrors a Pydantic-style tool with many optional fields: the nullable object is
 *  declared after the eighth property, so validation feedback must scan the whole schema. */
server.registerTool(
  'create_work_item',
  {
    description:
      'Creates a work item; used to verify schema-validation feedback in mock e2e tests.',
    inputSchema: {
      project: z.string(),
      subject: z.string(),
      type: z.string().optional(),
      description: z.string().optional(),
      assignee: z.string().optional(),
      priority: z.string().optional(),
      status: z.string().optional(),
      start_date: z.string().optional(),
      due_date: z.string().optional(),
      estimated_hours: z.number().optional(),
      parent_id: z.number().int().optional(),
      custom_fields: z.record(z.string(), z.unknown()).nullable().optional(),
      confirm: z.boolean().optional(),
    },
  },
  async ({ subject }) => ({
    content: [{ type: 'text', text: `E2E work item created: ${subject}` }],
  }),
);

if (process.env.E2E_MCP_LIST_CHANGED === 'true') {
  server.registerTool(
    'transport_probe',
    {
      description: 'Confirms that the real stdio MCP transport is connected.',
      inputSchema: {},
    },
    async () => ({ content: [{ type: 'text', text: 'stdio connected' }] }),
  );

  watchDynamicTool(server);
}

async function main() {
  const expectedUserToken = process.env.E2E_MCP_EXPECTED_USER_TOKEN;
  if (expectedUserToken && process.env.E2E_MCP_USER_TOKEN !== expectedUserToken) {
    console.error('[fake-mcp-server] E2E_MCP_USER_TOKEN does not match the expected value');
    process.exit(1);
  }
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error('[fake-mcp-server] failed to start', error);
  process.exit(1);
});
