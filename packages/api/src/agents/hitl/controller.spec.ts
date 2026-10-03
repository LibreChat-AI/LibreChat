import express from 'express';
import request from 'supertest';
import type { ToolApprovalGrantStorage, Agent } from 'librechat-data-provider';
import { createResetToolApprovalController } from './controller';

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
  const controller = createResetToolApprovalController({
    storage,
    getAgent,
    canAccessAgent,
    hasCapability,
  });
  app.post('/reset', (req, res) => controller(Object.assign(req, { user }), res));
  return { storage, app, getAgent, canAccessAgent, hasCapability };
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
