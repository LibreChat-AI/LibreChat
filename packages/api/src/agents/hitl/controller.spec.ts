import express from 'express';
import request from 'supertest';
import type { ToolApprovalGrantStorage, Agent } from 'librechat-data-provider';
import type { MCPServerTools } from '~/tools/definitions';
import type { ParsedServerConfig } from '~/mcp/types';
import { createResetToolApprovalController } from './controller';
import { formatMCPServerTools } from '~/mcp/tools';

function fixture(user?: { id: string; role?: string }) {
  const storage: ToolApprovalGrantStorage = {
    getToolApprovalGrants: async () => [],
    rememberToolApprovalGrants: async () => {},
    resetToolApprovalGrants: jest.fn(async () => {}),
  };
  const app = express();
  app.use(express.json());
  const getAgent = jest.fn(
    async (): Promise<Pick<Agent, 'id' | 'tool_options'>> => ({
      id: 'agent-a',
      tool_options: { query_mcp_db: { approval_mode: 'chat' as const } },
    }),
  );
  const canAccessAgent = jest.fn(async () => true);
  const hasCapability = jest.fn(async () => false);
  const getMCPServerConfigs = jest.fn(
    async (): Promise<Record<string, ParsedServerConfig>> => ({
      db: { type: 'streamable-http', url: 'https://mcp.example.test/mcp' },
    }),
  );
  const getMCPServerTools = jest.fn(async (): Promise<MCPServerTools | null> => null);
  const controller = createResetToolApprovalController({
    storage,
    getAgent,
    canAccessAgent,
    hasCapability,
    getMCPServerConfigs,
    getMCPServerTools,
  });
  app.post('/reset', (req, res) => controller(Object.assign(req, { user }), res));
  return {
    storage,
    app,
    getAgent,
    canAccessAgent,
    hasCapability,
    getMCPServerConfigs,
    getMCPServerTools,
  };
}

const reset = { agentId: 'agent-a', toolName: 'query_mcp_db' };

test('reset is authenticated and never accepts a caller-selected principal', async () => {
  const missing = fixture();
  await request(missing.app).post('/reset').send(reset).expect(401);
  expect(missing.storage.resetToolApprovalGrants).not.toHaveBeenCalled();
  const forged = fixture({ id: 'user-a' });
  await request(forged.app)
    .post('/reset')
    .send({ ...reset, userId: 'user-b' })
    .expect(400);
  expect(forged.storage.resetToolApprovalGrants).not.toHaveBeenCalled();
});

test('reset scopes storage to the authenticated owner and sanitizes failures', async () => {
  const f = fixture({ id: 'user-a' });
  await request(f.app).post('/reset').send(reset).expect(200, { reset: true });
  expect(f.storage.resetToolApprovalGrants).toHaveBeenCalledWith(
    'user-a',
    'agent-a',
    'query_mcp_db',
  );
  f.storage.resetToolApprovalGrants = async () => {
    throw new Error('secret-provider-payload');
  };
  await request(f.app).post('/reset').send(reset).expect(503, { code: 'APPROVAL_RESET_FAILED' });
});

test('unknown tools and inaccessible agents cannot create reset fences', async () => {
  const f = fixture({ id: 'user-a' });
  await request(f.app)
    .post('/reset')
    .send({ ...reset, toolName: 'unknown-tool' })
    .expect(403);
  f.canAccessAgent.mockResolvedValue(false);
  await request(f.app).post('/reset').send(reset).expect(403);
  expect(f.storage.resetToolApprovalGrants).not.toHaveBeenCalled();
});

test('a VIEW-only caller resets all personal learned modes without requesting authoring data', async () => {
  const f = fixture({ id: 'viewer-a' });
  f.getAgent.mockResolvedValueOnce({ id: 'agent-a' });
  await request(f.app).post('/reset').send({ agentId: 'agent-a' }).expect(200, { reset: true });
  expect(f.canAccessAgent).toHaveBeenCalled();
  expect(f.storage.resetToolApprovalGrants).toHaveBeenCalledWith('viewer-a', 'agent-a', undefined);
  await request(f.app)
    .post('/reset')
    .send({ agentId: 'agent-a', tenantId: 'another-tenant' })
    .expect(400);
  f.canAccessAgent.mockResolvedValue(false);
  await request(f.app).post('/reset').send({ agentId: 'agent-a' }).expect(403);
  expect(f.storage.resetToolApprovalGrants).toHaveBeenCalledTimes(1);
});

test.each([undefined, 'query_mcp_db'])(
  'manage:agents authorizes personal reset with tool=%s without a resource ACL',
  async (toolName) => {
    const f = fixture({ id: 'manager-a', role: 'USER' });
    f.hasCapability.mockResolvedValue(true);
    f.canAccessAgent.mockResolvedValue(false);
    await request(f.app)
      .post('/reset')
      .send({ agentId: 'agent-a', toolName })
      .expect(200, { reset: true });
    expect(f.hasCapability).toHaveBeenCalledWith(
      { id: 'manager-a', role: 'USER' },
      'manage:agents',
    );
    expect(f.canAccessAgent).not.toHaveBeenCalled();
    expect(f.storage.resetToolApprovalGrants).toHaveBeenCalledWith(
      'manager-a',
      'agent-a',
      toolName,
    );
  },
);

test('a failed capability lookup never grants access and preserves the normal ACL fallback', async () => {
  const f = fixture({ id: 'viewer-a', role: 'USER' });
  f.hasCapability.mockRejectedValue(new Error('synthetic capability failure'));
  f.canAccessAgent.mockResolvedValue(false);
  await request(f.app).post('/reset').send({ agentId: 'agent-a' }).expect(403);
  expect(f.storage.resetToolApprovalGrants).not.toHaveBeenCalled();
  f.canAccessAgent.mockResolvedValue(true);
  await request(f.app).post('/reset').send({ agentId: 'agent-a' }).expect(200);
});

test('targeted reset uses a verified current catalog alias without editing or saving the agent', async () => {
  const f = fixture({ id: 'viewer-a' });
  const agent = {
    id: 'agent-a',
    tool_options: { db_query_mcp_db: { approval_mode: 'chat' as const } },
  };
  f.getAgent.mockResolvedValue(agent);
  f.getMCPServerTools.mockResolvedValue(formatMCPServerTools('db', [{ name: 'db_query' }]));
  await request(f.app).post('/reset').send(reset).expect(200, { reset: true });
  expect(f.storage.resetToolApprovalGrants).toHaveBeenCalledWith(
    'viewer-a',
    'agent-a',
    'query_mcp_db',
  );
  expect(agent.tool_options).toEqual({ db_query_mcp_db: { approval_mode: 'chat' } });
  expect(f.getMCPServerTools).toHaveBeenCalledTimes(1);
});

test('a legacy request resets the canonical grant when current options already exist', async () => {
  const f = fixture({ id: 'viewer-a' });
  f.getMCPServerTools.mockResolvedValue(formatMCPServerTools('db', [{ name: 'db_query' }]));
  await request(f.app)
    .post('/reset')
    .send({ ...reset, toolName: 'db_query_mcp_db' })
    .expect(200);
  expect(f.storage.resetToolApprovalGrants).toHaveBeenCalledWith(
    'viewer-a',
    'agent-a',
    'query_mcp_db',
  );
});

test('a collision-preserved sibling never inherits another tool’s consent mode', async () => {
  const f = fixture({ id: 'viewer-a' });
  f.getAgent.mockResolvedValue({
    id: 'agent-a',
    tool_options: { db_query_mcp_db: { approval_mode: 'always' } },
  });
  f.getMCPServerTools.mockResolvedValue(
    formatMCPServerTools('db', [{ name: 'db_query' }, { name: 'query' }]),
  );
  await request(f.app).post('/reset').send(reset).expect(403);
  expect(f.storage.resetToolApprovalGrants).not.toHaveBeenCalled();
  await request(f.app)
    .post('/reset')
    .send({ ...reset, toolName: 'db_query_mcp_db' })
    .expect(200);
  expect(f.storage.resetToolApprovalGrants).toHaveBeenCalledWith(
    'viewer-a',
    'agent-a',
    'db_query_mcp_db',
  );
});

test('explicit current options override the legacy alias mode', async () => {
  const f = fixture({ id: 'viewer-a' });
  f.getAgent.mockResolvedValue({
    id: 'agent-a',
    tool_options: {
      db_query_mcp_db: { approval_mode: 'always' },
      query_mcp_db: { approval_mode: 'ask' },
    },
  });
  f.getMCPServerTools.mockResolvedValue(formatMCPServerTools('db', [{ name: 'db_query' }]));
  await request(f.app).post('/reset').send(reset).expect(403);
  expect(f.storage.resetToolApprovalGrants).not.toHaveBeenCalled();
});

test('raw server keys normalize only inside their exact configured boundary', async () => {
  const f = fixture({ id: 'viewer-a' });
  f.getMCPServerConfigs.mockResolvedValue({
    'db ops': { type: 'streamable-http', url: 'https://mcp.example.test/mcp' },
    'long_mcp_db ops': { type: 'streamable-http', url: 'https://other.example.test/mcp' },
  });
  f.getAgent.mockResolvedValue({
    id: 'agent-a',
    tool_options: {
      'db_ops_query_mcp_db ops': { approval_mode: 'chat' },
      'query_mcp_long_mcp_db ops': { approval_mode: 'always' },
    },
  });
  f.getMCPServerTools.mockResolvedValue(formatMCPServerTools('db ops', [{ name: 'db_ops_query' }]));
  await request(f.app)
    .post('/reset')
    .send({ ...reset, toolName: 'query_mcp_db_ops' })
    .expect(200);
  expect(f.storage.resetToolApprovalGrants).toHaveBeenCalledWith(
    'viewer-a',
    'agent-a',
    'query_mcp_db_ops',
  );
  expect(f.getMCPServerTools).toHaveBeenCalledWith('viewer-a', 'db ops', expect.any(Object));
});

test('a shadowed raw server cannot lend its options to the winning server', async () => {
  const f = fixture({ id: 'viewer-a' });
  f.getMCPServerConfigs.mockResolvedValue({
    'db!': { type: 'streamable-http', url: 'https://shadow.example.test/mcp' },
    db_: { type: 'streamable-http', url: 'https://mcp.example.test/mcp' },
  });
  f.getAgent.mockResolvedValue({
    id: 'agent-a',
    tool_options: { 'db_query_mcp_db!': { approval_mode: 'always' } },
  });
  f.getMCPServerTools.mockResolvedValue(formatMCPServerTools('db_', [{ name: 'query' }]));
  await request(f.app)
    .post('/reset')
    .send({ ...reset, toolName: 'query_mcp_db_' })
    .expect(403);
  expect(f.storage.resetToolApprovalGrants).not.toHaveBeenCalled();
});

test('missing catalogs cannot authorize unverified aliases; operational failure stays sanitized', async () => {
  const f = fixture({ id: 'viewer-a' });
  f.getAgent.mockResolvedValue({
    id: 'agent-a',
    tool_options: { db_query_mcp_db: { approval_mode: 'always' } },
  });
  await request(f.app).post('/reset').send(reset).expect(403);
  await request(f.app)
    .post('/reset')
    .send({ ...reset, toolName: 'db_query_mcp_db' })
    .expect(200);
  f.getMCPServerTools.mockRejectedValue(new Error('secret-catalog-headers'));
  await request(f.app).post('/reset').send(reset).expect(503, { code: 'APPROVAL_RESET_FAILED' });
  expect(f.storage.resetToolApprovalGrants).toHaveBeenCalledTimes(1);
});

test('agent-wide and inaccessible resets do not load MCP catalogs', async () => {
  const f = fixture({ id: 'viewer-a' });
  await request(f.app).post('/reset').send({ agentId: 'agent-a' }).expect(200);
  f.canAccessAgent.mockResolvedValue(false);
  await request(f.app).post('/reset').send(reset).expect(403);
  expect(f.getMCPServerConfigs).not.toHaveBeenCalled();
  expect(f.getMCPServerTools).not.toHaveBeenCalled();
});
