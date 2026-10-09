const express = require('express');
const { nanoid } = require('nanoid');
const { logger } = require('@librechat/data-schemas');
const {
  isActionDomainAllowed,
  blockFilteredActionProjection,
  validateActionOAuthMetadata,
} = require('@librechat/api');
const { actionDelimiter, EModelEndpoint, removeNullishValues } = require('librechat-data-provider');
const {
  legacyDomainEncode,
  decryptMetadata,
  encryptMetadata,
  domainParser,
} = require('~/server/services/ActionService');
const { getOpenAIClient } = require('~/server/controllers/assistants/helpers');
const db = require('~/models');

const router = express.Router();

/**
 * Adds or updates actions for a specific assistant.
 * @route POST /actions/:assistant_id
 * @param {string} req.params.assistant_id - The ID of the assistant.
 * @param {FunctionTool[]} req.body.functions - The functions to be added or updated.
 * @param {string} [req.body.action_id] - Optional ID for the action.
 * @param {ActionMetadata} req.body.metadata - Metadata for the action.
 * @returns {Object} 200 - success response - application/json
 */
router.post('/:assistant_id', async (req, res) => {
  try {
    const appConfig = req.config;
    const { assistant_id } = req.params;

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

    let metadata = await encryptMetadata(removeNullishValues(_metadata, true));
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

    const legacyDomain = legacyDomainEncode(metadata.domain);

    const action_id = _action_id ?? nanoid();
    const initialPromises = [];

    const { openai } = await getOpenAIClient({ req, res });

    initialPromises.push(db.getAssistant({ assistantId: assistant_id }));
    initialPromises.push(openai.beta.assistants.retrieve(assistant_id));
    !!_action_id && initialPromises.push(db.getActions({ actionId: action_id }, true));

    /** @type {[AssistantDocument, Assistant, [Action|undefined]]} */
    const [assistant_data, assistant, actions_result] = await Promise.all(initialPromises);

    if (actions_result && actions_result.length) {
      const action = actions_result[0];
      if (action.assistant_id !== assistant_id) {
        return res.status(403).json({ message: 'Action does not belong to this assistant' });
      }
      metadata = { ...action.metadata, ...metadata };
    }

    try {
      await validateActionOAuthMetadata(metadata.auth, appConfig?.actions?.allowedAddresses);
    } catch (error) {
      return res.status(400).json({ message: error.message });
    }

    if (!assistant) {
      return res.status(404).json({ message: 'Assistant not found' });
    }

    const { actions: _actions = [], user: assistant_user } = assistant_data ?? {};
    const actions = [];
    for (const action of _actions) {
      const [_action_domain, current_action_id] = action.split(actionDelimiter);
      if (current_action_id === action_id) {
        continue;
      }

      actions.push(action);
    }

    actions.push(`${encodedDomain}${actionDelimiter}${action_id}`);

    /** @type {{ tools: FunctionTool[] | { type: 'code_interpreter'|'retrieval'}[]}} */
    const { tools: _tools = [] } = assistant;

    const shouldRemoveAssistantTool = (tool) => {
      if (!tool.function) {
        return false;
      }
      const name = tool.function.name;
      return (
        name.includes(encodedDomain) || name.includes(legacyDomain) || name.includes(action_id)
      );
    };

    const tools = _tools
      .filter((tool) => !shouldRemoveAssistantTool(tool))
      .concat(
        functions.map((tool) => ({
          ...tool,
          function: {
            ...tool.function,
            name: `${tool.function.name}${actionDelimiter}${encodedDomain}`,
          },
        })),
      );

    if (
      blockFilteredActionProjection(req.config?.filters, res, {
        functions: tools,
        metadata: await decryptMetadata(metadata),
      })
    ) {
      return;
    }

    let updatedAssistant = await openai.beta.assistants.update(assistant_id, { tools });
    const promises = [];

    // Only update user field for new assistant documents
    const assistantUpdateData = { actions };
    if (!assistant_data) {
      assistantUpdateData.user = req.user.id;
    }
    promises.push(db.updateAssistantDoc({ assistantId: assistant_id }, assistantUpdateData));

    // Only update user field for new actions
    const actionUpdateData = { metadata, assistant_id };
    if (!actions_result || !actions_result.length) {
      // For new actions, use the assistant owner's user ID
      actionUpdateData.user = assistant_user || req.user.id;
    }
    promises.push(
      db.updateAction({ actionId: action_id, assistantId: assistant_id }, actionUpdateData),
    );

    /** @type {[AssistantDocument, Action]} */
    let [assistantDocument, updatedAction] = await Promise.all(promises);
    const sensitiveFields = ['api_key', 'oauth_client_id', 'oauth_client_secret'];
    for (let field of sensitiveFields) {
      if (updatedAction.metadata[field]) {
        delete updatedAction.metadata[field];
      }
    }

    /* Map Azure OpenAI model to the assistant as defined by config */
    if (appConfig.endpoints?.[EModelEndpoint.azureOpenAI]?.assistants) {
      updatedAssistant = {
        ...updatedAssistant,
        model: req.body.model,
      };
    }

    res.json([assistantDocument, updatedAssistant, updatedAction]);
  } catch (error) {
    const message = 'Trouble updating the Assistant Action';
    logger.error(message, error);
    res.status(500).json({ message });
  }
});

/**
 * Deletes an action for a specific assistant.
 * @route DELETE /actions/:assistant_id/:action_id
 * @param {string} req.params.assistant_id - The ID of the assistant.
 * @param {string} req.params.action_id - The ID of the action to delete.
 * @returns {Object} 200 - success response - application/json
 */
router.delete('/:assistant_id/:action_id/:model', async (req, res) => {
  try {
    const { assistant_id, action_id, model } = req.params;
    req.body = req.body || {}; // Express 5: ensure req.body exists
    req.body.model = model;
    const { openai } = await getOpenAIClient({ req, res });

    const initialPromises = [];
    initialPromises.push(db.getAssistant({ assistantId: assistant_id }));
    initialPromises.push(openai.beta.assistants.retrieve(assistant_id));

    /** @type {[AssistantDocument, Assistant]} */
    const [assistant_data, assistant] = await Promise.all(initialPromises);

    const { actions = [] } = assistant_data ?? {};
    const { tools = [] } = assistant ?? {};

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
      (tool) =>
        !(
          tool.function &&
          (tool.function.name.includes(storedDomain) || tool.function.name.includes(action_id))
        ),
    );

    await openai.beta.assistants.update(assistant_id, { tools: updatedTools });

    const promises = [];
    // Only update user field if assistant document doesn't exist
    const assistantUpdateData = { actions: updatedActions };
    if (!assistant_data) {
      assistantUpdateData.user = req.user.id;
    }
    promises.push(db.updateAssistantDoc({ assistantId: assistant_id }, assistantUpdateData));
    promises.push(db.deleteAction({ actionId: action_id, assistantId: assistant_id }));

    const [, deletedAction] = await Promise.all(promises);
    if (!deletedAction) {
      logger.warn('[Assistant Action Delete] No matching action document found', {
        action_id,
        assistant_id,
      });
    }
    res.status(200).json({ message: 'Action deleted successfully' });
  } catch (error) {
    const message = 'Trouble deleting the Assistant Action';
    logger.error(message, error);
    res.status(500).json({ message });
  }
});

module.exports = router;
