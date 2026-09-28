const express = require('express');
const { nanoid } = require('nanoid');
const { logger } = require('@librechat/data-schemas');
const {
  generateCheckAccess,
  planAgentActionUpdate,
  isActionDomainAllowed,
  legacyActionDomainEncode,
  validateActionOAuthMetadata,
  ACTION_CREDENTIAL_REFRESH_MESSAGE,
  buildActionOAuthTokenDeleteQueries,
  blockFilteredActionProjection,
} = require('@librechat/api');
const {
  Permissions,
  ResourceType,
  PermissionBits,
  PermissionTypes,
  actionDelimiter,
  removeNullishValues,
  validateActionDomain,
  validateAndParseOpenAPISpec,
} = require('librechat-data-provider');
const {
  decryptMetadata,
  encryptMetadata,
  domainParser,
} = require('~/server/services/ActionService');
const { findAccessibleResources } = require('~/server/services/PermissionService');
const { attachOwnerContacts } = require('~/server/services/Agents/ownerContact');
const db = require('~/models');
const { canAccessAgentResource } = require('~/server/middleware');

const router = express.Router();

async function deleteActionOAuthTokens(action_id) {
  await Promise.all(
    buildActionOAuthTokenDeleteQueries(action_id).map((query) => db.deleteTokens(query)),
  );
}

const checkAgentCreate = generateCheckAccess({
  permissionType: PermissionTypes.AGENTS,
  permissions: [Permissions.USE, Permissions.CREATE],
  getRoleByName: db.getRoleByName,
});

/**
 * Retrieves all user's actions
 * @route GET /actions/
 * @param {string} req.params.id - Assistant identifier.
 * @returns {Action[]} 200 - success response - application/json
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.user.id;
    const editableAgentObjectIds = await findAccessibleResources({
      userId,
      role: req.user.role,
      resourceType: ResourceType.AGENT,
      requiredPermissions: PermissionBits.EDIT,
    });

    const agentsResponse = await db.getListAgentsByAccess({
      accessibleIds: editableAgentObjectIds,
      limit: null,
    });

    const editableAgentIds = agentsResponse.data.map((agent) => agent.id);
    const actions =
      editableAgentIds.length > 0 ? await db.getActions({ agentId: editableAgentIds }) : [];

    for (const action of actions) {
      if (blockFilteredActionProjection(req.config?.filters, res, action)) {
        return;
      }
    }

    res.json(actions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Adds or updates actions for a specific agent.
 * @route POST /actions/:agent_id
 * @param {string} req.params.agent_id - The ID of the agent.
 * @param {FunctionTool[]} req.body.functions - The functions to be added or updated.
 * @param {string} [req.body.action_id] - Optional ID for the action.
 * @param {ActionMetadata} req.body.metadata - Metadata for the action.
 * @returns {Object} 200 - success response - application/json
 */
router.post(
  '/:agent_id',
  canAccessAgentResource({
    requiredPermission: PermissionBits.EDIT,
    resourceIdParam: 'agent_id',
  }),
  checkAgentCreate,
  async (req, res) => {
    try {
      const { agent_id } = req.params;

      /** @type {{ functions: FunctionTool[], action_id: string, metadata: ActionMetadata }} */
      const { functions, action_id: _action_id, metadata: _metadata } = req.body;
      if (!functions.length) {
        return res.status(400).json({ message: 'No functions provided' });
      }

      if (
        blockFilteredActionProjection(req.config?.filters, res, {
          functions,
          metadata: _metadata,
        })
      ) {
        return;
      }

      const metadata = await encryptMetadata(removeNullishValues(_metadata, true));
      const appConfig = req.config;

      // SECURITY: Validate the OpenAPI spec and extract the server URL
      if (metadata.raw_spec) {
        const validationResult = validateAndParseOpenAPISpec(metadata.raw_spec);
        if (!validationResult.status || !validationResult.serverUrl) {
          return res.status(400).json({
            message: validationResult.message || 'Invalid OpenAPI specification',
          });
        }

        // SECURITY: Validate the client-provided domain matches the spec's server URL domain
        // This prevents SSRF attacks where an attacker provides a whitelisted domain
        // but uses a different (potentially internal) URL in the raw_spec
        const domainValidation = validateActionDomain(metadata.domain, validationResult.serverUrl);
        if (!domainValidation.isValid) {
          logger.warn(`Domain mismatch detected: ${domainValidation.message}`, {
            userId: req.user.id,
            agent_id,
          });
          return res.status(400).json({
            message:
              'Domain mismatch: The domain in the OpenAPI spec does not match the provided domain',
          });
        }
      }

      const isDomainAllowed = await isActionDomainAllowed(
        metadata.domain,
        appConfig?.actions?.allowedDomains,
        appConfig?.actions?.allowedAddresses,
      );
      if (!isDomainAllowed) {
        return res.status(400).json({ message: 'Domain not allowed' });
      }

      const encodedDomain = await domainParser(metadata.domain, true);

      if (!encodedDomain) {
        return res.status(400).json({ message: 'No domain provided' });
      }

      const legacyDomain = legacyActionDomainEncode(metadata.domain);

      const requestedActionId = _action_id;
      const action_id = requestedActionId ?? nanoid();
      const initialPromises = [];

      // Permissions already validated by middleware - load agent directly
      initialPromises.push(db.getAgent({ id: agent_id }));
      if (requestedActionId) {
        initialPromises.push(db.getActions({ actionId: requestedActionId }, true));
      }

      /** @type {[Agent, [Action|undefined]]} */
      const [agent, actions_result] = await Promise.all(initialPromises);
      if (!agent) {
        return res.status(404).json({ message: 'Agent not found for adding action' });
      }

      const storedAction = actions_result?.[0];
      if (storedAction) {
        if (storedAction.agent_id !== agent_id) {
          return res.status(403).json({ message: 'Action does not belong to this agent' });
        }
      }

      const { actions: agentActions = [], tools: agentTools = [], author: agent_author } = agent;
      const plannedUpdate = planAgentActionUpdate({
        agentActions,
        agentTools,
        incomingFunctions: functions,
        incomingMetadata: metadata,
        actionId: action_id,
        requestedActionId,
        encodedDomain,
        legacyDomain,
        previousLegacyDomain: legacyActionDomainEncode(storedAction?.metadata?.domain),
        storedAction,
      });

      if (
        blockFilteredActionProjection(req.config?.filters, res, {
          functions: plannedUpdate.tools.map((name) => ({ function: { name } })),
          metadata: await decryptMetadata(plannedUpdate.metadata),
        })
      ) {
        return;
      }

      if (plannedUpdate.requiresCredentialRefresh) {
        return res.status(400).json({
          message: ACTION_CREDENTIAL_REFRESH_MESSAGE,
        });
      }

      try {
        await validateActionOAuthMetadata(
          plannedUpdate.metadata.auth,
          appConfig?.actions?.allowedAddresses,
        );
      } catch (error) {
        return res.status(400).json({ message: error.message });
      }

      if (plannedUpdate.deleteOAuthTokens && requestedActionId) {
        // Keep the callback URL stable while preventing old OAuth tokens from following a new target.
        await deleteActionOAuthTokens(requestedActionId);
      }

      // Force version update since actions are changing
      const updatedAgent = await db.updateAgent(
        { id: agent_id },
        { tools: plannedUpdate.tools, actions: plannedUpdate.actions },
        {
          updatingUserId: req.user.id,
          forceVersion: true,
        },
      );
      await attachOwnerContacts([updatedAgent]);

      // Only update user field for new actions
      const actionUpdateData = {
        action_id: plannedUpdate.actionId,
        metadata: plannedUpdate.metadata,
        agent_id,
      };
      if (!actions_result || !actions_result.length) {
        // For new actions, use the agent owner's user ID
        actionUpdateData.user = agent_author || req.user.id;
      }

      /** @type {Action} */
      const updatedAction = await db.updateAction(
        { actionId: requestedActionId ?? action_id, agentId: agent_id },
        actionUpdateData,
      );

      const sensitiveFields = ['api_key', 'oauth_client_id', 'oauth_client_secret'];
      for (let field of sensitiveFields) {
        if (updatedAction.metadata[field]) {
          delete updatedAction.metadata[field];
        }
      }

      res.json([updatedAgent, updatedAction]);
    } catch (error) {
      const message = 'Trouble updating the Agent Action';
      logger.error(message, error);
      res.status(500).json({ message });
    }
  },
);

/**
 * Deletes an action for a specific agent.
 * @route DELETE /actions/:agent_id/:action_id
 * @param {string} req.params.agent_id - The ID of the agent.
 * @param {string} req.params.action_id - The ID of the action to delete.
 * @returns {Object} 200 - success response - application/json
 */
router.delete(
  '/:agent_id/:action_id',
  canAccessAgentResource({
    requiredPermission: PermissionBits.EDIT,
    resourceIdParam: 'agent_id',
  }),
  checkAgentCreate,
  async (req, res) => {
    try {
      const { agent_id, action_id } = req.params;

      // Permissions already validated by middleware - load agent directly
      const agent = await db.getAgent({ id: agent_id });
      if (!agent) {
        return res.status(404).json({ message: 'Agent not found for deleting action' });
      }

      const { tools = [], actions = [] } = agent;

      let storedDomain = '';
      const updatedActions = actions.filter((action) => {
        if (action.includes(action_id)) {
          [storedDomain] = action.split(actionDelimiter);
          return false;
        }
        return true;
      });

      if (!storedDomain) {
        return res.status(400).json({ message: 'No domain provided' });
      }

      const updatedTools = tools.filter(
        (tool) => !(tool && (tool.includes(storedDomain) || tool.includes(action_id))),
      );

      // Force version update since actions are being removed
      await db.updateAgent(
        { id: agent_id },
        { tools: updatedTools, actions: updatedActions },
        { updatingUserId: req.user.id, forceVersion: true },
      );
      const deleted = await db.deleteAction({ actionId: action_id, agentId: agent_id });
      if (!deleted) {
        logger.warn('[Agent Action Delete] No matching action document found', {
          action_id,
          agent_id,
        });
      }
      res.status(200).json({ message: 'Action deleted successfully' });
    } catch (error) {
      const message = 'Trouble deleting the Agent Action';
      logger.error(message, error);
      res.status(500).json({ message });
    }
  },
);

module.exports = router;
