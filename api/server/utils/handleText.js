const partialRight = require('lodash/partialRight');
const {
  Capabilities,
  EModelEndpoint,
  isAgentsEndpoint,
  isAssistantsEndpoint,
  defaultRetrievalModels,
  defaultAssistantsVersion,
  defaultAgentCapabilities,
} = require('librechat-data-provider');
const { sendEvent, isUserProvided } = require('@librechat/api');

const addSpaceIfNeeded = (text) => (text.length > 0 && !text.endsWith(' ') ? text + ' ' : text);

const base = { message: true, initial: true };
const createOnProgress = (
  { generation = '', onProgress: _onProgress } = {
    generation: '',
    onProgress: null,
  },
) => {
  let i = 0;
  let tokens = addSpaceIfNeeded(generation);

  const basePayload = Object.assign({}, base, { text: tokens || '' });

  const progressCallback = (chunk, { res, ...rest }) => {
    basePayload.text = basePayload.text + chunk;

    const payload = Object.assign({}, basePayload, rest);
    sendEvent(res, payload);
    if (_onProgress) {
      _onProgress(payload);
    }
    if (i === 0) {
      basePayload.initial = false;
    }
    i++;
  };

  const sendIntermediateMessage = (res, payload, extraTokens = '') => {
    basePayload.text = basePayload.text + extraTokens;
    const message = Object.assign({}, basePayload, payload);
    sendEvent(res, message);
    if (i === 0) {
      basePayload.initial = false;
    }
    i++;
  };

  const onProgress = (opts) => {
    return partialRight(progressCallback, opts);
  };

  const getPartialText = () => {
    return basePayload.text;
  };

  return { onProgress, getPartialText, sendIntermediateMessage };
};

/**
 * Generate the configuration for a given key and base URL.
 * @param {string} key
 * @param {string} [baseURL]
 * @param {string} [endpoint]
 * @returns {boolean | { userProvide: boolean, userProvideURL?: boolean }}
 */
function generateConfig(key, baseURL, endpoint) {
  if (!key) {
    return false;
  }

  /** @type {{ userProvide: boolean, userProvideURL?: boolean }} */
  const config = { userProvide: isUserProvided(key) };

  if (baseURL) {
    config.userProvideURL = isUserProvided(baseURL);
  }

  const assistants = isAssistantsEndpoint(endpoint);
  const agents = isAgentsEndpoint(endpoint);
  if (assistants) {
    config.retrievalModels = defaultRetrievalModels;
    config.capabilities = [
      Capabilities.code_interpreter,
      Capabilities.image_vision,
      Capabilities.retrieval,
      Capabilities.actions,
      Capabilities.tools,
    ];
  }

  if (agents) {
    config.capabilities = defaultAgentCapabilities;
  }

  if (assistants && endpoint === EModelEndpoint.azureAssistants) {
    config.version = defaultAssistantsVersion.azureAssistants;
  } else if (assistants) {
    config.version = defaultAssistantsVersion.assistants;
  }

  return config;
}

module.exports = {
  generateConfig,
  createOnProgress,
};
