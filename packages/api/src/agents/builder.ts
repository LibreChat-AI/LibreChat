/**
 * @fileoverview Agent Builder: the tools behind the `agent_builder` capability marker.
 *
 * An agent that carries the marker in `tools` gets the builder tools when the deployment
 * lists `agent_builder` in `endpoints.agents.capabilities`. Every call runs as the user who
 * sent the message, with the same checks as the agent side panel: `list_agents` reads through
 * the panel's listing ACL, `get_agent` authorizes through `authorizeAgent`, and `create_agent`
 * saves through `createAgent`, the panel's create service. Write tools are offered only for the
 * operations `endpoints.agents.agentBuilder` lists, with a schema of the listed fields. Results
 * send only fixed fields, stable error codes and safe details to the model.
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
  AGENT_BUILDER_FIELDS,
  CREATE_AGENT_TOOL_NAME,
  AGENT_BUILDER_LIST_MAX_LIMIT,
  AGENT_BUILDER_LIST_DEFAULT_LIMIT,
  AGENT_BUILDER_CREATE_REQUIRED_FIELDS,
} from 'librechat-data-provider';
import type { AgentBuilderField, TAgentBuilderConfig } from 'librechat-data-provider';
import type { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import type { LCTool, LCToolRegistry } from '@librechat/agents';
import type { IRole } from '@librechat/data-schemas';
import type { AgentAccessRecord, AgentAccessUser, AuthorizeAgentDeps } from './access';
import type { CheckAccessParams } from '~/middleware/access';
import type { AgentListAccessDeps } from './listing';
import type { ServerRequest } from '~/types';
import { checkAccess, checkAccessWithRequestCache } from '~/middleware/access';
import { AGENT_SORT_CURSOR_ERROR_CODE } from './marketplace';
import { getSafeErrorMetadata } from '~/utils/errors';
import { toToolParameters } from '~/tools/schema';
import { getAgentListAccess } from './listing';
import { authorizeAgent } from './access';

export const AGENT_BUILDER_MARKER: AgentCapabilities.agent_builder =
  AgentCapabilities.agent_builder;
export const LIST_AGENTS_TOOL_NAME = 'list_agents';
export const GET_AGENT_TOOL_NAME = 'get_agent';

/** Same cap as the side panel's agent search. */
const MAX_SEARCH_LENGTH = 100;

/** Most names a refusal lists back to the model. */
const MAX_DETAIL_NAMES = 20;

/** Role permissions a read tool needs: the same `AGENTS.USE` the agent routes require. */
const READ_ROLE_PERMISSIONS: Permissions[] = [Permissions.USE];
/** Role permissions `create_agent` needs: the same as the panel's create route. */
const CREATE_ROLE_PERMISSIONS: Permissions[] = [Permissions.USE, Permissions.CREATE];

/**
 * Builder tools are called by the model directly, never from code. Programmatic calls skip
 * the approval hook, so writes must stay direct-only; this stays the builder's own rule until
 * `allowed_callers` becomes shared per-tool policy.
 */
const BUILDER_ALLOWED_CALLERS: LCTool['allowed_callers'] = ['direct'];

/** A write operation `endpoints.agents.agentBuilder` can list. */
export type AgentBuilderOperation = 'create';

/** The fields each offered write operation may set. An absent operation is not offered. */
export type AgentBuilderWrites = Partial<
  Record<AgentBuilderOperation, readonly AgentBuilderField[]>
>;

export type AgentBuilderErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'invalid_cursor'
  | 'unavailable'
  /** The call sets a field the admin did not list for the operation. */
  | 'field_not_allowed'
  /** A builder tool may not attach the Agent Builder to an agent. */
  | 'agent_builder_not_allowed';

/** Safe details: names the model sent, never stored data or error text. */
export interface AgentBuilderErrorDetails {
  fields?: string[];
  tools?: string[];
}

export interface AgentBuilderError {
  /** A builder code, or the stable code a save service refused with. */
  code: AgentBuilderErrorCode | AgentBuilderSaveRefusal['code'];
  details?: AgentBuilderErrorDetails;
}

/**
 * A refusal from the save service (`createAgent`). `invalid_request` carries zod issues;
 * only their top-level paths reach the model.
 */
export interface AgentBuilderSaveRefusal {
  code: string;
  details?: unknown;
}

/** What the builder reads from the save service's result. */
export type AgentBuilderSaveResult =
  | { ok: true; value: { id: string; name?: string | null; tools?: string[] | null } }
  | { ok: false; error: AgentBuilderSaveRefusal };

export type AgentBuilderResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AgentBuilderError };

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

export interface AgentBuilderWriteDeps {
  /** `createAgent` bound to the calling request's user, config and collaborators. */
  createAgent: (input: AgentBuilderWriteInput) => Promise<AgentBuilderSaveResult>;
}

export interface AgentBuilderDeps<U extends AgentBuilderUser = AgentBuilderUser>
  extends AuthorizeAgentDeps<AgentBuilderAgent, U>,
    AgentListAccessDeps<U>,
    AgentBuilderWriteDeps {
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

/** Agent fields a write tool sets, as validated against the listed fields. */
export interface AgentBuilderWriteInput {
  name?: string;
  description?: string;
  instructions?: string;
  provider?: string;
  model?: string;
  tools?: string[];
}

export interface AgentBuilderCreatedAgent {
  id: string;
  name: string;
  /** Requested tools the user may not attach; the agent was saved without them. */
  unavailable_tools?: string[];
}

const AGENT_BUILDER_FIELD_SCHEMAS: Record<AgentBuilderField, z.ZodTypeAny> = {
  name: z.string().min(1).describe('Display name.'),
  description: z.string().describe('One or two sentences on what the agent is for.'),
  instructions: z.string().describe('System instructions the agent follows.'),
  provider: z
    .string()
    .min(1)
    .describe('Endpoint the agent runs on, in the form `get_agent` returns it.'),
  model: z.string().min(1).describe('Model name on that endpoint.'),
  tools: z
    .array(z.string().min(1))
    .describe('Tool ids to attach. Ids the user may not use come back as `unavailable_tools`.'),
};

/**
 * Builds the strict schema of a write tool from the fields the admin listed, in the order of
 * `AGENT_BUILDER_FIELDS`. Listed `required` fields are required; the others are optional.
 */
export function buildAgentBuilderWriteSchema(
  fields: readonly AgentBuilderField[],
  required: readonly AgentBuilderField[] = [],
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of AGENT_BUILDER_FIELDS) {
    if (!fields.includes(field)) {
      continue;
    }
    const schema = AGENT_BUILDER_FIELD_SCHEMAS[field];
    shape[field] = required.includes(field) ? schema : schema.optional();
  }
  return z.object(shape).strict();
}

/** Builder tool names and the marker: no builder tool may attach these to an agent. */
function getBuilderToolNames(tools: readonly string[] | undefined): string[] {
  return (tools ?? []).filter((name) => name === AGENT_BUILDER_MARKER || toolSpecs.has(name));
}

function limitNames(names: Iterable<string>): string[] {
  return [...new Set(names)].slice(0, MAX_DETAIL_NAMES);
}

/**
 * Checks a write call against the fields the admin listed. A key outside `fields` is
 * `field_not_allowed` and nothing is dropped; a wrong type is `invalid_request`; adding the
 * Agent Builder to an agent is `agent_builder_not_allowed`. Details name only the offending
 * keys or tool ids from the call.
 */
export function checkAgentBuilderWrite(
  input: unknown,
  fields: readonly AgentBuilderField[],
  required: readonly AgentBuilderField[] = [],
): AgentBuilderResult<AgentBuilderWriteInput> {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: { code: 'invalid_request' } };
  }
  const allowed = new Set<string>(fields);
  const unlisted = Object.keys(input).filter((key) => !allowed.has(key));
  if (unlisted.length > 0) {
    return {
      ok: false,
      error: { code: 'field_not_allowed', details: { fields: limitNames(unlisted) } },
    };
  }
  const parsed = buildAgentBuilderWriteSchema(fields, required).safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: toInvalidRequest(parsed.error.issues) };
  }
  const value = parsed.data as AgentBuilderWriteInput;
  const builderTools = getBuilderToolNames(value.tools);
  if (builderTools.length > 0) {
    return {
      ok: false,
      error: { code: 'agent_builder_not_allowed', details: { tools: limitNames(builderTools) } },
    };
  }
  return { ok: true, value };
}

/** Names only the top-level fields at fault, never the values or messages. */
function toInvalidRequest(issues: unknown): AgentBuilderError {
  const fields = (Array.isArray(issues) ? issues : [])
    .map((issue: { path?: unknown } | null) => (Array.isArray(issue?.path) ? issue.path[0] : null))
    .filter((key): key is string => typeof key === 'string');
  return fields.length > 0
    ? { code: 'invalid_request', details: { fields: limitNames(fields) } }
    : { code: 'invalid_request' };
}

/** Maps a save refusal to its code; validation refusals also name the fields. */
function toBuilderError(error: AgentBuilderSaveRefusal): AgentBuilderError {
  if (error.code === 'invalid_request') {
    return toInvalidRequest(error.details);
  }
  return { code: error.code };
}

/**
 * Creates an agent through `createAgent`, the side panel's create service, so the call gets
 * the panel's validation, tool authorization, content filters, workspace rules and owner
 * grants. The agent is private to the user who sent the message.
 */
export async function createBuilderAgent(
  input: unknown,
  fields: readonly AgentBuilderField[],
  deps: AgentBuilderWriteDeps,
): Promise<AgentBuilderResult<AgentBuilderCreatedAgent>> {
  const checked = checkAgentBuilderWrite(input, fields, AGENT_BUILDER_CREATE_REQUIRED_FIELDS);
  if (!checked.ok) {
    return checked;
  }
  const result = await deps.createAgent(checked.value);
  if (!result.ok) {
    return { ok: false, error: toBuilderError(result.error) };
  }
  const saved = new Set(result.value.tools ?? []);
  const created: AgentBuilderCreatedAgent = { id: result.value.id, name: result.value.name ?? '' };
  const unavailable = (checked.value.tools ?? []).filter((tool) => !saved.has(tool));
  if (unavailable.length > 0) {
    created.unavailable_tools = limitNames(unavailable);
  }
  return { ok: true, value: created };
}

/** What a builder tool's schema and run take from the request's config. */
export interface AgentBuilderToolContext {
  limits: AgentBuilderListLimits;
  /** The fields a write tool may set; empty for a read tool. */
  fields: readonly AgentBuilderField[];
}

interface AgentBuilderToolSpec {
  name: string;
  description: string;
  rolePermissions: Permissions[];
  /** The write operation the tool performs. Read tools have none and are always offered. */
  operation?: AgentBuilderOperation;
  /** The model-facing schema. A write tool's schema holds only the listed fields. */
  schema: (context: AgentBuilderToolContext) => z.ZodTypeAny;
  run: <U extends AgentBuilderUser>(
    user: U,
    input: unknown,
    deps: AgentBuilderDeps<U>,
    context: AgentBuilderToolContext,
  ) => Promise<AgentBuilderResult<unknown>>;
}

/**
 * A write tool takes any object at run time and checks it in `run`, so an unlisted field is
 * refused with `field_not_allowed` instead of being stripped or failing schema parsing.
 */
const writeRuntimeSchema = z.object({}).passthrough();

/** The builder tools in the order the model sees them. */
const AGENT_BUILDER_TOOLS: readonly AgentBuilderToolSpec[] = [
  {
    name: LIST_AGENTS_TOOL_NAME,
    description:
      'List the agents the user can view, newest first, as `{ id, name, description }`. ' +
      'Use `search` only when the user names or describes an agent. ' +
      'Pass `next_cursor` back as `cursor` for more.',
    schema: ({ limits }) => createListAgentsSchema(limits),
    rolePermissions: READ_ROLE_PERMISSIONS,
    run: (user, input, deps, { limits }) =>
      listBuilderAgents(user, input as ListAgentsInput, deps, limits),
  },
  {
    name: GET_AGENT_TOOL_NAME,
    description:
      'Read one agent by id. Agents the user can only view return `{ id, name, description }`. ' +
      'Agents the user can edit also return provider, model and `instructions_source`; ' +
      'add "instructions" or "tools" to `include` only when the task needs them. ' +
      'Linked instructions (`instructions_source: "linked"`) are not returned as text.',
    schema: () => getAgentSchema,
    rolePermissions: READ_ROLE_PERMISSIONS,
    run: (user, input, deps) => getBuilderAgent(user, input as GetAgentInput, deps),
  },
  {
    name: CREATE_AGENT_TOOL_NAME,
    description:
      'Create a new agent owned by the user, with the same checks as saving it in the agent ' +
      'panel. Only the user can see it until they share it from the panel. Set only the ' +
      'fields in this schema. Returns `{ id, name }`; `unavailable_tools` lists requested ' +
      'tools the user may not attach. Never attach `agent_builder`.',
    operation: 'create',
    schema: ({ fields }) =>
      buildAgentBuilderWriteSchema(fields, AGENT_BUILDER_CREATE_REQUIRED_FIELDS),
    rolePermissions: CREATE_ROLE_PERMISSIONS,
    run: (_user, input, deps, { fields }) => createBuilderAgent(input, fields, deps),
  },
];

const toolSpecs = new Map(AGENT_BUILDER_TOOLS.map((spec) => [spec.name, spec]));

export const AGENT_BUILDER_TOOL_NAMES: readonly string[] = AGENT_BUILDER_TOOLS.map(
  (spec) => spec.name,
);

export function isAgentBuilderToolName(name: string): boolean {
  return toolSpecs.has(name);
}

/** The fields an operation may set under this config, or `undefined` when it is not listed. */
export function getAgentBuilderFields(
  config: TAgentBuilderConfig | undefined,
  operation: AgentBuilderOperation,
): readonly AgentBuilderField[] | undefined {
  return config?.[operation]?.fields;
}

/** The spec's fields under `writes`; `undefined` when it is a write tool that is not offered. */
function getOfferedFields(
  spec: AgentBuilderToolSpec,
  writes: AgentBuilderWrites,
): readonly AgentBuilderField[] | undefined {
  return spec.operation ? writes[spec.operation] : [];
}

/**
 * LLM-facing definitions for the builder tools: the read tools, plus each write tool whose
 * operation `writes` lists, with a schema of only its listed fields.
 */
export function getAgentBuilderToolDefinitions(
  limits: AgentBuilderListLimits = resolveAgentBuilderLimits(),
  writes: AgentBuilderWrites = {},
): LCTool[] {
  const definitions: LCTool[] = [];
  for (const spec of AGENT_BUILDER_TOOLS) {
    const fields = getOfferedFields(spec, writes);
    if (!fields) {
      continue;
    }
    definitions.push({
      name: spec.name,
      description: spec.description,
      parameters: toToolParameters(spec.schema({ limits, fields })) as LCTool['parameters'],
      allowed_callers: BUILDER_ALLOWED_CALLERS,
    });
  }
  return definitions;
}

/**
 * Resolves the write operations to offer one user: those the config lists, when the role
 * also has what the operation's tool needs. A failed role read offers no write tool.
 */
export async function resolveAgentBuilderWrites({
  config,
  req,
  user,
  getRoleByName,
}: {
  config: TAgentBuilderConfig | undefined;
  req?: CheckAccessParams['req'];
  user?: CheckAccessParams['user'] | null;
  getRoleByName?: CheckAccessParams['getRoleByName'];
}): Promise<AgentBuilderWrites> {
  const writes: AgentBuilderWrites = {};
  const createFields = getAgentBuilderFields(config, 'create');
  if (!createFields || !user || !getRoleByName) {
    return writes;
  }
  try {
    const canCreate = await checkAccessWithRequestCache({
      req,
      user,
      permissionType: PermissionTypes.AGENTS,
      permissions: CREATE_ROLE_PERMISSIONS,
      getRoleByName,
    });
    if (canCreate) {
      writes.create = createFields;
    }
  } catch (error) {
    logger.error('[agentBuilder] Role permission check failed', getSafeErrorMetadata(error));
  }
  return writes;
}

/**
 * Expands the `agent_builder` marker into its tool definitions. A name already taken by
 * another registration is left alone. `toolNames` lists the builder tools offered, so
 * marker-keyed `tool_options` (deferral, intents) resolve onto them.
 */
export function registerAgentBuilderTools({
  toolRegistry,
  toolDefinitions,
  config,
  writes,
}: {
  toolRegistry?: LCToolRegistry;
  toolDefinitions?: LCTool[];
  /** `endpoints.agents.agentBuilder` from the request's app config. */
  config?: TAgentBuilderConfig | null;
  /** Write operations to offer; see {@link resolveAgentBuilderWrites}. None by default. */
  writes?: AgentBuilderWrites;
}): { toolDefinitions: LCTool[]; toolNames: string[] } {
  const inputDefinitions = toolDefinitions ?? [];
  const taken = new Set(inputDefinitions.map((def) => def.name));
  const added: LCTool[] = [];
  const offered = getAgentBuilderToolDefinitions(resolveAgentBuilderLimits(config), writes);
  for (const def of offered) {
    if (taken.has(def.name) || toolRegistry?.has(def.name) === true) {
      continue;
    }
    toolRegistry?.set(def.name, def);
    added.push(def);
  }
  return {
    toolDefinitions: added.length > 0 ? [...inputDefinitions, ...added] : inputDefinitions,
    toolNames: offered.map((def) => def.name),
  };
}

/** Maps a result to the text the model receives: the value, or the error code and safe details. */
export function formatAgentBuilderResult(result: AgentBuilderResult<unknown>): string {
  if (result.ok) {
    return JSON.stringify(result.value);
  }
  const { code, details } = result.error;
  return JSON.stringify({ error: details ? { code, details } : { code } });
}

/** Creates the runtime tool for one builder tool name, bound to the calling user. */
export function createAgentBuilderTool<U extends AgentBuilderUser>({
  toolName,
  user,
  deps,
  writes = {},
  limits = resolveAgentBuilderLimits(),
}: {
  toolName: string;
  user: U;
  deps: AgentBuilderDeps<U>;
  /** Write operations this call may perform. A write tool not listed here is not created. */
  writes?: AgentBuilderWrites;
  limits?: AgentBuilderListLimits;
}): DynamicStructuredTool | null {
  const spec = toolSpecs.get(toolName);
  const fields = spec ? getOfferedFields(spec, writes) : undefined;
  if (!spec || !fields) {
    return null;
  }
  const context: AgentBuilderToolContext = { limits, fields };
  return tool(
    async (input: unknown) => {
      try {
        return formatAgentBuilderResult(await spec.run(user, input, deps, context));
      } catch (error) {
        logger.error(`[agentBuilder] ${toolName} failed`, getSafeErrorMetadata(error));
        return formatAgentBuilderResult({ ok: false, error: { code: 'unavailable' } });
      }
    },
    {
      name: spec.name,
      description: spec.description,
      schema: spec.operation ? writeRuntimeSchema : spec.schema(context),
    },
  ) as DynamicStructuredTool;
}

/**
 * Builds a builder tool for the event-driven executor. The tool must be in the run's
 * registry, which initialization fills only when the agent carries the marker and the
 * loader allowed it. The capability, the role permission and, for a write tool, the listed
 * operation in `req.config` are checked again here. Returns null when any check fails.
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
  deps: AgentBuilderRequestDeps;
}): Promise<DynamicStructuredTool | null> {
  const spec = toolSpecs.get(toolName);
  const user = req.user;
  if (!spec || !user?.id || toolRegistry?.has(toolName) !== true) {
    return null;
  }
  const config = req.config?.endpoints?.agents?.agentBuilder;
  const writes: AgentBuilderWrites = {};
  if (spec.operation) {
    const fields = getAgentBuilderFields(config, spec.operation);
    if (!fields) {
      return null;
    }
    writes[spec.operation] = fields;
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
  return createAgentBuilderTool({
    toolName,
    user: builderUser,
    writes,
    limits: resolveAgentBuilderLimits(config),
    deps: { ...deps, createAgent: (input) => deps.createAgent(req, input) },
  });
}

/** Builder deps whose `createAgent` still takes the request; it is bound per request. */
export type AgentBuilderRequestDeps = Omit<AgentBuilderDeps<AgentBuilderUser>, 'createAgent'> & {
  createAgent: (
    req: ServerRequest,
    input: AgentBuilderWriteInput,
  ) => Promise<AgentBuilderSaveResult>;
};

/** Methods the tool loader supplies to build builder tools. */
export interface AgentBuilderLoaderDeps extends Omit<AgentBuilderRequestDeps, 'getAgent'> {
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
  const deps: AgentBuilderRequestDeps = {
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
