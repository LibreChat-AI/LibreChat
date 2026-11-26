/**
 * @fileoverview Agent Builder: the tools behind the `agent_builder` capability marker.
 *
 * An agent that carries the marker in `tools` gets the builder tools when the deployment
 * lists `agent_builder` in `endpoints.agents.capabilities`. Every call runs as the user who
 * sent the message, with the same checks as the agent side panel: `list_agents` reads through
 * the panel's listing ACL, and `get_agent` authorizes through `authorizeAgent`. Results send
 * only fixed fields and stable error codes to the model.
 *
 * @module packages/api/src/agents/builder
 */

import { z } from 'zod';
import { tool } from '@librechat/agents/langchain/tools';
import { logger, escapeRegExp } from '@librechat/data-schemas';
import {
  Permissions,
  PermissionBits,
  PermissionTypes,
  AgentCapabilities,
  AGENT_BUILDER_LIST_MAX_LIMIT,
  AGENT_BUILDER_LIST_DEFAULT_LIMIT,
} from 'librechat-data-provider';
import type { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import type { TAgentBuilderConfig } from 'librechat-data-provider';
import type { LCTool, LCToolRegistry } from '@librechat/agents';
import type { IRole } from '@librechat/data-schemas';
import type { AgentAccessRecord, AgentAccessUser, AuthorizeAgentDeps } from './access';
import type { AgentListAccessDeps } from './listing';
import type { ServerRequest } from '~/types';
import { AGENT_SORT_CURSOR_ERROR_CODE } from './marketplace';
import { getSafeErrorMetadata } from '~/utils/errors';
import { checkAccess } from '~/middleware/access';
import { toToolParameters } from '~/tools/schema';
import { getAgentListAccess } from './listing';
import { authorizeAgent } from './access';

export const AGENT_BUILDER_MARKER: AgentCapabilities.agent_builder =
  AgentCapabilities.agent_builder;
export const LIST_AGENTS_TOOL_NAME = 'list_agents';
export const GET_AGENT_TOOL_NAME = 'get_agent';

/** Same cap as the side panel's agent search. */
const MAX_SEARCH_LENGTH = 100;

/** Role permissions a read tool needs: the same `AGENTS.USE` the agent routes require. */
const READ_ROLE_PERMISSIONS: Permissions[] = [Permissions.USE];

/**
 * Builder tools are called by the model directly, never from code. Programmatic calls skip
 * the approval hook, so this stays the builder's own rule until `allowed_callers` becomes
 * shared per-tool policy.
 */
const BUILDER_ALLOWED_CALLERS: LCTool['allowed_callers'] = ['direct'];

export type AgentBuilderErrorCode = 'not_found' | 'forbidden' | 'invalid_cursor' | 'unavailable';

export type AgentBuilderResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: AgentBuilderErrorCode } };

export interface AgentBuilderUser extends AgentAccessUser {
  tenantId?: string;
  idOnTheSource?: string;
}

/** Stored agent fields the builder reads. `_id` is the ACL resource ID. */
export interface AgentBuilderAgent extends AgentAccessRecord {
  id: string;
  name?: string | null;
  description?: string | null;
  provider?: string | null;
  model?: string | null;
  instructions?: string | null;
  /** Set when the instructions come from a linked prompt. */
  instructionsPrompt?: object | null;
  tools?: string[] | null;
}

export interface AgentListPage {
  data: Array<{ id?: unknown; name?: unknown; description?: unknown }>;
  has_more: boolean;
  after: string | null;
}

export interface AgentBuilderDeps<U extends AgentBuilderUser = AgentBuilderUser>
  extends AuthorizeAgentDeps<AgentBuilderAgent, U>,
    AgentListAccessDeps<U> {
  /** The side panel's listing query (`getListAgentsByAccess`). */
  getListAgentsByAccess: (params: {
    accessibleIds: string[] | null;
    tenantId: string | null;
    otherParams?: Record<string, unknown>;
    limit: number;
    after: string | null;
  }) => Promise<AgentListPage>;
}

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
}

export interface AgentList {
  agents: AgentSummary[];
  /** Pass back as `cursor` for the next page; absent on the last page. */
  next_cursor?: string;
}

export type InstructionsSource = 'inline' | 'linked';

export interface AgentDetails extends AgentSummary {
  provider: string;
  model: string;
  instructions_source: InstructionsSource;
  instructions?: string;
  tools?: string[];
}

/** Page sizes for `list_agents`, from `endpoints.agents.agentBuilder.list`. */
export interface AgentBuilderListLimits {
  defaultLimit: number;
  maxLimit: number;
}

/** Resolves the configured limits. An omitted default page size is capped at `maxLimit`. */
export function resolveAgentBuilderLimits(
  config?: TAgentBuilderConfig | null,
): AgentBuilderListLimits {
  const maxLimit = config?.list?.maxLimit ?? AGENT_BUILDER_LIST_MAX_LIMIT;
  return {
    defaultLimit:
      config?.list?.defaultLimit ?? Math.min(AGENT_BUILDER_LIST_DEFAULT_LIMIT, maxLimit),
    maxLimit,
  };
}

export interface ListAgentsInput {
  search?: string;
  limit?: number;
  cursor?: string;
}

type AgentIncludeField = 'instructions' | 'tools';

export interface GetAgentInput {
  id: string;
  include?: AgentIncludeField[];
}

function createListAgentsSchema(limits: AgentBuilderListLimits): z.ZodType<ListAgentsInput> {
  return z.object({
    search: z
      .string()
      .max(MAX_SEARCH_LENGTH)
      .optional()
      .describe('Text to match in agent names and descriptions. Omit to list all agents.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(limits.maxLimit)
      .optional()
      .describe(`Page size, default ${limits.defaultLimit}.`),
    cursor: z.string().optional().describe('`next_cursor` from the previous page.'),
  });
}

const AGENT_INCLUDE_FIELDS: [AgentIncludeField, ...AgentIncludeField[]] = ['instructions', 'tools'];

const getAgentSchema: z.ZodType<GetAgentInput> = z.object({
  id: z.string().min(1).describe('Agent id, as returned by list_agents.'),
  include: z
    .array(z.enum(AGENT_INCLUDE_FIELDS))
    .optional()
    .describe('Large fields to add. Request only what the task needs.'),
});

function toSummary(agent: { id?: unknown; name?: unknown; description?: unknown }): AgentSummary {
  return {
    id: String(agent.id),
    name: typeof agent.name === 'string' ? agent.name : '',
    description: typeof agent.description === 'string' ? agent.description : '',
  };
}

/**
 * Lists the agents the user can view, through the same ACL read and listing query as the
 * side panel. An unreadable cursor is `invalid_cursor`, never a restart from page one.
 */
export async function listBuilderAgents<U extends AgentBuilderUser>(
  user: U,
  input: ListAgentsInput,
  deps: AgentBuilderDeps<U>,
  limits: AgentBuilderListLimits = resolveAgentBuilderLimits(),
): Promise<AgentBuilderResult<AgentList>> {
  const { accessibleIds } = await getAgentListAccess(user, PermissionBits.VIEW, deps);
  const search = input.search?.trim().slice(0, MAX_SEARCH_LENGTH);
  const pattern = search ? new RegExp(escapeRegExp(search), 'i') : undefined;
  let page: AgentListPage;
  try {
    page = await deps.getListAgentsByAccess({
      accessibleIds,
      tenantId: user.tenantId ?? null,
      otherParams: pattern ? { $or: [{ name: pattern }, { description: pattern }] } : undefined,
      limit: Math.min(input.limit ?? limits.defaultLimit, limits.maxLimit),
      after: input.cursor ?? null,
    });
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === AGENT_SORT_CURSOR_ERROR_CODE) {
      return { ok: false, error: { code: 'invalid_cursor' } };
    }
    throw error;
  }
  const value: AgentList = { agents: page.data.map(toSummary) };
  if (page.has_more && page.after) {
    value.next_cursor = page.after;
  }
  return { ok: true, value };
}

/** Loads each input at most once, so a second authorization reuses the first one's reads. */
function memoizeAccessReads<U extends AgentBuilderUser>(
  deps: AuthorizeAgentDeps<AgentBuilderAgent, U>,
): AuthorizeAgentDeps<AgentBuilderAgent, U> {
  let agent: Promise<AgentBuilderAgent | null> | undefined;
  let canManage: Promise<boolean> | undefined;
  return {
    getAgent: (agentId) => (agent ??= deps.getAgent(agentId)),
    hasCapability: (user, capability) => (canManage ??= deps.hasCapability(user, capability)),
    checkPermission: deps.checkPermission,
  };
}

function presentForEditor(
  agent: AgentBuilderAgent,
  include: GetAgentInput['include'],
): AgentDetails {
  const instructionsSource: InstructionsSource =
    agent.instructionsPrompt != null ? 'linked' : 'inline';
  const details: AgentDetails = {
    ...toSummary(agent),
    provider: agent.provider ?? '',
    model: agent.model ?? '',
    instructions_source: instructionsSource,
  };
  const fields = new Set(include ?? []);
  /** Linked instructions send no text and trigger no prompt lookup. */
  if (fields.has('instructions') && instructionsSource === 'inline') {
    details.instructions = agent.instructions ?? '';
  }
  if (fields.has('tools')) {
    details.tools = agent.tools ?? [];
  }
  return details;
}

/**
 * Reads one agent. EDIT access returns the editor view, with instructions and tools only
 * when `include` names them; VIEW-only access returns the summary, whatever `include` says.
 */
export async function getBuilderAgent<U extends AgentBuilderUser>(
  user: U,
  input: GetAgentInput,
  deps: AgentBuilderDeps<U>,
): Promise<AgentBuilderResult<AgentSummary | AgentDetails>> {
  const access = memoizeAccessReads(deps);
  const editable = await authorizeAgent({ user, agentId: input.id, required: 'EDIT' }, access);
  if (editable.ok) {
    return { ok: true, value: presentForEditor(editable.value.agent, input.include) };
  }
  if (editable.error.code === 'not_found') {
    return { ok: false, error: { code: 'not_found' } };
  }
  const viewable = await authorizeAgent({ user, agentId: input.id, required: 'VIEW' }, access);
  if (!viewable.ok) {
    return { ok: false, error: { code: viewable.error.code } };
  }
  return { ok: true, value: toSummary(viewable.value.agent) };
}

interface AgentBuilderToolSpec<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  schema: (limits: AgentBuilderListLimits) => S;
  rolePermissions: Permissions[];
  run: <U extends AgentBuilderUser>(
    user: U,
    input: z.infer<S>,
    deps: AgentBuilderDeps<U>,
    limits: AgentBuilderListLimits,
  ) => Promise<AgentBuilderResult<unknown>>;
}

function defineTool<S extends z.ZodTypeAny>(spec: AgentBuilderToolSpec<S>) {
  return spec as unknown as AgentBuilderToolSpec<z.ZodTypeAny>;
}

/** The builder tools in the order the model sees them. */
const AGENT_BUILDER_TOOLS: readonly AgentBuilderToolSpec<z.ZodTypeAny>[] = [
  defineTool({
    name: LIST_AGENTS_TOOL_NAME,
    description:
      'List the agents the user can view, newest first, as `{ id, name, description }`. ' +
      'Use `search` only when the user names or describes an agent. ' +
      'Pass `next_cursor` back as `cursor` for more.',
    schema: createListAgentsSchema,
    rolePermissions: READ_ROLE_PERMISSIONS,
    run: listBuilderAgents,
  }),
  defineTool({
    name: GET_AGENT_TOOL_NAME,
    description:
      'Read one agent by id. Agents the user can only view return `{ id, name, description }`. ' +
      'Agents the user can edit also return provider, model and `instructions_source`; ' +
      'add "instructions" or "tools" to `include` only when the task needs them. ' +
      'Linked instructions (`instructions_source: "linked"`) are not returned as text.',
    schema: () => getAgentSchema,
    rolePermissions: READ_ROLE_PERMISSIONS,
    run: getBuilderAgent,
  }),
];

const toolSpecs = new Map(AGENT_BUILDER_TOOLS.map((spec) => [spec.name, spec]));

export const AGENT_BUILDER_TOOL_NAMES: readonly string[] = AGENT_BUILDER_TOOLS.map(
  (spec) => spec.name,
);

export function isAgentBuilderToolName(name: string): boolean {
  return toolSpecs.has(name);
}

/** LLM-facing definitions for the builder tools. */
export function getAgentBuilderToolDefinitions(
  limits: AgentBuilderListLimits = resolveAgentBuilderLimits(),
): LCTool[] {
  return AGENT_BUILDER_TOOLS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    parameters: toToolParameters(spec.schema(limits)) as LCTool['parameters'],
    allowed_callers: BUILDER_ALLOWED_CALLERS,
  }));
}

/**
 * Expands the `agent_builder` marker into its tool definitions. A name already taken by
 * another registration is left alone. `toolNames` lists every builder tool, so marker-keyed
 * `tool_options` (deferral, intents) resolve onto them.
 */
export function registerAgentBuilderTools({
  toolRegistry,
  toolDefinitions,
  config,
}: {
  toolRegistry?: LCToolRegistry;
  toolDefinitions?: LCTool[];
  /** `endpoints.agents.agentBuilder` from the request's app config. */
  config?: TAgentBuilderConfig | null;
}): { toolDefinitions: LCTool[]; toolNames: string[] } {
  const inputDefinitions = toolDefinitions ?? [];
  const taken = new Set(inputDefinitions.map((def) => def.name));
  const added: LCTool[] = [];
  for (const def of getAgentBuilderToolDefinitions(resolveAgentBuilderLimits(config))) {
    if (taken.has(def.name) || toolRegistry?.has(def.name) === true) {
      continue;
    }
    toolRegistry?.set(def.name, def);
    added.push(def);
  }
  return {
    toolDefinitions: added.length > 0 ? [...inputDefinitions, ...added] : inputDefinitions,
    toolNames: [...AGENT_BUILDER_TOOL_NAMES],
  };
}

/** Maps a result to the text the model receives: the value, or only the error code. */
export function formatAgentBuilderResult(result: AgentBuilderResult<unknown>): string {
  return JSON.stringify(result.ok ? result.value : { error: { code: result.error.code } });
}

/** Creates the runtime tool for one builder tool name, bound to the calling user. */
export function createAgentBuilderTool<U extends AgentBuilderUser>({
  toolName,
  user,
  deps,
  limits = resolveAgentBuilderLimits(),
}: {
  toolName: string;
  user: U;
  deps: AgentBuilderDeps<U>;
  limits?: AgentBuilderListLimits;
}): DynamicStructuredTool | null {
  const spec = toolSpecs.get(toolName);
  if (!spec) {
    return null;
  }
  return tool(
    async (input: unknown) => {
      try {
        return formatAgentBuilderResult(await spec.run(user, input, deps, limits));
      } catch (error) {
        logger.error(`[agentBuilder] ${toolName} failed`, getSafeErrorMetadata(error));
        return formatAgentBuilderResult({ ok: false, error: { code: 'unavailable' } });
      }
    },
    { name: spec.name, description: spec.description, schema: spec.schema(limits) },
  ) as DynamicStructuredTool;
}

/**
 * Builds a builder tool for the event-driven executor. The tool must be in the run's
 * registry, which initialization fills only when the agent carries the marker and the
 * loader allowed it. The capability and the role permission are checked again here.
 * Returns null when any check fails.
 */
export async function buildAgentBuilderTool({
  toolName,
  req,
  toolRegistry,
  capabilityEnabled,
  getRoleByName,
  deps,
}: {
  toolName: string;
  req: ServerRequest;
  /** The executing agent's registry from initialization. */
  toolRegistry?: LCToolRegistry;
  /** Whether `agent_builder` is in the run's enabled agent capabilities. */
  capabilityEnabled: () => Promise<boolean>;
  getRoleByName: (roleName: string, fieldsToSelect?: string | string[]) => Promise<IRole | null>;
  deps: AgentBuilderDeps<AgentBuilderUser>;
}): Promise<DynamicStructuredTool | null> {
  const spec = toolSpecs.get(toolName);
  const user = req.user;
  if (!spec || !user?.id || toolRegistry?.has(toolName) !== true) {
    return null;
  }
  if (!(await capabilityEnabled())) {
    return null;
  }
  let allowed = false;
  try {
    allowed = await checkAccess({
      user,
      permissionType: PermissionTypes.AGENTS,
      permissions: spec.rolePermissions,
      getRoleByName,
    });
  } catch (error) {
    logger.error('[agentBuilder] Role permission check failed', getSafeErrorMetadata(error));
  }
  if (!allowed) {
    return null;
  }
  const builderUser: AgentBuilderUser = {
    id: user.id,
    role: user.role,
    tenantId: user.tenantId,
    idOnTheSource: user.idOnTheSource,
  };
  const limits = resolveAgentBuilderLimits(req.config?.endpoints?.agents?.agentBuilder);
  return createAgentBuilderTool({ toolName, user: builderUser, deps, limits });
}

/** Methods the tool loader supplies to build builder tools. */
export interface AgentBuilderLoaderDeps
  extends Omit<AgentBuilderDeps<AgentBuilderUser>, 'getAgent'> {
  /** The agent model's lookup by filter (`getAgent({ id })`). */
  getAgent: (filter: { id: string }) => Promise<AgentBuilderAgent | null>;
  getRoleByName: (roleName: string, fieldsToSelect?: string | string[]) => Promise<IRole | null>;
  /** Whether a capability is in the request's enabled agent capabilities. */
  checkCapability: (req: ServerRequest, capability: AgentCapabilities) => Promise<boolean>;
}

/** A deferred builder-tool constructor, in the shape `loadTools` collects per tool name. */
export type AgentBuilderToolFactory = () => Promise<DynamicStructuredTool | null>;

/**
 * Creates the tool loader's dispatch for builder tool names. The returned function gives
 * a factory for a builder tool name and null for any other name, so the loader can fall
 * through to its other constructors.
 */
export function createAgentBuilderToolResolver({
  getAgent,
  getRoleByName,
  checkCapability,
  ...access
}: AgentBuilderLoaderDeps): (params: {
  tool: string;
  req?: ServerRequest;
  toolRegistry?: LCToolRegistry;
}) => AgentBuilderToolFactory | null {
  const deps: AgentBuilderDeps<AgentBuilderUser> = {
    ...access,
    getAgent: (agentId) => getAgent({ id: agentId }),
  };
  return ({ tool: toolName, req, toolRegistry }) => {
    if (!isAgentBuilderToolName(toolName)) {
      return null;
    }
    return async () => {
      if (!req) {
        return null;
      }
      return buildAgentBuilderTool({
        toolName,
        req,
        toolRegistry,
        capabilityEnabled: () => checkCapability(req, AGENT_BUILDER_MARKER),
        getRoleByName,
        deps,
      });
    };
  };
}

/** Capability gate for the marker, spread into the tool service's role-gate map. */
export const AGENT_BUILDER_CAPABILITY_GATES: Readonly<Record<string, AgentCapabilities>> = {
  [AGENT_BUILDER_MARKER]: AGENT_BUILDER_MARKER,
};

/**
 * Filters an agent's configured tools for loading. The `agent_builder` marker stays when
 * the capability is enabled and the role may use it; every other tool goes to `filter`.
 * Order is kept. `agentBuilderEnabled` tells initialization to register the builder tools.
 */
export function resolveAgentBuilderTools({
  tools,
  checkCapability,
  canUseTool,
  filter,
}: {
  tools?: string[] | null;
  /** The loader's capability check, which logs a disabled capability. */
  checkCapability: (capability: AgentCapabilities) => boolean;
  /** The resolved role grants (`resolveAgentToolPermissions`). */
  canUseTool: (tool: string) => boolean;
  /** The loader's decision for every tool other than the marker. */
  filter: (tool: string) => boolean;
}): { tools: string[] | undefined; agentBuilderEnabled: boolean } {
  let agentBuilderEnabled = false;
  const kept = tools?.filter((tool) => {
    if (tool !== AGENT_BUILDER_MARKER) {
      return filter(tool);
    }
    const allowed = checkCapability(AGENT_BUILDER_MARKER) && canUseTool(tool);
    agentBuilderEnabled ||= allowed;
    return allowed;
  });
  return { tools: kept, agentBuilderEnabled };
}
