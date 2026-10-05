const { logger } = require('@librechat/data-schemas');
const {
  getToolkitKey,
  checkPluginAuth,
  filterUniquePlugins,
  filterMediaToolPlugins,
} = require('@librechat/api');
const { getRoleByName } = require('~/models');
const { getCachedTools, setCachedTools } = require('~/server/services/Config');
const { availableTools, toolkits } = require('~/app/clients/tools');
const { getAppConfig } = require('~/server/services/Config');

const getAvailablePluginsController = async (req, res) => {
  try {
    const appConfig =
      req.config ??
      (await getAppConfig({
        role: req.user?.role,
        userId: req.user?.id,
        tenantId: req.user?.tenantId,
      }));
    const { filteredTools = [], includedTools = [] } = appConfig;

    const uniquePlugins = filterUniquePlugins(availableTools);
    const includeSet = new Set(includedTools);
    const filterSet = new Set(filteredTools);

    /** includedTools takes precedence — filteredTools ignored when both are set. */
    const plugins = [];
    for (const plugin of uniquePlugins) {
      /** Agents-runtime-only tools (e.g. ask_user_question) never work on the
       *  legacy plugins endpoint — no run to pause, no resume surface. */
      if (plugin.agentsOnly === true) {
        continue;
      }
      if (includeSet.size > 0) {
        if (!includeSet.has(plugin.pluginKey)) {
          continue;
        }
      } else if (filterSet.has(plugin.pluginKey)) {
        continue;
      }
      plugins.push(checkPluginAuth(plugin) ? { ...plugin, authenticated: true } : plugin);
    }

    res.status(200).json(plugins);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

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

    const uniquePlugins = filterUniquePlugins(availableTools);
    const toolDefKeysList = toolDefinitions ? Object.keys(toolDefinitions) : null;
    const toolDefKeys = toolDefKeysList ? new Set(toolDefKeysList) : null;

    /**
     * `getAvailableTools` serves BOTH tool dialogs — /api/agents/tools and
     * /api/assistants/tools. Tools flagged `agentsOnly` in the manifest (e.g.
     * ask_user_question, which pauses an agents run via a LangGraph interrupt)
     * cannot work on the assistants runtime: it executes tools directly with no
     * run to pause and no resume surface, so attaching one there guarantees a
     * permanent tool error. Scope them out of the assistants listing by route.
     */
    const isAssistantsRoute = req.baseUrl?.includes('/assistants') === true;

    const toolsOutput = [];
    for (const plugin of uniquePlugins) {
      if (plugin.agentsOnly === true && isAssistantsRoute) {
        continue;
      }
      const isToolDefined = toolDefKeys?.has(plugin.pluginKey) === true;
      const isToolkit =
        plugin.toolkit === true &&
        toolDefKeysList != null &&
        toolDefKeysList.some(
          (key) => getToolkitKey({ toolkits, toolName: key }) === plugin.pluginKey,
        );

      if (!isToolDefined && !isToolkit) {
        continue;
      }

      toolsOutput.push(checkPluginAuth(plugin) ? { ...plugin, authenticated: true } : plugin);
    }

    res
      .status(200)
      .json(await filterMediaToolPlugins(toolsOutput, { appConfig, request: req, getRoleByName }));
  } catch (error) {
    logger.error('[getAvailableTools]', error);
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getAvailableTools,
  getAvailablePluginsController,
};
