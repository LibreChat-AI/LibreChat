const { logger } = require('@librechat/data-schemas');
const {
  ADDED_AGENT_ID,
  initializeAgent,
  validateAgentModel,
  resolveAgentScopedSkillIds,
  resolveModelSpecSkillIds,
  loadAddedAgent: loadAddedAgentFn,
} = require('@librechat/api');
const { isEphemeralAgentId } = require('librechat-data-provider');
const { filterFilesByAgentAccess } = require('~/server/services/Files/permissions');
const { getMCPServerTools } = require('~/server/services/Config');
const { getAccessibleMcpServerNames, getAccessibleMCPServers } = require('~/server/services/MCP');
const { isFatalAgentInitializationError } = require('~/server/services/ToolService');
const { getSkillDbMethods, canAuthorSkillFiles } = require('./skillDeps');
const db = require('~/models');

const loadAddedAgent = (params) =>
  loadAddedAgentFn(params, {
    getAgent: db.getAgentWithVersionCount,
    getMCPServerTools,
    getAccessibleMCPServers,
  });

/**
 * Process addedConvo for parallel agent execution.
 * Creates a parallel agent config from an added conversation.
 *
 * When an added agent has no incoming edges, it becomes a start node
 * and runs in parallel with the primary agent automatically.
 *
 * Edge cases handled:
 * - Primary agent has edges (handoffs): Added agent runs in parallel with primary,
 *   but doesn't participate in the primary's handoff graph
 * - Primary agent has agent_ids (legacy chain): Added agent runs in parallel with primary,
 *   but doesn't participate in the chain
 * - Primary agent has both: Added agent is independent, runs parallel from start
 *
 * @param {Object} params
 * @param {import('express').Request} params.req
 * @param {import('express').Response} params.res
 * @param {Object} params.endpointOption - The endpoint option containing addedConvo
 * @param {Object} params.modelsConfig - The models configuration
 * @param {Function} params.logViolation - Function to log violations
 * @param {Function} params.loadTools - Function to load agent tools
 * @param {Array} params.requestFiles - Request files
 * @param {string} params.conversationId - The conversation ID
 * @param {string} [params.parentMessageId] - The parent message ID for thread filtering
 * @param {import('@librechat/api').MCPRuntimeRequestBody} [params.requestBody]
 * @param {Set} params.allowedProviders - Set of allowed providers
 * @param {Map} params.agentConfigs - Map of agent configs to add to
 * @param {string} params.primaryAgentId - The primary agent ID
 * @param {Object|undefined} params.userMCPAuthMap - User MCP auth map to merge into
 * @param {Array} [params.accessibleSkillIds] - Full VIEW-accessible skill IDs for the user
 * @param {Array} [params.editableSkillIds] - Full EDIT-accessible skill IDs for the user
 * @param {boolean} [params.skillsCapabilityEnabled] - Whether endpoint Skills are enabled
 * @param {boolean} [params.ephemeralSkillsToggle] - Per-request ephemeral Skills badge state
 * @param {boolean} [params.skillCreateAllowed] - Whether the user can create Skills
 * @param {Record<string, boolean>} [params.skillStates] - Per-user Skill active overrides
 * @param {boolean} [params.defaultActiveOnShare] - Default active state for shared Skills
 * @param {boolean} [params.codeEnvAvailable] - `execute_code` capability flag;
 *   forwarded verbatim to the added agent's `initializeAgent`. @see
 *   InitializeAgentParams.codeEnvAvailable for full semantics.
 * @param {boolean} [params.fileSearchAvailable] - `file_search` capability AND
 *   the caller's `FILE_SEARCH` grant; forwarded verbatim alongside
 *   `codeEnvAvailable`. @see InitializeAgentParams.fileSearchAvailable.
 * @param {boolean} [params.statefulSessionsAvailable] - `stateful_code_sessions`
 *   capability flag; forwarded verbatim alongside `codeEnvAvailable`.
 * @param {AbortSignal} [params.signal] - Owning run cancellation signal.
 * @returns {Promise<{userMCPAuthMap: Object|undefined}>} The updated userMCPAuthMap
 */
const processAddedConvo = async ({
  req,
  res,
  endpointOption,
  modelsConfig,
  logViolation,
  loadTools,
  requestFiles,
  conversationId,
  parentMessageId,
  requestBody,
  allowedProviders,
  agentConfigs,
  primaryAgentId,
  primaryAgent,
  userMCPAuthMap,
  accessibleSkillIds = [],
  editableSkillIds = [],
  skillsCapabilityEnabled = false,
  ephemeralSkillsToggle = false,
  skillCreateAllowed = false,
  skillStates,
  defaultActiveOnShare,
  codeEnvAvailable,
  fileSearchAvailable,
  backgroundToolsAvailable,
  toolIntentsAvailable,
  statefulSessionsAvailable,
  memoryAvailable,
  signal,
}) => {
  const addedConvo = endpointOption.addedConvo;
  if (addedConvo == null) {
    return { userMCPAuthMap };
  }

  logger.debug('[processAddedConvo] Processing added conversation', {
    model: addedConvo.model,
    agentId: addedConvo.agent_id,
    endpoint: addedConvo.endpoint,
  });

  try {
    const skillDbMethods = getSkillDbMethods();
    const addedAgent = await loadAddedAgent({ req, conversation: addedConvo, primaryAgent });
    if (!addedAgent) {
      return { userMCPAuthMap };
    }

    const addedValidation = await validateAgentModel({
      req,
      res,
      modelsConfig,
      logViolation,
      agent: addedAgent,
    });

    if (!addedValidation.isValid) {
      logger.warn(
        `[processAddedConvo] Added agent validation failed: ${addedValidation.error?.message}`,
      );
      return { userMCPAuthMap };
    }

    const selectedModelSpec =
      addedConvo.spec && Array.isArray(req.config?.modelSpecs?.list)
        ? req.config.modelSpecs.list.find((modelSpec) => modelSpec.name === addedConvo.spec)
        : null;

    if (
      addedAgent &&
      isEphemeralAgentId(addedAgent.id) &&
      selectedModelSpec &&
      Object.hasOwn(selectedModelSpec, 'skills')
    ) {
      if (selectedModelSpec.skills === true) {
        addedAgent.skills_enabled = true;
        delete addedAgent.skills;
      } else if (selectedModelSpec.skills === false) {
        addedAgent.skills_enabled = false;
        addedAgent.skills = [];
      } else if (Array.isArray(selectedModelSpec.skills)) {
        const resolvedSkillIds = await resolveModelSpecSkillIds({
          names: selectedModelSpec.skills,
          accessibleSkillIds,
          getSkillByName: skillDbMethods.getSkillByName,
        });
        addedAgent.skills_enabled = true;
        addedAgent.skills = resolvedSkillIds.map((id) => id.toString());
      }
    }

    const scopedSkillIds = resolveAgentScopedSkillIds({
      agent: addedAgent,
      accessibleSkillIds,
      skillsCapabilityEnabled,
      ephemeralSkillsToggle,
    });
    const scopedEditableSkillIds = resolveAgentScopedSkillIds({
      agent: addedAgent,
      accessibleSkillIds: editableSkillIds,
      skillsCapabilityEnabled,
      ephemeralSkillsToggle,
    });

    const addedConfig = await initializeAgent(
      {
        req,
        res,
        loadTools,
        requestFiles,
        conversationId,
        parentMessageId,
        requestBody,
        agent: addedAgent,
        endpointOption,
        allowedProviders,
        accessibleSkillIds: scopedSkillIds,
        skillAuthoringAvailable: canAuthorSkillFiles({
          agent: addedAgent,
          scopedEditableSkillIds,
          skillCreateAllowed,
          skillsCapabilityEnabled,
          ephemeralSkillsToggle,
        }),
        codeEnvAvailable,
        fileSearchAvailable,
        backgroundToolsAvailable,
        toolIntentsAvailable,
        statefulSessionsAvailable,
        memoryAvailable,
        skillStates,
        defaultActiveOnShare,
        signal,
      },
      {
        getFiles: db.getFiles,
        getUserKey: db.getUserKey,
        getMessages: db.getMessages,
        getConvoFiles: db.getConvoFiles,
        getAccessibleMcpServerNames,
        updateFilesUsage: db.updateFilesUsage,
        getUserCodeFiles: db.getUserCodeFiles,
        getUserKeyValues: db.getUserKeyValues,
        getToolFilesByIds: db.getToolFilesByIds,
        getCodeGeneratedFiles: db.getCodeGeneratedFiles,
        filterFilesByAgentAccess,
        listSkillsByAccess: skillDbMethods.listSkillsByAccess,
        listAlwaysApplySkills: skillDbMethods.listAlwaysApplySkills,
        getSkillByName: skillDbMethods.getSkillByName,
        getRoleByName: db.getRoleByName,
      },
    );

    if (userMCPAuthMap != null) {
      Object.assign(userMCPAuthMap, addedConfig.userMCPAuthMap ?? {});
    } else {
      userMCPAuthMap = addedConfig.userMCPAuthMap;
    }

    const addedAgentId = addedConfig.id || ADDED_AGENT_ID;
    agentConfigs.set(addedAgentId, addedConfig);

    // No edges needed - agent without incoming edges becomes a start node
    // and runs in parallel with the primary agent automatically.
    // This is independent of any edges/agent_ids the primary agent has.

    logger.debug(
      `[processAddedConvo] Added parallel agent: ${addedAgentId} (primary: ${primaryAgentId}, ` +
        `primary has edges: ${!!endpointOption.edges}, primary has agent_ids: ${!!endpointOption.agent_ids})`,
    );

    return { userMCPAuthMap };
  } catch (err) {
    if (isFatalAgentInitializationError(err, { signal })) {
      throw err;
    }
    logger.error('[processAddedConvo] Error processing addedConvo for parallel agent', err);
    return { userMCPAuthMap };
  }
};

module.exports = {
  processAddedConvo,
  ADDED_AGENT_ID,
};
