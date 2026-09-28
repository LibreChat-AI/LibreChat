const jwt = require('jsonwebtoken');
const { nanoid } = require('nanoid');
const { GraphEvents, sleep } = require('@librechat/agents');
const { tool } = require('@librechat/agents/langchain/tools');
const { logger, decryptV2 } = require('@librechat/data-schemas');
const {
  sendEvent,
  isAbortError,
  logAxiosError,
  detachOnAbort,
  getTokenExpiresAt,
  refreshAccessToken,
  GenerationJobManager,
  createSSRFSafeAgents,
  encryptSensitiveValue,
  decryptSensitiveValue,
  validateActionOAuthMetadata,
} = require('@librechat/api');
const {
  Time,
  CacheKeys,
  StepTypes,
  Constants,
  AuthTypeEnum,
  actionDelimiter,
  isImageVisionTool,
  actionDomainSeparator,
} = require('librechat-data-provider');
const {
  findToken,
  updateToken,
  createToken,
  getActions,
  deleteActions,
  deleteAssistant,
} = require('~/models');
const { getActionFlowStateManager } = require('~/config');
const { getLogStores } = require('~/cache');

const JWT_SECRET = process.env.JWT_SECRET;
const toolNameRegex = /^[a-zA-Z0-9_-]+$/;
const protocolRegex = /^https?:\/\//;
const replaceSeparatorRegex = new RegExp(actionDomainSeparator, 'g');

/**
 * Validates tool name against regex pattern and updates if necessary.
 * @param {object} params - The parameters for the function.
 * @param {object} params.req - Express Request.
 * @param {FunctionTool} params.tool - The tool object.
 * @param {string} params.assistant_id - The assistant ID
 * @returns {object|null} - Updated tool object or null if invalid and not an action.
 */
const validateAndUpdateTool = async ({ req, tool, assistant_id }) => {
  let actions;
  if (isImageVisionTool(tool)) {
    return null;
  }
  if (!toolNameRegex.test(tool.function.name)) {
    const [functionName, domain] = tool.function.name.split(actionDelimiter);
    actions = await getActions({ assistantId: assistant_id, user: req.user.id }, true);
    const matchingActions = actions.filter((action) => {
      const metadata = action.metadata;
      if (!metadata) {
        return false;
      }
      const strippedMetaDomain = stripProtocol(metadata.domain);
      return strippedMetaDomain === domain || metadata.domain === domain;
    });
    const action = matchingActions[0];
    if (!action) {
      return null;
    }

    const parsedDomain = await domainParser(domain, true);

    if (!parsedDomain) {
      return null;
    }

    tool.function.name = `${functionName}${actionDelimiter}${parsedDomain}`;
  }
  return tool;
};

/** @param {string} domain */
function stripProtocol(domain) {
  const stripped = domain.replace(protocolRegex, '');
  const pathIdx = stripped.indexOf('/');
  return pathIdx === -1 ? stripped : stripped.substring(0, pathIdx);
}

/**
 * Encodes a domain using the legacy scheme (full URL including protocol).
 * Used for backward-compatible matching against agents saved before the collision fix.
 * @param {string} domain
 * @returns {string}
 */
function legacyDomainEncode(domain) {
  if (!domain) {
    return '';
  }
  if (domain.length <= Constants.ENCODED_DOMAIN_LENGTH) {
    return domain.replace(/\./g, actionDomainSeparator);
  }
  const modifiedDomain = Buffer.from(domain).toString('base64');
  return modifiedDomain.substring(0, Constants.ENCODED_DOMAIN_LENGTH);
}

/**
 * Encodes or decodes a domain name to/from base64, or replacing periods with a custom separator.
 *
 * Necessary due to `[a-zA-Z0-9_-]*` Regex Validation, limited to a 64-character maximum.
 * Strips protocol prefix before encoding to prevent base64 collisions
 * (all `https://` URLs share the same 10-char base64 prefix).
 *
 * @param {string} domain - The domain name to encode/decode.
 * @param {boolean} inverse - False to decode from base64, true to encode to base64.
 * @returns {Promise<string>} Encoded or decoded domain string.
 */
async function domainParser(domain, inverse = false) {
  if (!domain) {
    return;
  }

  const domainsCache = getLogStores(CacheKeys.ENCODED_DOMAINS);

  if (inverse) {
    const hostname = stripProtocol(domain);
    const cachedDomain = await domainsCache.get(hostname);
    if (cachedDomain) {
      return hostname;
    }

    if (hostname.length <= Constants.ENCODED_DOMAIN_LENGTH) {
      return hostname.replace(/\./g, actionDomainSeparator);
    }

    const modifiedDomain = Buffer.from(hostname).toString('base64');
    const key = modifiedDomain.substring(0, Constants.ENCODED_DOMAIN_LENGTH);
    await domainsCache.set(key, modifiedDomain);
    return key;
  }

  const cachedDomain = await domainsCache.get(domain);
  if (!cachedDomain) {
    return domain.replace(replaceSeparatorRegex, '.');
  }

  try {
    return Buffer.from(cachedDomain, 'base64').toString('utf-8');
  } catch (error) {
    logger.error(`Failed to parse domain (possibly not base64): ${domain}`, error);
    return domain;
  }
}

/**
 * Loads action sets based on the user and assistant ID.
 *
 * @param {import('@librechat/data-schemas').ActionQuery} query - The criteria for loading action sets.
 * @returns {Promise<Action[] | null>} A promise that resolves to an array of actions or `null` if no match.
 */
async function loadActionSets(query) {
  return await getActions(query, true);
}

/**
 * Creates a general tool for an entire action set.
 *
 * @param {Object} params - The parameters for loading action sets.
 * @param {string} params.userId
 * @param {ServerResponse} params.res
 * @param {Action} params.action - The action set. Necessary for decrypting authentication values.
 * @param {ActionRequest} params.requestBuilder - The ActionRequest builder class to execute the API call.
 * @param {string | undefined} [params.name] - The name of the tool.
 * @param {string | undefined} [params.description] - The description for the tool.
 * @param {import('zod').ZodTypeAny | undefined} [params.zodSchema] - The Zod schema for tool input validation/definition
 * @param {{ oauth_client_id?: string; oauth_client_secret?: string; }} params.encrypted - The encrypted values for the action.
 * @param {string | null} [params.streamId] - The stream ID for resumable streams.
 * @param {number} [params.jobCreatedAt] - The generation epoch that owns emitted events.
 * @param {boolean} [params.useSSRFProtection] - When true, uses SSRF-safe HTTP agents that validate resolved IPs at connect time.
 * @param {string[] | null} [params.allowedAddresses] - Optional admin exemption list of host:port pairs that bypass the SSRF private-IP block.
 * @returns { Promise<typeof tool | { _call: (toolInput: Object | string) => unknown}> } An object with `_call` method to execute the tool input.
 */
async function createActionTool({
  userId,
  res,
  action,
  requestBuilder,
  zodSchema,
  name,
  description,
  encrypted,
  streamId = null,
  jobCreatedAt,
  useSSRFProtection = false,
  allowedAddresses,
}) {
  const ssrfAgents = useSSRFProtection ? createSSRFSafeAgents(allowedAddresses) : undefined;
  /** @type {(toolInput: Object | string, config: GraphRunnableConfig) => Promise<unknown>} */
  const _call = async (toolInput, config) => {
    try {
      /** @type {import('librechat-data-provider').ActionMetadataRuntime} */
      const metadata = action.metadata;
      const executor = requestBuilder.createExecutor();
      const preparedExecutor = executor.setParams(toolInput ?? {});

      if (metadata.auth && metadata.auth.type !== AuthTypeEnum.None) {
        try {
          if (metadata.auth.type === AuthTypeEnum.OAuth && metadata.auth.authorization_url) {
            await validateActionOAuthMetadata(metadata.auth, allowedAddresses);

            const action_id = action.action_id;
            const identifier = `${userId}:${action.action_id}`;
            const requestLogin = async () => {
              const { args: _args, stepId, ...toolCall } = config.toolCall ?? {};
              if (!stepId) {
                throw new Error('Tool call is missing stepId');
              }
              const statePayload = {
                nonce: nanoid(),
                user: userId,
                action_id,
              };

              const stateToken = jwt.sign(statePayload, JWT_SECRET, { expiresIn: '10m' });
              try {
                const redirectUri = `${process.env.DOMAIN_CLIENT}/api/actions/${action_id}/oauth/callback`;
                const params = new URLSearchParams({
                  client_id: metadata.oauth_client_id,
                  scope: metadata.auth.scope,
                  redirect_uri: redirectUri,
                  access_type: 'offline',
                  response_type: 'code',
                  state: stateToken,
                });

                const authURL = `${metadata.auth.authorization_url}?${params.toString()}`;
                /** @type {{ id: string; delta: AgentToolCallDelta }} */
                const data = {
                  id: stepId,
                  delta: {
                    type: StepTypes.TOOL_CALLS,
                    tool_calls: [{ ...toolCall, args: '' }],
                    auth: authURL,
                    expires_at: Date.now() + Time.TWO_MINUTES,
                  },
                };
                const flowsCache = getLogStores(CacheKeys.FLOWS);
                const flowManager = getActionFlowStateManager(flowsCache);
                await flowManager.createFlowWithHandler(
                  `${identifier}:oauth_login:${config.metadata.thread_id}:${config.metadata.run_id}`,
                  'oauth_login',
                  async () => {
                    const eventData = { event: GraphEvents.ON_RUN_STEP_DELTA, data };
                    if (streamId) {
                      await GenerationJobManager.emitChunk(streamId, eventData, {
                        expectedCreatedAt: jobCreatedAt,
                      });
                    } else {
                      sendEvent(res, eventData);
                    }
                    logger.debug('Sent OAuth login request to client', { action_id, identifier });
                    return true;
                  },
                  config?.signal,
                );
                logger.debug('Waiting for OAuth Authorization response', { action_id, identifier });
                /** Detached rather than signalled. This key is `userId:action_id`,
                 *  so a second run for the same action joins this very flow and
                 *  the browser's OAuth callback reads its metadata to exchange
                 *  the code; `monitorFlow` deletes the key when a waiter's signal
                 *  aborts, which would strand the other run and discard an
                 *  authorization the user already granted. Stopping only this
                 *  waiter leaves the flow to finish for whoever else needs it,
                 *  while keeping a late authorization from resuming this call
                 *  into the API request below. */
                const result = await detachOnAbort(
                  flowManager.createFlow(identifier, 'oauth', {
                    state: stateToken,
                    userId: userId,
                    client_url: metadata.auth.client_url,
                    redirect_uri: `${process.env.DOMAIN_SERVER}/api/actions/${action_id}/oauth/callback`,
                    token_exchange_method: metadata.auth.token_exchange_method,
                    allowedAddresses,
                    /** Encrypted values */
                    encrypted_oauth_client_id: encrypted.oauth_client_id,
                    encrypted_oauth_client_secret: encrypted.oauth_client_secret,
                  }),
                  config?.signal,
                );
                logger.debug('Received OAuth Authorization response', { action_id, identifier });
                data.delta.auth = undefined;
                data.delta.expires_at = undefined;
                const successEventData = { event: GraphEvents.ON_RUN_STEP_DELTA, data };
                if (streamId) {
                  await GenerationJobManager.emitChunk(streamId, successEventData, {
                    expectedCreatedAt: jobCreatedAt,
                  });
                } else {
                  sendEvent(res, successEventData);
                }
                await sleep(3000);
                metadata.oauth_access_token = result.access_token;
                metadata.oauth_refresh_token = result.refresh_token;
                const expiresAt = getTokenExpiresAt(result.expires_in);
                metadata.oauth_token_expires_at = expiresAt?.toISOString();
              } catch (error) {
                /** A stopped run is not an authentication failure. Relabelling it
                 *  loses the abort identity every downstream boundary keys on and
                 *  reports a fault the user caused deliberately. */
                if (isAbortError(error)) {
                  throw error;
                }
                const errorMessage = 'Failed to authenticate OAuth tool';
                logger.error(errorMessage, error);
                throw new Error(errorMessage);
              }
            };

            const tokenPromises = [];
            tokenPromises.push(findToken({ userId, type: 'oauth', identifier }));
            tokenPromises.push(
              findToken({
                userId,
                type: 'oauth_refresh',
                identifier: `${identifier}:refresh`,
              }),
            );
            const [tokenData, refreshTokenData] = await Promise.all(tokenPromises);

            if (tokenData) {
              // Valid token exists, add it to metadata for setAuth
              metadata.oauth_access_token = await decryptV2(tokenData.token);
              if (refreshTokenData) {
                metadata.oauth_refresh_token = await decryptV2(refreshTokenData.token);
              }
              metadata.oauth_token_expires_at = tokenData.expiresAt.toISOString();
            } else if (!refreshTokenData) {
              // No tokens exist, need to authenticate
              await requestLogin();
            } else if (refreshTokenData) {
              // Refresh token is still valid, use it to get new access token
              try {
                const refresh_token = await decryptV2(refreshTokenData.token);
                const refreshTokens = async () =>
                  await refreshAccessToken(
                    {
                      userId,
                      identifier,
                      refresh_token,
                      client_url: metadata.auth.client_url,
                      encrypted_oauth_client_id: encrypted.oauth_client_id,
                      token_exchange_method: metadata.auth.token_exchange_method,
                      encrypted_oauth_client_secret: encrypted.oauth_client_secret,
                      allowedAddresses,
                    },
                    {
                      findToken,
                      updateToken,
                      createToken,
                    },
                  );
                const flowsCache = getLogStores(CacheKeys.FLOWS);
                const flowManager = getActionFlowStateManager(flowsCache);
                /** Also shared across this user's runs for the action; see the
                 *  authorization flow above for why it is detached, not
                 *  signalled. */
                const refreshData = await detachOnAbort(
                  flowManager.createFlowWithHandler(
                    `${identifier}:refresh`,
                    'oauth_refresh',
                    refreshTokens,
                  ),
                  config?.signal,
                );
                metadata.oauth_access_token = refreshData.access_token;
                if (refreshData.refresh_token) {
                  metadata.oauth_refresh_token = refreshData.refresh_token;
                }
                const expiresAt = getTokenExpiresAt(refreshData.expires_in);
                metadata.oauth_token_expires_at = expiresAt?.toISOString();
              } catch (error) {
                /** The refresh did not fail — this run stopped waiting on it.
                 *  Falling through to `requestLogin` would emit an OAuth prompt
                 *  and open pending authorization state for a turn that is over. */
                if (isAbortError(error)) {
                  throw error;
                }
                logger.error('Failed to refresh token, requesting new login:', error);
                await requestLogin();
              }
            } else {
              await requestLogin();
            }
          }

          await preparedExecutor.setAuth(metadata);
        } catch (error) {
          if (
            isAbortError(error) ||
            error.message.includes('No access token found') ||
            error.message.includes('Access token is expired')
          ) {
            throw error;
          }
          throw new Error(`Authentication failed: ${error.message}`);
        }
      }

      const response = await preparedExecutor.execute(ssrfAgents);

      if (typeof response.data === 'object') {
        return JSON.stringify(response.data);
      }
      return response.data;
    } catch (error) {
      /** Surface the cancellation as a cancellation: `logAxiosError` would log it
       *  at error level and return its text as the tool's result, presenting a
       *  stopped turn as a failed API call. */
      if (isAbortError(error)) {
        logger.debug(`Action call to ${action.metadata.domain} cancelled by user abort`);
        throw error;
      }
      const message = `API call to ${action.metadata.domain} failed:`;
      return logAxiosError({ message, error });
    }
  };

  if (name) {
    return tool(_call, {
      name: name.replace(replaceSeparatorRegex, '_'),
      description: description || '',
      schema: zodSchema,
    });
  }

  return {
    _call,
  };
}

/**
 * Encrypts sensitive metadata values for an action.
 *
 * @param {ActionMetadata} metadata - The action metadata to encrypt.
 * @returns {Promise<ActionMetadata>} The updated action metadata with encrypted values.
 */
async function encryptMetadata(metadata) {
  const encryptedMetadata = { ...metadata };

  // ServiceHttp
  if (metadata.auth && metadata.auth.type === AuthTypeEnum.ServiceHttp) {
    if (metadata.api_key) {
      encryptedMetadata.api_key = await encryptSensitiveValue(metadata.api_key);
    }
  }

  // OAuth
  else if (metadata.auth && metadata.auth.type === AuthTypeEnum.OAuth) {
    if (metadata.oauth_client_id) {
      encryptedMetadata.oauth_client_id = await encryptSensitiveValue(metadata.oauth_client_id);
    }
    if (metadata.oauth_client_secret) {
      encryptedMetadata.oauth_client_secret = await encryptSensitiveValue(
        metadata.oauth_client_secret,
      );
    }
  }

  return encryptedMetadata;
}

/**
 * Decrypts sensitive metadata values for an action.
 *
 * @param {ActionMetadata} metadata - The action metadata to decrypt.
 * @returns {Promise<ActionMetadata>} The updated action metadata with decrypted values.
 */
async function decryptMetadata(metadata) {
  const decryptedMetadata = { ...metadata };

  // ServiceHttp
  if (metadata.auth && metadata.auth.type === AuthTypeEnum.ServiceHttp) {
    if (metadata.api_key) {
      decryptedMetadata.api_key = await decryptSensitiveValue(metadata.api_key);
    }
  }

  // OAuth
  else if (metadata.auth && metadata.auth.type === AuthTypeEnum.OAuth) {
    if (metadata.oauth_client_id) {
      decryptedMetadata.oauth_client_id = await decryptSensitiveValue(metadata.oauth_client_id);
    }
    if (metadata.oauth_client_secret) {
      decryptedMetadata.oauth_client_secret = await decryptSensitiveValue(
        metadata.oauth_client_secret,
      );
    }
  }

  return decryptedMetadata;
}

/**
 * Deletes an action and its corresponding assistant.
 * @param {Object} params - The parameters for the function.
 * @param {OpenAIClient} params.req - The Express Request object.
 * @param {string} params.assistant_id - The ID of the assistant.
 */
const deleteAssistantActions = async ({ req, assistant_id }) => {
  try {
    await deleteActions({ assistantId: assistant_id, user: req.user.id });
    await deleteAssistant({ assistantId: assistant_id, user: req.user.id });
  } catch (error) {
    const message = 'Trouble deleting Assistant Actions for Assistant ID: ' + assistant_id;
    logger.error(message, error);
    throw new Error(message);
  }
};

module.exports = {
  deleteAssistantActions,
  validateAndUpdateTool,
  legacyDomainEncode,
  createActionTool,
  encryptMetadata,
  decryptMetadata,
  loadActionSets,
  domainParser,
};
