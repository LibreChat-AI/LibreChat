import type { ToolApprovalGrantStorage } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import { createResetToolApprovalController } from './controller';

function fixture(
  user?: { id: string },
  body: object = { agentId: 'agent-a', toolName: 'query_mcp_db' },
) {
  const storage: ToolApprovalGrantStorage = {
    getToolApprovalGrants: async () => [],
    rememberToolApprovalGrants: async () => {},
    resetToolApprovalGrants: jest.fn(async () => {}),
  };
  const response = { status: jest.fn(), json: jest.fn() };
  response.status.mockReturnValue(response);
  return { storage, response, request: { user, body } as Request & { user?: { id: string } } };
}

test('reset is authenticated and never accepts a caller-selected principal', async () => {
  const missing = fixture();
  await createResetToolApprovalController(missing.storage)(
    missing.request,
    missing.response as Response,
  );
  expect(missing.response.status).toHaveBeenCalledWith(401);
  expect(missing.storage.resetToolApprovalGrants).not.toHaveBeenCalled();
  const forged = fixture(
    { id: 'user-a' },
    { agentId: 'agent-a', toolName: 'query_mcp_db', userId: 'user-b' },
  );
  await createResetToolApprovalController(forged.storage)(
    forged.request,
    forged.response as Response,
  );
  expect(forged.response.status).toHaveBeenCalledWith(400);
});

test('reset scopes storage to the authenticated owner and sanitizes failures', async () => {
  const f = fixture({ id: 'user-a' });
  await createResetToolApprovalController(f.storage)(f.request, f.response as Response);
  expect(f.storage.resetToolApprovalGrants).toHaveBeenCalledWith(
    'user-a',
    'agent-a',
    'query_mcp_db',
  );
  f.storage.resetToolApprovalGrants = async () => {
    throw new Error('secret-provider-payload');
  };
  await createResetToolApprovalController(f.storage)(f.request, f.response as Response);
  expect(f.response.status).toHaveBeenLastCalledWith(503);
  expect(f.response.json).toHaveBeenLastCalledWith({ code: 'APPROVAL_RESET_FAILED' });
});
