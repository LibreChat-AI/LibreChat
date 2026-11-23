import { z } from 'zod';
import { tool } from '@librechat/agents/langchain/tools';
import type { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import type { Request, Response } from 'express';
import type { ExtendedJsonSchema } from '~/tools/registry/schema';
import type { AgentManagementListResponse } from './management';
import type { ToolApprovalHook } from './hitl/hooks';
import { registerToolApprovalHook } from './hitl/hooks';

export const MANAGE_AGENT_TOOL_NAME = 'manage_agent';

const ACTIONS = ['list', 'get', 'create', 'update'] as const;
const READ_ACTIONS: ReadonlySet<string> = new Set(['list', 'get']);
/** Inner calls from code execution bypass `PreToolUse`, so writes must not run there. */
const PROGRAMMATIC_CALLERS = ['run_tools_with_code', 'run_tools_with_bash'];

export const MANAGE_AGENT_DESCRIPTION =
  'List, read, create, or update agents the user can edit. create and update ask the user for approval.';

export const manageAgentSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: [...ACTIONS] },
    agent_id: { type: 'string', description: 'Required for get and update.' },
    query: {
      type: 'object',
      description: 'list paging: { limit (1-100), cursor (from previous `after`) }.',
    },
    data: {
      type: 'object',
      description:
        'create/update fields: name, description, instructions, provider, model, model_parameters, tools, tool_options, conversation_starters, category. create requires provider and model. Unknown fields are rejected.',
    },
  },
  required: ['action'],
};

const inputSchema = z.object({
  action: z.enum(ACTIONS),
  agent_id: z.string().min(1).optional(),
  query: z.record(z.string(), z.unknown()).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

type ManagementHandler = (req: Request, res: Response) => Promise<Response>;

/** The Agent Management API handlers; they own ACL, validation, and response projection. */
export interface ManageAgentHandlers {
  list: ManagementHandler;
  get: ManagementHandler;
  create: ManagementHandler;
  update: ManagementHandler;
}

/** Runs a Management handler against the chat request's user and config, capturing its JSON. */
async function callHandler(
  handler: ManagementHandler,
  req: Request,
  input: { body?: unknown; params?: Record<string, string>; query?: unknown },
): Promise<{ status: number; body: unknown }> {
  let status = 200;
  let body: unknown;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(value: unknown) {
      body = value;
      return res;
    },
  };
  /** Own data properties: Express 5 defines `query` as a getter on the request prototype. */
  const callReq = Object.create(req, {
    body: { value: input.body ?? {}, writable: true },
    params: { value: input.params ?? {}, writable: true },
    query: { value: input.query ?? {}, writable: true },
  }) as Request;
  // shortcut: duck-typed response that supports only status().json(); replace with a
  // transport-free Management service if the handlers start using other response methods.
  await handler(callReq, res as unknown as Response);
  return { status, body };
}

/** Rows without instructions or tool settings keep list results small; `get` returns the full agent. */
function compactList(body: AgentManagementListResponse) {
  return {
    data: body.data.map(({ id, name, description, provider, model }) => ({
      id,
      name,
      description,
      provider,
      model,
    })),
    after: body.after,
  };
}

export function createManageAgentTool({
  req,
  handlers,
  approvalEnabled,
}: {
  req: Request;
  handlers: ManageAgentHandlers;
  /** Tool approval is on for this deployment; the approval hook is inert without it. */
  approvalEnabled: boolean;
}): DynamicStructuredTool {
  return tool(
    async ({ action, agent_id, query, data }: z.infer<typeof inputSchema>, config) => {
      const isWrite = !READ_ACTIONS.has(action);
      if (isWrite && !approvalEnabled) {
        return `Cannot ${action} agents: tool approval (endpoints.agents.toolApproval) is disabled.`;
      }
      const metadata = config?.metadata as Record<string, unknown> | undefined;
      if (isWrite && PROGRAMMATIC_CALLERS.some((name) => metadata?.[name] === true)) {
        return `Cannot ${action} agents from code execution. Call ${MANAGE_AGENT_TOOL_NAME} directly so the user can approve it.`;
      }
      if ((action === 'get' || action === 'update') && agent_id == null) {
        return `agent_id is required for ${action}.`;
      }
      if (isWrite && data == null) {
        return `data is required for ${action}.`;
      }

      const params = agent_id != null ? { id: agent_id } : undefined;
      const result = await callHandler(handlers[action], req, { body: data, params, query });
      if (action === 'list' && result.status === 200) {
        return JSON.stringify(compactList(result.body as AgentManagementListResponse));
      }
      return JSON.stringify(result.body);
    },
    { name: MANAGE_AGENT_TOOL_NAME, description: MANAGE_AGENT_DESCRIPTION, schema: inputSchema },
  );
}

/** Reads abstain; every other action asks. A headless run denies the `ask`. */
export const manageAgentApprovalHook: ToolApprovalHook = async (input) => {
  const action = input.toolInput?.action;
  if (typeof action === 'string' && READ_ACTIONS.has(action)) {
    return {};
  }
  return {
    decision: 'ask',
    reason: `${MANAGE_AGENT_TOOL_NAME} ${String(action)} changes an agent`,
  };
};

/** Process-wide registration; call once at startup. */
export function registerManageAgentApproval(): () => void {
  return registerToolApprovalHook(() => manageAgentApprovalHook, {
    matcher: `^${MANAGE_AGENT_TOOL_NAME}$`,
  });
}
