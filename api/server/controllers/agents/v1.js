const { z } = require('zod');
const { load } = require('js-yaml');
const fs = require('fs').promises;
const { nanoid } = require('nanoid');
const { logger } = require('@librechat/data-schemas');
const {
  refreshS3Url,
  splitMCPToolKey,
  buildServerNameAliases,
  findShadowedServerNames,
  agentCreateSchema,
  agentUpdateSchema,
  agentSubagentsSchema,
  resolveAvatarRefresh,
  applyCachedAvatarUrl,
  collectEdgeAgentIds,
  replaceEdgeSourceId,
  mergeDeploymentSkillIds,
  getAgentListAccess,
  getAgentListAvatarRefreshKey,
  mergeAgentOcrConversion,
  sanitizeModelParameters,
  collectToolResourceFileIds,
  convertOcrToContextInPlace,
  normalizeToolResourceFiles,
  stripFileIdsFromToolResources,
  inspectContent,
  inspectContentWithTraversal,
  extractAgentContent,
  extractAssistantActionContent,
  extractFileContent,
  hasActiveFilePolicy,
  hasActiveFileFieldPolicy,
  contentFilterBlockResponse,
  contentFilterUninspectableResponse,
  getBlockedOpaqueFileField,
  getBlockedUninspectableFileField,
  getContentTraversalFragments,
  isContentTraversalProtected,
  isContentTraversalLimitError,
  resolveCanonicalFileReferences,
  reportLocatorTraversalFailure,
  isActiveAgentWorkspaceConfiguration,
  reconcileAgentWorkspaceDefault,
  resolveAgentWorkspaceRestoreConfiguration,
  shouldValidateAgentWorkspaceDefaultBinding,
  validateAgentWorkspaceDefaultBinding,
  marketplaceMineFilter,
  resolveMarketplaceListQuery,
  mapMarketplaceListError,
} = require('@librechat/api');
const {
  Time,
  Tools,
  SkillsScope,
  CacheKeys,
  Constants,
  ResourceType,
  AccessRoleIds,
  PrincipalType,
  EToolResources,
  isActionTool,
  PermissionBits,
  actionDelimiter,
  AgentCapabilities,
  EModelEndpoint,
  FileSources,
  resolveAllowedStatefulCodeEnvironments,
  removeCodeExecutionCaller,
  hasActivePiiFields,
  hasActivePiiPatterns,
  openapiToFunction,
  removeNullishValues,
} = require('librechat-data-provider');
const {
  findPubliclyAccessibleResources,
  getResourcePermissionsMap,
  findAccessibleResources,
  hasPublicPermission,
  grantPermission,
} = require('~/server/services/PermissionService');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { resizeAvatar } = require('~/server/services/Files/images/avatar');
const { getFileStrategy } = require('~/server/utils/getFileStrategy');
const { filterFile } = require('~/server/services/Files/process');
const { getCachedTools } = require('~/server/services/Config');
const {
  createMCPPermissionContext,
  resolveConfigServers,
  userCanUseMCPServers,
} = require('~/server/services/MCP');
const { hasCapability } = require('~/server/middleware/roles/capabilities');
const { attachOwnerContacts } = require('~/server/services/Agents/ownerContact');
const { getMCPServersRegistry } = require('~/config');
const { getLogStores } = require('~/cache');
const db = require('~/models');

const systemTools = {
  [Tools.execute_code]: true,
  [Tools.file_search]: true,
  [Tools.web_search]: true,
  [Tools.memory]: true,
};

const MAX_SEARCH_LEN = 100;
const escapeRegex = (str = '') => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const getSafeModelParameters = (modelParameters) => {
  const { useResponsesApi } = modelParameters ?? {};
  return typeof useResponsesApi === 'boolean' ? { useResponsesApi } : {};
};
const hasEditBit = (permission) => (permission & PermissionBits.EDIT) === PermissionBits.EDIT;

const blockFilteredActionContent = (req, res, actions) => {
  const filters = req.config?.filters;
  const actionPolicyActive = hasActivePiiPatterns(filters?.actionMetadata?.pii);
  const definitionPolicyActive = hasActivePiiPatterns(filters?.agentInstructions?.pii);
  const toolPolicyActive = hasActivePiiFields(filters?.toolArguments?.pii, ['name', 'arguments']);
  if (
    (!actionPolicyActive && !definitionPolicyActive && !toolPolicyActive) ||
    actions.length === 0
  ) {
    return false;
  }
  const filterableActions = actions.map((action) => {
    const rawSpec = action.metadata?.raw_spec;
    if (typeof rawSpec !== 'string') {
      return action;
    }
    let spec;
    try {
      spec = JSON.parse(rawSpec);
    } catch {
      try {
        spec = load(rawSpec);
      } catch {
        return action;
      }
    }
    if (
      spec == null ||
      typeof spec !== 'object' ||
      !Array.isArray(spec.servers) ||
      !spec.servers[0]?.url ||
      spec.paths == null ||
      typeof spec.paths !== 'object' ||
      Object.keys(spec.paths).length === 0
    ) {
      return action;
    }
    try {
      const { functionSignatures } = openapiToFunction(spec);
      return { ...action, functions: functionSignatures };
    } catch {
      return action;
    }
  });
  let traversalError;
  for (const action of filterableActions) {
    const inspection = inspectContentWithTraversal(() => extractAssistantActionContent(action), {
      filters,
    });
    if (inspection.finding != null) {
      res.status(400).json(contentFilterBlockResponse(inspection.finding));
      return true;
    }
    traversalError ??= inspection.traversalError ?? undefined;
  }
  if (traversalError != null) {
    res.status(traversalError.statusCode).json(traversalError.body);
    return true;
  }
  return false;
};

const blockFilteredAgentContent = async (req, res, agentData) => {
  const filters = req.config?.filters;
  const definitionPolicyActive =
    hasActivePiiPatterns(filters?.agentInstructions?.pii) ||
    hasActivePiiPatterns(filters?.conversationStarters?.pii) ||
    hasActivePiiPatterns(filters?.modelParameters?.pii) ||
    hasActivePiiFields(filters?.toolArguments?.pii, ['name', 'arguments']);
  const filePolicyActive = hasActiveFilePolicy(filters);
  if (!definitionPolicyActive && !filePolicyActive) {
    return false;
  }
  let opaqueAgentData = agentData;
  let hydratedFiles = [];
  if (filePolicyActive) {
    try {
      const fileInspection = await resolveCanonicalFileReferences({
        onTraversalFailure: reportLocatorTraversalFailure,
        filters,
        input: agentData,
        user: req.user,
        /**
         * Every caller prunes tool-resource IDs against current ownership or
         * the existing agent's already-authorized resources before reaching
         * this point. Preserve that authorization decision while hydrating the
         * canonical rows for content inspection.
         */
        getFiles: ({ file_id, tenantId }, sort, select) =>
          db.getFiles(
            {
              file_id,
              ...(tenantId != null && { tenantId }),
            },
            sort,
            select,
          ),
      });
      opaqueAgentData = fileInspection.sanitizedInput;
      hydratedFiles = fileInspection.hydratedFiles;
    } catch (error) {
      if (error?.statusCode === 400 && error?.body != null) {
        res.status(error.statusCode).json(error.body);
        return true;
      }
      throw error;
    }
  }
  const avatarPath = agentData?.avatar?.filepath;
  const uninspectableField = getBlockedOpaqueFileField(filters, opaqueAgentData);
  if (uninspectableField != null) {
    res.status(400).json(contentFilterUninspectableResponse(uninspectableField));
    return true;
  }
  const fileFragments = hydratedFiles.flatMap(extractFileContent);
  if (typeof avatarPath === 'string' && !avatarPath.toLowerCase().startsWith('data:')) {
    fileFragments.push(...extractFileContent({ filepath: avatarPath }));
  }
  let agentFragments;
  let traversalError;
  try {
    agentFragments = extractAgentContent(agentData);
  } catch (error) {
    if (!isContentTraversalLimitError(error)) {
      throw error;
    }
    agentFragments = getContentTraversalFragments(error);
    traversalError = error;
  }
  const finding = inspectContent([...agentFragments, ...fileFragments], {
    filters,
  });
  if (finding != null) {
    res.status(400).json(contentFilterBlockResponse(finding));
    return true;
  }
  if (traversalError != null && isContentTraversalProtected({ error: traversalError, filters })) {
    res.status(traversalError.statusCode).json(traversalError.body);
    return true;
  }
  return false;
};

const sanitizeViewerSkillScope = (agent, accessibleSkillSet) => {
  const skillScopeEnabled = agent.skills_enabled === true;
  const configuredScope = agent.skills_scope;
  delete agent.skills_enabled;
  delete agent.skills_scope;

  if (!skillScopeEnabled) {
    delete agent.skills;
    return agent;
  }

  if (configuredScope === SkillsScope.none) {
    delete agent.skills;
    agent.skills_enabled = true;
    agent.skills_scope = SkillsScope.none;
    return agent;
  }

  if (configuredScope === SkillsScope.all) {
    delete agent.skills;
    agent.skills_enabled = true;
    agent.skills_scope = SkillsScope.all;
    return agent;
  }

  const configuredSkills = Array.isArray(agent.skills) ? agent.skills : [];
  if (configuredSkills.length === 0) {
    // Legacy empty allowlists mean the viewer's full accessible catalog;
    // explicit selected scope remains an intentionally empty catalog.
    delete agent.skills;
    agent.skills_enabled = true;
    if (configuredScope === SkillsScope.selected) {
      agent.skills_scope = SkillsScope.selected;
    }
    return agent;
  }

  const visibleSkills = configuredSkills
    .map((skillId) => String(skillId))
    .filter((skillId) => accessibleSkillSet.has(skillId));

  if (visibleSkills.length === 0) {
    delete agent.skills;
    if (configuredScope === SkillsScope.selected) {
      agent.skills_enabled = true;
      agent.skills_scope = SkillsScope.selected;
    }
    return agent;
  }

  agent.skills = visibleSkills;
  agent.skills_enabled = true;
  if (configuredScope === SkillsScope.selected) {
    agent.skills_scope = SkillsScope.selected;
  }
  return agent;
};

/**
 * Looks up each referenced agent id in Mongo, splits them into three
 * buckets the caller needs for validation: ids that don't exist at all,
 * ids the user lacks VIEW permission on, and ids that are fully
 * accessible. Missing ids are intentionally NOT treated as unauthorized
 * — for `edges`, a self-referential `from` can legitimately name the
 * agent being created (no DB record yet); callers that should reject
 * missing ids (like the subagent path) read the `missing` bucket
 * instead.
 * @param {Iterable<string>} agentIds
 * @param {string} userId
 * @param {string} userRole
 * @returns {Promise<{ missing: string[], unauthorized: string[] }>}
 */
const classifyAgentReferences = async (agentIds, userId, userRole) => {
  const ids = [...new Set(agentIds)];
  if (ids.length === 0) return { missing: [], unauthorized: [] };

  const agents = await db.getAgents({ id: { $in: ids } });
  const foundIds = new Set(agents.map((a) => a.id));
  const missing = ids.filter((id) => !foundIds.has(id));

  if (agents.length === 0) return { missing, unauthorized: [] };

  const permissionsMap = await getResourcePermissionsMap({
    userId,
    role: userRole,
    resourceType: ResourceType.AGENT,
    resourceIds: agents.map((a) => a._id),
  });

  const unauthorized = agents
    .filter((a) => {
      const bits = permissionsMap.get(a._id.toString()) ?? 0;
      return (bits & PermissionBits.VIEW) === 0;
    })
    .map((a) => a.id);

  return { missing, unauthorized };
};

/**
 * Validates that every agent referenced in `edges` exists and is viewable.
 * The create path may allow its newly generated self id because that agent
 * has not been inserted yet; all other missing references are invalid.
 * @param {GraphEdge[]} edges
 * @param {string} userId
 * @param {string} userRole
 * @param {Set<string>} [allowedMissingIds]
 * @returns {Promise<{ missing: string[], unauthorized: string[] }>}
 */
const validateEdgeAgentReferences = async (
  edges,
  userId,
  userRole,
  allowedMissingIds = new Set(),
) => {
  const { missing, unauthorized } = await classifyAgentReferences(
    collectEdgeAgentIds(edges),
    userId,
    userRole,
  );
  return {
    missing: missing.filter((id) => !allowedMissingIds.has(id)),
    unauthorized,
  };
};

/**
 * Collects every saved agent referenced by a spawn target. Graph edge
 * endpoints are included defensively even though request validation requires
 * them to be declared in the graph's `agent_ids` list.
 * @param {import('librechat-data-provider').AgentSubagentsConfig | undefined} subagents
 * @returns {string[]}
 */
const collectSubagentAgentIds = (subagents) => {
  const ids = new Set(subagents?.agent_ids ?? []);
  for (const graph of subagents?.graphs ?? []) {
    for (const agentId of graph.agent_ids ?? []) {
      ids.add(agentId);
    }
    for (const edge of graph.edges ?? []) {
      for (const agentId of collectEdgeAgentIds([edge])) {
        ids.add(agentId);
      }
    }
  }
  return [...ids];
};

/**
 * Rewrites a duplicated agent's self-references inside saved graph spawn
 * targets so the clone remains self-contained.
 * @param {import('librechat-data-provider').AgentSubagentsConfig | undefined} subagents
 * @param {string} sourceAgentId
 * @param {string} targetAgentId
 */
const replaceSubagentGraphAgentId = (subagents, sourceAgentId, targetAgentId) => {
  if (!Array.isArray(subagents?.graphs)) {
    return subagents;
  }

  const replaceId = (agentId) => (agentId === sourceAgentId ? targetAgentId : agentId);
  return {
    ...subagents,
    graphs: subagents.graphs.map((graph) => ({
      ...graph,
      agent_ids: graph.agent_ids?.map(replaceId),
      edges: graph.edges?.map((edge) => ({
        ...edge,
        from: Array.isArray(edge.from) ? edge.from.map(replaceId) : replaceId(edge.from),
        to: Array.isArray(edge.to) ? edge.to.map(replaceId) : replaceId(edge.to),
      })),
      entry_agent_id: replaceId(graph.entry_agent_id),
      result_agent_id: replaceId(graph.result_agent_id),
    })),
  };
};

const replaceAndValidateSubagentGraphAgentId = (subagents, sourceAgentId, targetAgentId) =>
  agentSubagentsSchema.parse(replaceSubagentGraphAgentId(subagents, sourceAgentId, targetAgentId));

/**
 * Validates saved-agent spawn targets more strictly than top-level edges: both
 * missing AND unauthorized ids are errors. Spawn targets
 * can't self-reference (subagents spawn *other* agents), so a
 * missing id is always a typo or a reference to a deleted agent —
 * `initializeClient` would silently drop it at runtime, leaving the
 * persisted config out of sync with actual spawn targets (Codex P2).
 * Returning the split lets the caller report each bucket with the
 * appropriate status.
 */
const validateSubagentReferences = async (
  subagents,
  userId,
  userRole,
  allowedMissingIds = new Set(),
) => {
  const { missing, unauthorized } = await classifyAgentReferences(
    collectSubagentAgentIds(subagents),
    userId,
    userRole,
  );
  return {
    missing: missing.filter((id) => !allowedMissingIds.has(id)),
    unauthorized,
  };
};

/**
 * Returns true when the agents-endpoint `subagents` capability is
 * enabled in this request's resolved app config. When disabled,
 * `initializeClient` already strips the `subagents` block at runtime
 * so persisted `agent_ids` are inert — gating the ACL check on this
 * keeps stale references in legacy records from blocking unrelated
 * edits after a capability-off rollback (Codex P2).
 * @param {Express.Request} req
 */
const isSubagentsCapabilityEnabled = (req) => {
  const capabilities = req.config?.endpoints?.[EModelEndpoint.agents]?.capabilities;
  if (!Array.isArray(capabilities)) return false;
  return capabilities.includes(AgentCapabilities.subagents);
};

const isCodeInterpreterCapabilityEnabled = (req) => {
  const capabilities = req.config?.endpoints?.[EModelEndpoint.agents]?.capabilities;
  if (!Array.isArray(capabilities)) return false;
  return capabilities.includes(AgentCapabilities.execute_code);
};

/** Reject a newly selected stateful workspace scope that the deployment owner
 * has excluded. Disabled sessions and unrelated edits remain saveable so an
 * allowlist tightening never silently rewrites or strands an existing agent. */
const validateStatefulCodeEnvironment = (
  req,
  res,
  enabled,
  environment,
  environmentId,
  environmentIdSelected = false,
  workspaceId,
  currentWorkspaceId,
  currentEnvironmentId,
) => {
  const configuredEnvironments =
    req.config?.endpoints?.[EModelEndpoint.agents]?.statefulCodeSessions?.environments ?? [];
  const workspaceValidation = validateAgentWorkspaceDefaultBinding({
    workspaceId,
    environmentId,
    currentWorkspaceId,
    currentEnvironmentId,
    environments: configuredEnvironments,
  });
  if (!workspaceValidation.valid) {
    res.status(400).json({ error: workspaceValidation.error });
    return false;
  }
  if (enabled !== true && !environmentIdSelected) {
    return true;
  }
  if (environmentId != null) {
    const configuredEnvironment = configuredEnvironments.find(
      (configured) => configured.id === environmentId,
    );
    const pairingOnly =
      configuredEnvironment?.pairing?.allowPrincipalWorkers === true &&
      configuredEnvironment.pairing.workerId == null &&
      configuredEnvironment.workerId == null;
    if (configuredEnvironment == null || pairingOnly) {
      res.status(400).json({
        error: `Stateful code environment is not configured: ${environmentId}`,
      });
      return false;
    }
  }
  if (enabled !== true) {
    return true;
  }

  const allowedEnvironments = resolveAllowedStatefulCodeEnvironments(
    req.config?.endpoints?.[EModelEndpoint.agents]?.statefulCodeSessions?.allowedEnvironments,
  );
  const resolvedEnvironment = environment ?? 'user';
  if (allowedEnvironments.includes(resolvedEnvironment)) {
    return true;
  }

  res.status(403).json({
    error: `Stateful code environment is not allowed by this deployment: ${resolvedEnvironment}`,
  });
  return false;
};

/**
 * @param {import('librechat-data-provider').AgentSubagentsConfig | undefined} subagents
 * @param {Express.Request} req
 * @returns {Promise<{ status: number, body: { error: string, agent_ids: string[] } } | null>}
 */
const getSubagentReferenceError = async (subagents, req, allowedMissingIds = new Set()) => {
  if (
    !isSubagentsCapabilityEnabled(req) ||
    subagents?.enabled !== true ||
    collectSubagentAgentIds(subagents).length === 0
  ) {
    return null;
  }

  const { missing, unauthorized } = await validateSubagentReferences(
    subagents,
    req.user.id,
    req.user.role,
    allowedMissingIds,
  );
  if (missing.length > 0) {
    return {
      status: 400,
      body: {
        error: 'One or more agents referenced in subagents do not exist',
        agent_ids: missing,
      },
    };
  }
  if (unauthorized.length > 0) {
    return {
      status: 403,
      body: {
        error: 'You do not have access to one or more agents referenced in subagents',
        agent_ids: unauthorized,
      },
    };
  }
  return null;
};

/**
 * Filters tools to only include those the user is authorized to use.
 * MCP tools must match the exact format `{toolName}_mcp_{serverName}` (exactly 2 segments).
 * Multi-delimiter keys are rejected to prevent authorization/execution mismatch.
 * Non-MCP tools must appear in availableTools (global tool cache) or systemTools.
 *
 * When `existingTools` is provided and the MCP registry is unavailable (e.g. server restart),
 * tools already present on the agent are preserved rather than stripped — they were validated
 * when originally added, and we cannot re-verify them without the registry.
 * @param {object} params
 * @param {string[]} params.tools - Raw tool strings from the request
 * @param {string} params.userId - Requesting user ID for MCP server access check
 * @param {string} [params.role] - Requesting user's role for ACL principal resolution
 * @param {object} [params.user] - Requesting user for MCP server use permission checks
 * @param {{ canUseServers: (user?: object) => Promise<boolean> }} [params.mcpPermissionContext] - Request-scoped MCP permission context
 * @param {Record<string, unknown>} params.availableTools - Global non-MCP tool cache
 * @param {string[]} [params.existingTools] - Tools already persisted on the agent document
 * @param {Record<string, unknown>} [params.configServers] - Config-source MCP servers resolved from appConfig overrides
 * @returns {Promise<string[]>} Only the authorized subset of tools
 */
const filterAuthorizedTools = async ({
  tools,
  userId,
  role,
  user,
  mcpPermissionContext,
  availableTools,
  existingTools,
  configServers,
  resolvedServerNames,
}) => {
  const filteredTools = [];
  let mcpServerConfigs;
  /** normalized server name -> the raw key `mcpServerConfigs` is indexed by */
  let configNamesByNormalized = new Map();
  let shadowedServerNames = new Set();
  let registryUnavailable = false;
  const existingToolSet = existingTools?.length ? new Set(existingTools) : null;
  const hasMCPTools = tools.some((tool) => tool?.includes(Constants.mcp_delimiter));
  const canUseMCP = hasMCPTools
    ? await (mcpPermissionContext
        ? mcpPermissionContext.canUseServers(user)
        : userCanUseMCPServers(user))
    : true;
  let loggedMCPDenied = false;

  for (const tool of tools) {
    const isActionToolName = typeof tool === 'string' && isActionTool(tool);
    const isMCPTool = tool?.includes(Constants.mcp_delimiter) && !isActionToolName;

    if (!isMCPTool) {
      if (availableTools[tool] || systemTools[tool] || isActionToolName) {
        filteredTools.push(tool);
      }
      continue;
    }

    if (!canUseMCP) {
      if (!loggedMCPDenied) {
        logger.warn(`[filterAuthorizedTools] User ${userId} lacks MCP server use permission`);
        loggedMCPDenied = true;
      }
      continue;
    }

    if (mcpServerConfigs === undefined) {
      try {
        mcpServerConfigs =
          (role
            ? await getMCPServersRegistry().getAllServerConfigs(userId, configServers, role)
            : await getMCPServersRegistry().getAllServerConfigs(userId, configServers)) ?? {};
      } catch (e) {
        logger.warn(
          '[filterAuthorizedTools] MCP registry unavailable, filtering all MCP tools',
          e.message,
        );
        mcpServerConfigs = {};
        registryUnavailable = true;
      }
      /** Shared first-wins construction — authorization must resolve a
       *  colliding normalized key to the SAME server execution routes to,
       *  or a tool could be authorized against one server and executed
       *  against another. */
      configNamesByNormalized = buildServerNameAliases(Object.keys(mcpServerConfigs));
      shadowedServerNames = findShadowedServerNames(Object.keys(mcpServerConfigs));
    }

    /** Tool keys embed the normalized server name; the config is keyed by the raw name. */
    const [, normalizedServerName] = splitMCPToolKey(
      tool,
      Array.from(configNamesByNormalized.keys()),
    );
    const serverName = configNamesByNormalized.get(normalizedServerName) ?? normalizedServerName;
    if (!serverName) {
      logger.warn(
        `[filterAuthorizedTools] Rejected malformed MCP tool key "${tool}" for user ${userId}`,
      );
      continue;
    }

    if (registryUnavailable && existingToolSet?.has(tool)) {
      filteredTools.push(tool);
      continue;
    }

    if (!Object.hasOwn(mcpServerConfigs, serverName)) {
      logger.warn(
        `[filterAuthorizedTools] Rejected MCP tool "${tool}" — server "${serverName}" not accessible to user ${userId}`,
      );
      continue;
    }

    /** A shadowed server's tools (including its `mcp_all` wildcard) produce
     *  the SAME normalized function names as the winning server's — in-run
     *  dispatch could execute either. Fail closed at authorization; this map
     *  is the full accessible set, so DB-vs-config collisions are visible. */
    if (shadowedServerNames.has(serverName)) {
      logger.warn(
        `[filterAuthorizedTools] Rejected MCP tool "${tool}" — server "${serverName}" is shadowed by a name collision; rename one server to use it`,
      );
      continue;
    }

    resolvedServerNames?.add(serverName);
    filteredTools.push(tool);
  }

  return filteredTools;
};

/**
 * Removes file IDs from tool resources unless they are already attached to the
 * agent or owned by an allowed uploader.
 * @param {object} params
 * @param {object} params.tool_resources
 * @param {string | object | Array<string | object>} params.ownerIds
 * @param {object} [params.existingToolResources]
 * @param {string} params.logPrefix
 * @returns {Promise<number>} Count of removed file references.
 */
const pruneToolResourceFileIdsForAgent = async ({
  tool_resources,
  ownerIds,
  existingToolResources,
  logPrefix,
}) => {
  const referencedFileIds = collectToolResourceFileIds(tool_resources);
  if (referencedFileIds.length === 0) {
    return 0;
  }
  const ownerIdSet = new Set(
    (Array.isArray(ownerIds) ? ownerIds : [ownerIds])
      .filter(Boolean)
      .map((ownerId) => ownerId.toString()),
  );
  const existingFileIds = new Set(collectToolResourceFileIds(existingToolResources ?? {}));

  try {
    const files = await db.getFiles({ file_id: { $in: referencedFileIds } }, null, {
      file_id: 1,
      user: 1,
    });
    const allowedIds = new Set(
      (files ?? [])
        .filter((file) => {
          if (!file.user) {
            return false;
          }
          return existingFileIds.has(file.file_id) || ownerIdSet.has(file.user.toString());
        })
        .map((file) => file.file_id),
    );
    const disallowedIds = referencedFileIds.filter((id) => !allowedIds.has(id));
    if (disallowedIds.length > 0) {
      logger.warn(`${logPrefix} Pruning ${disallowedIds.length} invalid file reference(s)`);
      return stripFileIdsFromToolResources(tool_resources, disallowedIds).removedCount;
    }
    return 0;
  } catch (fileCheckError) {
    logger.warn(`${logPrefix} File ownership check failed, pruning incoming file references`, {
      error: fileCheckError?.message,
    });
    return stripFileIdsFromToolResources(tool_resources, referencedFileIds).removedCount;
  }
};

/**
 * Creates an Agent.
 * @route POST /Agents
 * @param {ServerRequest} req - The request object.
 * @param {AgentCreateParams} req.body - The request body.
 * @param {ServerResponse} res - The response object.
 * @returns {Promise<Agent>} 201 - success response - application/json
 */
const createAgentHandler = async (req, res) => {
  try {
    /**
     * Hydrated resource records are a client transport shape, not a persisted
     * Agent shape. Canonicalize them before the strict IDs-only schema strips
     * `files`, then let the schema validate the resulting `file_ids`.
     */
    normalizeToolResourceFiles(req.body?.tool_resources);
    const validatedData = agentCreateSchema.parse(req.body);
    const { tools = [], ...agentData } = removeNullishValues(validatedData);

    if (
      (!isCodeInterpreterCapabilityEnabled(req) || !tools.includes(Tools.execute_code)) &&
      agentData.tool_options != null
    ) {
      agentData.tool_options = removeCodeExecutionCaller(agentData.tool_options);
    }

    if (
      !validateStatefulCodeEnvironment(
        req,
        res,
        agentData.stateful_code_sessions,
        agentData.stateful_code_environment,
        agentData.code_environment_id,
        agentData.code_environment_id != null,
        agentData.code_workspace_id,
      )
    ) {
      return;
    }

    if (agentData.model_parameters && typeof agentData.model_parameters === 'object') {
      agentData.model_parameters = removeNullishValues(
        sanitizeModelParameters(agentData.model_parameters),
        true,
      );
    }
    const { id: userId, role: userRole } = req.user;
    agentData.id = `agent_${nanoid()}`;
    agentData.edges = replaceEdgeSourceId(agentData.edges, '', agentData.id);
    agentData.subagents = replaceAndValidateSubagentGraphAgentId(
      agentData.subagents,
      '',
      agentData.id,
    );

    if (agentData.tool_resources) {
      await pruneToolResourceFileIdsForAgent({
        tool_resources: agentData.tool_resources,
        ownerIds: userId,
        logPrefix: '[/Agents]',
      });
    }

    if (await blockFilteredAgentContent(req, res, agentData)) {
      return;
    }

    if (agentData.edges?.length) {
      const { missing, unauthorized } = await validateEdgeAgentReferences(
        agentData.edges,
        userId,
        userRole,
        new Set([agentData.id]),
      );
      if (missing.length > 0) {
        return res.status(400).json({
          error: 'One or more agents referenced in edges do not exist',
          agent_ids: missing,
        });
      }
      if (unauthorized.length > 0) {
        return res.status(403).json({
          error: 'You do not have access to one or more agents referenced in edges',
          agent_ids: unauthorized,
        });
      }
    }

    /**
     * Only validate subagent ACL when the feature is actually enabled
     * on BOTH the endpoint (capability flag in appConfig) AND the
     * agent payload. Runtime (`initializeClient` + `run.ts`) checks
     * `subagents?.enabled` as a truthy predicate — so `undefined` /
     * `null` / missing `enabled` all disable the feature. The ACL
     * check must match exactly: only enforce when `enabled === true`.
     * Otherwise a payload that omits `enabled` (e.g. API clients, or
     * legacy records that never set the field) could 403 here while
     * runtime would happily no-op on the subagent tool. Disable-path
     * is also untouched: toggling `enabled: false` always passes the
     * gate, so a user who lost VIEW on a child can still save the
     * disable edit.
     */
    const subagentReferenceError = await getSubagentReferenceError(
      agentData.subagents,
      req,
      new Set([agentData.id]),
    );
    if (subagentReferenceError) {
      return res.status(subagentReferenceError.status).json(subagentReferenceError.body);
    }

    agentData.author = userId;
    agentData.tools = [];

    const hasMCPTools = tools.some((t) => t?.includes(Constants.mcp_delimiter));
    const [availableTools, configServers] = await Promise.all([
      getCachedTools().then((t) => t ?? {}),
      hasMCPTools ? resolveConfigServers(req) : Promise.resolve(undefined),
    ]);
    const mcpPermissionContext = createMCPPermissionContext(req);
    /** Resolved during authorization, so persistence indexes the real server rather
     *  than a suffix guess - see the note on `filterAuthorizedTools`. */
    const resolvedServerNames = new Set();
    agentData.tools = await filterAuthorizedTools({
      tools,
      userId,
      role: req.user.role,
      user: req.user,
      mcpPermissionContext,
      availableTools,
      configServers,
      resolvedServerNames,
    });
    if (hasMCPTools) {
      agentData.mcpServerNames = Array.from(resolvedServerNames);
    }

    const agent = await db.createAgent(agentData);

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
      logger.debug(
        `[createAgent] Granted owner permissions to user ${userId} for agent ${agent.id}`,
      );
    } catch (permissionError) {
      logger.error(
        `[createAgent] Failed to grant owner permissions for agent ${agent.id}:`,
        permissionError,
      );
    }

    res.status(201).json(agent);
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.error('[/Agents] Validation error', error.errors);
      return res.status(400).json({ error: 'Invalid request data', details: error.errors });
    }
    logger.error('[/Agents] Error creating agent', error);
    if (error?.statusCode === 409) {
      return res.status(409).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
};

/**
 * Retrieves an Agent by ID.
 * @route GET /Agents/:id
 * @param {object} req - Express Request
 * @param {object} req.params - Request params
 * @param {string} req.params.id - Agent identifier.
 * @param {object} req.user - Authenticated user information
 * @param {string} req.user.id - User ID
 * @returns {Promise<Agent>} 200 - success response - application/json
 * @returns {Error} 404 - Agent not found
 */
const getAgentHandler = async (req, res, expandProperties = false) => {
  try {
    const id = req.params.id;
    const author = req.user.id;

    // Permissions are validated by middleware before calling this function.
    // Load the agent with a `version` count but without the heavy `versions`
    // array; version history is fetched lazily via GET /agents/:id/versions.
    const agent = await db.getAgentWithVersionCount({ id });

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    if (agent.avatar && agent.avatar?.source === FileSources.s3) {
      try {
        agent.avatar = {
          ...agent.avatar,
          filepath: await refreshS3Url(agent.avatar),
        };
      } catch (e) {
        logger.warn('[/Agents/:id] Failed to refresh S3 URL', e);
      }
    }

    agent.author = agent.author.toString();

    // Check if agent is public
    const isPublic = await hasPublicPermission({
      resourceType: ResourceType.AGENT,
      resourceId: agent._id,
      requiredPermissions: PermissionBits.VIEW,
    });
    agent.isPublic = isPublic;

    await attachOwnerContacts([agent]);

    if (agent.author !== author) {
      delete agent.author;
    }

    if (!expandProperties) {
      // VIEW permission: Basic agent info only
      const responseAgent = {
        _id: agent._id,
        id: agent.id,
        name: agent.name,
        description: agent.description,
        conversation_starters: agent.conversation_starters,
        avatar: agent.avatar,
        author: agent.author,
        provider: agent.provider,
        model: agent.model,
        model_parameters: getSafeModelParameters(agent.model_parameters),
        isPublic: agent.isPublic,
        version: agent.version,
        // Safe metadata
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
      };

      if (agent.support_contact !== undefined) {
        responseAgent.support_contact = agent.support_contact;
      }
      if (agent.owner_contact !== undefined) {
        responseAgent.owner_contact = agent.owner_contact;
      }

      return res.status(200).json(responseAgent);
    }

    // EDIT permission: Full agent details including sensitive configuration
    return res.status(200).json(agent);
  } catch (error) {
    logger.error('[/Agents/:id] Error retrieving agent', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Retrieves an agent's version history.
 * Loaded lazily so the editor doesn't transfer large histories up front.
 * @route GET /agents/:id/versions
 * @param {object} req - Express Request
 * @param {object} req.params - Request params
 * @param {string} req.params.id - Agent identifier.
 * @returns {Promise<Agent[]>} 200 - The agent's version history - application/json
 * @returns {Error} 404 - Agent not found
 */
const getAgentVersionsHandler = async (req, res) => {
  try {
    const id = req.params.id;
    const versions = await db.getAgentVersions({ id });

    if (versions == null) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    return res.status(200).json(versions);
  } catch (error) {
    logger.error('[/Agents/:id/versions] Error retrieving agent versions', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Updates an Agent.
 * @route PATCH /Agents/:id
 * @param {object} req - Express Request
 * @param {object} req.params - Request params
 * @param {string} req.params.id - Agent identifier.
 * @param {AgentUpdateParams} req.body - The Agent update parameters.
 * @returns {Promise<Agent>} 200 - success response - application/json
 */
const updateAgentHandler = async (req, res) => {
  try {
    const id = req.params.id;
    /** See the create path: retain hydrated file IDs through validation. */
    normalizeToolResourceFiles(req.body?.tool_resources);
    const validatedData = agentUpdateSchema.parse(req.body);
    // Preserve explicit null for avatar to allow resetting the avatar
    const {
      avatar: avatarField,
      code_environment_id: codeEnvironmentIdField,
      git_identity: gitIdentityField,
      _id,
      ...rest
    } = validatedData;
    let updateData = removeNullishValues(rest);
    if (codeEnvironmentIdField !== undefined) {
      updateData.code_environment_id = codeEnvironmentIdField;
    }
    if (gitIdentityField !== undefined) {
      updateData.git_identity = gitIdentityField;
    }
    let existingAgent;

    const includesStatefulConfiguration =
      updateData.stateful_code_sessions !== undefined ||
      updateData.stateful_code_environment !== undefined ||
      updateData.code_environment_id !== undefined;
    const includesWorkspaceConfiguration = updateData.code_workspace_id !== undefined;
    const includesToolsConfiguration = Array.isArray(updateData.tools);
    const includesToolOptionsConfiguration = updateData.tool_options !== undefined;
    if (
      includesStatefulConfiguration ||
      includesWorkspaceConfiguration ||
      includesToolsConfiguration ||
      includesToolOptionsConfiguration
    ) {
      existingAgent = await db.getAgent({ id }, {});
      if (!existingAgent) {
        return res.status(404).json({ error: 'Agent not found' });
      }

      const codeEnvironmentSelectionChanged =
        updateData.code_environment_id !== undefined &&
        updateData.code_environment_id !== existingAgent.code_environment_id;
      updateData = reconcileAgentWorkspaceDefault({
        update: updateData,
        request: validatedData,
        currentEnvironmentId: existingAgent.code_environment_id,
      });
      const statefulConfigurationChanged =
        (updateData.stateful_code_sessions !== undefined &&
          (updateData.stateful_code_sessions === true) !==
            (existingAgent.stateful_code_sessions === true)) ||
        (updateData.stateful_code_environment !== undefined &&
          (updateData.stateful_code_environment ?? 'user') !==
            (existingAgent.stateful_code_environment ?? 'user')) ||
        codeEnvironmentSelectionChanged;
      const activatesCodeExecution =
        includesToolsConfiguration &&
        updateData.tools.includes(Tools.execute_code) &&
        existingAgent.tools?.includes(Tools.execute_code) !== true;
      const effectiveCodeWorkspaceId =
        updateData.code_workspace_id ?? existingAgent.code_workspace_id;
      const selectsWorkspaceDefault =
        includesWorkspaceConfiguration &&
        shouldValidateAgentWorkspaceDefaultBinding({
          workspaceId: effectiveCodeWorkspaceId,
          environmentId:
            updateData.code_environment_id === null
              ? undefined
              : (updateData.code_environment_id ?? existingAgent.code_environment_id),
          currentWorkspaceId: existingAgent.code_workspace_id,
          currentEnvironmentId: existingAgent.code_environment_id,
        });
      if (statefulConfigurationChanged || selectsWorkspaceDefault || activatesCodeExecution) {
        const effectiveStatefulSessions =
          updateData.stateful_code_sessions ?? existingAgent.stateful_code_sessions;
        const effectiveStatefulEnvironment =
          updateData.stateful_code_environment ?? existingAgent.stateful_code_environment;
        const effectiveCodeEnvironmentId =
          updateData.code_environment_id === null
            ? undefined
            : (updateData.code_environment_id ?? existingAgent.code_environment_id);
        if (
          !validateStatefulCodeEnvironment(
            req,
            res,
            effectiveStatefulSessions,
            effectiveStatefulEnvironment,
            effectiveCodeEnvironmentId,
            codeEnvironmentSelectionChanged,
            effectiveCodeWorkspaceId,
            existingAgent.code_workspace_id,
            existingAgent.code_environment_id,
          )
        ) {
          return;
        }
      }

      if (includesToolsConfiguration || includesToolOptionsConfiguration) {
        const effectiveTools = updateData.tools ?? existingAgent.tools;
        const effectiveToolOptions = updateData.tool_options ?? existingAgent.tool_options;
        if (
          (!isCodeInterpreterCapabilityEnabled(req) ||
            !effectiveTools?.includes(Tools.execute_code)) &&
          effectiveToolOptions != null
        ) {
          updateData.tool_options = removeCodeExecutionCaller(effectiveToolOptions);
        }
      }
    }

    if (updateData.model_parameters && typeof updateData.model_parameters === 'object') {
      updateData.model_parameters = removeNullishValues(
        sanitizeModelParameters(updateData.model_parameters),
        true,
      );
    }
    if (avatarField === null) {
      updateData.avatar = avatarField;
    }

    if (updateData.edges !== undefined) {
      updateData.edges = replaceEdgeSourceId(updateData.edges, '', id);
    }
    if (updateData.subagents !== undefined) {
      updateData.subagents = replaceAndValidateSubagentGraphAgentId(updateData.subagents, '', id);
    }
    if (updateData.edges?.length) {
      const { id: userId, role: userRole } = req.user;
      const { missing, unauthorized } = await validateEdgeAgentReferences(
        updateData.edges,
        userId,
        userRole,
      );
      if (missing.length > 0) {
        return res.status(400).json({
          error: 'One or more agents referenced in edges do not exist',
          agent_ids: missing,
        });
      }
      if (unauthorized.length > 0) {
        return res.status(403).json({
          error: 'You do not have access to one or more agents referenced in edges',
          agent_ids: unauthorized,
        });
      }
    }

    /** Same guard as the create path: capability on the endpoint,
     *  AND `subagents.enabled === true` on the payload (runtime's
     *  truthy check treats `undefined` / `null` / `false` as
     *  disabled, so the ACL check must too). Missing or explicitly-
     *  disabled payloads always pass the gate — that preserves the
     *  "can always save a disable edit" behavior a user might need
     *  after losing VIEW on a referenced child. */
    const subagentReferenceError = await getSubagentReferenceError(updateData.subagents, req);
    if (subagentReferenceError) {
      return res.status(subagentReferenceError.status).json(subagentReferenceError.body);
    }

    // Convert OCR to context in incoming updateData
    convertOcrToContextInPlace(updateData);

    existingAgent ??= await db.getAgent({ id }, {});

    if (!existingAgent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Convert legacy OCR tool resource to context format in existing agent
    const ocrConversion = mergeAgentOcrConversion(existingAgent, updateData);
    if (ocrConversion.tool_resources) {
      updateData.tool_resources = ocrConversion.tool_resources;
    }
    if (ocrConversion.tools) {
      updateData.tools = ocrConversion.tools;
    }

    if (updateData.tool_resources) {
      await pruneToolResourceFileIdsForAgent({
        tool_resources: updateData.tool_resources,
        ownerIds: req.user.id,
        existingToolResources: existingAgent.tool_resources,
        logPrefix: `[/Agents/:id] Agent ${id}`,
      });
    }

    if (await blockFilteredAgentContent(req, res, updateData)) {
      return;
    }

    const isMCPTool = (t) =>
      typeof t === 'string' && t.includes(Constants.mcp_delimiter) && !isActionTool(t);
    const hasToolUpdate = updateData.tools !== undefined;
    const editingOwnAgent = existingAgent.author?.toString() === req.user.id;
    const existingTools = existingAgent.tools ?? [];
    const effectiveTools = (hasToolUpdate ? updateData.tools : existingAgent.tools) ?? [];
    const requestedMCPTools = effectiveTools.filter(isMCPTool);
    const existingMCPTools = existingTools.filter(isMCPTool);

    if (requestedMCPTools.length > 0 || (hasToolUpdate && existingMCPTools.length > 0)) {
      const mcpPermissionContext = createMCPPermissionContext(req);
      if (!(await mcpPermissionContext.canUseServers(req.user))) {
        if (editingOwnAgent) {
          updateData.tools = effectiveTools.filter((t) => !isMCPTool(t));
          /** Every MCP tool just went away, so nothing should stay indexed. */
          updateData.mcpServerNames = [];
        } else if (hasToolUpdate) {
          const existingMCPToolSet = new Set(existingMCPTools);
          const nextTools = updateData.tools.filter(
            (t) => !isMCPTool(t) || existingMCPToolSet.has(t),
          );
          const nextToolSet = new Set(nextTools);
          for (const existingMCPTool of existingMCPTools) {
            if (!nextToolSet.has(existingMCPTool)) {
              nextTools.push(existingMCPTool);
            }
          }
          updateData.tools = nextTools;
          /** The agent's MCP tools are retained verbatim here, so carry its resolved
           *  names across too. Left unset when the agent has none stored, so
           *  `updateAgent` can still derive rather than being pinned to an empty
           *  index that would strip agent-scoped access. */
          if (existingAgent.mcpServerNames?.length) {
            updateData.mcpServerNames = existingAgent.mcpServerNames;
          }
        }
      } else if (hasToolUpdate) {
        const existingToolSet = new Set(existingTools);
        const newMCPTools = requestedMCPTools.filter((t) => !existingToolSet.has(t));
        /** Names resolved during authorization of the newly added tools. */
        const resolvedServerNames = new Set();

        if (newMCPTools.length > 0) {
          const [availableTools, configServers] = await Promise.all([
            getCachedTools().then((t) => t ?? {}),
            resolveConfigServers(req),
          ]);
          const approvedNew = await filterAuthorizedTools({
            tools: newMCPTools,
            userId: req.user.id,
            role: req.user.role,
            user: req.user,
            mcpPermissionContext,
            availableTools,
            configServers,
            resolvedServerNames,
          });
          const rejectedSet = new Set(newMCPTools.filter((t) => !approvedNew.includes(t)));
          if (rejectedSet.size > 0) {
            updateData.tools = updateData.tools.filter((t) => !rejectedSet.has(t));
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
        /** Supplying `[]` would pin the index empty and suppress `updateAgent`'s
         *  derivation, so only assert it when the result is authoritative: either we
         *  resolved names, or no MCP tool survives and the index genuinely is empty. */
        const retainsMCPTools = (updateData.tools ?? []).some(isMCPTool);
        if (resolvedServerNames.size > 0 || !retainsMCPTools) {
          updateData.mcpServerNames = Array.from(resolvedServerNames);
        }
      }
    }

    if (updateData.code_environment_id === null) {
      delete updateData.code_environment_id;
      updateData.$unset = { code_environment_id: 1 };
    }
    if (updateData.git_identity === null) {
      delete updateData.git_identity;
      updateData.$unset = { ...updateData.$unset, git_identity: 1 };
    }

    let updatedAgent =
      Object.keys(updateData).length > 0
        ? await db.updateAgent({ id }, updateData, {
            updatingUserId: req.user.id,
          })
        : existingAgent;

    // Add version count to the response
    updatedAgent.version = updatedAgent.versions ? updatedAgent.versions.length : 0;

    if (updatedAgent.author) {
      updatedAgent.author = updatedAgent.author.toString();
    }

    await attachOwnerContacts([updatedAgent]);

    if (updatedAgent.author !== req.user.id) {
      delete updatedAgent.author;
    }

    return res.json(updatedAgent);
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.error('[/Agents/:id] Validation error', error.errors);
      return res.status(400).json({ error: 'Invalid request data', details: error.errors });
    }

    logger.error('[/Agents/:id] Error updating Agent', error);

    if (error.statusCode === 409) {
      return res.status(409).json({
        error: error.message,
        details: error.details,
      });
    }

    res.status(500).json({ error: error.message });
  }
};

/**
 * Duplicates an Agent based on the provided ID.
 * @route POST /Agents/:id/duplicate
 * @param {object} req - Express Request
 * @param {object} req.params - Request params
 * @param {string} req.params.id - Agent identifier.
 * @returns {Promise<Agent>} 201 - success response - application/json
 */
const duplicateAgentHandler = async (req, res) => {
  const { id } = req.params;
  const { id: userId, role: userRole } = req.user;
  const sensitiveFields = ['api_key', 'oauth_client_id', 'oauth_client_secret'];

  try {
    const agent = await db.getAgent({ id });
    if (!agent) {
      return res.status(404).json({
        error: 'Agent not found',
        status: 'error',
      });
    }

    const {
      id: _id,
      _id: __id,
      author: _author,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      tool_resources: _tool_resources = {},
      versions: _versions,
      __v: _v,
      ...cloneData
    } = agent;
    cloneData.name = `${agent.name} (${new Date().toLocaleString('en-US', {
      dateStyle: 'short',
      timeStyle: 'short',
      hour12: false,
    })})`;

    if (_tool_resources?.[EToolResources.context]) {
      cloneData.tool_resources = {
        [EToolResources.context]: _tool_resources[EToolResources.context],
      };
    }

    if (_tool_resources?.[EToolResources.ocr]) {
      cloneData.tool_resources = {
        /** Legacy conversion from `ocr` to `context` */
        [EToolResources.context]: {
          ...(_tool_resources[EToolResources.context] ?? {}),
          ..._tool_resources[EToolResources.ocr],
        },
      };
    }

    const newAgentId = `agent_${nanoid()}`;
    const newAgentData = Object.assign(cloneData, {
      id: newAgentId,
      author: userId,
    });
    if (
      isActiveAgentWorkspaceConfiguration(newAgentData) &&
      !validateStatefulCodeEnvironment(
        req,
        res,
        newAgentData.stateful_code_sessions,
        newAgentData.stateful_code_environment,
        newAgentData.code_environment_id,
        false,
        newAgentData.code_workspace_id,
      )
    ) {
      return;
    }
    newAgentData.edges = replaceEdgeSourceId(newAgentData.edges, id, newAgentId);
    newAgentData.edges = replaceEdgeSourceId(newAgentData.edges, '', newAgentId);
    newAgentData.subagents = replaceAndValidateSubagentGraphAgentId(
      newAgentData.subagents,
      id,
      newAgentId,
    );
    newAgentData.subagents = replaceAndValidateSubagentGraphAgentId(
      newAgentData.subagents,
      '',
      newAgentId,
    );

    if (newAgentData.edges?.length) {
      const { missing, unauthorized } = await validateEdgeAgentReferences(
        newAgentData.edges,
        userId,
        userRole,
        new Set([newAgentId]),
      );
      if (missing.length > 0) {
        return res.status(400).json({
          error: 'One or more agents referenced in edges do not exist',
          agent_ids: missing,
        });
      }
      if (unauthorized.length > 0) {
        return res.status(403).json({
          error: 'You do not have access to one or more agents referenced in edges',
          agent_ids: unauthorized,
        });
      }
    }

    const subagentReferenceError = await getSubagentReferenceError(
      newAgentData.subagents,
      req,
      new Set([newAgentId]),
    );
    if (subagentReferenceError) {
      return res.status(subagentReferenceError.status).json(subagentReferenceError.body);
    }

    const originalActions = (await db.getActions({ agentId: id }, true)) ?? [];
    const sanitizedActions = originalActions.map((action) => {
      const metadata = { ...(action.metadata || {}) };
      for (const field of sensitiveFields) {
        delete metadata[field];
      }
      return { ...action, metadata };
    });

    if (newAgentData.tools?.length) {
      const [availableTools, configServers] = await Promise.all([
        getCachedTools().then((t) => t ?? {}),
        resolveConfigServers(req),
      ]);
      const mcpPermissionContext = createMCPPermissionContext(req);
      /** The duplicate carries the source agent's `mcpServerNames`; replace it with what
       *  this user is actually authorized for, or the copy would grant the source's servers. */
      const resolvedServerNames = new Set();
      newAgentData.tools = await filterAuthorizedTools({
        tools: newAgentData.tools,
        userId,
        role: req.user.role,
        user: req.user,
        mcpPermissionContext,
        availableTools,
        existingTools: newAgentData.tools,
        configServers,
        resolvedServerNames,
      });
      /** When the registry is unavailable, `filterAuthorizedTools` grandfathers the
       *  source's tools without resolving them, so carry forward the source names those
       *  retained tools still point at rather than blanking the index. */
      const sourceNames = agent.mcpServerNames ?? [];
      if (sourceNames.length > 0) {
        const sourceNameSet = new Set(sourceNames);
        for (const tool of newAgentData.tools ?? []) {
          if (typeof tool !== 'string' || !tool.includes(Constants.mcp_delimiter)) {
            continue;
          }
          const [, retainedName] = splitMCPToolKey(tool, sourceNames);
          if (retainedName && sourceNameSet.has(retainedName)) {
            resolvedServerNames.add(retainedName);
          }
        }
      }
      newAgentData.mcpServerNames = Array.from(resolvedServerNames);
    }

    if (newAgentData.tool_resources) {
      normalizeToolResourceFiles(newAgentData.tool_resources);
      await pruneToolResourceFileIdsForAgent({
        tool_resources: newAgentData.tool_resources,
        ownerIds: userId,
        logPrefix: '[/Agents/:id/duplicate]',
      });
    }

    if (
      (!isCodeInterpreterCapabilityEnabled(req) ||
        !newAgentData.tools?.includes(Tools.execute_code)) &&
      newAgentData.tool_options != null
    ) {
      newAgentData.tool_options = removeCodeExecutionCaller(newAgentData.tool_options);
    }

    if (
      (await blockFilteredAgentContent(req, res, newAgentData)) ||
      blockFilteredActionContent(req, res, sanitizedActions)
    ) {
      return;
    }

    const newActionsList = [];

    /**
     * Duplicates an action and returns the new action ID.
     * @param {Action} action
     * @returns {Promise<string>}
     */
    const duplicateAction = async (action) => {
      const newActionId = nanoid();
      const { domain } = action.metadata;
      const fullActionId = `${domain}${actionDelimiter}${newActionId}`;

      const newAction = await db.updateAction(
        { actionId: newActionId, agentId: newAgentId },
        {
          metadata: action.metadata,
          agent_id: newAgentId,
          user: userId,
        },
      );

      newActionsList.push(newAction);
      return fullActionId;
    };

    const agentActions = await Promise.all(
      sanitizedActions.map((action) =>
        duplicateAction(action).catch((error) => {
          logger.error('[/agents/:id/duplicate] Error duplicating Action:', error);
        }),
      ),
    );
    newAgentData.actions = agentActions;

    let newAgent;
    try {
      newAgent = await db.createAgent(newAgentData);
    } catch (error) {
      await db.deleteActions({ agentId: newAgentId, user: userId }).catch((cleanupError) => {
        logger.error(
          '[/agents/:id/duplicate] Failed to clean up cloned Actions after Agent creation failed:',
          cleanupError,
        );
      });
      throw error;
    }

    try {
      await Promise.all([
        grantPermission({
          principalType: PrincipalType.USER,
          principalId: userId,
          resourceType: ResourceType.AGENT,
          resourceId: newAgent._id,
          accessRoleId: AccessRoleIds.AGENT_OWNER,
          grantedBy: userId,
        }),
        grantPermission({
          principalType: PrincipalType.USER,
          principalId: userId,
          resourceType: ResourceType.REMOTE_AGENT,
          resourceId: newAgent._id,
          accessRoleId: AccessRoleIds.REMOTE_AGENT_OWNER,
          grantedBy: userId,
        }),
      ]);
      logger.debug(
        `[duplicateAgent] Granted owner permissions to user ${userId} for duplicated agent ${newAgent.id}`,
      );
    } catch (permissionError) {
      logger.error(
        `[duplicateAgent] Failed to grant owner permissions for duplicated agent ${newAgent.id}:`,
        permissionError,
      );
    }

    return res.status(201).json({
      agent: newAgent,
      actions: newActionsList,
    });
  } catch (error) {
    logger.error('[/Agents/:id/duplicate] Error duplicating Agent:', error);
    if (error?.statusCode === 409) {
      return res.status(409).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
};

/**
 * Deletes an Agent based on the provided ID.
 * @route DELETE /Agents/:id
 * @param {object} req - Express Request
 * @param {object} req.params - Request params
 * @param {string} req.params.id - Agent identifier.
 * @returns {Promise<Agent>} 200 - success response - application/json
 */
const deleteAgentHandler = async (req, res) => {
  try {
    const id = req.params.id;
    const agent = await db.getAgent({ id });
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    await db.deleteAgent({ id });
    return res.json({ message: 'Agent deleted' });
  } catch (error) {
    logger.error('[/Agents/:id] Error deleting Agent', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Lists agents using ACL permissions or the manage:agents capability.
 * @route GET /Agents
 * @param {object} req - Express Request
 * @param {object} req.query - Request query
 * @param {string} [req.query.user] - The user ID of the agent's author.
 * @param {string} [req.query.sort] - One of 'newest' | 'oldest' | 'popular' | 'author'.
 *   Invalid, repeated and missing values leave the order unset, so the endpoint keeps
 *   serving its most-recently-edited order; the marketplace asks for 'newest' explicitly.
 * @param {string} [req.query.mine] - '1' to restrict results to agents authored by the
 *   caller; any other value is ignored.
 * @returns {Promise<AgentListResponse>} 200 - success response - application/json
 */
const getListAgentsHandler = async (req, res) => {
  try {
    const userId = req.user.id;
    const { category, search, limit = 100, cursor, promoted } = req.query;
    const listQuery = resolveMarketplaceListQuery(req.query);
    const sortMode = listQuery.sort;
    let requiredPermission = req.query.requiredPermission;
    if (typeof requiredPermission === 'string') {
      requiredPermission = parseInt(requiredPermission, 10);
      if (isNaN(requiredPermission)) {
        requiredPermission = PermissionBits.VIEW;
      }
    } else if (typeof requiredPermission !== 'number') {
      requiredPermission = PermissionBits.VIEW;
    }
    const canReturnSkillConfig = hasEditBit(requiredPermission);
    // Base filter
    const filter = {};

    // Handle category filter - only apply if category is defined
    if (category !== undefined && category.trim() !== '') {
      filter.category = category;
    }

    // Handle promoted filter - only from query param
    if (promoted === '1') {
      filter.is_promoted = true;
    } else if (promoted === '0') {
      filter.is_promoted = { $ne: true };
    }

    // "Only my agents": the contribution comes from `marketplaceMineFilter`, which owns
    // what the filter says; this merges it on top of the ACL-resolved `accessibleIds`.
    Object.assign(filter, marketplaceMineFilter(listQuery, userId));

    // Handle search filter (escape regex and cap length)
    if (search && search.trim() !== '') {
      const safeSearch = escapeRegex(search.trim().slice(0, MAX_SEARCH_LEN));
      const regex = new RegExp(safeSearch, 'i');
      filter.$or = [{ name: regex }, { description: regex }];
    }

    const cache = getLogStores(CacheKeys.S3_EXPIRY_INTERVAL);
    const refreshKey = getAgentListAvatarRefreshKey(req.user);

    /**
     * These reads share no inputs, so they resolve together rather than chaining round
     * trips ahead of the list query. The viewer skill scope and the editable set are only
     * consumed when the page is non-empty; dispatching them here trades a wasted lookup on
     * the (cheap) zero-agent path for one less serial hop on every populated page.
     *
     * `editableIds` lets a VIEW-scoped response mark which agents the caller may also edit,
     * so consumers wanting just the editable subset can filter one shared VIEW fetch rather
     * than issuing a second full paginated walk under an EDIT-scoped cache key. Managers and
     * EDIT-scoped requests need no separate edit lookup: everything they match is editable.
     *
     * `idOnTheSource` is forwarded so `getUserPrincipals` resolves identity without reading
     * the user document; the auth strategies already normalize it to a value or null. Each
     * omission would cost this handler another `User.findById`, once per lookup.
     */
    const { idOnTheSource } = req.user;
    const [
      { accessibleIds, editableIds },
      publiclyAccessibleIds,
      cachedRefreshEntry,
      accessibleSkillIds,
    ] = await Promise.all([
      getAgentListAccess(req.user, requiredPermission, { hasCapability, findAccessibleResources }),
      findPubliclyAccessibleResources({
        resourceType: ResourceType.AGENT,
        requiredPermissions: PermissionBits.VIEW,
      }),
      cache.get(refreshKey),
      canReturnSkillConfig
        ? null
        : findAccessibleResources({
            userId,
            role: req.user.role,
            idOnTheSource,
            resourceType: ResourceType.SKILL,
            requiredPermissions: PermissionBits.VIEW,
          }),
    ]);

    // Use the ACL-aware function before refreshing so the requested ordering and page
    // determine which avatars receive bounded S3 work.
    const data = await db.getListAgentsByAccess({
      accessibleIds,
      tenantId: req.user.tenantId ?? null,
      otherParams: filter,
      limit,
      after: cursor,
      includeSkillConfig: true,
      includeExecutionConfig: true,
      sort: sortMode,
    });
    const agents = data?.data ?? [];

    const cachedRefresh = await resolveAvatarRefresh({
      agents,
      userId,
      cachedRefreshEntry,
      cache,
      refreshKey,
      cacheTtl: Time.THIRTY_MINUTES,
      coverageLimit: req.config?.endpoints?.[EModelEndpoint.agents]?.avatarRefresh?.coverageLimit,
      refreshS3Url,
      updateAgent: db.updateAgentAvatar,
    });

    if (!agents.length) {
      return res.json(data);
    }

    const accessibleSkillSet = canReturnSkillConfig
      ? null
      : new Set(mergeDeploymentSkillIds(accessibleSkillIds).map((oid) => oid.toString()));

    const publicSet = new Set(publiclyAccessibleIds.map((oid) => oid.toString()));
    /** Null for EDIT-scoped requests, where every matched agent is editable by definition. */
    const editableSet = editableIds ? new Set(editableIds) : null;
    const agentsWithContacts = await attachOwnerContacts(agents);

    data.data = agentsWithContacts.map((agent) => {
      if (accessibleSkillSet) {
        sanitizeViewerSkillScope(agent, accessibleSkillSet);
      }
      try {
        if (agent?._id && publicSet.has(agent._id.toString())) {
          agent.isPublic = true;
        }
        agent.isEditable = editableSet == null || editableSet.has(agent?._id?.toString());
        return applyCachedAvatarUrl(agent, cachedRefresh);
      } catch (err) {
        logger.warn('[/Agents] Error mapping agent %s for list response: %o', agent?.id, err);
      }
      return agent;
    });

    return res.json(data);
  } catch (error) {
    const mappedError = mapMarketplaceListError(error);
    if (mappedError) {
      return res.status(mappedError.status).json(mappedError.body);
    }
    logger.error('[/Agents] Error listing Agents: %o', error);
    return res.status(500).json({ error: error.message });
  }
};

/**
 * Uploads and updates an avatar for a specific agent.
 * @route POST /:agent_id/avatar
 * @param {object} req - Express Request
 * @param {object} req.params - Request params
 * @param {string} req.params.agent_id - The ID of the agent.
 * @param {Express.Multer.File} req.file - The avatar image file.
 * @param {object} req.body - Request body
 * @param {string} [req.body.avatar] - Optional avatar for the agent's avatar.
 * @returns {Promise<void>} 200 - success response - application/json
 */
const uploadAgentAvatarHandler = async (req, res) => {
  try {
    const appConfig = req.config;
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }
    filterFile({ req, file: req.file, image: true, isAvatar: true });
    if (hasActiveFileFieldPolicy(req.config?.filters, ['name', 'content'])) {
      const finding = inspectContent(extractFileContent({ name: req.file.originalname }), {
        filters: req.config.filters,
      });
      if (finding != null) {
        return res.status(400).json(contentFilterBlockResponse(finding));
      }
      const uninspectableField = getBlockedUninspectableFileField(req.config.filters, ['content']);
      if (uninspectableField != null) {
        return res.status(400).json(contentFilterUninspectableResponse(uninspectableField));
      }
    }

    const { agent_id } = req.params;
    if (!agent_id) {
      return res.status(400).json({ message: 'Agent ID is required' });
    }

    const existingAgent = await db.getAgent({ id: agent_id });

    if (!existingAgent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const buffer = await fs.readFile(req.file.path);
    const fileStrategy = getFileStrategy(appConfig, { isAvatar: true });
    const resizedBuffer = await resizeAvatar({
      userId: req.user.id,
      input: buffer,
    });

    const { processAvatar } = getStrategyFunctions(fileStrategy);
    const avatarUrl = await processAvatar({
      buffer: resizedBuffer,
      userId: req.user.id,
      manual: 'false',
      agentId: agent_id,
      tenantId: req.user.tenantId,
    });

    const image = {
      filepath: avatarUrl,
      source: fileStrategy,
    };

    let _avatar = existingAgent.avatar;

    if (_avatar && _avatar.source) {
      const { deleteFile } = getStrategyFunctions(_avatar.source);
      try {
        await deleteFile(req, {
          filepath: _avatar.filepath,
          user: req.user.id,
          tenantId: req.user.tenantId,
        });
        await db.deleteFileByFilter({ user: req.user.id, filepath: _avatar.filepath });
      } catch (error) {
        logger.error('[/:agent_id/avatar] Error deleting old avatar', error);
      }
    }

    const data = {
      avatar: {
        filepath: image.filepath,
        source: image.source,
      },
    };

    const updatedAgent = await db.updateAgent({ id: agent_id }, data, {
      updatingUserId: req.user.id,
    });
    await attachOwnerContacts([updatedAgent]);

    try {
      const avatarCache = getLogStores(CacheKeys.S3_EXPIRY_INTERVAL);
      await avatarCache.delete(getAgentListAvatarRefreshKey(req.user));
    } catch (cacheErr) {
      logger.error('[/:agent_id/avatar] Error invalidating avatar refresh cache', cacheErr);
    }

    res.status(201).json(updatedAgent);
  } catch (error) {
    const message = 'An error occurred while updating the Agent Avatar';
    logger.error(
      `[/:agent_id/avatar] ${message} (${req.params?.agent_id ?? 'unknown agent'})`,
      error,
    );
    res.status(500).json({ message });
  } finally {
    try {
      await fs.unlink(req.file.path);
      logger.debug('[/:agent_id/avatar] Temp. image upload file deleted');
    } catch {
      logger.debug('[/:agent_id/avatar] Temp. image upload file already deleted');
    }
  }
};

/**
 * Reverts an agent to a previous version from its version history.
 * @route PATCH /agents/:id/revert
 * @param {object} req - Express Request object
 * @param {object} req.params - Request parameters
 * @param {string} req.params.id - The ID of the agent to revert
 * @param {object} req.body - Request body
 * @param {number} req.body.version_index - The index of the version to revert to
 * @param {object} req.user - Authenticated user information
 * @param {string} req.user.id - User ID
 * @param {string} req.user.role - User role
 * @param {ServerResponse} res - Express Response object
 * @returns {Promise<Agent>} 200 - The updated agent after reverting to the specified version
 * @throws {Error} 400 - If version_index is missing
 * @throws {Error} 403 - If user doesn't have permission to modify the agent
 * @throws {Error} 404 - If agent not found
 * @throws {Error} 500 - If there's an internal server error during the reversion process
 */
const revertAgentVersionHandler = async (req, res) => {
  try {
    const { id } = req.params;
    const { version_index } = req.body;

    if (version_index === undefined) {
      return res.status(400).json({ error: 'version_index is required' });
    }

    const existingAgent = await db.getAgent({ id }, {});

    if (!existingAgent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const revertVersion = existingAgent.versions?.[version_index];
    const restoredWorkspaceConfiguration = revertVersion
      ? resolveAgentWorkspaceRestoreConfiguration({
          version: revertVersion,
          current: existingAgent,
        })
      : undefined;
    if (
      isActiveAgentWorkspaceConfiguration(restoredWorkspaceConfiguration) &&
      !validateStatefulCodeEnvironment(
        req,
        res,
        restoredWorkspaceConfiguration.stateful_code_sessions,
        restoredWorkspaceConfiguration.stateful_code_environment,
        restoredWorkspaceConfiguration.code_environment_id,
        false,
        restoredWorkspaceConfiguration.code_workspace_id,
      )
    ) {
      return;
    }
    const storedRevertEdges = Array.isArray(revertVersion?.edges) ? revertVersion.edges : [];
    const revertEdges = replaceEdgeSourceId(storedRevertEdges, '', id);
    const hasLegacyEdgeSource = storedRevertEdges.some((edge) =>
      Array.isArray(edge.from) ? edge.from.includes('') : edge.from === '',
    );
    if (revertEdges.length > 0) {
      const { missing, unauthorized } = await validateEdgeAgentReferences(
        revertEdges,
        req.user.id,
        req.user.role,
      );
      if (missing.length > 0) {
        return res.status(400).json({
          error: 'One or more agents referenced in edges do not exist',
          agent_ids: missing,
        });
      }
      if (unauthorized.length > 0) {
        return res.status(403).json({
          error: 'You do not have access to one or more agents referenced in edges',
          agent_ids: unauthorized,
        });
      }
    }

    const subagentReferenceError = await getSubagentReferenceError(revertVersion?.subagents, req);
    if (subagentReferenceError) {
      return res.status(subagentReferenceError.status).json(subagentReferenceError.body);
    }

    // Permissions are enforced via route middleware (ACL EDIT)

    const actionIds = (revertVersion?.actions ?? [])
      .map((action) => (typeof action === 'string' ? action.split(actionDelimiter)[1] : undefined))
      .filter(Boolean);
    const actions =
      actionIds.length > 0
        ? ((await db.getActions({ agentId: id, actionId: actionIds }, true)) ?? [])
        : [];

    if (
      (await blockFilteredAgentContent(req, res, revertVersion)) ||
      blockFilteredActionContent(req, res, actions)
    ) {
      return;
    }

    let updatedAgent = await db.revertAgentVersion({ id }, version_index);
    const revertUpdates = {};
    if (
      revertVersion &&
      (hasLegacyEdgeSource || (!Array.isArray(revertVersion.edges) && updatedAgent.edges?.length))
    ) {
      revertUpdates.edges = revertEdges;
    }

    if (updatedAgent.tools?.length) {
      const [availableTools, configServers] = await Promise.all([
        getCachedTools().then((t) => t ?? {}),
        resolveConfigServers(req),
      ]);
      const mcpPermissionContext = createMCPPermissionContext(req);
      const filteredTools = await filterAuthorizedTools({
        tools: updatedAgent.tools,
        userId: req.user.id,
        role: req.user.role,
        user: req.user,
        mcpPermissionContext,
        availableTools,
        existingTools: updatedAgent.tools,
        configServers,
      });
      if (filteredTools.length !== updatedAgent.tools.length) {
        revertUpdates.tools = filteredTools;
      }
    }

    const effectiveRevertTools = revertUpdates.tools ?? updatedAgent.tools;
    const hasCodeExecutionCaller = Object.values(updatedAgent.tool_options ?? {}).some((options) =>
      options.allowed_callers?.includes('code_execution'),
    );
    if (
      (!isCodeInterpreterCapabilityEnabled(req) ||
        !effectiveRevertTools?.includes(Tools.execute_code)) &&
      hasCodeExecutionCaller
    ) {
      revertUpdates.tool_options = removeCodeExecutionCaller(updatedAgent.tool_options);
    }

    if (updatedAgent.tool_resources) {
      const hadHydratedToolResourceFiles = Object.values(updatedAgent.tool_resources).some(
        (resource) => Array.isArray(resource?.files),
      );
      normalizeToolResourceFiles(updatedAgent.tool_resources);
      const removedCount = await pruneToolResourceFileIdsForAgent({
        tool_resources: updatedAgent.tool_resources,
        ownerIds: req.user.id,
        existingToolResources: existingAgent.tool_resources,
        logPrefix: '[/Agents/:id/revert]',
      });
      if (hadHydratedToolResourceFiles || removedCount > 0) {
        revertUpdates.tool_resources = updatedAgent.tool_resources;
      }
    }

    if (Object.keys(revertUpdates).length > 0) {
      updatedAgent = await db.updateAgent({ id }, revertUpdates, { updatingUserId: req.user.id });
    }

    if (updatedAgent.author) {
      updatedAgent.author = updatedAgent.author.toString();
    }

    await attachOwnerContacts([updatedAgent]);

    if (updatedAgent.author !== req.user.id) {
      delete updatedAgent.author;
    }

    return res.json(updatedAgent);
  } catch (error) {
    logger.error('[/agents/:id/revert] Error reverting Agent version', error);
    if (error?.statusCode === 409) {
      return res.status(409).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
};
/**
 * Get all agent categories with counts
 *
 * @param {Object} _req - Express request object (unused)
 * @param {Object} res - Express response object
 */
const getAgentCategories = async (_req, res) => {
  try {
    const categories = await db.getCategoriesWithCounts();
    const promotedCount = await db.countPromotedAgents();
    const formattedCategories = categories.map((category) => ({
      value: category.value,
      label: category.label,
      count: category.agentCount,
      description: category.description,
    }));

    if (promotedCount > 0) {
      formattedCategories.unshift({
        value: 'promoted',
        label: 'Promoted',
        count: promotedCount,
        description: 'Our recommended agents',
      });
    }

    formattedCategories.push({
      value: 'all',
      label: 'All',
      description: 'All available agents',
    });

    res.status(200).json(formattedCategories);
  } catch (error) {
    logger.error('[/Agents/Marketplace] Error fetching agent categories:', error);
    res.status(500).json({
      error: 'Failed to fetch agent categories',
      userMessage: 'Unable to load categories. Please refresh the page.',
      suggestion: 'Try refreshing the page or check your network connection',
    });
  }
};
module.exports = {
  createAgent: createAgentHandler,
  getAgent: getAgentHandler,
  getAgentVersions: getAgentVersionsHandler,
  updateAgent: updateAgentHandler,
  duplicateAgent: duplicateAgentHandler,
  deleteAgent: deleteAgentHandler,
  getListAgents: getListAgentsHandler,
  uploadAgentAvatar: uploadAgentAvatarHandler,
  revertAgentVersion: revertAgentVersionHandler,
  getAgentCategories,
  filterAuthorizedTools,
};
