import { Types } from 'mongoose';
import { Permissions, PermissionTypes } from 'librechat-data-provider';
import type { IRole, IUser } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { ManageAgentHandlers } from './builder';
import { createManageAgentTool, manageAgentApprovalHook } from './builder';
import { createAgentManagementUpdateHandler } from './updates';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { warn: jest.fn(), error: jest.fn() },
}));

const user = { id: new Types.ObjectId().toString(), tenantId: 't', role: 'USER' } as IUser;
const agent = {
  _id: new Types.ObjectId(),
  id: 'agent_a',
  name: 'A',
  provider: 'openAI',
  model: 'gpt-5',
  version: 1,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};
const req = { user } as unknown as Request;
const role = {
  permissions: {
    [PermissionTypes.AGENTS]: { [Permissions.USE]: true, [Permissions.CREATE]: true },
  },
} as IRole;

function makeHandlers(overrides: Partial<ManageAgentHandlers> = {}): ManageAgentHandlers {
  const reply = (body: unknown) =>
    jest.fn(async (_req: Request, res: Response) => res.status(200).json(body));
  return {
    list: reply({ data: [{ ...agent, instructions: 'long' }], after: null }),
    get: reply({ id: agent.id }),
    create: reply({ id: 'agent_new' }),
    update: reply({ id: agent.id }),
    ...overrides,
  };
}

const invoke = (
  tool: ReturnType<typeof createManageAgentTool>,
  args: object,
  metadata?: Record<string, unknown>,
) => tool.invoke(args, metadata ? { metadata } : undefined);

describe('manage_agent', () => {
  it('routes each action to its Management handler with the agent id and compacts list rows', async () => {
    const handlers = makeHandlers();
    const tool = createManageAgentTool({ req: req, handlers, approvalEnabled: true });

    const listed = JSON.parse(await invoke(tool, { action: 'list', query: { limit: 5 } }));
    expect(listed.data[0]).toEqual({ id: agent.id, name: 'A', provider: 'openAI', model: 'gpt-5' });
    expect((handlers.list as jest.Mock).mock.calls[0][0].query).toEqual({ limit: 5 });

    await invoke(tool, { action: 'update', agent_id: agent.id, data: { name: 'B' } });
    const updateReq = (handlers.update as jest.Mock).mock.calls[0][0];
    expect(updateReq.params).toEqual({ id: agent.id });
    expect(updateReq.body).toEqual({ name: 'B' });
    expect(updateReq.user).toBe(user);
    expect(handlers.create).not.toHaveBeenCalled();
  });

  it('asks for approval on writes only', async () => {
    const input = (action: string) =>
      ({
        hook_event_name: 'PreToolUse',
        runId: 'run',
        toolUseId: 'call',
        toolName: 'manage_agent',
        toolInput: { action },
      }) as Parameters<typeof manageAgentApprovalHook>[0];
    const signal = new AbortController().signal;
    expect(await manageAgentApprovalHook(input('list'), signal)).toEqual({});
    expect(await manageAgentApprovalHook(input('get'), signal)).toEqual({});
    expect((await manageAgentApprovalHook(input('create'), signal)).decision).toBe('ask');
    expect((await manageAgentApprovalHook(input('update'), signal)).decision).toBe('ask');
  });

  it('refuses writes without tool approval or from code execution, but still reads', async () => {
    const handlers = makeHandlers();
    const unapproved = createManageAgentTool({
      req: req,
      handlers,
      approvalEnabled: false,
    });
    expect(await invoke(unapproved, { action: 'create', data: {} })).toMatch(/approval/);
    await invoke(unapproved, { action: 'get', agent_id: agent.id });
    expect(handlers.get).toHaveBeenCalled();

    const approved = createManageAgentTool({ req: req, handlers, approvalEnabled: true });
    const fromCode = await invoke(
      approved,
      { action: 'update', agent_id: agent.id, data: {} },
      { run_tools_with_code: true },
    );
    expect(fromCode).toMatch(/code execution/);
    expect(handlers.create).not.toHaveBeenCalled();
    expect(handlers.update).not.toHaveBeenCalled();
  });

  it('returns the Management permission error when the user cannot edit the agent', async () => {
    const updateAgent = jest.fn();
    const update = createAgentManagementUpdateHandler({
      getRoleByName: jest.fn().mockResolvedValue(role),
      getAgentWithVersionCount: jest.fn().mockResolvedValue(agent),
      checkPermission: jest.fn().mockResolvedValue(false),
      hasCapability: jest.fn().mockResolvedValue(false),
      updateAgent,
    });
    const tool = createManageAgentTool({
      req: req,
      handlers: makeHandlers({ update }),
      approvalEnabled: true,
    });

    const result = JSON.parse(
      await invoke(tool, { action: 'update', agent_id: agent.id, data: { name: 'B' } }),
    );
    expect(result.error.code).toBe('permission_denied');
    expect(updateAgent).not.toHaveBeenCalled();
  });
});
