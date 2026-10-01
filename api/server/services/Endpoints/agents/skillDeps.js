const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { batchUploadCodeEnvFiles } = require('~/server/services/Files/Code/crud');
const {
  getSessionInfo,
  checkIfActive,
  readWorkspaceFile,
  searchWorkspace,
  listWorkspaceFiles,
  writeWorkspaceFile,
  previewWorkspaceEdit,
  editWorkspaceFile,
  readSandboxFile,
  readSandboxImage,
  writeSandboxFile,
} = require('~/server/services/Files/Code/process');
const {
  checkAccess,
  isMemoryEnabled,
  resolveRequestTenantId,
  enrichWithSkillConfigurable,
  mergeDeploymentSkillIds,
  createDeploymentSkillMethods,
  createSkillFileSaver,
  createSkillManagementFileSaver,
  isDeploymentSkillFileSource,
  getDeploymentSkillDownloadStream,
} = require('@librechat/api');
const {
  Permissions,
  FileContext,
  ResourceType,
  PermissionBits,
  AccessRoleIds,
  PrincipalType,
  PermissionTypes,
  AgentCapabilities,
  isEphemeralAgentId,
} = require('librechat-data-provider');
const { checkPermission, grantPermission } = require('~/server/services/PermissionService');
const { getFileStrategy } = require('~/server/utils/getFileStrategy');
const db = require('~/models');

const deploymentSkillMethods = createDeploymentSkillMethods({
  getSkillById: db.getSkillById,
  getSkillByName: db.getSkillByName,
  listSkillsByAccess: db.listSkillsByAccess,
  listAlwaysApplySkills: db.listAlwaysApplySkills,
  listSkillFiles: db.listSkillFiles,
  getSkillFileByPath: db.getSkillFileByPath,
  updateSkillFileContent: db.updateSkillFileContent,
  updateSkillFileCodeEnvIds: db.updateSkillFileCodeEnvIds,
});

function getSkillDbMethods() {
  return deploymentSkillMethods;
}

function withDeploymentSkillIds(ids = []) {
  return mergeDeploymentSkillIds(ids);
}

function getSkillStrategyFunctions(source) {
  if (isDeploymentSkillFileSource(source)) {
    return {
      getDownloadStream: (_req, filepath) => getDeploymentSkillDownloadStream(filepath),
    };
  }
  return getStrategyFunctions(source);
}

function resolveSkillStorage(req, { isImage = false } = {}) {
  const source = getFileStrategy(req.config, { context: FileContext.skill_file, isImage });
  const strategy = getStrategyFunctions(source);
  if (!strategy.saveBuffer) {
    throw new Error(`Storage backend "${source}" does not support file writes`);
  }
  return { saveBuffer: strategy.saveBuffer, source };
}

const skillFileSaveDeps = {
  getSkillFileByPath: db.getSkillFileByPath,
  upsertSkillFile: db.upsertSkillFile,
  resolveStorage: resolveSkillStorage,
  getStrategyFunctions,
};
const saveSkillFileContent = createSkillFileSaver(skillFileSaveDeps);
const saveSkillManagementFileContent = createSkillManagementFileSaver(skillFileSaveDeps);

function getSkillManagementFileSaver() {
  return saveSkillManagementFileContent;
}

function canCreateSkill({ req }) {
  return checkAccess({
    req,
    user: req.user,
    permissionType: PermissionTypes.SKILLS,
    permissions: [Permissions.USE, Permissions.CREATE],
    getRoleByName: db.getRoleByName,
  });
}

function canEditSkill({ req, skillId }) {
  return checkPermission({
    userId: req.user.id,
    role: req.user.role,
    resourceType: ResourceType.SKILL,
    resourceId: skillId,
    requiredPermission: PermissionBits.EDIT,
  });
}

function isAgentSkillAuthoringEnabledForRun({
  agent,
  skillsCapabilityEnabled,
  ephemeralSkillsToggle,
}) {
  if (!skillsCapabilityEnabled) {
    return false;
  }
  if (isEphemeralAgentId(agent.id)) {
    if (agent.skills_enabled === false) {
      return false;
    }
    if (agent.skills_enabled === true) {
      return true;
    }
    return ephemeralSkillsToggle === true;
  }
  return agent.skills_enabled === true || agent.skill_authoring_enabled === true;
}

function canAuthorSkillFiles({
  agent,
  scopedEditableSkillIds = [],
  skillCreateAllowed,
  skillsCapabilityEnabled,
  ephemeralSkillsToggle,
}) {
  return (
    isAgentSkillAuthoringEnabledForRun({
      agent,
      skillsCapabilityEnabled,
      ephemeralSkillsToggle,
    }) &&
    (scopedEditableSkillIds.length > 0 || skillCreateAllowed === true)
  );
}

function grantSkillOwner({ req, skillId }) {
  return grantPermission({
    principalType: PrincipalType.USER,
    principalId: req.user.id,
    resourceType: ResourceType.SKILL,
    resourceId: skillId,
    accessRoleId: AccessRoleIds.SKILL_OWNER,
    grantedBy: req.user.id,
  });
}

function getAuthorSkillByName({ req, name }) {
  const author = req.user?._id ?? req.user?.id;
  if (!author) {
    return null;
  }
  return db.getAuthorSkillByName({
    name,
    author,
    tenantId: resolveRequestTenantId(req),
  });
}

/**
 * Builds the `skillPrimedIdsByName` map threaded through
 * `buildAgentToolContext`. Centralized here so every runtime route shares
 * one source of truth — if `ResolvedManualSkill` ever renames `_id` or
 * gains new identifying fields, only this helper changes.
 *
 * Combines both manual (`$`-popover) primes AND always-apply primes so
 * `read_file` can:
 *  - Relax the `disable-model-invocation: true` gate for either source
 *    (the body is already in context; blocking its own files would be
 *    nonsensical).
 *  - Pin same-name collision lookups to the exact `_id` the resolver
 *    primed (otherwise a newer same-name duplicate could shadow the
 *    body/file pair within a single turn).
 *
 * On the rare overlap (a name appears in both arrays because upstream
 * dedup was skipped), manual wins — manual invocation is explicit user
 * intent and carries the authoritative `_id` for this turn.
 *
 * Returns `undefined` (not `{}`) when both arrays are empty, so the
 * downstream `enrichWithSkillConfigurable` cleanly omits the field from
 * `mergedConfigurable` rather than threading an empty object.
 *
 * @param {Array<{ name: string, _id: { toString(): string } }> | undefined} manualSkillPrimes
 * @param {Array<{ name: string, _id: { toString(): string } }> | undefined} alwaysApplySkillPrimes
 * @returns {Record<string, string> | undefined}
 */
function buildSkillPrimedIdsByName(manualSkillPrimes, alwaysApplySkillPrimes) {
  const manualCount = manualSkillPrimes?.length ?? 0;
  const alwaysApplyCount = alwaysApplySkillPrimes?.length ?? 0;
  if (manualCount === 0 && alwaysApplyCount === 0) {
    return undefined;
  }
  const out = {};
  /* Order matters on the edge case where the same name appears in both
     lists: always-apply goes in first, then manual overwrites — manual
     wins because it's explicit user intent for this turn. */
  if (alwaysApplyCount > 0) {
    for (const p of alwaysApplySkillPrimes) {
      out[p.name] = p._id.toString();
    }
  }
  if (manualCount > 0) {
    for (const p of manualSkillPrimes) {
      out[p.name] = p._id.toString();
    }
  }
  return out;
}

/**
 * Builds the per-agent context consumed by ON_TOOL_EXECUTE. Keeping this
 * shape in one Adapter gives every runtime path the same configurable
 * fields and the same primed-skill pinning behavior.
 *
 * @param {object} params
 * @param {object} params.agent
 * @param {object} params.config
 * @param {Record<string, import('@librechat/api').LCAvailableTools>} [params.config.mcpAvailableTools]
 * @param {import('@librechat/api').RequestScopedMCPConnectionStore} [params.config.requestScopedConnections]
 * @returns {object}
 */
function buildAgentToolContext({ agent, config }) {
  return {
    agent,
    fileEncodingAgent: {
      provider: config.provider,
      model_parameters: config.model_parameters,
      imageDetail: config.imageDetail,
      agentContextAttachments: config.agentContextAttachments,
      fileConsumers: config.fileConsumers,
      deliveryRouting: config.deliveryRouting,
    },
    /** Per-agent resolved endpoint token/pricing config. Retained here because
     *  `agentToolContexts` is the one map that holds every agent — including
     *  pure subagents pruned from `agentConfigs` — so usage can be priced with
     *  the producing agent's config in multi-endpoint graphs. */
    endpointTokenConfig: config.endpointTokenConfig,
    toolRegistry: config.toolRegistry,
    backgroundToolNames: config.backgroundToolNames,
    intentToolNames: config.intentToolNames,
    mcpAvailableTools: config.mcpAvailableTools,
    requestScopedConnections: config.requestScopedConnections,
    userMCPAuthMap: config.userMCPAuthMap,
    tool_resources: config.tool_resources,
    actionsEnabled: config.actionsEnabled,
    accessibleMcpServerNames: config.accessibleMcpServerNames,
    accessibleSkillIds: config.accessibleSkillIds,
    activeSkillNames: config.activeSkillNames,
    codeEnvAvailable: config.codeEnvAvailable,
    codeExecutionContext: config.codeExecutionContext,
    skillAuthoringAvailable: config.skillAuthoringAvailable,
    fileAuthoringToolNames: config.fileAuthoringToolNames,
    skillPrimedIdsByName:
      buildSkillPrimedIdsByName(config.manualSkillPrimes, config.alwaysApplySkillPrimes) ?? {},
    provisionState: config.provisionState,
  };
}

/** Resolves the full run-level gate used to expose inline memory tools. */
function resolveMemoryAvailability({ enabledCapabilities, memoryConfig, user, getRoleByName }) {
  if (
    !enabledCapabilities.has(AgentCapabilities.memory) ||
    !isMemoryEnabled(memoryConfig) ||
    user?.personalization?.memories === false
  ) {
    return false;
  }
  return checkAccess({
    user,
    permissionType: PermissionTypes.MEMORIES,
    permissions: [Permissions.USE, Permissions.CREATE, Permissions.UPDATE],
    getRoleByName,
  });
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value ?? {}, key);
}

/**
 * Applies per-agent runtime context to a loadToolsForExecution result.
 *
 * @param {object} params
 * @param {{ loadedTools: unknown[], configurable?: Record<string, unknown> }} params.result
 * @param {object} params.req
 * @param {object | undefined} params.ctx
 * @param {object | undefined} [params.fallback]
 * @returns {{ loadedTools: unknown[], configurable: Record<string, unknown> }}
 */
function enrichLoadedToolsWithAgentContext({ result, req, ctx = {}, fallback = {} }) {
  const codeEnvAvailable = hasOwn(ctx, 'codeEnvAvailable')
    ? ctx.codeEnvAvailable === true
    : fallback.codeEnvAvailable === true;
  const skillAuthoringAvailable = hasOwn(ctx, 'skillAuthoringAvailable')
    ? ctx.skillAuthoringAvailable === true
    : fallback.skillAuthoringAvailable === true;

  return enrichWithSkillConfigurable({
    result,
    context: {
      req,
      codeEnvAvailable,
      accessibleSkillIds: ctx.accessibleSkillIds ?? fallback.accessibleSkillIds,
      skillPrimedIdsByName: ctx.skillPrimedIdsByName ?? fallback.skillPrimedIdsByName,
      activeSkillNames: ctx.activeSkillNames ?? fallback.activeSkillNames,
      skillAuthoringAvailable,
      fileAuthoringToolNames: ctx.fileAuthoringToolNames ?? fallback.fileAuthoringToolNames,
    },
  });
}

/** Skill-related properties for ToolExecuteOptions (stable references, allocated once). */
const skillToolDeps = {
  getSkillByName: deploymentSkillMethods.getSkillByName,
  getAuthorSkillByName,
  createSkill: db.createSkill,
  updateSkill: db.updateSkill,
  deleteSkill: db.deleteSkill,
  canCreateSkill,
  canEditSkill,
  grantSkillOwner,
  saveSkillFileContent,
  listSkillFiles: deploymentSkillMethods.listSkillFiles,
  getStrategyFunctions: getSkillStrategyFunctions,
  batchUploadCodeEnvFiles,
  getSessionInfo,
  checkIfActive,
  updateSkillFileCodeEnvIds: deploymentSkillMethods.updateSkillFileCodeEnvIds,
  getSkillFileByPath: deploymentSkillMethods.getSkillFileByPath,
  updateSkillFileContent: deploymentSkillMethods.updateSkillFileContent,
  readWorkspaceFile,
  searchWorkspace,
  listWorkspaceFiles,
  writeWorkspaceFile,
  previewWorkspaceEdit,
  editWorkspaceFile,
  /**
   * `read_file` falls back to a sandbox `cat` for `/mnt/data/...` paths
   * and for `{firstSegment}/...` paths whose first segment isn't a known
   * skill name. The handler routes through this when the agent has code
   * execution enabled; the codeapi base URL comes from
   * `LIBRECHAT_CODE_BASEURL` and the sandbox session id is forwarded by
   * the agents-side `ToolNode` via `tc.codeSessionContext`.
   */
  readSandboxFile,
  /**
   * Companion to `readSandboxFile` for the raster-image case: pulls the
   * bytes base64-encoded (size-guarded in-sandbox) so `read_file` can
   * return an image the model can see instead of refusing it as binary.
   */
  readSandboxImage,
  writeSandboxFile,
};

function getSkillToolDeps() {
  return skillToolDeps;
}

module.exports = {
  getSkillToolDeps,
  getSkillManagementFileSaver,
  canAuthorSkillFiles,
  isAgentSkillAuthoringEnabledForRun,
  getSkillDbMethods,
  withDeploymentSkillIds,
  getSkillStrategyFunctions,
  enrichWithSkillConfigurable,
  buildSkillPrimedIdsByName,
  buildAgentToolContext,
  resolveMemoryAvailability,
  enrichLoadedToolsWithAgentContext,
};
