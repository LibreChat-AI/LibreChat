const fs = require('fs');
const path = require('path');
const { Calculator } = require('@librechat/agents');
const { logger } = require('@librechat/data-schemas');
const { zodToJsonSchema } = require('zod-to-json-schema');
const { Tool } = require('@librechat/agents/langchain/tools');
const { Tools, ImageVisionTool } = require('librechat-data-provider');
const {
  getToolkitKey,
  isToolModuleFile,
  oaiToolkit,
  geminiToolkit,
  createAskUserQuestionTool,
} = require('@librechat/api');
const { toolkits } = require('~/app/clients/tools/manifest');

/**
 * Loads and formats tools from the specified tool directory.
 *
 * The directory is scanned for JavaScript files, excluding test files and any files in the filter set.
 * For each file, it attempts to load the file as a module and instantiate a class, if it's a subclass of `StructuredTool`.
 * Each tool instance is then formatted to be compatible with the OpenAI Assistant.
 * Additionally, instances of LangChain Tools are included in the result.
 *
 * @param {object} params - The parameters for the function.
 * @param {string} params.directory - The directory path where the tools are located.
 * @param {Array<string>} [params.adminFilter=[]] - Array of admin-defined tool keys to exclude from loading.
 * @param {Array<string>} [params.adminIncluded=[]] - Array of admin-defined tool keys to include from loading.
 * @returns {Record<string, FunctionTool>} An object mapping each tool's plugin key to its instance.
 */
function loadAndFormatTools({ directory, adminFilter = [], adminIncluded = [] }) {
  const filter = new Set([...adminFilter]);
  const included = new Set(adminIncluded);
  const tools = [];
  /* Structured Tools Directory */
  const files = fs.readdirSync(directory);

  if (included.size > 0 && adminFilter.length > 0) {
    logger.warn(
      'Both `includedTools` and `filteredTools` are defined; `filteredTools` will be ignored.',
    );
  }

  for (const file of files) {
    const filePath = path.join(directory, file);
    if (!isToolModuleFile(file) || (filter.has(file) && included.size === 0)) {
      continue;
    }

    let ToolClass = null;
    try {
      ToolClass = require(filePath);
    } catch (error) {
      logger.error(`[loadAndFormatTools] Error loading tool from ${filePath}:`, error);
      continue;
    }

    if (!ToolClass || !(ToolClass.prototype instanceof Tool)) {
      continue;
    }

    let toolInstance = null;
    try {
      toolInstance = new ToolClass({ override: true });
    } catch (error) {
      logger.error(
        `[loadAndFormatTools] Error initializing \`${file}\` tool; if it requires authentication, is the \`override\` field configured?`,
        error,
      );
      continue;
    }

    if (!toolInstance) {
      continue;
    }

    if (filter.has(toolInstance.name) && included.size === 0) {
      continue;
    }

    if (included.size > 0 && !included.has(file) && !included.has(toolInstance.name)) {
      continue;
    }

    const formattedTool = formatToOpenAIAssistantTool(toolInstance);
    tools.push(formattedTool);
  }

  const basicToolInstances = [
    new Calculator(),
    createAskUserQuestionTool(),
    ...Object.values(oaiToolkit),
    ...Object.values(geminiToolkit),
  ];
  for (const toolInstance of basicToolInstances) {
    const formattedTool = formatToOpenAIAssistantTool(toolInstance);
    let toolName = formattedTool[Tools.function].name;
    toolName = getToolkitKey({ toolkits, toolName }) ?? toolName;
    if (filter.has(toolName) && included.size === 0) {
      continue;
    }

    if (included.size > 0 && !included.has(toolName)) {
      continue;
    }
    tools.push(formattedTool);
  }

  tools.push(ImageVisionTool);

  return tools.reduce((map, tool) => {
    map[tool.function.name] = tool;
    return map;
  }, {});
}

/**
 * Checks if a schema is a Zod schema by looking for the _def property
 * @param {unknown} schema - The schema to check
 * @returns {boolean} True if it's a Zod schema
 */
function isZodSchema(schema) {
  return schema && typeof schema === 'object' && '_def' in schema;
}

/**
 * Formats a `StructuredTool` instance into a format that is compatible
 * with OpenAI's ChatCompletionFunctions. It uses the `zodToJsonSchema`
 * function to convert the schema of the `StructuredTool` into a JSON
 * schema, which is then used as the parameters for the OpenAI function.
 * If the schema is already a JSON schema, it is used directly.
 *
 * @param {StructuredTool} tool - The StructuredTool to format.
 * @returns {FunctionTool} The OpenAI Assistant Tool.
 */
function formatToOpenAIAssistantTool(tool) {
  const parameters = isZodSchema(tool.schema) ? zodToJsonSchema(tool.schema) : tool.schema;
  return {
    type: Tools.function,
    [Tools.function]: {
      name: tool.name,
      description: tool.description,
      parameters,
    },
  };
}

module.exports = {
  loadAndFormatTools,
};
