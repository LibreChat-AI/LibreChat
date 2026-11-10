const availableTools = require('./manifest.json').map((tool) => {
  if (
    tool.pluginKey !== 'flux' ||
    !['azure-foundry', 'azure-foundry-images'].includes(process.env.FLUX_API_PROVIDER)
  ) {
    return tool;
  }

  const foundryTool = {
    ...tool,
    description:
      process.env.FLUX_API_PROVIDER === 'azure-foundry-images'
        ? 'Generate images using the Microsoft Foundry Images API (FLUX-1.1-pro or FLUX.1-Kontext-pro).'
        : 'Generate and edit images using the configured Microsoft Foundry FLUX deployment.',
    authConfig: [],
  };
  delete foundryTool.isAuthRequired;
  return foundryTool;
});

/** @type {Record<string, TPlugin | undefined>} */
const manifestToolMap = {};

/** @type {Array<TPlugin>} */
const toolkits = [];

availableTools.forEach((tool) => {
  manifestToolMap[tool.pluginKey] = tool;
  if (tool.toolkit === true) {
    toolkits.push(tool);
  }
});

/**
 * Whether a tool (string pluginKey, or an OpenAI function-tool object) is
 * flagged `agentsOnly` in the manifest — usable only on the agents runtime
 * (e.g. `ask_user_question`, which pauses a LangGraph run via `interrupt()`).
 * The legacy assistants runtime executes tools with no run to pause and no
 * resume surface, so these must be rejected before assistant create/update —
 * the tools-dialog scoping alone doesn't stop a REST client or a stale saved
 * payload from posting the tool string directly.
 *
 * @param {string | { function?: { name?: string } } | undefined} tool
 * @returns {boolean}
 */
function isAgentsOnlyTool(tool) {
  const name = typeof tool === 'string' ? tool : tool?.function?.name;
  if (!name) {
    return false;
  }
  return manifestToolMap[name]?.agentsOnly === true;
}

module.exports = {
  toolkits,
  availableTools,
  manifestToolMap,
  isAgentsOnlyTool,
};
