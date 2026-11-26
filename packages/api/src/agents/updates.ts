import { z } from 'zod';
import { logger } from '@librechat/data-schemas';
import {
  Tools,
  Constants,
  Permissions,
  ResourceType,
  isActionTool,
  PermissionTypes,
  splitMCPToolKey,
  removeNullishValues,
  removeCodeExecutionCaller,
} from 'librechat-data-provider';
import type { GraphEdge, PermissionBits, AgentInstructionsPrompt } from 'librechat-data-provider';
import type { AppConfig, IRole, IUser, SystemCapability } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type {
  InstructionsPromptAccess,
  InstructionsPromptAccessUser,
  InstructionsPromptAccessRequest,
} from './instructions/access';
import type { CreatedAgent, CreateAgentDeps, CreateAgentError } from './creates';
import type { AgentContentCheckInput } from './content';
import type { AuthorizedAgent } from './access';
import {
  reconcileAgentWorkspaceDefault,
  validateStatefulCodeEnvironment,
  validateAgentCodeEnvironmentAllowlist,
  shouldValidateAgentWorkspaceDefaultBinding,
} from './workspace';
import {
  agentManagementUpdateSchema,
  mapAgentManagementError,
  toAgentManagementAccessCode,
  authorizeAgentManagementTarget,
  projectAgentManagementResponse,
} from './management';
import {
  getErrorStatus,
  toCreatedAgent,
  getAgentReferenceError,
  createAgentErrorResponse,
  isCodeInterpreterCapabilityEnabled,
} from './creates';
import {
  instructionsContentForScan,
  checkInstructionsPromptWrite,
  applyInstructionsPromptUnset,
} from './instructions/writes';
import { convertOcrToContextInPlace, mergeAgentOcrConversion } from './legacy';
import { notFound, checkAccessWithRequestCache } from '../middleware/access';
import { getRequestAgentAuthorization } from './access';
import { normalizeToolResourceFiles } from './orphans';
import { getSafeErrorMetadata } from '~/utils/errors';
import { getAgentRouteErrorResponse } from './errors';
import { validateHandoffReferences } from './specs';
import { applyAgentInferenceInput } from './input';
import { applySdkAgentBindingWrite } from './sdk';
import { agentUpdateSchema } from './validation';
import { checkAgentContent } from './content';
import { replaceEdgeSourceId } from './edges';

/** Update refusals use the same codes, details and HTTP mapping as create refusals. */
export type UpdateAgentError = CreateAgentError;

/** The saved agent as the editor sees it: version count, string author, restricted links. */
export type UpdatedAgent = UpdatableAgent & { version: number };

export type UpdateAgentResult =
  | { ok: true; value: UpdatedAgent }
  | { ok: false; error: UpdateAgentError };

/**
 * The loaded agent `updateAgent` edits, as the plain record `toCreatedAgent` produces.
 * Management loads a `version` count instead of `versions`.
 */
export type UpdatableAgent = Omit<CreatedAgent, 'instructionsPrompt'> & {
  /** A stored record holds the full link; only editor responses carry the restricted form. */
  instructionsPrompt?: AgentInstructionsPrompt | null;
};

/** Adapts a stored agent, or its absence, at the caller's database binding. */
export function toUpdatableAgent(
  agent: Parameters<typeof toCreatedAgent>[0] | null,
): UpdatableAgent | null {
  return agent ? (toCreatedAgent(agent) as UpdatableAgent) : null;
}

/** Request-bound collaborators supplied by the caller; this module reads no app state. */
export interface UpdateAgentDeps
  extends Pick<
    CreateAgentDeps,
    | 'getFiles'
    | 'getCachedTools'
    | 'resolveConfigServers'
    | 'filterAuthorizedTools'
    | 'classifyAgentReferences'
    | 'checkSubagentReferences'
    | 'pruneToolResourceFileIds'
    | 'replaceSubagentGraphAgentId'
  > {
  updateAgent: (
    search: { id: string },
    updateData: Record<string, unknown>,
    options: {
      updatingUserId: string;
      expectedMCPAccess: { names: string[]; updatedAt?: Date };
    },
  ) => Promise<UpdatableAgent | null>;
  instructionsPromptAccess: Pick<
    InstructionsPromptAccess,
    'validateLinkWrite' | 'presentForEditor'
  >;
  /** Whether the user may use MCP servers at all. */
  canUseMCPServers: () => Promise<boolean>;
  /** Adds owner contact fields to each agent in place. */
  attachOwnerContacts: (agents: UpdatedAgent[]) => Promise<unknown>;
}

export interface UpdateAgentContext {
  user: InstructionsPromptAccessUser;
  config?: AppConfig;
  /** Forwarded to the linked-prompt check so its role lookup reuses the request cache. */
  request?: InstructionsPromptAccessRequest;
  deps: UpdateAgentDeps;
}

type AgentUpdateInput = z.infer<typeof agentUpdateSchema>;

/** The partial write built from the request; `$unset` and `mcpServerNames` are added here. */
type AgentUpdateData = Partial<AgentUpdateInput> & {
  mcpServerNames?: string[];
  $unset?: Record<string, 1>;
  [key: string]: unknown;
};

type UpdateStepResult =
  | { ok: true; value: AgentUpdateData }
  | { ok: false; error: UpdateAgentError };

const isMCPTool = (tool: unknown): tool is string =>
  typeof tool === 'string' && tool.includes(Constants.mcp_delimiter) && !isActionTool(tool);

/** Code-environment checks that compare the request with the saved agent. */
function applyCodeConfiguration(
  updateData: AgentUpdateData,
  validatedData: AgentUpdateInput,
  existingAgent: UpdatableAgent,
  config: AppConfig | undefined,
): UpdateStepResult {
  const includesStatefulConfiguration =
    updateData.stateful_code_sessions !== undefined ||
    updateData.stateful_code_environment !== undefined ||
    updateData.code_environment_id !== undefined;
  const includesWorkspaceConfiguration = updateData.code_workspace_id !== undefined;
  const includesToolsConfiguration = Array.isArray(updateData.tools);
  const includesToolOptionsConfiguration = updateData.tool_options !== undefined;
  if (
    !includesStatefulConfiguration &&
    !includesWorkspaceConfiguration &&
    !includesToolsConfiguration &&
    !includesToolOptionsConfiguration
  ) {
    return { ok: true, value: updateData };
  }

  const codeEnvironmentSelectionChanged =
    updateData.code_environment_id !== undefined &&
    updateData.code_environment_id !== existingAgent.code_environment_id;
  const update = reconcileAgentWorkspaceDefault({
    update: updateData,
    request: validatedData,
    currentEnvironmentId: existingAgent.code_environment_id,
  });
  const statefulConfigurationChanged =
    (update.stateful_code_sessions !== undefined &&
      (update.stateful_code_sessions === true) !==
        (existingAgent.stateful_code_sessions === true)) ||
    (update.stateful_code_environment !== undefined &&
      (update.stateful_code_environment ?? 'user') !==
        (existingAgent.stateful_code_environment ?? 'user')) ||
    codeEnvironmentSelectionChanged;
  const activatesCodeExecution =
    includesToolsConfiguration &&
    update.tools?.includes(Tools.execute_code) === true &&
    existingAgent.tools?.includes(Tools.execute_code) !== true;
  const effectiveCodeWorkspaceId = update.code_workspace_id ?? existingAgent.code_workspace_id;
  const effectiveCodeEnvironmentId =
    update.code_environment_id === null
      ? undefined
      : (update.code_environment_id ?? existingAgent.code_environment_id);
  const selectsWorkspaceDefault =
    includesWorkspaceConfiguration &&
    shouldValidateAgentWorkspaceDefaultBinding({
      workspaceId: effectiveCodeWorkspaceId,
      environmentId: effectiveCodeEnvironmentId,
      currentWorkspaceId: existingAgent.code_workspace_id,
      currentEnvironmentId: existingAgent.code_environment_id,
    });
  if (statefulConfigurationChanged || selectsWorkspaceDefault || activatesCodeExecution) {
    const environment = validateStatefulCodeEnvironment(config, {
      enabled: update.stateful_code_sessions ?? existingAgent.stateful_code_sessions,
      environment: update.stateful_code_environment ?? existingAgent.stateful_code_environment,
      environmentId: effectiveCodeEnvironmentId,
      environmentIdSelected: codeEnvironmentSelectionChanged,
      workspaceId: effectiveCodeWorkspaceId,
      currentWorkspaceId: existingAgent.code_workspace_id,
      currentEnvironmentId: existingAgent.code_environment_id,
    });
    if (!environment.ok) {
      return environment;
    }
  }

  if (includesToolsConfiguration || includesToolOptionsConfiguration) {
    const effectiveTools = update.tools ?? existingAgent.tools;
    const effectiveToolOptions = update.tool_options ?? existingAgent.tool_options;
    if (
      (!isCodeInterpreterCapabilityEnabled(config) ||
        !effectiveTools?.includes(Tools.execute_code)) &&
      effectiveToolOptions != null
    ) {
      update.tool_options = removeCodeExecutionCaller(effectiveToolOptions);
    }
  }
  return { ok: true, value: update };
}

/**
 * Applies MCP server authorization to the tool list and rebuilds the MCP server index.
 * An editor without MCP access keeps the MCP tools already saved on another user's agent.
 * Mutates `updateData`.
 */
async function applyMCPToolAccess(
  updateData: AgentUpdateData,
  existingAgent: UpdatableAgent,
  ctx: UpdateAgentContext,
): Promise<void> {
  const { user, deps } = ctx;
  const hasToolUpdate = updateData.tools !== undefined;
  const editingOwnAgent = existingAgent.author === user.id;
  const existingTools = existingAgent.tools ?? [];
  const effectiveTools = (hasToolUpdate ? updateData.tools : existingAgent.tools) ?? [];
  const requestedMCPTools = effectiveTools.filter(isMCPTool);
  const existingMCPTools = existingTools.filter(isMCPTool);

  if (requestedMCPTools.length === 0 && !(hasToolUpdate && existingMCPTools.length > 0)) {
    return;
  }

  if (!(await deps.canUseMCPServers())) {
    if (editingOwnAgent) {
      updateData.tools = effectiveTools.filter((tool) => !isMCPTool(tool));
      /** Every MCP tool just went away, so nothing should stay indexed. */
      updateData.mcpServerNames = [];
    } else if (hasToolUpdate) {
      const existingMCPToolSet = new Set(existingMCPTools);
      const nextTools = (updateData.tools ?? []).filter(
        (tool) => !isMCPTool(tool) || existingMCPToolSet.has(tool),
      );
      const nextToolSet = new Set(nextTools);
      for (const existingMCPTool of existingMCPTools) {
        if (!nextToolSet.has(existingMCPTool)) {
          nextTools.push(existingMCPTool);
        }
      }
      updateData.tools = nextTools;
      /** Retained strings alone cannot authorize a previously unindexed server. */
      updateData.mcpServerNames = existingAgent.mcpServerNames ?? [];
    }
    return;
  }

  if (!hasToolUpdate) {
    return;
  }

  const existingToolSet = new Set(existingTools);
  const indexedNames = existingAgent.mcpServerNames ?? [];
  const newMCPTools = requestedMCPTools.filter((tool) => {
    const [, name] = splitMCPToolKey(tool, indexedNames);
    return !existingToolSet.has(tool) || name == null || !indexedNames.includes(name);
  });
  /** Names resolved during authorization of the newly added tools. */
  const resolvedServerNames = new Set<string>();

  if (newMCPTools.length > 0) {
    const [availableTools, configServers] = await Promise.all([
      deps.getCachedTools().then((cached) => cached ?? {}),
      deps.resolveConfigServers(),
    ]);
    const approvedNew = await deps.filterAuthorizedTools({
      tools: newMCPTools,
      availableTools,
      configServers,
      resolvedServerNames,
    });
    const rejectedSet = new Set(newMCPTools.filter((tool) => !approvedNew.includes(tool)));
    if (rejectedSet.size > 0) {
      updateData.tools = (updateData.tools ?? []).filter((tool) => !rejectedSet.has(tool));
    }
  }

  /** Rebuild the index from the tools that survive this edit: carry a prior name
   *  forward only while some retained tool still resolves to it, so detaching every
   *  tool for a server revokes agent-scoped access to it. The agent's own persisted
   *  names are the candidate set, which needs neither a registry query nor a guess. */
  const priorNames = existingAgent.mcpServerNames ?? [];
  if (priorNames.length > 0) {
    const priorNameSet = new Set(priorNames);
    for (const tool of updateData.tools ?? []) {
      if (typeof tool !== 'string' || !tool.includes(Constants.mcp_delimiter)) {
        continue;
      }
      const [, retainedName] = splitMCPToolKey(tool, priorNames);
      if (retainedName && priorNameSet.has(retainedName)) {
        resolvedServerNames.add(retainedName);
      }
    }
  }
  updateData.mcpServerNames = Array.from(resolvedServerNames);
}

/** Version count, string author (kept only for the owner), owner contacts, restricted links. */
async function presentUpdatedAgent(
  saved: UpdatableAgent,
  ctx: UpdateAgentContext,
): Promise<UpdatedAgent> {
  const { author, ...fields } = saved;
  const updatedAgent: UpdatedAgent = {
    ...fields,
    version: Array.isArray(saved.versions) ? saved.versions.length : (saved.version ?? 0),
  };
  if (author) {
    updatedAgent.author = author;
  }
  await ctx.deps.attachOwnerContacts([updatedAgent]);
  if (updatedAgent.author !== ctx.user.id) {
    delete updatedAgent.author;
  }
  return ctx.deps.instructionsPromptAccess.presentForEditor({
    user: ctx.user,
    agent: updatedAgent,
  });
}

async function runUpdateAgent(
  existingAgent: UpdatableAgent,
  input: unknown,
  ctx: UpdateAgentContext,
): Promise<UpdateAgentResult> {
  const { user, config, deps } = ctx;
  const id = existingAgent.id;
  /** See the create path: retain hydrated file IDs through validation. */
  normalizeToolResourceFiles(
    (input as Pick<AgentUpdateInput, 'tool_resources'> | null | undefined)?.tool_resources,
  );
  const validatedData = agentUpdateSchema.parse(input);
  const environmentChoices = validateAgentCodeEnvironmentAllowlist(
    config,
    validatedData.code_environment_ids,
  );
  if (!environmentChoices.ok) {
    return environmentChoices;
  }

  /** These fields keep an explicit `null` (a reset or a link removal), which
   *  `removeNullishValues` would drop. */
  const {
    avatar: avatarField,
    code_environment_id: codeEnvironmentIdField,
    git_identity: gitIdentityField,
    instructionsPrompt: instructionsPromptField,
    ...rest
  } = validatedData;
  const requested: AgentUpdateData = removeNullishValues(rest);
  applySdkAgentBindingWrite(
    requested,
    validatedData.sdk_runtime,
    config?.endpoints?.agents,
    user.role,
  );
  if (codeEnvironmentIdField !== undefined) {
    requested.code_environment_id = codeEnvironmentIdField;
  }
  if (gitIdentityField !== undefined) {
    requested.git_identity = gitIdentityField;
  }
  if (instructionsPromptField !== undefined) {
    requested.instructionsPrompt = instructionsPromptField;
  }

  const codeConfiguration = applyCodeConfiguration(requested, validatedData, existingAgent, config);
  if (!codeConfiguration.ok) {
    return codeConfiguration;
  }
  const updateData = codeConfiguration.value;

  if (avatarField === null) {
    updateData.avatar = avatarField;
  }
  if (updateData.edges !== undefined) {
    /** The request schema types `prompt` as a zod function; saved edges carry the same shape. */
    updateData.edges = replaceEdgeSourceId(
      updateData.edges as GraphEdge[] | undefined,
      '',
      id,
    ) as AgentUpdateData['edges'];
  }
  if (updateData.subagents !== undefined) {
    updateData.subagents = deps.replaceSubagentGraphAgentId(updateData.subagents, '', id);
  }
  if (updateData.edges?.length) {
    const edgeError = getAgentReferenceError(
      'edge',
      await validateHandoffReferences({
        edges: updateData.edges as GraphEdge[],
        specs: config?.modelSpecs?.list,
        allowedMissingIds: new Set(),
        classifySavedReferences: deps.classifyAgentReferences,
      }),
    );
    if (edgeError) {
      return { ok: false, error: edgeError };
    }
  }

  /** Same guard as the create path: a missing or disabled `subagents` payload always passes,
   *  so a user who lost VIEW on a referenced child can still save a disable edit. */
  const subagentReferences = await deps.checkSubagentReferences(updateData.subagents, new Set());
  const subagentError = subagentReferences
    ? getAgentReferenceError('subagent', subagentReferences)
    : null;
  if (subagentError) {
    return { ok: false, error: subagentError };
  }

  convertOcrToContextInPlace(updateData);
  applyAgentInferenceInput(updateData, existingAgent, config);

  const instructionsPromptError = await checkInstructionsPromptWrite({
    access: deps.instructionsPromptAccess,
    operation: 'update',
    user,
    previous: existingAgent.instructionsPrompt,
    next: instructionsPromptField,
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

  /** Converts a legacy OCR tool resource on the saved agent to the context format. */
  const ocrConversion = mergeAgentOcrConversion(existingAgent, updateData);
  if (ocrConversion.tool_resources) {
    updateData.tool_resources = ocrConversion.tool_resources;
  }
  if (ocrConversion.tools) {
    updateData.tools = ocrConversion.tools;
  }

  if (updateData.tool_resources) {
    await deps.pruneToolResourceFileIds({
      tool_resources: updateData.tool_resources,
      ownerIds: user.id,
      existingToolResources: existingAgent.tool_resources,
      logPrefix: `[/Agents/:id] Agent ${id}`,
    });
  }

  const content = await checkAgentContent({
    filters: config?.filters,
    user,
    agentData: instructionsContentForScan('update', {
      data: updateData,
      existing: existingAgent,
      nextLink: instructionsPromptField,
    }) as AgentContentCheckInput['agentData'],
    getFiles: deps.getFiles,
  });
  if (!content.ok) {
    return content;
  }

  await applyMCPToolAccess(updateData, existingAgent, ctx);

  if (updateData.code_environment_id === null) {
    delete updateData.code_environment_id;
    updateData.$unset = { code_environment_id: 1 };
  }
  if (updateData.git_identity === null) {
    delete updateData.git_identity;
    updateData.$unset = { ...updateData.$unset, git_identity: 1 };
  }
  const write = applyInstructionsPromptUnset(updateData);

  const saved =
    Object.keys(write).length > 0
      ? await deps.updateAgent({ id }, write, {
          updatingUserId: user.id,
          expectedMCPAccess: {
            names: existingAgent.mcpServerNames ?? [],
            updatedAt: existingAgent.updatedAt,
          },
        })
      : existingAgent;
  if (!saved) {
    throw new Error(`Agent ${id} was not found during update`);
  }
  return { ok: true, value: await presentUpdatedAgent(saved, ctx) };
}

/**
 * Validates, authorizes and saves an update to an agent the caller authorized for EDIT.
 * The authorization carries the loaded agent, so the service does not load it again.
 * The caller checks the AGENTS USE and CREATE role permissions first. Expected refusals
 * return `ok: false` with a stable code; persistence and provider failures throw.
 */
export async function updateAgent(
  authorized: AuthorizedAgent<'EDIT', UpdatableAgent>,
  input: unknown,
  ctx: UpdateAgentContext,
): Promise<UpdateAgentResult> {
  try {
    return await runUpdateAgent(authorized.agent, input, ctx);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { ok: false, error: { code: 'invalid_request', details: error.issues } };
    }
    throw error;
  }
}

/** Maps an `updateAgent` refusal to the HTTP status and body the side-panel route sends. */
export const updateAgentErrorResponse: (error: UpdateAgentError) => {
  status: number;
  body: object;
} = createAgentErrorResponse;

/** Runs `updateAgent` with the collaborators bound to the incoming request. */
export type UpdateAgentForRequest = (
  req: Request,
  authorized: AuthorizedAgent<'EDIT', UpdatableAgent>,
  input: unknown,
) => Promise<UpdateAgentResult>;

export interface AgentUpdateHandlerDeps {
  updateAgent: UpdateAgentForRequest;
}

const AGENT_UPDATE_FAILED_MESSAGE = 'Failed to update agent';

/**
 * Side-panel `PATCH /api/agents/:id` handler. A thrown failure is sent as an approved 409
 * conflict or a generic 500; see `getAgentRouteErrorResponse`. `createAgentAccessMiddleware` must run first:
 * it authorizes the agent for EDIT and loads it, and this handler reuses that record.
 */
export function createAgentUpdateHandler(
  deps: AgentUpdateHandlerDeps,
): (req: Request, res: Response) => Promise<Response> {
  return async function update(req: Request, res: Response): Promise<Response> {
    try {
      const authorized = getRequestAgentAuthorization<'EDIT', UpdatableAgent>(req, 'EDIT');
      if (!authorized) {
        return res.status(404).json(notFound(ResourceType.AGENT));
      }
      const result = await deps.updateAgent(req, authorized, req.body);
      if (result.ok) {
        return res.json(result.value);
      }
      if (result.error.code === 'invalid_request') {
        logger.error('[/Agents/:id] Validation error', result.error.details);
      }
      const { status, body } = updateAgentErrorResponse(result.error);
      return res.status(status).json(body);
    } catch (error) {
      logger.error('[/Agents/:id] Error updating Agent', getSafeErrorMetadata(error));
      const { status, body } = getAgentRouteErrorResponse(error, AGENT_UPDATE_FAILED_MESSAGE);
      return res.status(status).json(body);
    }
  };
}

export interface AgentManagementUpdateDeps {
  getRoleByName: (roleName: string, fieldsToSelect?: string | string[]) => Promise<IRole | null>;
  getAgentWithVersionCount: (search: {
    id: string;
    tenantId: string;
  }) => Promise<UpdatableAgent | null>;
  checkPermission: (params: {
    userId: string;
    role?: string;
    resourceType: ResourceType;
    resourceId: UpdatableAgent['_id'];
    requiredPermission: PermissionBits;
  }) => Promise<boolean>;
  hasCapability: (user: IUser, capability: SystemCapability) => Promise<boolean>;
  updateAgent: UpdateAgentForRequest;
}

type AgentManagementErrorCode = Parameters<typeof mapAgentManagementError>[0];

function sendError(res: Response, code: AgentManagementErrorCode, error?: unknown) {
  const mapped = mapAgentManagementError(code, error);
  return res.status(mapped.status).json(mapped.body);
}

/** Collapses a side-panel status into the Management API's coarser error codes. */
function mapUpdateStatus(status: number): AgentManagementErrorCode {
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

/** Validate and authorize Agent Management updates, then run the shared update service. */
export function createAgentManagementUpdateHandler(
  deps: AgentManagementUpdateDeps,
): (req: Request, res: Response) => Promise<Response> {
  return async function update(req: Request, res: Response): Promise<Response> {
    try {
      const user = req.user as IUser | undefined;
      if (!user?.id || !user.tenantId) {
        return sendError(res, 'permission_denied');
      }

      const canUpdate = await checkAccessWithRequestCache({
        req,
        user,
        permissionType: PermissionTypes.AGENTS,
        permissions: [Permissions.USE, Permissions.CREATE],
        getRoleByName: deps.getRoleByName,
      });
      if (!canUpdate) {
        return sendError(res, 'permission_denied');
      }

      const authorization = await authorizeAgentManagementTarget(
        { user, tenantId: user.tenantId, agentId: req.params.id, required: 'EDIT' },
        deps,
      );
      if (!authorization.ok) {
        return sendError(res, toAgentManagementAccessCode(authorization.error.code));
      }

      const parsedBody = agentManagementUpdateSchema.safeParse(req.body);
      if (!parsedBody.success) {
        return sendError(res, 'invalid_request', parsedBody.error);
      }

      const result = await deps.updateAgent(req, authorization.value, parsedBody.data);
      if (!result.ok) {
        return sendError(res, mapUpdateStatus(updateAgentErrorResponse(result.error).status));
      }
      return res.status(200).json(projectAgentManagementResponse(result.value));
    } catch (error) {
      logger.error('[AgentManagement] Error updating Agent', error);
      return sendError(res, getErrorStatus(error) === 409 ? 'invalid_request' : 'internal_error');
    }
  };
}
