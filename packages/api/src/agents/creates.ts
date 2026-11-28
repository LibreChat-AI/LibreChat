import { z } from 'zod';
import { nanoid } from 'nanoid';
import { logger } from '@librechat/data-schemas';
import {
  Tools,
  Constants,
  Permissions,
  ResourceType,
  AccessRoleIds,
  PrincipalType,
  EModelEndpoint,
  PermissionTypes,
  AgentCapabilities,
  removeNullishValues,
  removeCodeExecutionCaller,
} from 'librechat-data-provider';
import type {
  Agent,
  GraphEdge,
  AgentToolResources,
  AgentSubagentsConfig,
} from 'librechat-data-provider';
import type { AppConfig, IRole, IUser } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type {
  InstructionsPromptAccess,
  InstructionsPromptAccessUser,
  InstructionsPromptAccessRequest,
} from './instructions/access';
import type {
  GetAgentContentFiles,
  AgentContentCheckInput,
  AgentContentFilterError,
} from './content';
import type { InstructionsPromptLinkErrorResponse } from './instructions/errors';
import type { AgentManagementProjectionSource } from './management';
import type { AgentCodeEnvironmentError } from './workspace';
import {
  agentManagementCreateSchema,
  mapAgentManagementError,
  projectAgentManagementResponse,
} from './management';
import { agentCodeEnvironmentErrorResponse, validateStatefulCodeEnvironment } from './workspace';
import { instructionsContentForScan, checkInstructionsPromptWrite } from './instructions/writes';
import { checkAgentContent, agentContentFilterErrorResponse } from './content';
import { checkAccessWithRequestCache } from '../middleware/access';
import { normalizeToolResourceFiles } from './orphans';
import { getSafeErrorMetadata } from '~/utils/errors';
import { getAgentRouteErrorResponse } from './errors';
import { validateHandoffReferences } from './specs';
import { applyAgentInferenceInput } from './input';
import { applySdkAgentBindingWrite } from './sdk';
import { agentCreateSchema } from './validation';
import { replaceEdgeSourceId } from './edges';

/** Saved agents an agent definition references, split by why each one is refused. */
export interface AgentReferenceCheck {
  missing: string[];
  unauthorized: string[];
}

export type AgentReferenceErrorCode =
  | 'edge_agents_missing'
  | 'edge_agents_forbidden'
  | 'subagent_agents_missing'
  | 'subagent_agents_forbidden';

export interface AgentReferenceError {
  code: AgentReferenceErrorCode;
  details: { agent_ids: string[] };
}

const AGENT_REFERENCE_ERRORS: Record<
  AgentReferenceErrorCode,
  { status: 400 | 403; message: string }
> = {
  edge_agents_missing: {
    status: 400,
    message: 'One or more agents referenced in edges do not exist',
  },
  edge_agents_forbidden: {
    status: 403,
    message: 'You do not have access to one or more agents referenced in edges',
  },
  subagent_agents_missing: {
    status: 400,
    message: 'One or more agents referenced in subagents do not exist',
  },
  subagent_agents_forbidden: {
    status: 403,
    message: 'You do not have access to one or more agents referenced in subagents',
  },
};

/** Missing references are reported before inaccessible ones. Returns `null` when all resolve. */
export function getAgentReferenceError(
  kind: 'edge' | 'subagent',
  { missing, unauthorized }: AgentReferenceCheck,
): AgentReferenceError | null {
  if (missing.length > 0) {
    return { code: `${kind}_agents_missing`, details: { agent_ids: missing } };
  }
  if (unauthorized.length > 0) {
    return { code: `${kind}_agents_forbidden`, details: { agent_ids: unauthorized } };
  }
  return null;
}

/** Maps a refused agent reference to the HTTP status and body the agent routes send. */
export function agentReferenceErrorResponse(error: AgentReferenceError): {
  status: 400 | 403;
  body: { error: string; agent_ids: string[] };
} {
  const { status, message } = AGENT_REFERENCE_ERRORS[error.code];
  return { status, body: { error: message, agent_ids: error.details.agent_ids } };
}

/** Maps a reference check to the response the agent routes send, or `null` when all resolve. */
export function getAgentReferenceErrorResponse(
  kind: 'edge' | 'subagent',
  check: AgentReferenceCheck | null,
): ReturnType<typeof agentReferenceErrorResponse> | null {
  const error = check && getAgentReferenceError(kind, check);
  return error ? agentReferenceErrorResponse(error) : null;
}

/**
 * Expected refusals of `createAgent`, by stable code. Code-environment, content-filter and
 * reference refusals keep the codes of the helpers that produce them.
 */
export type CreateAgentError =
  | { code: 'invalid_request'; details: z.ZodIssue[] }
  | { code: 'instructions_prompt_rejected'; details: InstructionsPromptLinkErrorResponse }
  | AgentCodeEnvironmentError
  | AgentContentFilterError
  | AgentReferenceError;

/** A saved agent as a plain record with string ids, as the creation service returns it. */
export type CreatedAgent = Omit<Agent, '_id' | 'created_at'> & {
  _id: string;
  tenantId?: string;
  mcpServerNames?: string[];
  versions?: object[];
  createdAt?: Date;
  updatedAt?: Date;
};

/** An id the store returns that renders as its string form, such as a driver object id. */
type StoredAgentId = string | { toString(): string };

/**
 * Converts the record the agent store saved into a `CreatedAgent`. Only the ids change,
 * to the strings they serialize as, so a JSON response of the record is unchanged.
 */
export function toCreatedAgent(agent: {
  _id: StoredAgentId;
  author?: StoredAgentId | null;
}): CreatedAgent {
  return {
    ...agent,
    _id: String(agent._id),
    ...(agent.author != null && { author: String(agent.author) }),
  } as CreatedAgent;
}

export type CreateAgentResult =
  | { ok: true; value: CreatedAgent }
  | { ok: false; error: CreateAgentError };

/** Grant input accepted by `PermissionService.grantPermission`. */
export interface CreateAgentGrant {
  principalType: PrincipalType;
  principalId: string;
  resourceType: ResourceType;
  resourceId: string;
  accessRoleId: AccessRoleIds;
  grantedBy: string;
}

/** Request-bound collaborators supplied by the caller; this module reads no app state. */
export interface CreateAgentDeps {
  /** Saves the agent; the caller adapts the stored record with `toCreatedAgent`. */
  createAgent: (agentData: Record<string, unknown>) => Promise<CreatedAgent>;
  getFiles: GetAgentContentFiles;
  /** Removes tool-resource file IDs the owner cannot attach and that are not already on
   *  `existingToolResources`. Mutates `tool_resources`. */
  pruneToolResourceFileIds: (params: {
    tool_resources: AgentToolResources;
    ownerIds: string;
    existingToolResources?: AgentToolResources;
    logPrefix: string;
  }) => Promise<number>;
  /** Rewrites a subagent graph self-reference and returns the validated config. */
  replaceSubagentGraphAgentId: (
    subagents: AgentSubagentsConfig | undefined,
    sourceAgentId: string,
    targetAgentId: string,
  ) => AgentSubagentsConfig | undefined;
  /** Splits saved agent IDs into missing and not viewable by the user. */
  classifyAgentReferences: (agentIds: string[]) => Promise<AgentReferenceCheck>;
  /** Returns `null` when subagent references need no check for this request. */
  checkSubagentReferences: (
    subagents: AgentSubagentsConfig | undefined,
    allowedMissingIds: Set<string>,
  ) => Promise<AgentReferenceCheck | null>;
  instructionsPromptAccess: Pick<InstructionsPromptAccess, 'validateLinkWrite'>;
  getCachedTools: () => Promise<Record<string, unknown> | null | undefined>;
  resolveConfigServers: () => Promise<Record<string, unknown> | undefined>;
  /** Returns the subset of `tools` the user may attach and records resolved MCP server names. */
  filterAuthorizedTools: (params: {
    tools: string[];
    availableTools: Record<string, unknown>;
    configServers?: Record<string, unknown>;
    resolvedServerNames: Set<string>;
  }) => Promise<string[]>;
  grantPermission: (grant: CreateAgentGrant) => Promise<unknown>;
}

export interface CreateAgentContext {
  user: InstructionsPromptAccessUser;
  config?: AppConfig;
  /** Forwarded to the linked-prompt check so its role lookup reuses the request cache. */
  request?: InstructionsPromptAccessRequest;
  deps: CreateAgentDeps;
}

const LOG_PREFIX = '[/Agents]';

/** Config normalization only: a write keeps `code_execution` callers only when this is on. */
export function isCodeInterpreterCapabilityEnabled(config: AppConfig | undefined): boolean {
  const capabilities = config?.endpoints?.[EModelEndpoint.agents]?.capabilities;
  return Array.isArray(capabilities) && capabilities.includes(AgentCapabilities.execute_code);
}

/** Grant failures are logged, not returned: the agent is already saved. */
async function grantOwnerPermissions(
  agent: CreatedAgent,
  userId: string,
  grantPermission: CreateAgentDeps['grantPermission'],
): Promise<void> {
  try {
    await Promise.all([
      grantPermission({
        principalType: PrincipalType.USER,
        principalId: userId,
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
        accessRoleId: AccessRoleIds.AGENT_OWNER,
        grantedBy: userId,
      }),
      grantPermission({
        principalType: PrincipalType.USER,
        principalId: userId,
        resourceType: ResourceType.REMOTE_AGENT,
        resourceId: agent._id,
        accessRoleId: AccessRoleIds.REMOTE_AGENT_OWNER,
        grantedBy: userId,
      }),
    ]);
    logger.debug(`[createAgent] Granted owner permissions to user ${userId} for agent ${agent.id}`);
  } catch (permissionError) {
    logger.error(
      `[createAgent] Failed to grant owner permissions for agent ${agent.id}:`,
      permissionError,
    );
  }
}

async function runCreateAgent(input: unknown, ctx: CreateAgentContext): Promise<CreateAgentResult> {
  const { user, config, deps } = ctx;
  /**
   * Hydrated resource records are a client transport shape, not a persisted
   * Agent shape. Canonicalize them before the strict IDs-only schema strips
   * `files`, then let the schema validate the resulting `file_ids`.
   */
  normalizeToolResourceFiles(
    (input as { tool_resources?: AgentToolResources } | null | undefined)?.tool_resources,
  );
  const validatedData = agentCreateSchema.parse(input);
  const { tools = [], ...agentData } = removeNullishValues(validatedData);
  applySdkAgentBindingWrite(
    agentData,
    validatedData.sdk_runtime,
    config?.endpoints?.agents,
    user.role,
  );

  if (
    (!isCodeInterpreterCapabilityEnabled(config) || !tools.includes(Tools.execute_code)) &&
    agentData.tool_options != null
  ) {
    agentData.tool_options = removeCodeExecutionCaller(agentData.tool_options);
  }

  const environment = validateStatefulCodeEnvironment(config, {
    enabled: agentData.stateful_code_sessions,
    environment: agentData.stateful_code_environment,
    environmentId: agentData.code_environment_id,
    environmentIdSelected: agentData.code_environment_id != null,
    workspaceId: agentData.code_workspace_id,
    environmentIds: agentData.code_environment_ids,
  });
  if (!environment.ok) {
    return environment;
  }

  applyAgentInferenceInput(agentData, undefined, config);
  const agentId = `agent_${nanoid()}`;
  const allowedMissingIds = new Set([agentId]);
  const agentRecord = {
    ...agentData,
    id: agentId,
    /** The request schema types `prompt` as a zod function; saved edges carry the same shape. */
    edges: replaceEdgeSourceId(agentData.edges as GraphEdge[] | undefined, '', agentId),
    subagents: deps.replaceSubagentGraphAgentId(agentData.subagents, '', agentId),
  };

  if (agentRecord.tool_resources) {
    await deps.pruneToolResourceFileIds({
      tool_resources: agentRecord.tool_resources,
      ownerIds: user.id,
      logPrefix: LOG_PREFIX,
    });
  }

  const content = await checkAgentContent({
    filters: config?.filters,
    user,
    agentData: instructionsContentForScan('create', {
      data: agentRecord,
    }) as AgentContentCheckInput['agentData'],
    getFiles: deps.getFiles,
  });
  if (!content.ok) {
    return content;
  }

  if (agentRecord.edges?.length) {
    const edgeError = getAgentReferenceError(
      'edge',
      await validateHandoffReferences({
        edges: agentRecord.edges,
        specs: config?.modelSpecs?.list,
        allowedMissingIds,
        classifySavedReferences: deps.classifyAgentReferences,
      }),
    );
    if (edgeError) {
      return { ok: false, error: edgeError };
    }
  }

  /**
   * Subagent ACL is enforced only when the endpoint capability and the
   * payload's `enabled === true` both turn the feature on, matching the
   * runtime predicate, so a disable edit or an omitted flag never fails here.
   */
  const subagentReferences = await deps.checkSubagentReferences(
    agentRecord.subagents,
    allowedMissingIds,
  );
  const subagentError = subagentReferences
    ? getAgentReferenceError('subagent', subagentReferences)
    : null;
  if (subagentError) {
    return { ok: false, error: subagentError };
  }

  const instructionsPromptError = await checkInstructionsPromptWrite({
    access: deps.instructionsPromptAccess,
    operation: 'create',
    user,
    previous: undefined,
    next: agentRecord.instructionsPrompt,
    filters: config?.filters,
    linkedInstructions: config?.endpoints?.agents?.linkedInstructions,
    logger,
    req: ctx.request,
  });
  if (instructionsPromptError) {
    return {
      ok: false,
      error: { code: 'instructions_prompt_rejected', details: instructionsPromptError },
    };
  }

  const hasMCPTools = tools.some((tool) => tool?.includes(Constants.mcp_delimiter));
  const [availableTools, configServers] = await Promise.all([
    deps.getCachedTools().then((cached) => cached ?? {}),
    hasMCPTools ? deps.resolveConfigServers() : Promise.resolve(undefined),
  ]);
  /** Resolved during authorization, so persistence indexes the real server rather
   *  than a suffix guess. */
  const resolvedServerNames = new Set<string>();
  const authorizedTools = await deps.filterAuthorizedTools({
    tools,
    availableTools,
    configServers,
    resolvedServerNames,
  });
  const persisted: Record<string, unknown> = {
    ...agentRecord,
    author: user.id,
    tools: authorizedTools,
  };
  if (hasMCPTools) {
    persisted.mcpServerNames = Array.from(resolvedServerNames);
  }

  const agent = await deps.createAgent(persisted);
  await grantOwnerPermissions(agent, user.id, deps.grantPermission);
  return { ok: true, value: agent };
}

/**
 * Validates, authorizes and saves a new agent for `ctx.user`, then grants the owner roles.
 * The caller checks the AGENTS CREATE role permission first. Expected refusals return
 * `ok: false` with a stable code; persistence and provider failures throw.
 */
export async function createAgent(
  input: unknown,
  ctx: CreateAgentContext,
): Promise<CreateAgentResult> {
  try {
    return await runCreateAgent(input, ctx);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { ok: false, error: { code: 'invalid_request', details: error.issues } };
    }
    throw error;
  }
}

/** Maps a `createAgent` refusal to the HTTP status and body the side-panel route sends. */
export function createAgentErrorResponse(error: CreateAgentError): {
  status: number;
  body: object;
} {
  switch (error.code) {
    case 'invalid_request':
      return { status: 400, body: { error: 'Invalid request data', details: error.details } };
    case 'instructions_prompt_rejected':
      return { status: error.details.status, body: error.details.body };
    case 'edge_agents_missing':
    case 'edge_agents_forbidden':
    case 'subagent_agents_missing':
    case 'subagent_agents_forbidden':
      return agentReferenceErrorResponse(error);
    case 'content_filter_block':
    case 'content_filter_uninspectable':
      return agentContentFilterErrorResponse(error);
    default:
      return agentCodeEnvironmentErrorResponse(error);
  }
}

/**
 * Sends the side-panel response for a refused agent check. Returns `true` when it sent one,
 * so a route stops; returns `false` and sends nothing when the check passed.
 */
export function sendAgentRefusal(
  res: Response,
  check: { ok: true } | { ok: false; error: CreateAgentError },
): boolean {
  if (check.ok) {
    return false;
  }
  const { status, body } = createAgentErrorResponse(check.error);
  res.status(status).json(body);
  return true;
}

/** Runs `createAgent` with the collaborators bound to the incoming request. */
export type CreateAgentForRequest = (req: Request, input: unknown) => Promise<CreateAgentResult>;

export interface AgentManagementCreateDeps {
  getRoleByName: (roleName: string, fieldsToSelect?: string | string[]) => Promise<IRole | null>;
  createAgent: CreateAgentForRequest;
}

export interface AgentPanelCreateDeps {
  createAgent: CreateAgentForRequest;
}

const AGENT_CREATE_FAILED_MESSAGE = 'Failed to create agent';

/**
 * Side-panel `POST /agents` handler. A thrown failure is sent as an approved 409 conflict
 * or a generic 500; see `getAgentRouteErrorResponse`.
 */
export function createAgentPanelCreateHandler(
  deps: AgentPanelCreateDeps,
): (req: Request, res: Response) => Promise<Response> {
  return async function create(req: Request, res: Response): Promise<Response> {
    try {
      const result = await deps.createAgent(req, req.body);
      if (result.ok) {
        return res.status(201).json(result.value);
      }
      if (result.error.code === 'invalid_request') {
        logger.error(`${LOG_PREFIX} Validation error`, result.error.details);
      }
      const { status, body } = createAgentErrorResponse(result.error);
      return res.status(status).json(body);
    } catch (error) {
      logger.error(`${LOG_PREFIX} Error creating agent`, getSafeErrorMetadata(error));
      const { status, body } = getAgentRouteErrorResponse(error, AGENT_CREATE_FAILED_MESSAGE);
      return res.status(status).json(body);
    }
  };
}

type AgentManagementErrorCode = Parameters<typeof mapAgentManagementError>[0];

function sendError(res: Response, code: AgentManagementErrorCode, error?: unknown) {
  const mapped = mapAgentManagementError(code, error);
  return res.status(mapped.status).json(mapped.body);
}

/** Collapses a side-panel status into the Management API's coarser error codes. */
function mapCreateStatus(status: number): AgentManagementErrorCode {
  if (status === 400 || status === 409) {
    return 'invalid_request';
  }
  if (status === 401 || status === 403) {
    return 'permission_denied';
  }
  if (status === 404) {
    return 'not_found';
  }
  return 'internal_error';
}

/** Reads the `statusCode` a data-schemas method attaches to a thrown error. */
export function getErrorStatus(error: unknown): unknown {
  return (error as { statusCode?: unknown } | null)?.statusCode;
}

/** Validate and authorize Agent Management creation, then run the shared creation service. */
export function createAgentManagementCreateHandler(
  deps: AgentManagementCreateDeps,
): (req: Request, res: Response) => Promise<Response> {
  return async function create(req: Request, res: Response): Promise<Response> {
    try {
      const user = req.user as IUser | undefined;
      if (!user?.id || !user.tenantId) {
        return sendError(res, 'permission_denied');
      }

      const canCreate = await checkAccessWithRequestCache({
        req,
        user,
        permissionType: PermissionTypes.AGENTS,
        permissions: [Permissions.USE, Permissions.CREATE],
        getRoleByName: deps.getRoleByName,
      });
      if (!canCreate) {
        return sendError(res, 'permission_denied');
      }

      const parsedBody = agentManagementCreateSchema.safeParse(req.body);
      if (!parsedBody.success) {
        return sendError(res, 'invalid_request', parsedBody.error);
      }

      const result = await deps.createAgent(req, parsedBody.data);
      if (!result.ok) {
        return sendError(res, mapCreateStatus(createAgentErrorResponse(result.error).status));
      }
      return res
        .status(201)
        .json(projectAgentManagementResponse(result.value as AgentManagementProjectionSource));
    } catch (error) {
      logger.error('[AgentManagement] Error creating Agent', error);
      return sendError(res, getErrorStatus(error) === 409 ? 'invalid_request' : 'internal_error');
    }
  };
}
