import { z } from 'zod';
import { tool } from '@librechat/agents/langchain/tools';
import { AgentCapabilities, EModelEndpoint } from 'librechat-data-provider';
import type { AgentToolOptions, TToolApprovalPolicy } from 'librechat-data-provider';
import type { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import type { LCTool, LCToolRegistry } from '@librechat/agents';
import type { NextFunction, Request, Response } from 'express';
import type { AppConfig } from '@librechat/data-schemas';
import { isHITLEnabled } from './hitl/policy';

export const LIST_AGENTS_TOOL_NAME = 'list_agents';
export const GET_AGENT_TOOL_NAME = 'get_agent';
export const CREATE_AGENT_TOOL_NAME = 'create_agent';
export const UPDATE_AGENT_TOOL_NAME = 'update_agent';

const READ_TOOL_NAMES: readonly string[] = [LIST_AGENTS_TOOL_NAME, GET_AGENT_TOOL_NAME];
/** Every write pauses for human approval; see {@link requireAgentBuilderApproval}. */
export const AGENT_BUILDER_WRITE_TOOL_NAMES: readonly string[] = [
  CREATE_AGENT_TOOL_NAME,
  UPDATE_AGENT_TOOL_NAME,
];
export const AGENT_BUILDER_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...READ_TOOL_NAMES,
  ...AGENT_BUILDER_WRITE_TOOL_NAMES,
]);

/** The browser route chains (access middleware + v1 handler) each tool replays. */
export type AgentBuilderHandler = (req: Request, res: Response, next: NextFunction) => unknown;
export type AgentBuilderRoutes = Record<
  'list' | 'get' | 'getExpanded' | 'create' | 'update',
  readonly AgentBuilderHandler[]
>;

export function isAgentBuilderEnabled(appConfig?: AppConfig): boolean {
  return (appConfig?.endpoints?.[EModelEndpoint.agents]?.capabilities ?? []).includes(
    AgentCapabilities.agent_builder,
  );
}

/** Writes exist only when the endpoint approval policy is on, so they can never run unreviewed. */
export function isAgentBuilderWriteEnabled(appConfig?: AppConfig): boolean {
  return (
    isAgentBuilderEnabled(appConfig) &&
    isHITLEnabled(appConfig?.endpoints?.[EModelEndpoint.agents]?.toolApproval)
  );
}

/** Adds the write tools to `ask`; the policy resolves deny > ask > allow, so an allow entry cannot skip review. */
export function requireAgentBuilderApproval(
  policy: TToolApprovalPolicy | undefined,
): TToolApprovalPolicy | undefined {
  if (!isHITLEnabled(policy)) {
    return policy;
  }
  const ask = policy.ask ?? [];
  const missing = AGENT_BUILDER_WRITE_TOOL_NAMES.filter((name) => !ask.includes(name));
  return missing.length === 0 ? policy : { ...policy, ask: [...ask, ...missing] };
}

/** Defers the suite unless `tool_options` already says otherwise for the marker. */
export function withAgentBuilderDeferral(
  toolOptions: AgentToolOptions | undefined,
): AgentToolOptions {
  const marker = toolOptions?.[AgentCapabilities.agent_builder];
  return {
    ...toolOptions,
    [AgentCapabilities.agent_builder]: { defer_loading: true, ...marker },
  };
}

const objectParam = (description: string) => ({
  type: 'object' as const,
  description,
  additionalProperties: true,
});

function getAgentBuilderToolDefinitions(includeWrites: boolean, programmatic: boolean): LCTool[] {
  const readCallers: LCTool['allowed_callers'] = programmatic ? ['code_execution'] : ['direct'];
  const reads: LCTool[] = [
    {
      name: LIST_AGENTS_TOOL_NAME,
      description: 'List agents you can access. Returns id, name, description, isEditable.',
      allowed_callers: readCallers,
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Filter by name or description' },
          limit: { type: 'integer', description: '1-100, default 20' },
          cursor: { type: 'string', description: '`after` from the previous page' },
        },
      },
    },
    {
      name: GET_AGENT_TOOL_NAME,
      description: 'Get one agent. Full configuration with edit access, basic info otherwise.',
      allowed_callers: readCallers,
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  ];
  if (!includeWrites) {
    return reads;
  }
  return [
    ...reads,
    {
      name: CREATE_AGENT_TOOL_NAME,
      description: 'Create an agent. Requires user approval. `config` needs provider and model.',
      allowed_callers: ['direct'],
      parameters: {
        type: 'object',
        properties: { config: objectParam('Agent fields, as in get_agent') },
        required: ['config'],
      },
    },
    {
      name: UPDATE_AGENT_TOOL_NAME,
      description: 'Update an agent. Requires user approval. Send only the changed fields.',
      allowed_callers: ['direct'],
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          patch: objectParam('Only the fields to change'),
        },
        required: ['id', 'patch'],
      },
    },
  ];
}

/** Idempotently registers the suite; mirrors `registerMemoryTools`. */
export function registerAgentBuilderTools({
  toolRegistry,
  toolDefinitions,
  includeWrites,
  programmatic,
}: {
  toolRegistry?: LCToolRegistry;
  toolDefinitions?: LCTool[];
  includeWrites: boolean;
  programmatic: boolean;
}): { toolDefinitions: LCTool[]; toolNames: string[] } {
  const defs = getAgentBuilderToolDefinitions(includeWrites, programmatic);
  const toolNames = defs.map((def) => def.name);
  const input = toolDefinitions ?? [];
  const added = defs.filter(
    (def) => toolRegistry?.has(def.name) !== true && !input.some((d) => d.name === def.name),
  );
  for (const def of added) {
    toolRegistry?.set(def.name, def);
  }
  return { toolDefinitions: added.length > 0 ? [...input, ...added] : input, toolNames };
}

interface RouteResult {
  status: number;
  body?: unknown;
}

/**
 * Replays a browser route chain against a scoped copy of the chat request, so each tool
 * inherits the route's role check, agent ACL, validation and filtering unchanged.
 * shortcut: assumes every middleware awaits its own work before calling `next`; true for
 * the agent routes today. Upgrade to a service API if a chain gains fire-and-forget steps.
 */
async function runRoute(
  chain: readonly AgentBuilderHandler[],
  req: Request,
  input: Pick<Request, 'params' | 'query' | 'body'>,
): Promise<RouteResult> {
  const scoped = Object.assign(Object.create(req) as Request, input);
  const result: RouteResult = { status: 200 };
  const capture = {
    status(code: number) {
      result.status = code;
      return capture;
    },
    json(body: unknown) {
      result.body = body;
      return capture;
    },
    send(body: unknown) {
      result.body = body;
      return capture;
    },
    setHeader() {
      return capture;
    },
  };
  const res = capture as unknown as Response;
  for (const handler of chain) {
    let advanced = false;
    let failure: unknown;
    await handler(scoped, res, (error?: unknown) => {
      advanced = true;
      failure = error;
    });
    if (failure != null) {
      return { status: 500 };
    }
    if (!advanced) {
      return result;
    }
  }
  return result;
}

const ERROR_CODES: Record<number, string> = {
  400: 'invalid_request',
  401: 'permission_denied',
  403: 'permission_denied',
  404: 'not_found',
  409: 'conflict',
};

/** Only 4xx validation bodies reach the model: they describe its own input. Server errors stay generic. */
function toToolError({ status, body }: RouteResult): string {
  const code = ERROR_CODES[status] ?? 'internal_error';
  return JSON.stringify(status === 400 ? { error: code, details: body } : { error: code });
}

const isOk = ({ status }: RouteResult) => status >= 200 && status < 300;

type AgentRecord = { id?: string; name?: string; description?: string; version?: number };
type AgentList = { data?: (AgentRecord & { isEditable?: boolean })[]; has_more?: boolean };

function summarize(body: unknown): string {
  const { id, name, version } = (body ?? {}) as AgentRecord;
  return JSON.stringify({ id, name, version });
}

function withoutInternals(body: unknown): string {
  const { _id, __v, versions: _versions, ...agent } = (body ?? {}) as Record<string, unknown>;
  return JSON.stringify(agent);
}

/**
 * Builds the runtime instance of one suite tool for the requesting user. Returns null when the
 * capability is off, or for a write when approval is off, so an unregistered call cannot run.
 */
export function createAgentBuilderTool({
  name,
  req,
  routes,
}: {
  name: string;
  req: Request & { config?: AppConfig };
  routes: AgentBuilderRoutes;
}): DynamicStructuredTool | null {
  if (!isAgentBuilderEnabled(req.config)) {
    return null;
  }
  const writesEnabled = isAgentBuilderWriteEnabled(req.config);
  const description = getAgentBuilderToolDefinitions(true, false).find(
    (def) => def.name === name,
  )?.description;

  if (name === LIST_AGENTS_TOOL_NAME) {
    return tool(
      async ({ search, limit, cursor }) => {
        const result = await runRoute(routes.list, req, {
          params: {},
          query: { search, limit: String(limit ?? 20), cursor },
          body: {},
        });
        if (!isOk(result)) {
          return toToolError(result);
        }
        const { data = [], has_more, after } = result.body as AgentList & { after?: string };
        return JSON.stringify({
          data: data.map(({ id, name, description, isEditable }) => ({
            id,
            name,
            description,
            isEditable,
          })),
          has_more,
          after,
        });
      },
      {
        name,
        description,
        schema: z.object({
          search: z.string().max(100).optional(),
          limit: z.number().int().min(1).max(100).optional(),
          cursor: z.string().max(512).optional(),
        }),
      },
    );
  }

  if (name === GET_AGENT_TOOL_NAME) {
    return tool(
      async ({ id }) => {
        const input = { params: { id }, query: {}, body: {} };
        const expanded = await runRoute(routes.getExpanded, req, input);
        const result = expanded.status === 403 ? await runRoute(routes.get, req, input) : expanded;
        return isOk(result) ? withoutInternals(result.body) : toToolError(result);
      },
      { name, description, schema: z.object({ id: z.string().min(1) }) },
    );
  }

  if (!writesEnabled) {
    return null;
  }

  if (name === CREATE_AGENT_TOOL_NAME) {
    return tool(
      async ({ config }) => {
        const result = await runRoute(routes.create, req, { params: {}, query: {}, body: config });
        return isOk(result) ? summarize(result.body) : toToolError(result);
      },
      { name, description, schema: z.object({ config: z.record(z.string(), z.unknown()) }) },
    );
  }

  if (name === UPDATE_AGENT_TOOL_NAME) {
    return tool(
      async ({ id, patch }) => {
        const result = await runRoute(routes.update, req, {
          params: { id },
          query: {},
          body: patch,
        });
        return isOk(result) ? summarize(result.body) : toToolError(result);
      },
      {
        name,
        description,
        schema: z.object({ id: z.string().min(1), patch: z.record(z.string(), z.unknown()) }),
      },
    );
  }

  return null;
}
