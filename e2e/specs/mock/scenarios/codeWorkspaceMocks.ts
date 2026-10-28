import { expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

/**
 * Route mocks that stand in for a paired code worker. The composer's code
 * rail (approval mode, workspace, checkout) only renders for an agent that
 * runs stateful code sessions against an attached environment, so these specs
 * serve that agent, its environments and their workspaces from `page.route`.
 */

export type MockWorkspace = {
  id: string;
  name: string;
  repo?: string;
  ref?: string;
  /** Advertises `git_worktree` in `workspaceInstances`. */
  worktree?: boolean;
  instructionFile?: string;
};

export type MockEnvironment = {
  id: string;
  name: string;
  workspaces: MockWorkspace[];
  /** The workspace the environment's agent selects by default. */
  defaultWorkspaceId: string;
  allowCheckoutSelection?: boolean;
};

export type CodeMockOptions = {
  /** The first environment belongs to the agent Lia, a second one to her subagent. */
  environments: MockEnvironment[];
  /** Serve an MCP server with two tools and give Lia both. */
  mcp?: boolean;
};

export const LIA_ID = 'agent_liaMockAgent0000001';
const SUBAGENT_ID = 'agent_zedMockAgent0000002';
const MCP_SERVER = 'context7';

const sha = (char: string) => char.repeat(64).slice(0, 64);
const permission = { allowed: ['ask', 'allow'], default: 'ask' };

export function workspace(
  id: string,
  options: Partial<Omit<MockWorkspace, 'id' | 'name'>> = {},
): MockWorkspace {
  return { id, name: id, ...options };
}

/** One machine with four workspaces, one of them carrying instruction metadata. */
export function singleMachine(overrides: Partial<MockEnvironment> = {}): MockEnvironment {
  return {
    id: 'env-zimacube',
    name: 'ZimaCube',
    defaultWorkspaceId: 'librechat',
    allowCheckoutSelection: true,
    workspaces: [
      workspace('primary', { instructionFile: 'AGENTS.md' }),
      workspace('librechat', {
        worktree: true,
        repo: 'danny-avila/LibreChat',
        ref: 'dev',
        instructionFile: 'AGENTS.md',
      }),
      workspace('agents', { worktree: true, repo: 'LibreChat-AI/agents', ref: 'main' }),
      workspace('librechat-ai', { worktree: true, repo: 'LibreChat-AI/librechat.ai', ref: 'main' }),
    ],
    ...overrides,
  };
}

export function secondMachine(): MockEnvironment {
  return {
    id: 'env-studio',
    name: 'Studio',
    defaultWorkspaceId: 'docs',
    allowCheckoutSelection: true,
    workspaces: [
      workspace('docs', { worktree: true, repo: 'LibreChat-AI/docs', ref: 'main' }),
      workspace('notes'),
    ],
  };
}

const configSchema = (environment: MockEnvironment) => ({
  permissions: { fileWrite: permission, commandExecution: permission },
  workspaces: { allowCheckoutSelection: environment.allowCheckoutSelection === true },
});

const publicEnvironment = (environment: MockEnvironment, index: number) => ({
  id: environment.id,
  name: environment.name,
  type: 'attached',
  default: index === 0,
  configSchema: configSchema(environment),
  settings: {},
});

const status = (environment: MockEnvironment) => ({
  environmentId: environment.id,
  status: 'ready',
  statefulWorkspace: true,
  sandboxProfile: 'nsjail',
  runtimes: ['node', 'python'],
  operations: [
    'read_file',
    'search_text',
    'list_files',
    'write_file',
    'preview_edit',
    'edit_file',
    'execute_command',
  ],
  workspaces: environment.workspaces.map((entry) => ({
    id: entry.id,
    name: entry.name,
    ...(entry.worktree ? { workspaceInstances: ['git_worktree'] } : {}),
    ...(entry.repo
      ? {
          environment: {
            fingerprint: sha(entry.id.charAt(0) || 'a'),
            repo: entry.repo,
            ref: entry.ref,
            actions: [],
          },
        }
      : {}),
    instructions: entry.instructionFile
      ? [{ path: entry.instructionFile, bytes: 15258, sha256: sha('a'), truncated: false }]
      : [],
  })),
});

const mcpTools = [
  {
    name: 'resolve-library-id',
    pluginKey: `resolve-library-id_mcp_${MCP_SERVER}`,
    description: 'Resolve a library id',
  },
  {
    name: 'query-docs',
    pluginKey: `query-docs_mcp_${MCP_SERVER}`,
    description: 'Query library docs',
  },
];

function agentRecord(
  id: string,
  name: string,
  environment: MockEnvironment,
  extra: Record<string, unknown>,
) {
  return {
    id,
    name,
    description: 'Coding agent',
    provider: 'openAI',
    model: 'gpt-5',
    instructions: `You are ${name}.`,
    author: 'mock',
    category: 'general',
    tools: ['execute_code'],
    tool_options: {},
    model_parameters: {},
    agent_ids: [],
    edges: [],
    stateful_code_sessions: true,
    code_environment_id: environment.id,
    code_workspace_id: environment.defaultWorkspaceId,
    isCollaborative: false,
    version: 1,
    projectIds: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-05T00:00:00.000Z',
    _id: id
      .replace(/[^a-f0-9]/g, 'a')
      .padEnd(24, 'a')
      .slice(0, 24),
    permissions: 15,
    support_contact: { name: '', email: '' },
    ...extra,
  };
}

const json = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

type JsonRecord = Record<string, unknown>;

async function fetchRecord(route: Route): Promise<JsonRecord> {
  const response = await route.fetch();
  return (await response.json()) as JsonRecord;
}

/** Install every mock a coding agent needs; call before the first navigation. */
export async function installCodeMocks(page: Page, options: CodeMockOptions): Promise<void> {
  const { environments, mcp = false } = options;
  const [first, second] = environments;
  const agents: JsonRecord[] = [
    agentRecord(LIA_ID, 'Lia', first, {
      tools: mcp
        ? ['execute_code', ...mcpTools.map(({ pluginKey }) => pluginKey)]
        : ['execute_code'],
      agent_ids: second ? [SUBAGENT_ID] : [],
    }),
  ];
  if (second) {
    agents.push(agentRecord(SUBAGENT_ID, 'Zed', second, {}));
  }
  const byId = new Map(agents.map((agent) => [agent.id as string, agent]));

  await page.route('**/api/config', async (route) => {
    const body = await fetchRecord(route);
    Object.assign(body, {
      codeEnvironmentDecisionVersion: 1,
      codeEnvironmentMoveVersion: 1,
      codeEnvironmentTransitionVersion: 2,
      codeWorkspaceRecoveryVersion: 1,
      codeWorkspaceInheritanceVersion: 1,
    });
    await json(route, body);
  });

  await page.route('**/api/endpoints', async (route) => {
    const body = await fetchRecord(route);
    const current = (body.agents ?? {}) as JsonRecord;
    const capabilities = new Set([
      ...((current.capabilities as string[] | undefined) ?? []),
      'execute_code',
      'stateful_code_sessions',
      'tools',
    ]);
    body.agents = {
      ...current,
      order: current.order ?? 0,
      type: 'agents',
      capabilities: [...capabilities],
      statefulCodeSessions: {
        allowedEnvironments: ['managed', 'attached'],
        environments: environments.map(publicEnvironment),
        approvalsEnabled: true,
        approvalModes: ['ask', 'acceptEdits', 'fullAccess'],
        allowEnvironmentSelection: false,
      },
    };
    await json(route, body);
  });

  await page.route(/\/api\/agents(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    const body = await fetchRecord(route);
    if (!route.request().url().includes('cursor=')) {
      const existing = (body.data as JsonRecord[] | undefined) ?? [];
      body.data = [...agents, ...existing.filter((entry) => !byId.has(entry.id as string))];
    }
    await json(route, body);
  });

  await page.route(
    /\/api\/agents\/agent_(lia|zed)MockAgent\d+(\/[a-z]+)?(\?.*)?$/,
    async (route) => {
      const url = new URL(route.request().url());
      const id = url.pathname.split('/')[3];
      const agent = byId.get(id);
      const isRead = route.request().method() === 'GET';
      const suffix = url.pathname.split('/')[4];
      if (!agent || !isRead || (suffix && !['expanded', 'versions'].includes(suffix))) {
        await route.continue();
        return;
      }
      await json(route, agent);
    },
  );

  await page.route('**/api/code-environments', (route) =>
    json(route, {
      environments: environments.map((environment, index) => ({
        resourceId: `res${index}`,
        ...publicEnvironment(environment, index),
        canEdit: true,
        canDelete: true,
      })),
      controlPlanes: [],
    }),
  );
  for (const environment of environments) {
    await page.route(`**/api/code-environments/${environment.id}/status`, (route) =>
      json(route, status(environment)),
    );
  }

  if (!mcp) {
    return;
  }
  await page.route('**/api/mcp/tools', async (route) => {
    const body = await fetchRecord(route);
    body.servers = {
      ...((body.servers as JsonRecord | undefined) ?? {}),
      [MCP_SERVER]: {
        name: MCP_SERVER,
        icon: '',
        authenticated: true,
        authConfig: [],
        tools: mcpTools,
      },
    };
    await json(route, body);
  });
  await page.route('**/api/mcp/servers', async (route) => {
    const body = await fetchRecord(route);
    const entry = {
      serverName: MCP_SERVER,
      _id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
      dbId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
      config: { type: 'streamable-http', url: 'https://mcp.context7.com/mcp', title: MCP_SERVER },
      url: 'https://mcp.context7.com/mcp',
      type: 'streamable-http',
      title: MCP_SERVER,
      name: MCP_SERVER,
    };
    if (Array.isArray(body)) {
      body.push(entry);
    } else {
      ((body.servers as JsonRecord | undefined) ?? body)[MCP_SERVER] = entry;
    }
    await json(route, body);
  });
}

/** Open a new chat with the mocked coding agent selected and the code rail rendered. */
export async function openCodeChat(page: Page): Promise<void> {
  await page.goto(`/c/new?endpoint=agents&agent_id=${LIA_ID}`, { timeout: 15000 });
  await expect(page.getByTestId('composer-context-rail')).toBeVisible({ timeout: 30000 });
}
