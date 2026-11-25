const { logger } = require('@librechat/data-schemas');
const { listAvailableTools } = require('@librechat/api');
const { getCachedTools, setCachedTools } = require('~/server/services/Config');
const { availableTools, toolkits } = require('~/app/clients/tools');
const { getAppConfig } = require('~/server/services/Config');

const getAvailableTools = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      logger.warn('[getAvailableTools] User ID not found in request');
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const appConfig =
      req.config ??
      (await getAppConfig({
        role: req.user?.role,
        userId: req.user?.id,
        tenantId: req.user?.tenantId,
      }));

    let toolDefinitions = await getCachedTools();

    if (toolDefinitions == null && appConfig?.availableTools != null) {
      logger.warn('[getAvailableTools] Tool cache was empty, re-initializing from app config');
      await setCachedTools(appConfig.availableTools);
      toolDefinitions = appConfig.availableTools;
    }

    /**
     * `getAvailableTools` serves BOTH tool dialogs — /api/agents/tools and
     * /api/assistants/tools. Tools flagged `agentsOnly` in the manifest (e.g.
     * ask_user_question, which pauses an agents run via a LangGraph interrupt)
     * cannot work on the assistants runtime: it executes tools directly with no
     * run to pause and no resume surface, so attaching one there guarantees a
     * permanent tool error. Scope them out of the assistants listing by route.
     */
    const toolsOutput = listAvailableTools({
      manifest: availableTools,
      toolkits,
      toolDefinitions,
      githubCompare: appConfig?.githubCompare,
      forAssistants: req.baseUrl?.includes('/assistants') === true,
    });

    res.status(200).json(toolsOutput);
  } catch (error) {
    logger.error('[getAvailableTools]', error);
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getAvailableTools,
};
