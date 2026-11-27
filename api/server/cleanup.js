const { logger } = require('@librechat/data-schemas');

const graphPropsToClean = [
  'handlerRegistry',
  'runId',
  'tools',
  'signal',
  'config',
  'messages',
  'contentData',
  'stepKeyIds',
  'contentIndexMap',
  'toolCallStepIds',
  'messageIdsByStepKey',
  'messageStepHasToolCalls',
  'prelimMessageIdsByStepKey',
  'startIndex',
  'defaultAgentId',
  'dispatchReasoningDelta',
  'compileOptions',
  'invokedToolIds',
  'overrideModel',
];

const graphRunnablePropsToClean = [
  'lc_serializable',
  'lc_kwargs',
  'lc_runnable',
  'name',
  'lc_namespace',
  'lg_is_pregel',
  'nodes',
  'channels',
  'inputChannels',
  'outputChannels',
  'autoValidate',
  'streamMode',
  'streamChannels',
  'interruptAfter',
  'interruptBefore',
  'stepTimeout',
  'debug',
  'checkpointer',
  'retryPolicy',
  'config',
  'store',
  'triggerToNodes',
  'cache',
  'description',
  'metaRegistry',
];

/**
 * Cleans up the client object by removing potential circular references to its properties.
 * This is useful for preventing memory leaks and ensuring that the client
 * and its properties can be garbage collected when it is no longer needed.
 */
function disposeClient(client) {
  if (!client) {
    return;
  }

  try {
    if (client.user) {
      client.user = null;
    }
    if (client.apiKey) {
      client.apiKey = null;
    }
    if (client.azure) {
      client.azure = null;
    }
    if (client.conversationId) {
      client.conversationId = null;
    }
    if (client.responseMessageId) {
      client.responseMessageId = null;
    }
    if (client.parentMessageId) {
      client.parentMessageId = null;
    }
    if (client.message_file_map) {
      client.message_file_map = null;
    }
    if (client.clientName) {
      client.clientName = null;
    }
    if (client.sender) {
      client.sender = null;
    }
    if (client.model) {
      client.model = null;
    }
    if (client.maxContextTokens) {
      client.maxContextTokens = null;
    }
    if (client.currentDateString) {
      client.currentDateString = null;
    }
    if (client.inputTokensKey) {
      client.inputTokensKey = null;
    }
    if (client.outputTokensKey) {
      client.outputTokensKey = null;
    }
    if (client.skipSaveUserMessage !== undefined) {
      client.skipSaveUserMessage = null;
    }
    if (client.visionMode) {
      client.visionMode = null;
    }
    if (client.continued !== undefined) {
      client.continued = null;
    }
    if (client.fetchedConvo !== undefined) {
      client.fetchedConvo = null;
    }
    if (client.previous_summary) {
      client.previous_summary = null;
    }
    if (client.metadata) {
      client.metadata = null;
    }
    if (client.isVisionModel) {
      client.isVisionModel = null;
    }
    if (client.contextHandlers) {
      client.contextHandlers = null;
    }
    if (client.augmentedPrompt) {
      client.augmentedPrompt = null;
    }
    if (client.systemMessage) {
      client.systemMessage = null;
    }
    if (client.azureEndpoint) {
      client.azureEndpoint = null;
    }
    if (client.langchainProxy) {
      client.langchainProxy = null;
    }
    if (client.isOmni !== undefined) {
      client.isOmni = null;
    }
    if (client.runManager) {
      client.runManager = null;
    }
    // Properties specific to AnthropicClient
    if (client.message_start) {
      client.message_start = null;
    }
    if (client.message_delta) {
      client.message_delta = null;
    }
    if (client.isClaudeLatest !== undefined) {
      client.isClaudeLatest = null;
    }
    if (client.useMessages !== undefined) {
      client.useMessages = null;
    }
    if (client.supportsCacheControl !== undefined) {
      client.supportsCacheControl = null;
    }
    // Properties specific to GoogleClient
    if (client.serviceKey) {
      client.serviceKey = null;
    }
    if (client.project_id) {
      client.project_id = null;
    }
    if (client.client_email) {
      client.client_email = null;
    }
    if (client.private_key) {
      client.private_key = null;
    }
    if (client.access_token) {
      client.access_token = null;
    }
    if (client.reverseProxyUrl) {
      client.reverseProxyUrl = null;
    }
    if (client.authHeader) {
      client.authHeader = null;
    }
    if (client.isGenerativeModel !== undefined) {
      client.isGenerativeModel = null;
    }
    // Properties specific to OpenAIClient
    if (client.completionsUrl) {
      client.completionsUrl = null;
    }
    if (client.shouldSummarize !== undefined) {
      client.shouldSummarize = null;
    }
    if (client.isOllama !== undefined) {
      client.isOllama = null;
    }
    if (client.FORCE_PROMPT !== undefined) {
      client.FORCE_PROMPT = null;
    }
    if (client.isChatGptModel !== undefined) {
      client.isChatGptModel = null;
    }
    if (client.isUnofficialChatGptModel !== undefined) {
      client.isUnofficialChatGptModel = null;
    }
    if (client.useOpenRouter !== undefined) {
      client.useOpenRouter = null;
    }
    if (client.startToken) {
      client.startToken = null;
    }
    if (client.endToken) {
      client.endToken = null;
    }
    if (client.userLabel) {
      client.userLabel = null;
    }
    if (client.chatGptLabel) {
      client.chatGptLabel = null;
    }
    if (client.modelLabel) {
      client.modelLabel = null;
    }
    if (client.modelOptions) {
      client.modelOptions = null;
    }
    if (client.defaultVisionModel) {
      client.defaultVisionModel = null;
    }
    if (client.maxPromptTokens) {
      client.maxPromptTokens = null;
    }
    if (client.maxResponseTokens) {
      client.maxResponseTokens = null;
    }
    if (client.processMemory) {
      client.processMemory = null;
    }

    if (client.run) {
      if (client.run.Graph) {
        if (typeof client.run.Graph.clearHeavyState === 'function') {
          client.run.Graph.clearHeavyState();
        } else {
          client.run.Graph.resetValues();
        }

        if (client.run.Graph.agentContexts) {
          client.run.Graph.agentContexts.clear();
          client.run.Graph.agentContexts = null;
        }

        graphPropsToClean.forEach((prop) => {
          if (client.run.Graph[prop] !== undefined) {
            client.run.Graph[prop] = null;
          }
        });

        client.run.Graph = null;
      }

      if (client.run.graphRunnable) {
        graphRunnablePropsToClean.forEach((prop) => {
          if (client.run.graphRunnable[prop] !== undefined) {
            client.run.graphRunnable[prop] = null;
          }
        });

        if (client.run.graphRunnable.builder) {
          if (client.run.graphRunnable.builder.nodes !== undefined) {
            client.run.graphRunnable.builder.nodes = null;
          }
          client.run.graphRunnable.builder = null;
        }

        client.run.graphRunnable = null;
      }

      const runPropsToClean = [
        'handlerRegistry',
        'id',
        'indexTokenCountMap',
        'returnContent',
        'tokenCounter',
      ];

      runPropsToClean.forEach((prop) => {
        if (client.run[prop] !== undefined) {
          client.run[prop] = null;
        }
      });

      client.run = null;
    }

    if (client.sendMessage) {
      client.sendMessage = null;
    }
    if (client.savedMessageIds) {
      client.savedMessageIds.clear();
      client.savedMessageIds = null;
    }
    if (client.currentMessages) {
      client.currentMessages = null;
    }
    if (client.streamHandler) {
      client.streamHandler = null;
    }
    if (client.contentParts) {
      client.contentParts = null;
    }
    if (client.abortController) {
      client.abortController = null;
    }
    if (client.collectedUsage) {
      client.collectedUsage = null;
    }
    if (client.indexTokenCountMap) {
      client.indexTokenCountMap = null;
    }
    if (client.agentConfigs) {
      client.agentConfigs = null;
    }
    if (client.artifactPromises) {
      client.artifactPromises = null;
    }
    if (client.usage) {
      client.usage = null;
    }
    if (typeof client.dispose === 'function') {
      client.dispose();
    }
    if (client.options) {
      if (client.options.req) {
        client.options.req = null;
      }
      if (client.options.res) {
        client.options.res = null;
      }
      if (client.options.attachments) {
        client.options.attachments = null;
      }
      if (client.options.agent) {
        client.options.agent = null;
      }
    }
    client.options = null;
  } catch {
    // Ignore errors during disposal
  } finally {
    logger.debug('[disposeClient] Client disposed');
  }
}

module.exports = {
  disposeClient,
};
