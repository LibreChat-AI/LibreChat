const {
  handleError,
  applyModelSpecPreset,
  resolveModelSpecForEndpoint,
  resolveModelSpecPromptPrefixVariables,
  inspectContent,
  extractChatContent,
  contentFilterBlockResponse,
  applyRequestReasoningOverride,
} = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const {
  EndpointURLs,
  EModelEndpoint,
  isAgentsEndpoint,
  parseCompactConvo,
  getDefaultParamsEndpoint,
} = require('librechat-data-provider');
const azureAssistants = require('~/server/services/Endpoints/azureAssistants');
const assistants = require('~/server/services/Endpoints/assistants');
const { getEndpointsConfig } = require('~/server/services/Config');
const agents = require('~/server/services/Endpoints/agents');
const { updateFilesUsage } = require('~/models');

const buildFunction = {
  [EModelEndpoint.agents]: agents.buildOptions,
  [EModelEndpoint.assistants]: assistants.buildOptions,
  [EModelEndpoint.azureAssistants]: azureAssistants.buildOptions,
};

/**
 * Inspects only the user-authored value substituted for `{{current_user}}`.
 * The surrounding model-spec prompt is administrator-authored, so treating the
 * entire resolved prompt as user provenance would incorrectly apply user
 * content policy to static deployment configuration.
 *
 * `extractChatContent` deliberately gives prompt prefixes both prompt and
 * agent-instruction semantics, preserving the source-specific field controls
 * for the exact value that becomes model-bound.
 *
 * @param {ServerRequest} req
 * @param {unknown} promptPrefixTemplate
 * @returns {import('@librechat/api').ProtectionFinding | null}
 */
function inspectResolvedCurrentUser(req, promptPrefixTemplate) {
  if (
    typeof promptPrefixTemplate !== 'string' ||
    !/{{\s*current_user\s*}}/i.test(promptPrefixTemplate) ||
    !req.user?.name
  ) {
    return null;
  }

  return inspectContent(extractChatContent({ promptPrefix: String(req.user.name) }), {
    filters: req.config?.filters,
  });
}

async function buildEndpointOption(req, res, next) {
  const { endpoint, endpointType } = req.body;
  const isAgents =
    isAgentsEndpoint(endpoint) || req.baseUrl.startsWith(EndpointURLs[EModelEndpoint.agents]);

  let endpointsConfig;
  try {
    endpointsConfig = await getEndpointsConfig(req);
  } catch (error) {
    logger.error('Error fetching endpoints config in buildEndpointOption', error);
  }

  const defaultParamsEndpoint = getDefaultParamsEndpoint(endpointsConfig, endpoint);

  let parsedBody;
  try {
    parsedBody = parseCompactConvo({
      endpoint,
      endpointType,
      conversation: req.body,
      defaultParamsEndpoint,
    });
  } catch (error) {
    logger.error('Error parsing compact conversation', error);
    return handleError(res, { text: 'Error parsing conversation' });
  }

  const appConfig = req.config;
  let appliedModelSpecPrivateFields = new Set();
  let enforcedModelSpecFields = new Set();
  if (appConfig.modelSpecs?.list?.length && appConfig.modelSpecs?.enforce) {
    /** @type {{ list: TModelSpec[] }}*/
    const { list } = appConfig.modelSpecs;
    const rawSpec = req.body.spec;
    const spec = parsedBody.spec ?? (typeof rawSpec === 'string' ? rawSpec : undefined);
    const rawChatProjectId = req.body.chatProjectId;
    const parsedBodyForModelSpec =
      parsedBody.chatProjectId === undefined &&
      (typeof rawChatProjectId === 'string' || rawChatProjectId === null)
        ? { ...parsedBody, chatProjectId: rawChatProjectId }
        : parsedBody;

    if (!spec) {
      return handleError(res, { text: 'No model spec selected' });
    }

    const modelSpecResolution = resolveModelSpecForEndpoint({
      modelSpecs: { list },
      spec,
      endpoint,
    });
    if ('error' in modelSpecResolution) {
      return handleError(res, {
        text:
          modelSpecResolution.error === 'invalid-model-spec'
            ? 'Invalid model spec'
            : 'Model spec mismatch',
      });
    }
    const { modelSpec: currentModelSpec } = modelSpecResolution;
    enforcedModelSpecFields = new Set(Object.keys(currentModelSpec.preset));

    try {
      const result = applyModelSpecPreset({
        modelSpec: currentModelSpec,
        parsedBody: parsedBodyForModelSpec,
        endpoint,
        endpointType,
        defaultParamsEndpoint,
        includePresetDefaults: true,
      });
      parsedBody = result.parsedBody;
      appliedModelSpecPrivateFields = result.appliedPrivateFields;
    } catch (error) {
      logger.error('Error parsing model spec', error);
      return handleError(res, { text: 'Error parsing model spec' });
    }
  } else if (parsedBody.spec && appConfig.modelSpecs?.list) {
    const modelSpecResolution = resolveModelSpecForEndpoint({
      modelSpecs: appConfig.modelSpecs,
      spec: parsedBody.spec,
      endpoint,
    });
    if ('modelSpec' in modelSpecResolution) {
      const { modelSpec } = modelSpecResolution;

      try {
        const result = applyModelSpecPreset({
          modelSpec,
          parsedBody,
          endpoint,
          endpointType,
          defaultParamsEndpoint,
        });
        parsedBody = result.parsedBody;
        appliedModelSpecPrivateFields = result.appliedPrivateFields;
      } catch (error) {
        logger.error('Error parsing model spec', error);
        return handleError(res, { text: 'Error parsing model spec' });
      }
    } else if (modelSpecResolution.error === 'model-spec-mismatch') {
      return handleError(res, { text: 'Model spec mismatch' });
    }
  }

  if (!isAgents && appliedModelSpecPrivateFields.has('promptPrefix')) {
    const promptPrefixTemplate = parsedBody.promptPrefix;
    parsedBody = resolveModelSpecPromptPrefixVariables(
      parsedBody,
      req.user,
      req.body.clientTimestamp,
    );
    const finding = inspectResolvedCurrentUser(req, promptPrefixTemplate);
    if (finding != null) {
      return res.status(400).json(contentFilterBlockResponse(finding));
    }
  }

  try {
    const builder = isAgents
      ? (...args) => buildFunction[EModelEndpoint.agents](req, ...args)
      : buildFunction[endpointType ?? endpoint];

    // TODO: use object params
    req.body = req.body || {}; // Express 5: ensure req.body exists
    req.body.endpointOption = await builder(endpoint, parsedBody, endpointType);

    const reasoningApplied = await applyRequestReasoningOverride(req, {
      reasoningOverride: req.body.reasoningOverride,
      endpoint,
      endpointType,
      parsedModel: parsedBody.model,
      isAgent: isAgents,
      endpointsConfig,
      defaultParamsEndpoint,
      appliedModelSpecPrivateFields,
      enforcedModelSpecFields,
    });
    if (!reasoningApplied) {
      return handleError(res, { text: 'Invalid reasoning override' });
    }

    if (req.body.files && !isAgents) {
      req.body.endpointOption.attachments = updateFilesUsage(req.body.files, undefined, {
        user: req.user.id,
        tenantId: req.user.tenantId,
      });
    }

    next();
  } catch (error) {
    logger.error('Error building endpoint option', error);
    return handleError(res, { text: 'Error building endpoint option' });
  }
}

module.exports = buildEndpointOption;
