import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { getAccessToken } from './helpers';

const STATE_PATH =
  process.env.E2E_MCP_STATE_PATH || path.resolve(__dirname, '../.test-results/mcp-tool-state.json');
const SERVERS = ['e2e-memory', 'e2e-streamable', 'e2e-sse'] as const;
const TRANSPORT_PROBE = 'transport_probe';
const DYNAMIC_TOOL = 'runtime_probe';
const REPLICA_COUNT = Number(process.env.E2E_REPLICAS || '1');

type MCPTool = {
  name: string;
  pluginKey: string;
  description?: string;
};

type MCPToolsResponse = {
  servers?: Record<string, { tools?: MCPTool[] }>;
};

function writeToolState(
  revision: number,
  tool: { description: string; schemaVersion: number } | null,
) {
  const temporaryPath = `${STATE_PATH}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(temporaryPath, `${JSON.stringify({ revision, tool })}\n`);
  fs.renameSync(temporaryPath, STATE_PATH);
}

function getCatalogURLs() {
  if (REPLICA_COUNT === 1) {
    return ['/api/mcp/tools'];
  }
  const baseURL = new URL(process.env.E2E_BASE_URL || 'http://localhost:3080');
  const basePort = Number(baseURL.port || 80);
  return [1, 2].map((offset) => {
    const replicaURL = new URL('/api/mcp/tools', baseURL);
    replicaURL.port = String(basePort + offset);
    return replicaURL.toString();
  });
}

async function getTools(
  page: Page,
  accessToken: string,
  catalogURL: string,
): Promise<MCPToolsResponse> {
  const response = await page.request.get(catalogURL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<MCPToolsResponse>;
}

async function expectCatalog(
  page: Page,
  accessToken: string,
  expected: { present: boolean; description?: string; toolName: string },
) {
  await expect
    .poll(
      async () => {
        const catalogs = await Promise.all(
          getCatalogURLs().map((catalogURL) => getTools(page, accessToken, catalogURL)),
        );
        return catalogs.flatMap((catalog, replicaIndex) =>
          SERVERS.map((serverName) => {
            const pluginKey = `${expected.toolName}_mcp_${serverName}`;
            const tool = catalog.servers?.[serverName]?.tools?.find(
              (candidate) => candidate.pluginKey === pluginKey,
            );
            if (expected.description === undefined) {
              return { replica: replicaIndex + 1, serverName, present: tool != null };
            }
            return tool
              ? { replica: replicaIndex + 1, serverName, description: tool.description }
              : { replica: replicaIndex + 1, serverName };
          }),
        );
      },
      {
        message: `${expected.toolName} should be ${expected.present ? 'present' : 'absent'} on every MCP transport`,
        timeout: 30_000,
        intervals: [100, 250, 500],
      },
    )
    .toEqual(
      getCatalogURLs().flatMap((_, replicaIndex) =>
        SERVERS.map((serverName) => {
          if (expected.description === undefined) {
            return { replica: replicaIndex + 1, serverName, present: expected.present };
          }
          if (expected.present) {
            return {
              replica: replicaIndex + 1,
              serverName,
              description: expected.description,
            };
          }
          return { replica: replicaIndex + 1, serverName };
        }),
      ),
    );
}

test.describe('MCP tools/list_changed transports', () => {
  test.skip(
    process.env.E2E_MCP_LIST_CHANGED !== 'true',
    'runs only in the dedicated dynamic MCP topology matrix',
  );

  test('refreshes the public tool catalog over stdio, Streamable HTTP, and SSE', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto('/c/new');
    const accessToken = await getAccessToken(page);
    const revisionBase = Date.now();

    try {
      writeToolState(revisionBase, null);
      await expectCatalog(page, accessToken, {
        present: true,
        toolName: TRANSPORT_PROBE,
        description: undefined,
      });

      writeToolState(revisionBase + 1, {
        description: 'Dynamic MCP tool version one',
        schemaVersion: 1,
      });
      await expectCatalog(page, accessToken, {
        present: true,
        toolName: DYNAMIC_TOOL,
        description: 'Dynamic MCP tool version one',
      });

      writeToolState(revisionBase + 2, {
        description: 'Dynamic MCP tool version two',
        schemaVersion: 2,
      });
      await expectCatalog(page, accessToken, {
        present: true,
        toolName: DYNAMIC_TOOL,
        description: 'Dynamic MCP tool version two',
      });

      writeToolState(revisionBase + 3, null);
      await expectCatalog(page, accessToken, {
        present: false,
        toolName: DYNAMIC_TOOL,
      });
    } finally {
      writeToolState(revisionBase + 4, null);
    }
  });
});
