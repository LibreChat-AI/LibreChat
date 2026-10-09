const OpenAI = require('openai');
const {
  isUserProvided,
  resolveHeaders,
  constructAzureURL,
  checkUserKeyExpiry,
  getProxyDispatcher,
} = require('@librechat/api');
const { ErrorTypes, EModelEndpoint, mapModelToAzureConfig } = require('librechat-data-provider');
const { getUserKeyValues, getUserKeyExpiry } = require('~/models');

class Files {
  constructor(client) {
    this._client = client;
  }
  /**
   * Create an assistant file by attaching a
   * [File](https://platform.openai.com/docs/api-reference/files) to an
   * [assistant](https://platform.openai.com/docs/api-reference/assistants).
   */
  create(assistantId, body, options) {
    return this._client.post(`/assistants/${assistantId}/files`, {
      body,
      ...options,
      headers: { 'OpenAI-Beta': 'assistants=v1', ...options?.headers },
    });
  }

  /**
   * Retrieves an AssistantFile.
   */
  retrieve(assistantId, fileId, options) {
    return this._client.get(`/assistants/${assistantId}/files/${fileId}`, {
      ...options,
      headers: { 'OpenAI-Beta': 'assistants=v1', ...options?.headers },
    });
  }

  /**
   * Delete an assistant file.
   */
  del(assistantId, fileId, options) {
    return this._client.delete(`/assistants/${assistantId}/files/${fileId}`, {
      ...options,
      headers: { 'OpenAI-Beta': 'assistants=v1', ...options?.headers },
    });
  }
}

const initializeClient = async ({ req, res, version, endpointOption, initAppClient = false }) => {
  const appConfig = req.config;
  const { PROXY, OPENAI_ORGANIZATION, AZURE_ASSISTANTS_API_KEY, AZURE_ASSISTANTS_BASE_URL } =
    process.env;

  const userProvidesKey = isUserProvided(AZURE_ASSISTANTS_API_KEY);
  const userProvidesURL = isUserProvided(AZURE_ASSISTANTS_BASE_URL);

  let userValues = null;
  if (userProvidesKey || userProvidesURL) {
    const expiresAt = await getUserKeyExpiry({
      userId: req.user.id,
      name: EModelEndpoint.azureAssistants,
    });
    checkUserKeyExpiry(expiresAt, EModelEndpoint.azureAssistants);
    userValues = await getUserKeyValues({
      userId: req.user.id,
      name: EModelEndpoint.azureAssistants,
    });
  }

  let apiKey = userProvidesKey ? userValues.apiKey : AZURE_ASSISTANTS_API_KEY;
  let baseURL = userProvidesURL ? userValues.baseURL : AZURE_ASSISTANTS_BASE_URL;

  const opts = {};

  const clientOptions = {
    reverseProxyUrl: baseURL ?? null,
    proxy: PROXY ?? null,
    req,
    res,
    ...endpointOption,
  };

  /** @type {TAzureConfig | undefined} */
  const azureConfig = appConfig.endpoints?.[EModelEndpoint.azureOpenAI];

  /** @type {AzureOptions | undefined} */
  let azureOptions;

  if (azureConfig && azureConfig.assistants) {
    const { modelGroupMap, groupMap, assistantModels } = azureConfig;
    const modelName = req.body.model ?? req.query.model ?? assistantModels[0];
    const {
      azureOptions: currentOptions,
      baseURL: azureBaseURL,
      headers = {},
      serverless,
    } = mapModelToAzureConfig({
      modelName,
      modelGroupMap,
      groupMap,
    });

    azureOptions = currentOptions;

    baseURL = constructAzureURL({
      baseURL: azureBaseURL ?? 'https://${INSTANCE_NAME}.openai.azure.com/openai',
      azureOptions,
    });

    apiKey = azureOptions.azureOpenAIApiKey;
    opts.defaultQuery = { 'api-version': azureOptions.azureOpenAIApiVersion };
    opts.defaultHeaders = resolveHeaders({
      headers: {
        ...headers,
        'api-key': apiKey,
        'OpenAI-Beta': `assistants=${version}`,
      },
      user: req.user,
      stripUnresolved: true,
    });
    opts.model = azureOptions.azureOpenAIApiDeploymentName;

    if (initAppClient) {
      clientOptions.titleConvo = azureConfig.titleConvo;
      clientOptions.titleModel = azureConfig.titleModel;
      clientOptions.titleMethod = azureConfig.titleMethod ?? 'completion';

      const groupName = modelGroupMap[modelName].group;
      clientOptions.addParams = azureConfig.groupMap[groupName].addParams;
      clientOptions.dropParams = azureConfig.groupMap[groupName].dropParams;

      clientOptions.reverseProxyUrl = baseURL ?? clientOptions.reverseProxyUrl;
      clientOptions.headers = opts.defaultHeaders;
      clientOptions.azure = !serverless && azureOptions;
      if (serverless === true) {
        clientOptions.defaultQuery = azureOptions.azureOpenAIApiVersion
          ? { 'api-version': azureOptions.azureOpenAIApiVersion }
          : undefined;
        clientOptions.headers['api-key'] = apiKey;
      }
    }
  }

  if (userProvidesKey & !apiKey) {
    throw new Error(
      JSON.stringify({
        type: ErrorTypes.NO_USER_KEY,
      }),
    );
  }

  if (!apiKey) {
    throw new Error('Assistants API key not provided. Please provide it again.');
  }

  if (baseURL) {
    opts.baseURL = baseURL;
  }

  const proxyDispatcher = getProxyDispatcher(PROXY);
  if (proxyDispatcher) {
    opts.fetchOptions = {
      dispatcher: proxyDispatcher,
    };
  }

  if (OPENAI_ORGANIZATION) {
    opts.organization = OPENAI_ORGANIZATION;
  }

  /** @type {OpenAIClient} */
  const openai = new OpenAI({
    apiKey,
    ...opts,
  });

  openai.beta.assistants.files = new Files(openai);

  openai.req = req;
  openai.res = res;

  if (azureOptions) {
    openai.locals = { ...(openai.locals ?? {}), azureOptions };
  }

  return {
    openai,
    openAIApiKey: apiKey,
  };
};

module.exports = initializeClient;
