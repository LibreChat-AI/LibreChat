const { createMetadataAggregator, Providers, TitleMethod } = require('@librechat/agents');
const { logger } = require('@librechat/data-schemas');
const { Constants, EModelEndpoint } = require('librechat-data-provider');
const {
  getBalanceConfig,
  getProviderConfig,
  getSafeErrorMetadata,
  getTransactionsConfig,
  omitTitleOptions,
  resolveConfigHeaders,
  resolveRequestTenantId,
  createSafeUser,
  sanitizeTitle,
} = require('@librechat/api');
const db = require('~/models');

/**
 * Generate a conversation title from an agent run, honoring the endpoint's
 * `titleConvo`/`titleModel`/`titleEndpoint`/`titleMethod` configuration.
 *
 * This is the run-based title core shared by the chat flow
 * (`AgentClient.titleConvo`) and the Open Responses API flow: it resolves the
 * title model/endpoint config the same way for both, calls the run's
 * `generateTitle`, records the title's token usage, and returns the sanitized
 * title. Persistence (caching, the title policy, and `saveConvo`) stays in the
 * caller — the chat flow's `addTitle` service and the Responses API both own it.
 *
 * @param {object} params
 * @param {ServerRequest} params.req
 * @param {object} params.agent - The agent whose endpoint/provider config is used
 * @param {object} params.run - The completed (or in-flight) agent run
 * @param {string} params.text - The user's first message
 * @param {Array} [params.contentParts] - The assistant response content parts
 *   (final timing); empty for immediate timing (title from the user input only)
 * @param {string} params.conversationId
 * @param {string} [params.responseMessageId] - Used for usage recording and
 *   request-based header resolution
 * @param {string|null} [params.parentMessageId]
 * @param {string} [params.userId] - Defaults to `req.user?.id`
 * @param {AbortController} [params.abortController]
 * @param {(params: {
 *   collectedUsage: Array,
 *   model: string,
 *   balance: object,
 *   transactions: object,
 * }) => Promise<void>} [params.recordUsage] - Records the title's token usage.
 *   Callers own the recording strategy: `AgentClient` bills through the client
 *   (agent-scoped `endpointTokenConfig`), the Responses API bills with its own
 *   injected deps. When omitted, title usage is not recorded.
 * @returns {Promise<string|undefined>} The sanitized title, or `undefined` when
 *   title generation is disabled or failed
 */
async function generateRunTitle({
  req,
  agent,
  run,
  text,
  contentParts = [],
  conversationId,
  responseMessageId,
  parentMessageId,
  userId,
  abortController,
  recordUsage,
}) {
  try {
    const { handleLLMEnd, collected: collectedMetadata } = createMetadataAggregator();

    if (req?.body?.isTemporary) {
      logger.debug(
        `[api/server/services/Endpoints/agents/runTitle.js #generateRunTitle] Skipping title generation for temporary conversation`,
      );
      return;
    }

    const appConfig = req.config;
    let endpoint = agent.endpoint;

    /** @type {import('@librechat/agents').ClientOptions} */
    let clientOptions = {
      model: agent.model || agent.model_parameters.model,
    };

    let titleProviderConfig = getProviderConfig({ provider: endpoint, appConfig });

    /** @type {TEndpoint | undefined} */
    const endpointConfig =
      appConfig.endpoints?.all ??
      appConfig.endpoints?.[endpoint] ??
      titleProviderConfig.customEndpointConfig;
    if (!endpointConfig) {
      logger.debug(
        `[api/server/services/Endpoints/agents/runTitle.js #generateRunTitle] No endpoint config for "${endpoint}"`,
      );
    }

    if (endpointConfig?.titleConvo === false) {
      logger.debug(
        `[api/server/services/Endpoints/agents/runTitle.js #generateRunTitle] Title generation disabled for endpoint "${endpoint}"`,
      );
      return;
    }

    if (endpointConfig?.titleEndpoint && endpointConfig.titleEndpoint !== endpoint) {
      try {
        titleProviderConfig = getProviderConfig({
          provider: endpointConfig.titleEndpoint,
          appConfig,
        });
        endpoint = endpointConfig.titleEndpoint;
      } catch (error) {
        logger.warn(
          `[api/server/services/Endpoints/agents/runTitle.js #generateRunTitle] Error getting title endpoint config for "${endpointConfig.titleEndpoint}", falling back to default`,
          getSafeErrorMetadata(error),
        );
        // Fall back to original provider config
        endpoint = agent.endpoint;
        titleProviderConfig = getProviderConfig({ provider: endpoint, appConfig });
      }
    }

    if (
      endpointConfig &&
      endpointConfig.titleModel &&
      endpointConfig.titleModel !== Constants.CURRENT_MODEL
    ) {
      clientOptions.model = endpointConfig.titleModel;
    }

    const options = await titleProviderConfig.getOptions({
      req,
      endpoint,
      model_parameters: clientOptions,
      db: {
        getUserKey: db.getUserKey,
        getUserKeyValues: db.getUserKeyValues,
      },
    });

    let provider = options.provider ?? titleProviderConfig.overrideProvider ?? agent.provider;
    if (
      endpoint === EModelEndpoint.azureOpenAI &&
      options.llmConfig?.azureOpenAIApiInstanceName == null
    ) {
      provider = Providers.OPENAI;
    } else if (
      endpoint === EModelEndpoint.azureOpenAI &&
      options.llmConfig?.azureOpenAIApiInstanceName != null &&
      provider !== Providers.AZURE
    ) {
      provider = Providers.AZURE;
    }

    /** @type {import('@librechat/agents').ClientOptions} */
    clientOptions = { ...options.llmConfig };
    if (options.configOptions) {
      clientOptions.configuration = options.configOptions;
    }

    if (clientOptions.maxTokens != null) {
      delete clientOptions.maxTokens;
    }
    if (clientOptions?.modelKwargs?.max_completion_tokens != null) {
      delete clientOptions.modelKwargs.max_completion_tokens;
    }
    if (clientOptions?.modelKwargs?.max_output_tokens != null) {
      delete clientOptions.modelKwargs.max_output_tokens;
    }

    /** `omitTitleOptions` drops the Anthropic `clientOptions` carrier (thinking,
     *  streaming, etc.), which would also drop its `defaultHeaders` — preserve the
     *  original `clientOptions` object so gateway/reverse-proxy metadata still
     *  reaches title requests (the proxy may require it for auth/routing). Restore
     *  the SAME object reference, not a copy: the Vertex `createClient` closure from
     *  `getLLMConfig` closes over this object, so `resolveConfigHeaders` must mutate
     *  the very object the client is built from. */
    const anthropicClientOptions = clientOptions?.clientOptions;

    clientOptions = Object.assign(
      Object.fromEntries(
        Object.entries(clientOptions).filter(([key]) => !omitTitleOptions.has(key)),
      ),
    );

    if (anthropicClientOptions?.defaultHeaders != null && clientOptions.clientOptions == null) {
      clientOptions.clientOptions = anthropicClientOptions;
    }

    if (
      provider === Providers.GOOGLE &&
      (endpointConfig?.titleMethod === TitleMethod.FUNCTIONS ||
        endpointConfig?.titleMethod === TitleMethod.STRUCTURED)
    ) {
      clientOptions.json = true;
    }

    /** Resolve request-based headers across provider-specific header locations:
     *  OpenAI `configuration.defaultHeaders`, Anthropic `clientOptions.defaultHeaders`
     *  (preserved above), and Google `customHeaders`.
     */
    resolveConfigHeaders({
      llmConfig: clientOptions,
      user: createSafeUser(req?.user),
      tenantId: resolveRequestTenantId(req ?? {}),
      body: {
        messageId: responseMessageId,
        conversationId,
        parentMessageId,
      },
    });

    const titleResult = await run.generateTitle({
      provider,
      clientOptions,
      inputText: text,
      contentParts,
      titleMethod: endpointConfig?.titleMethod,
      titlePrompt: endpointConfig?.titlePrompt,
      titlePromptTemplate: endpointConfig?.titlePromptTemplate,
      chainOptions: {
        runName: 'TitleRun',
        signal: abortController.signal,
        callbacks: [
          {
            handleLLMEnd,
          },
        ],
        configurable: {
          thread_id: conversationId,
          user_id: userId ?? req?.user?.id,
        },
      },
    });

    const collectedUsage = collectedMetadata.map((item) => {
      let input_tokens, output_tokens;

      if (item.usage) {
        input_tokens =
          item.usage.prompt_tokens || item.usage.input_tokens || item.usage.inputTokens;
        output_tokens =
          item.usage.completion_tokens || item.usage.output_tokens || item.usage.outputTokens;
      } else if (item.tokenUsage) {
        input_tokens = item.tokenUsage.promptTokens;
        output_tokens = item.tokenUsage.completionTokens;
      } else if (item.usage_metadata) {
        input_tokens = item.usage_metadata.input_tokens;
        output_tokens = item.usage_metadata.output_tokens;
      }

      return {
        input_tokens: input_tokens,
        output_tokens: output_tokens,
      };
    });

    if (typeof recordUsage === 'function') {
      const balanceConfig = getBalanceConfig(appConfig);
      const transactionsConfig = getTransactionsConfig(appConfig);
      await recordUsage({
        collectedUsage,
        model: clientOptions.model,
        balance: balanceConfig,
        transactions: transactionsConfig,
      }).catch((err) => {
        logger.error(
          '[api/server/services/Endpoints/agents/runTitle.js #generateRunTitle] Error recording collected usage',
          getSafeErrorMetadata(err),
        );
      });
    }

    return sanitizeTitle(titleResult.title);
  } catch (err) {
    logger.error(
      '[api/server/services/Endpoints/agents/runTitle.js #generateRunTitle] Error',
      getSafeErrorMetadata(err),
    );
  }
}

module.exports = { generateRunTitle };
