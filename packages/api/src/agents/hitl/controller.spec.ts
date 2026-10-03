import express from 'express';
import request from 'supertest';
import type { ToolApprovalGrantStorage } from 'librechat-data-provider';
import { createResetToolApprovalController } from './controller';

function fixture(user?: { id: string }) {
  const storage: ToolApprovalGrantStorage = {
    getToolApprovalGrants: async () => [],
    rememberToolApprovalGrants: async () => {},
    resetToolApprovalGrants: jest.fn(async () => {}),
  };
  const app = express();
  app.use(express.json());
  const getAgent = jest.fn(async () => ({
    id: 'agent-a',
    tools: ['query_mcp_db'],
    tool_options: { query_mcp_db: { approval_mode: 'chat' as const } },
  }));
  const canAccessAgent = jest.fn(async () => true);
  const controller = createResetToolApprovalController({ storage, getAgent, canAccessAgent });
  app.post('/reset', (req, res) => controller(Object.assign(req, { user }), res));
  return { storage, app, getAgent, canAccessAgent };
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
