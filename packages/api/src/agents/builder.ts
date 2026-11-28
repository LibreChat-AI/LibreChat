/** Agent builder: tools an agent calls to list, read, create and update other agents. */
import { z } from 'zod';
import { tool } from '@librechat/agents/langchain/tools';
import { logger, escapeRegExp } from '@librechat/data-schemas';
import {
  Permissions,
  ResourceType,
  PermissionBits,
  PermissionTypes,
  EModelEndpoint,
  AgentCapabilities,
} from 'librechat-data-provider';
import type { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import type { LCTool, HookCallback, LCToolRegistry } from '@librechat/agents';
import type { AgentToolOptions } from 'librechat-data-provider';
import type { IRole } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types';
import { agentCreateSchema, agentUpdateSchema } from './validation';
import { checkAccess } from '~/middleware/access';
import { toToolParameters } from '~/tools/schema';
import { getSafeErrorMetadata } from '~/utils';
import { isHITLEnabled } from './hitl/policy';

export const AGENT_BUILDER_MARKER: AgentCapabilities.agent_builder =
  AgentCapabilities.agent_builder;
export const LIST_AGENTS_TOOL_NAME = 'list_agents';
export const GET_AGENT_TOOL_NAME = 'get_agent';
export const CREATE_AGENT_TOOL_NAME = 'create_agent';
export const UPDATE_AGENT_TOOL_NAME = 'update_agent';

const READ_TOOL_NAMES = [LIST_AGENTS_TOOL_NAME, GET_AGENT_TOOL_NAME];
export const AGENT_BUILDER_WRITE_TOOL_NAMES: string[] = [
  CREATE_AGENT_TOOL_NAME,
  UPDATE_AGENT_TOOL_NAME,
];

/** The fields an agent may write. Values are re-validated by the browser create/update flow. */
const editableFields = {
  name: true,
  description: true,
  instructions: true,
  provider: true,
  model: true,
  tools: true,
} as const;

const schemas = {
  [LIST_AGENTS_TOOL_NAME]: z.object({
    search: z.string().max(100).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    cursor: z.string().optional(),
  }),
  [GET_AGENT_TOOL_NAME]: z.object({ id: z.string() }),
  [CREATE_AGENT_TOOL_NAME]: agentCreateSchema.pick(editableFields),
  [UPDATE_AGENT_TOOL_NAME]: agentUpdateSchema.pick(editableFields).extend({ id: z.string() }),
};

const descriptions: Record<keyof typeof schemas, string> = {
  [LIST_AGENTS_TOOL_NAME]:
    'List agents the user can view (id, name, description). Omit `search` to list all agents; use it only when the user names or describes one.',
  [GET_AGENT_TOOL_NAME]: "Get an agent's configuration by id.",
  [CREATE_AGENT_TOOL_NAME]: 'Create an agent. The user must approve.',
  [UPDATE_AGENT_TOOL_NAME]:
    'Update an agent by id. Omitted fields stay unchanged; `tools` replaces the list, so include the tools to keep (the calling agent must keep `agent_builder`). The user must approve.',
};

export function getAgentBuilderToolDefinitions(includeWrites: boolean): LCTool[] {
  const names = includeWrites
    ? [...READ_TOOL_NAMES, ...AGENT_BUILDER_WRITE_TOOL_NAMES]
    : READ_TOOL_NAMES;
  return names.map((name) => ({
    name,
    description: descriptions[name as keyof typeof schemas],
    parameters: toToolParameters(schemas[name as keyof typeof schemas]),
  })) as LCTool[];
}

/** Whether every agent-builder write will reach a human approval decision. */
function writesNeedApproval(req: ServerRequest): boolean {
  return isHITLEnabled(req.config?.endpoints?.[EModelEndpoint.agents]?.toolApproval);
}

/**
 * Registers the agent-builder tools for an agent that carries the `agent_builder` marker.
 * Write tools register only when tool approval is enabled: without it nothing would pause
 * them, so they are not offered. Read tools take `allowed_callers` from `tool_options` (own
 * name first, then the marker); write tools stay direct-only so the approval hook always sees them.
 */
export function registerAgentBuilderTools({
  toolRegistry,
  toolDefinitions,
  toolOptions,
  approvalEnabled,
}: {
  toolRegistry?: LCToolRegistry;
  toolDefinitions?: LCTool[];
  toolOptions?: AgentToolOptions;
  approvalEnabled: boolean;
}): { toolDefinitions: LCTool[]; toolNames: string[] } {
  const definitions = getAgentBuilderToolDefinitions(approvalEnabled);
  const inputDefinitions = toolDefinitions ?? [];
  const newDefs: LCTool[] = [];
  for (const def of definitions) {
    if (toolRegistry?.has(def.name) || inputDefinitions.some((d) => d.name === def.name)) {
      continue;
    }
    const callers =
      toolOptions?.[def.name]?.allowed_callers ??
      toolOptions?.[AGENT_BUILDER_MARKER]?.allowed_callers;
    if (callers && READ_TOOL_NAMES.includes(def.name)) {
      def.allowed_callers = callers;
    }
    toolRegistry?.set(def.name, def);
    newDefs.push(def);
  }
  return {
    toolDefinitions: newDefs.length ? [...inputDefinitions, ...newDefs] : inputDefinitions,
    toolNames: definitions.map((def) => def.name),
  };
}

/** Asks for approval on every agent-builder write, even under a `bypass` or `allow` policy. */
export const agentBuilderApprovalHook: HookCallback<'PreToolUse'> = async (input) => ({
  decision: 'ask',
  reason: `${input.toolName} changes a saved agent`,
});

type AgentRecord = {
  _id: { toString(): string };
  id: string;
  name?: string | null;
  description?: string | null;
  instructions?: string | null;
  provider?: string;
  model?: string | null;
  tools?: string[];
};

type AgentWriteResult = {
  status: number;
  body?: { id?: string; name?: string; tools?: string[]; error?: string };
};
/** The browser `POST /agents` and `PATCH /agents/:id` logic, without the Express response. */
type AgentWrite = (req: ServerRequest) => Promise<AgentWriteResult>;

export interface AgentBuilderDeps {
  getRoleByName: (roleName: string, fieldsToSelect?: string | string[]) => Promise<IRole | null>;
  getAgent: (search: { id: string }) => Promise<AgentRecord | null>;
  findAccessibleResources: (params: {
    userId: string;
    role?: string;
    resourceType: ResourceType;
    requiredPermissions: number;
  }) => Promise<Array<{ toString(): string }>>;
  getListAgentsByAccess: (params: {
    accessibleIds: Array<{ toString(): string }>;
    otherParams?: Record<string, unknown>;
    limit: number;
    after: string | null;
  }) => Promise<{ data: Array<Partial<AgentRecord>>; has_more: boolean; after: string | null }>;
  checkPermission: (params: {
    userId: string;
    role?: string;
    resourceType: ResourceType;
    resourceId: { toString(): string };
    requiredPermission: PermissionBits;
  }) => Promise<boolean>;
  createAgent: AgentWrite;
  updateAgent: AgentWrite;
}

/** Runs a browser write with a substitute body and id, so it passes the same validation, tool authorization, content filtering and owner grants as the UI. */
function runWrite(
  write: AgentWrite,
  req: ServerRequest,
  body: Record<string, unknown>,
  id?: string,
): Promise<AgentWriteResult> {
  return write(
    Object.assign(Object.create(req) as ServerRequest, { body, params: id ? { id } : {} }),
  );
}

function writeResult(result: AgentWriteResult): string {
  if (result.status < 300 && result.body?.id) {
    const { id, name, tools } = result.body;
    return JSON.stringify({ id, name, tools });
  }
  /** 4xx messages are authored by the controllers; 5xx messages may carry internals. */
  const reason = result.status < 500 ? result.body?.error : undefined;
  return `Error ${result.status}${reason ? `: ${reason}` : ''}`;
}

/**
 * Builds one agent-builder tool for the event-driven executor, re-checking the opt-in,
 * capability and role gates at execution time. Returns `null` when the call is not permitted.
 * Per-agent ACL (VIEW to read, EDIT to update) is checked on each call.
 */
export async function buildAgentBuilderTool({
  toolName,
  req,
  agent,
  deps,
}: {
  toolName: string;
  req: ServerRequest;
  agent?: { id?: string; tools?: unknown[] } | null;
  deps: AgentBuilderDeps;
}): Promise<DynamicStructuredTool | null> {
  const user = req.user;
  const capabilities = req.config?.endpoints?.[EModelEndpoint.agents]?.capabilities ?? [];
  if (
    !user?.id ||
    !capabilities.includes(AGENT_BUILDER_MARKER) ||
    !(agent?.tools ?? []).includes(AGENT_BUILDER_MARKER)
  ) {
    return null;
  }
  const isWrite = AGENT_BUILDER_WRITE_TOOL_NAMES.includes(toolName);
  if (isWrite && !writesNeedApproval(req)) {
    return null;
  }
  try {
    const allowed = await checkAccess({
      user,
      permissionType: PermissionTypes.AGENTS,
      permissions: isWrite ? [Permissions.USE, Permissions.CREATE] : [Permissions.USE],
      getRoleByName: deps.getRoleByName,
    });
    if (!allowed) {
      return null;
    }
  } catch (error) {
    logger.error('[agentBuilder] Permission check failed', getSafeErrorMetadata(error));
    return null;
  }

  const userId = user.id;
  const role = user.role;
  const can = (target: AgentRecord, requiredPermission: PermissionBits) =>
    deps.checkPermission({
      userId,
      role,
      resourceType: ResourceType.AGENT,
      resourceId: target._id,
      requiredPermission,
    });

  const handlers = {
    [LIST_AGENTS_TOOL_NAME]: async ({
      search,
      limit,
      cursor,
    }: z.infer<(typeof schemas)['list_agents']>) => {
      const accessibleIds = await deps.findAccessibleResources({
        userId,
        role,
        resourceType: ResourceType.AGENT,
        requiredPermissions: PermissionBits.VIEW,
      });
      const regex = search?.trim() ? new RegExp(escapeRegExp(search.trim()), 'i') : undefined;
      const page = await deps.getListAgentsByAccess({
        accessibleIds,
        otherParams: regex ? { $or: [{ name: regex }, { description: regex }] } : undefined,
        limit: limit ?? 20,
        after: cursor ?? null,
      });
      return JSON.stringify({
        agents: page.data.map(({ id, name, description }) => ({ id, name, description })),
        next_cursor: page.has_more ? page.after : undefined,
      });
    },
    [GET_AGENT_TOOL_NAME]: async ({ id }: z.infer<(typeof schemas)['get_agent']>) => {
      const target = await deps.getAgent({ id });
      if (!target) {
        return 'Error 404: Agent not found';
      }
      /** Mirrors `GET /agents/:id`: VIEW sees the summary, EDIT also sees instructions and tools. */
      // shortcut: returns stored `instructions` only, not a linked `instructionsPrompt`; route through `presentForEditor` when linked prompts must be readable.
      const canEdit = await can(target, PermissionBits.EDIT);
      if (!canEdit && !(await can(target, PermissionBits.VIEW))) {
        return 'Error 404: Agent not found';
      }
      const { name, description, provider, model, instructions, tools } = target;
      return JSON.stringify(
        canEdit
          ? { id, name, description, provider, model, instructions, tools }
          : { id, name, description, provider, model },
      );
    },
    [CREATE_AGENT_TOOL_NAME]: async (input: z.infer<(typeof schemas)['create_agent']>) =>
      writeResult(await runWrite(deps.createAgent, req, input)),
    [UPDATE_AGENT_TOOL_NAME]: async ({
      id,
      ...input
    }: z.infer<(typeof schemas)['update_agent']>) => {
      const target = await deps.getAgent({ id });
      if (!target || !(await can(target, PermissionBits.EDIT))) {
        return 'Error 404: Agent not found or not editable';
      }
      if (id === agent?.id && input.tools && !input.tools.includes(AGENT_BUILDER_MARKER)) {
        return `Error 400: keep ${AGENT_BUILDER_MARKER} in tools when updating this agent`;
      }
      return writeResult(await runWrite(deps.updateAgent, req, input, id));
    },
  };

  const name = toolName as keyof typeof handlers;
  const handler = handlers[name] as ((input: object) => Promise<string>) | undefined;
  if (!handler) {
    return null;
  }
  return tool(
    async (input: object) => {
      try {
        return await handler(input);
      } catch (error) {
        logger.error(`[agentBuilder] ${toolName} failed`, getSafeErrorMetadata(error));
        return `Error: ${toolName} failed`;
      }
    },
    { name, description: descriptions[name], schema: schemas[name] },
  );
}
